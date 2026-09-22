import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppConfig, BetRecord } from "./types.js";

export interface RiskGuardStatus {
  consecutiveLosses: number;
  dailyPnlUsd: number;
  rollingPnlUsd: number;
  rollingResolvedBets: number;
  dayKey: string;
  pausedReason: string | null;
}

interface RiskStore extends RiskGuardStatus {
  recentResolvedPnls: number[];
  seenResolutionKeys: string[];
  updatedAt: string;
}

export class RiskGuard {
  private consecutiveLosses = 0;
  private dailyPnlUsd = 0;
  private recentResolvedPnls: number[] = [];
  private dayKey = utcDayKey(new Date());
  private pausedReason: string | null = null;
  private seenResolutionKeys = new Set<string>();
  private readonly path = resolve(process.env.RISK_STATE_PATH ?? "./data/risk.json");

  constructor() {
    this.load();
  }

  getStatus(): RiskGuardStatus {
    this.rollDay(new Date());
    return {
      consecutiveLosses: this.consecutiveLosses,
      dailyPnlUsd: this.dailyPnlUsd,
      rollingPnlUsd: sum(this.recentResolvedPnls),
      rollingResolvedBets: this.recentResolvedPnls.length,
      dayKey: this.dayKey,
      pausedReason: this.pausedReason,
    };
  }

  clearPause(force = false): boolean {
    if (!force && this.pausedReason) return false;
    this.pausedReason = null;
    this.consecutiveLosses = 0;
    this.recentResolvedPnls = [];
    this.save();
    return true;
  }

  onResolved(record: BetRecord, config: AppConfig, at = new Date()): string | null {
    if (!record.resolved || record.won === undefined || record.pnl === undefined) return null;
    const key = `${record.id}|${record.resolvedAt ?? ""}|${record.won}|${record.pnl}`;
    if (this.seenResolutionKeys.has(key)) return this.pausedReason;
    this.seenResolutionKeys.add(key);
    if (this.seenResolutionKeys.size > 500) {
      this.seenResolutionKeys = new Set([...this.seenResolutionKeys].slice(-300));
    }

    this.rollDay(at);
    this.dailyPnlUsd += record.pnl;
    this.consecutiveLosses = record.won ? 0 : this.consecutiveLosses + 1;

    const rollingConfig = config.safety.rolling_pnl_guard;
    const windowSize = Math.max(rollingConfig.min_resolved_bets, rollingConfig.window_size);
    this.recentResolvedPnls.push(record.pnl);
    this.recentResolvedPnls = this.recentResolvedPnls.slice(-windowSize);

    const maxLosses = config.safety.max_consecutive_losses;
    if (maxLosses > 0 && this.consecutiveLosses >= maxLosses) {
      this.pausedReason = `${this.consecutiveLosses} perdas consecutivas (limite ${maxLosses})`;
    }

    const maxDaily = config.safety.max_daily_loss_usd;
    if (!this.pausedReason && maxDaily > 0 && this.dailyPnlUsd <= -maxDaily) {
      this.pausedReason = `perda diária ${this.dailyPnlUsd.toFixed(2)} USD (limite -${maxDaily})`;
    }

    const rollingPnl = sum(this.recentResolvedPnls);
    if (
      !this.pausedReason
      && rollingConfig.enabled
      && this.recentResolvedPnls.length >= rollingConfig.min_resolved_bets
      && rollingPnl <= -rollingConfig.max_loss_usd
    ) {
      this.pausedReason = `P&L móvel ${rollingPnl.toFixed(2)} USD em ${this.recentResolvedPnls.length} operações (limite -${rollingConfig.max_loss_usd})`;
    }

    this.save();
    return this.pausedReason;
  }

  private rollDay(at: Date): void {
    const key = utcDayKey(at);
    if (key === this.dayKey) return;
    this.dayKey = key;
    this.dailyPnlUsd = 0;
    this.save();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const state = JSON.parse(readFileSync(this.path, "utf8")) as RiskStore;
      this.consecutiveLosses = Math.max(0, state.consecutiveLosses ?? 0);
      this.dailyPnlUsd = state.dailyPnlUsd ?? 0;
      this.recentResolvedPnls = Array.isArray(state.recentResolvedPnls)
        ? state.recentResolvedPnls.filter((pnl): pnl is number => Number.isFinite(pnl)).slice(-200)
        : [];
      this.dayKey = state.dayKey ?? utcDayKey(new Date());
      this.pausedReason = state.pausedReason ?? null;
      this.seenResolutionKeys = new Set(state.seenResolutionKeys ?? []);
      this.rollDay(new Date());
    } catch {
      this.pausedReason = "estado de risco inválido; revisão manual necessária";
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const state: RiskStore = {
      ...this.getStatusWithoutRoll(),
      recentResolvedPnls: this.recentResolvedPnls,
      seenResolutionKeys: [...this.seenResolutionKeys],
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this.path, JSON.stringify(state, null, 2));
  }

  private getStatusWithoutRoll(): RiskGuardStatus {
    return {
      consecutiveLosses: this.consecutiveLosses,
      dailyPnlUsd: this.dailyPnlUsd,
      rollingPnlUsd: sum(this.recentResolvedPnls),
      rollingResolvedBets: this.recentResolvedPnls.length,
      dayKey: this.dayKey,
      pausedReason: this.pausedReason,
    };
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

