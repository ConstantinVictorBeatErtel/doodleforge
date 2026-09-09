import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const API = 'https://api.worldlabs.ai';
export const MODELS = ['marble-1.0-draft', 'marble-1.0', 'marble-1.1', 'marble-1.1-plus'];
export async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function inspectInput(path) {
  const extension = extname(path).slice(1).toLowerCase();
  const kind = ['jpg', 'jpeg', 'png', 'webp'].includes(extension) ? 'image'
    : ['mp4', 'mov', 'webm', 'avi'].includes(extension) ? 'video' : null;
  if (!kind) throw new Error(`Unsupported input ${extension}; convert HEIC to JPEG first.`);
  const info = await stat(path);
  if (!info.isFile() || !info.size || info.size > (kind === 'image' ? 20 : 100) * 1_000_000)
    throw new Error(`Invalid ${kind} size: ${basename(path)}`);
  if (basename(path).length > 64) throw new Error('Input filename exceeds API limit of 64 characters.');
  return { path, kind, extension, bytes: info.size, sha256: await hashFile(path) };
}
export function makeRequest(inputs, ids, { model = 'marble-1.1-plus', name = 'doodleforge room', prompt } = {}) {
  if (!MODELS.includes(model)) throw new Error('Unsupported model');
  if (!name || name.length > 64) throw new Error('Name must be 1–64 characters');
  if (prompt && prompt.length > 2000) throw new Error('Prompt exceeds 2000 characters');
  if (!inputs.length || inputs.length !== ids.length) throw new Error('Input/asset count mismatch');
  if (inputs.length > 8 || (inputs.length > 1 && inputs.some(i => i.kind !== 'image')))
    throw new Error('Use one video, one image, or 2–8 images of one space.');
  const content = id => ({ source: 'media_asset', media_asset_id: id });
  const world_prompt = inputs.length > 1
    ? { type: 'multi-image', reconstruct_images: true, multi_image_prompt: ids.map(id => ({ content: content(id) })) }
    : inputs[0].kind === 'video'
      ? { type: 'video', video_prompt: content(ids[0]) }
      : { type: 'image', is_pano: false, image_prompt: content(ids[0]) };
  if (prompt) world_prompt.text_prompt = prompt;
  return { display_name: name, model, world_prompt, permission: { public: false, allow_id_access: false } };
}
export function creditEstimate(request) {
  const pano = request.world_prompt.type === 'image' ? 80 : 100;
  const base = request.model === 'marble-1.0-draft' ? 150 : 1500;
  return { min: base + pano, max: base + pano + (request.model === 'marble-1.1-plus' ? 1500 : 0) };
}

export class WorldLabs {
  constructor(key, fetchImpl = fetch) {
    if (!key) throw new Error('Add WORLDLABS_API_KEY to .env.local (World Labs Platform API key).');
    this.key = key;
    this.fetch = fetchImpl;
  }
  async api(path, body) {
    // Paid POSTs are never automatically retried: a timeout can still mean a job started.
    let response;
    try {
      response = await this.fetch(API + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'WLT-Api-Key': this.key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(60_000),
      });
    } catch { throw new Error('World Labs network request failed; generation submission may have succeeded. Check saved job state before retrying.'); }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const hint = ({401:'Invalid API key',402:'Insufficient API credits (Marble app credits are separate)',404:'Resource missing or account not API enabled',429:'Rate limited; resume later'})[response.status] || 'Request failed';
      throw new Error(`World Labs HTTP ${response.status}: ${hint}${body.request_id ? `; request_id=${body.request_id}` : ''}`);
    }
    return response.json();
  }
  credits() { return this.api('/marble/v1/credits'); }
  operation(id) { return this.api(`/marble/v1/operations/${encodeURIComponent(id)}`); }
  world(id) { return this.api(`/marble/v1/worlds/${encodeURIComponent(id)}`); }
  async upload(input) {
    const prepared = await this.api('/marble/v1/media-assets:prepare_upload', {
      file_name: basename(input.path), extension: input.extension, kind: input.kind,
    });
    const id = prepared.media_asset.media_asset_id ?? prepared.media_asset.id;
    const info = prepared.upload_info;
    if (!id || !info?.upload_url || new URL(info.upload_url).protocol !== 'https:') throw new Error('Invalid upload response');
    let response;
    try {
      response = await this.fetch(info.upload_url, {
        method: info.upload_method, headers: info.required_headers,
        body: createReadStream(input.path), duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(300_000),
      });
    } catch { throw new Error('Media upload failed; resume the job to retry the uncompleted upload.'); }
    // Never pass the API credential to signed upload/download hosts.
    if (!response.ok) throw new Error(`Media upload HTTP ${response.status}`);
    return id;
  }
}

export function worldManifest(world, files) {
  const semantics = world.assets?.splats?.semantics_metadata;
  const s = semantics?.metric_scale_factor, g = semantics?.ground_plane_offset;
  const valid = Number.isFinite(s) && s > 0 && Number.isFinite(g);
  // R_x(pi) * T(0,-ground,0) * S(scale), column-major.
  const matrix = valid ? [s,0,0,0, 0,-s,0,0, 0,0,-s,0, 0,g,0,1] : null;
  return {
    schemaVersion: 1, provider: 'worldlabs', worldId: world.world_id ?? world.id,
    displayName: world.display_name, model: world.model, marbleUrl: world.world_marble_url,
    caption: world.assets?.caption, assets: files,
    preferredSplat: files['splat-500k'] ? 'splat-500k' : files['splat-100k'] ? 'splat-100k' : 'splat-full_res',
    coordinates: { appFrame: 'right-handed; +Y up; camera forward -Z', matrixOrder: 'column-major',
      rawFrame: 'marble_raw_opencv', semantics: semantics ?? null, splatToApp: matrix,
      colliderToApp: null, colliderAlignment: 'unverified', worldTransformVersion: 1,
      calibration: 'unmeasured', metricMetadataAvailable: valid },
  };
}
export async function downloadWorld(world, dir, fetchImpl = fetch) {
  const assets = world.assets;
  if (!assets?.splats?.spz_urls || !assets?.mesh?.collider_mesh_url)
    throw new Error('World is missing splat or collider assets. Resume to fetch the world again.');
  const entries = Object.entries(assets.splats.spz_urls).map(([resolution,url]) => [`splat-${resolution}`,url,'.spz']);
  entries.push(['collider',assets.mesh.collider_mesh_url,'.glb']);
  const imageExtension = url => {
    const extension = extname(new URL(url).pathname).toLowerCase();
    return ['.jpg','.jpeg','.png','.webp'].includes(extension) ? extension : '.jpg';
  };
  if (assets.imagery?.pano_url) entries.push(['panorama',assets.imagery.pano_url,imageExtension(assets.imagery.pano_url)]);
  if (assets.thumbnail_url) entries.push(['thumbnail',assets.thumbnail_url,imageExtension(assets.thumbnail_url)]);
  const files = {};
  await mkdir(join(dir,'assets'), { recursive: true });
  for (const [key,url,extension] of entries) {
    if (!/^[a-zA-Z0-9_-]+$/.test(key) || new URL(url).protocol !== 'https:') throw new Error('Invalid asset reference');
    const relativePath = `assets/${key}${extension}`, path = join(dir,relativePath);
    const saved = await readFile(`${path}.json`,'utf8').then(JSON.parse).catch(() => null);
    if (saved && await hashFile(path).catch(() => null) === saved.sha256) { files[key] = saved; continue; }
    let response;
    try { response = await fetchImpl(url, { signal: AbortSignal.timeout(300_000) }); }
    catch { throw new Error(`Download failed for ${key}; resume later.`); }
    if (!response.ok || !response.body) throw new Error(`Download ${key} HTTP ${response.status}; resume to refresh asset URLs.`);
    await pipeline(Readable.fromWeb(response.body),createWriteStream(`${path}.part`));
    const bytes = (await stat(`${path}.part`)).size;
    if (!bytes) throw new Error(`Empty asset: ${key}`);
    await rename(`${path}.part`,path);
    files[key] = { path: relativePath, bytes, sha256: await hashFile(path), contentType: response.headers.get('content-type') };
    await saveJson(`${path}.json`,files[key]);
  }
  const manifest = worldManifest(world,files);
  await saveJson(join(dir,'manifest.json'),manifest);
  return manifest;
}

export async function runJob(client, state, dir, { poll = 10, wait = 1200, log = console.log } = {}) {
  const statePath = join(dir,'job.json');
  if (!state.operationId) {
    if (state.status === 'submitting' || state.status === 'submission-unknown')
      throw new Error('Previous submission outcome is unknown. Check Platform usage/worlds; attach its operation ID with resume --operation ID. Do not start another paid job blindly.');
    const balance = await client.credits();
    const estimate = creditEstimate(state.request);
    if (!Number.isFinite(balance.remaining_credits) || balance.remaining_credits < estimate.max)
      throw new Error(`Need at least ${estimate.max} prepaid API credits for this model; balance=${balance.remaining_credits}.`);
    state.creditsBefore = balance.remaining_credits;
    for (let i=0;i<state.inputs.length;i++) {
      if (state.assetIds[i]) continue;
      if (await hashFile(state.inputs[i].path) !== state.inputs[i].sha256) throw new Error('Input changed since job creation');
      log(`Uploading ${basename(state.inputs[i].path)}`);
      state.assetIds[i] = await client.upload(state.inputs[i]);
      await saveJson(statePath,state);
    }
    state.request = makeRequest(state.inputs,state.assetIds,state.options);
    state.status = 'submitting';
    await saveJson(statePath,state);
    const op = await client.api('/marble/v1/worlds:generate',state.request);
    if (!op.operation_id) throw new Error('Missing operation ID; check Platform before retrying');
    state.operationId = op.operation_id;
    state.operation = op;
    state.status = 'generating';
    await saveJson(statePath,state);
    log(`Generation started: ${state.operationId}`);
  }
  const deadline = Date.now() + wait*1000;
  let op = state.operation?.done ? state.operation : await client.operation(state.operationId);
  while (true) {
    state.operation = op;
    if (op.done) {
      if (op.error) { state.status='failed'; await saveJson(statePath,state); throw new Error(`World generation failed: ${op.error.message || op.error.code}`); }
      const id = op.response?.world_id ?? op.response?.id;
      if (!id) throw new Error('Completed operation has no world ID');
      state.worldId = id; state.status='downloading'; await saveJson(statePath,state);
      const world = await client.world(id);
      await saveJson(join(dir,'world.json'),world);
      await downloadWorld(world,dir,client.fetch);
      state.status = 'complete'; state.completedAt = new Date().toISOString();
      state.creditsAfter = await client.credits().then(v=>v.remaining_credits).catch(()=>null);
      await saveJson(statePath,state);
      log(`World saved: ${join(dir,'manifest.json')}`);
      return state;
    }
    await saveJson(statePath,state);
    if (Date.now() >= deadline) { log('Still generating. Resume this job later; no new generation will be submitted.'); return state; }
    log(`Generating… ${op.metadata?.progress ? JSON.stringify(op.metadata.progress) : ''}`);
    await new Promise(resolve=>setTimeout(resolve, Math.min(poll*1000,Math.max(1,deadline-Date.now()))));
    op = await client.operation(state.operationId);
  }
}
