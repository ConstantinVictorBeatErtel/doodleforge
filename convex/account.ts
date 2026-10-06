import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity } from "./model/auth";

async function deleteStorageIfPresent(ctx: MutationCtx, id: Id<"_storage">) {
  if (await ctx.db.system.get(id)) await ctx.storage.delete(id);
}

/** Remove a small bounded batch on each transaction so large accounts can be deleted safely. */
export const deleteBatch = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    const placements = await ctx.db.query("placements")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId)).take(50);
    for (const row of placements) await ctx.db.delete("placements", row._id);

    const worlds = await ctx.db.query("worlds")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId)).take(10);
    for (const row of worlds) {
      for (const fileId of [row.sourceStorageId, row.splatStorageId, row.colliderStorageId, row.panoStorageId]) {
        if (fileId) await deleteStorageIfPresent(ctx, fileId);
      }
      await ctx.db.delete("worlds", row._id);
    }

    const assets = await ctx.db.query("assets")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId)).take(10);
    for (const row of assets) {
      for (const fileId of [row.glbStorageId, row.cutoutStorageId, ...(row.drawingStorageIds ?? [])]) {
        if (fileId) await deleteStorageIfPresent(ctx, fileId);
      }
      await ctx.db.delete("assets", row._id);
    }

    const uploads = await ctx.db.query("uploads").withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId)).take(50);
    for (const row of uploads) {
      if (row.storageId) await deleteStorageIfPresent(ctx, row.storageId);
      await ctx.db.delete("uploads", row._id);
    }
    const rateLimit = await ctx.db.query("generationRateLimits")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId)).unique();
    if (rateLimit) await ctx.db.delete("generationRateLimits", rateLimit._id);

    if (placements.length === 50 || worlds.length === 10 || assets.length === 10 || uploads.length === 50) {
      await ctx.scheduler.runAfter(0, internal.account.deleteBatch, { ownerId });
    }
  },
});

/** Call before revoking the Clerk session; queued batches are private internal work. */
export const deleteMyData = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireIdentity(ctx);
    await ctx.scheduler.runAfter(0, internal.account.deleteBatch, { ownerId });
    return null;
  },
});
