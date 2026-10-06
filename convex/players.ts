// Multiplayer presence + movement. One doc per player; client sends ~5 Hz; remote players are lerped.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

const disabled = () => { throw new Error("Multiplayer is disabled for this release."); };

export const inRoom = query({
  args: { room: v.string() },
  handler: async (ctx, { room }): Promise<Doc<"players">[]> => {
    void ctx; void room; return disabled();
  },
});

export const join = mutation({
  args: { room: v.string(), sessionId: v.string(), name: v.string(), color: v.string() },
  handler: async (): Promise<Id<"players">> => disabled(),
});

export const move = mutation({
  args: { sessionId: v.string(), position: v.array(v.number()), yaw: v.number() },
  handler: async (): Promise<void> => disabled(),
});

export const heartbeat = mutation({
  args: { sessionId: v.string() },
  handler: async (): Promise<void> => disabled(),
});
