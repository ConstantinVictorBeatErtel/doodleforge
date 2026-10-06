import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // A World Labs (Marble) generated world, cached into Convex storage.
  worlds: defineTable({
    ownerId: v.optional(v.string()), // Missing on legacy rows: keep those records private.
    budgetDay: v.optional(v.string()),
    budgetReserveUsd: v.optional(v.number()),
    submissionStarted: v.optional(v.boolean()),
    sourceStorageId: v.optional(v.id("_storage")),
    name: v.string(),
    prompt: v.string(),
    model: v.string(),
    status: v.union(v.literal("generating"), v.literal("ready"), v.literal("failed")),
    worldId: v.optional(v.string()),          // World Labs world_id
    operationId: v.optional(v.string()),
    generationDeadline: v.optional(v.number()),
    stage: v.optional(v.string()),
    retryable: v.optional(v.boolean()),
    splatStorageId: v.optional(v.id("_storage")),   // cached 500k .spz
    splatFileName: v.optional(v.string()),    // e.g. "splat-500k.spz" — Convex storage URLs have no extension
    colliderStorageId: v.optional(v.id("_storage")), // cached collider .glb
    panoStorageId: v.optional(v.id("_storage")),
    spzUrl: v.optional(v.string()),           // original signed URL (may expire)
    metricScale: v.optional(v.number()),
    groundOffset: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_worldId", ["worldId"])
    .index("by_ownerId", ["ownerId"])
    .index("by_ownerId_and_worldId", ["ownerId", "worldId"]),

  // A Tripo generated object, cached into Convex storage (Tripo URLs die in 5 min).
  assets: defineTable({
    ownerId: v.optional(v.string()),
    budgetDay: v.optional(v.string()),
    budgetReserveUsd: v.optional(v.number()),
    submissionStarted: v.optional(v.boolean()),
    drawingStorageIds: v.optional(v.array(v.id("_storage"))),
    prompt: v.string(),
    model: v.string(),
    status: v.union(v.literal("generating"), v.literal("ready"), v.literal("failed")),
    taskId: v.optional(v.string()),
    glbStorageId: v.optional(v.id("_storage")),
    thumbnailUrl: v.optional(v.string()),
    error: v.optional(v.string()),
    // Sketch pipeline: the client watches these instead of polling a job endpoint.
    description: v.optional(v.string()),        // what the user typed under their drawing
    stage: v.optional(v.union(                  // drives the Image -> Cutout -> 3D card
      v.literal("image"), v.literal("cutout"), v.literal("mesh"), v.literal("done"))),
    progress: v.optional(v.number()),           // Tripo task progress, 0-100
    cutoutStorageId: v.optional(v.id("_storage")), // the isolated object PNG fed to Tripo
    hasSurfaceColor: v.optional(v.boolean()),   // inspectGlb verdict, not a promise of fidelity
  }).index("by_ownerId", ["ownerId"]),

  // Placed instances of assets inside a room (position/rotation/scale).
  placements: defineTable({
    ownerId: v.optional(v.string()),
    room: v.string(),
    assetId: v.id("assets"),
    position: v.array(v.number()),
    rotation: v.array(v.number()),
    scale: v.number(),
    // Longest dimension in metres, from the sketch size estimate (see fitDrawing).
    // Without it a reload re-normalizes every object to the 0.5 m default.
    targetSize: v.optional(v.number()),
  })
    .index("by_room", ["room"])
    .index("by_ownerId", ["ownerId"])
    .index("by_ownerId_and_room", ["ownerId", "room"])
    .index("by_assetId", ["assetId"]),

  dailyBudgets: defineTable({
    utcDay: v.string(),
    spentUsd: v.number(),
    reservedUsd: v.number(),
  }).index("by_utcDay", ["utcDay"]),

  generationRateLimits: defineTable({ ownerId: v.string(), minute: v.number(), count: v.number() })
    .index("by_ownerId", ["ownerId"]),

  uploads: defineTable({
    ownerId: v.string(),
    token: v.string(),
    storageId: v.optional(v.id("_storage")),
    expiresAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_storageId", ["storageId"])
    .index("by_ownerId", ["ownerId"]),

  // Multiplayer: one doc per player, ~5 Hz updates, lerp on client.
  players: defineTable({
    room: v.string(),
    sessionId: v.string(),
    name: v.string(),
    color: v.string(),
    position: v.array(v.number()),
    yaw: v.number(),
    lastSeen: v.number(),
  })
    .index("by_room", ["room"])
    .index("by_session", ["sessionId"]),
});
