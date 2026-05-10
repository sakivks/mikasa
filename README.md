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
- `pnpm cli -- fetch-options <underlying> <from> <to>` — fetch and cache weekly options chains (see Options strategies below)
- `pnpm cli -- backtest <run-config.yaml>` — run a backtest, write HTML report
- `pnpm cli -- cache-info [--symbol <s>]` — list cached coverage

## Run config

See [`run-configs/sma-crossover-reliance.yaml`](run-configs/sma-crossover-reliance.yaml).

## Options strategies (NIFTY / BANKNIFTY weekly)

mikasa supports multi-leg options backtesting on Indian index weeklies. Two strategies ship in v1:

- **Short straddle** — expiry-day intraday, sells ATM CE+PE, exits on premium SL/target/EOD
- **Iron condor** — weekly hold (Mon→Thu), 4-leg defined-risk premium collection

Both apply realistic Zerodha-schedule charges (STT, brokerage, exchange, SEBI, GST, stamp duty per leg) and an estimated SPAN-style margin model.

### Prerequisites

Options backtesting needs three inputs that the bundled fetch path does not yet automate:

1. **Kite credentials** — same as equity (`.env` with `KITE_API_KEY` / `KITE_API_SECRET` / `KITE_ACCESS_TOKEN`).
2. **NSE bhavcopy archive directory** — daily F&O bhavcopy CSVs from `archives.nseindia.com`, one per trading day. Used to enumerate historical contracts (Kite only serves the current instrument dump).
3. **Token map JSON** — `(underlying|expiryISO|strike|optionType) → { token, lotSize }`. Generated via a one-time export of `kite.getInstruments('NFO')`. Legacy shape (just `token`) is also accepted with a fallback lot-size.

### Fetch options data

```bash
pnpm cli fetch-options NIFTY 2025-05-01 2026-05-01 \
  --bhavcopy-dir ./bhavcopy \
  --token-map ./tokens.json
```

This populates `data-cache/instruments/options_instruments` (DuckDB) and per-contract 1-minute candles for ATM±10 strikes per weekly expiry.

### Run a backtest

```bash
pnpm cli backtest run-configs/short-straddle-nifty.yaml
# or
pnpm cli backtest run-configs/iron-condor-nifty.yaml
```

The backtest CLI auto-resolves `atmContracts` (short straddle) or `weeklyContracts` (iron condor) from the cached data before the engine starts. The HTML report includes a per-expiry options section with charge drag % and margin utilization (peak/avg).

### Custom strategies

Strategies are class-based (`extends Strategy`) and registered in [`src/strategies/registry.ts`](src/strategies/registry.ts). See [`src/strategies/short-straddle.ts`](src/strategies/short-straddle.ts) and [`src/strategies/iron-condor.ts`](src/strategies/iron-condor.ts) for patterns. Multi-leg orders go through `ctx.submitMultiLeg(...)` and fill atomically next bar.

### Limitations (v1)

- Margin model is a flat percentage of notional (not real SPAN)
- Bid-ask slippage is 1-tick adverse (configurable via `slippageBps`); no spread modeling
- No live/paper trading — backtest only
- Holds always force-exit before expiry close (no settlement modeling)
- Calendar / butterfly / ratio strategies not in v1

See [`docs/superpowers/specs/2026-05-10-options-strategies-design.md`](docs/superpowers/specs/2026-05-10-options-strategies-design.md) for full design.

## Design

See [`docs/superpowers/specs/2026-05-10-algo-trading-bot-design.md`](docs/superpowers/specs/2026-05-10-algo-trading-bot-design.md).

## Test

```bash
pnpm test
```
