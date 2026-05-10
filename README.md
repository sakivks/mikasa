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
