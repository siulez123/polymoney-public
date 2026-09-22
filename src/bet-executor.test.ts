import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildShadowExecutionCurve,
  shouldSubmitBoundedFakProbe,
} from "./bet-executor.js";

describe("bounded FAK empty-book probe", () => {
  const safeInput = {
    useMarketOrder: true,
    orderType: "FAK",
    bestAsk: null,
    allowLimitWithoutAsk: false,
    requireLiquidity: false,
  };

  it("submits only an immediate FAK when the local ask book is empty", () => {
    assert.equal(shouldSubmitBoundedFakProbe(safeInput), true);
  });

  it("does not bypass a visible ask, strict liquidity, or resting-order configuration", () => {
    assert.equal(shouldSubmitBoundedFakProbe({ ...safeInput, bestAsk: 0.84 }), false);
    assert.equal(shouldSubmitBoundedFakProbe({ ...safeInput, requireLiquidity: true }), false);
    assert.equal(shouldSubmitBoundedFakProbe({ ...safeInput, allowLimitWithoutAsk: true }), false);
    assert.equal(shouldSubmitBoundedFakProbe({ ...safeInput, orderType: "GTC" }), false);
    assert.equal(shouldSubmitBoundedFakProbe({ ...safeInput, useMarketOrder: false }), false);
  });
});

describe("shadow execution curve", () => {
  it("measures depth and fees without exceeding the global cap", () => {
    const curve = buildShadowExecutionCurve({
      bestBid: 0.80,
      bestAsk: 0.82,
      spread: 0.02,
      bids: [],
      asks: [
        { price: 0.82, size: 2 },
        { price: 0.83, size: 3 },
        { price: 0.86, size: 10 },
      ],
    }, 0.82, 0.85, 4, "0.01");

    assert.deepEqual(curve.levels.map((level) => level.maxPrice), [0.82, 0.83, 0.84, 0.85]);
    assert.equal(curve.levels[0]?.fillableShares, 2);
    assert.equal(curve.levels[0]?.reason, "insufficient_depth");
    assert.equal(curve.levels[1]?.fillableShares, 4);
    assert.equal(curve.levels[1]?.fullyFillable, true);
    assert.ok((curve.levels[1]?.estimatedFeesUsd ?? 0) > 0);
    assert.ok((curve.levels[1]?.feeAwareBreakEvenProbability ?? 0) > 0.82);
    assert.equal(curve.levels.every((level) => level.maxPrice <= 0.85), true);
  });

  it("rounds caps down to tick size and classifies empty books", () => {
    const curve = buildShadowExecutionCurve({
      bestBid: null,
      bestAsk: null,
      spread: null,
      bids: [],
      asks: [],
    }, 0.823, 0.85, 5, "0.01");

    assert.equal(curve.levels[0]?.maxPrice, 0.82);
    assert.equal(curve.levels[0]?.reason, "empty_book");
    assert.equal(curve.levels[0]?.feeAwareBreakEvenProbability, null);
  });
});

