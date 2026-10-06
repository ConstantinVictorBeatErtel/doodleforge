/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
beforeEach(() => {
  vi.stubEnv('WORLD_LABS_MAX_DRAFT_USD', '5'); vi.stubEnv('WORLD_LABS_MAX_STANDARD_USD', '5'); vi.stubEnv('WORLD_LABS_MAX_PLUS_USD', '5');
});
afterEach(() => vi.unstubAllEnvs());
const alice = { tokenIdentifier: 'https://issuer.test|alice', subject: 'alice', issuer: 'https://issuer.test' };
const bob = { tokenIdentifier: 'https://issuer.test|bob', subject: 'bob', issuer: 'https://issuer.test' };
const carol = { tokenIdentifier: 'https://issuer.test|carol', subject: 'carol', issuer: 'https://issuer.test' };
const dave = { tokenIdentifier: 'https://issuer.test|dave', subject: 'dave', issuer: 'https://issuer.test' };

test('logged-out requests fail and owner-scoped lists hide other accounts and legacy records', async () => {
  const base = convexTest(schema, modules);
  const userA = base.withIdentity(alice);
  const userB = base.withIdentity(bob);
  const world = await userA.mutation(api.worlds.importUploaded, { name: 'private room', splatStorageId: await upload(base, alice.tokenIdentifier) });
  await base.run(ctx => ctx.db.insert('worlds', { name: 'legacy', prompt: '', model: 'old', status: 'ready' }));

  await expect(base.query(api.worlds.list, {})).rejects.toThrow('Sign in');
  expect(await userA.query(api.worlds.list, {})).toHaveLength(1);
  expect(await userB.query(api.worlds.list, {})).toHaveLength(0);
  await expect(userB.mutation(api.worlds.deleteWorld, { id: world })).rejects.toThrow('World not found');
});

test('foreign assets cannot be placed or deleted, and placements stay owner-scoped', async () => {
  const base = convexTest(schema, modules);
  const userA = base.withIdentity(alice);
  const userB = base.withIdentity(bob);
  const asset = await base.run(ctx => ctx.db.insert('assets', { ownerId: alice.tokenIdentifier, prompt: 'private object', model: 'fixture', status: 'ready' }));
  const placement = await userA.mutation(api.assets.place, { room: 'room-a', assetId: asset, position: [0, 0, 0] });

  expect(await userB.query(api.assets.placementsInRoom, { room: 'room-a' })).toHaveLength(0);
  expect(await userA.query(api.assets.list, {})).toHaveLength(1);
  expect(await userB.query(api.assets.list, {})).toHaveLength(0);
  await expect(userB.mutation(api.assets.place, { room: 'room-b', assetId: asset, position: [1, 0, 0] })).rejects.toThrow('Object not found');
  await expect(userB.mutation(api.assets.deleteObject, { id: asset })).rejects.toThrow('Object not found');
  await expect(userB.mutation(api.assets.removePlacement, { id: placement })).rejects.toThrow('Placement not found');
  expect((await userA.query(api.assets.placementsInRoom, { room: 'room-a' })).map(row => row._id)).toEqual([placement]);
});

test('logged-out calls cannot reserve budget or trigger generation', async () => {
  const t = convexTest(schema, modules);
  await expect(t.action(api.worlds.generateFromText, { prompt: 'make a room' })).rejects.toThrow('Sign in');
  expect(await t.run(ctx => ctx.db.query('dailyBudgets').first())).toBeNull();
});

test('account deletion removes private creations, placements, upload tickets and storage', async () => {
  const base = convexTest(schema, modules);
  const user = base.withIdentity(alice);
  const splatStorageId = await upload(base, alice.tokenIdentifier);
  const worldId = await user.mutation(api.worlds.importUploaded, { name: 'room', splatStorageId });
  const assetStorageId = await base.run(ctx => ctx.storage.store(new Blob(['glb'])));
  const assetId = await base.run(ctx => ctx.db.insert('assets', { ownerId: alice.tokenIdentifier, prompt: 'object', model: 'fixture', status: 'ready', glbStorageId: assetStorageId }));
  await user.mutation(api.assets.place, { room: worldId, assetId, position: [0, 0, 0] });

  await user.mutation(api.account.deleteMyData, {});
  // deleteMyData queues a zero-delay batch; drain scheduled timers as well as
  // functions that have already started running.
  await base.finishAllScheduledFunctions(() => {});

  expect(await base.run(ctx => ctx.db.query('worlds').collect())).toHaveLength(0);
  expect(await base.run(ctx => ctx.db.query('assets').collect())).toHaveLength(0);
  expect(await base.run(ctx => ctx.db.query('placements').collect())).toHaveLength(0);
  expect(await base.run(ctx => ctx.db.query('uploads').collect())).toHaveLength(0);
  expect(await base.run(ctx => ctx.db.system.query('_storage').collect())).toHaveLength(0);
});

test('deleting one creation also removes its upload ticket', async () => {
  const base = convexTest(schema, modules);
  const user = base.withIdentity(alice);
  const splatStorageId = await upload(base, alice.tokenIdentifier);
  const worldId = await user.mutation(api.worlds.importUploaded, { name: 'room', splatStorageId });
  expect(await base.run(ctx => ctx.db.query('uploads').collect())).toHaveLength(1);

  await user.mutation(api.worlds.deleteWorld, { id: worldId });

  expect(await base.run(ctx => ctx.db.query('uploads').collect())).toHaveLength(0);
  expect(await base.run(ctx => ctx.db.system.query('_storage').collect())).toHaveLength(0);
});

test('paid work fails closed if its provider-specific maximum cost is not configured', async () => {
  const t = convexTest(schema, modules).withIdentity(alice);
  vi.stubEnv('WLT_API_KEY', 'unit-test-key');
  vi.stubEnv('WORLD_LABS_MAX_DRAFT_USD', '');
  await expect(t.action(api.worlds.generateFromText, { prompt: 'make a room' })).rejects.toThrow('WORLD_LABS_MAX_DRAFT_USD');
  expect(await t.run(ctx => ctx.db.query('dailyBudgets').first())).toBeNull();
});

test('atomic global reservation stops new paid generations at $50 across users', async () => {
  vi.stubEnv('WLT_API_KEY', 'unit-test-key');
  const base = convexTest(schema, modules);
  const userA = base.withIdentity(alice);
  const userB = base.withIdentity(bob);
  const userC = base.withIdentity(carol);
  const userD = base.withIdentity(dave);
  const users = [userA, userB, userC, userD];
  const requests = Array.from({ length: 11 }, (_, i) =>
    users[i % users.length].action(api.worlds.generateFromText, { prompt: `room ${i}` }),
  );
  const results = await Promise.allSettled(requests);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(10);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  await expect(userD.action(api.worlds.generateFromText, { prompt: 'one more' })).rejects.toThrow('budget has been reached');
  const budget = await base.run(ctx => ctx.db.query('dailyBudgets').first());
  expect(budget).toMatchObject({ spentUsd: 0, reservedUsd: 50 });
  const first = results.find(result => result.status === 'fulfilled');
  if (first?.status === 'fulfilled') await users[0].mutation(api.worlds.deleteWorld, { id: first.value });
  // Deleting one unsubmitted request returns only that reservation.
  const remaining = await base.run(ctx => ctx.db.query('dailyBudgets').first());
  expect(remaining?.reservedUsd).toBe(45);
});

test('short-window abuse throttling does not create a daily per-user generation allowance', async () => {
  vi.stubEnv('WLT_API_KEY', 'unit-test-key');
  const base = convexTest(schema, modules);
  const user = base.withIdentity(alice);
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => user.action(api.worlds.generateFromText, { prompt: `room ${i}` })));
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(3);
  expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect((await base.run(ctx => ctx.db.query('dailyBudgets').first()))?.reservedUsd).toBe(15);
});

async function upload(base: any, ownerId: string) {
  return base.run(async (ctx: any) => {
    const id = await ctx.storage.store(new Blob(['splat'], { type: 'application/octet-stream' }));
    await ctx.db.insert('uploads', { ownerId, token: crypto.randomUUID(), storageId: id, expiresAt: Date.now() + 60_000 });
    return id;
  });
}
