import type { AppConfig, BetRecord, BetResult, DiscoveredMarket, PnlSummary } from "./types.js";
import type { Logger } from "./logger.js";
import {
  formatBalanceMessage,
  formatHelpMessage,
  formatRecentMessage,
  formatStatusMessage,
  type CommandSnapshot,
} from "./telegram-commands.js";

export type CommandSnapshotProvider = () => CommandSnapshot;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function fmtSignal(result: BetResult): string {
  const s = result.signal;
  if (!s) return "";

  const lines: string[] = [];
  if (s.openPrice !== undefined) lines.push(`Open: $${s.openPrice.toFixed(2)}`);
  if (s.currentPrice !== undefined) lines.push(`Atual: $${s.currentPrice.toFixed(2)}`);
  if (s.deltaBps !== undefined) lines.push(`Delta: ${s.deltaBps.toFixed(2)} bps`);
  if (s.upMid !== undefined) lines.push(`Up mid: ${s.upMid.toFixed(3)}`);
  if (s.downMid !== undefined) lines.push(`Down mid: ${s.downMid.toFixed(3)}`);

  return lines.length ? "\n" + lines.map((l) => `  ${l}`).join("\n") : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramNotifier {
  private readonly enabled: boolean;
  private readonly token: string;
  private readonly chatId: string;
  private lastSend: {
    ok: boolean;
    at: string;
    error?: string;
    preview?: string;
  } | null = null;
  private sendCount = 0;
  private failCount = 0;
  private pollAbort: AbortController | null = null;
  private pollOffset = 0;
  private snapshotProvider: CommandSnapshotProvider | null = null;

  constructor(
    private config: AppConfig,
    private log: Logger,
  ) {
    this.token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
    this.chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
    this.enabled = config.telegram.enabled && Boolean(this.token && this.chatId);

    if (config.telegram.enabled && !this.enabled) {
      log.warn("Telegram enabled but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing");
    }
  }

  /** Enable long polling for /status /balance /recent (configured chat only). */
  startCommandPolling(provider: CommandSnapshotProvider): void {
    if (!this.enabled || this.pollAbort) return;
    this.snapshotProvider = provider;
    this.pollAbort = new AbortController();
    void this.registerBotCommands();
    void this.pollLoop(this.pollAbort.signal);
    this.log.info("Telegram: commands active (/status /balance /recent /help)");
  }

  stopCommandPolling(): void {
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.snapshotProvider = null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getStatus() {
    return {
      enabled: this.config.telegram.enabled,
      configured: this.enabled,
      chatId: this.chatId ? `${this.chatId.slice(0, 8)}…` : null,
      sendCount: this.sendCount,
      failCount: this.failCount,
      lastSend: this.lastSend,
      notifications: {
        start: this.config.telegram.notify_on_start,
        market: this.config.telegram.notify_on_market,
        bet: this.config.telegram.notify_on_bet,
        skip: this.config.telegram.notify_on_skip,
        error: this.config.telegram.notify_on_error,
        pnl: this.config.telegram.notify_on_pnl,
      },
    };
  }

  private async send(text: string): Promise<void> {
    if (!this.enabled) return;

    const url = this.apiUrl("sendMessage");
    const preview = text.replace(/<[^>]+>/g, "").slice(0, 80);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
          disable_notification: this.config.telegram.silent,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        this.failCount++;
        this.lastSend = { ok: false, at: new Date().toISOString(), error: `HTTP ${res.status}`, preview };
        this.log.warn({ status: res.status, body }, "Failed to send Telegram message");
        return;
      }

      this.sendCount++;
      this.lastSend = { ok: true, at: new Date().toISOString(), preview };
    } catch (err) {
      this.failCount++;
      const error = err instanceof Error ? err.message : String(err);
      this.lastSend = { ok: false, at: new Date().toISOString(), error, preview };
      this.log.warn({ err: error }, "Telegram error");
    }
  }

  notify(text: string): void {
    void this.send(text);
  }

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  private async registerBotCommands(): Promise<void> {
    try {
      // Avoid conflicts if an old webhook is still active
      await fetch(this.apiUrl("deleteWebhook"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drop_pending_updates: false }),
      });
      await fetch(this.apiUrl("setMyCommands"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commands: [
            { command: "status", description: "Bot status and P&L" },
            { command: "balance", description: "CLOB balance and staking" },
            { command: "recent", description: "Recent interactions" },
            { command: "help", description: "Command list" },
          ],
        }),
      });
    } catch (err) {
      this.log.warn({ err }, "Failed to register Telegram commands");
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const url = new URL(this.apiUrl("getUpdates"));
        url.searchParams.set("offset", String(this.pollOffset));
        url.searchParams.set("timeout", "25");
        url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

        const res = await fetch(url, { signal });
        if (!res.ok) {
          this.log.warn({ status: res.status }, "Telegram getUpdates HTTP error");
          await sleep(3000);
          continue;
        }

        const data = (await res.json()) as {
          ok?: boolean;
          result?: Array<{
            update_id: number;
            message?: {
              chat?: { id?: number | string };
              text?: string;
            };
          }>;
        };

        if (!data.ok || !data.result) {
          await sleep(2000);
          continue;
        }

        for (const update of data.result) {
          this.pollOffset = update.update_id + 1;
          const text = update.message?.text?.trim();
          const chatId = update.message?.chat?.id;
          if (!text || chatId === undefined) continue;
          if (String(chatId) !== this.chatId) {
            this.log.warn({ chatId }, "Telegram: unauthorized chat message — ignored");
            continue;
          }
          await this.handleCommand(text);
        }
      } catch (err) {
        if (signal.aborted) break;
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("abort")) {
          this.log.warn({ err: message }, "Telegram poll error");
        }
        await sleep(2000);
      }
    }
  }

  private async handleCommand(text: string): Promise<void> {
    const cmd = text.split(/\s+/)[0]?.toLowerCase().split("@")[0] ?? "";
    const snap = this.snapshotProvider?.();

    if (cmd === "/start" || cmd === "/help") {
      await this.send(formatHelpMessage());
      return;
    }

    if (!snap) {
      await this.send("Bot is starting… try again in a few seconds.");
      return;
    }

    if (cmd === "/status" || cmd === "/estado") {
      await this.send(formatStatusMessage(snap));
      return;
    }
    if (cmd === "/saldo" || cmd === "/balance") {
      await this.send(formatBalanceMessage(snap));
      return;
    }
    if (cmd === "/ultimas" || cmd === "/recent" || cmd === "/hist") {
      await this.send(formatRecentMessage(snap));
      return;
    }
  }

  notifyStarted(): void {
    if (!this.config.telegram.notify_on_start) return;

    const windows = this.config.timing.entry_windows ?? [];
    const timingLine =
      windows.length > 0
        ? `Entries: ${windows.map((w) => `T-${w.seconds_before_close}(Δ≥${w.min_delta_bps})`).join(" → ")}`
        : `Bet: ${this.config.timing.bet_seconds_before_close}s before close`;

    this.notify(
      [
        "🚀 <b>Polymoney started</b>",
        `Mode: <b>${escapeHtml(this.config.trading.mode)}</b>`,
        `Strategy: <b>${escapeHtml(this.config.strategy.mode)}</b>`,
        timingLine,
        `Size: ${this.config.bet.size_shares} shares`,
        "",
        "Commands: /status /balance /recent /help",
      ].join("\n"),
    );
  }

  notifyMarket(market: DiscoveredMarket, betAt: string, waitSeconds: number): void {
    if (!this.config.telegram.notify_on_market) return;

    this.notify(
      [
        "📊 <b>Active market</b>",
        escapeHtml(market.title),
        `Slug: <code>${escapeHtml(market.slug)}</code>`,
        `Close: ${new Date(market.windowEndUnix * 1000).toISOString()}`,
        `Bet at: ${betAt}`,
        `Wait: ${waitSeconds.toFixed(0)}s`,
      ].join("\n"),
    );
  }

  notifyBet(result: BetResult, sessionBets: number, sessionUsd: number): void {
    if (!this.config.telegram.notify_on_bet) return;

    const mode = result.paper ? "SIMULATED" : "LIVE";
    const notional = result.filledCost ?? result.price * result.size;
    const shares = result.filledSize ?? result.size;

    this.notify(
      [
        `✅ <b>Purchase ${mode}</b>`,
        `Side: <b>${result.side?.toUpperCase()}</b>`,
        `Price: ${result.price.toFixed(3)} × ${shares.toFixed(2)} shares = ${fmtUsd(notional)}`,
        `Market: <code>${escapeHtml(result.marketSlug)}</code>`,
        result.strategyReason ? `Signal: ${escapeHtml(result.strategyReason)}` : "",
        fmtSignal(result),
        result.orderId ? `Order: <code>${escapeHtml(result.orderId)}</code>` : "",
        `Session: ${sessionBets} purchases, ${fmtUsd(sessionUsd)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  notifySkipped(result: BetResult): void {
    if (!this.config.telegram.notify_on_skip) return;

    this.notify(
      [
        "⏭️ <b>Bet skipped</b>",
        `Market: <code>${escapeHtml(result.marketSlug)}</code>`,
        `Reason: ${escapeHtml(result.strategyReason ?? "neutral signal")}`,
        fmtSignal(result),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  notifyBetFailed(result: BetResult): void {
    if (!this.config.telegram.notify_on_bet) return;

    this.notify(
      [
        "❌ <b>Could not place bet</b>",
        `Market: <code>${escapeHtml(result.marketSlug)}</code>`,
        result.side ? `Side: <b>${result.side.toUpperCase()}</b>` : "",
        `Reason: ${escapeHtml(result.error ?? "unknown")}`,
        result.clobDetail ? `Details: <code>${escapeHtml(result.clobDetail.slice(0, 200))}</code>` : "",
        result.strategyReason ? `Signal: ${escapeHtml(result.strategyReason)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  notifyBetUnfilled(result: BetResult): void {
    if (!this.config.telegram.notify_on_bet) return;

    this.notify(
      [
        "⚠️ <b>Order submitted, no purchase</b>",
        `The order reached Polymarket but nobody sold at your price.`,
        `Market: <code>${escapeHtml(result.marketSlug)}</code>`,
        result.side ? `Side: <b>${result.side.toUpperCase()}</b>` : "",
        result.orderId ? `Order: <code>${escapeHtml(result.orderId)}</code>` : "",
        `Reason: ${escapeHtml(result.error ?? "no liquidity")}`,
        result.clobDetail ? `Details: <code>${escapeHtml(result.clobDetail.slice(0, 200))}</code>` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  notifyError(message: string): void {
    if (!this.config.telegram.notify_on_error) return;

    this.notify(`⚠️ <b>Error</b>\n${escapeHtml(message)}`);
  }

  notifyStopped(signal?: string): void {
    if (!this.config.telegram.notify_on_stop) return;

    this.notify(
      signal
        ? `🛑 <b>Bot stopped</b> (${escapeHtml(signal)})`
        : "🛑 <b>Bot stopped</b>",
    );
  }

  notifyPnl(record: BetRecord, summary: PnlSummary): void {
    if (!this.config.telegram.notify_on_pnl) return;

    const emoji = record.won ? "💰" : "📉";
    const resultLabel = record.won ? "WON" : "LOST";
    const pnlSign = (record.pnl ?? 0) >= 0 ? "+" : "";

    this.notify(
      [
        `${emoji} <b>${resultLabel}</b>`,
        `Your bet: <b>${record.side?.toUpperCase() ?? "?"}</b> → Winner: <b>${record.winner?.toUpperCase()}</b>`,
        `Cost: ${fmtUsd(record.cost)} | Payout: ${fmtUsd(record.payout ?? 0)}`,
        `P&L: <b>${pnlSign}${fmtUsd(record.pnl ?? 0)}</b>`,
        `Market: <code>${escapeHtml(record.marketSlug)}</code>`,
        record.resolveOpenPrice !== undefined
          ? `BTC: $${record.resolveOpenPrice.toFixed(2)} → $${record.resolveClosePrice?.toFixed(2)}`
          : "",
        "",
        `<b>Session total</b>`,
        `Resolved: ${summary.resolved} | W/L: ${summary.wins}/${summary.losses}`,
        `Win rate: ${(summary.winRate * 100).toFixed(1)}%`,
        `P&L total: <b>${summary.totalPnl >= 0 ? "+" : ""}${fmtUsd(summary.totalPnl)}</b>`,
      ]
        .filter((l) => l !== "")
        .join("\n"),
    );
  }
}

