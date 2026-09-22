import WebSocket from "ws";
import type { DiscoveredMarket, OrderBookLevel, OrderBookSnapshot } from "./types.js";
import type { Logger } from "./logger.js";

const CLOB_MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_INTERVAL_MS = 10_000;
const RECONNECT_MS = 2_000;

export type MarketBooks = { up: OrderBookSnapshot; down: OrderBookSnapshot };
export type MarketBooksListener = (books: MarketBooks, observedAt: string) => void | Promise<void>;

function finiteLevel(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normaliseLevels(raw: unknown, descending: boolean): OrderBookLevel[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const level = item as { price?: unknown; size?: unknown };
    const price = finiteLevel(level.price);
    const size = finiteLevel(level.size);
    if (price === null || size === null || size <= 0) return [];
    return [{ price, size }];
  }).sort((a, b) => descending ? b.price - a.price : a.price - b.price);
}

function snapshot(
  bids: OrderBookLevel[],
  asks: OrderBookLevel[],
): OrderBookSnapshot {
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  return {
    bids,
    asks,
    bestBid,
    bestAsk,
    spread: bestBid !== null && bestAsk !== null
      ? Number((bestAsk - bestBid).toFixed(6))
      : null,
  };
}

function updateLevel(
  levels: OrderBookLevel[],
  price: number,
  size: number,
  descending: boolean,
): OrderBookLevel[] {
  const byPrice = new Map(levels.map((level) => [level.price, level.size]));
  if (size <= 0) byPrice.delete(price);
  else byPrice.set(price, size);
  return [...byPrice.entries()]
    .map(([levelPrice, levelSize]) => ({ price: levelPrice, size: levelSize }))
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price);
}

/**
 * Apply a public market channel message to the book cache.
 * Exported for tests; contains no credentials and submits no orders.
 */
export function applyClobMarketMessage(
  cache: Map<string, OrderBookSnapshot>,
  payload: unknown,
): boolean {
  const messages = Array.isArray(payload) ? payload : [payload];
  let changed = false;

  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const event = item as {
      event_type?: string;
      asset_id?: unknown;
      bids?: unknown;
      asks?: unknown;
      price_changes?: unknown;
    };

    if (event.event_type === "book" && typeof event.asset_id === "string") {
      cache.set(
        event.asset_id,
        snapshot(normaliseLevels(event.bids, true), normaliseLevels(event.asks, false)),
      );
      changed = true;
      continue;
    }

    if (event.event_type !== "price_change" || !Array.isArray(event.price_changes)) continue;
    for (const rawChange of event.price_changes) {
      if (!rawChange || typeof rawChange !== "object") continue;
      const change = rawChange as {
        asset_id?: unknown;
        price?: unknown;
        size?: unknown;
        side?: unknown;
      };
      if (typeof change.asset_id !== "string") continue;
      const price = finiteLevel(change.price);
      const size = finiteLevel(change.size);
      const side = String(change.side ?? "").toUpperCase();
      if (price === null || size === null || (side !== "BUY" && side !== "SELL")) continue;

      const current = cache.get(change.asset_id) ?? snapshot([], []);
      const bids = side === "BUY"
        ? updateLevel(current.bids, price, size, true)
        : current.bids;
      const asks = side === "SELL"
        ? updateLevel(current.asks, price, size, false)
        : current.asks;
      cache.set(change.asset_id, snapshot(bids, asks));
      changed = true;
    }
  }

  return changed;
}

export class ClobLiquidityStream {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private generation = 0;
  private market: DiscoveredMarket | null = null;
  private listener: MarketBooksListener | null = null;
  private cache = new Map<string, OrderBookSnapshot>();

  constructor(private log: Logger) {}

  watchMarket(market: DiscoveredMarket, listener: MarketBooksListener): void {
    if (
      this.running
      && this.market?.slug === market.slug
      && this.listener === listener
    ) return;

    this.stopSocket();
    this.running = true;
    this.generation++;
    this.market = market;
    this.listener = listener;
    this.cache.clear();
    this.connect(this.generation);
  }

  getBooks(): MarketBooks | null {
    if (!this.market) return null;
    const up = this.cache.get(this.market.upTokenId);
    const down = this.cache.get(this.market.downTokenId);
    return up && down ? { up, down } : null;
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.market = null;
    this.listener = null;
    this.cache.clear();
    this.stopSocket();
  }

  private connect(generation: number): void {
    if (!this.running || generation !== this.generation || !this.market) return;
    const market = this.market;
    this.log.info({ slug: market.slug }, "Connecting public CLOB stream (shadow-only)");
    const ws = new WebSocket(CLOB_MARKET_WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      if (generation !== this.generation || !this.running) return;
      ws.send(JSON.stringify({
        assets_ids: [market.upTokenId, market.downTokenId],
        type: "market",
        custom_feature_enabled: true,
      }));
      this.pingTimer = setInterval(() => {
        if (this.ws === ws && ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, PING_INTERVAL_MS);
    });

    ws.on("message", (data) => {
      if (generation !== this.generation || !this.running) return;
      try {
        const text = data.toString();
        if (text === "PONG" || text === "PING") return;
        const changed = applyClobMarketMessage(this.cache, JSON.parse(text));
        const books = changed ? this.getBooks() : null;
        if (books && this.listener) {
          void Promise.resolve(this.listener(books, new Date().toISOString())).catch((err) => {
            this.log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              "CLOB stream shadow consumer failed",
            );
          });
        }
      } catch (err) {
        this.log.debug(
          { err: err instanceof Error ? err.message : String(err) },
          "CLOB message ignored",
        );
      }
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.clearPing();
      this.ws = null;
      if (!this.running || generation !== this.generation) return;
      this.log.warn({ slug: market.slug }, "CLOB stream disconnected; reconnecting");
      this.reconnectTimer = setTimeout(() => this.connect(generation), RECONNECT_MS);
    });

    ws.on("error", () => {
      this.log.warn({ slug: market.slug }, "Public CLOB stream error");
    });
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private stopSocket(): void {
    this.clearPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
  }
}

