import copy
import io
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from monitor_guardrails import evaluate
from test_live_health_report import REPORT


NOW = datetime(2026, 9, 16, 8, tzinfo=timezone.utc)
VALID = {'generatedAt': NOW.isoformat(),
         'operational': {'status': 'paused', 'tradingActive': False},
         'feed': {'current': {'running': True, 'connected': True,
                              'chainlinkConnected': True, 'chainlinkStale': False}}}


class GuardrailTests(unittest.TestCase):
    def test_paused_is_valid_and_inputs_unchanged(self):
        report = copy.deepcopy(VALID)
        self.assertEqual(evaluate(report, NOW), [])
        self.assertEqual(report, VALID)

    def test_null_operational_or_feed_alerts(self):
        for path in [('operational',), ('feed',), ('feed', 'current')]:
            report = copy.deepcopy(VALID)
            target = report
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = None
            self.assertTrue(evaluate(report, NOW), path)

    def test_missing_or_invalid_types_cannot_look_healthy(self):
        for value in (None, 'false', 0, [], {}):
            report = copy.deepcopy(VALID)
            report['operational']['tradingActive'] = value
            self.assertTrue(evaluate(report, NOW))
        for field in VALID['feed']['current']:
            for value in (None, 'true', 1):
                report = copy.deepcopy(VALID)
                report['feed']['current'][field] = value
                self.assertTrue(evaluate(report, NOW))

    def test_feed_failure_even_when_backup_connected(self):
        for field, value in [('running', False), ('connected', False),
                             ('chainlinkConnected', False), ('chainlinkStale', True)]:
            report = copy.deepcopy(VALID)
            report['feed']['current'][field] = value
            self.assertTrue(evaluate(report, NOW))

    def test_invalid_stale_future_and_naive_timestamps(self):
        for value in (None, 'bad', '2026-09-16T07:00:00Z',
                      '2026-09-16T09:00:00Z', '2026-09-16T08:00:00'):
            self.assertTrue(evaluate({**VALID, 'generatedAt': value}, NOW))

    def test_transient_health_failure_recovers(self):
        with patch.object(REPORT, 'urlopen', side_effect=[TimeoutError('private'), io.StringIO('{"status":"paused"}')]) as request, patch.object(REPORT.time, 'sleep'):
            self.assertEqual(REPORT.load_health(), {'status': 'paused'})
            self.assertEqual(request.call_count, 2)

    def test_health_failure_is_bounded_and_sanitized(self):
        with patch.object(REPORT, 'urlopen', side_effect=OSError('private-secret')) as request, patch.object(REPORT.time, 'sleep') as sleep:
            self.assertIsNone(REPORT.load_health())
            self.assertEqual(request.call_count, 3)
            self.assertEqual(sleep.call_count, 2)
        with patch.object(REPORT, 'urlopen', side_effect=lambda *a, **k: io.StringIO('[]')), patch.object(REPORT.time, 'sleep'):
            self.assertIsNone(REPORT.load_health())

