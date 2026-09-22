import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { RiskGuard } from "./risk-guard.js";
import type { BetRecord } from "./types.js";

test("manual dashboard resume can force-clear a circuit-breaker pause", () => {
  const dir = mkdtempSync(join(tmpdir(), "polymoney-risk-"));
  const path = join(dir, "risk.json");
  const previous = process.env.RISK_STATE_PATH;

  try {
    writeFileSync(path, JSON.stringify({
      consecutiveLosses: 2,
      dailyPnlUsd: -8,
      rollingPnlUsd: 0,
      rollingResolvedBets: 0,
      dayKey: new Date().toISOString().slice(0, 10),
      pausedReason: "2 consecutive losses (limit 2)",
      recentResolvedPnls: [-4, -4],
      seenResolutionKeys: [],
      updatedAt: new Date().toISOString(),
    }));
    process.env.RISK_STATE_PATH = path;

    const guard = new RiskGuard();
    assert.equal(guard.clearPause(false), false);
    assert.equal(guard.getStatus().pausedReason, "2 consecutive losses (limit 2)");

    assert.equal(guard.clearPause(true), true);
    assert.deepEqual(guard.getStatus(), {
      consecutiveLosses: 0,
      dailyPnlUsd: -8,
      rollingPnlUsd: 0,
      rollingResolvedBets: 0,
      dayKey: new Date().toISOString().slice(0, 10),
      pausedReason: null,
    });
  } finally {
    if (previous === undefined) delete process.env.RISK_STATE_PATH;
    else process.env.RISK_STATE_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rolling P&L guard pauses only after the configured minimum sample", () => {
  const dir = mkdtempSync(join(tmpdir(), "polymoney-risk-"));
  const previous = process.env.RISK_STATE_PATH;
  process.env.RISK_STATE_PATH = join(dir, "risk.json");

  try {
    const guard = new RiskGuard();
    const config = loadConfig();
    config.safety.max_consecutive_losses = 0;
    config.safety.max_daily_loss_usd = 0;
    config.safety.rolling_pnl_guard = {
      enabled: true,
      window_size: 10,
      min_resolved_bets: 5,
      max_loss_usd: 5,
    };

    for (let i = 1; i <= 4; i += 1) {
      const record = { id: String(i), resolved: true, won: false, pnl: -2 } as BetRecord;
      assert.equal(guard.onResolved(record, config), null);
    }

    const fifth = { id: "5", resolved: true, won: false, pnl: -2 } as BetRecord;
    assert.match(guard.onResolved(fifth, config) ?? "", /Rolling P&L -10\.00 USD over 5 trades/);
    assert.equal(guard.getStatus().rollingPnlUsd, -10);
    assert.equal(guard.getStatus().rollingResolvedBets, 5);
  } finally {
    if (previous === undefined) delete process.env.RISK_STATE_PATH;
    else process.env.RISK_STATE_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

