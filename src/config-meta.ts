/** Metadados estruturais dos campos de config (labels via i18n). */

import { getPack, type Locale } from "./i18n/index.js";

export type FieldType = "number" | "boolean" | "string" | "enum" | "json";

export interface ConfigFieldMeta {
  path: string;
  label: string;
  type: FieldType;
  description?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  restartHint?: boolean;
}

export interface ConfigSectionMeta {
  id: string;
  title: string;
  description?: string;
  fields: ConfigFieldMeta[];
}

interface FieldDef {
  path: string;
  type: FieldType;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  restartHint?: boolean;
}

interface SectionDef {
  id: string;
  fields: FieldDef[];
}

const SECTION_DEFS: SectionDef[] = [
  {
    id: "trading",
    fields: [
      { path: "trading.mode", type: "enum", options: ["paper", "live"], restartHint: true },
      { path: "trading.signature_type", type: "number", min: 0, max: 3, step: 1, restartHint: true },
      { path: "trading.clob_host", type: "string", restartHint: true },
      { path: "trading.chain_id", type: "number", min: 1, step: 1, restartHint: true },
      { path: "trading.tick_size", type: "enum", options: ["0.1", "0.01", "0.001", "0.0001"] },
      { path: "trading.neg_risk", type: "boolean" },
      { path: "trading.polygon_rpc_url", type: "string", restartHint: true },
      { path: "trading.geoblock_check", type: "boolean" },
    ],
  },
  {
    id: "strategy",
    fields: [
      { path: "strategy.mode", type: "enum", options: ["fixed", "cheapest", "momentum", "book_leader", "order_book_imbalance"] },
      { path: "strategy.shadow_modes", type: "json" },
      { path: "strategy.fixed_side", type: "enum", options: ["up", "down"] },
      { path: "strategy.min_delta_bps", type: "number", min: 0, max: 500, step: 1 },
      { path: "strategy.on_neutral", type: "enum", options: ["skip", "up", "down"] },
      { path: "strategy.price_feed", type: "enum", options: ["chainlink", "binance"], restartHint: true },
      { path: "strategy.rtds_url", type: "string", restartHint: true },
      { path: "strategy.twap_window_seconds", type: "number", min: 30, max: 60, step: 30 },
      { path: "strategy.binance_symbol", type: "string" },
      { path: "strategy.fallback_open_price", type: "boolean" },
      { path: "strategy.fallback_current_price", type: "boolean" },
      { path: "strategy.chainlink_stale_seconds", type: "number", min: 5, max: 120, step: 1 },
      { path: "strategy.min_book_mid_gap", type: "number", min: 0, max: 0.5, step: 0.01 },
    ],
  },
  {
    id: "timing",
    fields: [
      { path: "timing.bet_seconds_before_close", type: "number", min: 0.5, max: 180, step: 1 },
      { path: "timing.bet_min_seconds_before_close", type: "number", min: 0.5, max: 60, step: 0.5 },
      { path: "timing.bet_retry_interval_ms", type: "number", min: 200, max: 10000, step: 100 },
      { path: "timing.poll_interval_ms", type: "number", min: 10, max: 5000, step: 10 },
      { path: "timing.post_close_delay_seconds", type: "number", min: 0, max: 30, step: 1 },
      { path: "timing.prepare_before_bet_seconds", type: "number", min: 5, max: 300, step: 1 },
      { path: "timing.entry_windows", type: "json" },
      { path: "timing.shadow_liquidity_windows", type: "json" },
    ],
  },
  {
    id: "bet",
    fields: [
      { path: "bet.size_shares", type: "number", min: 1, step: 1 },
      { path: "bet.max_price", type: "number", min: 0.01, max: 0.99, step: 0.01 },
      { path: "bet.order_type", type: "enum", options: ["GTC", "FOK", "FAK"] },
      { path: "bet.use_market_order", type: "boolean" },
      { path: "bet.market_slippage", type: "number", min: 0, max: 0.5, step: 0.01 },
    ],
  },
  {
    id: "staking",
    fields: [
      { path: "staking.mode", type: "enum", options: ["fixed", "paroli", "all_in"] },
      { path: "staking.base_usd", type: "number", min: 0.01, step: 0.01 },
      { path: "staking.max_stake_usd", type: "number", min: 0, step: 1 },
      { path: "staking.reinvest_fraction", type: "number", min: 0, max: 1, step: 0.05 },
      { path: "staking.reset_on_loss", type: "boolean" },
      { path: "staking.recovery_cap.enabled", type: "boolean" },
      { path: "staking.recovery_cap.max_stake_usd", type: "number", min: 0, step: 1 },
      { path: "staking.recovery_cap.assumed_price", type: "number", min: 0, max: 0.99, step: 0.01 },
      { path: "staking.confidence.enabled", type: "boolean" },
      { path: "staking.confidence.confidence_at_min", type: "number", min: 0.05, max: 1, step: 0.05 },
      { path: "staking.confidence.full_delta_bps", type: "number", min: 1, max: 100, step: 1 },
      { path: "staking.confidence.default_when_no_delta", type: "number", min: 0.05, max: 1, step: 0.05 },
      { path: "staking.confidence.price_penalty_enabled", type: "boolean" },
      { path: "staking.confidence.price_factor_at_max", type: "number", min: 0.2, max: 1, step: 0.05 },
      { path: "staking.storage_path", type: "string" },
    ],
  },
  {
    id: "safety",
    fields: [
      { path: "safety.max_bets_per_session", type: "number", min: 0, step: 1 },
      { path: "safety.max_total_usd", type: "number", min: 0, step: 1 },
      { path: "safety.max_order_usd", type: "number", min: 0, step: 1 },
      { path: "safety.min_order_size", type: "number", min: 1, step: 1 },
      { path: "safety.max_spread", type: "number", min: 0, max: 1, step: 0.01 },
      { path: "safety.require_liquidity", type: "boolean" },
      { path: "safety.allow_limit_without_ask", type: "boolean" },
      { path: "safety.size_to_depth", type: "boolean" },
      { path: "safety.size_to_depth_buffer", type: "number", min: 0.1, max: 1, step: 0.05 },
      { path: "safety.max_consecutive_losses", type: "number", min: 0, max: 20, step: 1 },
      { path: "safety.max_daily_loss_usd", type: "number", min: 0, step: 1 },
      { path: "safety.rolling_pnl_guard.enabled", type: "boolean" },
      { path: "safety.rolling_pnl_guard.window_size", type: "number", min: 2, max: 200, step: 1 },
      { path: "safety.rolling_pnl_guard.min_resolved_bets", type: "number", min: 2, max: 200, step: 1 },
      { path: "safety.rolling_pnl_guard.max_loss_usd", type: "number", min: 0.01, step: 1 },
    ],
  },
  {
    id: "market",
    fields: [
      { path: "market.slug_prefix", type: "string" },
      { path: "market.window_seconds", type: "number", min: 60, step: 1 },
      { path: "market.gamma_api_url", type: "string" },
      { path: "market.discovery_lookahead_windows", type: "number", min: 0, max: 10, step: 1 },
      { path: "market.discovery_retry_ms", type: "number", min: 100, step: 100 },
    ],
  },
  {
    id: "pnl",
    fields: [
      { path: "pnl.enabled", type: "boolean" },
      { path: "pnl.storage_path", type: "string" },
      { path: "pnl.resolution_delay_seconds", type: "number", min: 0, max: 120, step: 1 },
      { path: "pnl.resolution_poll_ms", type: "number", min: 500, max: 30000, step: 500 },
      { path: "pnl.resolution_max_wait_seconds", type: "number", min: 5, max: 600, step: 5 },
    ],
  },
  {
    id: "telegram",
    fields: [
      { path: "telegram.enabled", type: "boolean" },
      { path: "telegram.notify_on_start", type: "boolean" },
      { path: "telegram.notify_on_market", type: "boolean" },
      { path: "telegram.notify_on_bet", type: "boolean" },
      { path: "telegram.notify_on_skip", type: "boolean" },
      { path: "telegram.notify_on_error", type: "boolean" },
      { path: "telegram.notify_on_stop", type: "boolean" },
      { path: "telegram.notify_on_pnl", type: "boolean" },
      { path: "telegram.silent", type: "boolean" },
    ],
  },
  {
    id: "logging",
    fields: [
      { path: "logging.level", type: "enum", options: ["trace", "debug", "info", "warn", "error", "fatal"] },
      { path: "logging.pretty", type: "boolean" },
    ],
  },
  {
    id: "server",
    fields: [
      { path: "server.enabled", type: "boolean", restartHint: true },
      { path: "server.port", type: "number", min: 1, max: 65535, step: 1, restartHint: true },
      { path: "server.host", type: "string", restartHint: true },
    ],
  },
];

/** @deprecated Prefer getConfigSections(locale) */
export const CONFIG_SECTIONS: ConfigSectionMeta[] = getConfigSections("pt");

export function getConfigSections(locale: Locale = "pt"): ConfigSectionMeta[] {
  const pack = getPack(locale).config;
  return SECTION_DEFS.map((section) => {
    const sec = pack.sections[section.id] ?? { title: section.id };
    return {
      id: section.id,
      title: sec.title,
      description: sec.description,
      fields: section.fields.map((f) => {
        const tr = pack.fields[f.path] ?? { label: f.path };
        return {
          ...f,
          label: tr.label,
          description: tr.description,
        };
      }),
    };
  });
}

export function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (!cur[key] || typeof cur[key] !== "object") cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

