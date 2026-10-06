// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import type { ConvexReactClient } from 'convex/react';
import { getFunctionName } from 'convex/server';
import { zipSync, strToU8 } from 'fflate';
import { ConvexProjectClient } from './ConvexProjectClient';
import { worldTransform } from './worldTransform';

afterEach(() => vi.unstubAllGlobals());

function backend(existing = false) {
  const imports: unknown[] = [];
  const query = vi.fn(async (_reference: unknown, _args: { worldId: string; splatFileName?: string }) => existing ? { _id: 'convex-world', splatUrl: 'https://storage.test/splat' } : null);
  const mutation = vi.fn(async (reference, args) => {
    const name = getFunctionName(reference);
    if (name === 'worlds:generateUploadUrl') return { url: 'https://storage.test/upload', token: 'upload-ticket' };
    if (name === 'worlds:claimUpload') return null;
    if (name === 'worlds:importUploaded') imports.push(args);
    return 'convex-world';
  });
  return { client: new ConvexProjectClient({ query, mutation } as unknown as ConvexReactClient), imports, query, mutation };
}

test('an already-imported saved room needs no local files or upload', async () => {
  const { client, mutation } = backend(true);
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('manifest.json')) return Response.json({
      worldId: 'saved-world', displayName: 'Saved room', preferredSplat: 'splat-500k',
      assets: { 'splat-500k': { path: 'assets/splat-500k.spz' } },
    });
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  expect(await client.importLocalWorld('saved-job')).toBe('convex-world');
  expect(mutation).not.toHaveBeenCalled();
});

test('concurrent entries for the same saved job import it once, with its original metadata', async () => {
  const { client, imports, query } = backend();
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return Response.json({ storageId: 'storage-id' });
    if (url.endsWith('manifest.json')) return Response.json({
      worldId: 'saved-world', displayName: 'Saved room', preferredSplat: 'splat-full_res',
      assets: { 'splat-full_res': { path: 'assets/splat-full_res.spz' }, collider: { path: 'assets/collider.glb' } },
      coordinates: { semantics: { metric_scale_factor: 2, ground_plane_offset: 3 } },
    });
    return new Response('asset');
  });
  vi.stubGlobal('fetch', fetcher);
  expect(await Promise.all([client.importLocalWorld('saved-job'), client.importLocalWorld('saved-job')])).toEqual(['convex-world', 'convex-world']);
  expect(imports).toHaveLength(1);
  expect(imports[0]).toMatchObject({ worldId: 'saved-world', splatFileName: 'splat-full_res.spz', metricScale: 2, groundOffset: 3, reuseExisting: true });
  expect(fetcher.mock.calls.filter(([url]) => url === '/world-assets/saved-job/manifest.json')).toHaveLength(1);
  // A 500k row for this same world must not be mistaken for the full-res capture.
  expect(query.mock.calls.every(([, args]) => args.splatFileName === 'splat-full_res.spz')).toBe(true);
  expect(fetcher.mock.calls.every(([url]) => !url.includes('worldlabs.ai'))).toBe(true);
});

test('ZIP import uses the existing parser and the same Convex import contract', async () => {
  const { client, imports } = backend();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ storageId: 'storage-id' })));
  const archive = zipSync({
    'manifest.json': strToU8(JSON.stringify({ displayName: 'ZIP room', worldId: 'zip-world', preferredSplat: 'splat-500k', assets: { 'splat-500k': { path: 'assets/splat-500k.spz' } } })),
    'assets/splat-500k.spz': strToU8('splat'),
  });
  await client.importZip(new File([archive], 'world.zip'));
  expect(imports[0]).toMatchObject({ name: 'ZIP room', worldId: 'zip-world', splatFileName: 'splat-500k.spz' });
});

test('failed saved asset reads do not register a ready world and can retry', async () => {
  const { client, imports } = backend();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  await expect(client.importLocalWorld('saved-job')).rejects.toThrow('saved room');
  await expect(client.importLocalWorld('saved-job')).rejects.toThrow('saved room');
  expect(imports).toEqual([]);
});

test('Convex viewer applies the same scale and ground offset as the CLI manifest', () => {
  expect(worldTransform(2, 3)).toEqual({ scale: [2, -2, -2], position: [0, 3, 0] });
});
