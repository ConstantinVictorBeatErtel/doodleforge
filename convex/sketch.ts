"use node";
// Sketch -> color GLB, as one Convex action.
//
// This is the pipeline verified in COLOR_PIPELINE.md, moved out of the local Node
// server (server/asset-pipeline.js) so keys stay in the Convex deployment and the
// finished object lands in Convex storage where every player in the room can see it.
//
//   drawing + clean view  -> fal FLUX.2 Klein 9B edit   (isolated object on white)
//                         -> fal BiRefNet                (transparent cutout)
//                         -> Tripo P1 image_to_model     (textured GLB)
//                         -> inspectGlb requireColor     (reject the gray base mesh)
//                         -> Convex storage
//
// Progress is written onto the asset row, so the client just watches it with
// useQuery — no job endpoint and no polling loop. These are internal actions kicked
// off by assets.startSketch / assets.resumeSketch, which return the asset id straight
// away; the client never holds a minute-long request open.
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { credentials, makeApi, generationPayload, waitForTask, MODEL } from "./tripo";
// Reused verbatim from the CLI: Klein + BiRefNet + the PNG alpha check.
import { runWorkflow } from "../scripts/image-benchmark/providers.mjs";

// providers.mjs is plain JS. convex/tsconfig.json has allowJs, so its inference (which
// only sees the defaults, losing `env`, `imageUrls` and onProgress's argument) wins over
// the ambient declaration in pipeline-modules.d.ts. Restate the call shape for both.
const runSketchWorkflow = runWorkflow as unknown as (
  id: "klein-9b",
  prompt: string,
  options: { env: Record<string, string | undefined>; imageUrls: string[]; onProgress?: (stage: string) => void },
) => Promise<{ status: "ok" | "failed" | "invalid-alpha"; error?: string; bytes: Uint8Array }>;
// Pure GLB container inspection — no three.js, safe to bundle.
import { inspectGlb, modelArtifact } from "../scripts/glb-assets.mjs";
const TASK_TIMEOUT_MS = 300_000;

/**
 * The drawing marks are instructions, not geometry. This wording is what produced a
 * clean isolated object from an annotated room screenshot; changing it changes results.
 */
function buildPrompt(description: string, hasCleanView: boolean) {
  return [
    "Create a polished isolated object from the annotated scene in image 1 and the user description.",
    "The colored drawing marks identify the object or desired outline. Interpret those marks as instructions; remove all drawing ink from the result.",
    hasCleanView ? "Image 2 shows the same scene without drawing marks for context." : "",
    "Preserve the requested colors, surface patterns and material appearance in the object; drawing ink color is only an annotation unless requested.",
    "Show only the requested object, complete and centered, in a clear three-quarter product view with visible depth and padding.",
    "Remove the room, surrounding objects, text, UI, cast shadows and ground plane. Use a plain white background for clean extraction. Preserve requested holes, openings and geometric features.",
    "User request: " + description,
  ].filter(Boolean).join("\n");
}

const redact = (message: string) => {
  let out = message;
  for (const secret of [process.env.TRIPO_API_KEY, process.env.FAL_KEY]) {
    if (secret?.trim()) out = out.split(secret.trim()).join("[redacted]");
  }
  return out;
};

/**
 * One paid Tripo task per run. The task ID is stored before polling starts, so a
 * reload or a retry resumes the existing task instead of submitting another one.
 */
export const run = internalAction({
  args: {
    id: v.id("assets"),
    imageStorageId: v.id("_storage"),          // the view with the drawing on it
    cleanStorageId: v.optional(v.id("_storage")), // the same view without ink
    description: v.string(),
  },
  handler: async (ctx, { id, imageStorageId, cleanStorageId, description }): Promise<Id<"assets">> => {
    const text = description.trim();
    const patch = (p: Record<string, unknown>) =>
      ctx.runMutation(internal.assets.update, { id, patch: p as any });

    try {
      const canSubmit: boolean = await ctx.runMutation(internal.assets.markSubmissionStarted, { id });
      if (!canSubmit) return id;
      // Convex storage URLs are public, so fal can fetch the drawing directly.
      const urls = (await Promise.all(
        [imageStorageId, cleanStorageId].filter(Boolean).map((s) => ctx.storage.getUrl(s as Id<"_storage">)),
      )).filter((u): u is string => Boolean(u));
      if (!urls.length) throw new Error("The drawing is no longer in storage. Sketch it again.");

      // Klein edit + BiRefNet cutout + alpha validation, in one call.
      const result = await runSketchWorkflow("klein-9b", buildPrompt(text, urls.length > 1), {
        env: process.env,
        imageUrls: urls,
        onProgress: (name) => { if (name === "backgroundRemoval") void patch({ stage: "cutout" }); },
      });
      if (result.status !== "ok") {
        throw new Error(result.error || "No usable transparent image was produced. 3D generation was not started.");
      }
      if (!await ctx.runQuery(internal.assets.byId, { id })) return id;
      const cutout = new Blob([result.bytes as BlobPart], { type: "image/png" });
      const cutoutStorageId = await ctx.storage.store(cutout);
      await patch({ stage: "mesh", cutoutStorageId });

      const api = makeApi(credentials());
      const form = new FormData();
      form.append("file", cutout, "object.png");
      const uploaded = await api("/upload/sts", { method: "POST", body: form });
      if (!uploaded.image_token) throw new Error("Tripo upload returned no image token.");
      if (!await ctx.runQuery(internal.assets.byId, { id })) return id;

      const submitted = await api("/task", { method: "POST", body: generationPayload(uploaded.image_token, "png", { color: true }) });
      if (!submitted.task_id) throw new Error("Tripo returned no task ID. Check its task history before creating again.");
      // Persist before polling: a retry must never resubmit paid work.
      await patch({ taskId: submitted.task_id });

      const task = await waitForTask(api, submitted.task_id, {
        timeoutMs: TASK_TIMEOUT_MS, pollMs: 2000,
        onProgress: (t: any) => { if (typeof t.progress === "number") void patch({ progress: t.progress }); },
      });

      if (!await ctx.runQuery(internal.assets.byId, { id })) return id;
      const glbStorageId = await downloadModel(ctx, task);
      await patch({
        status: "ready", stage: "done", progress: 100, glbStorageId,
        thumbnailUrl: task.output?.rendered_image_url,
        hasSurfaceColor: true,
      });
      return id;
    } catch (e: any) {
      await patch({ status: "failed", error: redact(String(e?.message ?? e)) });
      throw e;
    }
  },
});

/**
 * Pick up a task that was already paid for — the mesh finished but the download,
 * the color check or the deploy did not. Never submits a new task.
 */
export const resumeRun = internalAction({
  args: { assetId: v.id("assets") },
  handler: async (ctx, { assetId }): Promise<Id<"assets">> => {
    const asset = await ctx.runQuery(internal.assets.byId, { id: assetId });
    if (!asset) throw new Error("That object no longer exists.");
    if (!asset.taskId) throw new Error("This object has no saved Tripo task to resume.");
    const patch = (p: Record<string, unknown>) =>
      ctx.runMutation(internal.assets.update, { id: assetId, patch: p as any });
    await patch({ status: "generating", stage: "mesh", error: undefined });
    try {
      const api = makeApi(credentials());
      const task = await waitForTask(api, asset.taskId, {
        timeoutMs: TASK_TIMEOUT_MS, pollMs: 2000,
        onProgress: (t: any) => { if (typeof t.progress === "number") void patch({ progress: t.progress }); },
      });
      const glbStorageId = await downloadModel(ctx, task);
      await patch({
        status: "ready", stage: "done", progress: 100, glbStorageId,
        thumbnailUrl: task.output?.rendered_image_url, hasSurfaceColor: true,
      });
      return assetId;
    } catch (e: any) {
      await patch({ status: "failed", error: redact(String(e?.message ?? e)) });
      throw e;
    }
  },
});

/**
 * Tripo artifact URLs expire in minutes, so download immediately. `modelArtifact`
 * prefers the finished textured model over the gray base mesh; `inspectGlb` then
 * refuses a result that carries no base-color texture or vertex colors at all.
 */
async function downloadModel(ctx: { storage: { store: (b: Blob) => Promise<Id<"_storage">> } }, task: any): Promise<Id<"_storage">> {
  const { url } = modelArtifact(task, { color: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Mesh download failed (HTTP ${response.status}). Resume the saved task.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  inspectGlb(bytes, { requireColor: true });
  return await ctx.storage.store(new Blob([bytes as BlobPart], { type: "model/gltf-binary" }));
}
