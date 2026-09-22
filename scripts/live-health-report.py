#!/usr/bin/env python3
"""Sanitized Polymoney health and execution report."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.request import urlopen


DELTA_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*bps", re.I)
ENTRY_RE = re.compile(r"(?:^|\s)T-(\d+)(?=:|\s|$)", re.I)
EXECUTABLE_OUTCOMES = {"filled", "placed", "paper"}
LIVE_OUTCOMES = {"filled", "placed"}


def parse_scalar(raw: str) -> Any:
    value = raw.split(" #", 1)[0].strip().strip('"\'')
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    try:
        return float(value) if "." in value else int(value)
    except ValueError:
        return value


def section_text(config_text: str, section: str) -> str:
    match = re.search(
        rf"^{re.escape(section)}:\s*$\n(?P<body>(?:^[ \t]+.*(?:\n|$)|^\s*$\n)*)",
        config_text,
        re.M,
    )
    return match.group("body") if match else ""


def direct_value(body: str, key: str, default: Any = None) -> Any:
    match = re.search(rf"^  {re.escape(key)}:\s*(.+?)\s*$", body, re.M)
    return parse_scalar(match.group(1)) if match else default


def parse_entry_windows(timing_body: str) -> list[dict[str, Any]]:
    marker = re.search(r"^  entry_windows:\s*$", timing_body, re.M)
    if not marker:
        return []
    windows: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in timing_body[marker.end():].splitlines():
        if line and not line.startswith("    "):
            break
        item = re.match(r"^    -\s+([a-z_]+):\s*(.+?)\s*$", line)
        field = re.match(r"^      ([a-z_]+):\s*(.+?)\s*$", line)
        if item:
            if current:
                windows.append(current)
            current = {item.group(1): parse_scalar(item.group(2))}
        elif field and current is not None:
            current[field.group(1)] = parse_scalar(field.group(2))
    if current:
        windows.append(current)
    return sorted(windows, key=lambda item: item.get("seconds_before_close", 0), reverse=True)


def parse_config_text(config_text: str) -> dict[str, Any]:
    timing = section_text(config_text, "timing")
    strategy = section_text(config_text, "strategy")
    bet = section_text(config_text, "bet")
    staking = section_text(config_text, "staking")
    safety = section_text(config_text, "safety")
    entry_windows = parse_entry_windows(timing)
    return {
        # Compatibility with existing consumers.
        "bet_seconds_before_close": direct_value(timing, "bet_seconds_before_close"),
        "min_delta_bps": direct_value(strategy, "min_delta_bps"),
        "max_price": direct_value(bet, "max_price"),
        "max_stake_usd": direct_value(staking, "max_stake_usd"),
        "max_order_usd": direct_value(safety, "max_order_usd"),
        "size_to_depth": direct_value(safety, "size_to_depth"),
        "use_market_order": direct_value(bet, "use_market_order"),
        "entry_windows": entry_windows,
        "sections": {
            "timing": {
                "betSecondsBeforeClose": direct_value(timing, "bet_seconds_before_close"),
                "entryWindows": entry_windows,
            },
            "strategy": {"minDeltaBps": direct_value(strategy, "min_delta_bps")},
            "bet": {
                "maxPrice": direct_value(bet, "max_price"),
                "useMarketOrder": direct_value(bet, "use_market_order"),
            },
            "staking": {"maxStakeUsd": direct_value(staking, "max_stake_usd")},
            "safety": {
                "maxOrderUsd": direct_value(safety, "max_order_usd"),
                "sizeToDepth": direct_value(safety, "size_to_depth"),
            },
        },
    }


def load_health() -> dict[str, Any] | None:
    # Bounded retries for transient restarts/timeouts. Never export exception text.
    for attempt in range(3):
        try:
            with urlopen("http://127.0.0.1:3000/health", timeout=5) as response:
                data = json.load(response)
                if isinstance(data, dict):
                    return data
        except Exception:
            pass
        if attempt < 2:
            time.sleep(1)
    return None


def load_via_ssh(host: str) -> tuple[list, dict, dict, dict | None]:
    remote = r"""
import json
from pathlib import Path
import runpy
print(Path('/opt/polymoney/data/pnl.json').read_text())
print('---SPLIT---')
sp = Path('/opt/polymoney/data/staking.json')
print(sp.read_text() if sp.exists() else '{}')
print('---SPLIT---')
print(Path('/opt/polymoney/config.yaml').read_text())
print('---SPLIT---')
collector = runpy.run_path('/opt/polymoney/scripts/live-health-report.py')
print(json.dumps(collector['load_health']()))
"""
    proc = subprocess.run(
        ["ssh", host, "python3", "-"],
        input=remote,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise SystemExit(f"ssh failed: {proc.stderr or proc.stdout}")
    pnl_raw, staking_raw, config_raw, health_raw = proc.stdout.split("---SPLIT---")
    return (
        json.loads(pnl_raw)["bets"],
        json.loads(staking_raw.strip() or "{}"),
        parse_config_text(config_raw),
        json.loads(health_raw.strip() or "null"),
    )


def load_local(root: Path) -> tuple[list, dict, dict, dict | None]:
    bets = json.loads((root / "data/pnl.json").read_text())["bets"]
    staking_path = root / "data/staking.json"
    staking = json.loads(staking_path.read_text()) if staking_path.exists() else {}
    cfg = parse_config_text((root / "config.yaml").read_text())
    return bets, staking, cfg, load_health()


def classify_fail(error: str | None) -> str:
    value = (error or "").lower()
    if any(term in value for term in (
        "book has no asks",
        "empty sides",
        "no resting",
        "no orders found",
        "no liquidity on side",
        "no liquidity",
    )):
        return "no_liquidity"
    if (
        "best ask" in value
        and ("max_price" in value or "max price" in value)
    ) or (
        "price" in value
        and "above max_price" in value
    ):
        return "price_above_limit"
    if any(term in value for term in (
        "insufficient depth",
        "minimum order does not fit",
        "min. order does not fit",
    )):
        return "insufficient_depth"
    if any(term in value for term in ("max_price", "max price", "depth", "usable liquidity")):
        return "depth_or_max_price"
    if any(term in value for term in ("liquidity", "no liquidity")):
        return "no_liquidity"
    if "invalid amounts" in value or "quantiz" in value:
        return "invalid_amounts"
    if any(term in value for term in ("feed", "chainlink", "price unavailable", "stale")):
        return "feed_unavailable"
    if any(term in value for term in ("max_order_usd", "max_total_usd", "limit", "circuit breaker")):
        return "risk_limit"
    if any(term in value for term in ("unauthor", "signature", "wallet", "allowance", "insufficient funds", "balance")):
        return "auth_or_wallet"
    if any(term in value for term in ("timeout", "timed out", "fetch failed", "network", "socket", "econn", "http ")):
        return "network_or_api"
    if any(term in value for term in ("rejected", "order failed", "clob")):
        return "clob_rejected"
    return "unknown"


PRICE_ABOVE_RE = re.compile(
    r"best ask\s+([0-9]+(?:\.[0-9]+)?)\s*>\s*(?:max_price|max price)\s+([0-9]+(?:\.[0-9]+)?)",
    re.IGNORECASE,
)


def price_distance_bucket(error: str | None) -> str | None:
    match = PRICE_ABOVE_RE.search(error or "")
    if not match:
        return None
    distance = float(match.group(1)) - float(match.group(2))
    if distance <= 0.01 + 1e-9:
        return "lte_0_01"
    if distance <= 0.03 + 1e-9:
        return "gt_0_01_lte_0_03"
    if distance <= 0.05 + 1e-9:
        return "gt_0_03_lte_0_05"
    return "gt_0_05"


def parse_time(raw: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat((raw or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def entry_seconds(attempt: dict[str, Any]) -> int | None:
    value = attempt.get("entrySecondsBeforeClose")
    if isinstance(value, (int, float)):
        return int(value)
    match = ENTRY_RE.search(attempt.get("strategyReason") or "")
    return int(match.group(1)) if match else None


def attempts_for_bet(bet: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    history = bet.get("attemptHistory")
    if isinstance(history, list) and history:
        return [item for item in history if isinstance(item, dict)], False
    return [{
        "attemptedAt": bet.get("placedAt"),
        "outcome": bet.get("outcome"),
        "entrySecondsBeforeClose": entry_seconds(bet),
        "side": bet.get("side"),
        "price": bet.get("price"),
        "size": bet.get("size"),
        "filledSize": bet.get("filledSize"),
        "filledCost": bet.get("filledCost"),
        "platformFee": bet.get("platformFee"),
        "totalCost": bet.get("totalCost"),
        "strategyReason": bet.get("strategyReason"),
        "error": bet.get("error"),
    }], True


def threshold_for(cfg: dict[str, Any], seconds: int | None) -> float:
    for window in cfg.get("entry_windows", []):
        if window.get("seconds_before_close") == seconds:
            return float(window.get("min_delta_bps") or cfg.get("min_delta_bps") or 0)
    return float(cfg.get("min_delta_bps") or 0)


def build_entry_window_metrics(
    recent: list[dict[str, Any]],
    cfg: dict[str, Any],
    cutoff: datetime,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    def new_bucket() -> dict[str, Any]:
        return {
        "attempts": 0,
        "filled": 0,
        "paper": 0,
        "failed": 0,
        "unfilled": 0,
        "skipped": 0,
        "attemptsWithSide": 0,
        "resolvedFills": 0,
        "wins": 0,
        "losses": 0,
        "totalPnlUsd": 0.0,
        "totalCostUsd": 0.0,
        "totalFeesUsd": 0.0,
        "fillPrices": [],
        "fails": Counter(),
        "priceDistanceBuckets": Counter(),
        "signalSamples": 0,
        "feedUnavailableAttempts": 0,
        }

    buckets: dict[str, dict[str, Any]] = defaultdict(new_bucket)
    fresh_buckets: dict[str, dict[str, Any]] = defaultdict(new_bucket)
    legacy_buckets: dict[str, dict[str, Any]] = defaultdict(new_bucket)
    legacy_records = 0
    fresh_records = 0
    latest_signal_at: str | None = None
    total_signal_samples = 0
    fresh_signal_samples = 0
    total_feed_unavailable = 0
    fresh_feed_unavailable = 0

    def add_attempt(
        bucket: dict[str, Any],
        attempt: dict[str, Any],
        bet: dict[str, Any],
    ) -> tuple[str | None, bool]:
        outcome = attempt.get("outcome") or "failed"
        if outcome == "placed":
            outcome = "filled"
        bucket["attempts"] += 1
        bucket[outcome if outcome in {"filled", "paper", "failed", "unfilled", "skipped"} else "failed"] += 1
        if outcome in EXECUTABLE_OUTCOMES | {"failed", "unfilled"}:
            bucket["attemptsWithSide"] += 1
        category: str | None = None
        if outcome == "failed":
            category = classify_fail(attempt.get("error"))
            bucket["fails"][category] += 1
            if category == "price_above_limit":
                distance_bucket = price_distance_bucket(attempt.get("error"))
                if distance_bucket:
                    bucket["priceDistanceBuckets"][distance_bucket] += 1
            if category == "feed_unavailable":
                bucket["feedUnavailableAttempts"] += 1
        has_signal = bool(DELTA_RE.search(attempt.get("strategyReason") or ""))
        if has_signal:
            bucket["signalSamples"] += 1
        if outcome in EXECUTABLE_OUTCOMES:
            price = float(attempt.get("price") or 0)
            if price > 0:
                bucket["fillPrices"].append(price)
            if bet.get("resolved"):
                bucket["resolvedFills"] += 1
                bucket["wins"] += int(bet.get("won") is True)
                bucket["losses"] += int(bet.get("won") is False)
                bucket["totalPnlUsd"] += float(bet.get("pnl") or 0)
                bucket["totalCostUsd"] += float(
                    bet.get("totalCost") or bet.get("filledCost") or bet.get("cost") or 0
                )
                bucket["totalFeesUsd"] += float(bet.get("platformFee") or 0)
        return category, has_signal

    for bet in recent:
        attempts, legacy = attempts_for_bet(bet)
        legacy_records += int(legacy)
        fresh_records += int(not legacy)
        for attempt in attempts:
            attempted_at = parse_time(attempt.get("attemptedAt"))
            if attempted_at is not None and attempted_at < cutoff:
                continue
            seconds = entry_seconds(attempt)
            key = f"T-{seconds}" if seconds is not None else "unknown"
            category, has_signal = add_attempt(buckets[key], attempt, bet)
            cohort_bucket = legacy_buckets[key] if legacy else fresh_buckets[key]
            add_attempt(cohort_bucket, attempt, bet)
            if category == "feed_unavailable":
                total_feed_unavailable += 1
                if not legacy:
                    fresh_feed_unavailable += 1
            if has_signal:
                total_signal_samples += 1
                if not legacy:
                    fresh_signal_samples += 1
                raw_at = attempt.get("attemptedAt")
                if raw_at and (latest_signal_at is None or raw_at > latest_signal_at):
                    latest_signal_at = raw_at

    config_by_t = {
        int(window["seconds_before_close"]): window
        for window in cfg.get("entry_windows", [])
        if isinstance(window.get("seconds_before_close"), (int, float))
    }
    order = sorted(
        set(buckets) | set(fresh_buckets) | set(legacy_buckets),
        key=lambda key: -int(key[2:]) if key.startswith("T-") else 10**9,
    )

    def finalize_bucket(bucket: dict[str, Any], key: str) -> dict[str, Any]:
        bucket = {
            **bucket,
            "fillPrices": list(bucket["fillPrices"]),
            "fails": Counter(bucket["fails"]),
            "priceDistanceBuckets": Counter(bucket["priceDistanceBuckets"]),
        }
        seconds = int(key[2:]) if key.startswith("T-") else None
        side_attempts = bucket["attemptsWithSide"]
        executed = bucket["filled"] + bucket["paper"]
        config_window = config_by_t.get(seconds or -1, {})
        prices = bucket.pop("fillPrices")
        bucket["fails"] = dict(bucket["fails"])
        bucket["priceDistanceBuckets"] = dict(bucket["priceDistanceBuckets"])
        bucket.update({
            "entry": key,
            "secondsBeforeClose": seconds,
            "configuredMinDeltaBps": config_window.get("min_delta_bps"),
            "configuredMaxPrice": config_window.get("max_price", cfg.get("max_price")),
            "fillRate": executed / side_attempts if side_attempts else None,
            "averageFillPrice": round(sum(prices) / len(prices), 4) if prices else None,
            "winRate": (
                bucket["wins"] / bucket["resolvedFills"]
                if bucket["resolvedFills"] else None
            ),
            "totalPnlUsd": round(bucket["totalPnlUsd"], 2),
            "totalCostUsd": round(bucket["totalCostUsd"], 2),
            "totalFeesUsd": round(bucket["totalFeesUsd"], 2),
        })
        return bucket

    output = []
    for key in order:
        bucket = finalize_bucket(buckets[key], key)
        bucket["freshCohort"] = finalize_bucket(fresh_buckets[key], key)
        bucket["legacyCohort"] = finalize_bucket(legacy_buckets[key], key)
        output.append(bucket)
    return output, {
        "attributionBasis": "attempt_history_per_entry_window",
        "legacyRecordsWithoutAttemptHistory": legacy_records,
        "freshRecordsWithAttemptHistory": fresh_records,
        "signalSamples": total_signal_samples,
        "freshSignalSamples": fresh_signal_samples,
        "feedUnavailableAttempts": total_feed_unavailable,
        "freshFeedUnavailableAttempts": fresh_feed_unavailable,
        "latestSignalAt": latest_signal_at,
    }


def build_shadow_execution_metrics(
    recent: list[dict[str, Any]],
    cutoff: datetime,
) -> list[dict[str, Any]]:
    buckets: dict[str, dict[int, dict[str, Any]]] = defaultdict(
        lambda: defaultdict(lambda: {
            "observations": 0,
            "fullyFillable": 0,
            "fillableShares": 0.0,
            "fillableCostUsd": 0.0,
            "estimatedFeesUsd": 0.0,
            "breakEvenValues": [],
            "reasons": Counter(),
            "maxPrice": None,
        })
    )

    for bet in recent:
        attempts, _ = attempts_for_bet(bet)
        for attempt in attempts:
            attempted_at = parse_time(attempt.get("attemptedAt"))
            if attempted_at is None or attempted_at < cutoff:
                continue
            seconds = entry_seconds(attempt)
            shadow = attempt.get("shadowLiquidity")
            if seconds is None or not isinstance(shadow, dict):
                continue
            levels = shadow.get("levels")
            if not isinstance(levels, list):
                continue
            entry = f"T-{seconds}"
            for level in levels:
                if not isinstance(level, dict):
                    continue
                offset = level.get("offsetCents")
                if not isinstance(offset, (int, float)):
                    continue
                bucket = buckets[entry][int(offset)]
                bucket["observations"] += 1
                bucket["fullyFillable"] += int(level.get("fullyFillable") is True)
                bucket["fillableShares"] += float(level.get("fillableShares") or 0)
                bucket["fillableCostUsd"] += float(level.get("fillableCostUsd") or 0)
                bucket["estimatedFeesUsd"] += float(level.get("estimatedFeesUsd") or 0)
                break_even = level.get("feeAwareBreakEvenProbability")
                if isinstance(break_even, (int, float)):
                    bucket["breakEvenValues"].append(float(break_even))
                bucket["reasons"][str(level.get("reason") or "unknown")] += 1
                max_price = level.get("maxPrice")
                if isinstance(max_price, (int, float)):
                    bucket["maxPrice"] = float(max_price)

    output: list[dict[str, Any]] = []
    for entry in sorted(buckets, key=lambda key: -int(key[2:])):
        levels = []
        for offset, bucket in sorted(buckets[entry].items()):
            observations = bucket["observations"]
            break_even_values = bucket.pop("breakEvenValues")
            levels.append({
                "offsetCents": offset,
                "maxPrice": bucket["maxPrice"],
                "observations": observations,
                "fullyFillable": bucket["fullyFillable"],
                "fullyFillableRate": (
                    bucket["fullyFillable"] / observations if observations else None
                ),
                "averageFillableShares": round(
                    bucket["fillableShares"] / observations, 4
                ) if observations else None,
                "averageFillableCostUsd": round(
                    bucket["fillableCostUsd"] / observations, 4
                ) if observations else None,
                "averageEstimatedFeesUsd": round(
                    bucket["estimatedFeesUsd"] / observations, 4
                ) if observations else None,
                "averageFeeAwareBreakEvenProbability": round(
                    sum(break_even_values) / len(break_even_values), 6
                ) if break_even_values else None,
                "reasons": dict(bucket["reasons"]),
            })
        output.append({"entry": entry, "levels": levels})
    return output


def build_execution_correlation_metrics(
    recent: list[dict[str, Any]],
    cutoff: datetime,
) -> dict[str, Any]:
    """Aggregate only sanitized, per-submission correlation traces."""
    traces: list[dict[str, Any]] = []
    for bet in recent:
        attempts, _ = attempts_for_bet(bet)
        for attempt in attempts:
            attempted_at = parse_time(attempt.get("attemptedAt"))
            trace = attempt.get("executionCorrelation")
            if attempted_at is None or attempted_at < cutoff or not isinstance(trace, dict):
                continue
            traces.append(trace)

    categories = Counter(str(trace.get("resultCategory") or "unknown") for trace in traces)
    reasons = Counter(str(trace.get("reasonCode") or "unknown") for trace in traces)
    snapshot_ages = [
        float(trace["snapshotAgeMsAtSubmit"])
        for trace in traces
        if isinstance(trace.get("snapshotAgeMsAtSubmit"), (int, float))
    ]
    submission_times = [
        float(trace["submissionElapsedMs"])
        for trace in traces
        if isinstance(trace.get("submissionElapsedMs"), (int, float))
    ]
    shadow_fillable = sum(trace.get("shadowFullyFillable") is True for trace in traces)
    shadow_fillable_rejected = sum(
        trace.get("shadowFullyFillable") is True
        and trace.get("resultCategory") not in ("filled", "unfilled")
        for trace in traces
    )

    return {
        "observations": len(traces),
        "categories": dict(categories),
        "reasonCodes": dict(reasons),
        "averageSnapshotAgeMsAtSubmit": round(sum(snapshot_ages) / len(snapshot_ages), 1)
        if snapshot_ages else None,
        "maxSnapshotAgeMsAtSubmit": round(max(snapshot_ages), 1) if snapshot_ages else None,
        "averageSubmissionElapsedMs": round(sum(submission_times) / len(submission_times), 1)
        if submission_times else None,
        "shadowFullyFillable": shadow_fillable,
        "shadowFillableButRejected": shadow_fillable_rejected,
        "diagnosticBasis": "sanitized_per_attempt_snapshot_to_clob_submission",
    }


def build_shadow_strategy_metrics(
    recent: list[dict[str, Any]],
    cutoff: datetime,
) -> list[dict[str, Any]]:
    """Aggregate parallel strategy evaluations; these observations never represent orders."""
    buckets: dict[tuple[str, str], dict[str, Any]] = defaultdict(lambda: {
        "observations": 0,
        "signals": 0,
        "fullyFillable": 0,
        "sides": Counter(),
        "liquidityReasons": Counter(),
        "fees": [],
        "breakEven": [],
        "resolvedSignals": 0,
        "wins": 0,
        "losses": 0,
        "hypotheticalTrades": 0,
        "hypotheticalPnlUsd": 0.0,
    })
    for bet in recent:
        attempts, _ = attempts_for_bet(bet)
        for attempt in attempts:
            attempted_at = parse_time(attempt.get("attemptedAt"))
            if attempted_at is None or attempted_at < cutoff:
                continue
            evaluations = attempt.get("shadowStrategies")
            if not isinstance(evaluations, list):
                continue
            for evaluation in evaluations:
                if not isinstance(evaluation, dict):
                    continue
                mode = str(evaluation.get("mode") or evaluation.get("name") or "unknown")
                seconds = evaluation.get("entrySecondsBeforeClose")
                entry = f"T-{int(seconds)}" if isinstance(seconds, (int, float)) else "unknown"
                bucket = buckets[(mode, entry)]
                bucket["observations"] += 1
                side = evaluation.get("side")
                if side in ("up", "down"):
                    bucket["signals"] += 1
                    bucket["sides"][side] += 1
                bucket["fullyFillable"] += int(evaluation.get("fullyFillable") is True)
                bucket["liquidityReasons"][str(evaluation.get("liquidityReason") or "unknown")] += 1
                fee = evaluation.get("estimatedFeesUsd")
                if isinstance(fee, (int, float)):
                    bucket["fees"].append(float(fee))
                break_even = evaluation.get("feeAwareBreakEvenProbability")
                if isinstance(break_even, (int, float)):
                    bucket["breakEven"].append(float(break_even))
                won = evaluation.get("won")
                if evaluation.get("resolved") is True and isinstance(won, bool):
                    bucket["resolvedSignals"] += 1
                    bucket["wins" if won else "losses"] += 1
                hypothetical_pnl = evaluation.get("hypotheticalPnlUsd")
                if isinstance(hypothetical_pnl, (int, float)):
                    bucket["hypotheticalTrades"] += 1
                    bucket["hypotheticalPnlUsd"] += float(hypothetical_pnl)

    output = []
    for (mode, entry), bucket in sorted(buckets.items()):
        observations = bucket["observations"]
        output.append({
            "mode": mode,
            "entry": entry,
            "observations": observations,
            "signals": bucket["signals"],
            "signalRate": bucket["signals"] / observations if observations else None,
            "fullyFillable": bucket["fullyFillable"],
            "fullyFillableRate": bucket["fullyFillable"] / observations if observations else None,
            "sides": dict(bucket["sides"]),
            "liquidityReasons": dict(bucket["liquidityReasons"]),
            "averageEstimatedFeesUsd": round(sum(bucket["fees"]) / len(bucket["fees"]), 4)
            if bucket["fees"] else None,
            "averageFeeAwareBreakEvenProbability": round(
                sum(bucket["breakEven"]) / len(bucket["breakEven"]), 6
            ) if bucket["breakEven"] else None,
            "resolvedSignals": bucket["resolvedSignals"],
            "wins": bucket["wins"],
            "losses": bucket["losses"],
            "winRate": bucket["wins"] / bucket["resolvedSignals"]
            if bucket["resolvedSignals"] else None,
            "hypotheticalTrades": bucket["hypotheticalTrades"],
            "hypotheticalPnlUsd": round(bucket["hypotheticalPnlUsd"], 4),
            "orderSubmission": False,
        })
    return output


def analyze(
    bets: list,
    staking: dict,
    cfg: dict,
    hours: float,
    operational: dict[str, Any] | None = None,
) -> dict:
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=hours)
    recent = [bet for bet in bets if (parse_time(bet.get("placedAt")) or datetime.min.replace(tzinfo=timezone.utc)) >= cutoff]
    outcomes = Counter(bet.get("outcome") for bet in recent)
    # Shadow observations are stored as skipped markets with no primary side.
    # They are not failed strategy signals or order attempts.
    shadow_only = sum(
        bet.get("outcome") == "skipped"
        and bool(bet.get("attemptHistory"))
        and all(re.search(r"(?:^|\s)shadow_[a-z_]+:", attempt.get("strategyReason") or "")
                for attempt in bet["attemptHistory"])
        for bet in recent
    )
    fails = Counter(
        classify_fail(bet.get("error"))
        for bet in recent
        if bet.get("outcome") == "failed"
    )
    near_skips = 0
    for bet in recent:
        if bet.get("outcome") != "skipped":
            continue
        match = DELTA_RE.search(bet.get("strategyReason") or "")
        seconds = entry_seconds(bet)
        if match and 5.5 <= abs(float(match.group(1))) < threshold_for(cfg, seconds):
            near_skips += 1

    entries = [
        bet for bet in recent
        if bet.get("outcome") in EXECUTABLE_OUTCOMES and bet.get("resolved")
    ]
    wins = sum(bet.get("won") is True for bet in entries)
    losses = sum(bet.get("won") is False for bet in entries)
    pnl = sum(float(bet.get("pnl") or 0) for bet in entries)
    cost = sum(float(bet.get("totalCost") or bet.get("filledCost") or bet.get("cost") or 0) for bet in entries)
    fees = sum(float(bet.get("platformFee") or 0) for bet in entries)
    live_filled = sum(outcomes.get(outcome, 0) for outcome in LIVE_OUTCOMES)
    paper_filled = outcomes.get("paper", 0)
    executed = live_filled + paper_filled
    attempts_side = executed + outcomes.get("failed", 0) + outcomes.get("unfilled", 0)
    fill_rate = executed / attempts_side if attempts_side else None
    window_metrics, feed_evidence = build_entry_window_metrics(recent, cfg, cutoff)
    shadow_execution = build_shadow_execution_metrics(recent, cutoff)
    execution_correlation = build_execution_correlation_metrics(recent, cutoff)
    shadow_strategies = build_shadow_strategy_metrics(recent, cutoff)

    suggestions: list[dict[str, Any]] = []
    for window in window_metrics:
        fresh = window["freshCohort"]
        actionable_failures = {
            category: fresh["fails"].get(category, 0)
            for category in (
                "price_above_limit",
                "insufficient_depth",
                "no_liquidity",
                "depth_or_max_price",
            )
            if fresh["fails"].get(category, 0)
        }
        depth_fails = sum(actionable_failures.values())
        if (
            fresh["attemptsWithSide"] >= 8
            and fresh["fillRate"] is not None
            and fresh["fillRate"] < 0.35
            and depth_fails >= 4
        ):
            failure_detail = ", ".join(
                f"{category}={count}"
                for category, count in actionable_failures.items()
            )
            suggestions.append({
                "priority": "high",
                "issue": "fill_rate_baixa_por_janela",
                "entry": window["entry"],
                "evidenceCohort": "fresh_attempt_history",
                "detail": (
                    f"fill_rate fresh={fresh['fillRate']:.0%} with "
                    f"{depth_fails} failures ({failure_detail})"
                ),
                "actions": ["compare this window with the others before changing a single parameter"],
            })
    current_feed = (operational or {}).get("feed")
    if isinstance(current_feed, dict) and current_feed.get("chainlinkStale"):
        suggestions.append({
            "priority": "high",
            "issue": "chainlink_stale",
            "detail": f"stale for {current_feed.get('chainlinkStaleForSeconds')}s",
            "actions": ["diagnose the feed before changing strategy"],
        })
    if fails.get("unknown", 0):
        suggestions.append({
            "priority": "medium",
            "issue": "falhas_nao_classificadas",
            "detail": f"{fails['unknown']} failures without a known category",
            "actions": ["add a sanitized category before adjusting strategy"],
        })
    if losses >= 2 and wins + losses >= 5 and wins / (wins + losses) < 0.9:
        suggestions.append({
            "priority": "high",
            "issue": "wr_a_cair",
            "detail": f"WR={wins}/{wins + losses}",
            "actions": ["protect edge; do not increase stake or price without analysis"],
        })
    if not suggestions and attempts_side >= 5 and fill_rate is not None and fill_rate >= 0.5:
        suggestions.append({
            "priority": "low",
            "issue": "estavel",
            "detail": "no adjustment needed",
            "actions": ["keep configuration"],
        })

    return {
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "windowHours": hours,
        "config": cfg,
        "operational": {
            "status": (operational or {}).get("status"),
            "tradingActive": (operational or {}).get("tradingActive"),
            "uptimeSeconds": (operational or {}).get("uptime"),
        },
        "feed": {"current": current_feed, "windowEvidence": feed_evidence},
        "staking": {
            "seriesBankroll": staking.get("seriesBankroll"),
            "pendingRecoveryUsd": staking.get("pendingRecoveryUsd"),
        },
        "counts": {
            "attempts": len(recent),
            "shadowOnlyMarkets": shadow_only,
            "primaryAttemptMarkets": len(recent) - shadow_only,
            "filled": live_filled,
            "paper": paper_filled,
            "executed": executed,
            "failed": outcomes.get("failed", 0),
            "skipped": outcomes.get("skipped", 0),
            "unfilled": outcomes.get("unfilled", 0),
            "attemptsWithSide": attempts_side,
            "nearSkips": near_skips,
        },
        "fails": dict(fails),
        "entryWindows": window_metrics,
        "shadowExecution": shadow_execution,
        "executionCorrelation": execution_correlation,
        "shadowStrategies": shadow_strategies,
        "pnl": {
            "resolvedFills": len(entries),
            "liveResolvedFills": sum(bet.get("outcome") in LIVE_OUTCOMES for bet in entries),
            "paperResolvedFills": sum(bet.get("outcome") == "paper" for bet in entries),
            "wins": wins,
            "losses": losses,
            "winRate": wins / (wins + losses) if wins + losses else None,
            "totalPnlUsd": round(pnl, 2),
            "totalCostUsd": round(cost, 2),
            "totalFeesUsd": round(fees, 2),
            "fillRate": fill_rate,
            "fillRateBasis": "final_market_outcome",
        },
        "suggestions": suggestions,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hours", type=float, default=4)
    parser.add_argument("--local", type=str, default="")
    parser.add_argument("--host", type=str, default="", help="Explicit SSH destination; required without --local")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.local:
        bets, staking, cfg, operational = load_local(Path(args.local))
    else:
        if not args.host:
            parser.error("provide --local or an explicit --host")
        bets, staking, cfg, operational = load_via_ssh(args.host)
    report = analyze(bets, staking, cfg, args.hours, operational)
    if args.json:
        print(json.dumps(report, indent=2))
        return

    pnl = report["pnl"]
    counts = report["counts"]
    print(f"Polymoney live health — last {args.hours:g}h @ {report['generatedAt']}")
    print(f"operational: {report['operational']}")
    print(f"feed: {report['feed']}")
    print(f"config: {report['config']}")
    print(
        f"counts: attempts={counts['attempts']} filled={counts['filled']} "
        f"failed={counts['failed']} skipped={counts['skipped']} "
        f"sideAttempts={counts['attemptsWithSide']}"
    )
    print(f"fails: {report['fails']}")
    print(f"entryWindows: {report['entryWindows']}")
    wr = f"{pnl['winRate'] * 100:.1f}%" if pnl["winRate"] is not None else "n/a"
    fr = f"{pnl['fillRate'] * 100:.1f}%" if pnl["fillRate"] is not None else "n/a"
    print(
        f"pnl: fills={pnl['resolvedFills']} W/L={pnl['wins']}/{pnl['losses']} "
        f"WR={wr} fillRate={fr} pnl=${pnl['totalPnlUsd']:+.2f}"
    )


if __name__ == "__main__":
    main()
