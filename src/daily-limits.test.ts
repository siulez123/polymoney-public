import assert from "node:assert/strict";
import test from "node:test";
import { buildDailySessionStats, utcDayKey } from "./daily-limits.js";

test("rebuilds only today's filled live exposure", () => {
  const records = [
    { paper: false, outcome: "filled", placedAt: "2026-08-21T00:00:01Z", filledCost: 4.25, cost: 4.25 },
    { paper: false, outcome: "filled", placedAt: "2026-08-21T23:59:59Z", filledCost: undefined, cost: 3.5 },
    { paper: true, outcome: "paper", placedAt: "2026-08-21T10:00:00Z", filledCost: 20, cost: 20 },
    { paper: false, outcome: "failed", placedAt: "2026-08-21T10:00:00Z", filledCost: undefined, cost: 0 },
    { paper: false, outcome: "filled", placedAt: "2026-08-20T23:59:59Z", filledCost: 8, cost: 8 },
  ] as const;

  assert.deepEqual(
    buildDailySessionStats(records, new Date("2026-08-21T12:00:00Z")),
    { betsPlaced: 2, totalUsdSpent: 7.75, betsSkipped: 0 },
  );
});

test("uses UTC calendar days", () => {
  assert.equal(utcDayKey(new Date("2026-08-21T23:59:59Z")), "2026-08-21");
  assert.equal(utcDayKey(new Date("2026-08-22T00:00:00Z")), "2026-08-22");
});

