import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { configSchema } from "./config.js";
import { getConfigSections } from "./config-meta.js";
import { renderDashboardHtml } from "./dashboard-html.js";

function configPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return prefix ? [prefix] : [];
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      configPaths(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return prefix ? [prefix] : [];
}

test("config screen covers every current system setting in all locales", () => {
  const config = configSchema.parse(parseYaml(readFileSync("config.yaml", "utf8")));
  const expectedPaths = configPaths(config);

  for (const locale of ["pt", "en", "es"] as const) {
    const sections = getConfigSections(locale);
    const fields = sections.flatMap((section) => section.fields);
    const visiblePaths = new Set(fields.map((field) => field.path));
    const missing = expectedPaths.filter((path) => !visiblePaths.has(path));
    assert.deepEqual(missing, [], `missing config fields for ${locale}`);
    for (const field of fields) {
      assert.notEqual(field.label, field.path, `missing label for ${locale}: ${field.path}`);
    }

    const strategyMode = fields.find((field) => field.path === "strategy.mode");
    assert.ok(strategyMode?.options?.includes(config.strategy.mode));
  }
});

test("dashboard All filter keeps the complete history renderable", () => {
  const html = renderDashboardHtml();
  assert.match(html, /const storedTradeFilter/);
  assert.match(html, /renderTrades\(\);/);
  assert.match(html, /filtered\.map\(\(trade\) =>/);
  assert.doesNotMatch(html, /filtered\.map\(t =>/);
  assert.match(html, /f\.type === 'json'/);
  assert.match(html, /validateSettingsForm/);
});

