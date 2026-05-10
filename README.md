# mikasa — Algo Trading Bot (Backtest, Milestone 1)

A TypeScript backtest engine for Indian intraday equities via Zerodha Kite Connect.

## Quick start

```bash
pnpm install
cp .env.example .env   # then fill in KITE_API_KEY / KITE_API_SECRET / KITE_ACCESS_TOKEN
pnpm cli -- fetch RELIANCE 2025-01-01 2025-01-31 5minute
pnpm cli -- backtest run-configs/sma-crossover-reliance.yaml
open reports/<run-id>.html
```

## Data sources

The bot supports two historical data sources:

- `kite` (default): Zerodha Kite Connect. Requires API credentials in `.env`. Larger lookback, paid subscription.
- `yahoo`: Yahoo Finance via `yahoo-finance2`. Free, no credentials. Limited to ~60 days for intraday intervals; lower data quality.

Select per run-config:

```yaml
source: yahoo
```

Or per `fetch` invocation: `pnpm cli fetch RELIANCE 2025-01-01 2025-01-31 5minute --source yahoo`.

### Daily Kite auth

Kite access tokens expire every morning around 06:00 IST. Daily flow:

```bash
# 1. Print login URL (or open it manually in a browser)
pnpm cli auth --login

# 2. Login to Zerodha; browser redirects to your app URL with ?request_token=<TOKEN>
# 3. Exchange the request_token for a fresh access_token (writes to .env automatically)
pnpm cli auth <request_token>
```

## Commands

- `pnpm cli -- fetch <symbol> <from> <to> <interval>` — fetch and cache historical candles
- `pnpm cli -- backtest <run-config.yaml>` — run a backtest, write HTML report
- `pnpm cli -- cache-info [--symbol <s>]` — list cached coverage

## Run config

See [`run-configs/sma-crossover-reliance.yaml`](run-configs/sma-crossover-reliance.yaml).

## Design

See [`docs/superpowers/specs/2026-05-10-algo-trading-bot-design.md`](docs/superpowers/specs/2026-05-10-algo-trading-bot-design.md).

## Test

```bash
pnpm test
```
