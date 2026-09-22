import type { ApiKeyCreds } from "@polymarket/clob-client-v2";
import type { WalletClient } from "viem";
import { encodeAbiParameters, keccak256, toHex } from "viem";

const MSG_TO_SIGN = "This message attests that I control the given wallet";
const BYTES32_ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

const CLOB_AUTH_TYPE_STRING =
  "ClobAuth(address address,string timestamp,uint256 nonce,string message)";
const CLOB_AUTH_TYPE_HASH = keccak256(toHex(CLOB_AUTH_TYPE_STRING));
const DOMAIN_TYPE_HASH = keccak256(
  toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);
const CLOB_AUTH_DOMAIN_NAME_HASH = keccak256(toHex("ClobAuthDomain"));
const CLOB_AUTH_DOMAIN_VERSION_HASH = keccak256(toHex("1"));

const CLOB_AUTH_STRUCT = [
  { name: "address", type: "address" },
  { name: "timestamp", type: "string" },
  { name: "nonce", type: "uint256" },
  { name: "message", type: "string" },
] as const;

const TYPED_DATA_SIGN_STRUCT = [
  { name: "contents", type: "ClobAuth" },
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
] as const;

interface ApiKeyRaw {
  apiKey: string;
  secret: string;
  passphrase: string;
}

async function signTypedData(
  signer: WalletClient,
  domain: Record<string, unknown>,
  types: Record<string, readonly { name: string; type: string }[]>,
  primaryType: string,
  message: Record<string, unknown>,
): Promise<`0x${string}`> {
  const account = signer.account;
  if (!account) throw new Error("wallet client sem account");
  return signer.signTypedData({
    account,
    domain,
    types,
    primaryType,
    message,
  });
}

function buildAppDomainSep(chainId: number, funderAddress: `0x${string}`): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        DOMAIN_TYPE_HASH,
        CLOB_AUTH_DOMAIN_NAME_HASH,
        CLOB_AUTH_DOMAIN_VERSION_HASH,
        BigInt(chainId),
        funderAddress,
      ],
    ),
  );
}

async function buildWrappedClobAuthSignature(
  signer: WalletClient,
  chainId: number,
  timestamp: number,
  nonce: number,
  funderAddress: `0x${string}`,
): Promise<string> {
  const ts = timestamp.toString();
  const contents = {
    address: funderAddress,
    timestamp: ts,
    nonce: BigInt(nonce),
    message: MSG_TO_SIGN,
  };

  const contentsHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "string" },
        { type: "uint256" },
        { type: "string" },
      ],
      [CLOB_AUTH_TYPE_HASH, funderAddress, ts, BigInt(nonce), MSG_TO_SIGN],
    ),
  );

  const innerSig = await signTypedData(
    signer,
    { name: "ClobAuthDomain", version: "1", chainId },
    { TypedDataSign: TYPED_DATA_SIGN_STRUCT, ClobAuth: CLOB_AUTH_STRUCT },
    "TypedDataSign",
    {
      contents,
      name: "DepositWallet",
      version: "1",
      chainId: BigInt(chainId),
      verifyingContract: funderAddress,
      salt: BYTES32_ZERO,
    },
  );

  const lenHex = 186 .toString(16).padStart(4, "0");
  const appDomainSep = buildAppDomainSep(chainId, funderAddress);
  return `0x${innerSig.slice(2)}${appDomainSep.slice(2)}${contentsHash.slice(2)}${toHex(CLOB_AUTH_TYPE_STRING).slice(2)}${lenHex}`;
}

async function requestApiKey(
  host: string,
  path: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: ApiKeyRaw | { error?: string } }> {
  const response = await fetch(`${host}${path}`, { method, headers });
  const body = (await response.json()) as ApiKeyRaw | { error?: string };
  return { ok: response.ok, status: response.status, body };
}

/** Tenta derivar API key L2 ligada à deposit wallet (POLY_1271). Falha se o CLOB ainda não suportar. */
export async function deriveDepositWalletApiKey(
  host: string,
  chainId: number,
  signer: WalletClient,
  funderAddress: `0x${string}`,
  nonce = 0,
): Promise<ApiKeyCreds | null> {
  const ts = Math.floor(Date.now() / 1000);
  const signature = await buildWrappedClobAuthSignature(
    signer,
    chainId,
    ts,
    nonce,
    funderAddress,
  );
  const headers = {
    POLY_ADDRESS: funderAddress,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: String(ts),
    POLY_NONCE: String(nonce),
  };

  for (const [method, path] of [
    ["GET", "/auth/derive-api-key"],
    ["POST", "/auth/api-key"],
  ] as const) {
    const result = await requestApiKey(host, path, method, headers);
    if (result.ok && "apiKey" in result.body && result.body.apiKey) {
      return {
        key: result.body.apiKey,
        secret: result.body.secret,
        passphrase: result.body.passphrase,
      };
    }
  }

  return null;
}

export const DEPOSIT_WALLET_AUTH_ERROR =
  "Contas deposit wallet (signature_type=3) não conseguem obter API key CLOB válida via SDK — " +
  "bug Polymarket: https://github.com/Polymarket/clob-client-v2/issues/65. " +
  "Usa mode: paper até haver fix, ou aposta manual no site.";

