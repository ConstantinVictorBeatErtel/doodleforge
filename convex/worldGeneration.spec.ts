/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
import type { Id } from './_generated/dataModel';

const modules = import.meta.glob("./**/*.ts");
const TEST_IDENTITY = { tokenIdentifier: "test|user", subject: "user", issuer: "https://test.clerk.accounts.dev" };
const asUser = () => convexTest(schema, modules).withIdentity(TEST_IDENTITY);
beforeEach(() => {
  vi.useFakeTimers(); vi.stubEnv('WLT_API_KEY', 'test-key');
  vi.stubEnv('WORLD_LABS_MAX_DRAFT_USD', '5'); vi.stubEnv('WORLD_LABS_MAX_STANDARD_USD', '5'); vi.stubEnv('WORLD_LABS_MAX_PLUS_USD', '5');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function drain(t: any) {
  // Let each action finish its mocked HTTP work before advancing to its watchdog.
  for (let i = 0; vi.getTimerCount() && i < 1000; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    await t.finishInProgressScheduledFunctions();
  }
  expect(vi.getTimerCount()).toBe(0);
}
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

async function media(t: any, type = 'image/jpeg') {
  return t.run(async (ctx: any) => {
    const id = await ctx.storage.store(new Blob(['capture'], { type }));
    // convex-test 0.0.56 omits contentType when emulating a browser upload.
    await ctx.db.patch(id as never, { contentType: type } as never);
    await ctx.db.insert('uploads', { ownerId: TEST_IDENTITY.tokenIdentifier, token: crypto.randomUUID(), storageId: id, expiresAt: Date.now() + 60_000 });
    return id;
  });
}

test('missing provider key fails before creating a generation', async () => {
  vi.stubEnv('WLT_API_KEY', '');
  const t = asUser();
  await expect(t.mutation(api.worlds.startFromMedia, { storageId: await media(t), kind: 'image' })).rejects.toThrow('WLT_API_KEY');
  expect(await t.query(api.worlds.list)).toHaveLength(0);
});

test('media kind must match the stored upload before scheduling a paid request', async () => {
  const t = asUser();
  await expect(t.mutation(api.worlds.startFromMedia, { storageId: await media(t, 'video/mp4'), kind: 'image' })).rejects.toThrow('image');
  expect(await t.query(api.worlds.list)).toHaveLength(0);
});

test.each(['image', 'video'] as const)('a %s upload uses a real URI and the fast model by default', async kind => {
  const t = asUser();
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => json({ operation_id: 'op', done: true, error: { message: 'Provider rejected capture' } }));
  vi.stubGlobal('fetch', fetcher);
  const id = await t.mutation(api.worlds.startFromMedia, { storageId: await media(t, kind === 'image' ? 'image/jpeg' : 'video/mp4'), kind });
  await drain(t);
  const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string);
  expect(body.model).toBe('marble-1.0-draft');
  expect(body.world_prompt).toMatchObject({ type: kind, [`${kind}_prompt`]: { source: 'uri', uri: expect.stringMatching(/^https?:/) } });
  const world = (await t.query(api.worlds.list)).find(w => w._id === id);
  expect(world).toMatchObject({ status: 'failed', error: 'Provider rejected capture' });
});

test('detail selection is honored, pending operations poll without resubmission, and optional panorama failure does not block readiness', async () => {
  const t = asUser();
  let polls = 0;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'POST') return json({ operation_id: 'op', done: false });
    if (path.includes('operations/')) return json(++polls < 2 ? { done: false } : { done: true, response: { world_id: 'real-room' } });
    if (path.includes('worlds/')) return json({ assets: { splats: { spz_urls: { '500k': 'https://assets/splat' }, semantics_metadata: { metric_scale_factor: 2, ground_plane_offset: 3 } }, mesh: { collider_mesh_url: 'https://assets/collider' }, imagery: { pano_url: 'https://assets/pano' } } });
    return new Response(path.endsWith('pano') ? 'unavailable' : 'binary', { status: path.endsWith('pano') ? 503 : 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  const id = await t.mutation(api.worlds.startFromMedia, { storageId: await media(t), kind: 'image', model: 'marble-1.1' });
  await drain(t);
  const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0][1]!.body as string).model).toBe('marble-1.1');
  expect(polls).toBe(2);
  expect((await t.query(api.worlds.list)).find(w => w._id === id)).toMatchObject({ status: 'ready', stage: 'Ready', metricScale: 2, groundOffset: 3, splatUrl: expect.any(String), colliderUrl: expect.any(String) });
});

test('failed asset downloads never get stored as a ready splat', async () => {
  const t = asUser();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return json({ operation_id: 'op', done: true, response: { world_id: 'room' } });
    if (url.includes('worlds/')) return json({ assets: { splats: { spz_urls: { '500k': 'https://assets/splat' } } } });
    return new Response('expired', { status: 403 });
  }));
  const id = await t.mutation(api.worlds.startFromMedia, { storageId: await media(t), kind: 'image' });
  await drain(t);
  expect((await t.query(api.worlds.list)).find(w => w._id === id)).toMatchObject({ status: 'failed', retryable: true, splatUrl: null });
});

test('a slow operation times out and resumes the same paid operation once, ignoring stale work', async () => {
  const t = asUser();
  let complete = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return json({ operation_id: 'same-op', done: false });
    if (url.includes('operations/')) return json(complete ? { done: true, response: { world_id: 'room' } } : { done: false });
    if (url.includes('worlds/')) return json({ assets: { splats: { spz_urls: { '500k': 'https://assets/splat' } } } });
    return new Response('splat');
  });
  vi.stubGlobal('fetch', fetcher);
  const id = await t.mutation(api.worlds.startFromMedia, { storageId: await media(t), kind: 'image' });
  const initial = await t.run(ctx => ctx.db.get(id));
  await drain(t);
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'failed', retryable: true, operationId: 'same-op' });
  complete = true;
  await t.mutation(api.worlds.resumeGeneration, { id });
  await t.mutation(api.worlds.resumeGeneration, { id });
  await t.mutation(internal.worlds.expireGeneration, { id, deadline: initial!.generationDeadline! });
  await t.action(internal.worlds.pollGeneration, { id, deadline: initial!.generationDeadline! });
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'generating' });
  await drain(t);
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'ready' });
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

test('an ambiguous submit failure is not automatically retried', async () => {
  const t = asUser();
  const fetcher = vi.fn(async () => { throw new Error('Connection lost'); });
  vi.stubGlobal('fetch', fetcher);
  const id = await t.mutation(api.worlds.startFromMedia, { storageId: await media(t), kind: 'image' });
  await drain(t);
  await t.mutation(api.worlds.resumeGeneration, { id });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'failed', retryable: false });
});

test('room geometry downloads run together and use the smaller 500k splat', async () => {
  const t = asUser();
  let releaseSplat!: () => void;
  const colliderStarted = new Promise<void>(resolve => { releaseSplat = resolve; });
  const downloads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return json({ operation_id: 'op', done: true, response: { world_id: 'room' } });
    if (url.includes('worlds/')) return json({ assets: { splats: { spz_urls: { '500k': 'https://assets/small', full_res: 'https://assets/full' } }, mesh: { collider_mesh_url: 'https://assets/collider' } } });
    downloads.push(url);
    if (url.endsWith('small')) await colliderStarted;
    if (url.endsWith('collider')) releaseSplat();
    return new Response('geometry');
  }));
  const id = await t.mutation(api.worlds.startFromMedia, { storageId: await media(t), kind: 'image' });
  await drain(t);
  expect(downloads).toEqual(['https://assets/small', 'https://assets/collider']);
  const world = await t.run(ctx => ctx.db.get(id));
  expect(world?.error).toBeUndefined();
  expect(world).toMatchObject({ status: 'ready' });
});

test.each([0, 21 * 1024 * 1024])('rejects invalid image size %s before submission', async size => {
  const t = asUser();
  const storageId = await media(t);
  await t.run(ctx => ctx.db.patch(storageId as never, { size } as never));
  await expect(t.mutation(api.worlds.startFromMedia, { storageId, kind: 'image' })).rejects.toThrow('20 MB');
  expect(await t.query(api.worlds.list)).toHaveLength(0);
});

test('text creation also defaults to fast and returns before provider completion', async () => {
  const t = asUser();
  const fetcher = vi.fn(async () => json({ operation_id: 'op', done: true, error: { message: 'test failure' } }));
  vi.stubGlobal('fetch', fetcher);
  const id = await t.action(api.worlds.generateFromText, { prompt: 'A room' });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ model: 'marble-1.0-draft', status: 'generating' });
  await drain(t);
});

test.each(['failed collider', 'late completion'])('cleans unused downloads after %s', async mode => {
  const t = asUser();
  let id: Id<'worlds'>;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return json({ operation_id: 'op', done: true, response: { world_id: 'room' } });
    if (url.includes('worlds/')) return json({ assets: { splats: { spz_urls: { '500k': 'https://assets/splat' } }, mesh: { collider_mesh_url: 'https://assets/collider' } } });
    if (url.endsWith('collider')) {
      if (mode === 'failed collider') return new Response('expired', { status: 403 });
      const world = await t.run(ctx => ctx.db.get(id));
      await t.mutation(internal.worlds.expireGeneration, { id, deadline: world!.generationDeadline! });
    }
    return new Response('geometry');
  }));
  id = await t.mutation(api.worlds.startFromMedia, { storageId: await media(t), kind: 'image' });
  await drain(t);
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'failed' });
  expect(await t.run(ctx => ctx.db.system.query('_storage').collect())).toHaveLength(1);
});
