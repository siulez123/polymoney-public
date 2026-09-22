import { en, es } from "./packs.js";
import type { Locale, LocalePack, Messages } from "./types.js";
import { LOCALES, parseLocale } from "./types.js";

export { LOCALES, parseLocale };
export type { Locale, LocalePack, Messages };

export const PACKS: Record<Locale, LocalePack> = { en, es };

export function getPack(locale: Locale): LocalePack {
  return PACKS[locale] ?? PACKS.en;
}

export function getUi(locale: Locale): Messages {
  return getPack(locale).ui;
}

/** Serialize packs for the dashboard (UI and locale keys only). */
export function dashboardI18nJson(): string {
  const out: Record<string, Messages> = {};
  for (const loc of LOCALES) {
    out[loc] = PACKS[loc].ui;
  }
  return JSON.stringify(out);
}

