import type { SessionStats } from "./bet-executor.js";
import type { BetRecord } from "./types.js";

type DailySpendRecord = Pick<
  BetRecord,
  "paper" | "outcome" | "placedAt" | "filledCost" | "cost"
>;

export function utcDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Rebuild today's live exposure from persisted P&L history.
 * This makes the UTC daily cap survive process restarts.
 */
export function buildDailySessionStats(
  records: readonly DailySpendRecord[],
  now: Date = new Date(),
): SessionStats {
  const today = utcDayKey(now);
  let betsPlaced = 0;
  let totalUsdSpent = 0;

  for (const record of records) {
    if (record.paper || record.outcome !== "filled") continue;

    const placedAt = new Date(record.placedAt);
    if (Number.isNaN(placedAt.getTime()) || utcDayKey(placedAt) !== today) continue;

    betsPlaced++;
    const cost = record.filledCost ?? record.cost;
    if (Number.isFinite(cost) && cost > 0) {
      totalUsdSpent += cost;
    }
  }

  return { betsPlaced, totalUsdSpent, betsSkipped: 0 };
}

