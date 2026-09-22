from __future__ import annotations

import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("shadow_backtest.py")
SPEC = importlib.util.spec_from_file_location("shadow_backtest", MODULE_PATH)
assert SPEC and SPEC.loader
BACKTEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BACKTEST)


NOW = datetime(2026, 9, 7, 20, 0, tzinfo=timezone.utc)


def evaluation(mode: str, seconds: int, pnl: float, *, depth: float = 6, intended: float = 5):
    return {
        "mode": mode,
        "observedAt": f"2026-09-07T19:{59-seconds//10:02d}:00Z",
        "entrySecondsBeforeClose": seconds,
        "side": "up",
        "resolved": True,
        "won": pnl > 0,
        "fullyFillable": True,
        "fillableShares": depth,
        "intendedShares": intended,
        "fillableCostUsd": 4,
        "estimatedFeesUsd": 0.05,
        "feeAwareBreakEvenProbability": 0.81,
        "hypotheticalPnlUsd": pnl,
        "liquidityReason": "fillable",
    }


def bet(index: int, evaluations: list[dict]):
    return {
        "id": str(index),
        "marketSlug": f"market-{index}",
        "windowEndUnix": 1788811200 + index * 300,
        "attemptHistory": [{
            "attemptedAt": "2026-09-07T19:30:00Z",
            "entrySecondsBeforeClose": 90,
            "shadowStrategies": evaluations,
        }],
    }


class ShadowBacktestTest(unittest.TestCase):
    def test_deduplicates_retries_using_earliest_observation(self):
        first = evaluation("ensemble", 90, 1)
        duplicate = {**first, "observedAt": "2026-09-07T19:59:59Z", "hypotheticalPnlUsd": -4}
        item = bet(1, [first])
        item["attemptHistory"].append({
            "attemptedAt": "2026-09-07T19:59:59Z",
            "shadowStrategies": [duplicate],
        })
        rows = BACKTEST.collect_rows([item], datetime(2026, 9, 1, tzinfo=timezone.utc), 0.9)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["pnlUsd"], 1)

    def test_accepts_exact_full_fill_with_minimum_depth_coverage(self):
        rows = BACKTEST.collect_rows(
            [bet(1, [evaluation("ensemble", 90, 1, depth=5, intended=5)])],
            datetime(2026, 9, 1, tzinfo=timezone.utc),
            0.9,
        )
        self.assertTrue(rows[0]["executable"])
        self.assertEqual(rows[0]["executionReason"], "fillable")
        self.assertEqual(rows[0]["pnlUsd"], 1)

    def test_rejects_when_full_fill_evidence_is_false(self):
        item = evaluation("ensemble", 90, 1, depth=4, intended=5)
        item["fullyFillable"] = False
        rows = BACKTEST.collect_rows(
            [bet(1, [item])], datetime(2026, 9, 1, tzinfo=timezone.utc), 0.9
        )
        self.assertFalse(rows[0]["executable"])
        self.assertIsNone(rows[0]["pnlUsd"])

    def test_keeps_each_market_in_only_one_chronological_cohort(self):
        bets = [bet(i, [evaluation("book_leader", 120, 1)]) for i in range(10)]
        report = BACKTEST.analyze(bets, 168, 1, NOW)
        self.assertEqual(report["sample"]["trainMarkets"], 7)
        self.assertEqual(report["sample"]["holdoutMarkets"], 3)
        result = report["strategies"][0]
        self.assertEqual(result["train"]["markets"], 7)
        self.assertEqual(result["holdout"]["markets"], 3)

    def test_portfolio_uses_earliest_fill_only(self):
        rows = BACKTEST.collect_rows(
            [bet(1, [
                evaluation("book_leader", 180, 1),
                evaluation("book_leader", 120, -4),
            ])],
            datetime(2026, 9, 1, tzinfo=timezone.utc),
            1,
        )
        portfolio = BACKTEST.portfolio_rows(rows)
        self.assertEqual(len(portfolio), 1)
        self.assertEqual(portfolio[0]["entrySecondsBeforeClose"], 180)
        self.assertEqual(BACKTEST.summarize(portfolio)["feeAwarePnlUsd"], 1)

    def test_reports_fee_aware_metrics_and_insufficient_sample(self):
        bets = [
            bet(i, [evaluation("ensemble", 90, 1 if i % 2 == 0 else -0.5)])
            for i in range(10)
        ]
        report = BACKTEST.analyze(bets, 168, 1, NOW)
        result = report["strategies"][0]
        self.assertEqual(result["holdout"]["trades"], 3)
        self.assertEqual(result["readiness"]["status"], "descriptive_only")
        self.assertEqual(BACKTEST.readiness(result["holdout"])["status"], "insufficient_sample")
        self.assertGreater(result["holdout"]["feesUsd"], 0)
        self.assertIsNotNone(result["holdout"]["winRateWilson95"])
        self.assertFalse(report["method"]["orderSubmission"])

    def test_excludes_maker_without_queue_evidence(self):
        item = evaluation("passive_maker", 120, 1)
        item["executionStyle"] = "maker"
        rows = BACKTEST.collect_rows(
            [bet(1, [item])], datetime(2026, 9, 1, tzinfo=timezone.utc), 1
        )
        self.assertEqual(rows[0]["executionReason"], "maker_queue_unknown")
        self.assertEqual(BACKTEST.summarize(rows)["trades"], 0)

    def test_unresolved_earliest_execution_does_not_select_later_winner(self):
        early = evaluation("book_leader", 240, 1)
        early["resolved"] = False
        rows = BACKTEST.collect_rows([bet(1, [early, evaluation("book_leader", 180, 1)])],
                                     datetime(2026, 9, 1, tzinfo=timezone.utc), 1)
        portfolio = BACKTEST.portfolio_rows(rows)
        self.assertEqual(portfolio[0]["entrySecondsBeforeClose"], 240)
        self.assertEqual(BACKTEST.summarize(portfolio)["trades"], 0)

    def daily_rows(self):
        rows = []
        for day in range(2, 7):
            for index in range(30):
                at = datetime(2026, 9, day, 12, index, tzinfo=timezone.utc)
                item = bet(day * 100 + index, [evaluation("book_leader", 240, 1)])
                item["windowEndUnix"] = at.timestamp()
                item["attemptHistory"][0]["attemptedAt"] = at.isoformat()
                item["attemptHistory"][0]["shadowStrategies"][0]["observedAt"] = at.isoformat()
                rows.extend(BACKTEST.collect_rows([item], datetime(2026, 9, 1, tzinfo=timezone.utc), 1))
        return rows

    def test_blocks_have_fixed_boundaries_and_no_partial_days(self):
        rows = self.daily_rows()
        cutoff = datetime(2026, 9, 1, 6, tzinfo=timezone.utc)
        first = BACKTEST.daily_validation(rows, cutoff, NOW)
        later = BACKTEST.daily_validation(rows, cutoff + timedelta(hours=2), NOW + timedelta(hours=2))
        self.assertEqual(first["blocks"], later["blocks"])
        self.assertEqual(sum(b["holdout"]["trades"] for b in first["blocks"]), 150)
        self.assertEqual(first["blocks"][-1]["endUtc"], "2026-09-07T00:00:00Z")
        self.assertEqual(first["status"], "paper_review")

    def test_prior_evidence_excludes_current_and_future_blocks(self):
        result = BACKTEST.daily_validation(self.daily_rows(), datetime(2026, 9, 1, tzinfo=timezone.utc), NOW)
        self.assertEqual(result["blocks"][0]["train"]["trades"], 0)
        self.assertEqual(result["blocks"][1]["train"]["trades"], 30)
        self.assertEqual(result["blocks"][0]["status"], "insufficient_prior_evidence")

    def test_pending_or_negative_latest_block_prevents_review(self):
        rows = self.daily_rows()
        rows[-1]["pnlUsd"] = None
        result = BACKTEST.daily_validation(rows, datetime(2026, 9, 1, tzinfo=timezone.utc), NOW)
        self.assertEqual(result["blocks"][-1]["status"], "pending_outcomes")
        self.assertEqual(result["status"], "not_ready")
        rows[-1]["pnlUsd"] = -100
        rows[-1]["won"] = False
        result = BACKTEST.daily_validation(rows, datetime(2026, 9, 1, tzinfo=timezone.utc), NOW)
        self.assertEqual(result["status"], "not_ready")
        self.assertEqual(result["consecutivePassingBlocks"], 0)

    def test_sanitized_export_drops_raw_fields_at_all_levels(self):
        import json
        report = BACKTEST.analyze([bet(i, [evaluation("ensemble", 90, 1)]) for i in range(10)], 168, 1, NOW)
        report["raw"] = "SECRET_MARKET"
        report["sample"]["marketIds"] = ["SECRET_MARKET"]
        s = report["strategies"][0]
        s["train"]["raw"] = "SECRET_MARKET"
        s["windows"][0]["validation"]["blocks"][0]["holdout"]["raw"] = "SECRET_MARKET"
        exported = BACKTEST.sanitized_summary(report)
        self.assertNotIn("SECRET_MARKET", json.dumps(exported))
        self.assertIn("validation", exported["strategies"][0]["windows"][0])


if __name__ == "__main__":
    unittest.main()

