import { en, es, pt } from "./packs.js";
import type { Locale, LocalePack, Messages } from "./types.js";
import { LOCALES, parseLocale } from "./types.js";

export { LOCALES, parseLocale };
export type { Locale, LocalePack, Messages };

export const PACKS: Record<Locale, LocalePack> = { pt, en, es };

export function getPack(locale: Locale): LocalePack {
  return PACKS[locale] ?? PACKS.pt;
}

export function getUi(locale: Locale): Messages {
  return getPack(locale).ui;
}

/** Serializa packs para o dashboard (só UI + keys de idioma). */
export function dashboardI18nJson(): string {
  const out: Record<string, Messages> = {};
  for (const loc of LOCALES) {
    out[loc] = PACKS[loc].ui;
  }
  return JSON.stringify(out);
}

