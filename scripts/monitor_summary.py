#!/usr/bin/env python3
"""Render the already sanitized operational/backtest reports for Actions."""
import json
import sys


def ratio(numerator, denominator):
    if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0
               for v in (numerator, denominator)):
        return "n/a (contagens indisponíveis)"
    if numerator > denominator:
        return f"n/a (contagens inconsistentes: {numerator}/{denominator})"
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
        "## Polymoney — últimas 24 horas", "",
        f"- Serviço ativo: {report.get('serviceActive')}",
        f"- Commit: {report.get('deployedCommit')}",
        f"- Estado: {report.get('operational', {}).get('status', 'n/a')}",
        f"- Mercados apenas shadow: {counts.get('shadowOnlyMarkets', 'n/a')}; com tentativa principal: {counts.get('primaryAttemptMarkets', 'n/a')}",
        "- A pausa impede novas execuções principais; a observação shadow continua."
        if report.get('operational', {}).get('tradingActive') is False else "- Consultar estado operacional antes de interpretar ausência de execuções.",
        f"- Tentativas com lado / total: {ratio(signals, attempts)}",
        f"- Execuções / tentativas com lado: {ratio(executed, signals)}",
        f"- Execuções / total: {ratio(executed, attempts)}",
        f"- Resolvidas / execuções: {ratio(resolved, executed)}",
        "- Contagens por resultado final de mercado; incluem paper. Ter lado não garante elegibilidade CLOB.",
        f"- Live resolvidas: {pnl.get('liveResolvedFills', 'n/a')}; paper resolvidas: {pnl.get('paperResolvedFills', 'n/a')}",
        f"- W/L: {pnl.get('wins', 'n/a')}/{pnl.get('losses', 'n/a')}",
        f"- P&L líquido: ${pnl.get('totalPnlUsd', 'n/a')}; fees: ${pnl.get('totalFeesUsd', 'n/a')}",
        "",
        "### Backtest descritivo — holdout móvel", "",
        f"- Mercados: {backtest['sample']['distinctMarkets']}; holdout: {backtest['sample']['holdoutMarkets']}",
        "- Comparações sucessivas sobrepõem dados; não são confirmações independentes.",
    ]
    for s in backtest["strategies"]:
        h = s["holdout"]
        lines.append(f"- {s['mode']}: {h['trades']} trades; WR {percent(h['winRate'])}; P&L ${h['feeAwarePnlUsd']}; ROI {percent(h['roi'])}; drawdown ${h['maxDrawdownUsd']}")
    lines += ["", "### Validação por estratégia e janela — dias UTC completos", "",
              "- Exige 3 blocos consecutivos com evidência anterior; aprovação significa apenas revisão paper.",
              "- Blocos sem sobreposição podem continuar correlacionados. Exige validação prospetiva e avaliação do drawdown/latência.",
              "", "| Estratégia | Janela | Blocos aprovados consecutivos | Estado | Média P&L/bloco | Desvio padrão |",
              "|---|---|---:|---|---:|---:|"]
    for s in backtest["strategies"]:
        for w in s["windows"]:
            v = w.get("validation")
            if not v:
                lines.append(f"| {s['mode']} | {w['entry']} | n/a | validação indisponível | n/a | n/a |")
                continue
            latest = v.get('blocks', [{}])[-1] if v.get('blocks') else {}
            detail = f"{v['status']}; último={latest.get('holdoutStatus', 'n/a')}, anterior={latest.get('priorStatus', 'n/a')}"
            lines.append(f"| {s['mode']} | {w['entry']} | {v['consecutivePassingBlocks']}/{v['requiredConsecutiveBlocks']} | {detail} | {v['meanBlockPnlUsd']} | {v['stddevBlockPnlUsd']} |")
    if prospective:
        lines += ["", "### Experiência shadow prospetiva — período fixo", "",
                  f"- {prospective['startUtc']} a {prospective['endUtc']}: {prospective['status']}",
                  "- Sem ordens. Nenhum resultado promove automaticamente uma estratégia."]
        for hypothesis in prospective['hypotheses']:
            blocks = hypothesis['blocks']
            trades = sum(b['metrics']['trades'] for b in blocks)
            net = sum(b['metrics']['feeAwarePnlUsd'] for b in blocks)
            excluded = sum(b['timingExcludedMarkets'] for b in blocks)
            lines.append(f"- {hypothesis['mode']} {hypothesis['entry']}: {trades} resolvidas shadow; P&L ${net:.2f}; {excluded} observações excluídas por horário.")
    if opportunities:
        metrics = opportunities['metrics']
        lines += ["", "### Scanner público — pares complementares do mesmo mercado", "",
                  f"- Estado: {opportunities['status']}; mercados selecionados: {opportunities['selectedMarkets']}; rondas: {opportunities['completedRounds']}/{opportunities['requestedRounds']}",
                  f"- Observações positivas / pares avaliáveis: {ratio(metrics['positivePairObservations'], metrics['evaluatedPairs'])}",
                  f"- Mercados positivos distintos: {metrics['distinctPositiveMarkets']}; episódios: {metrics['opportunityEpisodes']}; repetidos: {metrics['repeatedEpisodes']}",
                  f"- Maior intervalo entre amostras positivas consecutivas: {metrics['longestObservedSpanSeconds']} s",
                  "- Recolhas curtas por execução; não é monitorização contínua nem prova de execução.",
                  "- Sem ordens. Fees por mercado, profundidade reduzida a 90% e reservas de custos assumidas.",
                  f"- Rejeições: {json.dumps(metrics['rejections'], sort_keys=True)}",
                  f"- Erros de recolha: {json.dumps(opportunities['collectionErrors'], sort_keys=True)}"]
        peak = metrics['peakIndicativeOpportunity']
        if peak:
            lines += [f"- Melhor margem potencial observada: ${peak['netEdgeUsd']}; custo total estimado: ${peak['totalCostUsd']}; fees: ${peak['feesUsd']}; reserva: ${peak['costReserveUsd']}",
                      f"- Custo máximo de uma perna sem cobertura: ${peak['maximumUnhedgedLegCostUsd']}. As duas compras não são atómicas."]
        else:
            lines.append("- Nenhuma oportunidade líquida positiva observada nos dados avaliáveis.")
        lines.append("- Não somar observações repetidas como lucro; sem P&L realizado ou rendimento diário projetado.")
    lines.append("\nDetalhes dos blocos, fees, ROI, drawdown e Wilson 95% no artefacto sanitizado (30 dias).")
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

