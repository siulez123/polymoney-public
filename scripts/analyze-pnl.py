#!/usr/bin/env python3
"""Análise rápida do pnl.json no VPS."""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

bets = json.loads(Path("data/pnl.json").read_text())["bets"]
print("total", len(bets))
print("outcomes", dict(Counter(b.get("outcome") for b in bets)))


def actionable(b: dict) -> bool:
    o = b.get("outcome")
    if o == "placed":
        o = "filled"
    return o in ("filled", "paper")


act = [b for b in bets if actionable(b)]
pending = [b for b in act if not b.get("resolved")]
resolved = [b for b in act if b.get("resolved")]
print("actionable", len(act), "pending", len(pending), "resolved", len(resolved))

now = datetime.now(timezone.utc)
print("--- pending last 25 ---")
for b in pending[-25:]:
    placed = b.get("placedAt")
    age_h = None
    if placed:
        age_h = round(
            (now - datetime.fromisoformat(placed.replace("Z", "+00:00"))).total_seconds() / 3600,
            1,
        )
    print(
        b.get("marketSlug"),
        "side=",
        b.get("side"),
        "out=",
        b.get("outcome"),
        "age_h=",
        age_h,
        "paper=",
        b.get("paper"),
        "err=",
        str(b.get("error") or "")[:80],
    )

wins = [b for b in resolved if b.get("won")]
losses = [b for b in resolved if b.get("won") is False]
pnl = sum(float(b.get("pnl") or 0) for b in resolved)
print(f"W{len(wins)} L{len(losses)} WR={len(wins)/max(1,len(resolved))*100:.1f}% PnL={pnl:+.2f}")

by: dict = defaultdict(lambda: {"n": 0, "w": 0, "l": 0, "pnl": 0.0, "px": 0.0, "d": []})
for b in resolved:
    day = (b.get("resolvedAt") or b.get("placedAt") or "")[:10]
    if not day:
        continue
    d = by[day]
    d["n"] += 1
    if b.get("won"):
        d["w"] += 1
    else:
        d["l"] += 1
    d["pnl"] += float(b.get("pnl") or 0)
    d["px"] += float(b.get("price") or 0)
    m = re.search(r"([+-]?\d+\.?\d*) bps", b.get("strategyReason") or "")
    if m:
        d["d"].append(abs(float(m.group(1))))

print("\n=== days ===")
for day in sorted(by)[-21:]:
    d = by[day]
    wr = d["w"] / d["n"] * 100 if d["n"] else 0
    ap = d["px"] / d["n"] if d["n"] else 0
    ad = sum(d["d"]) / len(d["d"]) if d["d"] else 0
    print(f"{day} n={d['n']:3d} W{d['w']:2d}/L{d['l']:2d} wr={wr:5.1f}% pnl={d['pnl']:+8.2f} avgPx={ap:.3f} |d|={ad:.1f}")

buckets = defaultdict(lambda: {"n": 0, "w": 0, "pnl": 0.0})
for b in resolved:
    px = float(b.get("price") or 0)
    key = "<=0.70" if px <= 0.70 else "0.70-0.80" if px <= 0.80 else "0.80-0.87" if px <= 0.87 else ">0.87"
    buckets[key]["n"] += 1
    if b.get("won"):
        buckets[key]["w"] += 1
    buckets[key]["pnl"] += float(b.get("pnl") or 0)
print("\nby price")
for k in ["<=0.70", "0.70-0.80", "0.80-0.87", ">0.87"]:
    d = buckets[k]
    if not d["n"]:
        continue
    print(f"  {k} n={d['n']} wr={d['w']/d['n']*100:.1f}% pnl={d['pnl']:+.2f}")

db = defaultdict(lambda: {"n": 0, "w": 0, "pnl": 0.0})
for b in resolved:
    m = re.search(r"([+-]?\d+\.?\d*) bps", b.get("strategyReason") or "")
    if not m:
        continue
    ad = abs(float(m.group(1)))
    key = "<7" if ad < 7 else "7-10" if ad < 10 else "10-15" if ad < 15 else "15-25" if ad < 25 else ">=25"
    db[key]["n"] += 1
    if b.get("won"):
        db[key]["w"] += 1
    db[key]["pnl"] += float(b.get("pnl") or 0)
print("\nby |delta|")
for k in ["<7", "7-10", "10-15", "15-25", ">=25"]:
    d = db[k]
    if not d["n"]:
        continue
    print(f"  {k} n={d['n']} wr={d['w']/d['n']*100:.1f}% pnl={d['pnl']:+.2f}")

print("\nlast 15 resolved")
for b in resolved[-15:]:
    print(
        (b.get("resolvedAt") or "")[:19],
        b.get("side"),
        "won=",
        b.get("won"),
        "pnl=",
        b.get("pnl"),
        "px=",
        b.get("price"),
        (b.get("strategyReason") or "")[:75],
    )

