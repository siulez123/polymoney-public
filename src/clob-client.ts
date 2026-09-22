import {
  ClobClient,
  OrderType,
  Side,
  type ApiKeyCreds,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { AppConfig, EnvSecrets } from "./types.js";
import type { Logger } from "./logger.js";

let clientInstance: ClobClient | null = null;

export function resetClobClient(): void {
  clientInstance = null;
}

const DEPOSIT_WALLET_SIG_TYPE = 3;

function envApiCreds(secrets: EnvSecrets): ApiKeyCreds | null {
  if (secrets.apiKey && secrets.apiSecret && secrets.apiPassphrase) {
    return {
      key: secrets.apiKey,
      secret: secrets.apiSecret,
      passphrase: secrets.apiPassphrase,
    };
  }
  return null;
}

async function resolveApiCreds(
  config: AppConfig,
  secrets: EnvSecrets,
  signer: ReturnType<typeof createWalletClient>,
  log: Logger,
): Promise<ApiKeyCreds> {
  const sigType = config.trading.signature_type;
  const fromEnv = envApiCreds(secrets);

  if (fromEnv && sigType !== DEPOSIT_WALLET_SIG_TYPE) {
    log.info("Using POLY_API_* from the environment");
    return fromEnv;
  }

  if (fromEnv && sigType === DEPOSIT_WALLET_SIG_TYPE) {
    log.warn(
      "POLY_API_* ignored for signature_type=3 — npm run derive-api-key credentials are bound to the signer, not the profile",
    );
  }

  if (sigType === DEPOSIT_WALLET_SIG_TYPE) {
    const depositClient = new ClobClient({
      host: config.trading.clob_host,
      chain: config.trading.chain_id,
      signer,
      signatureType: DEPOSIT_WALLET_SIG_TYPE,
      funderAddress: secrets.depositWalletAddress,
    });
    const creds = await depositClient.createOrDeriveApiKey();
    log.info(
      { funder: secrets.depositWalletAddress },
      "API key derived for deposit wallet",
    );
    return creds;
  }

  const tempClient = new ClobClient({
    host: config.trading.clob_host,
    chain: config.trading.chain_id,
    signer,
  });
  return tempClient.createOrDeriveApiKey();
}

export async function initClobClient(
  config: AppConfig,
  secrets: EnvSecrets,
  log: Logger,
): Promise<ClobClient> {
  if (clientInstance) return clientInstance;

  const account = privateKeyToAccount(secrets.privateKey as `0x${string}`);
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(config.trading.polygon_rpc_url),
  });

  const creds = await resolveApiCreds(config, secrets, signer, log);

  const sigType = config.trading.signature_type;
  if (sigType === DEPOSIT_WALLET_SIG_TYPE) {
    log.info(
      { signer: account.address, funder: secrets.depositWalletAddress },
      "Deposit wallet mode (signature_type=3)",
    );
  } else if (sigType === 1) {
    log.info(
      { signer: account.address, funder: secrets.depositWalletAddress },
      "Proxy wallet mode (signature_type=1)",
    );
  }

  clientInstance = new ClobClient({
    host: config.trading.clob_host,
    chain: config.trading.chain_id,
    signer,
    creds,
    signatureType: config.trading.signature_type,
    funderAddress: secrets.depositWalletAddress,
  });

  return clientInstance;
}

export interface GeoblockResult {
  blocked: boolean;
  country?: string;
  region?: string;
}

export async function checkGeoblock(config: AppConfig, log: Logger): Promise<GeoblockResult> {
  if (!config.trading.geoblock_check) return { blocked: false };

  try {
    const response = await fetch("https://polymarket.com/api/geoblock");
    if (!response.ok) return { blocked: false };

    const data = (await response.json()) as {
      blocked?: boolean;
      country?: string;
      region?: string;
    };
    const result: GeoblockResult = {
      blocked: Boolean(data.blocked),
      country: data.country,
      region: data.region,
    };
    if (result.blocked) {
      const where = [result.country, result.region].filter(Boolean).join("/");
      log.warn(
        { geo: result },
        `Geoblock warning: IP may be blocked (${where}) — still attempting orders`,
      );
    } else {
      log.info({ country: result.country, region: result.region }, "Geoblock check OK");
    }
    return result;
  } catch (err) {
    log.warn({ err }, "Could not check geoblock, continuing");
    return { blocked: false };
  }
}

export function mapLimitOrderType(name: string): OrderType.GTC | OrderType.GTD {
  return name === "GTC" ? OrderType.GTC : OrderType.GTC;
}

export function mapMarketOrderType(name: string): OrderType.FOK | OrderType.FAK {
  return name === "FAK" ? OrderType.FAK : OrderType.FOK;
}

export { Side, OrderType };

export function getSignerAddress(secrets: EnvSecrets): string | null {
  if (!secrets.privateKey?.startsWith("0x")) return null;
  try {
    return privateKeyToAccount(secrets.privateKey as `0x${string}`).address;
  } catch {
    return null;
  }
}

