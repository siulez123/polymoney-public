import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  AppConfig,
  BetAttemptRecord,
  BetOutcome,
  BetRecord,
  BetResult,
  DiscoveredMarket,
  PnlSummary,
} from "./types.js";
import type { Logger } from "./logger.js";
import type { PriceFeed } from "./price-feed.js";
import { resolveFromGamma, waitForResolution } from "./resolution.js";
import type { StakingManager } from "./staking.js";

export function betOutcome(record: BetRecord): BetOutcome {
  if (record.outcome === "placed") return "filled";
  return record.outcome ?? "filled";
}

export function isFilledOutcome(outcome: BetOutcome): boolean {
  return outcome === "filled" || outcome === "placed";
}

/** Bets included in P&L (live or simulated paper). */
export function isActionableBet(outcome: BetOutcome): boolean {
  return isFilledOutcome(outcome) || outcome === "paper";
}

function outcomeFromResult(result: BetResult): BetOutcome {
  if (result.skipped) return "skipped";
  if (result.paper) return "paper";
  if (result.success && (result.filledSize ?? 0) > 0) return "filled";
  if (result.submitted) return "unfilled";
  return "failed";
}

const ENTRY_WINDOW_RE = /(?:^|\s)T-(\d+)(?=:|\s|$)/i;

export function buildAttemptSnapshot(result: BetResult): BetAttemptRecord {
  const match = ENTRY_WINDOW_RE.exec(result.strategyReason ?? "");
  return {
    attemptedAt: result.timestamp,
    outcome: outcomeFromResult(result),
    entrySecondsBeforeClose: match ? Number(match[1]) : null,
    side: result.side,
    price: result.price,
    size: result.size,
    filledSize: result.filledSize,
    filledCost: result.filledCost,
    platformFee: result.platformFee,
    totalCost: result.totalCost,
    submitted: result.submitted,
    strategyReason: result.strategyReason,
    error: result.error,
    shadowLiquidity: result.shadowLiquidity,
    shadowStrategies: result.shadowStrategies,
    executionCorrelation: result.executionCorrelation,
  };
}

export function computeBetPnl(side: "up" | "down", winner: "up" | "down", cost: number, size: number, fee = 0): {
  won: boolean;
  payout: number;
  pnl: number;
} {
  const won = side === winner;
  const payout = won ? size : 0;
  const pnl = payout - cost - fee;
  return { won, payout, pnl };
}

export function applyShadowResolution(record: BetRecord, winner: "up" | "down"): boolean {
  let changed = false;
  for (const attempt of record.attemptHistory ?? []) {
    for (const evaluation of attempt.shadowStrategies ?? []) {
      if (evaluation.resolved) continue;
      evaluation.resolved = true;
      evaluation.winner = winner;
      if (evaluation.side !== null) {
        evaluation.won = evaluation.side === winner;
        if (evaluation.executionStyle !== "maker" && evaluation.fullyFillable) {
          evaluation.hypotheticalPayoutUsd = evaluation.won ? evaluation.intendedShares : 0;
          evaluation.hypotheticalPnlUsd = Number((
            evaluation.hypotheticalPayoutUsd
            - evaluation.fillableCostUsd
            - evaluation.estimatedFeesUsd
          ).toFixed(6));
        }
      }
      changed = true;
    }
  }
  if (changed) {
    record.shadowResolved = true;
    record.shadowWinner = winner;
    record.shadowResolvedAt = new Date().toISOString();
  }
  return changed;
}

interface PnlStore {
  bets: BetRecord[];
}

/**
 * Replace a JSON file atomically so readers never observe the truncate/write
 * window created by writeFileSync on the destination itself.
 */
export function writeJsonAtomically(path: string, value: unknown): void {
  const payload = JSON.stringify(value, null, 2);
  const directory = dirname(path);
  const tempPath = `${path}.${process.pid}.tmp`;
  mkdirSync(directory, { recursive: true });

  try {
    writeFileSync(tempPath, payload);
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

export function buildSummary(bets: BetRecord[]): PnlSummary {
  const actionable = bets.filter((b) => isActionableBet(betOutcome(b)));
  const failed = bets.filter((b) => betOutcome(b) === "failed");
  const skipped = bets.filter((b) => betOutcome(b) === "skipped");
  const unfilled = bets.filter((b) => betOutcome(b) === "unfilled");
  const resolved = actionable.filter((b) => b.resolved);
  const wins = resolved.filter((b) => b.won);
  const losses = resolved.filter((b) => b.won === false);
  const pending = actionable.filter((b) => !b.resolved);

  const totalCost = resolved.reduce((s, b) => s + (b.totalCost ?? b.cost), 0);
  const totalFees = resolved.reduce((s, b) => s + (b.platformFee ?? 0), 0);
  const totalPnl = resolved.reduce((s, b) => s + (b.pnl ?? 0), 0);

  return {
    totalBets: actionable.length,
    failed: failed.length,
    skipped: skipped.length,
    unfilled: unfilled.length,
    historyTotal: bets.length,
    resolved: resolved.length,
    pending: pending.length,
    wins: wins.length,
    losses: losses.length,
    totalCost,
    totalFees,
    totalPnl,
    winRate: resolved.length > 0 ? wins.length / resolved.length : 0,
    lastResolved: resolved.length > 0 ? resolved[resolved.length - 1]! : null,
  };
}

function buildRecordFromResult(market: DiscoveredMarket, result: BetResult): BetRecord {
  const outcome = outcomeFromResult(result);
  const simulatedFill = outcome === "filled" || outcome === "paper";
  const filledSize = result.filledSize ?? (simulatedFill ? result.size : 0);
  const filledCost = result.filledCost ?? (simulatedFill ? result.price * result.size : 0);
  const averagePrice = filledSize > 0 ? filledCost / filledSize : result.price;
  const platformFee = result.platformFee ?? (
    simulatedFill ? filledSize * 0.07 * averagePrice * (1 - averagePrice) : 0
  );
  const totalCost = result.totalCost ?? filledCost + platformFee;

  return {
    id: `${result.marketSlug}-${Date.now()}`,
    marketSlug: result.marketSlug,
    title: market.title,
    side: result.side,
    price: simulatedFill ? filledCost / Math.max(filledSize, 1) : result.price,
    size: simulatedFill ? filledSize : result.size,
    cost: simulatedFill ? filledCost : result.side ? result.price * result.size : 0,
    filledSize: filledSize > 0 ? filledSize : undefined,
    filledCost: filledCost > 0 ? filledCost : undefined,
    platformFee: platformFee > 0 ? platformFee : undefined,
    totalCost: totalCost > 0 ? totalCost : undefined,
    orderId: result.orderId,
    orderStatus: result.status,
    clobDetail: result.clobDetail,
    paper: result.paper,
    placedAt: result.timestamp,
    windowStartUnix: market.windowStartUnix,
    windowEndUnix: market.windowEndUnix,
    strategyReason: result.strategyReason,
    attemptHistory: [buildAttemptSnapshot(result)],
    outcome,
    error: result.error,
    resolved: false,
  };
}

export class PnlTracker {
  private bets: BetRecord[] = [];
  private summary: PnlSummary = buildSummary([]);

  constructor(
    private config: AppConfig,
    private log: Logger,
    private staking: StakingManager | null = null,
  ) {
    if (config.pnl.enabled) {
      this.load();
    }
  }

  getSummary(): PnlSummary {
    return this.summary;
  }

  getBets(): BetRecord[] {
    return [...this.bets];
  }

  private storagePath(): string {
    return resolve(this.config.pnl.storage_path);
  }

  private load(): void {
    const path = this.storagePath();
    if (!existsSync(path)) return;

    try {
      const raw = readFileSync(path, "utf8");
      const store = JSON.parse(raw) as PnlStore;
      this.bets = (store.bets ?? []).map((b) => ({
        ...b,
        outcome: b.outcome === "placed" ? "filled" : (b.outcome ?? "filled"),
      }));
      this.summary = buildSummary(this.bets);
      this.log.info(
        {
          historyTotal: this.summary.historyTotal,
          compradas: this.summary.totalBets,
          semCompra: this.summary.unfilled,
          falhadas: this.summary.failed,
          ignoradas: this.summary.skipped,
          resolved: this.summary.resolved,
          totalPnl: this.summary.totalPnl.toFixed(2),
        },
        "P&L carregado",
      );
    } catch (err) {
      this.log.warn({ err }, "Failed to load P&L, starting from zero");
    }
  }

  private save(): void {
    writeJsonAtomically(this.storagePath(), { bets: this.bets });
  }

  recordAttempt(market: DiscoveredMarket, result: BetResult): BetRecord | null {
    if (!this.config.pnl.enabled) return null;

    const record = buildRecordFromResult(market, result);
    const existingIdx = this.bets.findIndex((b) => b.marketSlug === result.marketSlug);

    if (existingIdx >= 0) {
      const existing = this.bets[existingIdx]!;
      // Multi-T: never overwrite a fill with later skipped/unfilled attempts
      if (isFilledOutcome(existing.outcome ?? "filled") && !isFilledOutcome(record.outcome)) {
        this.log.debug(
          { slug: existing.marketSlug, kept: existing.outcome, ignored: record.outcome },
          "Existing fill — later attempt ignored in history",
        );
        return existing;
      }
      const updated: BetRecord = {
        ...existing,
        ...record,
        id: existing.id,
        placedAt: record.placedAt,
        attemptHistory: [
          ...(existing.attemptHistory ?? []),
          ...(record.attemptHistory ?? []),
        ],
      };
      this.bets[existingIdx] = updated;
      this.summary = buildSummary(this.bets);
      this.save();
      this.log.info(
        { slug: updated.marketSlug, outcome: updated.outcome, orderId: updated.orderId },
        "Attempt updated in history",
      );
      return updated;
    }

    this.bets.push(record);
    this.summary = buildSummary(this.bets);
    this.save();

    this.log.info(
      {
        slug: record.marketSlug,
        outcome: record.outcome,
        side: record.side,
        cost: record.cost.toFixed(2),
        orderId: record.orderId,
        error: record.error,
      },
      "Attempt recorded in history",
    );

    return record;
  }

  /**
   * Append shadow telemetry without replacing the live market outcome.
   * The received result must always be skipped/side=null; this guard prevents regressions.
   */
  recordShadowObservation(market: DiscoveredMarket, result: BetResult): BetRecord | null {
    if (!this.config.pnl.enabled) return null;
    if (!result.skipped || result.side !== null || result.submitted) {
      throw new Error("Shadow observations cannot represent or submit an order");
    }

    const existingIdx = this.bets.findIndex((bet) => bet.marketSlug === result.marketSlug);
    if (existingIdx >= 0) {
      const existing = this.bets[existingIdx]!;
      existing.attemptHistory = [
        ...(existing.attemptHistory ?? []),
        buildAttemptSnapshot(result),
      ];
      if (existing.shadowWinner) applyShadowResolution(existing, existing.shadowWinner);
      this.save();
      this.log.info(
        { slug: existing.marketSlug, strategyReason: result.strategyReason },
        "Shadow observation appended to history",
      );
      return existing;
    }

    const record = buildRecordFromResult(market, result);
    this.bets.push(record);
    this.summary = buildSummary(this.bets);
    this.save();
    this.log.info(
      { slug: record.marketSlug, strategyReason: result.strategyReason },
      "First shadow observation recorded for market",
    );
    return record;
  }

  /** @deprecated use recordAttempt */
  recordBet(market: DiscoveredMarket, result: BetResult): BetRecord | null {
    return this.recordAttempt(market, result);
  }

  async resolveBet(
    market: DiscoveredMarket,
    result: BetResult,
    feed: PriceFeed | null,
  ): Promise<BetRecord | null> {
    if (!this.config.pnl.enabled) return null;
    if (!result.success || result.skipped || !result.side) return null;

    let record = this.bets.find((b) => b.marketSlug === result.marketSlug);
    if (!record) {
      record = this.recordAttempt(market, result) ?? undefined;
    }
    if (!record || record.resolved || !isActionableBet(betOutcome(record))) return record ?? null;

    try {
      const resolution = await waitForResolution(
        this.config,
        market.slug,
        market.windowStartUnix,
        market.windowEndUnix,
        feed,
        this.log,
      );

      this.applyOfficialResolution(record, resolution.winner, resolution.source);
      return record;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn({ slug: market.slug, err: message }, "P&L still pending (waiting for Gamma)");
      return record;
    }
  }

  /**
   * Reconcile bets: resolve pending results via Gamma and correct false Chainlink resolutions.
   * Return records whose outcome changed in this pass.
   */
  async reconcileAgainstGamma(): Promise<BetRecord[]> {
    if (!this.config.pnl.enabled) return [];

    const changed: BetRecord[] = [];
    const candidates = this.bets.filter((b) => {
      const pendingShadow = (b.attemptHistory ?? []).some((attempt) =>
        (attempt.shadowStrategies ?? []).some((evaluation) => !evaluation.resolved));
      if (pendingShadow) return true;
      if (!isActionableBet(betOutcome(b)) || !b.side) return false;
      return !b.resolved || b.resolutionSource === "chainlink";
    });

    for (const record of candidates) {
      const gamma = await resolveFromGamma(this.config, record.marketSlug);
      if (!gamma) continue;

      if (!record.resolved) {
        if (isActionableBet(betOutcome(record)) && record.side) {
          this.applyOfficialResolution(record, gamma.winner, "gamma");
          changed.push(record);
        } else if (applyShadowResolution(record, gamma.winner)) {
          this.save();
        }
        continue;
      }

      if (applyShadowResolution(record, gamma.winner)) this.save();

      if (record.winner === gamma.winner) {
        if (record.resolutionSource !== "gamma") {
          record.resolutionSource = "gamma";
          delete record.resolveOpenPrice;
          delete record.resolveClosePrice;
          this.save();
        }
        continue;
      }

      const oldWon = Boolean(record.won);
      const oldPnl = record.pnl ?? 0;
      const oldWinner = record.winner;
      this.applyOfficialResolution(record, gamma.winner, "gamma", { oldWon, oldPnl });
      changed.push(record);
      this.log.warn(
        {
          slug: record.marketSlug,
          oldWinner,
          correctedWinner: gamma.winner,
          oldPnl: oldPnl.toFixed(2),
          newPnl: (record.pnl ?? 0).toFixed(2),
        },
        "Chainlink resolution corrected by official Gamma result",
      );
    }

    return changed;
  }

  private applyOfficialResolution(
    record: BetRecord,
    winner: "up" | "down",
    source: "gamma" | "chainlink",
    previous?: { oldWon: boolean; oldPnl: number },
  ): void {
    applyShadowResolution(record, winner);
    const { won, payout, pnl } = computeBetPnl(
      record.side!, winner, record.cost, record.size, record.platformFee ?? 0,
    );

    record.resolved = true;
    record.winner = winner;
    record.won = won;
    record.payout = payout;
    record.pnl = pnl;
    record.resolutionSource = source;
    if (source === "gamma") {
      delete record.resolveOpenPrice;
      delete record.resolveClosePrice;
    }
    record.resolvedAt = new Date().toISOString();

    this.summary = buildSummary(this.bets);
    this.save();

    if (previous) {
      this.staking?.correctBetResolution(previous.oldWon, previous.oldPnl, won, pnl);
    } else {
      this.staking?.onBetResolved(won, pnl);
    }

    const emoji = won ? "✅" : "❌";
    this.log.info(
      {
        slug: record.marketSlug,
        side: record.side,
        winner,
        won,
        cost: record.cost.toFixed(2),
        payout: payout.toFixed(2),
        pnl: pnl.toFixed(2),
        totalPnl: this.summary.totalPnl.toFixed(2),
        winRate: `${(this.summary.winRate * 100).toFixed(1)}%`,
        source,
      },
      `${emoji} P&L resolvido`,
    );
  }
}

