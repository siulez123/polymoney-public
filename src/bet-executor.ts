import type {
  AppConfig,
  BetResult,
  DiscoveredMarket,
  OrderBookSnapshot,
  ShadowExecutionCurve,
  ShadowLiquidityLevel,
  ShadowStrategyEvaluation,
} from "./types.js";
import type { Logger } from "./logger.js";
import { askDepthWithinPrice, fetchMidPrice, getBooksForMarket } from "./clob.js";
import type { EnvSecrets } from "./types.js";
import type { PriceFeed } from "./price-feed.js";
import { decideSide, selectShadowStrategyModes } from "./strategy.js";
import type { StakingManager } from "./staking.js";
import type { AccountBalanceTracker } from "./account-balance.js";
import { initSecureClient, placeSecureBuyOrder } from "./secure-trading.js";
import {
  formatUnfilledMessage,
  type ClobOrderResponse,
} from "./clob-errors.js";

export interface SessionStats {
  betsPlaced: number;
  totalUsdSpent: number;
  betsSkipped: number;
}

export interface BetAttemptOptions {
  /** Override strategy.min_delta_bps for this attempt (entry window) */
  minDeltaBps?: number;
  /** Override bet.max_price for this attempt */
  maxPrice?: number;
  /** Seconds before this window closes (for logs/reason) */
  entrySecondsBeforeClose?: number;
}

const TAKER_FEE_RATE = 0.07;
const SHADOW_OFFSETS_CENTS = [0, 1, 2, 3] as const;

function roundDownToTick(value: number, tickSize: number): number {
  const safeTick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01;
  const units = Math.floor((value + 1e-9) / safeTick);
  return Number((units * safeTick).toFixed(6));
}

export function buildPassiveMakerQuote(
  book: OrderBookSnapshot,
  configuredMaxPrice: number,
  rawTickSize: string | number,
): number | null {
  const tick = Number(rawTickSize);
  const safeTick = Number.isFinite(tick) && tick > 0 ? tick : 0.01;
  const candidate = book.bestBid !== null
    ? book.bestBid + safeTick
    : book.bestAsk !== null
      ? book.bestAsk - safeTick
      : null;
  if (candidate === null) return null;
  const postOnlyCap = book.bestAsk !== null ? book.bestAsk - safeTick : configuredMaxPrice;
  const quote = roundDownToTick(Math.min(configuredMaxPrice, postOnlyCap, candidate), safeTick);
  return quote >= safeTick ? quote : null;
}

function shadowLevel(
  book: OrderBookSnapshot,
  cap: number,
  offsetCents: number,
  desiredShares: number,
): ShadowLiquidityLevel {
  const eligible = book.asks.filter((level) => level.price <= cap + 1e-9);
  const availableDepthShares = eligible.reduce((sum, level) => sum + level.size, 0);
  const availableDepthUsd = eligible.reduce((sum, level) => sum + level.price * level.size, 0);
  let remaining = Math.max(0, desiredShares);
  let fillableShares = 0;
  let fillableCostUsd = 0;
  let estimatedFeesUsd = 0;

  for (const level of eligible) {
    if (remaining <= 1e-9) break;
    const shares = Math.min(remaining, level.size);
    fillableShares += shares;
    fillableCostUsd += shares * level.price;
    estimatedFeesUsd += shares * TAKER_FEE_RATE * level.price * (1 - level.price);
    remaining -= shares;
  }

  const fullyFillable = desiredShares > 0 && fillableShares + 1e-9 >= desiredShares;
  const averagePrice = fillableShares > 0 ? fillableCostUsd / fillableShares : null;
  const feeAwareBreakEvenProbability = fillableShares > 0
    ? (fillableCostUsd + estimatedFeesUsd) / fillableShares
    : null;
  const reason = fullyFillable
    ? "fillable"
    : book.bestAsk === null
      ? "empty_book"
      : book.bestAsk > cap + 1e-9
        ? "quote_above_cap"
        : "insufficient_depth";

  return {
    offsetCents,
    maxPrice: cap,
    bestAsk: book.bestAsk,
    availableDepthShares: Number(availableDepthShares.toFixed(6)),
    availableDepthUsd: Number(availableDepthUsd.toFixed(6)),
    fillableShares: Number(fillableShares.toFixed(6)),
    fillableCostUsd: Number(fillableCostUsd.toFixed(6)),
    averagePrice: averagePrice === null ? null : Number(averagePrice.toFixed(6)),
    estimatedFeesUsd: Number(estimatedFeesUsd.toFixed(6)),
    feeAwareBreakEvenProbability: feeAwareBreakEvenProbability === null
      ? null
      : Number(feeAwareBreakEvenProbability.toFixed(6)),
    fullyFillable,
    reason,
  };
}

export function buildShadowExecutionCurve(
  book: OrderBookSnapshot,
  configuredMaxPrice: number,
  globalMaxPrice: number,
  desiredShares: number,
  rawTickSize: string | number,
): ShadowExecutionCurve {
  const tickSize = Number(rawTickSize);
  const hardCap = Math.min(0.99, globalMaxPrice);
  const seen = new Set<number>();
  const levels = SHADOW_OFFSETS_CENTS.flatMap((offsetCents) => {
    const requestedCap = Math.min(hardCap, configuredMaxPrice + offsetCents / 100);
    const cap = roundDownToTick(requestedCap, tickSize);
    if (seen.has(cap)) return [];
    seen.add(cap);
    return [shadowLevel(book, cap, offsetCents, desiredShares)];
  });

  return {
    configuredMaxPrice,
    globalMaxPrice: hardCap,
    desiredShares,
    levels,
  };
}

function applyAttemptOverrides(config: AppConfig, opts?: BetAttemptOptions): AppConfig {
  if (!opts) return config;
  const next = { ...config };
  if (opts.minDeltaBps !== undefined) {
    next.strategy = { ...config.strategy, min_delta_bps: opts.minDeltaBps };
  }
  if (opts.maxPrice !== undefined) {
    next.bet = { ...config.bet, max_price: opts.maxPrice };
  }
  return next;
}

export async function evaluateShadowStrategies(
  config: AppConfig,
  market: DiscoveredMarket,
  books: { up: OrderBookSnapshot; down: OrderBookSnapshot },
  feed: PriceFeed | null,
  log: Logger,
  attempt: BetAttemptOptions | undefined,
  globalMaxPrice: number,
  includePrimary = false,
): Promise<ShadowStrategyEvaluation[]> {
  const intendedShares = Math.max(
    config.bet.size_shares,
    market.minOrderSize,
    config.safety.min_order_size,
  );
  const shadowModes = selectShadowStrategyModes(config.strategy.mode, config.strategy.shadow_modes);
  const modes = includePrimary
    ? [config.strategy.mode, ...shadowModes]
    : shadowModes;
  return Promise.all(modes.map(async (mode) => {
    const shadowConfig: AppConfig = {
      ...config,
      strategy: { ...config.strategy, mode },
    };
    const decision = await decideSide(shadowConfig, market, books, feed, log, {
      minDeltaBps: attempt?.minDeltaBps,
    });
    const base = {
      name: mode,
      mode,
      observedAt: new Date().toISOString(),
      entrySecondsBeforeClose: attempt?.entrySecondsBeforeClose ?? null,
      side: decision.side,
      reason: decision.reason,
      configuredMaxPrice: config.bet.max_price,
      intendedShares,
      signal: decision.signal,
    };
    if (decision.side === null) {
      return {
        ...base,
        bestAsk: null,
        fullyFillable: false,
        fillableShares: 0,
        fillableCostUsd: 0,
        averagePrice: null,
        estimatedFeesUsd: 0,
        feeAwareBreakEvenProbability: null,
        liquidityReason: "no_signal" as const,
        executionStyle: mode === "passive_maker" ? "maker" as const : "taker" as const,
        quotePrice: null,
      };
    }
    const book = decision.side === "up" ? books.up : books.down;
    if (mode === "passive_maker") {
      const quotePrice = buildPassiveMakerQuote(book, config.bet.max_price, market.tickSize);
      return {
        ...base,
        bestAsk: book.bestAsk,
        fullyFillable: false,
        fillableShares: 0,
        fillableCostUsd: 0,
        averagePrice: null,
        estimatedFeesUsd: 0,
        feeAwareBreakEvenProbability: quotePrice,
        liquidityReason: quotePrice === null ? "empty_book" as const : "maker_quote" as const,
        executionStyle: "maker" as const,
        quotePrice,
      };
    }
    const curve = buildShadowExecutionCurve(
      book,
      config.bet.max_price,
      globalMaxPrice,
      intendedShares,
      market.tickSize,
    );
    const level = curve.levels.find((item) => item.offsetCents === 0) ?? curve.levels[0]!;
    return {
      ...base,
      bestAsk: level.bestAsk,
      fullyFillable: level.fullyFillable,
      fillableShares: level.fillableShares,
      fillableCostUsd: level.fillableCostUsd,
      averagePrice: level.averagePrice,
      estimatedFeesUsd: level.estimatedFeesUsd,
      feeAwareBreakEvenProbability: level.feeAwareBreakEvenProbability,
      liquidityReason: level.reason,
      executionStyle: "taker" as const,
      quotePrice: null,
    };
  }));
}

export async function evaluateShadowObservation(
  config: AppConfig,
  market: DiscoveredMarket,
  feed: PriceFeed | null,
  log: Logger,
  attempt: BetAttemptOptions,
  source: "fixed_window" | "websocket_trigger",
  books?: { up: OrderBookSnapshot; down: OrderBookSnapshot },
  observedAt = new Date().toISOString(),
): Promise<BetResult> {
  const globalMaxPrice = config.bet.max_price;
  const scopedConfig = applyAttemptOverrides(config, attempt);
  const currentBooks = books ?? await getBooksForMarket(
    scopedConfig,
    market.upTokenId,
    market.downTokenId,
    log,
  );
  const decision = await decideSide(scopedConfig, market, currentBooks, feed, log, {
    minDeltaBps: attempt.minDeltaBps,
  });
  const shadowStrategies = await evaluateShadowStrategies(
    scopedConfig,
    market,
    currentBooks,
    feed,
    log,
    attempt,
    globalMaxPrice,
    true,
  );
  const intendedShares = Math.max(
    scopedConfig.bet.size_shares,
    market.minOrderSize,
    scopedConfig.safety.min_order_size,
  );
  const selectedBook = decision.side === "up"
    ? currentBooks.up
    : decision.side === "down"
      ? currentBooks.down
      : null;
  const shadowLiquidity = selectedBook
    ? buildShadowExecutionCurve(
      selectedBook,
      scopedConfig.bet.max_price,
      globalMaxPrice,
      intendedShares,
      market.tickSize,
    )
    : undefined;
  const entryTag = `T-${attempt.entrySecondsBeforeClose ?? 0}`;
  const strategyReason = `${entryTag}: shadow_${source}: ${decision.reason}`;

  log.info(
    {
      slug: market.slug,
      source,
      entry: entryTag,
      primaryMode: scopedConfig.strategy.mode,
      primarySide: decision.side,
      maxPrice: scopedConfig.bet.max_price,
      minDeltaBps: scopedConfig.strategy.min_delta_bps,
      primaryFillable: shadowStrategies.find(
        (evaluation) => evaluation.mode === scopedConfig.strategy.mode,
      )?.fullyFillable ?? false,
      shadowStrategies,
    },
    "Liquidity observation recorded (shadow-only)",
  );

  return {
    success: true,
    paper: true,
    marketSlug: market.slug,
    side: null,
    tokenId: null,
    price: 0,
    size: 0,
    skipped: true,
    status: "shadow_observation",
    strategyReason,
    signal: decision.signal,
    shadowLiquidity,
    shadowStrategies,
    timestamp: observedAt,
  };
}

interface ResolvedPrice {
  price: number;
  useMarketOrder: boolean;
  source: string;
}

export interface BoundedFakProbeInput {
  useMarketOrder: boolean;
  orderType: string;
  bestAsk: number | null;
  allowLimitWithoutAsk: boolean;
  requireLiquidity: boolean;
}

/**
 * A FAK probe is safe only when it remains an immediate, price-capped order.
 * It must never turn into a resting order or bypass an explicit liquidity rule.
 */
export function shouldSubmitBoundedFakProbe(input: BoundedFakProbeInput): boolean {
  return (
    input.useMarketOrder
    && input.orderType === "FAK"
    && input.bestAsk === null
    && !input.allowLimitWithoutAsk
    && !input.requireLiquidity
  );
}

async function resolveBuyPrice(
  config: AppConfig,
  tokenId: string,
  book: OrderBookSnapshot,
): Promise<ResolvedPrice> {
  const { bet, safety } = config;
  const askUsable =
    book.bestAsk !== null && book.bestAsk <= bet.max_price + 1e-9;

  // Market order only when ask ≤ max_price; otherwise resting limit (if allowed)
  if (bet.use_market_order) {
    if (askUsable && book.bestAsk !== null) {
      return {
        price: Math.min(bet.max_price, 0.99, book.bestAsk + bet.market_slippage),
        useMarketOrder: true,
        source: "book_ask",
      };
    }
    if (safety.allow_limit_without_ask) {
      return {
        price: bet.max_price,
        useMarketOrder: false,
        source:
          book.bestAsk === null
            ? "max_price_limit"
            : "max_price_limit_ask_too_high",
      };
    }
    return {
      price: bet.max_price,
      useMarketOrder: true,
      source: "max_price_market",
    };
  }

  if (askUsable && book.bestAsk !== null) {
    const price = Math.min(bet.max_price, book.bestAsk + bet.market_slippage);
    return { price, useMarketOrder: false, source: "book_ask_limit" };
  }

  const apiPrice = await fetchMidPrice(config, tokenId);
  if (apiPrice !== null) {
    const price = Math.min(bet.max_price, apiPrice + bet.market_slippage);
    return { price, useMarketOrder: false, source: "clob_price_api" };
  }

  if (safety.allow_limit_without_ask && book.bestBid !== null) {
    const price = Math.min(bet.max_price, book.bestBid + 0.01);
    return { price, useMarketOrder: false, source: "bid_cross" };
  }

  if (safety.allow_limit_without_ask) {
    return { price: bet.max_price, useMarketOrder: false, source: "max_price_limit" };
  }

  return { price: bet.max_price, useMarketOrder: false, source: "none" };
}

function validateSafety(
  config: AppConfig,
  stats: SessionStats,
  side: "up" | "down",
  price: number,
  size: number,
  book: OrderBookSnapshot,
  priceSource: string,
): string | null {
  const { safety, bet } = config;

  if (size < safety.min_order_size) {
    return `Size ${size} below the minimum ${safety.min_order_size}`;
  }

  const notional = price * size;

  if (safety.max_order_usd > 0 && config.staking.mode !== "all_in" && notional > safety.max_order_usd) {
    return `Order $${notional.toFixed(2)} exceeds max_order_usd $${safety.max_order_usd}`;
  }

  if (safety.max_total_usd > 0 && stats.totalUsdSpent + notional > safety.max_total_usd) {
    return `UTC daily total would exceed max_total_usd ${safety.max_total_usd}`;
  }

  if (safety.max_bets_per_session > 0 && stats.betsPlaced >= safety.max_bets_per_session) {
    return `Session bet limit reached (${safety.max_bets_per_session})`;
  }

  if (safety.max_spread > 0 && book.spread !== null && book.spread > safety.max_spread) {
    const takerFromBook = priceSource === "book_ask" || priceSource === "book_ask_limit";
    if (!takerFromBook) {
      return `Spread ${book.spread.toFixed(3)} exceeds max_spread ${safety.max_spread}`;
    }
  }

  if (safety.require_liquidity && book.bestAsk === null && priceSource === "none") {
    return `No liquidity on side ${side}`;
  }

  if (price > bet.max_price) {
    return `Price ${price} above max_price ${bet.max_price}`;
  }

  return null;
}

/** Adjust shares to ask depth ≤ max_price. Return a retryable error if depth is insufficient. */
function applySizeToDepth(
  config: AppConfig,
  book: OrderBookSnapshot,
  price: number,
  desiredShares: number,
  marketMinOrderSize: number,
): { size: number; depthUsd: number; depthShares: number; capped: boolean; error?: string } {
  const { safety, bet } = config;
  const depth = askDepthWithinPrice(book, bet.max_price);
  const buffer = safety.size_to_depth_buffer;
  const usableUsd = depth.depthUsd * buffer;
  const usableShares = depth.depthShares * buffer;
  const minSize = Math.max(safety.min_order_size, marketMinOrderSize);
  const minUsd = minSize * Math.min(price, bet.max_price);

  if (depth.levels === 0 || usableUsd < minUsd || usableShares < minSize) {
    const askLevels = book.asks.length;
    const detail =
      book.bestAsk === null
        ? `book has no asks (empty CLOB sides)`
        : book.bestAsk > bet.max_price + 1e-9
          ? `best ask ${book.bestAsk.toFixed(3)} > max_price ${bet.max_price} `
            + `(${askLevels} book levels, 0 ≤ max_price)`
          : `depth=$${depth.depthUsd.toFixed(2)} / ${depth.depthShares.toFixed(2)} sh `
            + `across ${depth.levels} levels ≤ max_price (minimum order does not fit)`;
    return {
      size: desiredShares,
      depthUsd: depth.depthUsd,
      depthShares: depth.depthShares,
      capped: false,
      error: `No usable liquidity ≤ max_price ${bet.max_price}: ${detail}`,
    };
  }

  const desiredUsd = price * desiredShares;
  if (desiredUsd <= usableUsd && desiredShares <= usableShares) {
    return {
      size: desiredShares,
      depthUsd: depth.depthUsd,
      depthShares: depth.depthShares,
      capped: false,
    };
  }

  const sizeByUsd = Math.floor((usableUsd / price) * 100) / 100;
  const sizeByShares = Math.floor(usableShares * 100) / 100;
  const size = Math.max(minSize, Math.min(desiredShares, sizeByUsd, sizeByShares));

  if (size < minSize || size * price < minUsd * 0.99) {
    return {
      size: desiredShares,
      depthUsd: depth.depthUsd,
      depthShares: depth.depthShares,
      capped: false,
      error:
        `Insufficient depth after buffer ${buffer}: `
        + `$${usableUsd.toFixed(2)} / ${usableShares.toFixed(2)} sh`,
    };
  }

  return {
    size,
    depthUsd: depth.depthUsd,
    depthShares: depth.depthShares,
    capped: size + 1e-9 < desiredShares,
  };
}

function isLiquidityRetryable(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("liquidez")
    || lower.includes("liquidity")
    || lower.includes("no resting")
    || lower.includes("no orders found to match")
    || lower.includes("insufficient depth")
    || lower.includes("no liquidity")
  );
}

export function isBetRetryable(result: BetResult): boolean {
  if (result.success || result.skipped) return false;
  if (result.submitted && !isLiquidityRetryable(result.error)) return false;
  return isLiquidityRetryable(result.error);
}

export async function executeBet(
  config: AppConfig,
  secrets: EnvSecrets,
  market: DiscoveredMarket,
  stats: SessionStats,
  feed: PriceFeed | null,
  log: Logger,
  staking: StakingManager | null,
  accountBalance: AccountBalanceTracker | null = null,
  attempt?: BetAttemptOptions,
): Promise<BetResult> {
  const globalMaxPrice = config.bet.max_price;
  config = applyAttemptOverrides(config, attempt);
  const entryTag =
    attempt?.entrySecondsBeforeClose !== undefined
      ? `T-${attempt.entrySecondsBeforeClose}`
      : null;

  const books = await getBooksForMarket(config, market.upTokenId, market.downTokenId, log);
  const snapshotObservedAtMs = Date.now();
  const decision = await decideSide(config, market, books, feed, log, {
    minDeltaBps: attempt?.minDeltaBps,
  });
  const shadowStrategies = await evaluateShadowStrategies(
    config, market, books, feed, log, attempt, globalMaxPrice,
  );
  if (entryTag && decision.reason) {
    decision.reason = `${entryTag}: ${decision.reason}`;
  }

  log.info(
    {
      mode: config.strategy.mode,
      side: decision.side,
      reason: decision.reason,
      signal: decision.signal,
      shadowStrategies,
      entry: entryTag,
      minDeltaBps: config.strategy.min_delta_bps,
      maxPrice: config.bet.max_price,
    },
    "Strategy decision",
  );

  if (decision.side === null) {
    stats.betsSkipped++;
    return {
      success: true,
      paper: config.trading.mode === "paper",
      marketSlug: market.slug,
      side: null,
      tokenId: null,
      price: 0,
      size: 0,
      skipped: true,
      strategyReason: decision.reason,
      signal: decision.signal,
      status: "skipped",
      timestamp: new Date().toISOString(),
    };
  }

  const side = decision.side;
  const book = side === "up" ? books.up : books.down;
  const tokenId = side === "up" ? market.upTokenId : market.downTokenId;
  let { price, useMarketOrder, source: priceSource } = await resolveBuyPrice(config, tokenId, book);

  let size: number;
  let stakeMeta: {
    stakeUsd: number;
    rawStakeUsd: number;
    confidence: number;
    deltaFactor: number;
    priceFactor: number;
    absDeltaBps: number | null;
  } | null = null;

  if (staking && config.staking.mode === "all_in" && accountBalance) {
    await accountBalance.refreshNow(config, secrets, log);
  }

  if (staking) {
    const sized = staking.computeBetShares(price, market, {
      deltaBps: decision.signal?.deltaBps,
      price,
    });
    size = sized.shares;
    stakeMeta = {
      stakeUsd: sized.stakeUsd,
      rawStakeUsd: sized.rawStakeUsd,
      confidence: sized.confidence.confidence,
      deltaFactor: sized.confidence.deltaFactor,
      priceFactor: sized.confidence.priceFactor,
      absDeltaBps: sized.confidence.absDeltaBps,
    };
  } else {
    size = Math.max(config.bet.size_shares, market.minOrderSize, config.safety.min_order_size);
  }

  const shadowLiquidity = buildShadowExecutionCurve(
    book,
    config.bet.max_price,
    globalMaxPrice,
    size,
    market.tickSize,
  );
  log.info(
    {
      entry: entryTag,
      side,
      levels: shadowLiquidity.levels.map((level) => ({
        offsetCents: level.offsetCents,
        cap: level.maxPrice,
        fillableShares: level.fillableShares,
        fullyFillable: level.fullyFillable,
        breakEven: level.feeAwareBreakEvenProbability,
        reason: level.reason,
      })),
    },
    "Shadow execution curve calculated (without submitting an order)",
  );

  let depthMeta: { depthUsd: number; depthShares: number; capped: boolean } | null = null;
  if (config.safety.size_to_depth) {
    const sized = applySizeToDepth(config, book, price, size, market.minOrderSize);
    depthMeta = {
      depthUsd: sized.depthUsd,
      depthShares: sized.depthShares,
      capped: sized.capped,
    };
    if (sized.error) {
      const boundedFakProbe = shouldSubmitBoundedFakProbe({
        useMarketOrder,
        orderType: config.bet.order_type,
        bestAsk: book.bestAsk,
        allowLimitWithoutAsk: config.safety.allow_limit_without_ask,
        requireLiquidity: config.safety.require_liquidity,
      });
      // size_to_depth is for market/taker; allow_limit_without_ask places a resting limit
      if (config.safety.allow_limit_without_ask) {
        useMarketOrder = false;
        price = config.bet.max_price;
        priceSource =
          book.bestAsk === null
            ? "max_price_limit_no_depth"
            : "max_price_limit_ask_too_high";
        if (staking) {
          const resized = staking.computeBetShares(price, market, {
            deltaBps: decision.signal?.deltaBps,
            price,
          });
          size = resized.shares;
          stakeMeta = {
            stakeUsd: resized.stakeUsd,
            rawStakeUsd: resized.rawStakeUsd,
            confidence: resized.confidence.confidence,
            deltaFactor: resized.confidence.deltaFactor,
            priceFactor: resized.confidence.priceFactor,
            absDeltaBps: resized.confidence.absDeltaBps,
          };
        }
        log.info(
          {
            side,
            bestAsk: book.bestAsk,
            desiredSize: size,
            price,
            depthError: sized.error,
          },
          "No depth ≤ max_price — placing resting limit",
        );
      } else if (boundedFakProbe) {
        price = config.bet.max_price;
        priceSource = "bounded_fak_empty_book";
        log.info(
          {
            side,
            desiredSize: size,
            maxPrice: price,
            maxOrderUsd: config.safety.max_order_usd,
            maxTotalUsd: config.safety.max_total_usd,
          },
          "Local book has no asks — sending a capped FAK probe",
        );
      } else {
        log.warn(
          { side, price, desiredSize: size, ...depthMeta, bestAsk: book.bestAsk },
          "Bet blocked by size-to-depth",
        );
        return {
          success: false,
          paper: config.trading.mode === "paper",
          marketSlug: market.slug,
          side,
          tokenId,
          price,
          size,
          error: sized.error,
          strategyReason: decision.reason,
          signal: decision.signal,
          shadowLiquidity,
          shadowStrategies,
          timestamp: new Date().toISOString(),
        };
      }
    } else {
      size = sized.size;
    }
  }

  const safetyError = validateSafety(config, stats, side, price, size, book, priceSource);
  if (safetyError) {
    log.warn({ safetyError, side, price, size, priceSource, book }, "Bet aborted by safety checks");
    return {
      success: false,
      paper: config.trading.mode === "paper",
      marketSlug: market.slug,
      side,
      tokenId,
      price,
      size,
      error: safetyError,
      strategyReason: decision.reason,
      signal: decision.signal,
      shadowLiquidity,
      shadowStrategies,
      timestamp: new Date().toISOString(),
    };
  }

  log.info(
    {
      slug: market.slug,
      side,
      price,
      size,
      stakeUsd: (price * size).toFixed(2),
      stakingMode: config.staking.mode,
      seriesBankroll: staking?.getStatus().seriesBankroll,
      pendingRecoveryUsd: staking?.getStatus().pendingRecoveryUsd,
      confidence: stakeMeta,
      priceSource,
      useMarketOrder,
      notional: (price * size).toFixed(2),
      mode: config.trading.mode,
      orderType: config.bet.order_type,
      strategyReason: decision.reason,
      sizeToDepth: depthMeta,
      book: {
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        spread: book.spread,
        askLevels: book.asks.length,
      },
    },
    "Executing bet",
  );

  if (config.trading.mode === "paper") {
    const filledCost = price * size;
    const platformFee = useMarketOrder ? size * 0.07 * price * (1 - price) : 0;
    return {
      success: true,
      paper: true,
      marketSlug: market.slug,
      side,
      tokenId,
      price,
      size,
      filledSize: size,
      filledCost,
      platformFee,
      totalCost: filledCost + platformFee,
      status: "paper_simulated",
      strategyReason: decision.reason,
      signal: decision.signal,
      shadowLiquidity,
      shadowStrategies,
      timestamp: new Date().toISOString(),
    };
  }

  const client = await initSecureClient(secrets, log);
  const result = await placeSecureBuyOrder(
    client,
    config,
    tokenId,
    price,
    size,
    useMarketOrder,
    log,
  );
  const configuredShadow = shadowLiquidity.levels.find((level) => level.offsetCents === 0) ?? null;
  const executionCorrelation = {
    snapshotObservedAt: new Date(snapshotObservedAtMs).toISOString(),
    snapshotAgeMsAtSubmit: Math.max(0, result.telemetry.submissionElapsedMs > 0
      ? Date.now() - snapshotObservedAtMs - result.telemetry.submissionElapsedMs
      : Date.now() - snapshotObservedAtMs),
    entrySecondsBeforeClose: attempt?.entrySecondsBeforeClose ?? null,
    orderType: config.bet.order_type,
    configuredMaxPrice: config.bet.max_price,
    bestAsk: book.bestAsk,
    askLevels: book.asks.length,
    shadowReason: configuredShadow?.reason ?? null,
    shadowFullyFillable: configuredShadow?.fullyFillable ?? null,
    intendedPrice: price,
    intendedShares: size,
    intendedCostUsd: Number((price * size).toFixed(6)),
    ...result.telemetry,
  };

  if (result.error) {
    log.error({ error: result.error, clobDetail: result.detail }, "Failed to place order");
    return {
      success: false,
      paper: false,
      marketSlug: market.slug,
      side,
      tokenId,
      price,
      size,
      error: result.error,
      clobDetail: result.detail,
      strategyReason: decision.reason,
      signal: decision.signal,
      shadowLiquidity,
      shadowStrategies,
      executionCorrelation,
      timestamp: new Date().toISOString(),
    };
  }

  const filledSize = result.filledSize ?? 0;
  const filledCost = result.filledCost ?? 0;

  if (filledSize <= 0) {
    let parsedResponse: ClobOrderResponse = {};
    try {
      parsedResponse = JSON.parse(result.detail ?? "{}") as ClobOrderResponse;
    } catch {
      parsedResponse = {};
    }
    const unfilled = formatUnfilledMessage(
      useMarketOrder ? config.bet.order_type : "GTC",
      result.status ?? "unknown",
      parsedResponse,
    );
    log.warn(
      { orderId: result.orderId, status: result.status, clobDetail: unfilled.detail, useMarketOrder },
      "Order submitted but unfilled",
    );
    return {
      success: false,
      submitted: true,
      paper: false,
      marketSlug: market.slug,
      side,
      tokenId,
      price,
      size,
      orderId: result.orderId,
      status: result.status,
      filledSize: 0,
      filledCost: 0,
      error: unfilled.message,
      clobDetail: unfilled.detail,
      strategyReason: decision.reason,
      signal: decision.signal,
      shadowLiquidity,
      shadowStrategies,
      executionCorrelation,
      timestamp: new Date().toISOString(),
    };
  }

  log.info(
    { orderId: result.orderId, status: result.status, filledSize, filledCost, platformFee: result.platformFee, totalCost: result.totalCost },
    "Purchase confirmed on Polymarket",
  );

  return {
    success: true,
    paper: false,
    marketSlug: market.slug,
    side,
    tokenId,
    price: filledCost / filledSize,
    size: filledSize,
    orderId: result.orderId,
    status: result.status,
    filledSize,
    filledCost,
    platformFee: result.platformFee,
    totalCost: result.totalCost,
    clobDetail: result.detail,
    strategyReason: decision.reason,
    signal: decision.signal,
    shadowLiquidity,
    shadowStrategies,
    executionCorrelation,
    timestamp: new Date().toISOString(),
  };
}

