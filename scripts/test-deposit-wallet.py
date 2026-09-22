#!/usr/bin/env python3
"""
Deposit wallet diagnostics (signature_type=3) for Polymarket CLOB.

Usage on the VPS:
  cd /opt/polymoney
  bash scripts/run-deposit-wallet-test.sh
  bash scripts/run-deposit-wallet-test.sh --live   # try GTC order at 0.01 (unlikely to fill)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

HOST = os.environ.get("CLOB_HOST", "https://clob.polymarket.com")
CHAIN_ID = int(os.environ.get("CHAIN_ID", "137"))


def load_env() -> None:
    candidates = [
        Path.cwd() / ".env",
        Path("/opt/polymoney/.env"),
        Path(__file__).resolve().parent.parent / ".env",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)
        print(f"[env] {path}")
        return
    print("[env] .env not found — using environment variables")


def ok(msg: str) -> None:
    print(f"  ✓ {msg}")


def fail(msg: str) -> None:
    print(f"  ✗ {msg}")


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def current_btc_token() -> tuple[str, bool]:
    """Same as the Node bot: GET /events?slug=... (not /markets)."""
    window = (int(time.time()) // 300) * 300
    slug = f"btc-updown-5m-{window}"
    url = f"https://gamma-api.polymarket.com/events?slug={slug}"
    import urllib.request

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "polymoney-test/1.0"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        events = json.loads(resp.read().decode())
    if not events:
        raise RuntimeError(f"Market not found: {slug}")
    market = events[0]["markets"][0]
    token_ids = json.loads(market["clobTokenIds"])
    neg_risk = bool(market.get("negRisk", False))
    print(f"  market: {slug}")
    return str(token_ids[0]), neg_risk


def balance_usd(client: Any) -> float:
    from py_clob_client_v2 import AssetType, BalanceAllowanceParams, SignatureTypeV2

    params = BalanceAllowanceParams(
        asset_type=AssetType.COLLATERAL,
        signature_type=SignatureTypeV2.POLY_1271,
    )
    try:
        client.update_balance_allowance(params)
    except Exception:
        pass
    data = client.get_balance_allowance(params)
    raw = data.get("balance", "0") if isinstance(data, dict) else "0"
    return float(raw) / 1_000_000


def try_auth_recipe_a(private_key: str, funder: str) -> tuple[Any | None, str | None]:
    """Issue #70 method: client with sig3+funder before deriving."""
    from py_clob_client_v2 import ClobClient, SignatureTypeV2

    try:
        client = ClobClient(
            HOST,
            chain_id=CHAIN_ID,
            key=private_key,
            signature_type=SignatureTypeV2.POLY_1271,
            funder=funder,
        )
        creds = client.create_or_derive_api_key()
        client.set_api_creds(creds)
        return client, None
    except Exception as exc:
        return None, str(exc)


def try_auth_recipe_b(private_key: str, funder: str) -> tuple[Any | None, str | None]:
    """Official quickstart: derive using a temporary client, then create the full client."""
    from py_clob_client_v2 import ClobClient, SignatureTypeV2

    try:
        temp = ClobClient(HOST, chain_id=CHAIN_ID, key=private_key)
        creds = temp.create_or_derive_api_key()
        client = ClobClient(
            HOST,
            chain_id=CHAIN_ID,
            key=private_key,
            creds=creds,
            signature_type=SignatureTypeV2.POLY_1271,
            funder=funder,
        )
        return client, None
    except Exception as exc:
        return None, str(exc)


def try_post_test_order(client: Any, token_id: str, neg_risk: bool) -> tuple[bool, str]:
    from py_clob_client_v2 import OrderArgs, OrderType, PartialCreateOrderOptions, Side

    try:
        order = client.create_order(
            OrderArgs(token_id=token_id, price=0.01, size=5.0, side=Side.BUY),
            PartialCreateOrderOptions(tick_size="0.01", neg_risk=neg_risk),
        )
        maker = getattr(order, "maker", None) or (order.get("maker") if isinstance(order, dict) else None)
        signer = getattr(order, "signer", None) or (order.get("signer") if isinstance(order, dict) else None)
        print(f"  order maker: {maker}")
        print(f"  order signer: {signer}")

        resp = client.post_order(order, OrderType.GTC)
        detail = json.dumps(resp, default=str)
        if isinstance(resp, dict) and resp.get("error"):
            return False, detail
        if isinstance(resp, dict) and (resp.get("orderID") or resp.get("orderId")):
            return True, detail
        return False, detail
    except Exception as exc:
        err = str(exc)
        if hasattr(exc, "read"):
            try:
                err = f"{err} body={exc.read().decode()[:500]}"
            except Exception:
                pass
        if hasattr(exc, "error_message"):
            err = str(exc.error_message)
        return False, err


def main() -> int:
    parser = argparse.ArgumentParser(description="CLOB deposit wallet test (sig 3)")
    parser.add_argument(
        "--live",
        action="store_true",
        help="Send a GTC order at 0.01 in the current BTC market (authentication test)",
    )
    args = parser.parse_args()

    load_env()

    private_key = os.environ.get("PRIVATE_KEY", "")
    funder = os.environ.get("DEPOSIT_WALLET_ADDRESS", "")

    if not private_key.startswith("0x"):
        fail("PRIVATE_KEY missing or invalid in .env")
        return 1
    if not funder.startswith("0x"):
        fail("DEPOSIT_WALLET_ADDRESS missing or invalid in .env")
        return 1

    print(f"CLOB host: {HOST}")
    print(f"Funder (profile): {funder}")

    section("1. Authentication — method A (sig3 before deriving)")
    client, err_a = try_auth_recipe_a(private_key, funder)
    if client:
        ok("API key derived (method A)")
    else:
        fail(f"Method A failed: {err_a}")

    if not client:
        section("1b. Authentication — method B (quickstart)")
        client, err_b = try_auth_recipe_b(private_key, funder)
        if client:
            ok("API key derived (method B)")
        else:
            fail(f"Method B failed: {err_b}")
            print(
                "\nConclusion: neither Python method worked. "
                "Try the Rust order sidecar (not included in this distribution)."
            )
            return 2

    section("2. Collateral balance")
    try:
        usd = balance_usd(client)
        if usd > 0:
            ok(f"CLOB balance: ${usd:.2f}")
        else:
            fail("CLOB balance = $0 — auth may target the wrong address (EOA vs profile)")
    except Exception as exc:
        fail(f"get_balance_allowance: {exc}")
        usd = 0.0

    section("3. Test order")
    if not args.live:
        print("  (skipped — run with --live to test POST /order)")
        print("\nSummary: auth OK" + (" + balance OK" if usd > 0 else " but balance $0"))
        return 0 if usd > 0 else 3

    try:
        token_id, neg_risk = current_btc_token()
    except Exception as exc:
        fail(str(exc))
        return 4

    placed, detail = try_post_test_order(client, token_id, neg_risk)
    if placed:
        ok("Order accepted by CLOB")
        print(f"  response: {detail[:500]}")
        return 0

    fail("Order rejected")
    print(f"  detail: {detail[:800]}")
    if "signer address has to be the address of the API KEY" in detail:
        print(
            "\nConclusion: bug #65 — EOA API key, deposit wallet order. "
            "Next step: Rust sidecar (not included in this distribution)"
        )
        return 5
    return 6


if __name__ == "__main__":
    sys.exit(main())

