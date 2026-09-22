# Novos mercados e estratégias — investigação de 22/09/2026

## Decisão

Não há vantagem demonstrada que justifique ativar uma nova estratégia com dinheiro real. Prioridade: estudar desporto pré-jogo e cestos completos de resultados; meteorologia fica numa segunda fase. Estas propostas não são modos implementados do motor BTC, nem alteram config.yaml, stakes, recuperação ou limites.

O scanner existente já procura pares binários em mercados gerais por volume. Ainda exclui negative-risk, relações entre eventos e market making. Mudar apenas BTC para ETH não cria uma vantagem independente e mantém exposição correlacionada.

## Universo e hipóteses

| Prioridade | Mercado / estratégia | Hipótese verificável | Dados e motivo para rejeitar |
|---|---|---|---|
| 1 | Desporto pré-jogo: ténis vencedor; futebol 1X2; MLB/NFL moneyline | Comparar preços executáveis com consenso externo sem margem e simular ordens post-only | Odds com timestamp e licença, regras equivalentes (empate, prolongamento, abandono), book e trades. Rejeitar odds atrasadas, divergência de regras, eventos já iniciados e seleção adversa |
| 2 | Eventos mutuamente exclusivos: cesto completo de resultados | Procurar soma de custos de aquisição abaixo do payout mínimo garantido pelas regras | Enumerar todos os resultados e contratos, profundidade de cada perna, fees e saída de emergência. Rejeitar conjuntos incompletos, augmented negative-risk, placeholders e Other variável |
| 3 | Temperatura máxima diária, inicialmente cidades dos EUA | Comparar probabilidades calibradas por estação com preços por intervalo | Arquivar previsões publicadas antes da aposta, erros históricos, estação, unidades, arredondamento e regra de resolução. Rejeitar previsão pontual tratada como distribuição e informação posterior ao corte |
| 4 | Liquidez passiva em eventos de curta duração | Spread capturado menos seleção adversa e custos de inventário positivo sem subsídios | Fila de execução, cancelamentos e markout a 10s/60s/5min. Rewards e rebates num livro separado; rejeitar se só a previsão de incentivos torna o resultado positivo |

Exemplos de universos confirmados nas páginas públicas em 22/09/2026: [desporto](https://polymarket.com/sports/live) inclui ténis, futebol, MLB e NFL; [meteorologia](https://polymarket.com/predictions/weather) apresenta mercados diários de temperatura, incluindo Tokyo, Hong Kong e Seoul. São exemplos de disponibilidade, não recomendações de aposta. A shortlist inicial de meteorologia deve usar estações com dados verificáveis, por exemplo Chicago/Miami quando existirem contratos elegíveis.

Não foi obtido um snapshot simultâneo executável de todos os books: a chamada direta à Gamma devolveu HTTP 403 neste ambiente. As páginas públicas confirmam categorias, mas não uma oportunidade líquida nem uma ordem preenchível. Não contornar restrições geográficas.

## Experiência 1: desporto pré-jogo

1. Fixar previamente ligas e horizontes (24h, 6h, 1h antes do início), sem escolher os jogos depois de conhecer os resultados. Descoberta por tags/eventos e amostra por categoria, em vez de apenas volume global.
2. Obter odds decimais comparáveis de pelo menos duas fontes autorizadas. Para cada fonte, usar p_i = (1/odd_i) / soma(1/odd_j); guardar a margem retirada. O consenso é uma referência a validar, não a probabilidade verdadeira.
3. Simular ordens post-only e expirá-las antes do início. Um toque no preço não conta como fill: modelar fila, volume transacionado depois da entrada, cancelamentos e cenários pessimistas de latência.
4. Medir preço contra o consenso de fecho, fill-rate por ordem elegível, P&L por evento e inventário remanescente. Compras e vendas parciais entram no resultado; não eliminar jogos sem fills.

## Experiência 2: cestos completos

Para q shares de cada resultado exaustivo e exclusivo: margem = payout mínimo do conjunto - custo de todos os asks - fees de cada perna - slippage - conversão/gas - reserva de execução. O payout de q só pode ser usado depois de verificar as regras e a completude. Confirmar timestamps, profundidade e mínimos por perna. Compras em batch não são atómicas; simular a perda de liquidar uma perna preenchida quando as restantes falham.

A conversão negative-risk relaciona No de um resultado com Yes dos restantes, mas o suporte do adapter e as regras do evento precisam de validação separada. Não ativar esta lógica no executor binário atual. [Documentação oficial](https://docs.polymarket.com/concepts/negative-risk).

## Custos e incentivos

Usar metadata atual por mercado, nunca assumir fees zero ou aplicar a tabela crypto a todas as categorias. A documentação distingue taxas taker por categoria e makers sem trading fee; o custo de saída e de inventário continua a existir. [Fees](https://docs.polymarket.com/trading/fees).

Ordens post-only, expiração, cancelamento de cotações antigas e reconciliação após reconexões fazem parte do teste de maker. [Market making](https://docs.polymarket.com/trading/market-making).

Rewards dependem dos requisitos de tamanho/spread e da concorrência. O programa especial crypto TWAP de agosto terminou; atribuir-lhe zero nas projeções atuais. Não contar rewards estimados como receita realizada. [Liquidity rewards](https://docs.polymarket.com/programs/liquidity-rewards).

A API NWS disponibiliza previsões e observações nos EUA; a fonte contratual de resolução prevalece sempre sobre a fonte do modelo. [NWS API](https://www.weather.gov/documentation/services-web-api).

## Critérios de validação antes de qualquer promoção

- Separação temporal entre treino, validação e holdout; parâmetros e universo congelados antes do holdout. Registar todas as variantes, incluindo as falhadas.
- Piso proposto para a nova investigação: 30 dias e 200 eventos resolvidos distintos por hipótese, além de três blocos prospetivos completos consecutivos positivos após custos. É um piso de recolha, não garantia de poder estatístico. Calcular amostra necessária a partir da variância e da vantagem mínima economicamente útil.
- Intervalo de 95% do P&L médio líquido acima de zero por bootstrap agrupado por evento/dia; análise de dependência e correção da seleção entre hipóteses. Fills, vários outcomes e snapshots do mesmo evento não são observações independentes.
- Win-rate isolado e comparação Wilson com break-even médio não bastam quando stakes, preços e payouts variam. Validar diretamente retornos líquidos e sensibilidade a fees, fills, latência e saída forçada.
- Incluir custos de dados/servidor e capital imobilizado. Reporting: P&L sem incentivos, incentivos realmente recebidos, drawdown, retorno por capital-dia, fill-rate e perdas nas piores execuções.
- Não reduzir os critérios existentes do estudo BTC. Se qualquer requisito falhar, manter apenas recolha/shadow, sem ativar live ou elevar limites.

## Ordem de implementação proposta

Primeiro: coletor público por categoria e arquivo temporal de books/odds; depois simulador maker com fila conservadora; só depois scanner de cestos com validação de regras. Nenhum dos três está implementado por esta documentação. Arbitragem entre plataformas fica adiada: regras, elegibilidade, transferências e necessidade de financiar duas contas tornam-na inadequada para a primeira experiência.
