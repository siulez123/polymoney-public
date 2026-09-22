import type { AppConfig } from "./types.js";

export interface EntryWindow {
  seconds_before_close: number;
  min_delta_bps: number;
  max_price?: number;
}

/**
 * Entry windows sorted from earliest (highest T) to latest.
 * If `entry_windows` is empty, return a single window with the legacy timing/delta.
 */
export function resolveEntryWindows(config: AppConfig): EntryWindow[] {
  const raw = config.timing.entry_windows ?? [];
  if (raw.length === 0) {
    return [{
      seconds_before_close: config.timing.bet_seconds_before_close,
      min_delta_bps: config.strategy.min_delta_bps,
    }];
  }
  return [...raw]
    .map((w) => ({
      seconds_before_close: w.seconds_before_close,
      min_delta_bps: w.min_delta_bps,
      max_price: w.max_price,
    }))
    .sort((a, b) => b.seconds_before_close - a.seconds_before_close);
}

export function resolveShadowLiquidityWindows(config: AppConfig): EntryWindow[] {
  return [...(config.timing.shadow_liquidity_windows ?? [])]
    .map((window) => ({
      seconds_before_close: window.seconds_before_close,
      min_delta_bps: window.min_delta_bps,
      max_price: window.max_price,
    }))
    .sort((a, b) => b.seconds_before_close - a.seconds_before_close);
}

export function earliestEntrySeconds(config: AppConfig): number {
  const windows = resolveEntryWindows(config);
  return Math.max(...windows.map((w) => w.seconds_before_close));
}

export function earliestObservationSeconds(config: AppConfig): number {
  const shadow = resolveShadowLiquidityWindows(config);
  return shadow.length > 0
    ? Math.max(earliestEntrySeconds(config), ...shadow.map((window) => window.seconds_before_close))
    : earliestEntrySeconds(config);
}

/**
 * Return the active shadow band for a WebSocket trigger.
 * Bands end at the next shadow T and never extend into the first live window.
 */
export function activeShadowLiquidityWindow(
  config: AppConfig,
  secondsBeforeClose: number,
): EntryWindow | null {
  const windows = resolveShadowLiquidityWindows(config);
  for (let index = 0; index < windows.length; index++) {
    const window = windows[index]!;
    const lowerBound = windows[index + 1]?.seconds_before_close ?? earliestEntrySeconds(config);
    if (
      secondsBeforeClose <= window.seconds_before_close
      && secondsBeforeClose > lowerBound
    ) {
      return window;
    }
  }
  return null;
}

