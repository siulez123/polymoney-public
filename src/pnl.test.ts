import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyShadowResolution,
  buildAttemptSnapshot,
  computeBetPnl,
  writeJsonAtomically,
} from "./pnl.js";
import type { BetRecord } from "./types.js";

test("fee-aware win PnL subtracts the taker fee", () => {
  const result = computeBetPnl("up", "up", 8.5, 10, 0.08925);
  assert.equal(result.won, true);
  assert.ok(Math.abs(result.pnl - 1.41075) < 1e-9);
});

test("fee-aware loss includes stake and taker fee", () => {
  const result = computeBetPnl("up", "down", 8.5, 10, 0.08925);
  assert.equal(result.won, false);
  assert.ok(Math.abs(result.pnl + 8.58925) < 1e-9);
});


test("captures entry-window metadata without raw order details", () => {
  const attempt = buildAttemptSnapshot({
    success: false,
    paper: false,
    marketSlug: "btc-updown-5m-1",
    side: "up",
    tokenId: "token",
    price: 0.82,
    size: 5,
    error: "No usable liquidity ≤ max_price 0.82",
    strategyReason: "T-90: momentum: 12.5 bps",
    timestamp: "2026-08-27T00:00:00Z",
    executionCorrelation: {
      snapshotObservedAt: "2026-08-27T00:00:00Z",
      snapshotAgeMsAtSubmit: 12,
      entrySecondsBeforeClose: 90,
      orderKind: "market",
      orderType: "FAK",
      configuredMaxPrice: 0.82,
      bestAsk: 0.81,
      askLevels: 2,
      shadowReason: "fillable",
      shadowFullyFillable: true,
      intendedPrice: 0.82,
      intendedShares: 5,
      intendedCostUsd: 4.1,
      quantizedAmountUsd: "4.10",
      quantizedPrice: "0.82",
      quantizedShares: "5.0000",
      submissionElapsedMs: 45,
      resultCategory: "clob_rejected",
      reasonCode: "other_clob_rejection",
    },
    shadowStrategies: [{
      name: "cheapest",
      mode: "cheapest",
      observedAt: "2026-08-27T00:00:00Z",
      entrySecondsBeforeClose: 90,
      side: "down",
      reason: "cheapest",
      configuredMaxPrice: 0.82,
      intendedShares: 5,
      bestAsk: 0.5,
      fullyFillable: true,
      fillableShares: 5,
      fillableCostUsd: 2.5,
      averagePrice: 0.5,
      estimatedFeesUsd: 0.0875,
      feeAwareBreakEvenProbability: 0.5175,
      liquidityReason: "fillable",
    }],
  });

  assert.equal(attempt.entrySecondsBeforeClose, 90);
  assert.equal(attempt.outcome, "failed");
  assert.equal(attempt.side, "up");
  assert.equal(attempt.price, 0.82);
  assert.equal(attempt.error, "No usable liquidity ≤ max_price 0.82");
  assert.equal("tokenId" in attempt, false);
  assert.equal(attempt.executionCorrelation?.reasonCode, "other_clob_rejection");
  assert.equal(attempt.shadowStrategies?.[0]?.mode, "cheapest");
  assert.equal("tokenId" in (attempt.shadowStrategies?.[0] ?? {}), false);
});

test("resolves shadow signals without treating maker quotes as fills", () => {
  const record = {
    marketSlug: "btc-updown-5m-shadow",
    attemptHistory: [{
      shadowStrategies: [
        { mode: "cheapest", side: "up", fullyFillable: true, intendedShares: 5,
          fillableCostUsd: 4, estimatedFeesUsd: 0.05 },
        { mode: "passive_maker", side: "down", fullyFillable: false, intendedShares: 5,
          fillableCostUsd: 0, estimatedFeesUsd: 0, executionStyle: "maker" },
      ],
    }],
  } as unknown as BetRecord;

  assert.equal(applyShadowResolution(record, "up"), true);
  const [taker, maker] = record.attemptHistory![0]!.shadowStrategies!;
  assert.equal(taker!.won, true);
  assert.equal(taker!.hypotheticalPnlUsd, 0.95);
  assert.equal(maker!.won, false);
  assert.equal(maker!.hypotheticalPnlUsd, undefined);
  assert.equal(record.shadowResolved, true);
  assert.equal(applyShadowResolution(record, "up"), false);
});


test("replaces P&L JSON atomically and preserves the previous file on serialization failure", () => {
  const root = mkdtempSync(join(tmpdir(), "polymoney-pnl-"));
  const path = join(root, "data", "pnl.json");

  try {
    writeJsonAtomically(path, { bets: [{ id: "first" }] });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      bets: [{ id: "first" }],
    });

    const circular: { self?: unknown } = {};
    circular.self = circular;
    assert.throws(() => writeJsonAtomically(path, circular));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      bets: [{ id: "first" }],
    });
    assert.equal(
      readdirSync(join(root, "data")).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

