import copy
import json
import time
import unittest
import urllib.error
from unittest.mock import patch
from opportunity_scanner import D, Evidence, PublicApi, Unavailable, evaluate_pair, market_spec, read_book, scan

NOW = 1789488000
KEY = '0x' + 'a' * 64


def market():
    return dict(active=True, closed=False, acceptingOrders=True, enableOrderBook=True,
                negRisk=False, endDate='2026-12-01T00:00:00Z', clobTokenIds='["123", "456"]',
                outcomes='["Yes", "No"]', conditionId=KEY, orderMinSize=5,
                feesEnabled=True, feeSchedule=dict(rate=0.07, exponent=1, takerOnly=True))


def books(p='0.45', other=None, size='100'):
    return {t: dict(asset_id=t, market=KEY, timestamp=str(NOW * 1000),
                    min_order_size='5', neg_risk=False,
                    asks=[dict(price=price, size=size)])
            for t, price in [('123', p), ('456', other or p)]}


class ScannerTest(unittest.TestCase):
    def assert_reason(self, reason, fn, *args):
        with self.assertRaises(Unavailable) as caught:
            fn(*args)
        self.assertEqual(caught.exception.reason, reason)

    def test_positive_pair_stays_within_total_budget(self):
        r = evaluate_pair(market_spec(market(), NOW), books(), NOW, .2)
        self.assertEqual(r['shares'], 21)
        self.assertEqual(r['costUsd'], D('18.90'))
        self.assertEqual(r['feesUsd'], D('.72766'))
        self.assertEqual(r['netEdgeUsd'], D('1.23454'))
        self.assertLessEqual(r['totalCostUsd'], 20)

    def test_gross_positive_is_not_net_positive(self):
        r = evaluate_pair(market_spec(market(), NOW), books('.48', '.49'), NOW, .2)
        self.assertGreater(r['grossEdgeUsd'], 0)
        self.assertLess(r['netEdgeUsd'], 0)

    def test_depth_is_sorted_buffered_and_consumed(self):
        b = books()
        b['123']['asks'] = [dict(price='.95', size='100'), dict(price='.4', size='10')]
        levels, _, _ = read_book(b['123'], '123', KEY, NOW)
        self.assertEqual(levels[0], (D('.4'), D('9')))
        r = evaluate_pair(market_spec(market(), NOW), b, NOW, .2)
        self.assertLess(r['netEdgeUsd'], 0)  # cheap top level cannot cover minimum
        self.assert_reason('insufficient_depth_or_budget', evaluate_pair,
                           market_spec(market(), NOW), books(size='10'), NOW, .2)

    def test_missing_duplicate_depth_and_identity_fail_closed(self):
        for mutation, reason in [(lambda b: b.pop('123'), 'missing_book'),
                                 (lambda b: b['123'].update(market='wrong'), 'invalid_book'),
                                 (lambda b: b['123']['asks'].append(dict(price='.45', size='100')), 'invalid_book')]:
            b = books(); mutation(b)
            self.assert_reason(reason, evaluate_pair, market_spec(market(), NOW), b, NOW, .2)

    def test_freshness_and_latency(self):
        s = market_spec(market(), NOW)
        self.assert_reason('stale_book', evaluate_pair, s, books(), NOW + 11, .2)
        self.assert_reason('stale_book', evaluate_pair, s, books(), NOW - 2, .2)
        b = books(); b['456']['timestamp'] = str((NOW - 2) * 1000)
        self.assert_reason('asynchronous_books', evaluate_pair, s, b, NOW, .2)
        self.assert_reason('slow_snapshot', evaluate_pair, s, books(), NOW, 3.1)

    def test_eligibility_unknown_fees_and_invalid_metadata(self):
        cases = [('negRisk', True, 'unsupported_market_type'),
                 ('feesEnabled', None, 'unknown_fees'),
                 ('feeSchedule', {'rate': .07, 'exponent': 2, 'takerOnly': True}, 'unknown_fees'),
                 ('feeSchedule', {'rate': 'NaN', 'exponent': 1, 'takerOnly': True}, 'unknown_fees'),
                 ('orderMinSize', None, 'unknown_minimum'),
                 ('outcomes', '["Yes", "Yes"]', 'invalid_tokens'),
                 ('endDate', '2020-01-01T00:00:00Z', 'ended')]
        for key, value, reason in cases:
            m = market(); m[key] = value
            self.assert_reason(reason, market_spec, m, NOW)
        self.assert_reason('invalid_response', market_spec, None, NOW)
        m = market(); m['feesEnabled'] = False; m.pop('feeSchedule')
        self.assertEqual(market_spec(m, NOW)['rate'], 0)

    def test_minimum_and_invalid_book_numbers(self):
        m = market(); m['orderMinSize'] = 11
        self.assert_reason('insufficient_depth_or_budget', evaluate_pair, market_spec(m, NOW), books(), NOW, .1)
        for value in ['NaN', 'Infinity', True, '-1']:
            b = books(); b['123']['asks'][0]['size'] = value
            self.assert_reason('invalid_book', evaluate_pair, market_spec(market(), NOW), b, NOW, .1)

    def test_episodes_reset_and_do_not_sum_reused_depth(self):
        r = evaluate_pair(market_spec(market(), NOW), books(), NOW, .1)
        r['privateSentinel'] = 'NEVER_EXPORT'
        e = Evidence(5)
        for at in [0, 5, 10]: e.observe(KEY, at, r)
        s = e.summary()
        self.assertEqual((s['opportunityEpisodes'], s['repeatedEpisodes'], s['longestObservedSpanSeconds']), (1, 1, 10))
        self.assertEqual(s['peakIndicativeOpportunity']['netEdgeUsd'], float(r['netEdgeUsd']))
        e.observe(KEY, 15, reason='missing_book')
        e.observe(KEY, 20, r); e.observe(KEY, 40, r)
        self.assertEqual(e.summary()['opportunityEpisodes'], 3)
        self.assertNotIn(KEY, json.dumps(e.summary()))
        self.assertNotIn('NEVER_EXPORT', json.dumps(e.summary()))
        self.assertIsNone(Evidence(5).summary()['positiveObservationRate'])

    def test_order_endpoints_cannot_be_requested_and_429_is_sanitized(self):
        api = PublicApi(time.monotonic() + 100)
        with patch('urllib.request.urlopen') as request:
            self.assert_reason('invalid_response', api.get, '/order', [])
            request.assert_not_called()
            request.side_effect = urllib.error.HTTPError('private-url', 429, 'private-message', {}, None)
            self.assert_reason('rate_limited', api.get, '/books', [])

    def test_full_scan_aggregates_and_stops_on_rate_limit(self):
        with patch('opportunity_scanner.time.time', return_value=NOW), patch('opportunity_scanner.time.sleep'), patch.object(PublicApi, 'get', side_effect=[[None, market()], list(books().values()), Unavailable('rate_limited')]) as get:
            r = scan(1, 3, 5)
        self.assertEqual(r['status'], 'degraded')
        self.assertEqual(r['completedRounds'], 1)
        self.assertEqual(r['collectionErrors'], {'rate_limited': 1})
        self.assertEqual(r['metrics']['evaluatedPairs'], 1)
        self.assertEqual(r['metrics']['pairObservations'], 2)
        self.assertEqual(get.call_count, 3)
        self.assertNotIn(KEY, json.dumps(r))
        self.assertFalse(r['orderSubmission'])

