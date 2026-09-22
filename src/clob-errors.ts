/** Typical POST /order response from Polymarket CLOB */
export interface ClobOrderResponse {
  success?: boolean;
  errorMsg?: string;
  orderID?: string;
  orderId?: string;
  id?: string;
  status?: string;
  takingAmount?: string;
  makingAmount?: string;
  tradeIDs?: string[];
  error?: string | Record<string, unknown>;
  statusCode?: number;
}

export function extractOrderId(response: ClobOrderResponse): string | undefined {
  for (const key of ["orderID", "orderId", "id"] as const) {
    const value = response[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function safeJson(obj: unknown, maxLen = 400): string {
  try {
    const s = JSON.stringify(obj);
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch {
    return String(obj);
  }
}

function translateErrorMsg(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("order signer address") || lower.includes("address of the api key")) {
    return "API key bound to signer (EOA), not the profile — Polymarket deposit wallet bug; see issue #65";
  }
  if (lower.includes("maker address not allowed") || lower.includes("deposit wallet flow")) {
    return "deposit wallet account — use signature_type: 3 in config.yaml (not 1)";
  }
  if (lower.includes("not enough balance") || lower.includes("insufficient balance")) {
    return "insufficient USDC balance in the Polymarket account";
  }
  if (lower.includes("allowance")) {
    return "USDC trading allowance required — authorize trading on the website";
  }
  if (lower.includes("min size") || lower.includes("minimum")) {
    return "order size below the market minimum";
  }
  if (lower.includes("geoblock") || lower.includes("restricted") || lower.includes("blocked")) {
    return "region blocked by Polymarket — trading is unavailable in restricted jurisdictions";
  }
  if (lower.includes("signature") || lower.includes("invalid")) {
    return "invalid signature — verify PRIVATE_KEY and DEPOSIT_WALLET_ADDRESS (profile address)";
  }
  if (lower.includes("market not found") || lower.includes("closed")) {
    return "market closed or unavailable";
  }
  if (lower.includes("fok") || lower.includes("fill")) {
    return "order cancelled — no seller at the requested price";
  }
  return msg;
}

export function formatClobOrderFailure(
  response: unknown,
  orderType: string,
): { message: string; detail: string } {
  const r = (response && typeof response === "object" ? response : {}) as ClobOrderResponse;
  const detail = safeJson(r);
  const status = r.status ?? "—";
  const taking = parseFloat(r.takingAmount ?? "0");
  const making = parseFloat(r.makingAmount ?? "0");

  if (typeof r.error === "string" && r.error.trim()) {
    return { message: `Polymarket: ${translateErrorMsg(r.error)}`, detail };
  }

  if (r.error && typeof r.error === "object") {
    const errText = safeJson(r.error, 200);
    return { message: `Polymarket: ${errText}`, detail };
  }

  const errorMsg = (r.errorMsg ?? "").trim();
  if (errorMsg) {
    return { message: `Polymarket: ${translateErrorMsg(errorMsg)}`, detail };
  }

  if (r.success === false) {
    if (taking === 0 && (orderType === "FAK" || orderType === "FOK")) {
      return {
        message: `Polymarket: order ${orderType} cancelled — nobody sold at the requested price`,
        detail,
      };
    }
    return {
      message: `Polymarket rejected the order (status: ${status})`,
      detail,
    };
  }

  if (!extractOrderId(r)) {
    if (taking === 0) {
      return {
        message: "Polymarket: no purchase — no shares sold at your price at this time",
        detail,
      };
    }
    return {
      message: `Polymarket: response without an order ID (status: ${status}, shares: ${taking})`,
      detail,
    };
  }

  return { message: "Polymarket: unknown error placing order", detail };
}

export function formatClobException(err: unknown): { message: string; detail: string } {
  if (err && typeof err === "object" && "data" in err) {
    const apiErr = err as { message?: string; status?: number; data?: unknown };
    const fromData = formatClobOrderFailure(apiErr.data, "?");
    if (fromData.message !== "Polymarket: unknown error placing order") {
      return fromData;
    }
    const prefix = apiErr.status ? `[HTTP ${apiErr.status}] ` : "";
    return {
      message: `${prefix}${apiErr.message ?? "Polymarket API error"}`,
      detail: safeJson(apiErr.data ?? err),
    };
  }

  const text = err instanceof Error ? err.message : String(err);
  return { message: translateErrorMsg(text), detail: text };
}

export function formatUnfilledMessage(
  orderType: string,
  status: string,
  response: ClobOrderResponse,
): { message: string; detail: string } {
  const detail = safeJson(response);
  const taking = parseFloat(response.takingAmount ?? "0");

  if (taking === 0) {
    return {
      message: `Order ${orderType} submitted but unfilled — no sellers at the price (status: ${status})`,
      detail,
    };
  }

  return {
    message: `Partial purchase only ${taking} shares (status: ${status})`,
    detail,
  };
}

