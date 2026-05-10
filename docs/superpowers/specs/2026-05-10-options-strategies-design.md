# Options Strategies — Design Spec

**Date**: 2026-05-10
**Status**: Draft (pending user review)
**Scope**: Add options backtesting to mikasa, supporting two Indian-market strategies on weekly index expiries.

## Goal

Extend mikasa from equity-only intraday backtesting to support multi-leg options strategies on Indian index weeklies (NIFTY, BANKNIFTY). Deliver two strategies in v1:

1. **Short Straddle** — expiry-day intraday, exploits theta + IV crush
2. **Iron Condor** — weekly hold (Mon entry, Thu exit), defined-risk premium collection

Both strategies share infrastructure (multi-leg orders, per-leg charges, estimated SPAN margin, multi-instrument timeline). v1 is backtest-only — no paper or live trading.

## Non-goals (v1)

- Calendar spreads, butterflies, ratio backspreads, delta-hedged structures
- Real SPAN/portfolio margin (use flat percentage estimate)
- Bid-ask slippage from spread modelling (1-tick slippage flat)
- Greek-based entries/exits
- Holding positions through expiry settlement (force-exit before close)
- Live/paper trading plumbing

## Scope decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Underlyings | NIFTY + BANKNIFTY weekly expiries |
| Execution mode | Backtest only |
| Candle granularity | 1-minute (resampled to 5m where strategies need it) |
| Strike universe per expiry | ATM ± 10 strikes (CE+PE = 42 contracts/expiry) |
| Charges fidelity | Realistic Zerodha schedule — brokerage + STT + exchange + SEBI + GST + stamp duty per leg |
| Margin model | Flat % of notional for naked shorts; max-loss formula for defined-risk spreads |
| Backtest period (initial) | 1 year (~52 expiries) |
| Engine architecture | Multi-instrument timeline + multi-leg positions (single engine handles equity + options) |

## Architecture

### Module layout

```
src/
  types/
    options.ts                  NEW
    index.ts                    add re-exports
  data/
    instrument-store.ts         EXTEND: index NFO-OPT instruments by (underlying, expiry, strike, type)
    options-chain.ts            NEW: ATM resolution, contract lookup
    nse-bhavcopy.ts             NEW: fetch historical instrument list from NSE archive
    kite-source.ts              EXTEND: fetchOptionCandles(token, from, to, '1minute')
  engine/
    backtest-engine.ts          EXTEND: multi-instrument time loop, snapshot delivery
    portfolio.ts                EXTEND: OptionPosition[] alongside equity Position[], basket margin
    broker-sim.ts               EXTEND: accept MultiLegOrder, atomic next-bar fill
    brokerage/
      options-charges.ts        NEW: per-leg Zerodha schedule
      span-margin.ts            NEW: estimated margin per OptionPosition basket
  strategies/
    short-straddle.ts           NEW
    iron-condor.ts              NEW
    strategy.ts                 EXTEND: signature returns Array<OrderIntent | MultiLegOrder>
    registry.ts                 register new strategies
  report/
    options-report.ts           NEW: per-expiry P&L, leg breakdown, margin utilization
  cli/
    fetch-options.ts            NEW: pnpm cli fetch-options NIFTY 2025-01-01 2026-01-01
```

### Core types (`src/types/options.ts`)

```ts
export type OptionType = 'CE' | 'PE';
export type Underlying = 'NIFTY' | 'BANKNIFTY';

export interface OptionContract {
  symbol: string;              // e.g. NIFTY25MAY22000CE
  underlying: Underlying;
  expiry: Date;                // market close on expiry day
  strike: number;
  optionType: OptionType;
  lotSize: number;             // read from instrument dump for that expiry
  instrumentToken: number;     // Kite token
}

export interface Leg {
  contract: OptionContract;
  side: OrderSide;             // BUY | SELL
  qty: number;                 // in lots
}

export interface MultiLegOrder {
  id: string;
  ts: Date;
  legs: Leg[];                 // executed atomically (all-or-none)
  reason: string;              // "entry" | "sl" | "target" | "eod" | "exit"
}

export interface OptionPosition {
  contract: OptionContract;
  netQty: number;              // signed lots (negative = short)
  avgPrice: number;
  realizedPnl: number;
}
```

### Data layer

#### Kite options data flow

1. **Instrument dump** — Kite `/instruments` CSV fetched daily and cached. Filter to `segment=NFO-OPT, name in (NIFTY, BANKNIFTY)`. Indexed by `(underlying, expiry, strike, optionType) → instrumentToken`.

2. **Expiry calendar** — derived from instrument dump. NIFTY weekly expiries are typically Thursdays (with holiday shifts to Wednesday). BANKNIFTY weekly expiries follow Wednesday cadence (subject to SEBI changes — read from dump rather than hardcoded). Source of truth = unique expiry dates from `NFO-OPT` rows.

3. **ATM resolution** — given `(underlying, expiry, asof_ts)`:
   - Fetch underlying spot at `asof_ts` from index 1m candles (NIFTY 50 token 256265, NIFTY BANK token 260105)
   - Round spot to nearest strike step (50 NIFTY, 100 BANKNIFTY)
   - Pick ATM ± 10 strikes both CE and PE → 42 contracts per expiry

4. **Candle fetch per contract** — Kite historical endpoint per `instrumentToken`, 1-minute. Each weekly contract's life ≤ 7 calendar days, so a single request per contract.

5. **Cache layout**:
   ```
   data-cache/
     instruments/
       NFO-OPT-YYYY-MM-DD.csv          daily snapshot
       index.json                       (underlying, expiry, strike, type) → token
     candles/
       options/
         NIFTY/
           2025-05-22/                  expiry date
             22000-CE-1minute.json
             22000-PE-1minute.json
   ```

#### Historical instrument resolution (key gotcha)

Kite serves only the *current* instrument dump. For a 1-year backtest we need historical contract identities (expired contracts).

**Approach**: Use NSE bhavcopy archive (`https://archives.nseindia.com/...`), public/free, gives daily `(symbol, expiry, strike, type)` for all NFO contracts. Cross-reference with Kite's instrument dump (which retains historical tokens for expired contracts) to resolve `instrumentToken`. Cache the union as `instruments/index.json`.

If NSE archive proves unreliable or tokens cannot be resolved for older expiries, fallback is "build prospectively" — start daily dump capture from today, accept shorter initial backtest window. This fallback is documented but not implemented in v1.

### Engine extensions

#### Multi-instrument time loop

Replace the current single-symbol loop:

```ts
// engine.run(config)
const subscribed: Map<string, Candle[]> = loadAll(config.instruments);
const timeline: Date[] = mergedSortedTimestamps(subscribed);
for (const ts of timeline) {
  const snapshot = snapshotAt(subscribed, ts);          // Map<symbol, Candle | null>
  const intents = strategy.onBar(ts, snapshot, portfolio, ctx);
  for (const order of intents) brokerSim.submit(order, ts);
  brokerSim.fillNextBar();
  portfolio.markToMarket(snapshot);
}
```

Bars may be unaligned (illiquid OTM contracts skip minutes). `snapshot[symbol]` may be `null`; strategies must tolerate.

#### Multi-leg fill semantics

- `MultiLegOrder` queued for next-bar-open fill on each leg's contract.
- If any leg has no next bar (no liquidity at that minute) → reject the whole order, log `reason: 'no-liquidity'`. No partial fills.
- Slippage: 1 tick adverse per leg by default (₹0.05 per tick for options), configurable.
- Charges per leg via `options-charges.ts`.

#### Portfolio

- `portfolio.optionPositions: Map<symbol, OptionPosition>` alongside existing equity `positions`.
- MTM: each option position valued at current bar close of its contract. If contract bar is `null`, use last available close.
- Realized P&L flushed when a leg's qty reaches 0.
- Basket-level margin tracked (Section: Charges & Margin).

#### Strategy interface

```ts
interface Strategy {
  onBar(ts: Date, snap: Snapshot, port: Portfolio, ctx: Context): Array<OrderIntent | MultiLegOrder>;
  init?(ctx: Context): void;        // declare instrument subscriptions
}
```

`init` lets a strategy enumerate the contracts it needs (e.g., "for each weekly expiry in [from, to], subscribe ATM±10 CE+PE 1m") so the engine knows what to load.

**Backwards compat**: existing equity strategies emit `OrderIntent[]` only; engine handles the union transparently.

### Strategy logic

#### Short Straddle (expiry-day intraday)

Run config:

```yaml
strategy: short-straddle
underlying: NIFTY
period: { from: 2025-05-01, to: 2026-05-01 }
params:
  entryTime: "09:20"          # IST
  exitTime: "15:15"
  slPctOnPremium: 30          # exit if combined premium up 30%
  targetPctOnPremium: 60      # take-profit on premium decay
  lots: 1
```

Logic:

1. `init` — subscribe NIFTY index 1m + every weekly expiry's ATM CE+PE 1m for that expiry day only.
2. On each expiry day at the `entryTime` bar:
   - Read spot, round to nearest 50, find ATM CE+PE for today's expiry
   - Emit `MultiLegOrder { legs: [SELL ATM_CE × lots, SELL ATM_PE × lots], reason: 'entry' }`
   - On fill, record `entryPremium = ce_open + pe_open`
3. Each subsequent bar same day:
   - `currentPremium = ce_close + pe_close`
   - If `currentPremium >= entryPremium × (1 + slPct/100)` → exit (BUY both legs), `reason: 'sl'`
   - Else if `currentPremium <= entryPremium × (1 - targetPct/100)` → exit, `reason: 'target'`
   - Else if `ts == exitTime` → exit, `reason: 'eod'`
4. No overnight position. Skip days when expiry not on Thursday (holidays — read from calendar).

#### Iron Condor (weekly, Mon → Thu)

Run config:

```yaml
strategy: iron-condor
underlying: NIFTY
params:
  entryDay: monday
  entryTime: "09:30"
  exitDay: thursday
  exitTime: "15:00"
  shortStrikeOffset: 200      # short call = ATM+200, short put = ATM-200
  wingWidth: 100              # long call = short call + 100, long put = short put - 100
  slPctOnCredit: 30           # exit if MTM loss >= 30% of credit
  lots: 1
```

Logic:

1. `init` — subscribe NIFTY index + ATM±10 CE+PE for every weekly expiry in range.
2. On Monday at `entryTime` of each week (using nearest weekly expiry):
   - ATM = round(spot, 50)
   - Short call = ATM + offset, long call = ATM + offset + wing
   - Short put = ATM − offset, long put = ATM − offset − wing
   - Emit 4-leg `MultiLegOrder`: SELL short_call, BUY long_call, SELL short_put, BUY long_put
   - `creditReceived = (short_call_fill + short_put_fill - long_call_fill - long_put_fill) × lotSize × lots`
3. Each subsequent bar until `exitDay` / `exitTime`:
   - `currentBuyBackCost = (short_call_close + short_put_close - long_call_close - long_put_close) × lotSize × lots` — what it costs right now to close the basket at mid (sum across legs respecting buy/sell sign)
   - `mtmPnl = creditReceived - currentBuyBackCost`
   - If `mtmPnl <= -creditReceived × slPct/100` → exit basket (reverse all 4 legs), `reason: 'sl'`
   - Else if `ts == exitDay && exitTime` → exit, `reason: 'exit'`
   - Else hold

#### Edge cases (both strategies)

- **Holiday-shifted expiry**: read actual expiry date from instrument dump per week; do not hardcode Thursday/Wednesday.
- **ATM tie** (spot exactly midway between strikes): pick the lower strike (convention).
- **Missing minute candles** for a leg: hold position, MTM uses last available close.
- **Margin breach** (loss exceeds available capital): forced exit at next bar open, mark `bankruptcy: true` in report.
- **Insufficient margin at entry**: skip trade, log `skipped: insufficient_margin`.

### Charges & margin

#### Per-leg charges (`brokerage/options-charges.ts`)

Zerodha schedule as of 2026:

```ts
function calcOptionLegCharges(leg: FilledLeg): Charges {
  const turnover = leg.price * leg.qty * leg.contract.lotSize;
  const brokerage = Math.min(20, turnover * 0.0003);          // ₹20 flat or 0.03%, whichever is lower
  const stt = leg.side === SELL ? turnover * 0.001 : 0;       // 0.1% on sell premium (post Oct-2023 hike)
  const exchange = turnover * 0.000503;                        // NSE 0.0503%
  const sebi = turnover * 0.000001;                            // ₹10/cr
  const stampDuty = leg.side === BUY ? turnover * 0.00003 : 0; // 0.003% on buy
  const gst = (brokerage + exchange + sebi) * 0.18;            // 18% on services
  return { brokerage, stt, exchange, sebi, stampDuty, gst, total };
}
```

Notes:

- STT rate **0.1%** on sell premium (verified at impl time — STT rates have changed twice in recent years).
- ITM-at-expiry STT path (0.125% on intrinsic value) included for completeness; v1 force-exits before close so this branch is exercised only by the bankruptcy/forced path.
- Charges hit realized P&L immediately on each fill.

#### Margin model (`brokerage/span-margin.ts`)

Approximation only — real SPAN requires futures price grid + portfolio framework (out of scope).

- **Naked short option**: `margin = 12% × strike × lotSize` (NIFTY) or `10% × strike × lotSize` (BANKNIFTY).
- **Iron condor (defined-risk)**: `margin = max(call_spread_max_loss, put_spread_max_loss) × lotSize × lots` where `spread_max_loss = wingWidth − (short_premium − long_premium)`.
- Per-basket calculation; positions re-evaluated each bar.

#### Capital tracking

- `config.initialCapital` (e.g., ₹5,00,000)
- Pre-trade check: `marginRequired(legs) <= availableCapital`. If not, skip + log.
- Track peak/avg margin utilization in report.
- No interest on idle cash (simplification).

#### P&L breakdown

```
Gross P&L      = Σ realized leg P&L
Charges        = Σ all-leg charges (entry + exit)
Net P&L        = Gross P&L − Charges
Charge drag %  = Charges / |Gross P&L|
```

### Report extensions (`report/options-report.ts`)

Existing equity HTML report shows: equity curve, trade table, summary stats. Extend with:

- **Per-expiry table**: expiry date, entry premium/credit, exit premium/value, gross P&L, charges, net P&L, margin used, hold duration. One row per expiry-strategy run.
- **Leg breakdown** (collapsible per expiry): each leg's symbol, side, qty, fills, charges, realized P&L.
- **Summary stats**: net P&L, win rate, avg win, avg loss, max drawdown (on margin), Sharpe, **charge drag %**, **margin utilization %** (peak/avg/min).
- **Premium decay chart** (per-expiry, optional): combined premium vs time intraday for straddle expiry days.
- **Skipped trades log**: insufficient margin, missing data, holiday expiry shifts.

Same vanilla HTML pattern as existing reports; renderer reads JSON state from engine.

### CLI

New commands:

- `pnpm cli fetch-options <UNDERLYING> <from> <to>` — fetch instrument dump + 1m candles for ATM±10 of every expiry in range.
- `pnpm cli backtest <run-config.yaml>` — already exists; auto-detects options strategies via registry.

## Testing

Per existing TDD pattern (`*.test.ts` adjacent to source):

- `types/options.test.ts` — type construction smoke
- `data/options-chain.test.ts` — ATM resolution given fixed spot + strike grid; expiry calendar parsing from instrument dump fixture
- `data/instrument-store.test.ts` — extend with options index lookups
- `data/nse-bhavcopy.test.ts` — bhavcopy parser + Kite token resolution
- `engine/backtest-engine.test.ts` — multi-instrument timeline merge; null-snapshot tolerance
- `engine/broker-sim.test.ts` — multi-leg atomic fill; partial-fill rejection; per-leg slippage
- `engine/portfolio.test.ts` — option position MTM; basket margin; bankruptcy path
- `engine/brokerage/options-charges.test.ts` — known fixtures (e.g., SELL 22000CE @ ₹100, lot 75 → expected STT/brokerage/GST)
- `engine/brokerage/span-margin.test.ts` — naked short vs iron condor margin formulas
- `strategies/short-straddle.test.ts` — synthetic 1-day candle stream: entry @ 09:20, SL at 30% premium spike, EOD exit
- `strategies/iron-condor.test.ts` — Monday entry, MTM tracking, Thursday exit
- **Integration test**: small fixture with 2 expiries of generated 1m candles, run end-to-end backtest, assert net P&L matches hand-calculated value.

## Build sequence

For the implementation plan to elaborate:

1. Types + instrument store extension (foundation, no engine changes)
2. NSE bhavcopy historical fetch + options-chain resolver
3. Charges + margin modules (pure functions, easy to test)
4. Engine multi-instrument timeline + multi-leg broker-sim
5. Portfolio extensions
6. Short straddle strategy (single-leg-pair, simpler)
7. Iron condor strategy (4-leg)
8. Report extensions
9. CLI commands
10. End-to-end integration test on 1 month of NIFTY data

## Open risks

- **NSE bhavcopy reliability** — site has historically had outages, anti-scraping. If unworkable, fall back to "build prospectively from today" with shorter initial backtest window. Validate during step 2.
- **Kite minute data for expired option tokens** — assumed to remain available indefinitely. Verify with a single old-token fetch before committing to the architecture.
- **STT rate drift** — Indian govt has changed options STT twice in ~2 years. Make rates a config constant, not magic numbers.
- **Lot size changes** — NIFTY lot has changed (75 → 50 → 75); always read from instrument dump per expiry, never hardcode.
- **Margin model accuracy** — flat % is a coarse approximation. Backtest signal is robust to it but absolute capital requirements aren't. Document the limitation in reports.
