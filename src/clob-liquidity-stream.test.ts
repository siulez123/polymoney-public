import assert from "node:assert/strict";
import test from "node:test";
import { applyClobMarketMessage } from "./clob-liquidity-stream.js";
import type { OrderBookSnapshot } from "./types.js";

test("CLOB stream builds and incrementally updates sorted books", () => {
  const cache = new Map<string, OrderBookSnapshot>();

  assert.equal(applyClobMarketMessage(cache, {
    event_type: "book",
    asset_id: "up-token",
    bids: [{ price: "0.40", size: "7" }, { price: "0.42", size: "3" }],
    asks: [{ price: "0.48", size: "4" }, { price: "0.45", size: "6" }],
  }), true);

  assert.deepEqual(cache.get("up-token"), {
    bids: [{ price: 0.42, size: 3 }, { price: 0.4, size: 7 }],
    asks: [{ price: 0.45, size: 6 }, { price: 0.48, size: 4 }],
    bestBid: 0.42,
    bestAsk: 0.45,
    spread: 0.03,
  });

  applyClobMarketMessage(cache, {
    event_type: "price_change",
    price_changes: [
      { asset_id: "up-token", side: "SELL", price: "0.45", size: "0" },
      { asset_id: "up-token", side: "SELL", price: "0.44", size: "8" },
      { asset_id: "up-token", side: "BUY", price: "0.43", size: "2" },
    ],
  });

  assert.deepEqual(cache.get("up-token"), {
    bids: [{ price: 0.43, size: 2 }, { price: 0.42, size: 3 }, { price: 0.4, size: 7 }],
    asks: [{ price: 0.44, size: 8 }, { price: 0.48, size: 4 }],
    bestBid: 0.43,
    bestAsk: 0.44,
    spread: 0.01,
  });
});

test("CLOB stream ignores malformed and unrelated events", () => {
  const cache = new Map<string, OrderBookSnapshot>();
  assert.equal(applyClobMarketMessage(cache, { event_type: "last_trade_price" }), false);
  assert.equal(applyClobMarketMessage(cache, "PONG"), false);
  assert.equal(cache.size, 0);
});

