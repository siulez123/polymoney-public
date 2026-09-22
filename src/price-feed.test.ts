import assert from "node:assert/strict";
import test from "node:test";
import {
  publicPriceFeedStatus,
  shouldForceChainlinkReconnect,
  type PriceFeedStatus,
} from "./price-feed.js";

test("public feed health omits prices and keeps operational counters", () => {
  const status: PriceFeedStatus = {
    running: true,
    connected: true,
    chainlinkConnected: true,
    chainlinkStale: false,
    lastPrice: 12345,
    currentSource: "chainlink",
    source: "chainlink",
    tickCount: 42,
    binanceBackup: false,
    binanceLastPrice: 12340,
    uptimeSeconds: 120,
    chainlinkConnections: 2,
    chainlinkReconnects: 1,
    chainlinkDisconnects: 1,
    chainlinkErrors: 0,
    chainlinkLastConnectedAt: "2026-08-27T00:00:00.000Z",
    chainlinkLastTickAt: "2026-08-27T00:01:00.000Z",
    chainlinkStaleForSeconds: 0,
    chainlinkWatchdogReconnects: 1,
    chainlinkLastWatchdogAt: "2026-08-27T00:00:30.000Z",
    chainlinkWatchdogOutcome: "recovered",
  };

  const sanitized = publicPriceFeedStatus(status);

  assert.equal("lastPrice" in sanitized, false);
  assert.equal("binanceLastPrice" in sanitized, false);
  assert.equal(sanitized.chainlinkReconnects, 1);
  assert.equal(sanitized.chainlinkLastTickAt, "2026-08-27T00:01:00.000Z");
  assert.equal(sanitized.chainlinkWatchdogReconnects, 1);
});

test("watchdog forces only a stale connected Chainlink feed after backoff", () => {
  const base = {
    running: true,
    chainlinkMode: true,
    connected: true,
    lastTickAt: 1_000,
    startedAt: 500,
    now: 12_000,
    staleMs: 10_000,
    lastForcedReconnectAt: 0,
    backoffMs: 20_000,
  };

  assert.equal(shouldForceChainlinkReconnect(base), true);
  assert.equal(shouldForceChainlinkReconnect({ ...base, connected: false }), false);
  assert.equal(shouldForceChainlinkReconnect({ ...base, now: 10_000 }), false);
  assert.equal(shouldForceChainlinkReconnect({
    ...base,
    lastForcedReconnectAt: 5_000,
  }), false);
  assert.equal(shouldForceChainlinkReconnect({
    ...base,
    now: 26_000,
    lastForcedReconnectAt: 5_000,
  }), true);
});

