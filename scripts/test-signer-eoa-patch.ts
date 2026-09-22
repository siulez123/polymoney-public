/**
 * Testa variantes de signer/maker/signatureType para desbloquear deposit wallet.
 * Ordem GTC a 0.01 (não deve preencher). Cancela no fim se aceitar.
 *
 * Uso: npx tsx scripts/test-signer-eoa-patch.ts
 */
import "dotenv/config";
import {
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const HOST = "https://clob.polymarket.com";
const CHAIN = 137;

type AnyOrder = {
  maker: string;
  signer: string;
  signatureType: number;
  signature: string;
  [k: string]: unknown;
};

async function postVariant(
  label: string,
  client: ClobClient,
  order: AnyOrder,
): Promise<void> {
  console.log(`\n=== ${label} ===`);
  console.log({
    maker: order.maker,
    signer: order.signer,
    signatureType: order.signatureType,
  });
  try {
    const resp = await client.postOrder(order as never, OrderType.GTC);
    console.log("OK:", JSON.stringify(resp));
    const id =
      (resp as { orderID?: string; orderId?: string }).orderID ??
      (resp as { orderId?: string }).orderId;
    if (id) {
      try {
        await client.cancelOrder({ orderID: id });
        console.log("cancelado:", id);
      } catch (e) {
        console.log("cancel falhou:", e);
      }
    }
  } catch (e: unknown) {
    const err = e as { data?: unknown; response?: { data?: unknown }; message?: string };
    console.log("FAIL:", JSON.stringify(err.data ?? err.response?.data ?? err.message ?? e));
  }
}

async function main(): Promise<void> {
  const pk = process.env.PRIVATE_KEY as Hex;
  const funder = process.env.DEPOSIT_WALLET_ADDRESS!;
  const account = privateKeyToAccount(pk);
  const signer = createWalletClient({ account, chain: polygon, transport: http() });
  console.log("EOA:", account.address);
  console.log("Funder:", funder);

  const bootstrap = new ClobClient({
    host: HOST,
    chain: CHAIN,
    signer,
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: funder,
  });
  const creds = await bootstrap.createOrDeriveApiKey();

  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / 300) * 300;
  const slug = `btc-updown-5m-${window}`;
  const events = (await fetch(
    `https://gamma-api.polymarket.com/events?slug=${slug}`,
  ).then((r) => r.json())) as { markets: { clobTokenIds: string }[] }[];
  const tokenId = JSON.parse(events[0].markets[0].clobTokenIds)[0] as string;
  console.log("Mercado:", slug, "token:", tokenId.slice(0, 16) + "…");

  const variants: Array<{ label: string; sigType: number }> = [
    { label: "A stock POLY_1271", sigType: SignatureTypeV2.POLY_1271 },
    { label: "B EOA + funder", sigType: SignatureTypeV2.EOA },
    { label: "C POLY_PROXY + funder", sigType: SignatureTypeV2.POLY_PROXY },
    { label: "D GNOSIS_SAFE + funder", sigType: SignatureTypeV2.POLY_GNOSIS_SAFE },
  ];

  for (const v of variants) {
    const c = new ClobClient({
      host: HOST,
      chain: CHAIN,
      signer,
      creds,
      signatureType: v.sigType,
      funderAddress: funder,
    });
    const tickSize = await c.getTickSize(tokenId);
    const negRisk = await c.getNegRisk(tokenId);
    try {
      const order = (await c.createOrder(
        { tokenID: tokenId, price: 0.01, size: 5, side: Side.BUY },
        { tickSize, negRisk },
      )) as AnyOrder;
      await postVariant(v.label, c, order);
    } catch (e: unknown) {
      console.log(`\n=== ${v.label} ===`);
      console.log("CREATE FAIL:", e instanceof Error ? e.message : e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

