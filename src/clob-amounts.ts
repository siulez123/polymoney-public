/** Quantização de montantes para o CLOB Polymarket (precisão maker/taker). */

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/** Floor para N casas com margem contra erro de float. */
export function floorDecimals(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(value * f + 1e-9) / f;
}

/**
 * Market BUY: maker (USDC) ≤2dp e taker (shares = amount/price) ≤4dp exactos.
 * Sem isto o SDK pode emitir taker com >4 casas (ex. tick 0.001 → roundConfig.amount=5)
 * ou um preço resolvido no book que rebenta a validação do CLOB.
 */
export function quantizeMarketBuy(
  price: number,
  size: number,
): { price: number; amountUsd: number; size: number } {
  const p = Math.round(price * 100) / 100;
  const pCents = Math.round(p * 100);
  if (pCents <= 0) {
    return { price: p, amountUsd: 0, size: 0 };
  }

  const maxCents = Math.floor(p * size * 100 + 1e-9);
  // amount=cents/100, shares=cents/pCents — shares com ≤4dp ⇔ (cents*10000)%pCents===0
  const centStep = pCents / gcd(pCents, 10_000);
  let cents = Math.floor(maxCents / centStep) * centStep;
  if (cents < centStep) {
    return { price: p, amountUsd: 0, size: 0 };
  }

  const shares = cents / pCents;
  return {
    price: p,
    amountUsd: cents / 100,
    size: Math.round(shares * 10_000) / 10_000,
  };
}

/**
 * Limit BUY: size ≤4dp e size*price ≤2dp (maker USDC).
 */
export function quantizeLimitBuy(
  price: number,
  size: number,
): { price: number; size: number; amountUsd: number } {
  const p = Math.round(price * 100) / 100;
  const pCents = Math.round(p * 100);
  if (pCents <= 0) {
    return { price: p, size: 0, amountUsd: 0 };
  }

  // size_4dp * pCents deve ser múltiplo de 100 (→ dólares com 2dp)
  const step = 100 / gcd(pCents, 100);
  let units = Math.floor(size * 10_000 + 1e-9);
  units = Math.floor(units / step) * step;
  const qSize = units / 10_000;
  const amountUsd = floorDecimals(qSize * p, 2);
  return { price: p, size: qSize, amountUsd };
}

