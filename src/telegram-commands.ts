import type { AppConfig, BetRecord, BotState, PnlSummary } from "./types.js";
import type { AccountBalanceStatus } from "./account-balance.js";
import type { StakingStatus } from "./staking.js";
import type { WalletInfo } from "./dashboard-api.js";
import { resolveEntryWindows } from "./entry-windows.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtUsd(value: number): string {
  const sign = value >= 0 ? "" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function fmtSignedUsd(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${fmtUsd(value)}`;
}

function fmtUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTimingLine(config: AppConfig): string {
  const windows = resolveEntryWindows(config);
  if (windows.length <= 1) {
    const w = windows[0]!;
    return `Timing: T-${w.seconds_before_close}s · delta≥${w.min_delta_bps} bps`;
  }
  return `Timing: ${windows.map((w) => `T-${w.seconds_before_close}(Δ≥${w.min_delta_bps})`).join(" → ")}`;
}

export interface CommandSnapshot {
  config: AppConfig;
  state: BotState;
  pnl: PnlSummary;
  recentBets: BetRecord[];
  balance: AccountBalanceStatus;
  staking: StakingStatus | null;
  wallet: WalletInfo;
  uptimeSec: number;
}

export function formatHelpMessage(): string {
  return [
    "<b>Polymoney commands</b>",
    "/status — bot status, config and P&amp;L",
    "/balance — CLOB balance and staking",
    "/recent — recent interactions (bets)",
    "/help — this help message",
  ].join("\n");
}

export function formatStatusMessage(snap: CommandSnapshot): string {
  const { config, state, pnl, uptimeSec } = snap;
  const nextIn =
    state.nextBetAt != null
      ? Math.max(0, (new Date(state.nextBetAt).getTime() - Date.now()) / 1000)
      : null;

  return [
    "🤖 <b>Bot status</b>",
    `Status: <b>${escapeHtml(state.status)}</b>${state.tradingActive ? "" : " (paused)"}`,
    `Mode: <b>${escapeHtml(config.trading.mode)}</b> · ${escapeHtml(config.strategy.mode)}`,
    `Uptime: ${fmtUptime(uptimeSec)}`,
    state.currentSlug ? `Market: <code>${escapeHtml(state.currentSlug)}</code>` : "Market: —",
    state.nextBetAt
      ? `Next bet: ${escapeHtml(state.nextBetAt)} (${nextIn !== null ? `${nextIn.toFixed(0)}s` : "?"})`
      : "Next bet: —",
    formatTimingLine(config),
    `Max price: ${config.bet.max_price} · order: ${config.bet.order_type}`,
    "",
    "<b>P&amp;L</b>",
    `Resolved: ${pnl.resolved} · W/L: ${pnl.wins}/${pnl.losses} · WR: ${(pnl.winRate * 100).toFixed(1)}%`,
    `P&amp;L total: <b>${fmtSignedUsd(pnl.totalPnl)}</b>`,
    `Pending: ${pnl.pending} · Skipped: ${pnl.skipped} · Failed: ${pnl.failed}`,
    state.lastError ? `\n⚠️ Last error: ${escapeHtml(state.lastError)}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function formatBalanceMessage(snap: CommandSnapshot): string {
  const { balance, staking, wallet } = snap;
  const bal =
    balance.currentBalanceUsd !== null
      ? fmtUsd(balance.currentBalanceUsd)
      : "unavailable";
  const lines = [
    "💵 <b>Account balance</b>",
    `Cash CLOB: <b>${bal}</b>`,
    balance.lastUpdated ? `Updated: ${escapeHtml(balance.lastUpdated)}` : "",
    balance.lastError ? `Balance error: ${escapeHtml(balance.lastError)}` : "",
    wallet.polymarketAccount
      ? `Wallet: <code>${escapeHtml(wallet.polymarketAccount)}</code>`
      : "",
    wallet.signerAddress ? `Signer: <code>${escapeHtml(wallet.signerAddress)}</code>` : "",
  ];

  if (staking) {
    lines.push(
      "",
      "<b>Staking</b>",
      `Mode: ${escapeHtml(staking.mode)}`,
      `Next bet: <b>${fmtUsd(staking.nextStakeUsd)}</b>`,
      `Series bankroll: ${fmtUsd(staking.seriesBankroll)}`,
      staking.recoveryCapEnabled
        ? `Pending recovery: ${fmtUsd(staking.pendingRecoveryUsd)} (cap ${fmtUsd(staking.recoveryMaxStakeUsd)})`
        : "",
    );
  }

  return lines.filter(Boolean).join("\n");
}

function outcomeLabel(b: BetRecord): string {
  if (b.won === true) return "✅ WON";
  if (b.won === false) return "❌ LOST";
  if (b.outcome === "filled" || b.outcome === "placed" || b.outcome === "paper") return "📥 FILLED";
  if (b.outcome === "failed") return "🚫 FAIL";
  if (b.outcome === "unfilled") return "⚠️ UNFILLED";
  if (b.outcome === "skipped") return "⏭️ SKIP";
  return escapeHtml(String(b.outcome ?? b.orderStatus ?? "?"));
}

export function formatRecentMessage(snap: CommandSnapshot, limit = 8): string {
  const bets = snap.recentBets.slice(0, limit);
  if (bets.length === 0) {
    return "📋 <b>Recent interactions</b>\nNo history yet.";
  }

  const lines = ["📋 <b>Recent interactions</b>", ""];
  for (const b of bets) {
    const when = b.placedAt ? b.placedAt.replace("T", " ").slice(0, 19) : "?";
    const side = b.side ? b.side.toUpperCase() : "—";
    const cost = b.cost > 0 ? ` ${fmtUsd(b.cost)}` : "";
    const pnl =
      b.pnl !== undefined && b.pnl !== null && b.resolved
        ? ` · P&amp;L ${fmtSignedUsd(b.pnl)}`
        : "";
    const detail =
      b.error
        ? escapeHtml(b.error.slice(0, 60))
        : b.strategyReason
          ? escapeHtml(b.strategyReason.slice(0, 60))
          : "";
    lines.push(
      `${outcomeLabel(b)} <b>${side}</b>${cost}${pnl}`,
      `<code>${escapeHtml(when)}</code> · ${escapeHtml(b.marketSlug ?? "")}`,
    );
    if (detail) lines.push(detail);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

