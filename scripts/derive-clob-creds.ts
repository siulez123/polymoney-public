/**
 * Generate CLOB credentials (API key + secret + passphrase) from PRIVATE_KEY.
 * These credentials are NOT available on the Polymarket website — Settings only shows Relayer API keys.
 *
 * Usage: npm run derive-api-key
 */
import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const privateKey = process.env.PRIVATE_KEY?.trim();
if (!privateKey?.startsWith("0x")) {
  console.error("Set PRIVATE_KEY in .env (exported from polymarket.com/settings)");
  process.exit(1);
}

const account = privateKeyToAccount(privateKey as `0x${string}`);
const signer = createWalletClient({
  account,
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com"),
});

const client = new ClobClient({
  host: "https://clob.polymarket.com",
  chain: 137,
  signer,
});

const creds = await client.createOrDeriveApiKey();

console.log("");
console.log("=== CLOB credentials (trading) ===");
console.log("");
console.log("Signer (from PRIVATE_KEY):", account.address);
console.log("");
console.log("POLY_API_KEY=" + creds.key);
console.log("POLY_API_SECRET=" + creds.secret);
console.log("POLY_API_PASSPHRASE=" + creds.passphrase);
console.log("");
console.log("Note: store these values securely. Do not share or commit them.");
console.log("");
console.log(
  "Deposit wallet account (signature_type=3): these credentials are bound to the signer above,",
);
console.log(
  "not to the profile address. Polymarket may reject orders until the SDK is fixed.",
);
console.log("Issue: https://github.com/Polymarket/clob-client-v2/issues/65");
console.log("");

