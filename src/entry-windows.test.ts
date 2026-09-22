import assert from "node:assert/strict";
import test from "node:test";
import {
  activeShadowLiquidityWindow,
  earliestEntrySeconds,
  earliestObservationSeconds,
  resolveShadowLiquidityWindows,
} from "./entry-windows.js";
import type { AppConfig } from "./types.js";

function config(): AppConfig {
  return {
    timing: {
      bet_seconds_before_close: 90,
      entry_windows: [
        { seconds_before_close: 90, min_delta_bps: 12, max_price: 0.82 },
        { seconds_before_close: 60, min_delta_bps: 10, max_price: 0.85 },
        { seconds_before_close: 40, min_delta_bps: 10, max_price: 0.87 },
      ],
      shadow_liquidity_windows: [
        { seconds_before_close: 120, min_delta_bps: 12, max_price: 0.82 },
        { seconds_before_close: 180, min_delta_bps: 12, max_price: 0.82 },
        { seconds_before_close: 150, min_delta_bps: 12, max_price: 0.82 },
      ],
    },
  } as AppConfig;
}

test("shadow liquidity windows are sorted and do not change live entry timing", () => {
  const value = config();
  assert.deepEqual(
    resolveShadowLiquidityWindows(value).map((window) => window.seconds_before_close),
    [180, 150, 120],
  );
  assert.equal(earliestEntrySeconds(value), 90);
  assert.equal(earliestObservationSeconds(value), 180);
});

test("websocket triggers are assigned only to pre-live shadow bands", () => {
  const value = config();
  assert.equal(activeShadowLiquidityWindow(value, 170)?.seconds_before_close, 180);
  assert.equal(activeShadowLiquidityWindow(value, 150)?.seconds_before_close, 150);
  assert.equal(activeShadowLiquidityWindow(value, 121)?.seconds_before_close, 150);
  assert.equal(activeShadowLiquidityWindow(value, 119)?.seconds_before_close, 120);
  assert.equal(activeShadowLiquidityWindow(value, 90), null);
  assert.equal(activeShadowLiquidityWindow(value, 181), null);
});

