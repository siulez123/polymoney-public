import type { AppConfig, BetRecord, BotState } from "./types.js";
import type { AccountBalanceTracker } from "./account-balance.js";
import type { PnlTracker } from "./pnl.js";
import type { StakingManager } from "./staking.js";
import type { TelegramNotifier } from "./telegram.js";
import type { PriceFeed } from "./price-feed.js";

import type { RiskGuard } from "./risk-guard.js";
import type { WebPushNotifier } from "./web-push.js";

export interface WalletInfo {
  polymarketAccount: string | null;
  signerAddress: string | null;
}

export interface DashboardContext {
  config: AppConfig;
  state: BotState;
  pnlTracker: PnlTracker;
  telegram: TelegramNotifier;
  feed: PriceFeed | null;
  wallet: WalletInfo;
  accountBalance: AccountBalanceTracker | null;
  staking: StakingManager | null;
  riskGuard?: RiskGuard;
  webPush?: WebPushNotifier | null;
}

function buildCumulativePnl(bets: BetRecord[]): Array<{ at: string; pnl: number; cumulative: number }> {
  const resolved = bets
    .filter((b) => b.resolved && b.resolvedAt)
    .sort((a, b) => new Date(a.resolvedAt!).getTime() - new Date(b.resolvedAt!).getTime());

  let cumulative = 0;
  return resolved.map((b) => {
    cumulative += b.pnl ?? 0;
    return { at: b.resolvedAt!, pnl: b.pnl ?? 0, cumulative };
  });
}

export function buildStatusPayload(ctx: DashboardContext) {
  const { config, state, pnlTracker, telegram, feed, wallet, accountBalance, staking } = ctx;
  const bets = pnlTracker.getBets();
  const pnl = pnlTracker.getSummary();
  const cumulative = buildCumulativePnl(bets);

  const now = Date.now();
  const nextBetMs = state.nextBetAt ? new Date(state.nextBetAt).getTime() - now : null;

  return {
    ok: true,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    health: {
      status: state.status,
      lastError: state.lastError,
      startedAt: state.startedAt,
    },
    bot: {
      status: state.status,
      tradingActive: state.tradingActive,
      currentSlug: state.currentSlug,
      nextBetAt: state.nextBetAt,
      nextBetInSeconds: nextBetMs !== null ? Math.max(0, nextBetMs / 1000) : null,
      betsPlaced: state.betsPlaced,
      totalUsdSpent: state.totalUsdSpent,
      lastBet: state.lastBet,
    },
    config: {
      mode: config.trading.mode,
      strategy: config.strategy.mode,
      betSecondsBeforeClose: config.timing.bet_seconds_before_close,
      betMinSecondsBeforeClose: config.timing.bet_min_seconds_before_close,
      entryWindows: (config.timing.entry_windows ?? []).map((w) => ({
        secondsBeforeClose: w.seconds_before_close,
        minDeltaBps: w.min_delta_bps,
        maxPrice: w.max_price,
      })),
      sizeShares: config.bet.size_shares,
      maxPrice: config.bet.max_price,
      signatureType: config.trading.signature_type,
      minDeltaBps: config.strategy.min_delta_bps,
      onNeutral: config.strategy.on_neutral,
      priceFeed: config.strategy.price_feed,
    },
    staking: staking?.getStatus() ?? {
      mode: config.staking.mode,
      seriesBankroll: 0,
      pendingRecoveryUsd: 0,
      nextStakeUsd: config.staking.base_usd,
      baseUsd: config.staking.base_usd,
      maxStakeUsd: config.staking.max_stake_usd,
      reinvestFraction: config.staking.reinvest_fraction,
      recoveryCapEnabled: config.staking.recovery_cap.enabled,
      recoveryMaxStakeUsd: config.staking.recovery_cap.max_stake_usd,
      recoveryAssumedPrice: config.staking.recovery_cap.assumed_price || config.bet.max_price,
    },
    pnl,
    charts: {
      cumulativePnl: cumulative,
      wins: pnl.wins,
      losses: pnl.losses,
      pending: pnl.pending,
    },
    trades: bets.slice().reverse(),
    wallet: {
      polymarketAccount: wallet.polymarketAccount,
      signerAddress: wallet.signerAddress,
      balance: accountBalance?.getStatus() ?? {
        currentBalanceUsd: null,
        history: [],
        lastUpdated: null,
        lastError: null,
        polling: false,
      },
    },
    telegram: telegram.getStatus(),
    feed: feed?.getStatus() ?? {
      running: false,
      connected: false,
      chainlinkConnected: false,
      chainlinkStale: false,
      lastPrice: null,
      currentSource: null,
      source: null,
      tickCount: 0,
      binanceBackup: false,
      binanceLastPrice: null,
    },
    memory: {
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  };
}

