import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  computeStakeConfidence,
  type ConfidenceInput,
  type ConfidenceResult,
} from "./confidence.js";
import type { AppConfig, DiscoveredMarket } from "./types.js";
import type { Logger } from "./logger.js";

interface StakingStore {
  seriesBankroll?: number;
  pendingRecoveryUsd?: number;
  updatedAt: string;
}

export type StakingMode = "fixed" | "paroli" | "all_in";

export interface StakingStatus {
  mode: StakingMode;
  seriesBankroll: number;
  pendingRecoveryUsd: number;
  nextStakeUsd: number;
  baseUsd: number;
  maxStakeUsd: number;
  reinvestFraction: number;
  recoveryCapEnabled: boolean;
  recoveryMaxStakeUsd: number;
  recoveryAssumedPrice: number;
  confidenceEnabled: boolean;
}

export class StakingManager {
  private seriesBankroll = 0;
  private pendingRecoveryUsd = 0;
  private getBalanceUsd: (() => number | null) | null = null;

  constructor(
    private config: AppConfig,
    private log: Logger,
  ) {
    if (this.needsPersistence()) {
      this.load();
    }
  }

  /** Liga o saldo live (obrigatório para mode all_in). */
  setBalanceProvider(getBalanceUsd: () => number | null): void {
    this.getBalanceUsd = getBalanceUsd;
  }

  /** Zera banca série + recovery pendente e persiste. */
  resetBankroll(): void {
    this.seriesBankroll = 0;
    this.pendingRecoveryUsd = 0;
    if (this.needsPersistence()) {
      this.save();
    }
    this.log.info(
      {
        seriesBankroll: "0.00",
        pendingRecoveryUsd: "0.00",
        nextStakeUsd: this.getNextStakeUsd().toFixed(2),
      },
      "Banca staking zerada",
    );
  }

  getStatus(): StakingStatus {
    const { recovery_cap, confidence } = this.config.staking;
    return {
      mode: this.config.staking.mode,
      seriesBankroll: this.seriesBankroll,
      pendingRecoveryUsd: this.pendingRecoveryUsd,
      nextStakeUsd: this.getNextStakeUsd(),
      baseUsd: this.config.staking.base_usd,
      maxStakeUsd: this.config.staking.max_stake_usd,
      reinvestFraction: this.config.staking.reinvest_fraction,
      recoveryCapEnabled: recovery_cap.enabled,
      recoveryMaxStakeUsd: recovery_cap.max_stake_usd,
      recoveryAssumedPrice: this.recoveryAssumedPrice(),
      confidenceEnabled: confidence.enabled,
    };
  }

  /** Stake bruto (paroli/recovery) sem confidence — útil para UI. */
  getNextStakeUsd(): number {
    return this.getRawStakeUsd();
  }

  /**
   * Stake final em USD após confidence (paroli e recovery escalados).
   */
  getStakeUsdForSignal(input: ConfidenceInput = {}): {
    stakeUsd: number;
    rawStakeUsd: number;
    confidence: ConfidenceResult;
  } {
    const rawStakeUsd = this.getRawStakeUsd();
    const { base_usd, max_stake_usd, mode } = this.config.staking;

    if (mode === "all_in") {
      const confidence = computeStakeConfidence(this.config, {
        ...input,
        // all-in: sem redução por confidence
      });
      // Forçar 100% do saldo (confidence ignorada no sizing)
      return {
        stakeUsd: rawStakeUsd,
        rawStakeUsd,
        confidence: {
          ...confidence,
          confidence: 1,
          deltaFactor: 1,
          priceFactor: 1,
        },
      };
    }

    const confidence = computeStakeConfidence(this.config, input);
    let stakeUsd = rawStakeUsd * confidence.confidence;
    stakeUsd = Math.max(base_usd, stakeUsd);
    if (max_stake_usd > 0) {
      stakeUsd = Math.min(stakeUsd, max_stake_usd);
    }
    if (this.config.safety.max_order_usd > 0) {
      stakeUsd = Math.min(stakeUsd, this.config.safety.max_order_usd);
    }

    return { stakeUsd, rawStakeUsd, confidence };
  }

  computeBetShares(
    price: number,
    market: DiscoveredMarket,
    input: ConfidenceInput = {},
  ): { shares: number; stakeUsd: number; rawStakeUsd: number; confidence: ConfidenceResult } {
    const minSize = Math.max(market.minOrderSize, this.config.safety.min_order_size);
    const usesUsdSizing =
      this.config.staking.mode === "paroli"
      || this.config.staking.mode === "all_in"
      || (this.config.staking.recovery_cap.enabled && this.pendingRecoveryUsd > 0);

    if (!usesUsdSizing) {
      const shares = Math.max(this.config.bet.size_shares, minSize);
      const confidence = computeStakeConfidence(this.config, { ...input, price });
      return {
        shares,
        stakeUsd: price * shares,
        rawStakeUsd: price * shares,
        confidence,
      };
    }

    const sized = this.getStakeUsdForSignal({ ...input, price });
    let shares = Math.floor((sized.stakeUsd / price) * 100) / 100;

    if (this.config.staking.mode !== "all_in" && this.config.safety.max_order_usd > 0) {
      const maxShares = Math.floor((this.config.safety.max_order_usd / price) * 100) / 100;
      if (shares > maxShares) shares = maxShares;
    }

    shares = Math.max(shares, minSize);
    return {
      shares,
      stakeUsd: sized.stakeUsd,
      rawStakeUsd: sized.rawStakeUsd,
      confidence: sized.confidence,
    };
  }

  onBetResolved(won: boolean, pnl: number): void {
    const changed = this.applyResolution(won, pnl);
    if (!changed) return;
    this.saveAndLog(won, pnl, "Banca staking atualizada");
  }

  /** Corrige staking quando uma resolução anterior estava errada (ex.: Chainlink vs Gamma). */
  correctBetResolution(oldWon: boolean, oldPnl: number, newWon: boolean, newPnl: number): void {
    this.reverseResolution(oldWon, oldPnl);
    this.applyResolution(newWon, newPnl);
    this.saveAndLog(newWon, newPnl, "Banca staking corrigida após reconciliação Gamma");
  }

  private reverseResolution(won: boolean, pnl: number): void {
    const { mode, recovery_cap, reinvest_fraction } = this.config.staking;

    if (mode === "paroli" && won && pnl > 0) {
      this.seriesBankroll = Math.max(0, this.seriesBankroll - pnl * reinvest_fraction);
    }

    if (recovery_cap.enabled) {
      if (won && pnl > 0) {
        this.pendingRecoveryUsd += pnl;
      } else if (!won && pnl < 0) {
        this.pendingRecoveryUsd = Math.max(0, this.pendingRecoveryUsd - Math.abs(pnl));
      }
    }
  }

  private applyResolution(won: boolean, pnl: number): boolean {
    const { mode, recovery_cap } = this.config.staking;
    let changed = false;

    // all_in: stake = saldo live; não acumula banca série
    if (mode === "paroli") {
      if (won && pnl > 0) {
        this.seriesBankroll += pnl * this.config.staking.reinvest_fraction;
        changed = true;
      } else if (!won && this.config.staking.reset_on_loss) {
        this.seriesBankroll = 0;
        changed = true;
      }
    }

    if (recovery_cap.enabled) {
      if (!won && pnl < 0) {
        this.pendingRecoveryUsd += Math.abs(pnl);
        changed = true;
      } else if (won && pnl > 0 && this.pendingRecoveryUsd > 0) {
        this.pendingRecoveryUsd = Math.max(0, this.pendingRecoveryUsd - pnl);
        changed = true;
      }
    }

    return changed;
  }

  private saveAndLog(won: boolean, pnl: number, message: string): void {
    this.save();
    this.log.info(
      {
        won,
        pnl: pnl.toFixed(2),
        mode: this.config.staking.mode,
        seriesBankroll: this.seriesBankroll.toFixed(2),
        pendingRecoveryUsd: this.pendingRecoveryUsd.toFixed(2),
        nextStakeUsd: this.getNextStakeUsd().toFixed(2),
        recoveryCapEnabled: this.config.staking.recovery_cap.enabled,
        confidenceEnabled: this.config.staking.confidence.enabled,
      },
      message,
    );
  }

  private getRawStakeUsd(): number {
    if (this.config.staking.mode === "all_in") {
      return this.getModeStakeUsd();
    }
    const modeStake = this.getModeStakeUsd();
    if (!this.config.staking.recovery_cap.enabled || this.pendingRecoveryUsd <= 0) {
      return modeStake;
    }
    return Math.max(modeStake, this.getRecoveryStakeUsd());
  }

  private getModeStakeUsd(): number {
    const { mode, base_usd, max_stake_usd } = this.config.staking;

    if (mode === "all_in") {
      const bal = this.getBalanceUsd?.() ?? null;
      if (bal === null || !Number.isFinite(bal) || bal <= 0) {
        this.log.warn(
          { base_usd },
          "all_in: saldo indisponível — a usar base_usd",
        );
        return base_usd;
      }
      // CLOB exige order + fee estimate ≤ balance (ex.: fee ~0.9%).
      // Reserva 1.5% para a fee; senão all-in a 100% falha com "not enough balance".
      const feeReserve = 0.015;
      const usable = bal / (1 + feeReserve);
      return Math.floor(usable * 100) / 100;
    }

    if (mode === "paroli") {
      let stake = base_usd + this.seriesBankroll;
      if (max_stake_usd > 0) {
        stake = Math.min(stake, max_stake_usd);
      }
      return stake;
    }

    return base_usd;
  }

  private getRecoveryStakeUsd(): number {
    const { base_usd, recovery_cap } = this.config.staking;
    if (this.pendingRecoveryUsd <= 0) return base_usd;

    const assumedPrice = this.recoveryAssumedPrice();
    const margin = 1 - assumedPrice;
    if (margin <= 0) return base_usd;

    const rawRecovery = this.pendingRecoveryUsd * (assumedPrice / margin);
    let stake = Math.max(base_usd, rawRecovery);
    if (recovery_cap.max_stake_usd > 0) {
      stake = Math.min(stake, recovery_cap.max_stake_usd);
    }
    return stake;
  }

  private recoveryAssumedPrice(): number {
    const configured = this.config.staking.recovery_cap.assumed_price;
    if (configured > 0) return configured;
    return this.config.bet.max_price;
  }

  private needsPersistence(): boolean {
    return (
      this.config.staking.mode === "paroli"
      || this.config.staking.mode === "all_in"
      || this.config.staking.recovery_cap.enabled
    );
  }

  private storagePath(): string {
    return resolve(this.config.staking.storage_path);
  }

  private load(): void {
    const path = this.storagePath();
    if (!existsSync(path)) return;

    try {
      const raw = readFileSync(path, "utf8");
      const data = JSON.parse(raw) as StakingStore;
      this.seriesBankroll = Math.max(0, data.seriesBankroll ?? 0);
      this.pendingRecoveryUsd = Math.max(0, data.pendingRecoveryUsd ?? 0);
      this.log.info(
        {
          mode: this.config.staking.mode,
          seriesBankroll: this.seriesBankroll.toFixed(2),
          pendingRecoveryUsd: this.pendingRecoveryUsd.toFixed(2),
          path,
        },
        "Banca staking carregada",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: message, path }, "Falha ao carregar banca staking");
    }
  }

  private save(): void {
    const path = this.storagePath();
    const data: StakingStore = {
      seriesBankroll: this.seriesBankroll,
      pendingRecoveryUsd: this.pendingRecoveryUsd,
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
  }
}

