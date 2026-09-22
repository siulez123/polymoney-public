#!/usr/bin/env python3
"""Validate sanitized monitoring evidence; never changes trading state."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def evaluate(report, now=None):
    now = now or datetime.now(timezone.utc)
    reasons = []
    if not isinstance(report, dict):
        return ["invalid report"]
    try:
        stamp = datetime.fromisoformat(report['generatedAt'].replace('Z', '+00:00'))
        age = (now - stamp).total_seconds()
        if not -60 <= age <= 900:
            reasons.append("stale report or future timestamp")
    except (KeyError, TypeError, ValueError, AttributeError):
        reasons.append("collection timestamp unavailable")
    operational = report.get('operational')
    if (not isinstance(operational, dict)
            or not isinstance(operational.get('status'), str)
            or not operational['status'].strip()
            or operational['status'] == 'unknown'
            or type(operational.get('tradingActive')) is not bool):
        reasons.append("operational state unavailable or invalid")
    feed = report.get('feed')
    current = feed.get('current') if isinstance(feed, dict) else None
    required = ('running', 'connected', 'chainlinkConnected', 'chainlinkStale')
    if (not isinstance(current, dict)
            or any(type(current.get(key)) is not bool for key in required)):
        reasons.append("feed state unavailable or invalid")
    elif (not current['running'] or not current['connected']
          or not current['chainlinkConnected'] or current['chainlinkStale']):
        reasons.append("Chainlink disconnected, stopped or stale")
    return reasons


if __name__ == '__main__':
    reasons = evaluate(json.loads(Path('report.json').read_text()))
    Path('observability-reason.txt').write_text('; '.join(reasons))
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f"unavailable={'true' if reasons else 'false'}\n")

