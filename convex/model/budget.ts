import type { MutationCtx } from "../_generated/server";

export const DAILY_AI_BUDGET_USD = 50;
export const GENERATIONS_PER_MINUTE_PER_USER = 3;

export function requiredMaxCostUsd(name: string): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0 || value > DAILY_AI_BUDGET_USD) {
    throw new Error(`${name} must be configured on the Convex deployment as the conservative maximum USD cost for one complete generation.`);
  }
  return Math.ceil(value * 100) / 100;
}

export function maxWorldGenerationCostUsd(model: string): number {
  const key = model === "marble-1.0-draft" ? "WORLD_LABS_MAX_DRAFT_USD"
    : model === "marble-1.1-plus" ? "WORLD_LABS_MAX_PLUS_USD" : "WORLD_LABS_MAX_STANDARD_USD";
  return requiredMaxCostUsd(key);
}

export async function reserveDailyBudget(ctx: MutationCtx, amountUsd: number, ownerId: string): Promise<string> {
  const minute = Math.floor(Date.now() / 60_000);
  const limit = await ctx.db.query("generationRateLimits").withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId)).unique();
  if (limit?.minute === minute && limit.count >= GENERATIONS_PER_MINUTE_PER_USER) {
    throw new Error("Too many generations in a short time. Wait a minute before starting another.");
  }
  if (limit?.minute === minute) await ctx.db.patch(limit._id, { count: limit.count + 1 });
  else if (limit) await ctx.db.patch(limit._id, { minute, count: 1 });
  else await ctx.db.insert("generationRateLimits", { ownerId, minute, count: 1 });

  const utcDay = new Date().toISOString().slice(0, 10);
  const day = await ctx.db.query("dailyBudgets").withIndex("by_utcDay", (q) => q.eq("utcDay", utcDay)).unique();
  const spent = day?.spentUsd ?? 0;
  const reserved = day?.reservedUsd ?? 0;
  if (spent + reserved + amountUsd > DAILY_AI_BUDGET_USD) {
    throw new Error("AI generation is paused because today's generation budget has been reached. Please try again tomorrow.");
  }
  if (day) await ctx.db.patch(day._id, { reservedUsd: reserved + amountUsd });
  else await ctx.db.insert("dailyBudgets", { utcDay, spentUsd: 0, reservedUsd: amountUsd });
  return utcDay;
}

export async function settleDailyBudget(
  ctx: MutationCtx,
  row: { budgetDay?: string; budgetReserveUsd?: number },
  succeeded: boolean,
): Promise<void> {
  if (!row.budgetDay || !row.budgetReserveUsd) return;
  const day = await ctx.db.query("dailyBudgets")
    .withIndex("by_utcDay", (q) => q.eq("utcDay", row.budgetDay!))
    .unique();
  if (!day) return;
  const amount = row.budgetReserveUsd;
  await ctx.db.patch(day._id, {
    reservedUsd: Math.max(0, day.reservedUsd - amount),
    spentUsd: day.spentUsd + (succeeded ? amount : 0),
  });
}
