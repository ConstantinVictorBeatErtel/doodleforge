import type { ConvexReactClient } from 'convex/react';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { readWorldZip, type ZipEntry, type ZipWorld } from './worldZip';

type Manifest = {
  worldId?: string;
  displayName?: string;
  model?: string;
  caption?: string;
  preferredSplat?: string;
  assets?: Record<string, { path: string }>;
  coordinates?: { semantics?: { metric_scale_factor?: number; ground_plane_offset?: number } };
};

/** One import path for CLI manifests and ZIPs, feeding the original Convex viewer. */
export class ConvexProjectClient {
  private readonly pending = new Map<string, Promise<Id<'worlds'>>>();

  constructor(private readonly convex: Pick<ConvexReactClient, 'query' | 'mutation'>) {}

  /** Legacy `?job=` links: a capture the CLI saved locally under `public/world-assets/`. */
  importLocalWorld(job: string): Promise<Id<'worlds'>> {
    return this.once(job, () => this.loadLocalWorld(job));
  }

  async importZip(file: File): Promise<Id<'worlds'>> {
    return this.importWorld(await readWorldZip(file));
  }

  private once(key: string, operation: () => Promise<Id<'worlds'>>): Promise<Id<'worlds'>> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = operation().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private loadLocalWorld(job: string): Promise<Id<'worlds'>> {
    if (!/^[a-zA-Z0-9_-]+$/.test(job)) throw new Error('Invalid saved room reference.');
    return this.loadSavedWorld(`/world-assets/${job}/`);
  }

  /** Import a manifest + its assets, saved locally by the capture CLI. */
  private async loadSavedWorld(base: string): Promise<Id<'worlds'>> {
    const response = await fetch(`${base}manifest.json`);
    if (!response.ok) throw new Error('The saved room is not available. Import its world ZIP from the existing app, then try again.');
    const manifest = await response.json() as Manifest;
    if (!manifest.assets) throw new Error('The saved room manifest has no assets.');
    // The manifest's own pick first, the same order readWorldZip uses.
    const splatKey = [manifest.preferredSplat, 'splat-500k', 'splat-full_res', 'splat-150k', 'splat-100k']
      .find((key) => key && manifest.assets?.[key]) ?? 'splat-100k';
    const splatFileName = manifest.assets[splatKey]?.path.split('/').pop();
    if (manifest.worldId) {
      // Same world at a different resolution is a different import: reusing the 500k
      // row here would silently keep serving it after the capture moved to full_res.
      const existing = await this.convex.query(api.worlds.byWorldId, { worldId: manifest.worldId, splatFileName });
      if (existing?.splatUrl) return existing._id;
    }
    const readAsset = async (key: string): Promise<ZipEntry | undefined> => {
      const path = manifest.assets?.[key]?.path;
      if (!path) return undefined;
      if (!/^assets\/[a-zA-Z0-9_.-]+$/.test(path)) throw new Error('Invalid saved asset path.');
      const asset = await fetch(`${base}${path}`);
      if (!asset.ok) throw new Error(`Unable to read saved asset: ${path}`);
      return { name: path.slice('assets/'.length), blob: await asset.blob() };
    };
    const [splat, collider, pano] = await Promise.all([
      readAsset(splatKey), readAsset('collider'), readAsset('panorama'),
    ]);
    if (!splat) throw new Error('The saved room has no splat to display.');
    const semantics = manifest.coordinates?.semantics;
    return this.importWorld({
      name: manifest.displayName ?? 'doodleforge room',
      worldId: manifest.worldId, model: manifest.model, prompt: manifest.caption,
      metricScale: semantics?.metric_scale_factor, groundOffset: semantics?.ground_plane_offset,
      splat, collider, pano,
    }, true);
  }

  async importWorld(world: ZipWorld, reuseExisting = false): Promise<Id<'worlds'>> {
    const store = async (entry?: ZipEntry): Promise<Id<'_storage'> | undefined> => {
      if (!entry) return undefined;
      const ticket = await this.convex.mutation(api.worlds.generateUploadUrl, {});
      const response = await fetch(ticket.url, { method: 'POST', headers: { 'Content-Type': entry.blob.type || 'application/octet-stream' }, body: entry.blob });
      if (!response.ok) throw new Error(`Unable to upload ${entry.name}. Please retry.`);
      const result = await response.json() as { storageId?: string };
      if (!result.storageId) throw new Error(`Storage did not return an ID for ${entry.name}.`);
      const storageId = result.storageId as Id<'_storage'>;
      await this.convex.mutation(api.worlds.claimUpload, { token: ticket.token, storageId });
      return storageId;
    };
    const [splatStorageId, colliderStorageId, panoStorageId] = await Promise.all([
      store(world.splat), store(world.collider), store(world.pano),
    ]);
    return this.convex.mutation(api.worlds.importUploaded, {
      name: world.name, splatStorageId: splatStorageId!, splatFileName: world.splat.name,
      colliderStorageId, panoStorageId, worldId: world.worldId, model: world.model, prompt: world.prompt,
      metricScale: world.metricScale, groundOffset: world.groundOffset, reuseExisting,
    });
  }
}
