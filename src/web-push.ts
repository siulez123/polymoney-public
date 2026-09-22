import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import webpush from "web-push";
import type { Logger } from "./logger.js";

export interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface VapidStore {
  publicKey: string;
  privateKey: string;
  subject: string;
}

interface SubscriptionStore {
  subscriptions: PushSubscriptionJSON[];
  updatedAt?: string;
}

const DEFAULT_VAPID_PATH = "./data/vapid.json";
const DEFAULT_SUBS_PATH = "./data/push-subscriptions.json";

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/**
 * Web Push (VAPID) para notificações GANHOU/PERDEU com a app em background.
 * SSE da página não corre quando o OS suspende o PWA — push sim.
 */
export class WebPushNotifier {
  private ready = false;
  private publicKey = "";
  private privateKey = "";
  private subject = "mailto:polymoney@localhost";
  private subscriptions: PushSubscriptionJSON[] = [];
  private readonly vapidPath: string;
  private readonly subsPath: string;

  constructor(
    private log: Logger,
    vapidPath = DEFAULT_VAPID_PATH,
    subsPath = DEFAULT_SUBS_PATH,
  ) {
    this.vapidPath = resolve(vapidPath);
    this.subsPath = resolve(subsPath);
  }

  init(): void {
    const fromEnvPub = process.env.VAPID_PUBLIC_KEY?.trim();
    const fromEnvPriv = process.env.VAPID_PRIVATE_KEY?.trim();
    const fromEnvSub = process.env.VAPID_SUBJECT?.trim();

    let store = readJson<VapidStore>(this.vapidPath);

    if (fromEnvPub && fromEnvPriv) {
      this.publicKey = fromEnvPub;
      this.privateKey = fromEnvPriv;
      this.subject = fromEnvSub || "mailto:polymoney@localhost";
    } else if (store?.publicKey && store?.privateKey) {
      this.publicKey = store.publicKey;
      this.privateKey = store.privateKey;
      this.subject = store.subject || this.subject;
    } else {
      const keys = webpush.generateVAPIDKeys();
      this.publicKey = keys.publicKey;
      this.privateKey = keys.privateKey;
      store = {
        publicKey: this.publicKey,
        privateKey: this.privateKey,
        subject: this.subject,
      };
      writeJson(this.vapidPath, store);
      this.log.info({ path: this.vapidPath }, "VAPID keys geradas para Web Push");
    }

    if (fromEnvSub) this.subject = fromEnvSub;

    webpush.setVapidDetails(this.subject, this.publicKey, this.privateKey);

    const subs = readJson<SubscriptionStore>(this.subsPath);
    this.subscriptions = Array.isArray(subs?.subscriptions) ? subs!.subscriptions : [];
    this.ready = true;

    this.log.info(
      {
        subscribers: this.subscriptions.length,
        publicKeyPrefix: this.publicKey.slice(0, 12) + "…",
      },
      "Web Push pronto (notificações em background)",
    );
  }

  isReady(): boolean {
    return this.ready && Boolean(this.publicKey);
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  getSubscriberCount(): number {
    return this.subscriptions.length;
  }

  subscribe(sub: PushSubscriptionJSON): void {
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      throw new Error("Subscription inválida");
    }
    const idx = this.subscriptions.findIndex((s) => s.endpoint === sub.endpoint);
    if (idx >= 0) this.subscriptions[idx] = sub;
    else this.subscriptions.push(sub);
    this.saveSubs();
    this.log.info({ subscribers: this.subscriptions.length }, "Web Push: subscription registada");
  }

  unsubscribe(endpoint: string): void {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.subscriptions.length !== before) {
      this.saveSubs();
      this.log.info({ subscribers: this.subscriptions.length }, "Web Push: subscription removida");
    }
  }

  async notifyPnl(won: boolean, body: string, pnlUsd?: number, notificationId?: string): Promise<void> {
    if (!this.ready || this.subscriptions.length === 0) return;

    const sign = won ? "+" : "";
    const pnlTxt = typeof pnlUsd === "number" && Number.isFinite(pnlUsd)
      ? ` ${sign}$${Math.abs(pnlUsd).toFixed(2)}`
      : "";
    const title = won ? `WON${pnlTxt}` : `LOSS${pnlTxt}`;
    const payload = JSON.stringify({
      title,
      body,
      tag: `polymoney-pnl-${notificationId ?? Date.now()}`,
      renotify: true,
      won,
      icon: won ? "/icon-win.png" : "/icon-loss.png",
      badge: won ? "/badge-win.png" : "/badge-loss.png",
      color: won ? "#22c55e" : "#ef4444",
    });

    await this.sendPayload(payload);
  }

  async notifySystem(title: string, body: string, notificationId?: string): Promise<void> {
    if (!this.ready || this.subscriptions.length === 0) return;

    const payload = JSON.stringify({
      title,
      body,
      tag: `polymoney-system-${notificationId ?? Date.now()}`,
      renotify: true,
      won: null,
      icon: "/icon-app.png",
    });
    await this.sendPayload(payload);
  }

  private async sendPayload(payload: string): Promise<void> {
    const stale: string[] = [];
    await Promise.all(
      this.subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload, { TTL: 60 * 60 });
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          const message = err instanceof Error ? err.message : String(err);
          if (status === 404 || status === 410) {
            stale.push(sub.endpoint);
          } else {
            this.log.warn({ err: message, status }, "Web Push: falha ao enviar");
          }
        }
      }),
    );

    if (stale.length > 0) {
      this.subscriptions = this.subscriptions.filter((s) => !stale.includes(s.endpoint));
      this.saveSubs();
    }
  }

  private saveSubs(): void {
    writeJson(this.subsPath, {
      subscriptions: this.subscriptions,
      updatedAt: new Date().toISOString(),
    } satisfies SubscriptionStore);
  }
}

export function parsePushSubscription(raw: unknown): PushSubscriptionJSON {
  if (!raw || typeof raw !== "object") throw new Error("Body inválido");
  const o = raw as Record<string, unknown>;
  const keys = o.keys as Record<string, unknown> | undefined;
  if (typeof o.endpoint !== "string" || !keys) throw new Error("Subscription inválida");
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    throw new Error("Subscription keys inválidas");
  }
  return {
    endpoint: o.endpoint,
    expirationTime: typeof o.expirationTime === "number" ? o.expirationTime : null,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

