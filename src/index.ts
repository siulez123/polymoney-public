import "dotenv/config";
import { loadConfig, loadSecrets, validateSecretsForLive } from "./config.js";
import { createLogger } from "./logger.js";
import { AccountBalanceTracker } from "./account-balance.js";
import { checkGeoblock, getSignerAddress, initClobClient, resetClobClient } from "./clob-client.js";
import { createInitialState, runBotLoop } from "./scheduler.js";
import { startHealthServer } from "./health-server.js";
import { PriceFeed } from "./price-feed.js";
import { TelegramNotifier } from "./telegram.js";
import { PnlTracker } from "./pnl.js";
import { StakingManager } from "./staking.js";
import { RiskGuard } from "./risk-guard.js";
import { getSecureAccountWallet, initSecureClient } from "./secure-trading.js";
import { WebPushNotifier } from "./web-push.js";

function needsPriceFeed(config: ReturnType<typeof loadConfig>): boolean {
  return config.strategy.mode === "momentum" || config.pnl.enabled;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const secrets = loadSecrets();
  const log = createLogger(config);
  const staking = new StakingManager(config, log);
  const riskGuard = new RiskGuard();
  const pnlTracker = new PnlTracker(config, log, staking);
  // Restore the persisted guard before health endpoints or the scheduler start.
  const state = createInitialState(pnlTracker.getSummary(), riskGuard.getStatus().pausedReason);
  const controller = new AbortController();
  const telegram = new TelegramNotifier(config, log);
  const webPush = new WebPushNotifier(log);
  webPush.init();

  const feed = needsPriceFeed(config) ? new PriceFeed(config, log, (alert) => {
    const recovered = alert.kind === "recovered";
    const title = recovered ? "Chainlink feed recovered" : "Chainlink feed stale";
    const body = recovered
      ? `Prices restored after automatic reconnection (${alert.watchdogReconnects} watchdog).`
      : `No fresh prices for ${Math.round(alert.staleForSeconds)}s; automatic reconnection started.`;
    telegram.notify(`${recovered ? "✅" : "⚠️"} <b>${title}</b>\n${body}`);
    void webPush.notifySystem(title, body, `feed-${alert.kind}-${alert.at}`);
  }) : null;

  const wallet = {
    polymarketAccount: secrets.depositWalletAddress || null,
    signerAddress: getSignerAddress(secrets),
  };

  const accountBalance = new AccountBalanceTracker();
  staking.setBalanceProvider(() => accountBalance.getCurrentBalanceUsd());

  // Health server first — Railway checks health immediately on startup
  const healthServer = startHealthServer(
    { config, state, pnlTracker, telegram, feed, wallet, accountBalance, staking, riskGuard, webPush },
    log,
  );

  validateSecretsForLive(config, secrets);

  feed?.start();

  if (config.trading.mode === "live") {
    await checkGeoblock(config, log);
    // SecureClient first: derive the correct deposit wallet (walletType 3)
    const secure = await initSecureClient(secrets, log);
    const derived = secure.account.wallet;
    if (secrets.depositWalletAddress.toLowerCase() !== derived.toLowerCase()) {
      secrets.depositWalletAddress = derived;
      wallet.polymarketAccount = derived;
      resetClobClient();
    }
    // Keep ClobClient for balance / reads with the correct funder
    await initClobClient(config, secrets, log);
    log.info(
      {
        contaPolymarket: getSecureAccountWallet() ?? secrets.depositWalletAddress,
        signer: wallet.signerAddress,
        walletType: secure.account.walletType,
      },
      "Polymarket account (SecureClient) ready for live",
    );
  }

  accountBalance.start(config, secrets, log);

  // Correct false Chainlink resolutions / pending results when the bot starts
  void pnlTracker.reconcileAgainstGamma().then((changed) => {
    if (changed.length > 0) {
      state.pnl = pnlTracker.getSummary();
      log.info({ corrected: changed.length }, "Gamma reconciliation on startup");
    }
  });

  telegram.startCommandPolling(() => ({
    config,
    state,
    pnl: pnlTracker.getSummary(),
    recentBets: pnlTracker.getBets().slice().reverse(),
    balance: accountBalance.getStatus(),
    staking: staking.getStatus(),
    wallet,
    uptimeSec: process.uptime(),
  }));

  if (
    (config.staking.mode === "paroli" || config.staking.recovery_cap.enabled)
    && !config.pnl.enabled
  ) {
    log.warn("paroli/recovery_cap requires pnl.enabled=true to update bankroll after resolution");
  }

  if (config.staking.mode === "all_in") {
    log.info("Staking all_in: each bet uses 100% of the available USDC balance");
  }

  const shutdown = (signal: string) => {
    log.info({ signal }, "Shutdown received");
    telegram.notifyStopped(signal);
    telegram.stopCommandPolling();
    controller.abort();
    feed?.stop();
    accountBalance.stop();
    healthServer?.close();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await runBotLoop(
    config,
    secrets,
    state,
    feed,
    telegram,
    pnlTracker,
    staking,
    log,
    controller.signal,
    riskGuard,
    accountBalance,
    webPush,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

