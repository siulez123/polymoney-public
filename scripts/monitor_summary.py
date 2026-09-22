#!/usr/bin/env python3
"""Render the already sanitized operational/backtest reports for Actions."""
import json
import sys


def ratio(numerator, denominator):
    if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0
               for v in (numerator, denominator)):
        return "n/a (counts unavailable)"
    if numerator > denominator:
        return f"n/a (inconsistent counts: {numerator}/{denominator})"
    if denominator == 0:
        return f"n/a ({numerator}/{denominator})"
    return f"{numerator}/{denominator} ({100 * numerator / denominator:.2f}%)"


def percent(value):
    return "n/a" if value is None else f"{100 * value:.2f}%"


def render(report, backtest, prospective=None, opportunities=None):
    counts, pnl = report.get("counts", {}), report.get("pnl", {})
    attempts, signals = counts.get("attempts"), counts.get("attemptsWithSide")
    executed, resolved = counts.get("executed"), pnl.get("resolvedFills")
    lines = [
        "## Polymoney — last 24 hours", "",
        f"- Service active: {report.get('serviceActive')}",
        f"- Commit: {report.get('deployedCommit')}",
        f"- Status: {report.get('operational', {}).get('status', 'n/a')}",
        f"- Shadow-only markets: {counts.get('shadowOnlyMarkets', 'n/a')}; with primary attempt: {counts.get('primaryAttemptMarkets', 'n/a')}",
        "- Pausing prevents new primary executions; shadow observation continues."
        if report.get('operational', {}).get('tradingActive') is False else "- Check operational state before interpreting a lack of executions.",
        f"- Attempts with a side / total: {ratio(signals, attempts)}",
        f"- Executions / attempts with a side: {ratio(executed, signals)}",
        f"- Executions / total: {ratio(executed, attempts)}",
        f"- Resolved / executions: {ratio(resolved, executed)}",
        "- Counts by final market outcome; include paper. Having a side does not guarantee CLOB eligibility.",
        f"- Live resolved: {pnl.get('liveResolvedFills', 'n/a')}; paper resolved: {pnl.get('paperResolvedFills', 'n/a')}",
        f"- W/L: {pnl.get('wins', 'n/a')}/{pnl.get('losses', 'n/a')}",
        f"- Net P&L: ${pnl.get('totalPnlUsd', 'n/a')}; fees: ${pnl.get('totalFeesUsd', 'n/a')}",
        "",
        "### Descriptive backtest — rolling holdout", "",
        f"- Markets: {backtest['sample']['distinctMarkets']}; holdout: {backtest['sample']['holdoutMarkets']}",
        "- Successive comparisons overlap data; they are not independent confirmations.",
    ]
    for s in backtest["strategies"]:
        h = s["holdout"]
        lines.append(f"- {s['mode']}: {h['trades']} trades; WR {percent(h['winRate'])}; P&L ${h['feeAwarePnlUsd']}; ROI {percent(h['roi'])}; drawdown ${h['maxDrawdownUsd']}")
    lines += ["", "### Validation by strategy and window — complete UTC days", "",
              "- Requires 3 consecutive blocks with prior evidence; passing only authorizes paper review.",
              "- Non-overlapping blocks may still be correlated. Requires prospective validation and drawdown/latency assessment.",
              "", "| Strategy | Window | Consecutive passing blocks | Status | Mean P&L/block | Standard deviation |",
              "|---|---|---:|---|---:|---:|"]
    for s in backtest["strategies"]:
        for w in s["windows"]:
            v = w.get("validation")
            if not v:
                lines.append(f"| {s['mode']} | {w['entry']} | n/a | validation unavailable | n/a | n/a |")
                continue
            latest = v.get('blocks', [{}])[-1] if v.get('blocks') else {}
            detail = f"{v['status']}; latest={latest.get('holdoutStatus', 'n/a')}, prior={latest.get('priorStatus', 'n/a')}"
            lines.append(f"| {s['mode']} | {w['entry']} | {v['consecutivePassingBlocks']}/{v['requiredConsecutiveBlocks']} | {detail} | {v['meanBlockPnlUsd']} | {v['stddevBlockPnlUsd']} |")
    if prospective:
        lines += ["", "### Prospective shadow experiment — fixed period", "",
                  f"- {prospective['startUtc']} to {prospective['endUtc']}: {prospective['status']}",
                  "- No orders. No result automatically promotes a strategy."]
        for hypothesis in prospective['hypotheses']:
            blocks = hypothesis['blocks']
            trades = sum(b['metrics']['trades'] for b in blocks)
            net = sum(b['metrics']['feeAwarePnlUsd'] for b in blocks)
            excluded = sum(b['timingExcludedMarkets'] for b in blocks)
            lines.append(f"- {hypothesis['mode']} {hypothesis['entry']}: {trades} resolved shadow trades; P&L ${net:.2f}; {excluded} observations excluded by timing.")
    if opportunities:
        metrics = opportunities['metrics']
        lines += ["", "### Public scanner — complementary pairs in the same market", "",
                  f"- Status: {opportunities['status']}; selected markets: {opportunities['selectedMarkets']}; rounds: {opportunities['completedRounds']}/{opportunities['requestedRounds']}",
                  f"- Positive observations / evaluable pairs: {ratio(metrics['positivePairObservations'], metrics['evaluatedPairs'])}",
                  f"- Distinct positive markets: {metrics['distinctPositiveMarkets']}; episodes: {metrics['opportunityEpisodes']}; repeated: {metrics['repeatedEpisodes']}",
                  f"- Longest span between consecutive positive samples: {metrics['longestObservedSpanSeconds']} s",
                  "- Short collections per run; not continuous monitoring or proof of execution.",
                  "- No orders. Market-specific fees, depth reduced to 90% and assumed cost reserves.",
                  f"- Rejections: {json.dumps(metrics['rejections'], sort_keys=True)}",
                  f"- Collection errors: {json.dumps(opportunities['collectionErrors'], sort_keys=True)}"]
        peak = metrics['peakIndicativeOpportunity']
        if peak:
            lines += [f"- Best potential edge observed: ${peak['netEdgeUsd']}; estimated total cost: ${peak['totalCostUsd']}; fees: ${peak['feesUsd']}; reserve: ${peak['costReserveUsd']}",
                      f"- Maximum unhedged leg cost: ${peak['maximumUnhedgedLegCostUsd']}. The two purchases are not atomic."]
        else:
            lines.append("- No positive net opportunity observed in evaluable data.")
        lines.append("- Do not add repeated observations as profit; no realized P&L or projected daily income.")
    lines.append("\nBlock details, fees, ROI, drawdown and Wilson 95% in the sanitized artifact (30 days).")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    with open(sys.argv[1]) as handle:
        report = json.load(handle)
    with open(sys.argv[2]) as handle:
        backtest = json.load(handle)
    prospective = None
    if len(sys.argv) > 3:
        with open(sys.argv[3]) as handle:
            prospective = json.load(handle)
    opportunities = None
    if len(sys.argv) > 4:
        with open(sys.argv[4]) as handle:
            opportunities = json.load(handle)
    print(render(report, backtest, prospective, opportunities), end="")

