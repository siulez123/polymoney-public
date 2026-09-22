import type { IncomingMessage, ServerResponse } from "node:http";
import { buildStatusPayload, type DashboardContext } from "./dashboard-api.js";

const CHECK_MS = 1000;
const HEARTBEAT_MS = 30_000;

function fingerprint(payload: ReturnType<typeof buildStatusPayload>): string {
  const p = payload;
  return JSON.stringify({
    status: p.bot.status,
    tradingActive: p.bot.tradingActive,
    staking: p.staking,
    slug: p.bot.currentSlug,
    nextBetAt: p.bot.nextBetAt,
    betsPlaced: p.bot.betsPlaced,
    totalUsdSpent: p.bot.totalUsdSpent,
    lastBet: p.bot.lastBet,
    lastError: p.health.lastError,
    pnl: p.pnl,
    tradesLen: p.trades.length,
    trades: p.trades.map((t) => ({
      id: t.id,
      outcome: t.outcome,
      error: t.error,
      resolved: t.resolved,
      won: t.won,
      pnl: t.pnl,
    })),
    telegram: {
      sendCount: p.telegram.sendCount,
      failCount: p.telegram.failCount,
      lastSend: p.telegram.lastSend,
    },
    feed: {
      connected: p.feed.connected,
      chainlinkConnected: p.feed.chainlinkConnected,
      currentSource: p.feed.currentSource,
      lastPrice: p.feed.lastPrice,
      tickCount: p.feed.tickCount,
    },
    walletBalance: {
      current: p.wallet.balance?.currentBalanceUsd,
      len: p.wallet.balance?.history?.length ?? 0,
      last: p.wallet.balance?.history?.length
        ? p.wallet.balance.history[p.wallet.balance.history.length - 1]
        : null,
      lastError: p.wallet.balance?.lastError,
    },
  });
}

export function handleSseStream(ctx: DashboardContext, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write(": connected\n\n");

  let lastHash = "";
  let lastHeartbeat = Date.now();

  const sendPayload = () => {
    const payload = buildStatusPayload(ctx);
    const hash = fingerprint(payload);

    if (hash !== lastHash) {
      lastHash = hash;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      lastHeartbeat = Date.now();
    } else if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
      res.write(": heartbeat\n\n");
      lastHeartbeat = Date.now();
    }
  };

  sendPayload();

  const timer = setInterval(sendPayload, CHECK_MS);

  req.on("close", () => {
    clearInterval(timer);
  });
}

