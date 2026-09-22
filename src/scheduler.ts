import type { AppConfig, BotState, DiscoveredMarket, BetRecord } from "./types.js";
import type { Logger } from "./logger.js";
import {
  currentWindowStart,
  discoverCurrentMarket,
  msUntilBetDeadline,
  msUntilSecondsBeforeClose,
  msUntilWindowEnd,
  sleep,
  slugForWindow,
  waitForMarket,
} from "./market-discovery.js";
import {
  evaluateShadowObservation,
  executeBet,
  isBetRetryable,
  type BetAttemptOptions,
  type SessionStats,
} from "./bet-executor.js";
import type { EnvSecrets } from "./types.js";
import type { PriceFeed } from "./price-feed.js";
import type { TelegramNotifier } from "./telegram.js";
import { PnlTracker, buildSummary } from "./pnl.js";
import type { StakingManager } from "./staking.js";
import type { AccountBalanceTracker } from "./account-balance.js";
import type { WebPushNotifier } from "./web-push.js";
import { RiskGuard } from "./risk-guard.js";
import {
  activeShadowLiquidityWindow,
  earliestEntrySeconds,
  earliestObservationSeconds,
  resolveEntryWindows,
  resolveShadowLiquidityWindows,
  type EntryWindow,
} from "./entry-windows.js";
import { buildDailySessionStats, utcDayKey } from "./daily-limits.js";
import type { BetResult } from "./types.js";
import { ClobLiquidityStream, type MarketBooks } from "./clob-liquidity-stream.js";
import { runMarketCycle } from "./market-cycle.js";

export function createInitialState(pnl = buildSummary([]), pausedReason: string | null = null): BotState {
  return {
    status: pausedReason !== null ? "paused" : "idle",
    currentSlug: null,
    nextBetAt: null,
    betsPlaced: 0,
    totalUsdSpent: 0,
    lastBet: null,
    lastError: pausedReason !== null ? `Circuit breaker: ${pausedReason}` : null,
    startedAt: new Date().toISOString(),
    pnl,
    tradingActive: pausedReason === null,
  };
}

function isFilledBet(result: BetResult): boolean {
  return Boolean(result.success && !result.skipped && result.side);
}

async function waitUntilSecondsBeforeClose(
  market: DiscoveredMarket,
  secondsBeforeClose: number,
  config: AppConfig,
  state: BotState,
  telegram: TelegramNotifier,
  log: Logger,
  notify: boolean,
): Promise<void> {
  state.status = state.tradingActive ? "waiting" : "paused";
  state.currentSlug = market.slug;

  const betAtUnix = market.windowEndUnix - secondsBeforeClose;
  state.nextBetAt = new Date(betAtUnix * 1000).toISOString();

  let remaining = msUntilSecondsBeforeClose(market, secondsBeforeClose);

  if (remaining <= 0) {
    log.warn(
      { slug: market.slug, t: secondsBeforeClose },
      "Entry time T has passed — trying immediately",
    );
    return;
  }

  log.info(
    {
      slug: market.slug,
      entryT: secondsBeforeClose,
      betAt: state.nextBetAt,
      waitSeconds: (remaining / 1000).toFixed(1),
    },
    "Waiting for the entry window",
  );

  if (notify) {
    telegram.notifyMarket(market, state.nextBetAt!, remaining / 1000);
  }

  const prepareMs = config.timing.prepare_before_bet_seconds * 1000;

  while (remaining > 0) {
    if (!state.tradingActive) {
      state.status = "paused";
    }
    if (remaining > prepareMs) {
      const sleepChunk = Math.min(remaining - prepareMs, 5000);
      await sleep(sleepChunk);
    } else {
      await sleep(config.timing.poll_interval_ms);
    }
    remaining = msUntilSecondsBeforeClose(market, secondsBeforeClose);
  }
}

async function waitUntilWindowClose(
  market: DiscoveredMarket,
  config: AppConfig,
  log: Logger,
): Promise<void> {
  let remaining = msUntilWindowEnd(market);
  while (remaining > 0) {
    await sleep(Math.min(remaining, 1000));
    remaining = msUntilWindowEnd(market);
  }
  await sleep(config.timing.post_close_delay_seconds * 1000);
  log.debug({ slug: market.slug }, "Window closed");
}

/** true = this T and the next entry window T have passed → skip */
function shouldSkipPastWindow(
  market: DiscoveredMarket,
  window: EntryWindow,
  next: EntryWindow | undefined,
): boolean {
  const ms = msUntilSecondsBeforeClose(market, window.seconds_before_close);
  if (ms >= 0) return false;
  if (!next) return false;
  return msUntilSecondsBeforeClose(market, next.seconds_before_close) < 0;
}

function primaryShadowFillable(config: AppConfig, result: BetResult): boolean {
  return result.shadowStrategies?.find(
    (evaluation) => evaluation.mode === config.strategy.mode,
  )?.fullyFillable ?? false;
}

async function runShadowLiquidityWindows(
  config: AppConfig,
  market: DiscoveredMarket,
  feed: PriceFeed | null,
  log: Logger,
  state: BotState,
  telegram: TelegramNotifier,
  pnlTracker: PnlTracker,
  stream: ClobLiquidityStream,
  signal: AbortSignal,
): Promise<void> {
  const windows = resolveShadowLiquidityWindows(config);
  for (let index = 0; index < windows.length; index++) {
    if (signal.aborted) return;
    const window = windows[index]!;
    const next = windows[index + 1];
    if (shouldSkipPastWindow(market, window, next)) continue;

    await waitUntilSecondsBeforeClose(
      market,
      window.seconds_before_close,
      config,
      state,
      telegram,
      log,
      false,
    );
    if (signal.aborted) return;

    const result = await evaluateShadowObservation(
      config,
      market,
      feed,
      log,
      {
        minDeltaBps: window.min_delta_bps,
        maxPrice: window.max_price,
        entrySecondsBeforeClose: window.seconds_before_close,
      },
      "fixed_window",
      stream.getBooks() ?? undefined,
    );
    pnlTracker.recordShadowObservation(market, result);
    state.pnl = pnlTracker.getSummary();
  }
}

async function runEntryWindows(
  config: AppConfig,
  secrets: EnvSecrets,
  market: DiscoveredMarket,
  stats: SessionStats,
  feed: PriceFeed | null,
  log: Logger,
  staking: StakingManager | null,
  accountBalance: AccountBalanceTracker | null,
  state: BotState,
  telegram: TelegramNotifier,
  pnlTracker: PnlTracker,
  signal: AbortSignal,
): Promise<BetResult> {
  const windows = resolveEntryWindows(config);
  let lastResult: BetResult | null = null;

  for (let i = 0; i < windows.length; i++) {
    if (signal.aborted || !state.tradingActive) break;
    if (msUntilBetDeadline(market, config) <= 0) {
      log.info({ slug: market.slug }, "Bet deadline reached — stopping attempts");
      break;
    }

    const window = windows[i]!;
    const next = windows[i + 1];

    if (shouldSkipPastWindow(market, window, next)) {
      log.debug(
        { t: window.seconds_before_close, nextT: next?.seconds_before_close },
        "Entry window has passed — skipping",
      );
      continue;
    }

    await waitUntilSecondsBeforeClose(
      market,
      window.seconds_before_close,
      config,
      state,
      telegram,
      log,
      false, // notification already sent while idling until the first T
    );

    if (signal.aborted || !state.tradingActive) break;
    if (msUntilBetDeadline(market, config) <= 0) break;

    const attempt: BetAttemptOptions = {
      minDeltaBps: window.min_delta_bps,
      maxPrice: window.max_price,
      entrySecondsBeforeClose: window.seconds_before_close,
    };

    state.status = "executing";
    log.info(
      {
        slug: market.slug,
        entryT: window.seconds_before_close,
        minDeltaBps: window.min_delta_bps,
        maxPrice: window.max_price ?? config.bet.max_price,
        windowIndex: i + 1,
        windowCount: windows.length,
      },
      "Entry attempt",
    );

    let result = await executeBet(
      config,
      secrets,
      market,
      stats,
      feed,
      log,
      staking,
      accountBalance,
      attempt,
    );
    let attempts = 1;

    // Retry liquidity only until the next T (or deadline)
    while (isBetRetryable(result)) {
      const untilNext = next
        ? msUntilSecondsBeforeClose(market, next.seconds_before_close)
        : msUntilBetDeadline(market, config);
      if (untilNext <= 0) break;

      log.info(
        {
          attempt: attempts + 1,
          entryT: window.seconds_before_close,
          error: result.error,
          remainingMs: untilNext,
        },
        "Liquidity retry",
      );
      await sleep(Math.min(config.timing.bet_retry_interval_ms, untilNext));
      result = await executeBet(
        config,
        secrets,
        market,
        stats,
        feed,
        log,
        staking,
        accountBalance,
        attempt,
      );
      attempts++;
    }

    if (attempts > 1) {
      log.info(
        { attempts, success: result.success, entryT: window.seconds_before_close },
        "Retries for this window completed",
      );
    }

    lastResult = result;
    state.lastBet = result;
    state.lastError = result.error ?? null;
    pnlTracker.recordAttempt(market, result);
    state.pnl = pnlTracker.getSummary();

    if (isFilledBet(result)) {
      log.info({ entryT: window.seconds_before_close }, "Fill in this window — no further attempts");
      return result;
    }

    if (result.skipped) {
      log.info(
        { reason: result.strategyReason, entryT: window.seconds_before_close },
        "Skipped this window — trying the next T",
      );
      continue;
    }

    // Unfilled or failed: try the next T (FAK leaves no resting order)
    log.info(
      {
        entryT: window.seconds_before_close,
        success: result.success,
        submitted: result.submitted,
        error: result.error,
      },
      "No fill in this window — trying the next T",
    );
  }

  if (lastResult) return lastResult;

  return {
    success: true,
    paper: config.trading.mode === "paper",
    marketSlug: market.slug,
    side: null,
    tokenId: null,
    price: 0,
    size: 0,
    skipped: true,
    strategyReason: "no entry window available",
    status: "skipped",
    timestamp: new Date().toISOString(),
  };
}

export async function runBotLoop(
  config: AppConfig,
  secrets: EnvSecrets,
  state: BotState,
  feed: PriceFeed | null,
  telegram: TelegramNotifier,
  pnlTracker: PnlTracker,
  staking: StakingManager | null,
  log: Logger,
  signal: AbortSignal,
  riskGuard: RiskGuard = new RiskGuard(),
  accountBalance: AccountBalanceTracker | null = null,
  webPush: WebPushNotifier | null = null,
): Promise<void> {
  const liquidityStream = new ClobLiquidityStream(log);
  signal.addEventListener("abort", () => liquidityStream.stop(), { once: true });
  const recordedLiquidityTriggers = new Set<string>();
  const liquidityTriggersInFlight = new Set<string>();

  let statsDay = utcDayKey();
  let stats: SessionStats = buildDailySessionStats(pnlTracker.getBets());
  state.betsPlaced = stats.betsPlaced;
  state.totalUsdSpent = stats.totalUsdSpent;

  const notifyResolved = (record: BetRecord) => {
    telegram.notifyPnl(record, state.pnl);
    const side = (record.side || "?").toUpperCase();
    const slug = String(record.marketSlug || "").replace("btc-updown-5m-", "");
    const pnl = record.pnl ?? 0;
    const body =
      `${side} · ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`
      + (slug ? ` · ${slug}` : "");
    void webPush?.notifyPnl(
      Boolean(record.won),
      body,
      pnl,
      `${record.id}|${record.resolvedAt ?? "resolved"}`,
    );
  };

  const applyRiskPause = (reason: string, record: BetRecord) => {
    state.tradingActive = false;
    state.status = "paused";
    state.lastError = `Circuit breaker: ${reason}`;
    log.warn(
      {
        reason,
        won: record.won,
        pnl: record.pnl,
        risk: riskGuard.getStatus(),
      },
      "Trading paused by circuit breaker",
    );
    telegram.notify(
      `🛑 <b>Trading paused</b>\n${reason}\n`
      + `Bet P&L: ${record.pnl?.toFixed(2) ?? "?"} · Resume in the dashboard (Play).`,
    );
    void webPush?.notifySystem(
      "Polymoney paused",
      `${reason} · Bet P&L: ${record.pnl?.toFixed(2) ?? "?"} USD. Open the dashboard to resume.`,
      `risk-${record.id}-${record.resolvedAt ?? "resolved"}`,
    );
  };

  const onResolvedRecord = (record: BetRecord) => {
    const reason = riskGuard.onResolved(record, config);
    if (reason) applyRiskPause(reason, record);
  };

  const windows = resolveEntryWindows(config);
  log.info(
    {
      mode: config.trading.mode,
      strategy: config.strategy.mode,
      entryWindows: windows.map((w) => ({
        t: w.seconds_before_close,
        minDelta: w.min_delta_bps,
        maxPrice: w.max_price,
      })),
      earliestT: earliestEntrySeconds(config),
      sizeShares: config.bet.size_shares,
      maxStakeUsd: config.staking.max_stake_usd,
      recoveryCap: config.staking.recovery_cap.enabled,
      maxConsecutiveLosses: config.safety.max_consecutive_losses,
      maxDailyLossUsd: config.safety.max_daily_loss_usd,
    },
    "Bot started",
  );

  telegram.notifyStarted();

  while (!signal.aborted) {
    try {
      if (!state.tradingActive) {
        state.status = "paused";
      } else {
        state.status = "discovering";
      }

      let market = await discoverCurrentMarket(config, log);

      if (!market) {
        const nextWindow = currentWindowStart(config) + config.market.window_seconds;
        const nextSlug = slugForWindow(config, nextWindow);
        log.info({ nextSlug }, "Current market unavailable, waiting for the next one");
        market = await waitForMarket(config, log, nextWindow);
      }

      const timeToEnd = msUntilWindowEnd(market);
      const timeToDeadline = msUntilBetDeadline(market, config);

      if (timeToEnd <= 0 || timeToDeadline <= 0) {
        const nextWindow = market.windowStartUnix + config.market.window_seconds;
        log.info({ nextWindow }, "Current window ended / deadline passed, advancing");
        market = await waitForMarket(config, log, nextWindow);
      }

      liquidityStream.watchMarket(market, async (books: MarketBooks, observedAt: string) => {
        const secondsBeforeClose = msUntilWindowEnd(market) / 1000;
        const window = activeShadowLiquidityWindow(config, secondsBeforeClose);
        if (!window) return;

        const key = `${market.slug}|T-${window.seconds_before_close}`;
        if (recordedLiquidityTriggers.has(key) || liquidityTriggersInFlight.has(key)) return;
        liquidityTriggersInFlight.add(key);
        try {
          const result = await evaluateShadowObservation(
            config,
            market,
            feed,
            log,
            {
              minDeltaBps: window.min_delta_bps,
              maxPrice: window.max_price,
              entrySecondsBeforeClose: window.seconds_before_close,
            },
            "websocket_trigger",
            books,
            observedAt,
          );
          if (!primaryShadowFillable(config, result)) return;
          pnlTracker.recordShadowObservation(market, result);
          state.pnl = pnlTracker.getSummary();
          recordedLiquidityTriggers.add(key);
          log.info(
            { slug: market.slug, entryT: window.seconds_before_close, observedAt },
            "CLOB liquidity trigger captured in shadow",
          );
        } finally {
          liquidityTriggersInFlight.delete(key);
        }
      });

      // Wake at the first shadow T, keeping the notification pointed at the first live T.
      state.status = state.tradingActive ? "waiting" : "paused";
      state.currentSlug = market.slug;
      const firstT = earliestObservationSeconds(config);
      const firstLiveT = earliestEntrySeconds(config);
      const firstLiveAt = market.windowEndUnix - firstLiveT;
      state.nextBetAt = new Date(firstLiveAt * 1000).toISOString();
      let untilFirst = msUntilSecondsBeforeClose(market, firstT);
      if (untilFirst > 0) {
        log.info(
          {
            slug: market.slug,
            observationT: firstT,
            liveEntryT: firstLiveT,
            waitSeconds: (untilFirst / 1000).toFixed(1),
          },
          "Waiting for the first shadow observation",
        );
        telegram.notifyMarket(
          market,
          state.nextBetAt,
          Math.max(0, msUntilSecondsBeforeClose(market, firstLiveT) / 1000),
        );
        const prepareMs = config.timing.prepare_before_bet_seconds * 1000;
        while (untilFirst > 0) {
          if (!state.tradingActive) state.status = "paused";
          if (untilFirst > prepareMs) {
            await sleep(Math.min(untilFirst - prepareMs, 5000));
          } else {
            await sleep(config.timing.poll_interval_ms);
          }
          untilFirst = msUntilSecondsBeforeClose(market, firstT);
        }
      }

      if (signal.aborted) break;

      await runMarketCycle(async () => {
        await runShadowLiquidityWindows(
          config,
          market,
          feed,
          log,
          // Shadow timers must not overwrite the primary entry time/status.
          { ...state },
          telegram,
          pnlTracker,
          liquidityStream,
          signal,
        );
      }, async () => {
        if (signal.aborted) return;

        if (!state.tradingActive) {
          log.info({ slug: market.slug }, "Trading paused — bet skipped");
          state.status = "paused";
          await waitUntilWindowClose(market, config, log);
          return;
        }

        const currentStatsDay = utcDayKey();
        if (currentStatsDay !== statsDay) {
          statsDay = currentStatsDay;
          stats = buildDailySessionStats(pnlTracker.getBets());
          state.betsPlaced = stats.betsPlaced;
          state.totalUsdSpent = stats.totalUsdSpent;
          log.info(
            { utcDay: statsDay, betsPlaced: stats.betsPlaced, totalUsdSpent: stats.totalUsdSpent },
            "UTC daily counters reset",
          );
        }

        const result = await runEntryWindows(
          config,
          secrets,
          market,
          stats,
          feed,
          log,
          staking,
          accountBalance,
          state,
          telegram,
          pnlTracker,
          signal,
        );

        state.lastBet = result;
        state.lastError = result.error ?? null;
        state.pnl = pnlTracker.getSummary();

        if (result.skipped) {
          log.info({ reason: result.strategyReason }, "Bet skipped by strategy (all windows)");
          telegram.notifySkipped(result);
          state.status = "done";
        } else if (isFilledBet(result)) {
          stats.betsPlaced++;
          stats.totalUsdSpent += result.filledCost ?? result.price * result.size;
          state.betsPlaced = stats.betsPlaced;
          state.totalUsdSpent = stats.totalUsdSpent;
          telegram.notifyBet(result, stats.betsPlaced, stats.totalUsdSpent);
          state.status = "done";
        } else if (result.submitted) {
          telegram.notifyBetUnfilled(result);
          state.status = "error";
        } else {
          telegram.notifyBetFailed(result);
          state.status = "error";
        }

        await waitUntilWindowClose(market, config, log);

        if (isFilledBet(result)) {
          void pnlTracker.resolveBet(market, result, feed).then((resolved) => {
            state.pnl = pnlTracker.getSummary();
            if (resolved?.resolved) {
              notifyResolved(resolved);
              onResolvedRecord(resolved);
            }
          });
        }

      }, async () => {
        const reconciled = await pnlTracker.reconcileAgainstGamma();
        state.pnl = pnlTracker.getSummary();
        for (const record of reconciled) {
          if (record.resolved) {
            notifyResolved(record);
            onResolvedRecord(record);
          }
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.status = "error";
      state.lastError = message;
      log.error({ err: message }, "Bot loop error");
      telegram.notifyError(message);
      await sleep(5000);
    }
  }

  liquidityStream.stop();
  log.info("Bot stopped");
}

