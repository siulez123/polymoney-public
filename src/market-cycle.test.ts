import assert from "node:assert/strict";
import test from "node:test";
import { runMarketCycle } from "./market-cycle.js";

test("entry is not blocked by a later shadow observation", async () => {
  const events: string[] = [];
  let finishShadow!: () => void;
  const shadowDone = new Promise<void>((resolve) => { finishShadow = resolve; });
  await runMarketCycle(async () => {
    events.push("shadow T-240");
    await shadowDone;
    events.push("shadow T-120");
  }, async () => {
    events.push("entry T-180");
    finishShadow();
  }, async () => { events.push("reconcile"); });
  assert.deepEqual(events, ["shadow T-240", "entry T-180", "shadow T-120", "reconcile"]);
});

test("paused entry still observes and reconciles without submitting", async () => {
  let submitted = 0;
  let observed = false;
  let resolved = false;
  const tradingActive = false;
  await runMarketCycle(async () => { observed = true; }, async () => {
    if (!tradingActive) return;
    submitted++;
  }, async () => { resolved = true; });
  assert.equal(submitted, 0);
  assert.equal(observed, true);
  assert.equal(resolved, true);
});

test("task failures are propagated only after all work settles and reconciliation runs", async () => {
  const events: string[] = [];
  await assert.rejects(runMarketCycle(async () => {
    throw new Error("shadow failure");
  }, async () => {
    await Promise.resolve();
    events.push("entry settled");
  }, async () => { events.push("reconciled"); }), /shadow failure/);
  assert.deepEqual(events, ["entry settled", "reconciled"]);
});

test("entry failures also allow reconciliation", async () => {
  let reconciled = false;
  await assert.rejects(runMarketCycle(async () => {}, async () => {
    throw new Error("entry failure");
  }, async () => { reconciled = true; }), /entry failure/);
  assert.equal(reconciled, true);
});

test("reconciliation failures are not swallowed", async () => {
  await assert.rejects(runMarketCycle(async () => {}, async () => {}, async () => {
    throw new Error("resolution unavailable");
  }), /resolution unavailable/);
});

