export type StrategyMode =
  | "fixed"
  | "cheapest"
  | "momentum"
  | "book_leader"
  | "passive_maker"
  | "momentum_multi_horizon"
  | "mean_reversion"
  | "order_book_imbalance"
  | "cross_market_confirmation"
  | "fee_aware_value"
  | "ensemble";
export type NeutralAction = "skip" | "up" | "down";
export type PriceFeedSource = "chainlink" | "binance";
export type OrderTypeName = "GTC" | "FOK" | "FAK";
export type TradingMode = "paper" | "live";

export interface AppConfig {
  market: {
    slug_prefix: string;
    window_seconds: number;
    gamma_api_url: string;
    discovery_lookahead_windows: number;
    discovery_retry_ms: number;
  };
  timing: {
    bet_seconds_before_close: number;
    bet_min_seconds_before_close: number;
    bet_retry_interval_ms: number;
    poll_interval_ms: number;
    post_close_delay_seconds: number;
    prepare_before_bet_seconds: number;
    /**
     * Várias tentativas na mesma janela 5m, cada uma com o seu min_delta (e max_price opcional).
     * Se vazio, usa bet_seconds_before_close + strategy.min_delta_bps (comportamento antigo).
     */
    entry_windows: Array<{
      seconds_before_close: number;
      min_delta_bps: number;
      /** Override opcional de bet.max_price só neste T */
      max_price?: number;
    }>;
    /**
     * Observações antecipadas exclusivamente shadow. Nunca autorizam envio de ordens.
     */
    shadow_liquidity_windows: Array<{
      seconds_before_close: number;
      min_delta_bps: number;
      max_price?: number;
    }>;
  };
  bet: {
    size_shares: number;
    max_price: number;
    order_type: OrderTypeName;
    use_market_order: boolean;
    market_slippage: number;
  };
  staking: {
    mode: "fixed" | "paroli" | "all_in";
    base_usd: number;
    max_stake_usd: number;
    /** 0–1: fração do pnl reinvestida na banca_série após vitória (paroli) */
    reinvest_fraction: number;
    reset_on_loss: boolean;
    recovery_cap: {
      enabled: boolean;
      max_stake_usd: number;
      /** Preço assumido no cálculo (0 = usa bet.max_price) */
      assumed_price: number;
    };
    /** Escala o stake (paroli + recovery) pela força do sinal */
    confidence: {
      enabled: boolean;
      /** Confidence quando |delta| = min_delta_bps */
      confidence_at_min: number;
      /** |delta| a partir do qual confidence delta = 1 */
      full_delta_bps: number;
      /** Se não há delta (outras estratégias) */
      default_when_no_delta: number;
      /** Penalizar asks perto do max_price */
      price_penalty_enabled: boolean;
      /** Multiplicador de confidence quando price = max_price */
      price_factor_at_max: number;
    };
    storage_path: string;
  };
  strategy: {
    mode: StrategyMode;
    /** Estratégias adicionais avaliadas apenas em shadow; nunca enviam ordens. */
    shadow_modes: StrategyMode[];
    fixed_side: "up" | "down";
    min_delta_bps: number;
    on_neutral: NeutralAction;
    price_feed: PriceFeedSource;
    rtds_url: string;
    twap_window_seconds: 30 | 60;
    binance_symbol: string;
    fallback_open_price: boolean;
    fallback_current_price: boolean;
    chainlink_stale_seconds: number;
    min_book_mid_gap: number;
  };
  trading: {
    mode: TradingMode;
    clob_host: string;
    chain_id: number;
    signature_type: number;
    tick_size: string;
    neg_risk: boolean;
    polygon_rpc_url: string;
    geoblock_check: boolean;
  };
  safety: {
    max_bets_per_session: number;
    max_total_usd: number;
    max_order_usd: number;
    min_order_size: number;
    max_spread: number;
    require_liquidity: boolean;
    allow_limit_without_ask: boolean;
    size_to_depth: boolean;
    size_to_depth_buffer: number;
    /** 0 = off. Pausa trading após N perdas resolvidas seguidas. */
    max_consecutive_losses: number;
    /** 0 = off. Pausa trading se P&L do dia UTC ≤ -este valor. */
    max_daily_loss_usd: number;
    /** Circuit breaker persistente sobre o P&L das operações resolvidas mais recentes. */
    rolling_pnl_guard: {
      enabled: boolean;
      window_size: number;
      min_resolved_bets: number;
      max_loss_usd: number;
    };
  };
  logging: {
    level: string;
    pretty: boolean;
  };
  server: {
    enabled: boolean;
    port: number;
    host: string;
  };
  telegram: {
    enabled: boolean;
    notify_on_start: boolean;
    notify_on_market: boolean;
    notify_on_bet: boolean;
    notify_on_skip: boolean;
    notify_on_error: boolean;
    notify_on_stop: boolean;
    notify_on_pnl: boolean;
    silent: boolean;
  };
  pnl: {
    enabled: boolean;
    storage_path: string;
    resolution_delay_seconds: number;
    resolution_poll_ms: number;
    resolution_max_wait_seconds: number;
  };
}

export interface EnvSecrets {
  privateKey: string;
  depositWalletAddress: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export interface DiscoveredMarket {
  eventId: string;
  marketId: string;
  slug: string;
  title: string;
  windowStartUnix: number;
  windowEndUnix: number;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  outcomes: string[];
  tickSize: string;
  negRisk: boolean;
  minOrderSize: number;
  acceptingOrders: boolean;
  closed: boolean;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  /** Asks ordenados por preço ascendente (melhor ask primeiro) */
  asks: OrderBookLevel[];
  /** Bids ordenados por preço descendente (melhor bid primeiro) */
  bids: OrderBookLevel[];
}

export type ShadowLiquidityReason =
  | "fillable"
  | "empty_book"
  | "quote_above_cap"
  | "insufficient_depth";

export interface ShadowLiquidityLevel {
  offsetCents: number;
  maxPrice: number;
  bestAsk: number | null;
  availableDepthShares: number;
  availableDepthUsd: number;
  fillableShares: number;
  fillableCostUsd: number;
  averagePrice: number | null;
  estimatedFeesUsd: number;
  feeAwareBreakEvenProbability: number | null;
  fullyFillable: boolean;
  reason: ShadowLiquidityReason;
}

export interface ShadowExecutionCurve {
  configuredMaxPrice: number;
  globalMaxPrice: number;
  desiredShares: number;
  levels: ShadowLiquidityLevel[];
}

export interface ShadowStrategyEvaluation {
  name: string;
  mode: StrategyMode;
  observedAt: string;
  entrySecondsBeforeClose: number | null;
  side: "up" | "down" | null;
  reason: string;
  configuredMaxPrice: number;
  intendedShares: number;
  bestAsk: number | null;
  fullyFillable: boolean;
  fillableShares: number;
  fillableCostUsd: number;
  averagePrice: number | null;
  estimatedFeesUsd: number;
  feeAwareBreakEvenProbability: number | null;
  liquidityReason: ShadowLiquidityReason | "no_signal" | "maker_quote";
  executionStyle?: "taker" | "maker";
  quotePrice?: number | null;
  resolved?: boolean;
  winner?: "up" | "down";
  won?: boolean;
  hypotheticalPayoutUsd?: number;
  hypotheticalPnlUsd?: number;
  signal?: {
    deltaBps?: number;
    upMid?: number;
    downMid?: number;
    shortReturnBps?: number;
    mediumReturnBps?: number;
    longReturnBps?: number;
    score?: number;
    estimatedProbability?: number;
    estimatedEdge?: number;
    votesUp?: number;
    votesDown?: number;
  };
}

export type ExecutionResultCategory =
  | "filled"
  | "unfilled"
  | "invalid_format"
  | "no_liquidity"
  | "auth_or_wallet"
  | "rate_limited"
  | "market_unavailable"
  | "network_or_api"
  | "clob_rejected";

/** Telemetria sanitizada que correlaciona o book observado com a submissão CLOB. */
export interface ExecutionCorrelationTrace {
  snapshotObservedAt: string;
  snapshotAgeMsAtSubmit: number;
  entrySecondsBeforeClose: number | null;
  orderKind: "market" | "limit";
  orderType: OrderTypeName;
  configuredMaxPrice: number;
  bestAsk: number | null;
  askLevels: number;
  shadowReason: ShadowLiquidityReason | null;
  shadowFullyFillable: boolean | null;
  intendedPrice: number;
  intendedShares: number;
  intendedCostUsd: number;
  quantizedAmountUsd: string;
  quantizedPrice: string;
  quantizedShares: string;
  signedAmountUsd?: string;
  makerAmountBaseUnits?: string;
  takerAmountBaseUnits?: string;
  precisionValid?: boolean;
  precisionAttempts?: number;
  submissionElapsedMs: number;
  httpStatus?: number;
  clobCode?: string;
  clobStatus?: string;
  resultCategory: ExecutionResultCategory;
  reasonCode: string;
}

export interface BetResult {
  success: boolean;
  paper: boolean;
  marketSlug: string;
  side: "up" | "down" | null;
  tokenId: string | null;
  price: number;
  size: number;
  orderId?: string;
  status?: string;
  error?: string;
  skipped?: boolean;
  submitted?: boolean;
  filledSize?: number;
  filledCost?: number;
  platformFee?: number;
  totalCost?: number;
  clobDetail?: string;
  strategyReason?: string;
  shadowLiquidity?: ShadowExecutionCurve;
  shadowStrategies?: ShadowStrategyEvaluation[];
  executionCorrelation?: ExecutionCorrelationTrace;
  signal?: {
    openPrice?: number;
    currentPrice?: number;
    deltaBps?: number;
    upMid?: number;
    downMid?: number;
  };
  timestamp: string;
}

/** skipped=ignorada | failed=erro | unfilled=ordem sem compra | filled=comprada | paper=simulada */
export type BetOutcome = "skipped" | "failed" | "unfilled" | "filled" | "paper" | "placed";

export interface BetAttemptRecord {
  attemptedAt: string;
  outcome: BetOutcome;
  entrySecondsBeforeClose: number | null;
  side: "up" | "down" | null;
  price: number;
  size: number;
  filledSize?: number;
  filledCost?: number;
  platformFee?: number;
  totalCost?: number;
  submitted?: boolean;
  strategyReason?: string;
  error?: string;
  shadowLiquidity?: ShadowExecutionCurve;
  shadowStrategies?: ShadowStrategyEvaluation[];
  executionCorrelation?: ExecutionCorrelationTrace;
}

export interface BetRecord {
  id: string;
  marketSlug: string;
  title: string;
  side: "up" | "down" | null;
  price: number;
  size: number;
  cost: number;
  filledSize?: number;
  filledCost?: number;
  platformFee?: number;
  totalCost?: number;
  orderId?: string;
  orderStatus?: string;
  clobDetail?: string;
  paper: boolean;
  placedAt: string;
  windowStartUnix: number;
  windowEndUnix: number;
  strategyReason?: string;
  attemptHistory?: BetAttemptRecord[];
  outcome: BetOutcome;
  error?: string;
  resolved: boolean;
  winner?: "up" | "down";
  won?: boolean;
  pnl?: number;
  payout?: number;
  resolutionSource?: "gamma" | "chainlink";
  resolveOpenPrice?: number;
  resolveClosePrice?: number;
  resolvedAt?: string;
  shadowResolved?: boolean;
  shadowWinner?: "up" | "down";
  shadowResolvedAt?: string;
}

export interface PnlSummary {
  totalBets: number;
  failed: number;
  skipped: number;
  unfilled: number;
  historyTotal: number;
  resolved: number;
  pending: number;
  wins: number;
  losses: number;
  totalCost: number;
  totalFees: number;
  totalPnl: number;
  winRate: number;
  lastResolved: BetRecord | null;
}

export interface BotState {
  status: "idle" | "discovering" | "waiting" | "executing" | "done" | "error" | "paused";
  currentSlug: string | null;
  nextBetAt: string | null;
  betsPlaced: number;
  totalUsdSpent: number;
  lastBet: BetResult | null;
  lastError: string | null;
  startedAt: string;
  pnl: PnlSummary;
  /** false = pausado pelo dashboard; não coloca apostas */
  tradingActive: boolean;
}

