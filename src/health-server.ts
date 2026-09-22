import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ZodError } from "zod";
import { updateConfigInPlace } from "./config.js";
import { getConfigSections } from "./config-meta.js";
import { parseLocale } from "./i18n/index.js";
import type { Logger } from "./logger.js";
import { publicPriceFeedStatus } from "./price-feed.js";
import { buildStatusPayload, type DashboardContext } from "./dashboard-api.js";
import { renderDashboardHtml } from "./dashboard-html.js";
import {
  DASHBOARD_ICON_SVG,
  DASHBOARD_MANIFEST,
  DASHBOARD_SERVICE_WORKER,
} from "./dashboard-pwa.js";
import {
  BADGE_LOSS_PNG_B64,
  BADGE_WIN_PNG_B64,
  ICON_APP_PNG_B64,
  ICON_LOSS_PNG_B64,
  ICON_WIN_PNG_B64,
} from "./notification-icons.js";
import { handleSseStream } from "./dashboard-sse.js";
import {
  dashboardAuthCookieHeader,
  getDashboardToken,
  isDashboardAuthEnabled,
  isDashboardAuthorized,
  sendDashboardUnauthorized,
  sendDashboardUnauthorizedJson,
} from "./dashboard-auth.js";
import { parsePushSubscription } from "./web-push.js";

function queryParam(url: string | undefined, key: string): string | null {
  if (!url) return null;
  try {
    return new URL(url, "http://local").searchParams.get(key);
  } catch {
    return null;
  }
}

function localeFromReq(req: IncomingMessage): ReturnType<typeof parseLocale> {
  return parseLocale(
    queryParam(req.url, "lang")
      ?? req.headers["accept-language"]?.split(",")[0]
      ?? null,
  );
}

function guardDashboard(req: IncomingMessage, res: ServerResponse): boolean {
  if (isDashboardAuthorized(req)) return true;
  const accept = req.headers.accept ?? "";
  if (accept.includes("application/json") || req.url?.startsWith("/api/")) {
    sendDashboardUnauthorizedJson(res);
  } else {
    sendDashboardUnauthorized(res);
  }
  return false;
}

function readBody(req: IncomingMessage, maxBytes = 64_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Body demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startHealthServer(
  ctx: DashboardContext,
  log: Logger,
): Server | null {
  const { config, state } = ctx;

  if (!config.server.enabled) return null;

  const dashboardHtml = renderDashboardHtml();
  const authEnabled = isDashboardAuthEnabled();

  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0];
    const accept = req.headers.accept ?? "";

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          status: state.status,
          tradingActive: state.tradingActive,
          uptime: process.uptime(),
          feed: ctx.feed ? publicPriceFeedStatus(ctx.feed.getStatus()) : null,
        }),
      );
      return;
    }

    // PWA assets públicos (SW precisa registar sem token)
    if (path === "/manifest.webmanifest") {
      res.writeHead(200, {
        "Content-Type": "application/manifest+json; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(DASHBOARD_MANIFEST);
      return;
    }
    if (path === "/sw.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "Service-Worker-Allowed": "/",
      });
      res.end(DASHBOARD_SERVICE_WORKER);
      return;
    }
    if (path === "/icon.svg") {
      res.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(DASHBOARD_ICON_SVG);
      return;
    }

    const pngIcons: Record<string, string> = {
      "/badge-win.png": BADGE_WIN_PNG_B64,
      "/badge-loss.png": BADGE_LOSS_PNG_B64,
      "/icon-win.png": ICON_WIN_PNG_B64,
      "/icon-loss.png": ICON_LOSS_PNG_B64,
      "/icon-app.png": ICON_APP_PNG_B64,
    };
    if (path && pngIcons[path]) {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(Buffer.from(pngIcons[path], "base64"));
      return;
    }

    if (!guardDashboard(req, res)) return;

    if (path === "/api/status" || (path === "/pnl" && accept.includes("application/json"))) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(buildStatusPayload(ctx)));
      return;
    }

    if (path === "/api/stream") {
      handleSseStream(ctx, req, res);
      return;
    }

    if (path === "/api/push/vapid-public-key" && req.method === "GET") {
      const push = ctx.webPush;
      if (!push?.isReady()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Web Push não configurado" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        publicKey: push.getPublicKey(),
        subscribers: push.getSubscriberCount(),
      }));
      return;
    }

    if (path === "/api/push/subscribe" && req.method === "POST") {
      const push = ctx.webPush;
      if (!push?.isReady()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Web Push não configurado" }));
        return;
      }
      void readBody(req)
        .then((raw) => {
          const sub = parsePushSubscription(JSON.parse(raw));
          push.subscribe(sub);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, subscribers: push.getSubscriberCount() }));
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: message }));
        });
      return;
    }

    if (path === "/api/push/unsubscribe" && req.method === "POST") {
      const push = ctx.webPush;
      if (!push?.isReady()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Web Push não configurado" }));
        return;
      }
      void readBody(req)
        .then((raw) => {
          const body = JSON.parse(raw) as { endpoint?: string };
          if (!body.endpoint) throw new Error("endpoint em falta");
          push.unsubscribe(body.endpoint);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, subscribers: push.getSubscriberCount() }));
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: message }));
        });
      return;
    }

    if (path === "/api/trading/start" && req.method === "POST") {
      const previousRisk = ctx.riskGuard?.getStatus();
      if (previousRisk?.pausedReason) {
        const cleared = ctx.riskGuard?.clearPause(true) ?? false;
        if (!cleared) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `Não foi possível limpar o RiskGuard: ${previousRisk.pausedReason}` }));
          return;
        }
      }
      state.tradingActive = true;
      state.status = "waiting";
      state.lastError = null;
      log.info(
        { clearedRiskPause: previousRisk?.pausedReason ?? null },
        "Trading retomado manualmente via dashboard",
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        tradingActive: true,
        clearedRiskPause: previousRisk?.pausedReason ?? null,
      }));
      return;
    }

    if (path === "/api/trading/stop" && req.method === "POST") {
      state.tradingActive = false;
      state.status = "paused";
      state.lastError = "Trading pausado manualmente via dashboard";
      log.info("Trading pausado via dashboard");
      void ctx.webPush?.notifySystem(
        "Polymoney pausado",
        "Trading pausado manualmente no dashboard.",
        "manual-pause",
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, tradingActive: false }));
      return;
    }

    if (path === "/api/config" && req.method === "GET") {
      try {
        const locale = localeFromReq(req);
        const body = JSON.stringify({
          ok: true,
          lang: locale,
          config: ctx.config,
          meta: { sections: getConfigSections(locale) },
        });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err: message }, "Falha GET /api/config");
        const body = JSON.stringify({ ok: false, error: message });
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(body);
      }
      return;
    }

    if (path === "/api/config" && req.method === "PUT") {
      const locale = localeFromReq(req);
      void readBody(req, 256_000)
        .then((raw) => {
          const body = JSON.parse(raw) as { config?: unknown };
          if (!body.config || typeof body.config !== "object") {
            throw new Error("Body inválido: esperado { config: {...} }");
          }
          const { requiresRestart } = updateConfigInPlace(ctx.config, body.config);
          log.info({ requiresRestart }, "Config atualizada via dashboard");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            lang: locale,
            config: ctx.config,
            requiresRestart,
            meta: { sections: getConfigSections(locale) },
          }));
        })
        .catch((err) => {
          const message = err instanceof ZodError
            ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
            : err instanceof Error ? err.message : String(err);
          log.warn({ err: message }, "Falha ao atualizar config");
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: message }));
        });
      return;
    }

    if (path === "/pnl" || path === "/") {
      const headers: Record<string, string> = {
        "Content-Type": "text/html; charset=utf-8",
      };
      const expected = getDashboardToken();
      const qToken = req.url?.includes("token=")
        ? new URL(req.url, "http://local").searchParams.get("token")
        : null;
      if (expected && qToken && qToken === expected) {
        headers["Set-Cookie"] = dashboardAuthCookieHeader(expected);
      }
      res.writeHead(200, headers);
      res.end(dashboardHtml);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not found", path }));
  });

  server.listen(config.server.port, config.server.host, () => {
    log.info(
      {
        port: config.server.port,
        host: config.server.host,
        dashboard: authEnabled ? "/pnl?token=..." : "/pnl",
        dashboardAuth: authEnabled,
      },
      "Health server ativo",
    );
    if (!authEnabled) {
      log.warn("DASHBOARD_TOKEN não definido — dashboard público");
    }
  });

  return server;
}

