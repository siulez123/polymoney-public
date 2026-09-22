#!/usr/bin/env python3
"""Walk-forward backtest for Polymoney's stored shadow-strategy observations.

The script never submits orders. It reads pnl.json, de-duplicates retries by
market/strategy/window, requires the stored full-fill simulation, and keeps all
observations from the same market in either the train or holdout cohort.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


MIN_HOLDOUT_MARKETS = 20
MIN_HOLDOUT_TRADES = 20
TRAIN_FRACTION = 0.70
DEFAULT_DEPTH_BUFFER = 1.0


def parse_time(raw: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def load_local(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text())
    bets = data.get("bets") if isinstance(data, dict) else data
    if not isinstance(bets, list):
        raise SystemExit("input must be pnl.json or a JSON array of bet records")
    return [item for item in bets if isinstance(item, dict)]


def load_via_ssh(host: str, identity: str) -> list[dict[str, Any]]:
    remote = """
import json
from pathlib import Path
data = json.loads(Path('/opt/polymoney/data/pnl.json').read_text())
print(json.dumps(data.get('bets', []), separators=(',', ':')))
"""
    command = ["ssh"]
    if identity:
        command.extend(["-i", identity])
    command.extend(["-o", "BatchMode=yes", host, "sudo", "python3", "-"])
    proc = subprocess.run(command, input=remote, capture_output=True, text=True, timeout=90)
    if proc.returncode != 0:
        raise SystemExit(f"ssh failed: {proc.stderr or proc.stdout}")
    data = json.loads(proc.stdout)
    if not isinstance(data, list):
        raise SystemExit("remote pnl data is not a bet array")
    return [item for item in data if isinstance(item, dict)]


def attempts_for_bet(bet: dict[str, Any]) -> list[dict[str, Any]]:
    history = bet.get("attemptHistory")
    return [item for item in history if isinstance(item, dict)] if isinstance(history, list) else []


def market_key(bet: dict[str, Any]) -> str:
    return str(bet.get("marketSlug") or bet.get("id") or "unknown")


def market_time(bet: dict[str, Any], attempted_at: datetime) -> float:
    end = bet.get("windowEndUnix")
    return float(end) if isinstance(end, (int, float)) else attempted_at.timestamp()


def conservative_fill(evaluation: dict[str, Any], depth_buffer: float) -> tuple[bool, str]:
    if evaluation.get("executionStyle") == "maker":
        return False, "maker_queue_unknown"
    if evaluation.get("side") not in {"up", "down"}:
        return False, "no_signal"
    if evaluation.get("fullyFillable") is not True:
        return False, str(evaluation.get("liquidityReason") or "not_fully_fillable")
    # fillableShares is capped at intendedShares by the production simulator,
    # so multiplying it by a buffer would reject every exact full fill. The
    # authoritative signal is fullyFillable: the complete intended order
    # crossed available depth within the price cap.
    intended = evaluation.get("intendedShares")
    available = evaluation.get("fillableShares")
    if isinstance(intended, (int, float)) and float(intended) > 0 and isinstance(available, (int, float)):
        if float(available) + 1e-9 < float(intended) * depth_buffer:
            return False, "depth_coverage"
    return True, "fillable"


def collect_rows(
    bets: list[dict[str, Any]],
    cutoff: datetime,
    depth_buffer: float,
) -> list[dict[str, Any]]:
    """Return the earliest observation for every market/strategy/window."""
    deduplicated: dict[tuple[str, str, int], dict[str, Any]] = {}
    for bet in bets:
        key = market_key(bet)
        for attempt in attempts_for_bet(bet):
            attempt_at = parse_time(attempt.get("attemptedAt"))
            if attempt_at is None or attempt_at < cutoff:
                continue
            evaluations = attempt.get("shadowStrategies")
            if not isinstance(evaluations, list):
                continue
            for evaluation in evaluations:
                if not isinstance(evaluation, dict):
                    continue
                mode = str(evaluation.get("mode") or evaluation.get("name") or "unknown")
                seconds = evaluation.get("entrySecondsBeforeClose")
                if not isinstance(seconds, (int, float)):
                    seconds = attempt.get("entrySecondsBeforeClose")
                if not isinstance(seconds, (int, float)):
                    continue
                observed_at = parse_time(evaluation.get("observedAt")) or attempt_at
                row_key = (key, mode, int(seconds))
                previous = deduplicated.get(row_key)
                if previous is not None and previous["observedAt"] <= observed_at:
                    continue
                executable, execution_reason = conservative_fill(evaluation, depth_buffer)
                pnl = evaluation.get("hypotheticalPnlUsd")
                resolved = evaluation.get("resolved") is True
                deduplicated[row_key] = {
                    "market": key,
                    "marketTime": market_time(bet, attempt_at),
                    "observedAt": observed_at,
                    "explicitTiming": parse_time(evaluation.get("observedAt")) is not None
                    and isinstance(bet.get("windowEndUnix"), (int, float)),
                    "explicitCosts": all(isinstance(evaluation.get(k), (int, float))
                                         and not isinstance(evaluation.get(k), bool)
                                         for k in ("fillableCostUsd", "estimatedFeesUsd")),
                    "mode": mode,
                    "entrySecondsBeforeClose": int(seconds),
                    "side": evaluation.get("side"),
                    "resolved": resolved,
                    "won": evaluation.get("won") if isinstance(evaluation.get("won"), bool) else None,
                    "executable": executable,
                    "executionReason": execution_reason,
                    "pnlUsd": float(pnl) if executable and resolved and isinstance(pnl, (int, float)) else None,
                    "costUsd": float(evaluation.get("fillableCostUsd") or 0),
                    "feesUsd": float(evaluation.get("estimatedFeesUsd") or 0),
                    "breakEven": (
                        float(evaluation["feeAwareBreakEvenProbability"])
                        if isinstance(evaluation.get("feeAwareBreakEvenProbability"), (int, float))
                        else None
                    ),
                }
    return list(deduplicated.values())


def split_markets(rows: list[dict[str, Any]], train_fraction: float) -> tuple[set[str], set[str]]:
    by_market: dict[str, float] = {}
    for row in rows:
        by_market[row["market"]] = min(by_market.get(row["market"], math.inf), row["marketTime"])
    ordered = sorted(by_market, key=lambda key: (by_market[key], key))
    if len(ordered) <= 1:
        return set(ordered), set()
    split = max(1, min(len(ordered) - 1, int(len(ordered) * train_fraction)))
    return set(ordered[:split]), set(ordered[split:])


def wilson_interval(wins: int, total: int, z: float = 1.959963984540054) -> list[float] | None:
    if total <= 0:
        return None
    p = wins / total
    denominator = 1 + z * z / total
    centre = p + z * z / (2 * total)
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total)
    return [round((centre - margin) / denominator, 6), round((centre + margin) / denominator, 6)]


def max_drawdown(pnls: list[float]) -> float:
    equity = peak = drawdown = 0.0
    for pnl in pnls:
        equity += pnl
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    return round(drawdown, 4)


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(rows, key=lambda row: (row["marketTime"], row["observedAt"]))
    trades = [row for row in ordered if row["pnlUsd"] is not None]
    resolved_signals = [row for row in ordered if row["resolved"] and row["side"] in {"up", "down"}]
    wins = sum(row["won"] is True for row in trades)
    losses = sum(row["won"] is False for row in trades)
    pnl = sum(row["pnlUsd"] for row in trades)
    capital = sum(row["costUsd"] + row["feesUsd"] for row in trades)
    fees = sum(row["feesUsd"] for row in trades)
    break_even = [row["breakEven"] for row in trades if row["breakEven"] is not None]
    reasons: dict[str, int] = defaultdict(int)
    for row in ordered:
        if not row["executable"]:
            reasons[row["executionReason"]] += 1
    return {
        "markets": len({row["market"] for row in ordered}),
        "observations": len(ordered),
        "signals": sum(row["side"] in {"up", "down"} for row in ordered),
        "resolvedSignals": len(resolved_signals),
        "trades": len(trades),
        "wins": wins,
        "losses": losses,
        "winRate": round(wins / len(trades), 6) if trades else None,
        "winRateWilson95": wilson_interval(wins, len(trades)),
        "averageBreakEvenProbability": round(sum(break_even) / len(break_even), 6) if break_even else None,
        "feeAwarePnlUsd": round(pnl, 4),
        "feesUsd": round(fees, 4),
        "capitalUsedUsd": round(capital, 4),
        "roi": round(pnl / capital, 6) if capital else None,
        "averagePnlUsd": round(pnl / len(trades), 4) if trades else None,
        "maxDrawdownUsd": max_drawdown([row["pnlUsd"] for row in trades]),
        "nonExecutableReasons": dict(sorted(reasons.items())),
    }


def portfolio_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Model one live position per market: take the earliest executable window."""
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[(row["market"], row["mode"])].append(row)
    selected = []
    for candidates in grouped.values():
        chronological = sorted(candidates, key=lambda row: -row["entrySecondsBeforeClose"])
        executable = next((row for row in chronological if row["executable"]), None)
        selected.append(executable or chronological[0])
    return selected


def readiness(holdout: dict[str, Any]) -> dict[str, Any]:
    missing_markets = max(0, MIN_HOLDOUT_MARKETS - holdout["markets"])
    missing_trades = max(0, MIN_HOLDOUT_TRADES - holdout["trades"])
    if missing_markets or missing_trades:
        status = "insufficient_sample"
    elif holdout["feeAwarePnlUsd"] <= 0 or (holdout["roi"] or 0) <= 0:
        status = "reject"
    else:
        interval = holdout.get("winRateWilson95")
        break_even = holdout.get("averageBreakEvenProbability")
        status = (
            "candidate"
            if interval and break_even is not None and interval[0] > break_even
            else "inconclusive"
        )
    return {
        "status": status,
        "minimumHoldoutMarkets": MIN_HOLDOUT_MARKETS,
        "minimumHoldoutTrades": MIN_HOLDOUT_TRADES,
        "missingMarkets": missing_markets,
        "missingTrades": missing_trades,
    }


def daily_validation(rows: list[dict[str, Any]], cutoff: datetime, now: datetime) -> dict[str, Any]:
    """Fixed UTC day boundaries; never split a market or include a partial day.

    The first cutoff day is omitted so observations before midnight are retained
    for markets closing just after midnight. Later resolutions may revise a block;
    pending executable outcomes are explicit and cannot pass the gate.
    """
    day = timedelta(days=1)
    start = cutoff.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) + day
    end = now.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    blocks = []
    previous_rows = []
    while start < end:
        stop = start + day
        cohort = [r for r in rows if start.timestamp() <= r["marketTime"] < stop.timestamp()]
        train = summarize(previous_rows)
        result = summarize(cohort)
        pending = sum(r["executable"] and r["pnlUsd"] is None for r in cohort)
        holdout_status = readiness(result)["status"]
        prior_status = readiness(train)["status"]
        status = holdout_status
        if pending:
            status = "pending_outcomes"
        elif status == "candidate" and prior_status != "candidate":
            status = "insufficient_prior_evidence"
        # This is a research screen, never a live-promotion instruction.
        blocks.append({
            "startUtc": start.isoformat().replace("+00:00", "Z"),
            "endUtc": stop.isoformat().replace("+00:00", "Z"),
            "train": train,
            "holdout": result,
            "pendingTrades": pending,
            "priorStatus": prior_status,
            "holdoutStatus": holdout_status,
            "status": status,
        })
        previous_rows.extend(cohort)
        start = stop
    streak = 0
    for block in reversed(blocks):
        if block["status"] != "candidate":
            break
        streak += 1
    pnls = [b["holdout"]["feeAwarePnlUsd"] for b in blocks]
    return {
        "basis": "complete_UTC_days_by_market_close",
        "requiredConsecutiveBlocks": 3,
        "consecutivePassingBlocks": streak,
        "status": "paper_review" if streak >= 3 else "not_ready",
        "meanBlockPnlUsd": round(statistics.mean(pnls), 4) if pnls else None,
        "stddevBlockPnlUsd": round(statistics.stdev(pnls), 4) if len(pnls) > 1 else None,
        "blocks": blocks,
        "limitations": "Observed strategies were not selected prospectively; blocks can be serially correlated. No latency replay or automatic promotion.",
    }


METRIC_KEYS = (
    "markets", "trades", "wins", "losses", "winRate", "winRateWilson95",
    "feeAwarePnlUsd", "feesUsd", "roi", "maxDrawdownUsd",
    "averageBreakEvenProbability",
)


def sanitized_summary(report: dict[str, Any]) -> dict[str, Any]:
    """Explicit allowlist: no raw rows, market IDs, arbitrary extra fields."""
    def metrics(value):
        return {key: value.get(key) for key in METRIC_KEYS}

    def validation(value):
        result = {key: value[key] for key in (
            "basis", "requiredConsecutiveBlocks", "consecutivePassingBlocks",
            "status", "meanBlockPnlUsd", "stddevBlockPnlUsd", "limitations",
        )}
        result["blocks"] = [{
            **{key: block[key] for key in ("startUtc", "endUtc", "pendingTrades", "status", "priorStatus", "holdoutStatus")},
            "train": metrics(block["train"]), "holdout": metrics(block["holdout"]),
        } for block in value["blocks"]]
        return result

    return {
        "generatedAt": report["generatedAt"],
        "windowHours": report["windowHours"],
        "sample": {key: report["sample"][key] for key in (
            "distinctMarkets", "trainMarkets", "holdoutMarkets", "deduplicatedObservations",
        )},
        "strategies": [{
            "mode": s["mode"],
            "train": metrics(s["train"]), "holdout": metrics(s["holdout"]),
            "windows": [{
                "entry": w["entry"], "train": metrics(w["train"]),
                "holdout": metrics(w["holdout"]), "validation": validation(w["validation"]),
            } for w in s["windows"]],
        } for s in report["strategies"]],
    }


def analyze(
    bets: list[dict[str, Any]],
    hours: float,
    depth_buffer: float = DEFAULT_DEPTH_BUFFER,
    now: datetime | None = None,
) -> dict[str, Any]:
    generated = now or datetime.now(timezone.utc)
    rows = collect_rows(bets, generated - timedelta(hours=hours), depth_buffer)
    train_markets, holdout_markets = split_markets(rows, TRAIN_FRACTION)
    modes = sorted({row["mode"] for row in rows})
    strategies = []
    for mode in modes:
        mode_rows = [row for row in rows if row["mode"] == mode]
        portfolio = portfolio_rows(mode_rows)
        train = summarize([row for row in portfolio if row["market"] in train_markets])
        holdout = summarize([row for row in portfolio if row["market"] in holdout_markets])
        windows = []
        for seconds in sorted({row["entrySecondsBeforeClose"] for row in mode_rows}, reverse=True):
            window_rows = [row for row in mode_rows if row["entrySecondsBeforeClose"] == seconds]
            windows.append({
                "entry": f"T-{seconds}",
                "train": summarize([row for row in window_rows if row["market"] in train_markets]),
                "holdout": summarize([row for row in window_rows if row["market"] in holdout_markets]),
                "validation": daily_validation(window_rows, generated - timedelta(hours=hours), generated),
            })
        strategies.append({
            "mode": mode,
            "portfolioPolicy": "earliest_conservative_fill_per_market",
            "train": train,
            "holdout": holdout,
            "readiness": {"status": "descriptive_only", "basis": "evaluate_each_strategy_window"},
            "windows": windows,
        })
    return {
        "generatedAt": generated.isoformat().replace("+00:00", "Z"),
        "windowHours": hours,
        "method": {
            "split": "chronological_70_30_by_distinct_market",
            "deduplication": "earliest_observation_per_market_strategy_window",
            "minimumStoredDepthCoverage": depth_buffer,
            "fillEvidence": "stored_fully_fillable_full_order_simulation",
            "fees": "stored_polymarket_fee_estimate_included",
            "latency": "not_modelled_without_tick_replay",
            "maker": "excluded_without_queue_position_evidence",
            "orderSubmission": False,
            "validation": "complete_UTC_days_non_overlapping_by_market_close",
            "promotion": "manual_review_only_after_prospective_validation",
        },
        "sample": {
            "distinctMarkets": len(train_markets | holdout_markets),
            "trainMarkets": len(train_markets),
            "holdoutMarkets": len(holdout_markets),
            "deduplicatedObservations": len(rows),
        },
        "strategies": strategies,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="local pnl.json")
    source.add_argument("--host", help="SSH host, for example user@server")
    parser.add_argument("--identity", default="", help="SSH private-key path")
    parser.add_argument("--hours", type=float, default=168)
    parser.add_argument("--depth-buffer", type=float, default=DEFAULT_DEPTH_BUFFER)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--sanitized-json", action="store_true", help="allowlisted aggregate export only")
    args = parser.parse_args()
    if not 0 < args.depth_buffer <= 1:
        raise SystemExit("--depth-buffer must be > 0 and <= 1")
    bets = load_local(args.input) if args.input else load_via_ssh(args.host, args.identity)
    report = analyze(bets, args.hours, args.depth_buffer)
    if args.json or args.sanitized_json:
        print(json.dumps(sanitized_summary(report) if args.sanitized_json else report, indent=2))
        return
    print(f"Shadow backtest: {report['sample']['distinctMarkets']} mercados")
    for strategy in report["strategies"]:
        holdout = strategy["holdout"]
        print(
            f"{strategy['mode']}: holdout trades={holdout['trades']} "
            f"pnl=${holdout['feeAwarePnlUsd']:+.2f} status={strategy['readiness']['status']}"
        )


if __name__ == "__main__":
    main()

