import WebSocket from "ws";
import type { AppConfig } from "./types.js";
import type { Logger } from "./logger.js";

interface PriceTick {
  ts: number;
  price: number;
}

export type PriceSource = "chainlink" | "binance";

export interface PriceFeedStatus {
  running: boolean;
  connected: boolean;
  chainlinkConnected: boolean;
  chainlinkStale: boolean;
  lastPrice: number | null;
  currentSource: PriceSource | null;
  source: string | null;
  tickCount: number;
  binanceBackup: boolean;
  binanceLastPrice: number | null;
  uptimeSeconds: number;
  chainlinkConnections: number;
  chainlinkReconnects: number;
  chainlinkDisconnects: number;
  chainlinkErrors: number;
  chainlinkLastConnectedAt: string | null;
  chainlinkLastTickAt: string | null;
  chainlinkStaleForSeconds: number | null;
  chainlinkWatchdogReconnects: number;
  chainlinkLastWatchdogAt: string | null;
  chainlinkWatchdogOutcome: ChainlinkWatchdogOutcome;
}

export type ChainlinkWatchdogOutcome =
  | "idle"
  | "reconnecting"
  | "waiting_for_tick"
  | "recovered";

export interface PriceFeedAlert {
  kind: "stale" | "recovered";
  at: string;
  staleForSeconds: number;
  watchdogReconnects: number;
}

export interface ChainlinkWatchdogInput {
  running: boolean;
  chainlinkMode: boolean;
  connected: boolean;
  lastTickAt: number;
  startedAt: number;
  now: number;
  staleMs: number;
  lastForcedReconnectAt: number;
  backoffMs: number;
}

export function shouldForceChainlinkReconnect(input: ChainlinkWatchdogInput): boolean {
  if (!input.running || !input.chainlinkMode || !input.connected) return false;
  const freshnessBase = input.lastTickAt || input.startedAt;
  if (freshnessBase <= 0 || input.now - freshnessBase <= input.staleMs) return false;
  return (
    input.lastForcedReconnectAt <= 0
    || input.now - input.lastForcedReconnectAt >= input.backoffMs
  );
}

export type PublicPriceFeedStatus = Omit<
  PriceFeedStatus,
  "lastPrice" | "binanceLastPrice"
>;

export function publicPriceFeedStatus(status: PriceFeedStatus): PublicPriceFeedStatus {
  const { lastPrice, binanceLastPrice, ...publicStatus } = status;
  void lastPrice;
  void binanceLastPrice;
  return publicStatus;
}

const MAX_HISTORY = 600;
const PING_INTERVAL_MS = 5000;
const RECONNECT_MS = 3000;
const BINANCE_BACKUP_POLL_MS = 2000;
const WATCHDOG_INTERVAL_MS = 5000;

export class PriceFeed {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private binancePollTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastPrice: number | null = null;
  private chainlinkLastTickAt = 0;
  private binancePrice: number | null = null;
  private binanceLastTickAt = 0;
  private history: PriceTick[] = [];
  private startedAt = 0;
  private chainlinkConnections = 0;
  private chainlinkDisconnects = 0;
  private chainlinkErrors = 0;
  private chainlinkLastConnectedAt = 0;
  private chainlinkWatchdogReconnects = 0;
  private chainlinkLastWatchdogAt = 0;
  private chainlinkWatchdogOutcome: ChainlinkWatchdogOutcome = "idle";
  private watchdogAwaitingRecovery = false;

  constructor(
    private config: AppConfig,
    private log: Logger,
    private onAlert?: (alert: PriceFeedAlert) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();

    if (this.config.strategy.price_feed === "chainlink") {
      this.connectChainlink();
      this.startChainlinkWatchdog();
      if (this.binanceFallbackEnabled()) {
        this.startBinanceBackupPoll();
      }
    } else {
      this.startBinancePoll();
    }
  }

  stop(): void {
    this.running = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.binancePollTimer) clearTimeout(this.binancePollTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.ws?.close();
    this.ws = null;
  }

  getCurrentPrice(): number | null {
    const { price } = this.resolveCurrentPrice();
    return price;
  }

  getCurrentPriceSource(): PriceSource | null {
    const { source } = this.resolveCurrentPrice();
    return source;
  }

  getStatus(): PriceFeedStatus {
    const chainlink = this.config.strategy.price_feed === "chainlink";
    const chainlinkConnected = chainlink && this.ws?.readyState === WebSocket.OPEN;
    const { price, source } = this.resolveCurrentPrice();
    const now = Date.now();
    const staleBase = this.chainlinkLastTickAt || this.startedAt;
    const chainlinkStaleForSeconds =
      chainlink && staleBase > 0
        ? Math.max(0, (now - staleBase - this.chainlinkStaleMs()) / 1000)
        : null;

    return {
      running: this.running,
      connected: chainlink ? chainlinkConnected || this.isBinanceFresh() : this.running,
      chainlinkConnected,
      chainlinkStale: chainlink && !this.isChainlinkFresh(),
      lastPrice: price,
      currentSource: source,
      source: this.running ? this.config.strategy.price_feed : null,
      tickCount: this.history.length,
      binanceBackup: this.binanceFallbackEnabled(),
      binanceLastPrice: this.binancePrice,
      uptimeSeconds: this.startedAt > 0 ? Math.max(0, (now - this.startedAt) / 1000) : 0,
      chainlinkConnections: this.chainlinkConnections,
      chainlinkReconnects: Math.max(0, this.chainlinkConnections - 1),
      chainlinkDisconnects: this.chainlinkDisconnects,
      chainlinkErrors: this.chainlinkErrors,
      chainlinkLastConnectedAt: this.chainlinkLastConnectedAt > 0
        ? new Date(this.chainlinkLastConnectedAt).toISOString()
        : null,
      chainlinkLastTickAt: this.chainlinkLastTickAt > 0
        ? new Date(this.chainlinkLastTickAt).toISOString()
        : null,
      chainlinkStaleForSeconds,
      chainlinkWatchdogReconnects: this.chainlinkWatchdogReconnects,
      chainlinkLastWatchdogAt: this.chainlinkLastWatchdogAt > 0
        ? new Date(this.chainlinkLastWatchdogAt).toISOString()
        : null,
      chainlinkWatchdogOutcome: this.chainlinkWatchdogOutcome,
    };
  }

  getPriceNear(targetUnixMs: number, toleranceMs = 2000): number | null {
    if (!this.history.length) return this.isChainlinkFresh() ? this.lastPrice : null;

    let best: PriceTick | null = null;
    let bestDelta = Infinity;

    for (const tick of this.history) {
      const delta = Math.abs(tick.ts - targetUnixMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = tick;
      }
    }

    if (!best || bestDelta > toleranceMs) return null;
    return best.price;
  }

  /** Sanitized current feed return relative to the nearest tick N seconds ago. */
  getReturnBps(secondsAgo: number): number | null {
    const current = this.getCurrentPrice();
    const previous = this.getPriceNear(Date.now() - secondsAgo * 1000, 5000);
    if (current === null || previous === null || previous <= 0) return null;
    return ((current - previous) / previous) * 10_000;
  }

  private resolveCurrentPrice(): { price: number | null; source: PriceSource | null } {
    if (this.config.strategy.price_feed === "binance") {
      return { price: this.lastPrice, source: this.lastPrice !== null ? "binance" : null };
    }

    if (this.isChainlinkFresh() && this.lastPrice !== null) {
      return { price: this.lastPrice, source: "chainlink" };
    }

    if (this.config.strategy.fallback_current_price && this.isBinanceFresh()) {
      return { price: this.binancePrice, source: "binance" };
    }

    // Do not return stale Chainlink prices — momentum requires a fresh tick
    return { price: null, source: null };
  }

  private binanceFallbackEnabled(): boolean {
    return this.config.strategy.fallback_open_price || this.config.strategy.fallback_current_price;
  }

  private chainlinkStaleMs(): number {
    return this.config.strategy.chainlink_stale_seconds * 1000;
  }

  private isChainlinkFresh(): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    if (this.lastPrice === null || this.chainlinkLastTickAt === 0) return false;
    return Date.now() - this.chainlinkLastTickAt <= this.chainlinkStaleMs();
  }

  private isBinanceFresh(): boolean {
    if (this.binancePrice === null || this.binanceLastTickAt === 0) return false;
    return Date.now() - this.binanceLastTickAt <= this.chainlinkStaleMs();
  }

  private recordChainlinkTick(ts: number, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    this.lastPrice = price;
    this.chainlinkLastTickAt = Date.now();
    this.history.push({ ts, price });
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }
    if (this.watchdogAwaitingRecovery) {
      this.watchdogAwaitingRecovery = false;
      this.chainlinkWatchdogOutcome = "recovered";
      this.emitAlert("recovered", 0);
      this.log.info(
        { watchdogReconnects: this.chainlinkWatchdogReconnects },
        "Chainlink watchdog confirmed feed recovery",
      );
    }
  }

  private recordBinanceTick(price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    this.binancePrice = price;
    this.binanceLastTickAt = Date.now();

    if (this.config.strategy.price_feed === "binance") {
      this.lastPrice = price;
      this.history.push({ ts: Date.now(), price });
      if (this.history.length > MAX_HISTORY) {
        this.history.shift();
      }
    }
  }

  private connectChainlink(): void {
    const url = this.config.strategy.rtds_url;
    this.log.info({ url }, "Connecting Chainlink TWAP RTDS feed");

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.chainlinkConnections++;
      this.chainlinkLastConnectedAt = Date.now();
      if (this.watchdogAwaitingRecovery) {
        this.chainlinkWatchdogOutcome = "waiting_for_tick";
      }
      this.log.info(
        { connections: this.chainlinkConnections },
        "Chainlink feed connected",
      );
      const msg = JSON.stringify({
        action: "subscribe",
        subscriptions: [
          {
            topic: this.config.strategy.twap_window_seconds === 60
              ? "crypto_prices_twap_sixty"
              : "crypto_prices_twap_thirty",
            type: "update",
            filters: '{"symbol":"btc/usd"}',
          },
        ],
      });
      this.ws?.send(msg);

      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send("PING");
        }
      }, PING_INTERVAL_MS);
    });

    this.ws.on("message", (data) => {
      try {
        const raw = JSON.parse(data.toString()) as {
          topic?: string;
          payload?: { symbol?: string; value?: number | string; timestamp?: number; window_s?: number };
        };
        const expectedTopic = this.config.strategy.twap_window_seconds === 60
          ? "crypto_prices_twap_sixty"
          : "crypto_prices_twap_thirty";
        if (raw.topic !== expectedTopic) return;
        if (raw.payload?.symbol !== "btc/usd") return;
        if (raw.payload.window_s !== this.config.strategy.twap_window_seconds) return;

        const price = Number(raw.payload.value);
        const ts = raw.payload.timestamp ?? Date.now();
        this.recordChainlinkTick(ts, price);
      } catch {
        // ignore non-JSON messages (pong, etc.)
      }
    });

    this.ws.on("close", () => {
      if (this.running) this.chainlinkDisconnects++;
      this.log.warn(
        { disconnects: this.chainlinkDisconnects },
        "Chainlink feed disconnected, reconnecting...",
      );
      if (this.binanceFallbackEnabled()) {
        this.log.info("Using Binance as the current price fallback");
      }
      this.scheduleReconnect(() => this.connectChainlink());
    });

    this.ws.on("error", () => {
      if (this.running) this.chainlinkErrors++;
      this.log.warn(
        { errors: this.chainlinkErrors },
        "Chainlink feed error",
      );
    });
  }

  private startBinanceBackupPoll(): void {
    this.log.info("Binance backup polling enabled (Chainlink fallback)");
    const poll = async () => {
      if (!this.running) return;
      try {
        const price = await fetchBinanceSpotPrice(this.config.strategy.binance_symbol);
        if (price !== null) {
          this.recordBinanceTick(price);
        }
      } catch (err) {
        this.log.warn({ err: err instanceof Error ? err.message : err }, "Binance backup polling error");
      }
      if (this.running) {
        this.binancePollTimer = setTimeout(poll, BINANCE_BACKUP_POLL_MS);
      }
    };
    poll();
  }

  private startBinancePoll(): void {
    const poll = async () => {
      if (!this.running) return;
      try {
        const price = await fetchBinanceSpotPrice(this.config.strategy.binance_symbol);
        if (price !== null) {
          this.recordBinanceTick(price);
        }
      } catch (err) {
        this.log.warn({ err: err instanceof Error ? err.message : err }, "Binance polling error");
      }
      if (this.running) {
        this.binancePollTimer = setTimeout(poll, 1000);
      }
    };
    poll();
  }

  private scheduleReconnect(connect: () => void): void {
    if (!this.running) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws = null;
    this.reconnectTimer = setTimeout(connect, RECONNECT_MS);
  }

  private watchdogBackoffMs(): number {
    return Math.max(this.chainlinkStaleMs() * 2, RECONNECT_MS * 4);
  }

  private startChainlinkWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => this.checkChainlinkWatchdog(), WATCHDOG_INTERVAL_MS);
  }

  private checkChainlinkWatchdog(): void {
    const now = Date.now();
    const connected = this.ws?.readyState === WebSocket.OPEN;
    if (!shouldForceChainlinkReconnect({
      running: this.running,
      chainlinkMode: this.config.strategy.price_feed === "chainlink",
      connected,
      lastTickAt: this.chainlinkLastTickAt,
      startedAt: this.startedAt,
      now,
      staleMs: this.chainlinkStaleMs(),
      lastForcedReconnectAt: this.chainlinkLastWatchdogAt,
      backoffMs: this.watchdogBackoffMs(),
    })) return;

    const freshnessBase = this.chainlinkLastTickAt || this.startedAt;
    const staleForSeconds = Math.max(0, (now - freshnessBase) / 1000);
    this.chainlinkLastWatchdogAt = now;
    this.chainlinkWatchdogReconnects++;
    this.chainlinkWatchdogOutcome = "reconnecting";
    this.watchdogAwaitingRecovery = true;
    this.log.warn(
      { staleForSeconds, watchdogReconnects: this.chainlinkWatchdogReconnects },
      "Watchdog detected stale Chainlink — forcing reconnection",
    );
    this.emitAlert("stale", staleForSeconds);

    const socket = this.ws;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    } else {
      this.scheduleReconnect(() => this.connectChainlink());
    }
  }

  private emitAlert(kind: PriceFeedAlert["kind"], staleForSeconds: number): void {
    try {
      this.onAlert?.({
        kind,
        at: new Date().toISOString(),
        staleForSeconds,
        watchdogReconnects: this.chainlinkWatchdogReconnects,
      });
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : err },
        "Failed to emit sanitized feed alert",
      );
    }
  }
}

export async function fetchBinanceSpotPrice(symbol: string): Promise<number | null> {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const data = (await res.json()) as { price: string };
  const price = parseFloat(data.price);
  return Number.isFinite(price) && price > 0 ? price : null;
}

async function fetchBinanceKline(
  symbol: string,
  unixSeconds: number,
): Promise<[number, string, string, string, string, ...unknown[]] | null> {
  const startMs = unixSeconds * 1000;
  const url =
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m` +
    `&startTime=${startMs}&limit=1`;

  const res = await fetch(url);
  if (!res.ok) return null;

  const klines = (await res.json()) as Array<[number, string, string, string, string, ...unknown[]]>;
  return klines[0] ?? null;
}

export async function fetchBinanceOpenPrice(
  symbol: string,
  windowStartUnix: number,
): Promise<number | null> {
  const candle = await fetchBinanceKline(symbol, windowStartUnix);
  if (!candle) return null;
  return parseFloat(candle[1]);
}

export async function fetchBinanceClosePrice(
  symbol: string,
  windowEndUnix: number,
): Promise<number | null> {
  const candle = await fetchBinanceKline(symbol, windowEndUnix - 60);
  if (!candle) return null;
  return parseFloat(candle[4]);
}

