import assert from "node:assert/strict";
import test from "node:test";
import { selectShadowStrategyModes } from "./strategy.js";
import { buildPassiveMakerQuote } from "./bet-executor.js";

test("shadow strategies are unique and never duplicate the live strategy", () => {
  assert.deepEqual(
    selectShadowStrategyModes("momentum", ["book_leader", "momentum", "cheapest", "book_leader"]),
    ["book_leader", "cheapest"],
  );
});

test("all experimental strategies can coexist in shadow without the live strategy", () => {
  const modes = [
    "passive_maker",
    "momentum_multi_horizon",
    "mean_reversion",
    "order_book_imbalance",
    "cross_market_confirmation",
    "fee_aware_value",
    "ensemble",
  ] as const;
  assert.deepEqual(selectShadowStrategyModes("momentum", [...modes]), [...modes]);
  assert.equal(modes.includes("momentum" as never), false);
});

test("passive maker quote stays below the ask and respects the configured cap", () => {
  const book = {
    bestBid: 0.78,
    bestAsk: 0.82,
    spread: 0.04,
    bids: [{ price: 0.78, size: 10 }],
    asks: [{ price: 0.82, size: 10 }],
  };
  assert.equal(buildPassiveMakerQuote(book, 0.82, "0.01"), 0.79);
  assert.equal(buildPassiveMakerQuote({ ...book, bestBid: 0.84, bestAsk: 0.85 }, 0.82, "0.01"), 0.82);
});

