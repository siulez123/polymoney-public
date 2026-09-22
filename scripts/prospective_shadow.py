#!/usr/bin/env python3
"""Predeclared shadow study. Reads local data; exports aggregates; never orders.

Do not move dates or replace hypotheses after seeing results. Missing/late data
are visible. Completion requests analysis, never trading or strategy promotion.
"""
import argparse
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

from shadow_backtest import collect_rows, load_local, summarize, METRIC_KEYS

START = datetime(2026, 9, 16, tzinfo=timezone.utc)
END = START + timedelta(days=14)
HYPOTHESES = (("order_book_imbalance", 180),  # unchanged control
              ("order_book_imbalance", 240),  # timing hypothesis
              ("book_leader", 240))           # exploratory alternative
TIMING_TOLERANCE_SECONDS = 5
EXPECTED_MARKETS_PER_DAY = 288  # existing BTC 5-minute market universe


def analyze(bets, now=None):
    now = now or datetime.now(timezone.utc)
    # Fixed cutoff: results do not drop out when the rolling backtest advances.
    rows = collect_rows(bets, START, 1.0)
    results = []
    for mode, seconds in HYPOTHESES:
        selected = [r for r in rows if r["mode"] == mode
                    and r["entrySecondsBeforeClose"] == seconds
                    and START.timestamp() <= r["marketTime"] < END.timestamp()
                    and START <= r["observedAt"] <= now]
        blocks = []
        accepted = []
        for day in range(14):
            start = START + timedelta(days=day)
            stop = start + timedelta(days=1)
            cohort = [r for r in selected if start.timestamp() <= r["marketTime"] < stop.timestamp()]
            timely = [r for r in cohort if r["explicitTiming"]
                      and abs(r["marketTime"] - r["observedAt"].timestamp() - seconds)
                      <= TIMING_TOLERANCE_SECONDS]
            # Reject invalid numeric evidence, never treat missing fees as zero.
            valid = [r for r in timely if not r["executable"] or (r["explicitCosts"] and (
                r["pnlUsd"] is None or (
                all(math.isfinite(r[k]) for k in ("pnlUsd", "costUsd", "feesUsd"))
                and r["costUsd"] > 0 and r["feesUsd"] >= 0
                and isinstance(r["won"], bool))))]
            summary = summarize(valid)
            accepted.extend(valid)
            pending = sum(r["executable"] and r["pnlUsd"] is None for r in valid)
            coverage = len(valid) / EXPECTED_MARKETS_PER_DAY
            status = "scheduled" if now < start else "collecting"
            if now >= stop:
                status = "incomplete" if coverage < .90 or pending or len(valid) != len(timely) else "closed"
            blocks.append({
                "startUtc": start.isoformat(), "endUtc": stop.isoformat(),
                "status": status, "observedMarkets": len(cohort),
                "timingExcludedMarkets": len(cohort) - len(timely),
                "invalidEvidenceMarkets": len(timely) - len(valid),
                "coverage": round(coverage, 6), "pendingTrades": pending,
                "metrics": {k: summary[k] for k in METRIC_KEYS},
            })
        total = summarize(accepted)
        results.append({"mode": mode, "entry": f"T-{seconds}", "blocks": blocks,
                        "metrics": {k: total[k] for k in METRIC_KEYS}})
    complete = all(b["status"] == "closed" for s in results for b in s["blocks"])
    enough = all(sum(b["metrics"]["trades"] for b in s["blocks"]) >= 30 for s in results)
    status = "scheduled" if now < START else "collecting"
    if now >= END:
        status = "review_required" if complete and enough else "insufficient_evidence"
    return {
        "studyId": "btc5m-shadow-20260916-v1", "startUtc": START.isoformat(),
        "endUtc": END.isoformat(), "generatedAt": now.isoformat(), "status": status,
        "orderSubmission": False, "automaticPromotion": False,
        "timingToleranceSeconds": TIMING_TOLERANCE_SECONDS,
        "expectedMarketsPerDay": EXPECTED_MARKETS_PER_DAY,
        "minimumCoverage": .90, "minimumResolvedTradesPerHypothesis": 30,
        "limitations": "Hypothetical full fills; no queue or latency replay. Stored fee estimates. "
        "30 trades is a data floor, not proof of profit. Three correlated hypotheses; "
        "review all daily net returns, missingness, drawdown and multiple comparisons after the fixed end.",
        "hypotheses": results,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(analyze(load_local(args.input)), indent=2))

