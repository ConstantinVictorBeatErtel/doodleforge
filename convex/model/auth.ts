import type { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export type AuthCtx = QueryCtx | MutationCtx | ActionCtx;

/** A stable, issuer-qualified key for ownership records. */
export async function requireIdentity(ctx: AuthCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Sign in to continue.");
  return identity.tokenIdentifier;
}

export async function ownsWorld(ctx: QueryCtx | MutationCtx, id: Id<"worlds">, owner: string) {
  const doc = await ctx.db.get(id);
  if (!doc || doc.ownerId !== owner) throw new Error("World not found.");
  return doc;
}

export async function ownsAsset(ctx: QueryCtx | MutationCtx, id: Id<"assets">, owner: string) {
  const doc = await ctx.db.get(id);
  if (!doc || doc.ownerId !== owner) throw new Error("Object not found.");
  return doc;
}

export async function ownsPlacement(ctx: QueryCtx | MutationCtx, id: Id<"placements">, owner: string) {
  const doc = await ctx.db.get(id);
  if (!doc || doc.ownerId !== owner) throw new Error("Placement not found.");
  return doc;
}

export async function requireOwnedUpload(ctx: MutationCtx, id: Id<"_storage">, owner: string) {
  const upload = await ctx.db.query("uploads").withIndex("by_storageId", (q) => q.eq("storageId", id)).unique();
  if (!upload || upload.ownerId !== owner || upload.expiresAt < Date.now()) {
    throw new Error("This upload has expired or does not belong to your account. Upload it again.");
  }
  return upload;
}

export async function deleteOwnedUploadTicket(ctx: MutationCtx, id: Id<"_storage">, owner: string) {
  const tickets = await ctx.db.query("uploads").withIndex("by_storageId", (q) => q.eq("storageId", id)).take(50);
  for (const ticket of tickets) if (ticket.ownerId === owner) await ctx.db.delete("uploads", ticket._id);
}
