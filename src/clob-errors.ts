/** Resposta típica do POST /order na Polymarket CLOB */
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
    return "API key ligada ao signer (EOA), não ao perfil — bug Polymarket em contas deposit wallet; ver issue #65";
  }
  if (lower.includes("maker address not allowed") || lower.includes("deposit wallet flow")) {
    return "conta deposit wallet — usa signature_type: 3 no config.yaml (não 1)";
  }
  if (lower.includes("not enough balance") || lower.includes("insufficient balance")) {
    return "saldo USDC insuficiente na conta Polymarket";
  }
  if (lower.includes("allowance")) {
    return "falta autorizar USDC para trading (allowance) — faz um trade manual uma vez no site";
  }
  if (lower.includes("min size") || lower.includes("minimum")) {
    return "tamanho da ordem abaixo do mínimo do mercado";
  }
  if (lower.includes("geoblock") || lower.includes("restricted") || lower.includes("blocked")) {
    return "região bloqueada pela Polymarket (Amsterdam/NL e EUA não funcionam — usa VPS fora da lista bloqueada)";
  }
  if (lower.includes("signature") || lower.includes("invalid")) {
    return "assinatura inválida — confirma PRIVATE_KEY e DEPOSIT_WALLET_ADDRESS (endereço do perfil)";
  }
  if (lower.includes("market not found") || lower.includes("closed")) {
    return "mercado fechado ou indisponível";
  }
  if (lower.includes("fok") || lower.includes("fill")) {
    return "ordem cancelada — não houve vendedor ao preço pedido";
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
        message: `Polymarket: ordem ${orderType} cancelada — ninguém vendeu ao preço pedido`,
        detail,
      };
    }
    return {
      message: `Polymarket recusou a ordem (estado: ${status})`,
      detail,
    };
  }

  if (!extractOrderId(r)) {
    if (taking === 0) {
      return {
        message: "Polymarket: sem compra — nenhuma share vendida ao teu preço neste momento",
        detail,
      };
    }
    return {
      message: `Polymarket: resposta sem ID de ordem (estado: ${status}, shares: ${taking})`,
      detail,
    };
  }

  return { message: "Polymarket: erro desconhecido ao colocar ordem", detail };
}

export function formatClobException(err: unknown): { message: string; detail: string } {
  if (err && typeof err === "object" && "data" in err) {
    const apiErr = err as { message?: string; status?: number; data?: unknown };
    const fromData = formatClobOrderFailure(apiErr.data, "?");
    if (fromData.message !== "Polymarket: erro desconhecido ao colocar ordem") {
      return fromData;
    }
    const prefix = apiErr.status ? `[HTTP ${apiErr.status}] ` : "";
    return {
      message: `${prefix}${apiErr.message ?? "Erro na API Polymarket"}`,
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
      message: `Ordem ${orderType} enviada mas sem compra — sem vendedores ao preço (estado: ${status})`,
      detail,
    };
  }

  return {
    message: `Compra parcial apenas ${taking} shares (estado: ${status})`,
    detail,
  };
}

