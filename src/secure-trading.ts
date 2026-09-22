import {
  createSecureClient,
  OrderSide,
  OrderType,
} from "@polymarket/client";
import { privateKey } from "@polymarket/client/viem";
import { quantizeLimitBuy, quantizeMarketBuy } from "./clob-amounts.js";
import {
  CLOB_MIN_MARKET_BUY_USD,
  descendingCentCandidates,
  validateSignedBuyPrecision,
} from "./signed-order-amounts.js";
import type { AppConfig, EnvSecrets, ExecutionResultCategory, OrderTypeName } from "./types.js";
import type { Logger } from "./logger.js";

type SecureTradingClient = Awaited<ReturnType<typeof createSecureClient>>;
type SignedMarketOrder = Awaited<ReturnType<SecureTradingClient["createMarketOrder"]>>;
type OrderResponse = Awaited<ReturnType<SecureTradingClient["postOrder"]>>;

let secureClient: SecureTradingClient | null = null;

export function resetSecureClient(): void {
  secureClient = null;
}

function mapOrderType(name: OrderTypeName): (typeof OrderType)[keyof typeof OrderType] {
  switch (name) {
    case "FOK":
      return OrderType.FOK;
    case "FAK":
      return OrderType.FAK;
    case "GTC":
    default:
      return OrderType.GTC;
  }
}

export async function initSecureClient(
  secrets: EnvSecrets,
  log: Logger,
): Promise<SecureTradingClient> {
  if (secureClient) return secureClient;

  if (!secrets.privateKey?.startsWith("0x")) {
    throw new Error("PRIVATE_KEY is required for SecureClient");
  }

  secureClient = await createSecureClient({
    signer: privateKey(secrets.privateKey),
  });

  const { signer, wallet, walletType } = secureClient.account;
  log.info(
    { signer, wallet, walletType },
    "SecureClient authenticated (deposit wallet)",
  );

  if (
    secrets.depositWalletAddress
    && secrets.depositWalletAddress.toLowerCase() !== wallet.toLowerCase()
  ) {
    log.warn(
      {
        envDeposit: secrets.depositWalletAddress,
        derivedDeposit: wallet,
      },
      "DEPOSIT_WALLET_ADDRESS in .env differs from the derived deposit wallet — using the derived wallet for trading",
    );
  }

  return secureClient;
}

export function getSecureAccountWallet(): string | null {
  return secureClient?.account.wallet ?? null;
}

export interface SecureOrderResult {
  orderId?: string;
  status?: string;
  error?: string;
  detail?: string;
  filledSize?: number;
  filledCost?: number;
  platformFee?: number;
  totalCost?: number;
  telemetry: SecureOrderTelemetry;
}

export interface SecureOrderTelemetry {
  orderKind: "market" | "limit";
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

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" ? value as UnknownRecord : undefined;
}

function redactClobText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value)
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:api[_ -]?key|token|secret|private[_ -]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/0x[a-f0-9]{40,}/gi, "[redacted_hex]")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 240) : undefined;
}

function collectClobRecords(payload: unknown): UnknownRecord[] {
  const root = asRecord(payload);
  if (!root) return [];
  const response = asRecord(root.response);
  return [root, asRecord(root.data), response, asRecord(response?.data)].filter(
    (entry): entry is UnknownRecord => entry !== undefined,
  );
}

function firstClobField(records: UnknownRecord[], fields: string[]): unknown {
  for (const record of records) {
    for (const field of fields) {
      if (record[field] !== undefined && record[field] !== null) return record[field];
    }
  }
  return undefined;
}

function allClobFields(records: UnknownRecord[], fields: string[]): unknown[] {
  return records.flatMap((record) => fields
    .map((field) => record[field])
    .filter((value) => value !== undefined && value !== null));
}

function numericStatus(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value.trim())) return Number(value);
  }
  return undefined;
}

export function sanitizeClobFailureDetail(payload: unknown): string {
  const records = collectClobRecords(payload);
  const safe: UnknownRecord = {};
  const message = redactClobText(firstClobField([...records].reverse(), ["errorMsg", "error", "reason", "detail", "message"]));
  const code = redactClobText(firstClobField(records, ["code", "errorCode"]));
  const status = redactClobText(firstClobField(records, ["status", "statusCode"]));
  if (message) safe.message = message;
  if (code) safe.code = code;
  if (status) safe.status = status;
  return JSON.stringify(safe);
}

export function classifyClobResult(message: unknown, code?: unknown, status?: unknown, payload?: unknown): {
  resultCategory: ExecutionResultCategory;
  reasonCode: string;
} {
  const records = collectClobRecords(payload);
  const nestedMessages = allClobFields(records, ["message", "errorMsg", "error", "reason", "detail"]);
  const nestedCodes = allClobFields(records, ["code", "errorCode"]);
  const nestedStatuses = allClobFields(records, ["status", "statusCode"]);
  const text = [message, code, status, ...nestedMessages, ...nestedCodes, ...nestedStatuses]
    .map(redactClobText)
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  const httpStatus = numericStatus(status, code, ...nestedStatuses, ...nestedCodes);

  if (text.includes("invalid_amount") || text.includes("invalid amount")) {
    return { resultCategory: "invalid_format", reasonCode: "invalid_amounts" };
  }
  if (text.includes("tick size") || text.includes("invalid price") || text.includes("price precision")) {
    return { resultCategory: "invalid_format", reasonCode: "invalid_tick_or_price" };
  }
  if (text.includes("precision")) {
    return { resultCategory: "invalid_format", reasonCode: "invalid_precision" };
  }
  if (text.includes("minimum order") || text.includes("minimum size") || text.includes("min size") || text.includes("minimum notional") || text.includes("below minimum") || text.includes("too small")) {
    return { resultCategory: "invalid_format", reasonCode: "below_clob_minimum" };
  }
  if (text.includes("no orders found") || text.includes("no match") || text.includes("not enough orders") || text.includes("liquidity") || text.includes("not fully filled") || text.includes("fully filled immediately")) {
    return { resultCategory: "no_liquidity", reasonCode: "fak_no_match" };
  }
  if (text.includes("balance")) {
    return { resultCategory: "auth_or_wallet", reasonCode: "insufficient_balance" };
  }
  if (text.includes("allowance")) {
    return { resultCategory: "auth_or_wallet", reasonCode: "insufficient_allowance" };
  }
  if (text.includes("unauthor") || text.includes("forbidden") || text.includes("signature") || text.includes("api key") || httpStatus === 401 || httpStatus === 403) {
    return { resultCategory: "auth_or_wallet", reasonCode: "invalid_signature_or_auth" };
  }
  if (text.includes("rate limit") || text.includes("too many request") || httpStatus === 429) {
    return { resultCategory: "rate_limited", reasonCode: "rate_limited" };
  }
  if (text.includes("market closed") || text.includes("market is closed") || text.includes("not accepting") || text.includes("inactive market")) {
    return { resultCategory: "market_unavailable", reasonCode: "market_unavailable" };
  }
  if (text.includes("timeout") || text.includes("network") || text.includes("fetch") || (httpStatus !== undefined && httpStatus >= 500)) {
    return { resultCategory: "network_or_api", reasonCode: "network_or_api_error" };
  }
  if (httpStatus === 400 || httpStatus === 409 || httpStatus === 422) {
    return { resultCategory: "clob_rejected", reasonCode: "unclassified_client_rejection" };
  }
  return { resultCategory: "clob_rejected", reasonCode: "other_clob_rejection" };
}

const MAX_SIGNED_PRECISION_ATTEMPTS = 25;

export async function placeSecureBuyOrder(
  client: SecureTradingClient,
  config: AppConfig,
  tokenId: string,
  price: number,
  size: number,
  useMarketOrder: boolean,
  log: Logger,
): Promise<SecureOrderResult> {
  const orderType = mapOrderType(config.bet.order_type);
  const market = quantizeMarketBuy(price, size);
  const limit = quantizeLimitBuy(price, size);
  const startedAt = Date.now();
  const baseTelemetry: SecureOrderTelemetry = {
    orderKind: useMarketOrder ? "market" : "limit",
    quantizedAmountUsd: market.amountUsd.toFixed(2),
    quantizedPrice: limit.price.toFixed(2),
    quantizedShares: limit.size.toFixed(4),
    submissionElapsedMs: 0,
    resultCategory: "clob_rejected",
    reasonCode: "not_submitted",
  };

  if (
    (useMarketOrder && market.amountUsd < CLOB_MIN_MARKET_BUY_USD)
    || (!useMarketOrder && limit.size < 0.0001)
  ) {
    return {
      error: "Quantized CLOB amount fell below the minimum",
      detail: JSON.stringify({ price, size, market, limit }),
      telemetry: {
        ...baseTelemetry,
        submissionElapsedMs: Date.now() - startedAt,
        resultCategory: "invalid_format",
        reasonCode: "below_clob_minimum",
      },
    };
  }

  try {
    const marketOrderType =
      orderType === OrderType.FOK ? OrderType.FOK : OrderType.FAK;

    log.debug(
      {
        amountUsd: market.amountUsd,
        marketSize: market.size,
        limitSize: limit.size,
        limitPrice: limit.price,
        useMarketOrder,
      },
      "Order amounts (quantized for CLOB)",
    );

    let response: OrderResponse;
    if (useMarketOrder) {
      let finalPrecision: ReturnType<typeof validateSignedBuyPrecision> | null = null;
      let signedOrder: SignedMarketOrder | null = null;
      let signedAmountUsd = "";
      const candidates = descendingCentCandidates(
        market.amountUsd,
        MAX_SIGNED_PRECISION_ATTEMPTS,
        CLOB_MIN_MARKET_BUY_USD,
      );

      for (const candidate of candidates) {
        const candidateOrder = await client.createMarketOrder({
          tokenId,
          side: OrderSide.BUY,
          amount: candidate,
          maxSpend: candidate,
          maxPrice: market.price.toFixed(2),
          orderType: marketOrderType,
        });
        const precision = validateSignedBuyPrecision(candidateOrder);

        log.debug(
          {
            candidateAmountUsd: candidate,
            ...precision,
          },
          "Final signed order precision (sanitized)",
        );

        finalPrecision = precision;
        if (precision.valid) {
          signedOrder = candidateOrder;
          signedAmountUsd = candidate;
          break;
        }
      }

      if (!signedOrder) {
        return {
          error: "invalid_amounts_local: could not build a signed order with valid CLOB precision",
          detail: JSON.stringify({
            requestedAmountUsd: market.amountUsd.toFixed(2),
            attempts: candidates.length,
            finalPrecision,
          }),
          telemetry: {
            ...baseTelemetry,
            makerAmountBaseUnits: finalPrecision?.makerAmountBaseUnits,
            takerAmountBaseUnits: finalPrecision?.takerAmountBaseUnits,
            precisionValid: false,
            precisionAttempts: candidates.length,
            submissionElapsedMs: Date.now() - startedAt,
            resultCategory: "invalid_format",
            reasonCode: "invalid_signed_precision",
          },
        };
      }

      if (signedAmountUsd !== market.amountUsd.toFixed(2)) {
        log.info(
          {
            requestedAmountUsd: market.amountUsd.toFixed(2),
            signedAmountUsd,
            attempts: candidates.indexOf(signedAmountUsd) + 1,
          },
          "Max spend reduced to meet final CLOB precision",
        );
      }

      response = await client.postOrder(signedOrder);
      baseTelemetry.signedAmountUsd = signedAmountUsd;
      baseTelemetry.makerAmountBaseUnits = finalPrecision?.makerAmountBaseUnits;
      baseTelemetry.takerAmountBaseUnits = finalPrecision?.takerAmountBaseUnits;
      baseTelemetry.precisionValid = finalPrecision?.valid;
      baseTelemetry.precisionAttempts = candidates.indexOf(signedAmountUsd) + 1;
    } else {
      response = await client.placeLimitOrder({
        tokenId,
        side: OrderSide.BUY,
        price: limit.price.toFixed(2),
        size: limit.size.toFixed(4),
      });
    }

    log.info({ response, useMarketOrder, orderType }, "SecureClient response");

    if (!response.ok) {
      const rejectedStatus = "status" in response ? String(response.status) : undefined;
      const classified = classifyClobResult(response.message, response.code, rejectedStatus, response);
      return {
        error: response.message ?? `Order rejected (${String(response.code)})`,
        detail: sanitizeClobFailureDetail(response),
        telemetry: {
          ...baseTelemetry,
          submissionElapsedMs: Date.now() - startedAt,
          httpStatus: typeof response.code === "number" ? response.code : undefined,
          clobCode: response.code === undefined ? undefined : String(response.code),
          clobStatus: rejectedStatus,
          ...classified,
        },
      };
    }

    const filledSize = Number.parseFloat(response.takingAmount ?? "0");
    const filledCost = Number.parseFloat(response.makingAmount ?? "0");
    const averagePrice = filledSize > 0 ? filledCost / filledSize : price;
    const platformFee = useMarketOrder && filledSize > 0
      ? filledSize * 0.07 * averagePrice * (1 - averagePrice)
      : 0;
    const totalCost = filledCost + platformFee;

    return {
      orderId: response.orderId,
      status: response.status,
      detail: JSON.stringify(response),
      filledSize: Number.isFinite(filledSize) ? filledSize : 0,
      filledCost: Number.isFinite(filledCost) ? filledCost : 0,
      platformFee: Number.isFinite(platformFee) ? platformFee : 0,
      totalCost: Number.isFinite(totalCost) ? totalCost : filledCost,
      telemetry: {
        ...baseTelemetry,
        submissionElapsedMs: Date.now() - startedAt,
        clobCode: "code" in response && response.code !== undefined ? String(response.code) : undefined,
        clobStatus: response.status,
        resultCategory: filledSize > 0 ? "filled" : "unfilled",
        reasonCode: filledSize > 0 ? "filled" : "accepted_without_fill",
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, "SecureClient exception while placing order");
    const records = collectClobRecords(err);
    const code = firstClobField(records, ["code", "errorCode"]);
    const status = firstClobField(records, ["status", "statusCode"]);
    const classified = classifyClobResult(message, code, status, err);
    return {
      error: message,
      detail: sanitizeClobFailureDetail(err),
      telemetry: {
        ...baseTelemetry,
        submissionElapsedMs: Date.now() - startedAt,
        httpStatus: numericStatus(status, code),
        clobCode: redactClobText(code),
        clobStatus: redactClobText(status),
        ...classified,
      },
    };
  }
}

