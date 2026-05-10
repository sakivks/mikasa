# Algo Trading Bot — Design

**Date:** 2026-05-10
**Project:** mikasa
**Status:** Draft (post-brainstorm, pre-implementation-plan)

## Summary

A standalone TypeScript algorithmic trading bot for Indian equities via Zerodha Kite Connect. First milestone is **backtest-only**: deterministic intraday backtests against a local DuckDB cache of historical candles, with a pluggable strategy interface and a full HTML report (metrics + equity curve + trade list) per run.

Paper trading and live trading are explicit non-goals for milestone 1, but the engine, broker model, and strategy interface are designed so a `LiveBroker` / `PaperBroker` can replace `BrokerSim` without touching strategy code.

## Goals

- Run an intraday strategy over historical data and produce a trustworthy report
- Author new strategies in a small amount of typed code (no JSON-rule DSL)
- Iterate fast: cached data, no API calls on rerun, sub-minute backtest for one symbol-month at 5min
- Deterministic: same config + same cache → identical report (seeded)
- Clear seams for adding paper/live execution later

## Non-goals (milestone 1)

- Live or paper order execution
- Options / F&O / multi-leg strategies
- Tick-level (sub-minute) simulation
- Walk-forward optimization, parameter sweeps, ML pipelines
- Portfolio optimization across many symbols (basket support exists, but no allocation logic beyond per-strategy sizing)
- Multi-broker abstraction beyond Zerodha

## Stack

- Node 20+, TypeScript strict
- pnpm, vitest, eslint, prettier
- `kiteconnect` npm — Kite Connect SDK
- `@duckdb/node-api` — local cache
- `technicalindicators` — SMA/EMA/RSI/ATR/etc.
- `zod` — config validation
- `pino` — structured logging
- `yaml` — run-config parsing
- HTML report: self-contained file, Chart.js inlined

## Architecture

Single-package monolith with strict folder boundaries.

```
mikasa/
  src/
    data/         # Kite client + DuckDB cache (fetch, store, query candles)
    engine/       # backtest loop, broker simulator, portfolio, fill model
    strategies/   # strategy base class + concrete strategies
    indicators/   # typed wrappers over `technicalindicators`
    report/       # metrics + HTML report
    cli/          # commands: fetch, backtest, cache-info
    config/       # env + yaml run-config loaders (zod-validated)
    types/        # Candle, Order, Fill, Position, Trade, RunConfig
    util/         # logger (pino), time helpers (IST tz)
  data-cache/     # DuckDB file (gitignored)
  reports/        # generated HTML reports (gitignored)
  logs/           # per-run logs (gitignored)
  test/
    fixtures/     # committed candle CSVs for deterministic integration tests
  run-configs/    # YAML configs (committed examples + user files)
```

### Top-level data flow

```
Kite API ──► data/cache (DuckDB) ──► engine ──► strategy.onBar ──► orders
                                       │
                                       ▼
                                   broker sim ──► fills ──► portfolio
                                                              │
                                                              ▼
                                                  trade log + equity ──► report
```

## Components

### `data/`

- **`KiteClient`**
  - Auth from env: `KITE_API_KEY`, `KITE_API_SECRET`, `KITE_ACCESS_TOKEN`
  - `getHistorical(symbol, from, to, interval)` — wraps `kiteconnect`
  - Rate-limit aware (Kite: 3 req/s historical): exponential backoff on 429 (1s/2s/4s, max 5 retries)
  - Chunks date ranges into Kite's per-call window limits (60 days for minute-resolution at time of writing — verified against Kite docs at implementation time, not hard-coded if the SDK exposes it)

- **`CandleStore` (DuckDB)**
  - Schema:
    ```sql
    CREATE TABLE candles (
      symbol   VARCHAR  NOT NULL,
      ts       TIMESTAMP NOT NULL,   -- UTC
      interval VARCHAR  NOT NULL,    -- '1minute' | '5minute' | '15minute' | 'day'
      open     DOUBLE   NOT NULL,
      high     DOUBLE   NOT NULL,
      low      DOUBLE   NOT NULL,
      close    DOUBLE   NOT NULL,
      volume   BIGINT   NOT NULL,
      PRIMARY KEY (symbol, ts, interval)
    );
    CREATE TABLE coverage (
      symbol VARCHAR, interval VARCHAR,
      from_ts TIMESTAMP, to_ts TIMESTAMP,
      PRIMARY KEY (symbol, interval, from_ts)
    );
    ```
  - Methods: `upsert(rows)`, `query(symbol, from, to, interval)`, `coverage(symbol, interval)`
  - `upsert` uses `INSERT ... ON CONFLICT DO UPDATE` (idempotent)

- **`DataLoader`**
  - `load(symbol, from, to, interval)`:
    1. Read coverage for `(symbol, interval)`
    2. Compute missing ranges
    3. Fetch missing from Kite, upsert
    4. Update coverage table
    5. Return candles for the requested range, sorted by `ts`

### `engine/`

- **`BacktestEngine`**
  - Inputs: candles iterator (time-merged across symbols), strategy instance, broker sim, portfolio, run config
  - Loop:
    1. Pop next bar
    2. Process pending orders against this bar (orders submitted on prior bar)
    3. Update indicators with this bar's close
    4. `strategy.onBar(bar, ctx)` — strategy may submit new orders (filled on next bar)
    5. `portfolio.markToMarket(bar.close)` — append equity snapshot
    6. EOD squareoff: at the configurable `squareoff_time` (default `15:15 IST`), `OrderRouter` enqueues exit-all market orders for any open positions; they fill on the next bar like any other order. If the run reaches the final bar with positions still open (squareoff order had no next bar to fill on), the engine force-closes them at the final bar's close and logs a warning.
  - Asserts time-monotonic input. Asserts cash conservation each step in DEBUG mode.

- **`BrokerSim`**
  - Slippage convention: buys pay `price × (1 + slippage_bps/10_000)`, sells receive `price × (1 − slippage_bps/10_000)`. Always against the trader.
  - Fill model:
    - Market buy: fills at next bar's `open` with buy-slippage
    - Market sell: fills at next bar's `open` with sell-slippage
    - Limit buy: fills if next bar's `low <= limit`, at `min(limit, open)` with buy-slippage
    - Limit sell: fills if next bar's `high >= limit`, at `max(limit, open)` with sell-slippage
    - Stop buy: triggers if next bar's `high >= stop`, fills at `max(stop, open)` with buy-slippage
    - Stop sell: triggers if next bar's `low <= stop`, fills at `min(stop, open)` with sell-slippage
  - Brokerage model: `zerodha-intraday` — `min(0.03% × turnover, ₹20) per executed order` plus STT (0.025% sell), exchange (NSE 0.00322% turnover), GST (18% on brokerage + exchange), SEBI (₹10/crore), stamp duty (0.003% buy). Fee breakdown stored on each `Trade`.

- **`Portfolio`**
  - Tracks: cash, positions (`Map<symbol, { qty, avgPrice }>`), realized PnL, unrealized PnL, equity curve buffer (`{ ts, equity }[]`)
  - `applyFill(fill)` updates cash, position, realized PnL on close
  - `markToMarket(prices)` computes unrealized PnL and appends snapshot

- **`OrderRouter`**
  - Translates strategy intents (`buy`, `sell`, `exit`) to broker orders
  - Enforces intraday squareoff (15:15 IST bar emits exit-all)
  - Rejects orders that exceed available cash (logged, `onOrderRejected` invoked)

### `strategies/`

```ts
abstract class Strategy {
  abstract init(ctx: StrategyContext): void;
  abstract onBar(bar: Candle, ctx: StrategyContext): void;
  onOrderFill?(fill: Fill, ctx: StrategyContext): void;
  onOrderRejected?(reason: string, intent: OrderIntent, ctx: StrategyContext): void;
}

interface StrategyContext {
  position(symbol: string): Position | null;
  cash: number;
  submitOrder(intent: OrderIntent): OrderId;
  cancelOrder(id: OrderId): void;
  indicator: IndicatorRegistry;
  params: Record<string, unknown>;  // from run-config
  logger: Logger;
}
```

Reference strategy: `examples/SmaCrossover.ts` (fast/slow SMA cross — long-only, intraday).

### `indicators/`

Thin wrappers over `technicalindicators` exposing rolling-update API:

```ts
const sma = new SMA(period);
sma.update(close); // returns latest value or undefined while warming up
```

Indicators are registered in `Strategy.init()` through `ctx.indicator`. The engine fetches `warmup_bars` worth of history *before* the run-config `from` date (default 200 bars, configurable per run) and feeds those bars to indicators only — strategy `onBar` is not invoked during warmup, and no orders can be placed. This prevents indicator-warmup gaps without leaking warmup PnL into reported metrics.

### `report/`

- **`Metrics`**
  - Total return, CAGR (where applicable), Sharpe (daily, rf=0 default, configurable), Sortino, max drawdown (% and ₹), win rate, avg win, avg loss, expectancy, profit factor, total trades, avg trade duration, exposure %, fees paid

- **`HtmlReport`**
  - Single self-contained HTML file with embedded JSON data and inlined Chart.js
  - Sections: header (run config + summary stats), equity curve chart, drawdown chart, monthly returns table/heatmap, trade list table (sortable), per-symbol breakdown if multi-symbol

### `cli/`

- `mikasa fetch <symbol> <from> <to> <interval>` — populate cache
- `mikasa backtest <run-config.yaml>` — run backtest, write report
- `mikasa cache-info [symbol]` — show coverage per (symbol, interval)

### `config/`

- `.env`: `KITE_API_KEY`, `KITE_API_SECRET`, `KITE_ACCESS_TOKEN`
- Run config (zod-validated):
  ```yaml
  strategy: SmaCrossover
  params: { fast: 9, slow: 21 }
  symbols: [RELIANCE, INFY]
  from: 2025-01-01
  to:   2025-04-30
  interval: 5minute
  capital: 100000
  slippage_bps: 5
  brokerage: zerodha-intraday
  warmup_bars: 200
  squareoff_time: "15:15"
  seed: 42
  ```

## Key invariants

- **No lookahead.** Strategy sees bars up to and including the current bar (with `onBar` invoked after that bar's close is known). Orders submitted on bar N fill on bar N+1 at earliest. Engine asserts.
- **Time monotonic.** Bars feed strictly increasing `ts`. Engine asserts.
- **Cash conservation.** `cash + Σ(position.qty × mark_price) == initial_capital + realized_pnl − fees` at every step. Asserted in DEBUG mode.
- **Timezone.** All `ts` stored UTC in DuckDB; displayed and compared in IST in run logic. Market hours filter `09:15:00 – 15:30:00 IST`.
- **Idempotent cache.** `(symbol, ts, interval)` is the primary key; re-fetch overwrites.
- **Determinism.** Same config + same cache → identical report. All non-determinism (slippage randomization if enabled, tie-breaking) seeded via `seed:` in run-config.

## Order lifecycle

```
submitted → (next bar) → filled
                       │
                       ├─► rejected (insufficient cash / limits)
                       │
                       └─► (limit) pending → filled
                                          │
                                          └─► expired-EOD (auto-cancelled at squareoff)
```

## Error handling

| Source | Failure | Policy |
|---|---|---|
| Kite auth | bad/expired access_token | fail fast at startup; log Kite login URL |
| Kite API | 429 rate limit | exponential backoff (1s/2s/4s, max 5 retries), then fail run |
| Kite API | network timeout | 3 retries with backoff, then fail run |
| Kite API | partial data (gap) | log warn, store what came back, mark gap in coverage |
| DuckDB | write fail | abort run; never silently drop rows |
| Run config | missing/bad field | zod parse, fail at load with field path |
| Strategy | throws in `onBar` | abort run, dump bar context + stack |
| Engine | invariant assertion (cash, lookahead, time) | hard crash with full state dump (bug, not user error) |
| Order | insufficient cash | reject order, emit `onOrderRejected`, continue run |

**Logging:** `pino` JSON to stdout + per-run file at `logs/<run-id>.log`. Run-id = `YYYYMMDD-HHMMSS-<strategy>`.

**No silent failures.** Every catch logs and chooses: retry / abort / reject-and-continue. No bare `catch {}`.

**No silent fills for missing data.** If cache is short and Kite fetch fails, the run aborts. No forward-fill or zero-pad.

## Testing

### Unit (vitest)

- `data/CandleStore` — upsert idempotency, query bounds, coverage gap detection
- `data/DataLoader` — mocked Kite client; cache-hit / miss / partial-coverage paths
- `engine/BrokerSim` — market fills next-bar open; limit fills only when bar range crosses; EOD squareoff at 15:15 IST
- `engine/Portfolio` — cash math after buy/sell/fees, mark-to-market, equity snapshot
- `engine/BacktestEngine` — no-lookahead invariant (a strategy that peeks fails the test), time-monotonic assertion
- `indicators/*` — known input → known output (golden values vs `technicalindicators`)
- `report/Metrics` — Sharpe/Sortino/MDD on synthetic equity curves with hand-computed expected values
- `strategies/SmaCrossover` — given 50-bar synthetic series, expected entries/exits

### Integration

- End-to-end backtest on **fixture CSV** (no live Kite): seeded 1-month 5min RELIANCE data committed to `test/fixtures/`. Asserts deterministic PnL, trade count, final equity.
- DuckDB roundtrip: write candles → query → equality
- HTML report generation: render and parse output, assert sections present and metrics non-NaN

### Manual / smoke (not in CI)

- `mikasa fetch` against real Kite (requires creds)
- HTML report opens in browser, charts render

### CI

GitHub Actions: `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`. No live Kite calls in CI.

## Open questions (defer to implementation plan)

- Exact monthly returns calculation (calendar month vs rolling 21-bar) — pick during report impl
- Whether `cache-info` should warn on detected gaps within otherwise-covered ranges
- Per-symbol position sizing model: fixed-qty, fixed-₹, percent-of-equity — start with fixed-₹, extend later

## Future extensions (out of scope for milestone 1)

- `PaperBroker` (live ticks via Kite WebSocket, simulated fills) — replaces `BrokerSim` behind same interface
- `LiveBroker` (real Kite orders) — replaces `BrokerSim` behind same interface
- Walk-forward param sweeps, parallel run executor
- Multi-strategy portfolio with allocation
- Options strategies (requires options chain handling, margin calc)
