import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AssetType, COLLATERAL_TOKEN_DECIMALS } from "@polymarket/clob-client-v2";
import { initClobClient } from "./clob-client.js";
import type { AppConfig, EnvSecrets } from "./types.js";
import type { Logger } from "./logger.js";

export interface BalanceSnapshot {
  at: string;
  balanceUsd: number;
}

export interface AccountBalanceStatus {
  currentBalanceUsd: number | null;
  history: BalanceSnapshot[];
  lastUpdated: string | null;
  lastError: string | null;
  polling: boolean;
}

const POLL_MS = 60_000;
/** ~30 dias a 1 ponto/min, com margem */
const MAX_POINTS = 50_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_STORAGE = "./data/balance-history.json";

interface BalanceStore {
  history: BalanceSnapshot[];
  updatedAt?: string;
}

export class AccountBalanceTracker {
  private history: BalanceSnapshot[] = [];
  private currentBalanceUsd: number | null = null;
  private lastUpdated: string | null = null;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly storagePath: string;

  constructor(storagePath = DEFAULT_STORAGE) {
    this.storagePath = resolve(storagePath);
    this.load();
  }

  start(config: AppConfig, secrets: EnvSecrets, log: Logger): void {
    if (!secrets.privateKey?.startsWith("0x") || !secrets.depositWalletAddress) {
      log.info("Saldo Polymarket: sem credenciais — gráfico desativado");
      return;
    }

    void this.poll(config, secrets, log);
    this.timer = setInterval(() => void this.poll(config, secrets, log), POLL_MS);
    log.info(
      { intervalSec: POLL_MS / 1000, historyPoints: this.history.length, path: this.storagePath },
      "A monitorizar saldo USDC da conta Polymarket",
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(): AccountBalanceStatus {
    return {
      currentBalanceUsd: this.currentBalanceUsd,
      history: [...this.history],
      lastUpdated: this.lastUpdated,
      lastError: this.lastError,
      polling: this.timer !== null,
    };
  }

  getCurrentBalanceUsd(): number | null {
    return this.currentBalanceUsd;
  }

  /** Refresh imediato do saldo CLOB (ex.: sizing all-in antes da ordem). */
  async refreshNow(config: AppConfig, secrets: EnvSecrets, log: Logger): Promise<number | null> {
    const deadline = Date.now() + 5_000;
    while (this.polling && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await this.poll(config, secrets, log);
    return this.currentBalanceUsd;
  }

  private async poll(config: AppConfig, secrets: EnvSecrets, log: Logger): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const client = await initClobClient(config, secrets, log);
      const resp = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const raw = Number.parseInt(resp.balance ?? "0", 10);
      if (!Number.isFinite(raw)) {
        throw new Error("Resposta de saldo inválida");
      }
      const balanceUsd = raw / 10 ** COLLATERAL_TOKEN_DECIMALS;
      const at = new Date().toISOString();

      this.currentBalanceUsd = balanceUsd;
      this.lastUpdated = at;
      this.lastError = null;

      const last = this.history[this.history.length - 1];
      if (!last || last.balanceUsd !== balanceUsd || Date.now() - new Date(last.at).getTime() >= POLL_MS - 5000) {
        this.history.push({ at, balanceUsd });
        this.trimHistory();
        this.save();
      }

      log.debug({ balanceUsd: balanceUsd.toFixed(2) }, "Saldo Polymarket atualizado");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      log.warn({ err: message }, "Falha ao obter saldo Polymarket");
    } finally {
      this.polling = false;
    }
  }

  private trimHistory(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    this.history = this.history.filter((p) => new Date(p.at).getTime() >= cutoff);
    if (this.history.length > MAX_POINTS) {
      this.history = this.history.slice(-MAX_POINTS);
    }
  }

  private load(): void {
    if (!existsSync(this.storagePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.storagePath, "utf8")) as BalanceStore;
      this.history = Array.isArray(data.history) ? data.history : [];
      this.trimHistory();
      const last = this.history[this.history.length - 1];
      if (last) {
        this.currentBalanceUsd = last.balanceUsd;
        this.lastUpdated = last.at;
      }
    } catch {
      this.history = [];
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true });
      const payload: BalanceStore = {
        history: this.history,
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(this.storagePath, JSON.stringify(payload));
    } catch {
      // não bloquear o bot se o disco falhar
    }
  }
}

