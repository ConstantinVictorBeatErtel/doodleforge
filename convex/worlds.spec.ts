/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob("./**/*.ts");
const TEST_IDENTITY = { tokenIdentifier: "test|user", subject: "user", issuer: "https://test.clerk.accounts.dev" };
const asUser = () => convexTest(schema, modules).withIdentity(TEST_IDENTITY);

test('local imports reuse the provider world and preserve ZIP metadata', async () => {
  const t = asUser();
  const splatStorageId = await t.run(async (ctx) => { const id = await ctx.storage.store(new Blob(['splat'])); await ctx.db.insert('uploads', { ownerId: TEST_IDENTITY.tokenIdentifier, token: crypto.randomUUID(), storageId: id, expiresAt: Date.now() + 60_000 }); return id; });
  const input = { name: 'Demo', worldId: 'saved-world', splatStorageId, splatFileName: 'splat-500k.spz', metricScale: 2, groundOffset: 3, reuseExisting: true };
  const id = await t.mutation(api.worlds.importUploaded, input);
  expect(await t.mutation(api.worlds.importUploaded, input)).toBe(id);
  const worlds = await t.query(api.worlds.list, {});
  expect(worlds).toHaveLength(1);
  expect(worlds[0]).toMatchObject({ _id: id, metricScale: 2, groundOffset: 3, splatFileName: 'splat-500k.spz', status: 'ready' });
  expect((await t.query(api.worlds.byWorldId, { worldId: 'saved-world' }))?._id).toBe(id);
});

test('an imported world uses the existing placement and multiplayer tables', async () => {
  const t = asUser();
  const splatStorageId = await t.run(async (ctx) => { const id = await ctx.storage.store(new Blob(['splat'])); await ctx.db.insert('uploads', { ownerId: TEST_IDENTITY.tokenIdentifier, token: crypto.randomUUID(), storageId: id, expiresAt: Date.now() + 60_000 }); return id; });
  const room = await t.mutation(api.worlds.importUploaded, { name: 'Demo', splatStorageId });
  const assetId = await t.run((ctx) => ctx.db.insert('assets', { ownerId: TEST_IDENTITY.tokenIdentifier, prompt: 'fixture', model: 'fixture', status: 'ready' }));
  await t.mutation(api.assets.place, { room, assetId, position: [1, 0, 2] });
  expect(await t.query(api.assets.placementsInRoom, { room })).toHaveLength(1);
  expect(await t.query(api.assets.placementsInRoom, { room: 'different-world' })).toHaveLength(0);
  await expect(t.query(api.players.inRoom, { room })).rejects.toThrow('Multiplayer is disabled');
});
