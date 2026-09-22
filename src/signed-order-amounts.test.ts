import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOB_MIN_MARKET_BUY_USD,
  descendingCentCandidates,
  validateSignedBuyPrecision,
} from "./signed-order-amounts.js";

test("accepts signed BUY amounts with maker <=2dp and taker <=4dp", () => {
  const result = validateSignedBuyPrecision({
    makerAmount: "4100000",
    takerAmount: "5000000",
  });

  assert.equal(result.valid, true);
  assert.equal(result.makerRemainderBaseUnits, "0");
  assert.equal(result.takerRemainderBaseUnits, "0");
});

test("rejects the intermittent one-base-unit taker drift", () => {
  const result = validateSignedBuyPrecision({
    makerAmount: "4100000",
    takerAmount: "5000001",
  });

  assert.equal(result.valid, false);
  assert.equal(result.takerRemainderBaseUnits, "1");
});

test("rejects maker values finer than cents", () => {
  assert.equal(validateSignedBuyPrecision({
    makerAmount: "4100001",
    takerAmount: "5000000",
  }).valid, false);
});

test("candidate search only lowers max spend and is bounded", () => {
  assert.deepEqual(descendingCentCandidates(4.10, 4), [
    "4.10",
    "4.09",
    "4.08",
    "4.07",
  ]);
  assert.deepEqual(descendingCentCandidates(0.02, 10), ["0.02", "0.01"]);
});

test("market BUY candidate search never drops below the CLOB minimum notional", () => {
  assert.deepEqual(
    descendingCentCandidates(1.03, 10, CLOB_MIN_MARKET_BUY_USD),
    ["1.03", "1.02", "1.01", "1.00"],
  );
  assert.deepEqual(
    descendingCentCandidates(0.99, 10, CLOB_MIN_MARKET_BUY_USD),
    [],
  );
});

