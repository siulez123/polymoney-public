import type { AppConfig } from "./types.js";
import type { Logger } from "./logger.js";
import type { PriceFeed } from "./price-feed.js";
import { fetchBinanceClosePrice, fetchBinanceOpenPrice } from "./price-feed.js";
import { fetchEventBySlug } from "./market-discovery.js";

export type MarketWinner = "up" | "down";

interface GammaMarketResolved {
  closed: boolean;
  outcomes: string;
  outcomePrices: string;
  umaResolutionStatus?: string;
}

function parseJsonArray<T>(value: string): T[] {
  return JSON.parse(value) as T[];
}

function winnerFromOutcomePrices(outcomes: string[], prices: string[]): MarketWinner | null {
  const upIndex = outcomes.findIndex((o) => o.toLowerCase() === "up");
  const downIndex = outcomes.findIndex((o) => o.toLowerCase() === "down");
  if (upIndex === -1 || downIndex === -1) return null;

  const upPrice = parseFloat(prices[upIndex] ?? "0");
  const downPrice = parseFloat(prices[downIndex] ?? "0");

  if (upPrice >= 0.99) return "up";
  if (downPrice >= 0.99) return "down";
  return null;
}

export async function resolveFromGamma(
  config: AppConfig,
  slug: string,
): Promise<{ winner: MarketWinner; source: "gamma" } | null> {
  const event = await fetchEventBySlug(config, slug);
  const market = event?.markets?.[0] as GammaMarketResolved | undefined;
  if (!market) return null;
  if (!market.closed && market.umaResolutionStatus !== "resolved") return null;

  const outcomes = parseJsonArray<string>(market.outcomes);
  const prices = parseJsonArray<string>(market.outcomePrices);
  const winner = winnerFromOutcomePrices(outcomes, prices);

  if (!winner) return null;
  return { winner, source: "gamma" };
}

export async function resolveFromChainlink(
  config: AppConfig,
  windowStartUnix: number,
  windowEndUnix: number,
  feed: PriceFeed | null,
  log: Logger,
): Promise<{ winner: MarketWinner; source: "chainlink"; openPrice: number; closePrice: number } | null> {
  const openMs = windowStartUnix * 1000;
  const closeMs = windowEndUnix * 1000;

  let openPrice = feed?.getPriceNear(openMs, 5000) ?? null;
  let closePrice = feed?.getPriceNear(closeMs, 5000) ?? null;

  if (openPrice === null && config.strategy.fallback_open_price) {
    openPrice = await fetchBinanceOpenPrice(config.strategy.binance_symbol, windowStartUnix);
  }

  if (closePrice === null) {
    closePrice = feed?.getCurrentPrice() ?? null;
  }

  if (closePrice === null && config.strategy.fallback_current_price) {
    closePrice = await fetchBinanceClosePrice(config.strategy.binance_symbol, windowEndUnix);
  }

  if (openPrice === null || closePrice === null) {
    log.debug({ openPrice, closePrice }, "Chainlink resolution: preços em falta");
    return null;
  }

  const winner: MarketWinner = closePrice >= openPrice ? "up" : "down";
  log.debug({ openPrice, closePrice, winner }, "Chainlink resolution");

  return { winner, source: "chainlink", openPrice, closePrice };
}

/** Espera apenas pela resolução oficial Gamma (nunca Chainlink local). */
export async function waitForResolution(
  config: AppConfig,
  slug: string,
  _windowStartUnix: number,
  _windowEndUnix: number,
  _feed: PriceFeed | null,
  log: Logger,
): Promise<{
  winner: MarketWinner;
  source: "gamma";
}> {
  const { resolution_delay_seconds, resolution_poll_ms, resolution_max_wait_seconds } = config.pnl;

  await sleep(resolution_delay_seconds * 1000);

  const deadline = Date.now() + resolution_max_wait_seconds * 1000;

  while (Date.now() < deadline) {
    const gamma = await resolveFromGamma(config, slug);
    if (gamma) return gamma;

    log.debug({ slug }, "Resolução Gamma pendente, a tentar de novo...");
    await sleep(resolution_poll_ms);
  }

  throw new Error(`Gamma ainda não resolveu ${slug} após ${resolution_max_wait_seconds}s`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

