# Polymoney

Research software, not a demonstrated source of income. The BTC 5-minute engine is implemented; sports, weather and multi-outcome baskets are research proposals, not enabled strategies. Start in paper mode without wallet credentials.

- [New strategies and markets (PT)](docs/research-roadmap.md)
- [Public source release](docs/public-release.md) · [Security](SECURITY.md)

Automated bot for the **Polymarket Bitcoin Up/Down 5-minute** market. It discovers the active market, waits for the configured timing window, and places paper or live orders via SecureClient (deposit wallet).

[README em português](README.md)

## How it works

1. Builds the current market slug: `btc-updown-5m-{unix_timestamp}` (300s windows)
2. Fetches token IDs and close time from the [Gamma API](https://gamma-api.polymarket.com)
3. Waits until `bet_seconds_before_close` seconds before window end
4. Picks a side with the configured **strategy** (e.g. Chainlink momentum)
5. Sizes the stake (`fixed` / `paroli` / `all_in`) and applies safety checks (depth, max price, circuit breaker)
6. Places a market order if there is an ask ≤ `max_price`; otherwise a resting limit (when `allow_limit_without_ask` is on)
7. Resolves P&L after close (Gamma / Chainlink) and updates staking state

## Strategies

| Mode | Description |
|------|-------------|
| `momentum` | Current BTC vs window open (Chainlink — same resolution source). Up if above, Down if below |
| `book_leader` | Side with the higher book mid |
| `cheapest` | Cheaper outcome |
| `fixed` | Fixed side (`fixed_side`) |

With `on_neutral: skip`, the bot skips when the signal is weak (e.g. `|delta| < min_delta_bps`).

## Staking (order size)

| Mode | Description |
|------|-------------|
| `fixed` | Fixed share size (`bet.size_shares`) |
| `paroli` | `base_usd` + series profits (reset on loss) |
| `all_in` | Nearly 100% of USDC balance (~1.5% reserved for CLOB fee estimate) |

Related options: `recovery_cap`, `confidence` (scales stake by delta/price), `max_stake_usd`, circuit breaker (`max_consecutive_losses`, `max_daily_loss_usd`).

## Requirements

- Node.js ≥ 24
- Polymarket deposit wallet (signature type 3) + USDC — live only
- Signer private key — live only

## Local setup

```bash
cp .env.example .env
cp config.example.yaml config.local.yaml
export CONFIG_PATH=config.local.yaml
# Edit .env: PRIVATE_KEY, DEPOSIT_WALLET_ADDRESS (live)
# Edit config.local.yaml; keep trading.mode: paper

npm ci
npm run dev                 # hot reload
# or
npm run build && npm start
```

## Configuration

Non-secrets → **`config.yaml`**. Secrets → **`.env`** (or host env vars).

### config.yaml — main knobs

| Section | Key | Description |
|---------|-----|-------------|
| `timing` | `bet_seconds_before_close` | When to attempt the bet (e.g. 60) |
| `strategy` | `mode` | `momentum`, `book_leader`, `cheapest`, `fixed` |
| `strategy` | `min_delta_bps` | Minimum BTC delta (momentum) |
| `strategy` | `on_neutral` | `skip` / `up` / `down` |
| `bet` | `max_price` | Max price per share |
| `bet` | `use_market_order` | `true` = taker when a usable ask exists |
| `staking` | `mode` | `fixed`, `paroli`, `all_in` |
| `staking` | `base_usd` | Base (paroli) / fallback (all_in) |
| `trading` | `mode` | `paper` or `live` |
| `trading` | `signature_type` | `3` = deposit wallet |
| `safety` | `size_to_depth` | Cap size to ask depth ≤ max_price |
| `safety` | `allow_limit_without_ask` | Resting limit if no ask ≤ max_price |
| `safety` | `max_consecutive_losses` | Pause after N losses in a row (0 = off) |
| `safety` | `max_daily_loss_usd` | Pause if UTC day P&L ≤ −this amount |
| `pnl` | `enabled` | P&L tracking |
| `telegram` | `enabled` | Notifications + commands |

### .env — secrets

| Variable | Live | Description |
|----------|------|-------------|
| `PRIVATE_KEY` | Yes | Signer (`0x…`) |
| `DEPOSIT_WALLET_ADDRESS` | Yes | Deposit wallet (funder) |
| `TELEGRAM_BOT_TOKEN` | If telegram on | BotFather token |
| `TELEGRAM_CHAT_ID` | If telegram on | Chat ID |
| `DASHBOARD_TOKEN` | No | Protects `/pnl` and API (`?token=` or cookie) |
| `CONFIG_PATH` | No | Alternate path to config.yaml |

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather)
2. Get your chat ID ([@userinfobot](https://t.me/userinfobot) or `getUpdates`)
3. Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `.env`
4. Set `telegram.enabled: true` in config

Notifications: bet, P&L (configurable). Commands: `/status`, `/saldo`, `/ultimas`, `/help`.

## Dashboard

```
http://localhost:3000/pnl
# with token: http://localhost:3000/pnl?token=YOUR_TOKEN
```

Live SSE: P&L, win rate, balance, bot state, trade history.  
API: `GET /api/status` · Stream: `GET /api/stream` · Health: `GET /health`

## Paper mode

`trading.mode: paper` — simulates without sending orders. Useful for timing and discovery.

## Deposit wallet (live)

New accounts use signature type **3**. Live trading goes through `@polymarket/client` (SecureClient). Plain `clob-client-v2` fails on deposit wallets ([bug #65](https://github.com/Polymarket/clob-client-v2/issues/65)).

Diagnostics:

```bash
bash scripts/run-deposit-wallet-test.sh          # auth + balance
bash scripts/run-deposit-wallet-test.sh --live   # + test order
```

## Deploy

- **Railway:** connect the repo; set env vars; `Dockerfile` + `railway.toml`; health on `:3000/health`
- **VPS/systemd:** `npm run build && npm start` (or a `polymoney` unit)

## Disclaimer

Live mode uses real money. No profit guarantee. Fees, latency, slippage, and geoblocking can prevent fills. Use at your own risk.

## Buy me a coffee

If this project helps you, you can support its development via [Revolut — @josef020](https://revolut.me/josef020). Support is voluntary and does not purchase trading signals or promised returns.

## Licensing

Public source; no repository-wide reuse license has been granted. See [release notes](docs/public-release.md#licensing).
