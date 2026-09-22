import type { AppConfig } from "./types.js";

export interface ConfidenceInput {
  deltaBps?: number;
  /** Preço de entrada (ask / limit) — opcional, para penalizar asks caros */
  price?: number;
}

export interface ConfidenceResult {
  confidence: number;
  deltaFactor: number;
  priceFactor: number;
  absDeltaBps: number | null;
}

/**
 * Confidence ∈ [confidence_at_min, 1] a partir de |delta| e preço.
 * Em min_delta → confidence_at_min; em full_delta_bps → 1.
 */
export function computeStakeConfidence(
  config: AppConfig,
  input: ConfidenceInput,
): ConfidenceResult {
  const cfg = config.staking.confidence;
  if (!cfg.enabled) {
    return {
      confidence: 1,
      deltaFactor: 1,
      priceFactor: 1,
      absDeltaBps: input.deltaBps !== undefined ? Math.abs(input.deltaBps) : null,
    };
  }

  const absDelta =
    input.deltaBps !== undefined && Number.isFinite(input.deltaBps)
      ? Math.abs(input.deltaBps)
      : null;

  let deltaFactor = cfg.default_when_no_delta;
  if (absDelta !== null) {
    const minD = config.strategy.min_delta_bps;
    const fullD = Math.max(minD + 0.01, cfg.full_delta_bps);
    const atMin = clamp(cfg.confidence_at_min, 0.05, 1);
    if (absDelta <= minD) {
      deltaFactor = atMin;
    } else if (absDelta >= fullD) {
      deltaFactor = 1;
    } else {
      const t = (absDelta - minD) / (fullD - minD);
      deltaFactor = atMin + t * (1 - atMin);
    }
  }

  let priceFactor = 1;
  if (
    cfg.price_penalty_enabled
    && input.price !== undefined
    && Number.isFinite(input.price)
  ) {
    const maxP = config.bet.max_price;
    const cheap = Math.min(0.5, maxP - 0.01);
    const atMax = clamp(cfg.price_factor_at_max, 0.2, 1);
    if (input.price <= cheap) {
      priceFactor = 1;
    } else if (input.price >= maxP) {
      priceFactor = atMax;
    } else {
      const t = (input.price - cheap) / (maxP - cheap);
      priceFactor = 1 - t * (1 - atMax);
    }
  }

  const confidence = clamp(deltaFactor * priceFactor, 0.05, 1);
  return { confidence, deltaFactor, priceFactor, absDeltaBps: absDelta };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

