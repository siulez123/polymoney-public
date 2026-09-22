import type { AppConfig, OrderBookLevel, OrderBookSnapshot } from "./types.js";
import type { Logger } from "./logger.js";

function parseLevels(
  levels: Array<{ price: string; size: string }> | undefined,
  descending: boolean,
): OrderBookLevel[] {
  if (!levels?.length) return [];
  const parsed = levels
    .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
  parsed.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
  return parsed;
}

export async function fetchOrderBook(
  config: AppConfig,
  tokenId: string,
): Promise<OrderBookSnapshot> {
  const url = `${config.trading.clob_host}/book?token_id=${encodeURIComponent(tokenId)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`CLOB book error ${response.status} for token ${tokenId}`);
  }

  const book = (await response.json()) as {
    bids?: Array<{ price: string; size: string }>;
    asks?: Array<{ price: string; size: string }>;
  };

  const bids = parseLevels(book.bids, true);
  const asks = parseLevels(book.asks, false);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  return { bestBid, bestAsk, spread, asks, bids };
}

/** Taker liquidity (USD and shares) in asks priced ≤ maxPrice. */
export function askDepthWithinPrice(
  book: OrderBookSnapshot,
  maxPrice: number,
): { depthUsd: number; depthShares: number; levels: number } {
  let depthUsd = 0;
  let depthShares = 0;
  let levels = 0;
  for (const level of book.asks) {
    if (level.price > maxPrice + 1e-9) break;
    depthUsd += level.price * level.size;
    depthShares += level.size;
    levels += 1;
  }
  return { depthUsd, depthShares, levels };
}

export async function fetchMidPrice(
  config: AppConfig,
  tokenId: string,
): Promise<number | null> {
  const url = `${config.trading.clob_host}/price?token_id=${encodeURIComponent(tokenId)}&side=buy`;
  const response = await fetch(url);

  if (!response.ok) return null;

  const data = (await response.json()) as { price?: string };
  return data.price ? parseFloat(data.price) : null;
}

export async function getBooksForMarket(
  config: AppConfig,
  upTokenId: string,
  downTokenId: string,
  log: Logger,
): Promise<{ up: OrderBookSnapshot; down: OrderBookSnapshot }> {
  const [up, down] = await Promise.all([
    fetchOrderBook(config, upTokenId),
    fetchOrderBook(config, downTokenId),
  ]);

  log.debug(
    {
      up: { bestBid: up.bestBid, bestAsk: up.bestAsk, spread: up.spread, askLevels: up.asks.length },
      down: { bestBid: down.bestBid, bestAsk: down.bestAsk, spread: down.spread, askLevels: down.asks.length },
    },
    "Order books fetched",
  );
  return { up, down };
}

