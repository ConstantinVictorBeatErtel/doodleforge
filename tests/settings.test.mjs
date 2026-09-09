import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettings } from '../server/settings.js';

async function setup(t, getEnv = () => ({})) {
  const dir = await mkdtemp(join(tmpdir(), 'doodleforge-settings-'));
  const file = join(dir, 'api-keys.json');
  const store = createSettings({ file, getEnv });
  const server = createServer((req, res) => store.middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true }); });
  const url = `http://127.0.0.1:${server.address().port}/api/settings`;
  const patch = (body, headers = {}) => fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { file, store, url, patch };
}

test('keys persist privately, update generation env immediately, and are never returned', async t => {
  const { file, store, url, patch } = await setup(t);
  assert.equal((await (await fetch(url)).json()).FAL_KEY.configured, false);
  const response = await patch({ FAL_KEY: 'test-fal-secret', TRIPO_API_KEY: 'test-tripo-secret' });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes('test-fal-secret') && !text.includes('test-tripo-secret'));
  assert.equal(store.env().FAL_KEY, 'test-fal-secret');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).TRIPO_API_KEY, 'test-tripo-secret');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const restarted = createSettings({ file });
  await restarted.middleware({url:'/api/asset-status'}, {}, () => {});
  assert.equal(restarted.env().FAL_KEY, 'test-fal-secret');
  assert.ok(!(await (await fetch(url)).text()).includes('test-fal-secret'));
});

test('blank modal updates preserve keys; explicit removal falls back to environment', async t => {
  const { store, patch } = await setup(t, () => ({ FAL_KEY: 'environment-key' }));
  await patch({ FAL_KEY: 'override-key', TRIPO_API_KEY: 'tripo-key' });
  await patch({});
  assert.equal(store.env().FAL_KEY, 'override-key');
  await patch({ FAL_KEY: null });
  assert.equal(store.env().FAL_KEY, 'environment-key');
  assert.equal(store.env().TRIPO_API_KEY, 'tripo-key');
});

test('settings reject cross-site requests, untrusted hosts and invalid inputs without changing keys', async t => {
  const { store, patch, url } = await setup(t);
  assert.equal((await patch({ FAL_KEY: 'secret' }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await patch({ FAL_KEY: 'secret' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = request(url, { headers: { Host: 'other.example' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHost, 403);
  for (const input of [{ OPENAI_API_KEY: 'secret' }, { FAL_KEY: '' }, { FAL_KEY: 'bad\nkey' }, { FAL_KEY: 42 }, []]) assert.equal((await patch(input)).status, 400);
  assert.equal((await patch({ FAL_KEY: 'x'.repeat(17000) })).status, 413);
  assert.equal(store.env().FAL_KEY, undefined);
});

test('simultaneous updates retain both providers', async t => {
  const { store, patch } = await setup(t);
  const results = await Promise.all([patch({ FAL_KEY: 'fal-key' }), patch({ TRIPO_API_KEY: 'tripo-key' })]);
  assert.ok(results.every(response => response.ok));
  assert.equal(store.env().FAL_KEY, 'fal-key'); assert.equal(store.env().TRIPO_API_KEY, 'tripo-key');
});

test('unreadable persisted settings fail closed without exposing file contents', async t => {
  const { file } = await setup(t);
  await writeFile(file, 'corrupted-secret-file');
  const store = createSettings({ file });
  let code, payload, called = false;
  await store.middleware({ url:'/api/asset-status' }, { writeHead: value => { code = value; }, end: value => { payload = value; } }, () => { called = true; });
  assert.equal(code, 503); assert.equal(called, false); assert.ok(!payload.includes('corrupted-secret-file'));
});
