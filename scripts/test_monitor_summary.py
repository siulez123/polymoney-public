import unittest
from monitor_summary import ratio, render


class MonitorSummaryTest(unittest.TestCase):
    def test_paused_shadow_collection_is_explicit(self):
        report = {"operational": {"tradingActive": False},
                  "counts": {"shadowOnlyMarkets": 288, "primaryAttemptMarkets": 0}}
        text = render(report, {"sample": {"distinctMarkets": 0, "holdoutMarkets": 0}, "strategies": []})
        self.assertIn("Shadow-only markets: 288; with primary attempt: 0", text)
        self.assertIn("Pausing prevents new primary executions", text)

    def test_one_execution_out_of_286_is_explicit(self):
        report = {"counts": {"attempts": 286, "attemptsWithSide": 1, "executed": 1},
                  "pnl": {"resolvedFills": 1}}
        text = render(report, {"sample": {"distinctMarkets": 0, "holdoutMarkets": 0}, "strategies": []})
        self.assertIn("Executions / attempts with a side: 1/1 (100.00%)", text)
        self.assertIn("Executions / total: 1/286 (0.35%)", text)
        self.assertIn("Resolved / executions: 1/1 (100.00%)", text)

    def test_zero_missing_and_inconsistent_denominators(self):
        self.assertEqual(ratio(0, 0), "n/a (0/0)")
        self.assertIn("unavailable", ratio(None, 1))
        self.assertIn("inconsistent", ratio(2, 1))
        self.assertEqual(ratio(0, 3), "0/3 (0.00%)")

    def test_scanner_zero_denominator_is_not_profit(self):
        from opportunity_scanner import Evidence
        scanner = dict(status='no_usable_data', selectedMarkets=5, completedRounds=2,
                       requestedRounds=2, collectionErrors={}, metrics=Evidence(5).summary())
        text = render({}, {'sample': {'distinctMarkets': 0, 'holdoutMarkets': 0}, 'strategies': []}, opportunities=scanner)
        self.assertIn('Positive observations / evaluable pairs: n/a (0/0)', text)
        self.assertIn('No orders', text)
        self.assertIn('no realized P&L', text)

    def test_positive_scanner_reports_costs_without_realized_profit(self):
        from opportunity_scanner import Evidence
        from test_opportunity_scanner import market_spec, market, NOW, books, evaluate_pair
        e = Evidence(5)
        e.observe('secret-condition', 0, evaluate_pair(market_spec(market(), NOW), books(), NOW, .1))
        scanner = dict(status='ok', selectedMarkets=1, completedRounds=1, requestedRounds=1,
                       collectionErrors={}, metrics=e.summary())
        text = render({}, {'sample': {'distinctMarkets': 0, 'holdoutMarkets': 0}, 'strategies': []}, opportunities=scanner)
        self.assertIn('potential edge observed', text)
        self.assertIn('are not atomic', text)
        self.assertNotIn('secret-condition', text)

