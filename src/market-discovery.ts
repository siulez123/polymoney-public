import type { AppConfig, DiscoveredMarket } from "./types.js";
import type { Logger } from "./logger.js";

interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string;
  clobTokenIds: string;
  endDate: string;
  closed: boolean;
  acceptingOrders: boolean;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  negRisk?: boolean;
}

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  endDate: string;
  closed: boolean;
  markets: GammaMarket[];
}

function parseJsonArray<T>(value: string): T[] {
  return JSON.parse(value) as T[];
}

export function currentWindowStart(config: AppConfig, nowUnix = Math.floor(Date.now() / 1000)): number {
  const { window_seconds } = config.market;
  return nowUnix - (nowUnix % window_seconds);
}

export function slugForWindow(config: AppConfig, windowStartUnix: number): string {
  return `${config.market.slug_prefix}-${windowStartUnix}`;
}

export async function fetchEventBySlug(
  config: AppConfig,
  slug: string,
): Promise<GammaEvent | null> {
  const url = `${config.market.gamma_api_url}/events?slug=${encodeURIComponent(slug)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Gamma API error ${response.status} for slug ${slug}`);
  }

  const events = (await response.json()) as GammaEvent[];
  return events[0] ?? null;
}

function parseMarket(event: GammaEvent, market: GammaMarket, windowStartUnix: number, config: AppConfig): DiscoveredMarket {
  const outcomes = parseJsonArray<string>(market.outcomes);
  const tokenIds = parseJsonArray<string>(market.clobTokenIds);

  const upIndex = outcomes.findIndex((o) => o.toLowerCase() === "up");
  const downIndex = outcomes.findIndex((o) => o.toLowerCase() === "down");

  if (upIndex === -1 || downIndex === -1) {
    throw new Error(`Mercado ${market.slug} não tem outcomes Up/Down: ${outcomes.join(", ")}`);
  }

  const endUnix = Math.floor(new Date(market.endDate).getTime() / 1000);
  const windowEndUnix = windowStartUnix + config.market.window_seconds;

  return {
    eventId: event.id,
    marketId: market.id,
    slug: market.slug,
    title: event.title,
    windowStartUnix,
    windowEndUnix: endUnix || windowEndUnix,
    conditionId: market.conditionId,
    upTokenId: tokenIds[upIndex]!,
    downTokenId: tokenIds[downIndex]!,
    outcomes,
    tickSize: market.orderPriceMinTickSize
      ? String(market.orderPriceMinTickSize)
      : config.trading.tick_size,
    negRisk: market.negRisk ?? config.trading.neg_risk,
    minOrderSize: market.orderMinSize ?? config.safety.min_order_size,
    acceptingOrders: market.acceptingOrders,
    closed: market.closed || event.closed,
  };
}

export async function discoverCurrentMarket(
  config: AppConfig,
  log: Logger,
): Promise<DiscoveredMarket | null> {
  const baseWindow = currentWindowStart(config);

  for (let offset = 0; offset <= config.market.discovery_lookahead_windows; offset++) {
    const windowStart = baseWindow + offset * config.market.window_seconds;
    const slug = slugForWindow(config, windowStart);

    log.debug({ slug, windowStart }, "A procurar mercado");

    const event = await fetchEventBySlug(config, slug);
    if (!event?.markets?.length) continue;

    const market = event.markets[0]!;
    if (market.closed || event.closed) {
      log.debug({ slug }, "Mercado fechado, a tentar próximo");
      continue;
    }

    const discovered = parseMarket(event, market, windowStart, config);
    log.info(
      {
        slug: discovered.slug,
        title: discovered.title,
        windowStart: new Date(discovered.windowStartUnix * 1000).toISOString(),
        windowEnd: new Date(discovered.windowEndUnix * 1000).toISOString(),
        upTokenId: discovered.upTokenId,
        downTokenId: discovered.downTokenId,
      },
      "Mercado descoberto",
    );

    return discovered;
  }

  return null;
}

export async function waitForMarket(
  config: AppConfig,
  log: Logger,
  targetWindowStart?: number,
): Promise<DiscoveredMarket> {
  const windowStart = targetWindowStart ?? currentWindowStart(config);

  while (true) {
    const slug = slugForWindow(config, windowStart);
    const event = await fetchEventBySlug(config, slug);

    if (event?.markets?.length) {
      const market = event.markets[0]!;
      if (!market.closed && !event.closed) {
        return parseMarket(event, market, windowStart, config);
      }
    }

    log.warn({ slug }, "Mercado ainda não disponível, a tentar de novo...");
    await sleep(config.market.discovery_retry_ms);
  }
}

export function msUntilBetTime(market: DiscoveredMarket, config: AppConfig): number {
  const betAtUnix = market.windowEndUnix - config.timing.bet_seconds_before_close;
  return betAtUnix * 1000 - Date.now();
}

/** ms até o instante `windowEnd - secondsBeforeClose` */
export function msUntilSecondsBeforeClose(
  market: DiscoveredMarket,
  secondsBeforeClose: number,
): number {
  const atUnix = market.windowEndUnix - secondsBeforeClose;
  return atUnix * 1000 - Date.now();
}

export function msUntilWindowEnd(market: DiscoveredMarket): number {
  return market.windowEndUnix * 1000 - Date.now();
}

export function msUntilBetDeadline(market: DiscoveredMarket, config: AppConfig): number {
  const deadlineUnix = market.windowEndUnix - config.timing.bet_min_seconds_before_close;
  return deadlineUnix * 1000 - Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

