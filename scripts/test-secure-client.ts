/**
 * Teste live com o SDK unificado @polymarket/client (createSecureClient).
 * Contorna o bug do clob-client-v2 (#65) em contas POLY_1271 / deposit wallet.
 *
 * Uso (no VPS Helsinki, sem geoblock):
 *   npx tsx scripts/test-secure-client.ts
 *   npx tsx scripts/test-secure-client.ts --market   # market order ~$5
 */
import "dotenv/config";
import { createSecureClient, OrderSide, OrderType } from "@polymarket/client";
import { privateKey } from "@polymarket/client/viem";
import { privateKeyToAccount } from "viem/accounts";

async function discoverBtcToken(): Promise<{ slug: string; tokenId: string; side: "up" }> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / 300) * 300;
  const slug = `btc-updown-5m-${window}`;
  const events = (await fetch(
    `https://gamma-api.polymarket.com/events?slug=${slug}`,
  ).then((r) => r.json())) as { markets?: { clobTokenIds?: string }[] }[];

  const market = events?.[0]?.markets?.[0];
  if (!market?.clobTokenIds) {
    throw new Error(`Mercado não encontrado: ${slug}`);
  }
  const ids = JSON.parse(market.clobTokenIds) as string[];
  return { slug, tokenId: ids[0], side: "up" };
}

async function main(): Promise<void> {
  const pk = process.env.PRIVATE_KEY?.trim();
  const wallet = process.env.DEPOSIT_WALLET_ADDRESS?.trim();
  if (!pk?.startsWith("0x")) throw new Error("PRIVATE_KEY em falta");
  if (!wallet?.startsWith("0x")) throw new Error("DEPOSIT_WALLET_ADDRESS em falta");

  const doMarket = process.argv.includes("--market");
  const { slug, tokenId } = await discoverBtcToken();
  console.log("mercado:", slug);
  console.log("tokenId:", tokenId);
  console.log("wallet:", wallet);

  // auto-deposit (default): omitir wallet → SDK deriva DEPOSIT_WALLET (type 3)
  // --with-wallet: passa DEPOSIT_WALLET_ADDRESS (antes classificava como POLY_PROXY → falha)
  // --eoa: autentica como EOA
  const mode = process.argv.includes("--with-wallet")
    ? "with-wallet"
    : process.argv.includes("--eoa")
      ? "eoa"
      : "auto-deposit";
  const signerAddress = privateKeyToAccount(pk as `0x${string}`).address;

  console.log("A criar SecureClient mode=", mode);
  const client = await createSecureClient({
    signer: privateKey(pk),
    ...(mode === "with-wallet"
      ? { wallet }
      : mode === "eoa"
        ? { wallet: signerAddress }
        : {}),
  });

  const account = client.account;
  console.log("account:", JSON.stringify(account, null, 2));
  if (
    mode === "auto-deposit"
    && account.wallet.toLowerCase() !== wallet.toLowerCase()
  ) {
    console.warn(
      `AVISO: deposit derivado ${account.wallet} != DEPOSIT_WALLET_ADDRESS ${wallet}`,
    );
  }

  try {
    const bal = await client.fetchCollateralBalance?.();
    console.log("collateral:", bal);
  } catch (e) {
    console.log("fetchCollateralBalance skip:", e instanceof Error ? e.message : e);
  }

  if (doMarket) {
    console.log("A colocar market order BUY ~$5 FAK...");
    const response = await client.placeMarketOrder({
      tokenId,
      side: OrderSide.BUY,
      amount: 5,
      orderType: OrderType.FAK,
    });
    console.log("response:", JSON.stringify(response, null, 2));
    if (!response.ok) {
      process.exitCode = 1;
      return;
    }
    console.log("OK orderId:", response.orderId);
    return;
  }

  console.log("A colocar limit BUY @ 0.01 size 5 (teste de auth; provavelmente não preenche)...");
  const response = await client.placeLimitOrder({
    tokenId,
    side: OrderSide.BUY,
    price: 0.01,
    size: 5,
  });
  console.log("response:", JSON.stringify(response, null, 2));
  if (!response.ok) {
    process.exitCode = 1;
    return;
  }
  console.log("OK orderId:", response.orderId);

  try {
    await client.cancelOrder({ orderId: response.orderId });
    console.log("ordem de teste cancelada");
  } catch (e) {
    console.log("cancel skip:", e instanceof Error ? e.message : e);
  }
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});

