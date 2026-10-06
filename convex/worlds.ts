// World Labs Marble: generate → poll → cache assets in Convex storage.
import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, ownsWorld, requireOwnedUpload, deleteOwnedUploadTicket } from "./model/auth";
import { maxWorldGenerationCostUsd, reserveDailyBudget, settleDailyBudget } from "./model/budget";

const FAST_MODEL = "marble-1.0-draft";
const POLL_MS = 3000;
const waitBudget = (model: string) => model === FAST_MODEL ? 8 * 60_000 : 15 * 60_000;
const modelValidator = v.union(v.literal("marble-1.0-draft"), v.literal("marble-1.0"), v.literal("marble-1.1"), v.literal("marble-1.1-plus"));
function requireKey() {
  if (!process.env.WLT_API_KEY?.trim()) throw new Error("Room generation is not configured. Set WLT_API_KEY on the Convex backend.");
}
const errorMessage = (e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  const key = process.env.WLT_API_KEY?.trim();
  return (key ? message.split(key).join("[redacted]") : message).slice(0, 500);
};
const BASE = "https://api.worldlabs.ai/marble/v1";
const headers = () => ({
  "WLT-Api-Key": process.env.WLT_API_KEY ?? "",
  "Content-Type": "application/json",
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireIdentity(ctx);
    const worlds = await ctx.db.query("worlds")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId)).order("desc").take(100);
    return Promise.all(
      worlds.map(async (w) => ({
        ...w,
        splatUrl: w.splatStorageId ? await ctx.storage.getUrl(w.splatStorageId) : null,
        colliderUrl: w.colliderStorageId ? await ctx.storage.getUrl(w.colliderStorageId) : null,
        panoUrl: w.panoStorageId ? await ctx.storage.getUrl(w.panoStorageId) : null,
      })),
    );
  },
});

/**
 * Resolve an already imported provider world before uploading its files again.
 * Pass `splatFileName` to require a resolution: the same world imported at 500k is
 * not a substitute for the full-res one the caller is about to upload.
 */
export const byWorldId = query({
  args: { worldId: v.string(), splatFileName: v.optional(v.string()) },
  handler: async (ctx, { worldId, splatFileName }) => {
    const ownerId = await requireIdentity(ctx);
    let candidates = ctx.db.query('worlds').withIndex('by_ownerId_and_worldId', (q) => q.eq('ownerId', ownerId).eq('worldId', worldId))
      .filter((q) => q.eq(q.field('status'), 'ready'));
    if (splatFileName) candidates = candidates.filter((q) => q.eq(q.field('splatFileName'), splatFileName));
    const world = await candidates.first();
    return world ? { _id: world._id, splatUrl: world.splatStorageId ? await ctx.storage.getUrl(world.splatStorageId) : null } : null;
  },
});

export const create = internalMutation({
  args: { name: v.string(), prompt: v.string(), model: v.string(), ownerId: v.string(), budgetReserveUsd: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const budgetDay = args.budgetReserveUsd ? await reserveDailyBudget(ctx, args.budgetReserveUsd, args.ownerId) : undefined;
    const deadline = Date.now() + waitBudget(args.model);
    const id = await ctx.db.insert("worlds", { ...args, budgetDay, status: "generating", stage: "Starting World Labs…", generationDeadline: deadline });
    await ctx.scheduler.runAfter(waitBudget(args.model), internal.worlds.expireGeneration, { id, deadline });
    return id;
  },
});

export const update = internalMutation({
  args: {
    id: v.id("worlds"),
    deadline: v.optional(v.number()),
    patch: v.object({
      status: v.optional(v.union(v.literal("generating"), v.literal("ready"), v.literal("failed"))),
      worldId: v.optional(v.string()),
      operationId: v.optional(v.string()),
      splatStorageId: v.optional(v.id("_storage")),
      colliderStorageId: v.optional(v.id("_storage")),
      panoStorageId: v.optional(v.id("_storage")),
      spzUrl: v.optional(v.string()),
      metricScale: v.optional(v.number()),
      groundOffset: v.optional(v.number()),
      error: v.optional(v.string()),
      stage: v.optional(v.string()),
      retryable: v.optional(v.boolean()),
      submissionStarted: v.optional(v.boolean()),
    }),
  },
  handler: async (ctx, { id, deadline, patch }): Promise<boolean> => {
    const previous = await ctx.db.get(id);
    if (!previous) return false;
    if (deadline !== undefined) {
      if (previous?.status !== "generating" || previous.generationDeadline !== deadline) return false;
    }
    await ctx.db.patch(id, patch);
    if (previous.status === "generating" && (patch.status === "ready" || (patch.status === "failed" && patch.retryable === false && !previous.submissionStarted))) {
      await settleDailyBudget(ctx, previous, patch.status === "ready");
    }
    return true;
  },
});

/** Each check is a short action. The operation ID and deadline survive browser reloads. */
export const generationState = internalQuery({
  args: { id: v.id("worlds") },
  handler: (ctx, { id }) => ctx.db.get(id),
});

export const markSubmissionStarted = internalMutation({
  args: { id: v.id("worlds"), deadline: v.number() },
  handler: async (ctx, { id, deadline }) => {
    const world = await ctx.db.get(id);
    if (!world || world.status !== "generating" || world.generationDeadline !== deadline) return false;
    await ctx.db.patch(id, { submissionStarted: true });
    return true;
  },
});

export const assertOwnedUploads = internalQuery({
  args: { ownerId: v.string(), storageIds: v.array(v.id("_storage")) },
  handler: async (ctx, { ownerId, storageIds }) => {
    for (const storageId of storageIds) {
      const upload = await ctx.db.query("uploads").withIndex("by_storageId", (q) => q.eq("storageId", storageId)).unique();
      if (!upload || upload.ownerId !== ownerId || upload.expiresAt < Date.now()) throw new Error("This upload has expired or does not belong to your account.");
    }
    return true;
  },
});

export const expireGeneration = internalMutation({
  args: { id: v.id("worlds"), deadline: v.number() },
  handler: async (ctx, { id, deadline }) => {
    const world = await ctx.db.get(id);
    if (!world || world.status !== "generating" || world.generationDeadline !== deadline) return;
    await ctx.db.patch(id, { status: "failed", retryable: Boolean(world.operationId),
      error: world.operationId ? "This is taking longer than expected. Resume to check the same generation without starting another." : "World Labs did not return an operation. Check the provider dashboard before creating another world." });
    if (!world.operationId && !world.submissionStarted) await settleDailyBudget(ctx, world, false);
  },
});

// Save progress and schedule the next check in one transaction.
export const schedulePoll = internalMutation({
  args: { id: v.id("worlds"), deadline: v.number(), operationId: v.string(), stage: v.string(), delay: v.number() },
  handler: async (ctx, { id, deadline, operationId, stage, delay }) => {
    const world = await ctx.db.get(id);
    if (world?.status !== "generating" || world.generationDeadline !== deadline) return;
    await ctx.db.patch(id, { operationId, stage });
    if (delay >= 0) await ctx.scheduler.runAfter(delay, internal.worlds.pollGeneration, { id, deadline });
  },
});

export const failGeneration = internalMutation({
  args: { id: v.id("worlds"), deadline: v.number(), error: v.string(), retryable: v.boolean() },
  handler: async (ctx, { id, deadline, error, retryable }) => {
    const world = await ctx.db.get(id);
    if (world?.status === "generating" && world.generationDeadline === deadline) {
      await ctx.db.patch(id, { status: "failed", error, retryable });
      if (!retryable && !world.submissionStarted) await settleDailyBudget(ctx, world, false);
    }
  },
});

export const resumeGeneration = mutation({
  args: { id: v.id("worlds") },
  handler: async (ctx, { id }) => {
    requireKey();
    const ownerId = await requireIdentity(ctx);
    const world = await ownsWorld(ctx, id, ownerId);
    if (!world || world.status !== "failed" || !world.retryable || !world.operationId) return;
    const deadline = Math.max(Date.now() + waitBudget(world.model), (world.generationDeadline ?? 0) + 1);
    await ctx.db.patch(id, { status: "generating", error: undefined, retryable: false, stage: "Checking your existing generation…", generationDeadline: deadline });
    await ctx.scheduler.runAfter(0, internal.worlds.pollGeneration, { id, deadline });
    await ctx.scheduler.runAfter(deadline - Date.now(), internal.worlds.expireGeneration, { id, deadline });
  },
});

async function runGenerate(ctx: ActionCtx, id: Id<"worlds">, worldPrompt: unknown, displayName: string, model: string) {
  const row: Doc<"worlds"> | null = await ctx.runQuery(internal.worlds.generationState, { id });
  if (!row || row.status !== "generating" || !row.generationDeadline) return;
  const deadline = row.generationDeadline;
  let submitted = false;
  const canSubmit: boolean = await ctx.runMutation(internal.worlds.markSubmissionStarted, { id, deadline });
  if (!canSubmit) return;
  try {
    // Never retry this paid POST automatically, including after an ambiguous network error.
    const op = await post("worlds:generate", { display_name: displayName.slice(0, 64), model, world_prompt: worldPrompt });
    if (typeof op.operation_id !== "string" || !op.operation_id) throw new Error("World Labs did not return an operation ID. Check the provider dashboard before trying again.");
    submitted = true;
    await ctx.runMutation(internal.worlds.schedulePoll, { id, deadline, operationId: op.operation_id, stage: "Building your world…", delay: op.done ? -1 : POLL_MS });
    if (op.done) await finishOperation(ctx, id, deadline, op);
  } catch (e) {
    await ctx.runMutation(internal.worlds.failGeneration, { id, deadline,
      error: !submitted ? "World Labs submission did not return an operation ID. Its billing outcome is uncertain; check the provider dashboard before starting another generation." : errorMessage(e),
      retryable: submitted });
  }
}

export const pollGeneration = internalAction({
  args: { id: v.id("worlds"), deadline: v.number() },
  handler: async (ctx, { id, deadline }): Promise<void> => {
    const row: Doc<"worlds"> | null = await ctx.runQuery(internal.worlds.generationState, { id });
    if (row?.status !== "generating" || row.generationDeadline !== deadline || !row.operationId) return;
    if (Date.now() >= deadline) { await ctx.runMutation(internal.worlds.expireGeneration, { id, deadline }); return; }
    try {
      const op = await get(`operations/${row.operationId}`);
      if (op.done) await finishOperation(ctx, id, deadline, op);
      else await ctx.runMutation(internal.worlds.schedulePoll, { id, deadline, operationId: row.operationId,
        stage: typeof op.metadata?.progress?.description === "string" ? op.metadata.progress.description.slice(0, 160) : "Building your world…", delay: POLL_MS });
    } catch (e) {
      await ctx.runMutation(internal.worlds.failGeneration, { id, deadline, error: errorMessage(e), retryable: true });
    }
  },
});

async function finishOperation(ctx: ActionCtx, id: Id<"worlds">, deadline: number, op: any) {
  if (op.error) {
    await ctx.runMutation(internal.worlds.failGeneration, { id, deadline, error: errorMessage(op.error.message ?? "World Labs generation failed."), retryable: false });
    return;
  }
  if (typeof op.response?.world_id !== "string") throw new Error("World Labs completed without returning a world ID.");
  await ctx.runMutation(internal.worlds.update, { id, deadline, patch: { stage: "Downloading your room…" } });
  const world = await get(`worlds/${op.response.world_id}`);
  const spzUrl = world.assets?.splats?.spz_urls?.["500k"] ?? world.assets?.splats?.spz_urls?.full_res;
  if (typeof spzUrl !== "string") throw new Error("World Labs returned no usable room splat.");
  const colliderUrl = world.assets?.mesh?.collider_mesh_url;
  const meta = world.assets?.splats?.semantics_metadata ?? {};
  const downloads = await Promise.allSettled([
    downloadAsset(spzUrl), colliderUrl ? downloadAsset(colliderUrl) : Promise.resolve(undefined),
  ]);
  const failed = downloads.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  const stored: Id<"_storage">[] = [];
  const discard = () => Promise.all(stored.map(storageId => ctx.storage.delete(storageId)));
  try {
    // Network downloads overlap; store only after both downloads are valid.
    // Keep storage writes ordered so partial-write cleanup is deterministic.
    for (const result of downloads) {
      if (result.status === "fulfilled" && result.value) stored.push(await ctx.storage.store(result.value));
    }
    const [splatStorageId, colliderStorageId] = stored;
    // Commit only while this attempt is current; discard late or partial downloads.
    const saved: boolean = await ctx.runMutation(internal.worlds.update, { id, deadline, patch: {
      status: "ready", stage: "Ready", retryable: false, worldId: op.response.world_id, spzUrl, splatStorageId, colliderStorageId,
      ...(Number.isFinite(meta.metric_scale_factor) && { metricScale: meta.metric_scale_factor }),
      ...(Number.isFinite(meta.ground_plane_offset) && { groundOffset: meta.ground_plane_offset }),
    } });
    if (!saved) { await discard(); return; }
  } catch (e) { await discard(); throw e; }
  const panoUrl = world.assets?.imagery?.pano_url;
  if (typeof panoUrl === "string") await ctx.scheduler.runAfter(0, internal.worlds.cachePanorama, { id, url: panoUrl });
}

export const cachePanorama = internalAction({
  args: { id: v.id("worlds"), url: v.string() },
  handler: async (ctx, { id, url }): Promise<void> => {
    try {
      const panoStorageId = await cacheAsset(ctx, url);
      await ctx.runMutation(internal.worlds.update, { id, patch: { panoStorageId } });
    } catch { /* A thumbnail is optional; never fail or delay a usable room. */ }
  },
});

/** Text generation also returns immediately and opens the same reactive viewer. */
export const generateFromText = action({
  args: { prompt: v.string(), model: v.optional(modelValidator), name: v.optional(v.string()) },
  handler: async (ctx, { prompt, model = FAST_MODEL, name }): Promise<Id<"worlds">> => {
    const ownerId = await requireIdentity(ctx);
    requireKey();
    if (!prompt.trim()) throw new Error("Describe the room first.");
    const id = await ctx.runMutation(internal.worlds.create, { name: name ?? prompt.slice(0, 40), prompt, model, ownerId, budgetReserveUsd: maxWorldGenerationCostUsd(model) });
    await ctx.scheduler.runAfter(0, internal.worlds.runFromText, { id, prompt, model, name: name ?? prompt });
    return id;
  },
});

export const runFromText = internalAction({
  args: { id: v.id("worlds"), prompt: v.string(), model: v.string(), name: v.string() },
  handler: async (ctx, { id, prompt, model, name }): Promise<void> => {
    await runGenerate(ctx, id, { type: "text", text_prompt: prompt }, name, model);
  },
});

export const startFromMedia = mutation({
  args: { storageId: v.id("_storage"), kind: v.union(v.literal("image"), v.literal("video")), name: v.optional(v.string()), model: v.optional(modelValidator) },
  handler: async (ctx, { storageId, kind, name, model }): Promise<Id<"worlds">> => {
    const ownerId = await requireIdentity(ctx);
    requireKey();
    await requireOwnedUpload(ctx, storageId, ownerId);
    const file = await ctx.db.system.get(storageId);
    const types = kind === "video" ? ["video/mp4", "video/quicktime", "video/webm"] : ["image/jpeg", "image/png", "image/webp"];
    if (!file || !types.includes(file.contentType ?? "")) throw new Error(`Choose a supported ${kind} upload.`);
    const max = (kind === "video" ? 100 : 20) * 1024 * 1024;
    if (!file.size || file.size > max) throw new Error(`The ${kind} must be nonempty and ${kind === "video" ? 100 : 20} MB or smaller.`);
    const displayName = name?.trim() || "My room";
    const chosenModel = model ?? FAST_MODEL;
    const budgetReserveUsd = maxWorldGenerationCostUsd(model ?? FAST_MODEL);
    const budgetDay = await reserveDailyBudget(ctx, budgetReserveUsd, ownerId);
    const deadline = Date.now() + waitBudget(chosenModel);
    const id = await ctx.db.insert("worlds", { ownerId, budgetDay, budgetReserveUsd, sourceStorageId: storageId, name: displayName, prompt: "", model: chosenModel, status: "generating", stage: "Starting World Labs…", generationDeadline: deadline });
    await ctx.scheduler.runAfter(0, internal.worlds.runFromMedia, { id, storageId, kind, model: chosenModel, name: displayName });
    await ctx.scheduler.runAfter(waitBudget(chosenModel), internal.worlds.expireGeneration, { id, deadline });
    return id;
  },
});

export const runFromMedia = internalAction({
  args: { id: v.id("worlds"), storageId: v.id("_storage"), kind: v.union(v.literal("image"), v.literal("video")), model: v.string(), name: v.string() },
  handler: async (ctx, { id, storageId, kind, model, name }): Promise<void> => {
    const mediaUrl = await ctx.storage.getUrl(storageId);
    if (!mediaUrl) {
      await ctx.runMutation(internal.worlds.update, { id, patch: { status: "failed", error: "The uploaded file is no longer in storage. Please try again." } });
      return;
    }
    await runGenerate(ctx, id, { type: kind, [`${kind}_prompt`]: { source: "uri", uri: mediaUrl } }, name, model);
  },
});

/** Short-lived URL the browser POSTs one extracted zip asset to. See src/lib/worldZip.ts. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireIdentity(ctx);
    const token = crypto.randomUUID();
    const url = await ctx.storage.generateUploadUrl();
    await ctx.db.insert("uploads", { ownerId, token, expiresAt: Date.now() + 60 * 60_000 });
    return { url, token };
  },
});

export const claimUpload = mutation({
  args: { token: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, { token, storageId }) => {
    const ownerId = await requireIdentity(ctx);
    const ticket = await ctx.db.query("uploads").withIndex("by_token", (q) => q.eq("token", token)).unique();
    if (!ticket || ticket.ownerId !== ownerId || ticket.expiresAt < Date.now()) throw new Error("This upload has expired. Please upload it again.");
    const metadata = await ctx.db.system.get(storageId);
    if (!metadata || metadata.size === 0 || metadata.size > 100 * 1024 * 1024) throw new Error("The uploaded file is empty or too large.");
    await ctx.db.patch(ticket._id, { storageId });
    return null;
  },
});

/**
 * Register a world whose assets were unzipped and uploaded by the client
 * (`hackathon-room-full.zip` from scripts/package_room.py, or any zip with a splat
 * plus an optional collider). No provider call, so it works with the venue Wi-Fi down.
 */
export const importUploaded = mutation({
  args: {
    name: v.string(),
    splatStorageId: v.id("_storage"),
    splatFileName: v.optional(v.string()),
    colliderStorageId: v.optional(v.id("_storage")),
    panoStorageId: v.optional(v.id("_storage")),
    worldId: v.optional(v.string()),
    model: v.optional(v.string()),
    prompt: v.optional(v.string()),
    metricScale: v.optional(v.number()),
    groundOffset: v.optional(v.number()),
    reuseExisting: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<Id<"worlds">> => {
    const ownerId = await requireIdentity(ctx);
    await requireOwnedUpload(ctx, a.splatStorageId, ownerId);
    for (const fileId of [a.colliderStorageId, a.panoStorageId]) if (fileId) await requireOwnedUpload(ctx, fileId, ownerId);
    if (a.reuseExisting && a.worldId) {
      let candidates = ctx.db.query('worlds').withIndex('by_ownerId_and_worldId', (q) => q.eq('ownerId', ownerId).eq('worldId', a.worldId))
        .filter((q) => q.eq(q.field('status'), 'ready'));
      // Same rule as byWorldId: only a row holding this same splat counts as already imported.
      if (a.splatFileName) candidates = candidates.filter((q) => q.eq(q.field('splatFileName'), a.splatFileName));
      const existing = await candidates.first();
      if (existing?.splatStorageId && await ctx.storage.getUrl(existing.splatStorageId)) return existing._id;
    }
    return ctx.db.insert("worlds", {
      ownerId,
      name: a.name,
      prompt: a.prompt ?? "",
      model: a.model ?? "upload",
      status: "ready",
      worldId: a.worldId,
      splatStorageId: a.splatStorageId,
      splatFileName: a.splatFileName,
      colliderStorageId: a.colliderStorageId,
      panoStorageId: a.panoStorageId,
      metricScale: a.metricScale,
      groundOffset: a.groundOffset,
    });
  },
});

/** Import a world you already generated in the Marble app (paste the world_id). Costs nothing. */
export const importExisting = action({
  args: { worldId: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, { worldId, name }): Promise<Id<"worlds">> => {
    const ownerId = await requireIdentity(ctx);
    const world = await get(`worlds/${worldId}`);
    const id = await ctx.runMutation(internal.worlds.create, {
      name: name ?? world.display_name ?? worldId, prompt: world.caption ?? "", model: world.model ?? "unknown", ownerId,
    });
    const spzUrl: string = world.assets.splats.spz_urls["500k"] ?? world.assets.splats.spz_urls.full_res;
    const colliderUrl: string | undefined = world.assets.mesh?.collider_mesh_url;
    const meta = world.assets.splats.semantics_metadata ?? {};
    const splatStorageId = await ctx.storage.store(await (await fetch(spzUrl)).blob());
    const colliderStorageId = colliderUrl ? await ctx.storage.store(await (await fetch(colliderUrl)).blob()) : undefined;
    await ctx.runMutation(internal.worlds.update, {
      id, patch: { status: "ready", worldId, spzUrl, splatStorageId, colliderStorageId,
        metricScale: meta.metric_scale_factor, groundOffset: meta.ground_plane_offset },
    });
    return id;
  },
});

export const deleteWorld = mutation({
  args: { id: v.id("worlds") },
  handler: async (ctx, { id }) => {
    const ownerId = await requireIdentity(ctx);
    const world = await ownsWorld(ctx, id, ownerId);
    const placements = await ctx.db.query("placements")
      .withIndex("by_ownerId_and_room", (q) => q.eq("ownerId", ownerId).eq("room", id)).take(500);
    for (const placement of placements) await ctx.db.delete("placements", placement._id);
    for (const fileId of [world.sourceStorageId, world.splatStorageId, world.colliderStorageId, world.panoStorageId]) {
      if (fileId) {
        await ctx.storage.delete(fileId);
        await deleteOwnedUploadTicket(ctx, fileId, ownerId);
      }
    }
    await ctx.db.delete("worlds", id);
    if (world.budgetDay && world.budgetReserveUsd && world.status === "generating" && !world.operationId && !world.submissionStarted) {
      await settleDailyBudget(ctx, world, false);
    }
  },
});

// Bound the full response read as well as connection time. Asset fetches carry no API key.
async function request<T>(url: string, init: RequestInit, read: (r: Response) => Promise<T>, timeout = 60_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`World Labs request failed (HTTP ${response.status}).`);
    return await read(response);
  } finally { clearTimeout(timer); }
}
async function downloadAsset(url: string) {
  const blob = await request(url, {}, r => r.blob(), 120_000);
  if (!blob.size) throw new Error("World Labs returned an empty asset.");
  return blob;
}
async function cacheAsset(ctx: ActionCtx, url: string) {
  return ctx.storage.store(await downloadAsset(url));
}
async function post(path: string, body: unknown) {
  return request(`${BASE}/${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) }, r => r.json());
}
async function get(path: string) {
  return request(`${BASE}/${path}`, { headers: headers() }, r => r.json());
}
