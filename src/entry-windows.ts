import type { AppConfig } from "./types.js";

export interface EntryWindow {
  seconds_before_close: number;
  min_delta_bps: number;
  max_price?: number;
}

/**
 * Janelas de entrada ordenadas da mais cedo (maior T) para a mais tarde.
 * Se `entry_windows` estiver vazio, devolve uma única janela com o timing/delta clássicos.
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
 * Devolve a banda shadow ativa para um gatilho WebSocket.
 * As bandas terminam no T shadow seguinte e nunca avançam para dentro da primeira janela live.
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

