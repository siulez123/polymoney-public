const USDC_BASE_UNITS_PER_CENT = 10_000n;
const SHARE_BASE_UNITS_PER_TEN_THOUSANDTH = 100n;

/** Minimum notional accepted by the CLOB for a marketable BUY. */
export const CLOB_MIN_MARKET_BUY_USD = 1;

export interface SignedOrderAmounts {
  makerAmount: string;
  takerAmount: string;
}

export interface SignedBuyPrecision {
  valid: boolean;
  makerAmountBaseUnits: string;
  takerAmountBaseUnits: string;
  makerRemainderBaseUnits: string;
  takerRemainderBaseUnits: string;
}

/** Validate the final, signed BUY amounts against the CLOB precision contract. */
export function validateSignedBuyPrecision(
  order: SignedOrderAmounts,
): SignedBuyPrecision {
  const maker = BigInt(order.makerAmount);
  const taker = BigInt(order.takerAmount);
  const makerRemainder = maker % USDC_BASE_UNITS_PER_CENT;
  const takerRemainder = taker % SHARE_BASE_UNITS_PER_TEN_THOUSANDTH;

  return {
    valid: maker > 0n && taker > 0n && makerRemainder === 0n && takerRemainder === 0n,
    makerAmountBaseUnits: maker.toString(),
    takerAmountBaseUnits: taker.toString(),
    makerRemainderBaseUnits: makerRemainder.toString(),
    takerRemainderBaseUnits: takerRemainder.toString(),
  };
}

/**
 * Candidate max-spends in descending cent increments. This can only reduce the
 * requested exposure and lets the SDK rebuild/sign amounts until both sides
 * satisfy the exchange precision contract.
 */
export function descendingCentCandidates(
  amountUsd: number,
  maxAttempts = 25,
  minAmountUsd = 0.01,
): string[] {
  const startCents = Math.floor(amountUsd * 100 + 1e-9);
  const minCents = Math.max(1, Math.ceil(minAmountUsd * 100 - 1e-9));
  const attempts = Math.max(1, Math.floor(maxAttempts));
  const candidates: string[] = [];

  for (let offset = 0; offset < attempts; offset += 1) {
    const cents = startCents - offset;
    if (cents < minCents) break;
    candidates.push((cents / 100).toFixed(2));
  }

  return candidates;
}

