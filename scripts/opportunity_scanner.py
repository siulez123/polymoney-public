#!/usr/bin/env python3
"""Public-data YES/NO scanner. No wallet, order API, local P&L or trading config.

Only aggregate output leaves the process. Snapshots are indicative, not fills.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING
import json
import time
import urllib.error
import urllib.request

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
D = Decimal
PAIR_BUDGET = D("20")  # hypothetical combined cost; never submitted
DEPTH_BUFFER = D("0.9")
SLIPPAGE_BPS = D("20")
FIXED_COST_RESERVE = D("0.10")  # sensitivity assumption, not measured merge/gas cost
MIN_NET = D("0.01")
MAX_BOOK_AGE_SECONDS = 10
MAX_BOOK_SKEW_SECONDS = 1
MAX_FETCH_SECONDS = 3
MAX_SHARES = 100
REASONS = {
    "market_ineligible", "unsupported_market_type", "invalid_tokens", "unknown_fees",
    "unknown_minimum", "ended", "missing_book", "invalid_book", "stale_book",
    "asynchronous_books", "slow_snapshot", "insufficient_depth_or_budget",
    "no_net_edge", "rate_limited", "network_error", "invalid_response", "deadline",
}


class Unavailable(Exception):
    def __init__(self, reason):
        self.reason = reason if reason in REASONS else "invalid_response"
        super().__init__(self.reason)


def number(value):
    if value is None or isinstance(value, bool):
        raise ValueError("missing number")
    result = D(str(value))
    if not result.is_finite():
        raise ValueError("nonfinite number")
    return result


def timestamp(value):
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timezone required")
    return parsed.timestamp()


def array(value):
    return json.loads(value) if isinstance(value, str) else value


def market_spec(market, now):
    if not isinstance(market, dict):
        raise Unavailable("invalid_response")
    if not all(market.get(k) is True for k in ("active", "acceptingOrders", "enableOrderBook")) or market.get("closed") is not False:
        raise Unavailable("market_ineligible")
    # Cross-event baskets/adapters need separate rule and completeness validation.
    if market.get("negRisk") is not False:
        raise Unavailable("unsupported_market_type")
    try:
        end = timestamp(market["endDate"])
        if end <= now + 60:
            raise Unavailable("ended")
        tokens, outcomes = array(market["clobTokenIds"]), array(market["outcomes"])
        if not isinstance(tokens, list) or not isinstance(outcomes, list) or len(tokens) != 2 or len(outcomes) != 2:
            raise ValueError("not binary")
        if tokens[0] == tokens[1] or not all(isinstance(t, str) and t.isdigit() for t in tokens):
            raise ValueError("bad tokens")
        if not all(isinstance(o, str) and o.strip() for o in outcomes) or outcomes[0] == outcomes[1]:
            raise ValueError("bad outcomes")
        condition = market["conditionId"]
        if not isinstance(condition, str) or len(condition) != 66 or not condition.startswith("0x") or any(c not in "0123456789abcdefABCDEF" for c in condition[2:]):
            raise ValueError("bad condition")
    except (KeyError, TypeError, ValueError):
        raise Unavailable("invalid_tokens") from None
    try:
        minimum = number(market.get("orderMinSize"))
        if minimum <= 0:
            raise ValueError("bad minimum")
    except (ValueError, InvalidOperation):
        raise Unavailable("unknown_minimum") from None
    try:
        if market.get("feesEnabled") is False:
            rate = D(0)
        elif market.get("feesEnabled") is True:
            schedule = market.get("feeSchedule") or {}
            rate = number(schedule.get("rate"))
            if number(schedule.get("exponent")) != 1 or not 0 <= rate <= 1 or schedule.get("takerOnly") is not True:
                raise ValueError("unsupported fee curve")
        else:
            raise ValueError("unknown fee flag")
    except (ValueError, InvalidOperation, AttributeError):
        raise Unavailable("unknown_fees") from None
    return {"key": condition, "tokens": tokens, "end": end,
            "minimumNotional": minimum, "rate": rate}


def read_book(book, token, condition, now):
    if book is None:
        raise Unavailable("missing_book")
    try:
        if book.get("asset_id") != token or book.get("market") != condition or book.get("neg_risk") is not False:
            raise ValueError("identity mismatch")
        at = float(number(book["timestamp"]) / 1000)
        minimum = number(book["min_order_size"])
        if minimum <= 0:
            raise ValueError("minimum")
        levels = []
        if not isinstance(book["asks"], list):
            raise ValueError("asks")
        for level in book["asks"]:
            price, size = number(level["price"]), number(level["size"])
            if not 0 < price < 1 or size <= 0:
                raise ValueError("level")
            levels.append((price, size * DEPTH_BUFFER))
        # API does not promise ascending ask order.
        levels.sort()
        if len({price for price, _ in levels}) != len(levels):
            raise ValueError("duplicate depth")
    except (KeyError, TypeError, ValueError, InvalidOperation, AttributeError, OverflowError):
        raise Unavailable("invalid_book") from None
    if now - at > MAX_BOOK_AGE_SECONDS or at - now > 1:
        raise Unavailable("stale_book")
    return levels, minimum, at


def quote(levels, shares, rate):
    remaining, cost, fees = shares, D(0), D(0)
    for price, available in levels:
        take = min(remaining, available)
        cost += take * price
        # Round each level upwards: a conservative bound on exchange rounding.
        fees += (take * rate * price * (1 - price)).quantize(D("0.00001"), rounding=ROUND_CEILING)
        remaining -= take
        if remaining == 0:
            return cost, fees
    return None


def evaluate_pair(spec, books, now, fetch_seconds):
    if spec["end"] <= now + 60:
        raise Unavailable("ended")
    if fetch_seconds > MAX_FETCH_SECONDS:
        raise Unavailable("slow_snapshot")
    first, second = [read_book(books.get(t), t, spec["key"], now) for t in spec["tokens"]]
    if abs(first[2] - second[2]) > MAX_BOOK_SKEW_SECONDS:
        raise Unavailable("asynchronous_books")
    best = None
    minimum_shares = max(first[1], second[1]).to_integral_value(rounding=ROUND_CEILING)
    for integer in range(int(minimum_shares), MAX_SHARES + 1):
        shares = D(integer)
        legs = [quote(book[0], shares, spec["rate"]) for book in (first, second)]
        if any(leg is None for leg in legs):
            break
        if any(leg[0] < spec["minimumNotional"] for leg in legs):
            continue
        cost, fees = sum(leg[0] for leg in legs), sum(leg[1] for leg in legs)
        reserve = FIXED_COST_RESERVE + cost * SLIPPAGE_BPS / 10000
        total = cost + fees + reserve
        if total > PAIR_BUDGET:
            break
        result = {"shares": shares, "costUsd": cost, "feesUsd": fees,
                  "costReserveUsd": reserve, "totalCostUsd": total,
                  "grossEdgeUsd": shares - cost, "netEdgeUsd": shares - total,
                  "roi": (shares - total) / total,
                  "maximumUnhedgedLegCostUsd": max(leg[0] + leg[1] for leg in legs)}
        if best is None or result["netEdgeUsd"] > best["netEdgeUsd"]:
            best = result
    if best is None:
        raise Unavailable("insufficient_depth_or_budget")
    return best


class PublicApi:
    """Hardcoded public reads only. POST /books is a public batch read."""
    def __init__(self, deadline):
        self.deadline = deadline

    def get(self, path, body=None):
        if path.startswith("/markets?") and body is None:
            url = GAMMA + path
        elif path == "/books" and isinstance(body, list):
            url = CLOB + path
        else:
            raise Unavailable("invalid_response")
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise Unavailable("deadline")
        request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
            headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=min(15, remaining)) as response:
                raw = response.read(8_000_001)
                if len(raw) > 8_000_000:
                    raise Unavailable("invalid_response")
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            raise Unavailable("rate_limited" if error.code == 429 else "network_error") from None
        except (OSError, ValueError):
            raise Unavailable("network_error") from None


class Evidence:
    def __init__(self, interval):
        self.interval = interval
        self.reasons = Counter()
        self.observations = self.evaluated = self.positive = self.episodes = self.repeated = 0
        self.positive_markets = set()
        self.active = {}
        self.longest = 0.0
        self.peak = None

    def observe(self, key, at, result=None, reason=None):
        self.observations += 1
        if reason:
            self.reasons[reason if reason in REASONS else "invalid_response"] += 1
        else:
            self.evaluated += 1
        if result is None or result["netEdgeUsd"] < MIN_NET:
            self.active.pop(key, None)
            if not reason:
                self.reasons["no_net_edge"] += 1
            return
        self.positive += 1
        self.positive_markets.add(key)
        previous = self.active.get(key)
        if previous is None or not 0 < at - previous["last"] <= self.interval * 2:
            previous = {"first": at, "last": at, "count": 0}
            self.episodes += 1
        previous["count"] += 1
        if previous["count"] == 2:
            self.repeated += 1
        previous["last"] = at
        self.active[key] = previous
        self.longest = max(self.longest, at - previous["first"])
        if self.peak is None or result["netEdgeUsd"] > self.peak["netEdgeUsd"]:
            self.peak = result

    def summary(self):
        # Explicit allowlist: never export keys, token IDs, questions or books.
        metric_keys = ("shares", "costUsd", "feesUsd", "costReserveUsd", "totalCostUsd",
                       "grossEdgeUsd", "netEdgeUsd", "roi", "maximumUnhedgedLegCostUsd")
        return {"pairObservations": self.observations, "evaluatedPairs": self.evaluated,
                "positivePairObservations": self.positive, "distinctPositiveMarkets": len(self.positive_markets),
                "opportunityEpisodes": self.episodes, "repeatedEpisodes": self.repeated,
                "longestObservedSpanSeconds": round(self.longest, 3),
                "positiveObservationRate": round(self.positive / self.evaluated, 6) if self.evaluated else None,
                "rejections": {k: self.reasons[k] for k in sorted(REASONS) if self.reasons[k]},
                "peakIndicativeOpportunity": {k: round(float(self.peak[k]), 6) for k in metric_keys} if self.peak else None}


def scan(max_markets=60, samples=12, interval=5):
    started = datetime.now(timezone.utc)
    begin = time.monotonic()
    api = PublicApi(begin + 150)  # keeps collection within workflow timeout
    evidence = Evidence(interval)
    selected, seen, discovery_reasons = [], set(), Counter()
    discovered = rounds = 0
    errors = Counter()
    try:
        for page in range(3):
            markets = api.get(f"/markets?active=true&closed=false&limit=100&offset={page * 100}&order=volume24hr&ascending=false")
            if not isinstance(markets, list):
                raise Unavailable("invalid_response")
            for market in markets:
                discovered += 1
                try:
                    spec = market_spec(market, time.time())
                    if spec["key"] in seen:
                        continue
                    seen.add(spec["key"])
                    selected.append(spec)
                except Unavailable as error:
                    discovery_reasons[error.reason] += 1
                if len(selected) == max_markets:
                    break
            if len(selected) == max_markets or len(markets) < 100:
                break
        for sample in range(samples if selected else 0):
            round_start = time.monotonic()
            for offset in range(0, len(selected), 20):
                batch = selected[offset:offset + 20]
                try:
                    fetch_start = time.monotonic()
                    raw = api.get("/books", [{"token_id": t} for spec in batch for t in spec["tokens"]])
                    elapsed = time.monotonic() - fetch_start
                    if not isinstance(raw, list) or any(not isinstance(book, dict) for book in raw):
                        raise Unavailable("invalid_response")
                    if any(not isinstance(book.get("asset_id"), str) for book in raw):
                        raise Unavailable("invalid_response")
                    books = {book.get("asset_id"): book for book in raw}
                    if len(books) != len(raw):
                        raise Unavailable("invalid_response")
                    for spec in batch:
                        try:
                            result = evaluate_pair(spec, books, time.time(), elapsed)
                            evidence.observe(spec["key"], time.monotonic(), result)
                        except Unavailable as error:
                            evidence.observe(spec["key"], time.monotonic(), reason=error.reason)
                except Unavailable as error:
                    for spec in batch:
                        evidence.observe(spec["key"], time.monotonic(), reason=error.reason)
                    if error.reason in {"rate_limited", "deadline"}:
                        raise
                    errors[error.reason] += 1
            rounds += 1
            if sample + 1 < samples:
                time.sleep(max(0, min(interval - (time.monotonic() - round_start), api.deadline - time.monotonic())))
    except Unavailable as error:
        errors[error.reason] += 1
    metrics = evidence.summary()
    status = "ok" if evidence.evaluated and not errors else "degraded"
    if not evidence.evaluated:
        status = "no_usable_data"
    return {"schemaVersion": 1, "generatedAt": datetime.now(timezone.utc).isoformat(),
            "startedAt": started.isoformat(), "scanSeconds": round(time.monotonic() - begin, 3),
            "status": status, "mode": "public_read_only", "orderSubmission": False,
            "scope": "same_market_complementary_pairs_standard_binary",
            "discoveredMarkets": discovered, "selectedMarkets": len(selected),
            "completedRounds": rounds, "requestedRounds": samples, "sampleIntervalSeconds": interval,
            "discoveryRejections": {k: discovery_reasons[k] for k in sorted(REASONS) if discovery_reasons[k]},
            "collectionErrors": {k: errors[k] for k in sorted(REASONS) if errors[k]},
            "assumptions": {"hypotheticalPairBudgetUsd": float(PAIR_BUDGET),
                "depthFraction": float(DEPTH_BUFFER), "slippageReserveBps": float(SLIPPAGE_BPS),
                "fixedCostReserveUsd": float(FIXED_COST_RESERVE), "minimumNetEdgeUsd": float(MIN_NET),
                "maxBookAgeSeconds": MAX_BOOK_AGE_SECONDS, "maxBookSkewSeconds": MAX_BOOK_SKEW_SECONDS,
                "maxFetchSeconds": MAX_FETCH_SECONDS, "maximumSharesSearched": MAX_SHARES},
            "metrics": metrics,
            "limitations": "Indicative snapshots only; two legs are not atomic. Reserves are assumptions, not measured costs. "
                "No orders, fills, realized P&L or projected daily income. Repeated depth is never summed as profit. "
                "Observed spans require consecutive samples, not continuous availability; no bridging between hourly runs. "
                "Volume-ranked bounded sample; negative-risk and cross-event baskets excluded. "
                "Conservatively require both book minimum shares and Gamma minimum USD notional."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-markets", type=int, default=60, choices=range(1, 61), metavar="1..60")
    parser.add_argument("--samples", type=int, default=12, choices=range(1, 13), metavar="1..12")
    parser.add_argument("--interval", type=int, default=5, choices=range(2, 11), metavar="2..10")
    args = parser.parse_args()
    print(json.dumps(scan(args.max_markets, args.samples, args.interval), indent=2, allow_nan=False))

