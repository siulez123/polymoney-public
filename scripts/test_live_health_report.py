from __future__ import annotations

import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("live-health-report.py")
SPEC = importlib.util.spec_from_file_location("live_health_report", MODULE_PATH)
assert SPEC and SPEC.loader
REPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPORT)


def placed_at(delta_hours: float = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=delta_hours)).isoformat().replace("+00:00", "Z")


CONFIG_TEXT = """
timing:
  bet_seconds_before_close: 90
  entry_windows:
    - seconds_before_close: 90
      min_delta_bps: 12
      max_price: 0.82
    - seconds_before_close: 60
      min_delta_bps: 10
      max_price: 0.85
    - seconds_before_close: 40
      min_delta_bps: 10
      max_price: 0.87
bet:
  max_price: 0.90
  use_market_order: true
staking:
  max_stake_usd: 20
strategy:
  min_delta_bps: 6
safety:
  max_order_usd: 20
  size_to_depth: true
"""


class AnalyzeReportTest(unittest.TestCase):
    def test_shadow_only_markets_are_not_primary_attempts(self):
        shadow = {"placedAt": placed_at(), "outcome": "skipped", "attemptHistory": [
            {"attemptedAt": placed_at(), "outcome": "skipped",
             "strategyReason": "T-240: shadow_timer: no signal"}]}
        mixed = {**shadow, "attemptHistory": shadow['attemptHistory'] + [
            {"attemptedAt": placed_at(), "outcome": "skipped", "strategyReason": "T-180: no edge"}]}
        legacy = {"placedAt": placed_at(), "outcome": "skipped"}
        report = REPORT.analyze([shadow, mixed, legacy], {}, REPORT.parse_config_text(CONFIG_TEXT), 24)
        self.assertEqual(report['counts']['shadowOnlyMarkets'], 1)
        self.assertEqual(report['counts']['primaryAttemptMarkets'], 2)
        self.assertEqual(report['counts']['attempts'], 3)

    def test_parses_section_scoped_config_and_all_entry_windows(self) -> None:
        config = REPORT.parse_config_text(CONFIG_TEXT)
        self.assertEqual(config["min_delta_bps"], 6)
        self.assertEqual(config["max_price"], 0.9)
        self.assertEqual(
            [item["seconds_before_close"] for item in config["entry_windows"]],
            [90, 60, 40],
        )
        self.assertEqual(config["entry_windows"][0]["min_delta_bps"], 12)

    def test_counts_resolved_paper_and_live_entries(self) -> None:
        bets = [
            {"placedAt": placed_at(), "outcome": "paper", "resolved": True, "won": True, "pnl": 1.5, "totalCost": 4.2, "platformFee": 0.2},
            {"placedAt": placed_at(), "outcome": "paper", "resolved": True, "won": False, "pnl": -1.1, "totalCost": 5.3, "platformFee": 0.3},
            {"placedAt": placed_at(), "outcome": "filled", "resolved": True, "won": True, "pnl": 0.8, "totalCost": 6.1, "platformFee": 0.1},
            {"placedAt": placed_at(), "outcome": "failed", "error": "insufficient depth", "resolved": False},
        ]
        report = REPORT.analyze(bets, {}, REPORT.parse_config_text(CONFIG_TEXT), 24)
        self.assertEqual(report["counts"]["filled"], 1)
        self.assertEqual(report["counts"]["paper"], 2)
        self.assertAlmostEqual(report["pnl"]["fillRate"], 0.75)
        self.assertEqual(report["pnl"]["resolvedFills"], 3)
        self.assertAlmostEqual(report["pnl"]["totalPnlUsd"], 1.2)
        self.assertAlmostEqual(report["pnl"]["totalFeesUsd"], 0.6)

    def test_attributes_attempt_history_to_each_entry_window(self) -> None:
        now = placed_at()
        bet = {
            "placedAt": now,
            "outcome": "filled",
            "resolved": True,
            "won": True,
            "pnl": 0.9,
            "totalCost": 4.1,
            "platformFee": 0.05,
            "attemptHistory": [
                {"attemptedAt": now, "outcome": "failed", "entrySecondsBeforeClose": 90, "side": "up", "price": 0.82, "error": "No usable liquidity ≤ max_price 0.82: best ask 0.910 > max_price 0.82", "strategyReason": "T-90: momentum 13 bps"},
                {"attemptedAt": now, "outcome": "unfilled", "entrySecondsBeforeClose": 60, "side": "up", "price": 0.85, "error": "No orders found to match", "strategyReason": "T-60: momentum 11 bps"},
                {"attemptedAt": now, "outcome": "filled", "entrySecondsBeforeClose": 40, "side": "up", "price": 0.86, "strategyReason": "T-40: momentum 12 bps"},
            ],
        }
        report = REPORT.analyze([bet], {}, REPORT.parse_config_text(CONFIG_TEXT), 24)
        windows = {item["entry"]: item for item in report["entryWindows"]}
        self.assertEqual(windows["T-90"]["fails"]["price_above_limit"], 1)
        self.assertEqual(windows["T-90"]["freshCohort"]["fails"]["price_above_limit"], 1)
        self.assertEqual(windows["T-90"]["legacyCohort"]["attempts"], 0)
        self.assertEqual(windows["T-60"]["unfilled"], 1)
        self.assertEqual(windows["T-40"]["filled"], 1)
        self.assertEqual(windows["T-40"]["wins"], 1)
        self.assertAlmostEqual(windows["T-40"]["totalPnlUsd"], 0.9)
        self.assertAlmostEqual(windows["T-40"]["averageFillPrice"], 0.86)
        self.assertEqual(report["feed"]["windowEvidence"]["signalSamples"], 3)

    def test_classifies_actionable_sanitized_failures(self) -> None:
        self.assertEqual(
            REPORT.classify_fail("No usable liquidity ≤ max_price 0.82: book has no asks"),
            "no_liquidity",
        )
        self.assertEqual(
            REPORT.classify_fail("best ask 0.910 > max_price 0.82"),
            "price_above_limit",
        )
        self.assertEqual(
            REPORT.classify_fail("depth=$3.00 / 4.00 sh (minimum order does not fit)"),
            "insufficient_depth",
        )
        self.assertEqual(
            REPORT.classify_fail("No usable liquidity ≤ max_price 0.82"),
            "depth_or_max_price",
        )
        self.assertEqual(REPORT.classify_fail("Chainlink feed stale"), "feed_unavailable")
        self.assertEqual(REPORT.classify_fail("wallet signature unauthorized"), "auth_or_wallet")
        self.assertEqual(REPORT.classify_fail("network timeout"), "network_or_api")
        self.assertEqual(REPORT.classify_fail("unexpected problem"), "unknown")

    def test_buckets_price_distance_without_exposing_exact_prices(self) -> None:
        self.assertEqual(
            REPORT.price_distance_bucket("best ask 0.83 > max_price 0.82"),
            "lte_0_01",
        )
        self.assertEqual(
            REPORT.price_distance_bucket("best ask 0.85 > max_price 0.82"),
            "gt_0_01_lte_0_03",
        )
        self.assertEqual(
            REPORT.price_distance_bucket("best ask 0.91 > max_price 0.82"),
            "gt_0_05",
        )
        self.assertIsNone(REPORT.price_distance_bucket("book has no asks"))

    def test_treats_legacy_placed_outcome_as_a_fill_per_window(self) -> None:
        now = placed_at()
        bet = {
            "placedAt": now,
            "outcome": "placed",
            "resolved": True,
            "won": True,
            "pnl": 1,
            "attemptHistory": [{
                "attemptedAt": now,
                "outcome": "placed",
                "entrySecondsBeforeClose": 60,
                "side": "up",
                "price": 0.84,
            }],
        }
        report = REPORT.analyze([bet], {}, REPORT.parse_config_text(CONFIG_TEXT), 24)
        window = next(item for item in report["entryWindows"] if item["entry"] == "T-60")
        self.assertEqual(window["filled"], 1)
        self.assertEqual(window["failed"], 0)

    def test_separates_legacy_from_fresh_and_excludes_legacy_from_suggestions(self) -> None:
        now = placed_at()
        legacy = [
            {
                "placedAt": now,
                "outcome": "failed",
                "entrySecondsBeforeClose": 90,
                "side": "up",
                "error": "No usable liquidity ≤ max_price 0.82",
                "strategyReason": "T-90: momentum 13 bps",
            }
            for _ in range(8)
        ]
        fresh = {
            "placedAt": now,
            "outcome": "skipped",
            "attemptHistory": [{
                "attemptedAt": now,
                "outcome": "skipped",
                "entrySecondsBeforeClose": 90,
                "side": None,
                "strategyReason": "T-90: momentum 4 bps",
            }],
        }
        report = REPORT.analyze([*legacy, fresh], {}, REPORT.parse_config_text(CONFIG_TEXT), 24)
        window = next(item for item in report["entryWindows"] if item["entry"] == "T-90")
        self.assertEqual(window["attemptsWithSide"], 8)
        self.assertEqual(window["freshCohort"]["attempts"], 1)
        self.assertEqual(window["freshCohort"]["attemptsWithSide"], 0)
        self.assertEqual(window["legacyCohort"]["attemptsWithSide"], 8)
        self.assertEqual(report["feed"]["windowEvidence"]["legacyRecordsWithoutAttemptHistory"], 8)
        self.assertEqual(report["feed"]["windowEvidence"]["freshRecordsWithAttemptHistory"], 1)
        self.assertEqual(report["suggestions"], [])

    def test_generates_tuning_suggestion_only_from_fresh_attempts(self) -> None:
        now = placed_at()
        bets = [
            {
                "placedAt": now,
                "outcome": "failed",
                "attemptHistory": [{
                    "attemptedAt": now,
                    "outcome": "failed",
                    "entrySecondsBeforeClose": 90,
                    "side": "up",
                    "error": "best ask 0.910 > max_price 0.82",
                    "strategyReason": "T-90: momentum 13 bps",
                }],
            }
            for _ in range(8)
        ]
        report = REPORT.analyze(bets, {}, REPORT.parse_config_text(CONFIG_TEXT), 24)
        suggestion = next(item for item in report["suggestions"] if item["entry"] == "T-90")
        self.assertEqual(suggestion["evidenceCohort"], "fresh_attempt_history")
        self.assertIn("price_above_limit=8", suggestion["detail"])
        window = next(item for item in report["entryWindows"] if item["entry"] == "T-90")
        self.assertEqual(window["freshCohort"]["priceDistanceBuckets"]["gt_0_05"], 8)

    def test_includes_current_sanitized_operational_health(self) -> None:
        operational = {
            "status": "waiting",
            "tradingActive": True,
            "uptime": 123,
            "feed": {"connected": True, "chainlinkStale": False, "chainlinkReconnects": 1},
        }
        report = REPORT.analyze([], {}, REPORT.parse_config_text(CONFIG_TEXT), 24, operational)
        self.assertEqual(report["operational"]["status"], "waiting")
        self.assertTrue(report["operational"]["tradingActive"])
        self.assertTrue(report["feed"]["current"]["connected"])

    def test_aggregates_sanitized_shadow_execution_by_window_and_offset(self) -> None:
        now = placed_at()
        bet = {
            "placedAt": now,
            "outcome": "failed",
            "attemptHistory": [{
                "attemptedAt": now,
                "outcome": "failed",
                "entrySecondsBeforeClose": 90,
                "side": "up",
                "error": "No liquidity",
                "shadowLiquidity": {
                    "configuredMaxPrice": 0.82,
                    "globalMaxPrice": 0.9,
                    "desiredShares": 5,
                    "levels": [
                        {
                            "offsetCents": 0,
                            "maxPrice": 0.82,
                            "fillableShares": 0,
                            "fillableCostUsd": 0,
                            "estimatedFeesUsd": 0,
                            "feeAwareBreakEvenProbability": None,
                            "fullyFillable": False,
                            "reason": "empty_book",
                        },
                        {
                            "offsetCents": 2,
                            "maxPrice": 0.84,
                            "fillableShares": 5,
                            "fillableCostUsd": 4.2,
                            "estimatedFeesUsd": 0.05,
                            "feeAwareBreakEvenProbability": 0.85,
                            "fullyFillable": True,
                            "reason": "fillable",
                        },
                    ],
                },
            }],
        }
        report = REPORT.analyze([bet], {}, REPORT.parse_config_text(CONFIG_TEXT), 24)
        shadow = next(item for item in report["shadowExecution"] if item["entry"] == "T-90")
        base = next(item for item in shadow["levels"] if item["offsetCents"] == 0)
        plus_two = next(item for item in shadow["levels"] if item["offsetCents"] == 2)
        self.assertEqual(base["reasons"]["empty_book"], 1)
        self.assertEqual(plus_two["fullyFillableRate"], 1)
        self.assertEqual(plus_two["averageFeeAwareBreakEvenProbability"], 0.85)

    def test_excludes_entries_outside_the_window(self) -> None:
        bets = [{"placedAt": placed_at(25), "outcome": "paper", "resolved": True, "won": True, "pnl": 10}]
        report = REPORT.analyze(bets, {}, REPORT.parse_config_text(CONFIG_TEXT), 24)
        self.assertEqual(report["counts"]["attempts"], 0)
        self.assertEqual(report["pnl"]["resolvedFills"], 0)

    def test_reports_resolved_shadow_accuracy_and_fee_aware_pnl(self) -> None:
        now = placed_at()
        bet = {
            "placedAt": now,
            "outcome": "failed",
            "attemptHistory": [{
                "attemptedAt": now,
                "outcome": "failed",
                "entrySecondsBeforeClose": 60,
                "shadowStrategies": [{
                    "mode": "ensemble",
                    "side": "up",
                    "fullyFillable": True,
                    "liquidityReason": "fillable",
                    "estimatedFeesUsd": 0.05,
                    "resolved": True,
                    "won": True,
                    "hypotheticalPnlUsd": 0.95,
                }],
            }],
        }
        report = REPORT.analyze([bet], {}, REPORT.parse_config_text(CONFIG_TEXT), 24)
        metric = next(item for item in report["shadowStrategies"] if item["mode"] == "ensemble")
        self.assertEqual(metric["resolvedSignals"], 1)
        self.assertEqual(metric["wins"], 1)
        self.assertEqual(metric["winRate"], 1)
        self.assertEqual(metric["hypotheticalTrades"], 1)
        self.assertAlmostEqual(metric["hypotheticalPnlUsd"], 0.95)
        self.assertFalse(metric["orderSubmission"])


if __name__ == "__main__":
    unittest.main()

