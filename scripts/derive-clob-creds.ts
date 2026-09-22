/**
 * Gera credenciais CLOB (API key + secret + passphrase) a partir da PRIVATE_KEY.
 * Estas credenciais NÃO existem no site Polymarket — só nas Settings aparecem Relayer API keys.
 *
 * Uso: npm run derive-api-key
 */
import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const privateKey = process.env.PRIVATE_KEY?.trim();
if (!privateKey?.startsWith("0x")) {
  console.error("Define PRIVATE_KEY no .env (exportada em polymarket.com/settings)");
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
console.log("=== Credenciais CLOB (trading) ===");
console.log("");
console.log("Signer (da PRIVATE_KEY):", account.address);
console.log("");
console.log("POLY_API_KEY=" + creds.key);
console.log("POLY_API_SECRET=" + creds.secret);
console.log("POLY_API_PASSPHRASE=" + creds.passphrase);
console.log("");
console.log("Nota: guarda estes valores em segurança. Não partilhes nem commits.");
console.log("");
console.log(
  "Conta deposit wallet (signature_type=3): estas credenciais ficam ligadas ao signer acima,",
);
console.log(
  "não ao endereço do perfil. A Polymarket pode rejeitar ordens até corrigirem o SDK.",
);
console.log("Issue: https://github.com/Polymarket/clob-client-v2/issues/65");
console.log("");

