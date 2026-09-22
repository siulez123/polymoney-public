import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type PackageMetadata = { version?: string };

test("@polymarket/client includes the fixed-point order amount fix", () => {
  const packagePath = new URL(
    "../node_modules/@polymarket/client/package.json",
    import.meta.url,
  );
  const metadata = JSON.parse(
    readFileSync(packagePath, "utf8"),
  ) as PackageMetadata;
  const [major = 0, minor = 0] = (metadata.version ?? "0.0.0")
    .split(".")
    .map(Number);

  assert.ok(
    major > 0 || minor >= 7,
    `@polymarket/client 0.7.0+ is required for exact fixed-point order amounts; found ${metadata.version ?? "unknown"}`,
  );
});

