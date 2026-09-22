import json
import unittest
from datetime import datetime, timedelta, timezone

import prospective_shadow as study
import test_shadow_backtest as fixtures
from shadow_backtest import daily_validation


def observation(day=0, minute=10, pnl=1):
    close = study.START + timedelta(days=day, minutes=minute)
    observed = close - timedelta(seconds=240)
    ev = fixtures.evaluation("book_leader", 240, pnl)
    ev["observedAt"] = observed.isoformat()
    item = fixtures.bet(day * 10000 + minute, [ev])
    item["windowEndUnix"] = close.timestamp()
    item["attemptHistory"][0]["attemptedAt"] = observed.isoformat()
    return item


class ProspectiveTest(unittest.TestCase):
    def block(self, bets, now=None):
        return study.analyze(bets, now or study.START + timedelta(days=1))["hypotheses"][2]["blocks"][0]

    def test_future_and_prestudy_observations_never_enter(self):
        self.assertEqual(self.block([observation(day=-1), observation(day=1)])['metrics']['trades'], 0)
        self.assertEqual(study.analyze([], study.START - timedelta(seconds=1))['status'], 'scheduled')

    def test_late_observation_is_excluded_even_when_profitable(self):
        item = observation()
        item['attemptHistory'][0]['shadowStrategies'][0]['observedAt'] = (
            study.START + timedelta(minutes=9)).isoformat()
        block = self.block([item])
        self.assertEqual(block['timingExcludedMarkets'], 1)
        self.assertEqual(block['metrics']['trades'], 0)

    def test_missing_timing_or_fees_cannot_pass(self):
        item = observation()
        del item['attemptHistory'][0]['shadowStrategies'][0]['observedAt']
        self.assertEqual(self.block([item])['timingExcludedMarkets'], 1)
        item = observation()
        del item['attemptHistory'][0]['shadowStrategies'][0]['estimatedFeesUsd']
        self.assertEqual(self.block([item])['invalidEvidenceMarkets'], 1)
        self.assertEqual(self.block([item])['metrics']['trades'], 0)

    def test_fixed_cohort_survives_beyond_rolling_window(self):
        items = [observation()]
        first = self.block(items)
        last = self.block(items, study.END + timedelta(days=10))
        self.assertEqual(first, last)
        self.assertEqual(last['metrics']['feeAwarePnlUsd'], 1)
        self.assertEqual(last['status'], 'incomplete')

    def test_unresolved_full_fill_is_pending_not_a_win(self):
        item = observation()
        item['attemptHistory'][0]['shadowStrategies'][0]['resolved'] = False
        block = self.block([item])
        self.assertEqual(block['pendingTrades'], 1)
        self.assertEqual(block['metrics']['trades'], 0)

    def test_export_contains_no_market_or_raw_observations(self):
        item = observation()
        item['marketSlug'] = 'SECRET_MARKET'
        result = study.analyze([item], study.START + timedelta(days=1))
        self.assertNotIn('SECRET_MARKET', json.dumps(result))
        self.assertNotIn('shadowStrategies', json.dumps(result))
        self.assertFalse(result['automaticPromotion'])
        self.assertFalse(result['orderSubmission'])

    def test_loss_is_not_hidden_by_insufficient_prior_evidence(self):
        rows = fixtures.ShadowBacktestTest().daily_rows()
        for r in rows:
            r['pnlUsd'] = -1
            r['won'] = False
        result = daily_validation(rows, datetime(2026, 9, 1, tzinfo=timezone.utc), fixtures.NOW)
        self.assertEqual(result['blocks'][0]['status'], 'reject')
        self.assertEqual(result['blocks'][0]['priorStatus'], 'insufficient_sample')
        self.assertEqual(result['blocks'][0]['holdoutStatus'], 'reject')

