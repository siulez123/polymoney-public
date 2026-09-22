import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { AppConfig, EnvSecrets } from "./types.js";

const EXPERIMENTAL_SHADOW_MODES = [
  "passive_maker",
  "momentum_multi_horizon",
  "mean_reversion",
  "order_book_imbalance",
  "cross_market_confirmation",
  "fee_aware_value",
  "ensemble",
] as const;

export const configSchema = z.object({
  market: z.object({
    slug_prefix: z.string().min(1),
    window_seconds: z.number().int().positive(),
    gamma_api_url: z.string().url(),
    discovery_lookahead_windows: z.number().int().min(0).max(10),
    discovery_retry_ms: z.number().int().positive(),
  }),
  timing: z.object({
    bet_seconds_before_close: z.number().min(0.5).max(180),
    bet_min_seconds_before_close: z.number().min(0.5).max(60),
    bet_retry_interval_ms: z.number().int().min(200).max(10000),
    poll_interval_ms: z.number().int().min(10).max(5000),
    post_close_delay_seconds: z.number().min(0).max(30),
    prepare_before_bet_seconds: z.number().min(5).max(300),
    entry_windows: z.array(z.object({
      seconds_before_close: z.number().min(1).max(180),
      min_delta_bps: z.number().min(0).max(500),
      max_price: z.number().min(0.01).max(0.99).optional(),
    })).default([]),
    shadow_liquidity_windows: z.array(z.object({
      seconds_before_close: z.number().min(1).max(240),
      min_delta_bps: z.number().min(0).max(500),
      max_price: z.number().min(0.01).max(0.99).optional(),
    })).max(6).default([]).superRefine((windows, ctx) => {
      const seen = new Set<number>();
      for (const window of windows) {
        if (seen.has(window.seconds_before_close)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "shadow_liquidity_windows devem ter seconds_before_close distintos",
          });
        }
        seen.add(window.seconds_before_close);
      }
    }),
  }).superRefine((t, ctx) => {
    if (t.entry_windows.length === 0) {
      if (t.bet_min_seconds_before_close >= t.bet_seconds_before_close) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "bet_min_seconds_before_close deve ser menor que bet_seconds_before_close",
        });
      }
      return;
    }
    const sorted = [...t.entry_windows].sort((a, b) => b.seconds_before_close - a.seconds_before_close);
    for (let i = 0; i < sorted.length; i++) {
      const w = sorted[i]!;
      if (w.seconds_before_close <= t.bet_min_seconds_before_close) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `entry_windows[${i}].seconds_before_close deve ser > bet_min_seconds_before_close`,
        });
      }
      if (i > 0 && w.seconds_before_close >= sorted[i - 1]!.seconds_before_close) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "entry_windows devem ter seconds_before_close distintos",
        });
      }
    }
  }),
  bet: z.object({
    size_shares: z.number().positive(),
    max_price: z.number().min(0.01).max(0.99),
    order_type: z.enum(["GTC", "FOK", "FAK"]),
    use_market_order: z.boolean(),
    market_slippage: z.number().min(0).max(0.5),
  }),
  staking: z.object({
    mode: z.enum(["fixed", "paroli", "all_in"]),
    base_usd: z.number().positive(),
    max_stake_usd: z.number().min(0),
    reinvest_fraction: z.number().min(0).max(1),
    reset_on_loss: z.boolean(),
    recovery_cap: z.object({
      enabled: z.boolean(),
      max_stake_usd: z.number().min(0),
      assumed_price: z.number().min(0).max(0.99),
    }),
    confidence: z.object({
      enabled: z.boolean().default(true),
      confidence_at_min: z.number().min(0.05).max(1).default(0.3),
      full_delta_bps: z.number().min(1).max(100).default(15),
      default_when_no_delta: z.number().min(0.05).max(1).default(0.7),
      price_penalty_enabled: z.boolean().default(true),
      price_factor_at_max: z.number().min(0.2).max(1).default(0.85),
    }).default({
      enabled: true,
      confidence_at_min: 0.3,
      full_delta_bps: 15,
      default_when_no_delta: 0.7,
      price_penalty_enabled: true,
      price_factor_at_max: 0.85,
    }),
    storage_path: z.string().min(1),
  }),
  strategy: z.object({
    mode: z.enum(["fixed", "cheapest", "momentum", "book_leader", "order_book_imbalance"]),
    shadow_modes: z.array(z.enum([
      "fixed", "cheapest", "momentum", "book_leader", "passive_maker",
      "momentum_multi_horizon", "mean_reversion", "order_book_imbalance",
      "cross_market_confirmation", "fee_aware_value", "ensemble",
    ]))
      .max(10)
      .default(["book_leader", "cheapest"])
      .transform((modes) => [...new Set([...modes, ...EXPERIMENTAL_SHADOW_MODES])]),
    fixed_side: z.enum(["up", "down"]),
    min_delta_bps: z.number().min(0).max(500),
    on_neutral: z.enum(["skip", "up", "down"]),
    price_feed: z.enum(["chainlink", "binance"]),
    rtds_url: z.string().url(),
    twap_window_seconds: z.union([z.literal(30), z.literal(60)]).default(30),
    binance_symbol: z.string().min(1),
    fallback_open_price: z.boolean(),
    fallback_current_price: z.boolean(),
    chainlink_stale_seconds: z.number().min(5).max(120),
    min_book_mid_gap: z.number().min(0).max(0.5),
  }),
  trading: z.object({
    mode: z.enum(["paper", "live"]),
    clob_host: z.string().url(),
    chain_id: z.number().int().positive(),
    signature_type: z.number().int().min(0).max(3),
    tick_size: z.enum(["0.1", "0.01", "0.001", "0.0001"]),
    neg_risk: z.boolean(),
    polygon_rpc_url: z.string().url(),
    geoblock_check: z.boolean(),
  }),
  safety: z.object({
    max_bets_per_session: z.number().int().min(0),
    max_total_usd: z.number().min(0),
    max_order_usd: z.number().min(0),
    min_order_size: z.number().positive(),
    max_spread: z.number().min(0).max(1),
    require_liquidity: z.boolean(),
    allow_limit_without_ask: z.boolean(),
    /** Limitar o tamanho da ordem à liquidez (asks) ≤ max_price */
    size_to_depth: z.boolean().default(true),
    /** Fração do depth utilizável (0–1), ex. 0.9 = usar no máx. 90% do book */
    size_to_depth_buffer: z.number().min(0.1).max(1).default(0.9),
    /** 0 = desligado. Pausa após N perdas consecutivas. */
    max_consecutive_losses: z.number().int().min(0).max(20).default(2),
    /** 0 = desligado. Pausa se P&L do dia UTC cair abaixo de -este USD. */
    max_daily_loss_usd: z.number().min(0).default(80),
    /** Pausa quando o P&L das últimas operações resolvidas ultrapassa o limite negativo. */
    rolling_pnl_guard: z.object({
      enabled: z.boolean().default(true),
      window_size: z.number().int().min(2).max(200).default(10),
      min_resolved_bets: z.number().int().min(2).max(200).default(5),
      max_loss_usd: z.number().positive().default(5),
    }).default({
      enabled: true,
      window_size: 10,
      min_resolved_bets: 5,
      max_loss_usd: 5,
    }),
  }),
  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
    pretty: z.boolean(),
  }),
  server: z.object({
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65535),
    host: z.string(),
  }),
  telegram: z.object({
    enabled: z.boolean(),
    notify_on_start: z.boolean(),
    notify_on_market: z.boolean(),
    notify_on_bet: z.boolean(),
    notify_on_skip: z.boolean(),
    notify_on_error: z.boolean(),
    notify_on_stop: z.boolean(),
    notify_on_pnl: z.boolean(),
    silent: z.boolean(),
  }),
  pnl: z.object({
    enabled: z.boolean(),
    storage_path: z.string().min(1),
    resolution_delay_seconds: z.number().min(0).max(120),
    resolution_poll_ms: z.number().int().min(500).max(30000),
    resolution_max_wait_seconds: z.number().int().min(5).max(600),
  }),
});

export function getConfigPath(configPath?: string): string {
  return resolve(configPath ?? process.env.CONFIG_PATH ?? "config.yaml");
}

export function loadConfig(configPath?: string): AppConfig {
  const path = getConfigPath(configPath);
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  const config = configSchema.parse(parsed) as AppConfig;

  // Railway (e outros PaaS) injetam PORT — o healthcheck usa essa porta
  if (process.env.PORT) {
    config.server.port = Number(process.env.PORT);
  }

  return config;
}

/** Campos que tipicamente exigem restart do processo para aplicar por completo. */
export const CONFIG_RESTART_HINTS = [
  "trading.mode",
  "trading.signature_type",
  "trading.clob_host",
  "trading.chain_id",
  "trading.polygon_rpc_url",
  "server.port",
  "server.host",
  "server.enabled",
  "strategy.price_feed",
  "strategy.rtds_url",
] as const;

function deepAssign(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && typeof target[key] === "object"
      && target[key] !== null
      && !Array.isArray(target[key])
    ) {
      deepAssign(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

/**
 * Valida um payload completo de config, grava no YAML e aplica in-place
 * no objecto em memória (hot-reload para a maioria dos campos).
 */
export function updateConfigInPlace(
  liveConfig: AppConfig,
  incoming: unknown,
  options?: { persist?: boolean; configPath?: string },
): { config: AppConfig; requiresRestart: string[] } {
  const parsed = configSchema.parse(incoming) as AppConfig;
  const diskPort = parsed.server.port;

  // PORT do PaaS tem prioridade em runtime
  if (process.env.PORT) {
    parsed.server.port = Number(process.env.PORT);
  }

  const requiresRestart = CONFIG_RESTART_HINTS.filter((path) => {
    const [section, key] = path.split(".") as [string, string];
    const live = liveConfig as unknown as Record<string, Record<string, unknown>>;
    const next = parsed as unknown as Record<string, Record<string, unknown>>;
    return live[section]?.[key] !== next[section]?.[key];
  });

  deepAssign(liveConfig as unknown as Record<string, unknown>, parsed as unknown as Record<string, unknown>);

  if (options?.persist !== false) {
    const forDisk = structuredClone(liveConfig);
    if (process.env.PORT) {
      forDisk.server.port = diskPort;
    }
    saveConfigToDisk(forDisk, options?.configPath);
  }

  return { config: liveConfig, requiresRestart };
}

export function saveConfigToDisk(config: AppConfig, configPath?: string): void {
  const path = getConfigPath(configPath);
  const yaml = stringifyYaml(config, { lineWidth: 0, defaultStringType: "PLAIN" });
  writeFileSync(
    path,
    `# Polymoney — gerado/atualizado via UI\n# ${new Date().toISOString()}\n\n${yaml}`,
    "utf8",
  );
}

export function loadSecrets(): EnvSecrets {
  const privateKey = process.env.PRIVATE_KEY?.trim();
  const depositWalletAddress = process.env.DEPOSIT_WALLET_ADDRESS?.trim();

  if (!privateKey && process.env.TRADING_MODE !== "paper") {
    // Em paper mode não exigimos chaves
  }

  return {
    privateKey: privateKey ?? "",
    depositWalletAddress: depositWalletAddress ?? "",
    apiKey: process.env.POLY_API_KEY?.trim() || undefined,
    apiSecret: process.env.POLY_API_SECRET?.trim() || undefined,
    apiPassphrase: process.env.POLY_API_PASSPHRASE?.trim() || undefined,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() || undefined,
  };
}

export function validateSecretsForLive(config: AppConfig, secrets: EnvSecrets): void {
  if (config.trading.mode !== "live") return;

  if (process.env.LIVE_TRADING_CONFIRMED !== "true") {
    throw new Error("Modo live bloqueado: define LIVE_TRADING_CONFIRMED=true após validar a estratégia em paper");
  }

  if (!secrets.privateKey) {
    throw new Error("PRIVATE_KEY é obrigatório em modo live");
  }
  if (!secrets.depositWalletAddress) {
    throw new Error("DEPOSIT_WALLET_ADDRESS é obrigatório em modo live");
  }
  if (!secrets.privateKey.startsWith("0x")) {
    throw new Error("PRIVATE_KEY deve começar com 0x");
  }
}

