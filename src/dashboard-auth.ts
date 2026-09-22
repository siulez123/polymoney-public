import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export function getDashboardToken(): string | undefined {
  const token = process.env.DASHBOARD_TOKEN?.trim();
  return token || undefined;
}

export function isDashboardAuthEnabled(): boolean {
  return Boolean(getDashboardToken());
}

function extractQueryToken(url: string | undefined): string | null {
  if (!url) return null;
  const q = url.indexOf("?");
  if (q === -1) return null;
  return new URLSearchParams(url.slice(q)).get("token");
}

function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7);
}

function tokensMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

function extractCookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "pm_dashboard_token") {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return rest.join("=");
      }
    }
  }
  return null;
}

export function isDashboardAuthorized(req: IncomingMessage): boolean {
  const expected = getDashboardToken();
  if (!expected) return true;

  const provided =
    extractQueryToken(req.url)
    ?? extractBearerToken(req)
    ?? extractCookieToken(req)
    ?? "";
  return tokensMatch(provided, expected);
}

/** Cookie para PWA / ecrã inicial sem ?token= em cada pedido. */
export function dashboardAuthCookieHeader(token: string): string {
  return (
    `pm_dashboard_token=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; SameSite=Lax`
  );
}

export function sendDashboardUnauthorized(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Polymoney — Acesso negado</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0b0f14; color: #e8eef5; padding: 2rem; max-width: 32rem; margin: 0 auto; }
    h1 { font-size: 1.25rem; margin-bottom: 0.75rem; }
    p { color: #8b9cb3; line-height: 1.6; }
    code { background: #121820; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Acesso negado</h1>
  <p>O dashboard requer um token. Abre o link com <code>?token=...</code> no URL.</p>
  <p>Exemplo: <code>/pnl?token=SEU_TOKEN</code></p>
</body>
</html>`);
}

export function sendDashboardUnauthorizedJson(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
}

