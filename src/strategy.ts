import type { AppConfig, DiscoveredMarket, OrderBookSnapshot, StrategyMode } from "./types.js";
import type { Logger } from "./logger.js";
import type { PriceFeed } from "./price-feed.js";
import { fetchBinanceOpenPrice, fetchBinanceSpotPrice } from "./price-feed.js";

export interface StrategyDecision {
  side: "up" | "down" | null;
  reason: string;
  signal?: {
    openPrice?: number;
    currentPrice?: number;
    deltaBps?: number;
    openSource?: string;
    currentSource?: string;
    upMid?: number;
    downMid?: number;
    shortReturnBps?: number;
    mediumReturnBps?: number;
    longReturnBps?: number;
    score?: number;
    estimatedProbability?: number;
    estimatedEdge?: number;
    votesUp?: number;
    votesDown?: number;
  };
}

function midPrice(book: OrderBookSnapshot): number | null {
  if (book.bestBid !== null && book.bestAsk !== null) {
    return (book.bestBid + book.bestAsk) / 2;
  }
  return book.bestAsk ?? book.bestBid;
}

function resolveNeutral(config: AppConfig): "up" | "down" | null {
  if (config.strategy.on_neutral === "skip") return null;
  return config.strategy.on_neutral;
}

async function resolveOpenPrice(
  config: AppConfig,
  market: DiscoveredMarket,
  feed: PriceFeed,
  log: Logger,
): Promise<{ price: number; source: "chainlink" | "binance" } | null> {
  const windowStartMs = market.windowStartUnix * 1000;
  // Polymarket resolve com Chainlink — janela larga p/ apanhar o tick do open
  const fromFeed = feed.getPriceNear(windowStartMs, 30_000);
  if (fromFeed !== null) {
    return { price: fromFeed, source: config.strategy.price_feed === "binance" ? "binance" : "chainlink" };
  }

  // Só usar Binance para open se o feed principal for Binance
  if (config.strategy.price_feed === "binance" && config.strategy.fallback_open_price) {
    const fromBinance = await fetchBinanceOpenPrice(
      config.strategy.binance_symbol,
      market.windowStartUnix,
    );
    if (fromBinance !== null) {
      log.debug({ fromBinance, windowStart: market.windowStartUnix }, "Open price via Binance kline");
      return { price: fromBinance, source: "binance" };
    }
  }

  return null;
}

async function resolveCurrentPrice(
  config: AppConfig,
  feed: PriceFeed,
  log: Logger,
): Promise<{ price: number; source: "chainlink" | "binance" } | null> {
  const source = feed.getCurrentPriceSource();
  const currentPrice = feed.getCurrentPrice();
  if (currentPrice !== null && source !== null) {
    // Com feed Chainlink, não misturar current Binance no sinal de momentum
    if (config.strategy.price_feed === "chainlink" && source !== "chainlink") {
      log.info({ source, currentPrice }, "Current Binance ignorado — sinal exige Chainlink");
      return null;
    }
    return { price: currentPrice, source };
  }

  if (config.strategy.price_feed !== "binance") return null;
  if (!config.strategy.fallback_current_price) return null;

  const fromBinance = await fetchBinanceSpotPrice(config.strategy.binance_symbol);
  if (fromBinance !== null) {
    log.debug({ fromBinance }, "Current price via Binance spot");
    return { price: fromBinance, source: "binance" };
  }
  return null;
}

export interface StrategyOverrides {
  minDeltaBps?: number;
}

export function selectShadowStrategyModes(
  primary: StrategyMode,
  configured: StrategyMode[],
): StrategyMode[] {
  return [...new Set(configured)].filter((mode) => mode !== primary);
}

async function momentumStrategy(
  config: AppConfig,
  market: DiscoveredMarket,
  feed: PriceFeed,
  log: Logger,
  overrides?: StrategyOverrides,
): Promise<StrategyDecision> {
  const minDeltaBps = overrides?.minDeltaBps ?? config.strategy.min_delta_bps;
  const current = await resolveCurrentPrice(config, feed, log);
  const open = await resolveOpenPrice(config, market, feed, log);

  if (current === null || open === null) {
    return {
      side: resolveNeutral(config),
      reason: "preço indisponível (open ou current Chainlink)",
      signal: {
        openPrice: open?.price,
        currentPrice: current?.price,
        openSource: open?.source,
        currentSource: current?.source,
      },
    };
  }

  if (open.source !== current.source) {
    return {
      side: resolveNeutral(config),
      reason: `fontes inconsistentes open=${open.source} current=${current.source}`,
      signal: {
        openPrice: open.price,
        currentPrice: current.price,
        openSource: open.source,
        currentSource: current.source,
      },
    };
  }

  const deltaBps = ((current.price - open.price) / open.price) * 10_000;
  const signal = {
    openPrice: open.price,
    currentPrice: current.price,
    deltaBps,
    openSource: open.source,
    currentSource: current.source,
  };

  if (Math.abs(deltaBps) < minDeltaBps) {
    log.info({ deltaBps, minDeltaBps, openSource: open.source, currentSource: current.source }, "Sinal neutro — delta abaixo do mínimo");
    return {
      side: resolveNeutral(config),
      reason: `delta ${deltaBps.toFixed(2)} bps < min ${minDeltaBps} bps`,
      signal,
    };
  }

  const side: "up" | "down" = deltaBps > 0 ? "up" : "down";
  return {
    side,
    reason: `momentum(${open.source}): BTC ${deltaBps > 0 ? "acima" : "abaixo"} do open (${deltaBps.toFixed(2)} bps)`,
    signal,
  };
}

function bookLeaderStrategy(
  config: AppConfig,
  books: { up: OrderBookSnapshot; down: OrderBookSnapshot },
): StrategyDecision {
  const upMid = midPrice(books.up);
  const downMid = midPrice(books.down);

  if (upMid === null || downMid === null) {
    return {
      side: resolveNeutral(config),
      reason: "book incompleto",
      signal: { upMid: upMid ?? undefined, downMid: downMid ?? undefined },
    };
  }

  const gap = Math.abs(upMid - downMid);
  if (gap < config.strategy.min_book_mid_gap) {
    return {
      side: resolveNeutral(config),
      reason: `gap mid ${gap.toFixed(3)} < min ${config.strategy.min_book_mid_gap}`,
      signal: { upMid, downMid },
    };
  }

  const side: "up" | "down" = upMid >= downMid ? "up" : "down";
  return {
    side,
    reason: `book_leader: up_mid=${upMid.toFixed(3)} down_mid=${downMid.toFixed(3)}`,
    signal: { upMid, downMid },
  };
}

function cheapestStrategy(
  books: { up: OrderBookSnapshot; down: OrderBookSnapshot },
): StrategyDecision {
  const upAsk = books.up.bestAsk ?? 1;
  const downAsk = books.down.bestAsk ?? 1;
  const side: "up" | "down" = upAsk <= downAsk ? "up" : "down";
  return {
    side,
    reason: `cheapest: up_ask=${upAsk} down_ask=${downAsk}`,
    signal: { upMid: upAsk, downMid: downAsk },
  };
}

function multiHorizonStrategy(
  config: AppConfig,
  feed: PriceFeed,
  overrides?: StrategyOverrides,
): StrategyDecision {
  const threshold = overrides?.minDeltaBps ?? config.strategy.min_delta_bps;
  const values = [feed.getReturnBps(15), feed.getReturnBps(30), feed.getReturnBps(60)];
  const available = values.filter((value): value is number => value !== null);
  const signal = {
    shortReturnBps: values[0] ?? undefined,
    mediumReturnBps: values[1] ?? undefined,
    longReturnBps: values[2] ?? undefined,
  };
  if (available.length < 2) return { side: null, reason: "histórico insuficiente para multi-horizon", signal };
  const up = available.filter((value) => value > 0).length;
  const down = available.filter((value) => value < 0).length;
  const average = available.reduce((sum, value) => sum + value, 0) / available.length;
  if (Math.max(up, down) < 2 || Math.abs(average) < threshold) {
    return { side: null, reason: "horizontes sem confirmação suficiente", signal };
  }
  return {
    side: up > down ? "up" : "down",
    reason: `momentum_multi_horizon: ${up} up / ${down} down, média ${average.toFixed(2)} bps`,
    signal,
  };
}

function meanReversionStrategy(
  config: AppConfig,
  feed: PriceFeed,
  overrides?: StrategyOverrides,
): StrategyDecision {
  const threshold = Math.max(8, overrides?.minDeltaBps ?? config.strategy.min_delta_bps);
  const short = feed.getReturnBps(30);
  const signal = { shortReturnBps: short ?? undefined };
  if (short === null || Math.abs(short) < threshold) {
    return { side: null, reason: `mean_reversion: movimento < ${threshold} bps`, signal };
  }
  return {
    side: short > 0 ? "down" : "up",
    reason: `mean_reversion: contra movimento de ${short.toFixed(2)} bps/30s`,
    signal,
  };
}

function bookImbalance(book: OrderBookSnapshot): number | null {
  const bid = book.bids.slice(0, 3).reduce((sum, level) => sum + level.size, 0);
  const ask = book.asks.slice(0, 3).reduce((sum, level) => sum + level.size, 0);
  const total = bid + ask;
  return total > 0 ? (bid - ask) / total : null;
}

function orderBookImbalanceStrategy(
  config: AppConfig,
  books: { up: OrderBookSnapshot; down: OrderBookSnapshot },
): StrategyDecision {
  const up = bookImbalance(books.up);
  const down = bookImbalance(books.down);
  if (up === null || down === null) return { side: null, reason: "order_book_imbalance: book incompleto" };
  const gap = up - down;
  if (Math.abs(gap) < config.strategy.min_book_mid_gap) {
    return { side: null, reason: "order_book_imbalance: diferença insuficiente", signal: { score: gap } };
  }
  return {
    side: gap > 0 ? "up" : "down",
    reason: `order_book_imbalance: score ${gap.toFixed(3)}`,
    signal: { score: gap },
  };
}

async function crossMarketConfirmationStrategy(
  config: AppConfig,
  market: DiscoveredMarket,
  books: { up: OrderBookSnapshot; down: OrderBookSnapshot },
  feed: PriceFeed,
  log: Logger,
  overrides?: StrategyOverrides,
): Promise<StrategyDecision> {
  const momentum = await momentumStrategy(config, market, feed, log, overrides);
  const predictionMarket = bookLeaderStrategy(config, books);
  if (!momentum.side || momentum.side !== predictionMarket.side) {
    return { side: null, reason: "cross_market_confirmation: Chainlink e CLOB não concordam", signal: momentum.signal };
  }
  return {
    side: momentum.side,
    reason: `cross_market_confirmation: Chainlink e CLOB confirmam ${momentum.side}`,
    signal: { ...momentum.signal, ...predictionMarket.signal },
  };
}

function feeAwareValueStrategy(
  config: AppConfig,
  books: { up: OrderBookSnapshot; down: OrderBookSnapshot },
): StrategyDecision {
  const upMid = midPrice(books.up);
  const downMid = midPrice(books.down);
  if (upMid === null || downMid === null || upMid + downMid <= 0) {
    return { side: null, reason: "fee_aware_value: fair value indisponível" };
  }
  const upProbability = upMid / (upMid + downMid);
  const candidates = (["up", "down"] as const).map((side) => {
    const ask = (side === "up" ? books.up : books.down).bestAsk;
    const probability = side === "up" ? upProbability : 1 - upProbability;
    const feePerShare = ask === null ? 0 : 0.07 * ask * (1 - ask);
    return { side, ask, probability, edge: ask === null ? -Infinity : probability - ask - feePerShare };
  });
  const best = candidates.sort((a, b) => b.edge - a.edge)[0]!;
  const minEdge = Math.max(0.005, config.strategy.min_book_mid_gap);
  if (!Number.isFinite(best.edge) || best.edge < minEdge) {
    return { side: null, reason: `fee_aware_value: edge < ${(minEdge * 100).toFixed(1)}%` };
  }
  return {
    side: best.side,
    reason: `fee_aware_value: edge ${(best.edge * 100).toFixed(2)}% após fee`,
    signal: { estimatedProbability: best.probability, estimatedEdge: best.edge, upMid, downMid },
  };
}

async function ensembleStrategy(
  config: AppConfig,
  market: DiscoveredMarket,
  books: { up: OrderBookSnapshot; down: OrderBookSnapshot },
  feed: PriceFeed,
  log: Logger,
  overrides?: StrategyOverrides,
): Promise<StrategyDecision> {
  const decisions = await Promise.all([
    momentumStrategy(config, market, feed, log, overrides),
    Promise.resolve(multiHorizonStrategy(config, feed, overrides)),
    Promise.resolve(orderBookImbalanceStrategy(config, books)),
    Promise.resolve(feeAwareValueStrategy(config, books)),
  ]);
  const votesUp = decisions.filter((decision) => decision.side === "up").length;
  const votesDown = decisions.filter((decision) => decision.side === "down").length;
  if (Math.max(votesUp, votesDown) < 2 || votesUp === votesDown) {
    return { side: null, reason: "ensemble: sem maioria de 2 votos", signal: { votesUp, votesDown } };
  }
  const side = votesUp > votesDown ? "up" : "down";
  return { side, reason: `ensemble: ${side} por ${Math.max(votesUp, votesDown)} votos`, signal: { votesUp, votesDown } };
}

export async function decideSide(
  config: AppConfig,
  market: DiscoveredMarket,
  books: { up: OrderBookSnapshot; down: OrderBookSnapshot },
  feed: PriceFeed | null,
  log: Logger,
  overrides?: StrategyOverrides,
): Promise<StrategyDecision> {
  const { mode } = config.strategy;

  switch (mode) {
    case "fixed":
      return { side: config.strategy.fixed_side, reason: `fixed: ${config.strategy.fixed_side}` };

    case "cheapest":
      return cheapestStrategy(books);

    case "book_leader":
      return bookLeaderStrategy(config, books);

    case "momentum":
      if (!feed) {
        return { side: resolveNeutral(config), reason: "feed de preço não disponível" };
      }
      return momentumStrategy(config, market, feed, log, overrides);

    case "passive_maker":
      if (!feed) return { side: null, reason: "passive_maker: feed indisponível" };
      return momentumStrategy(config, market, feed, log, overrides);

    case "momentum_multi_horizon":
      if (!feed) return { side: null, reason: "multi-horizon: feed indisponível" };
      return multiHorizonStrategy(config, feed, overrides);

    case "mean_reversion":
      if (!feed) return { side: null, reason: "mean_reversion: feed indisponível" };
      return meanReversionStrategy(config, feed, overrides);

    case "order_book_imbalance":
      return orderBookImbalanceStrategy(config, books);

    case "cross_market_confirmation":
      if (!feed) return { side: null, reason: "cross-market: feed indisponível" };
      return crossMarketConfirmationStrategy(config, market, books, feed, log, overrides);

    case "fee_aware_value":
      return feeAwareValueStrategy(config, books);

    case "ensemble":
      if (!feed) return { side: null, reason: "ensemble: feed indisponível" };
      return ensembleStrategy(config, market, books, feed, log, overrides);

    default:
      return { side: null, reason: `modo desconhecido: ${mode}` };
  }
}

