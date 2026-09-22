import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { configSchema } from "./config.js";


test("paper mode keeps strategies observable without recovery risk", () => {
  const raw = parseYaml(readFileSync(resolve("config.yaml"), "utf8"));
  const config = configSchema.parse(raw);


  assert.equal(config.trading.mode, "paper");
  assert.equal(config.staking.mode, "fixed");
  assert.equal(config.bet.size_shares, 5);
  assert.equal(config.strategy.mode, "order_book_imbalance");
  assert.deepEqual(config.timing.entry_windows, [
    { seconds_before_close: 180, min_delta_bps: 12, max_price: 0.82 },
  ]);
  assert.equal(config.staking.recovery_cap.enabled, false);
  assert.equal(config.staking.recovery_cap.max_stake_usd, 20);
  assert.equal(config.staking.max_stake_usd, 20);
  assert.equal(config.safety.max_order_usd, 20);
  assert.equal(config.staking.confidence.enabled, false);
  assert.equal(config.safety.max_bets_per_session, 0);
  assert.equal(config.safety.max_total_usd, 50);
  assert.equal(config.safety.max_consecutive_losses, 2);
  assert.deepEqual(config.safety.rolling_pnl_guard, {
    enabled: true,
    window_size: 10,
    min_resolved_bets: 5,
    max_loss_usd: 5,
  });
  assert.equal(config.safety.allow_limit_without_ask, false);
  assert.equal(config.safety.size_to_depth, true);
});

