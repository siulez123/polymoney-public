import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState } from "./scheduler.js";

test("startup honors a persisted risk pause before any market can enter", () => {
  const state = createInitialState(undefined, "5 perdas consecutivas");
  assert.equal(state.tradingActive, false);
  assert.equal(state.status, "paused");
  assert.equal(state.lastError, "Circuit breaker: 5 perdas consecutivas");
});

test("invalid persisted risk state also starts paused", () => {
  const state = createInitialState(undefined, "estado de risco inválido; revisão manual necessária");
  assert.equal(state.tradingActive, false);
});

test("startup without a risk pause preserves existing initialization", () => {
  const state = createInitialState();
  assert.equal(state.tradingActive, true);
  assert.equal(state.status, "idle");
  assert.equal(state.lastError, null);
});

