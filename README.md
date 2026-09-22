# Polymoney

Software de investigação, sem rentabilidade demonstrada. O motor BTC de 5 minutos está implementado; desporto, meteorologia e cestos de resultados são propostas de investigação, ainda não ativadas. Começa em modo paper, sem credenciais de carteira.

- [Novas estratégias e mercados](docs/research-roadmap.md)
- [Versão pública](docs/public-release.md) · [Segurança](SECURITY.md)

Bot automatizado para o mercado **Polymarket Bitcoin Up/Down 5 minutos**. Descobre o mercado ativo, espera o timing configurado e coloca a aposta (paper ou live) via SecureClient (deposit wallet).

[English README](README.en.md)

## Como funciona

1. Calcula o slug do mercado atual: `btc-updown-5m-{unix_timestamp}` (janelas de 300s)
2. Consulta a [Gamma API](https://gamma-api.polymarket.com) para token IDs e fecho
3. Espera até `bet_seconds_before_close` segundos antes do fim da janela
4. Decide o lado com a **estratégia** (ex. momentum Chainlink)
5. Dimensiona o stake (`fixed` / `paroli` / `all_in`), aplica safety (depth, max price, circuit breaker)
6. Coloca market order se houver ask ≤ `max_price`; senão limit resting (se `allow_limit_without_ask`)
7. Resolve P&L após o fecho (Gamma / Chainlink) e actualiza staking

## Estratégias

| Modo | Descrição |
|------|-----------|
| `momentum` | BTC atual vs open da janela (Chainlink — fonte de resolução). Up se acima, Down se abaixo |
| `book_leader` | Lado com mid mais alto no book |
| `cheapest` | Outcome mais barato |
| `fixed` | Lado fixo (`fixed_side`) |

Com `on_neutral: skip`, não aposta se o sinal for fraco (ex. `|delta| < min_delta_bps`).

## Staking (tamanho da aposta)

| Modo | Descrição |
|------|-----------|
| `fixed` | Tamanho fixo em shares (`bet.size_shares`) |
| `paroli` | `base_usd` + ganhos da série (reset à perda) |
| `all_in` | Quase 100% do saldo USDC (reserva ~1.5% para fee CLOB) |

Opções relacionadas: `recovery_cap`, `confidence` (escala stake pelo delta/preço), `max_stake_usd`, circuit breaker (`max_consecutive_losses`, `max_daily_loss_usd`).

## Requisitos

- Node.js ≥ 24
- Conta Polymarket com deposit wallet (signature type 3) e USDC — só em live
- Chave privada do signer — apenas em live

## Setup local

```bash
cp .env.example .env
cp config.example.yaml config.local.yaml
export CONFIG_PATH=config.local.yaml
# Edita .env: PRIVATE_KEY, DEPOSIT_WALLET_ADDRESS (live)
# Edita config.local.yaml; mantém trading.mode: paper

npm ci
npm run dev                 # hot reload
# ou
npm run build && npm start
```

## Configuração

Não-secreto → **`config.yaml`**. Secrets → **`.env`** (ou env vars no host).

### config.yaml — principais variáveis

| Secção | Variável | Descrição |
|--------|----------|-----------|
| `timing` | `bet_seconds_before_close` | Quando tentar apostar (ex. 60) |
| `strategy` | `mode` | `momentum`, `book_leader`, `cheapest`, `fixed` |
| `strategy` | `min_delta_bps` | Delta mínimo BTC (momentum) |
| `strategy` | `on_neutral` | `skip` / `up` / `down` |
| `bet` | `max_price` | Preço máximo por share |
| `bet` | `use_market_order` | `true` = taker se houver ask utilizável |
| `staking` | `mode` | `fixed`, `paroli`, `all_in` |
| `staking` | `base_usd` | Base (paroli) / fallback (all_in) |
| `trading` | `mode` | `paper` ou `live` |
| `trading` | `signature_type` | `3` = deposit wallet |
| `safety` | `size_to_depth` | Limitar stake à liquidez ≤ max_price |
| `safety` | `allow_limit_without_ask` | Limit resting se não houver ask ≤ max_price |
| `safety` | `max_consecutive_losses` | Pausa após N perdas seguidas (0 = off) |
| `safety` | `max_daily_loss_usd` | Pausa se P&L do dia UTC ≤ −este valor |
| `pnl` | `enabled` | Tracking de P&L |
| `telegram` | `enabled` | Notificações + comandos |

### .env — secrets

| Variável | Live | Descrição |
|----------|------|-----------|
| `PRIVATE_KEY` | Sim | Signer (`0x…`) |
| `DEPOSIT_WALLET_ADDRESS` | Sim | Deposit wallet (funder) |
| `TELEGRAM_BOT_TOKEN` | Se telegram on | Token @BotFather |
| `TELEGRAM_CHAT_ID` | Se telegram on | Chat ID |
| `DASHBOARD_TOKEN` | Não | Protege `/pnl` e API (`?token=` ou cookie) |
| `CONFIG_PATH` | Não | Caminho alternativo ao config.yaml |

## Telegram

1. Cria bot com [@BotFather](https://t.me/BotFather)
2. Obtém chat ID ([@userinfobot](https://t.me/userinfobot) ou `getUpdates`)
3. No `.env`: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
4. `telegram.enabled: true` no config

Notificações: aposta, P&L (configurável). Comandos: `/status`, `/saldo`, `/ultimas`, `/help`.

## Dashboard

```
http://localhost:3000/pnl
# com token: http://localhost:3000/pnl?token=TEU_TOKEN
```

SSE em tempo real: P&L, win rate, saldo, estado do bot, histórico.  
API: `GET /api/status` · Stream: `GET /api/stream` · Health: `GET /health`

## Modo paper

`trading.mode: paper` — simula sem enviar ordens. Bom para timing e descoberta.

## Deposit wallet (live)

Contas novas usam signature type **3**. Live usa `@polymarket/client` (SecureClient). O `clob-client-v2` sozinho falha em deposit wallets ([bug #65](https://github.com/Polymarket/clob-client-v2/issues/65)).

Diagnóstico:

```bash
bash scripts/run-deposit-wallet-test.sh          # auth + saldo
bash scripts/run-deposit-wallet-test.sh --live   # + ordem de teste
```

## Deploy

- **Railway:** liga o repo; define env vars; `Dockerfile` + `railway.toml`; health em `:3000/health`
- **VPS/systemd:** `npm run build && npm start` (ou unit `polymoney`)

## Aviso

Modo live usa dinheiro real. Sem garantia de lucro. Fees, latência, slippage e geoblock podem impedir fills. Usa por tua conta e risco.

## Buy me a coffee

Se este projeto te for útil, podes apoiar o desenvolvimento através do [Revolut — @josef020](https://revolut.me/josef020). O apoio é voluntário e não compra sinais de trading nem promessas de rentabilidade.

## Licença

Código público, ainda sem licença geral de reutilização. Consulta as [notas da versão](docs/public-release.md#licensing).
