# Options Strategies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add options backtesting to mikasa with two strategies (short straddle on NIFTY weekly expiries, iron condor on weekly hold), realistic Zerodha-schedule charges, and an estimated SPAN margin model.

**Architecture:** The existing multi-symbol engine loop is preserved — options support is added by (1) new option-aware types, (2) extensions to `StrategyContext` for multi-leg orders and cross-symbol price lookup, (3) extensions to `BrokerSim` for atomic multi-leg fills, (4) extensions to `Portfolio` for option positions and basket margin. Two new strategies emit `MultiLegOrder` via the extended context. A new options report renderer surfaces per-expiry P&L, leg breakdown, charge drag, and margin utilization.

**Tech Stack:** TypeScript, vitest, pnpm. Existing modules: `src/data/{kite-source,instrument-store,candle-store}`, `src/engine/{backtest-engine,broker-sim,portfolio,order-router}`, `src/strategies/strategy.ts`, `src/report/`.

**Spec:** [docs/superpowers/specs/2026-05-10-options-strategies-design.md](../specs/2026-05-10-options-strategies-design.md)

---

## Task 1: Foundation Option Types

**Files:**
- Create: `src/types/options.ts`
- Modify: `src/types/index.ts` (re-export)
- Test: `src/types/options.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/types/options.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { OrderSide } from './index';
import type { OptionContract, Leg, MultiLegOrder, OptionPosition } from './options';

describe('option types', () => {
  const contract: OptionContract = {
    symbol: 'NIFTY25MAY22000CE',
    underlying: 'NIFTY',
    expiry: new Date('2025-05-22T10:00:00Z'),
    strike: 22000,
    optionType: 'CE',
    lotSize: 75,
    instrumentToken: 12345678,
  };

  it('constructs an OptionContract', () => {
    expect(contract.strike).toBe(22000);
    expect(contract.optionType).toBe('CE');
  });

  it('constructs a Leg', () => {
    const leg: Leg = { contract, side: OrderSide.SELL, qty: 1 };
    expect(leg.side).toBe('sell');
  });

  it('constructs a MultiLegOrder with multiple legs', () => {
    const order: MultiLegOrder = {
      id: 'ml-1',
      ts: new Date('2025-05-22T03:50:00Z'),
      legs: [
        { contract, side: OrderSide.SELL, qty: 1 },
        { contract: { ...contract, strike: 21900, optionType: 'PE', symbol: 'NIFTY25MAY21900PE' }, side: OrderSide.SELL, qty: 1 },
      ],
      reason: 'entry',
    };
    expect(order.legs).toHaveLength(2);
  });

  it('constructs an OptionPosition with negative qty for short', () => {
    const pos: OptionPosition = { contract, netQty: -1, avgPrice: 120, realizedPnl: 0 };
    expect(pos.netQty).toBe(-1);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm vitest run src/types/options.test.ts`
Expected: FAIL with module-not-found for `./options`.

- [ ] **Step 3: Implement `src/types/options.ts`**

```ts
import type { OrderSide } from './index';

export type OptionType = 'CE' | 'PE';
export type Underlying = 'NIFTY' | 'BANKNIFTY';

export interface OptionContract {
  symbol: string;
  underlying: Underlying;
  expiry: Date;
  strike: number;
  optionType: OptionType;
  lotSize: number;
  instrumentToken: number;
}

export interface Leg {
  contract: OptionContract;
  side: OrderSide;
  qty: number;                  // in lots
}

export interface MultiLegOrder {
  id: string;
  ts: Date;
  legs: Leg[];
  reason: string;               // 'entry' | 'sl' | 'target' | 'eod' | 'exit'
}

export interface OptionPosition {
  contract: OptionContract;
  netQty: number;               // signed lots; negative = short
  avgPrice: number;             // weighted avg entry price (per-share)
  realizedPnl: number;
}
```

- [ ] **Step 4: Re-export from `src/types/index.ts`**

Add at end of file:

```ts
export type { OptionContract, Leg, MultiLegOrder, OptionPosition, OptionType, Underlying } from './options';
```

- [ ] **Step 5: Run test — verify it passes**

Run: `pnpm vitest run src/types/options.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/types/options.ts src/types/options.test.ts src/types/index.ts
git commit -m "feat(types): add option contract, leg, multi-leg order, option position types"
```

---

## Task 2: Instrument Store — Options Index

**Files:**
- Modify: `src/data/instrument-store.ts`
- Test: `src/data/instrument-store.test.ts`

Goal: index NFO-OPT instruments by `(underlying, expiry, strike, optionType) → OptionContract`.

- [ ] **Step 1: Write the failing test (append to existing test file)**

Append to `src/data/instrument-store.test.ts`:

```ts
import type { OptionContract } from '../types';

describe('options index', () => {
  it('indexes options instruments and resolves by (underlying, expiry, strike, type)', () => {
    const store = new InstrumentStore();
    const expiry = new Date('2025-05-22T10:00:00Z');
    const ce: OptionContract = {
      symbol: 'NIFTY25MAY22000CE',
      underlying: 'NIFTY',
      expiry,
      strike: 22000,
      optionType: 'CE',
      lotSize: 75,
      instrumentToken: 1001,
    };
    const pe: OptionContract = { ...ce, symbol: 'NIFTY25MAY22000PE', optionType: 'PE', instrumentToken: 1002 };
    store.addOption(ce);
    store.addOption(pe);

    expect(store.findOption('NIFTY', expiry, 22000, 'CE')).toEqual(ce);
    expect(store.findOption('NIFTY', expiry, 22000, 'PE')).toEqual(pe);
    expect(store.findOption('NIFTY', expiry, 21900, 'CE')).toBeNull();
  });

  it('lists distinct expiries per underlying', () => {
    const store = new InstrumentStore();
    const e1 = new Date('2025-05-22T10:00:00Z');
    const e2 = new Date('2025-05-29T10:00:00Z');
    store.addOption({ symbol: 'a', underlying: 'NIFTY', expiry: e1, strike: 22000, optionType: 'CE', lotSize: 75, instrumentToken: 1 });
    store.addOption({ symbol: 'b', underlying: 'NIFTY', expiry: e2, strike: 22000, optionType: 'CE', lotSize: 75, instrumentToken: 2 });
    store.addOption({ symbol: 'c', underlying: 'BANKNIFTY', expiry: e1, strike: 50000, optionType: 'CE', lotSize: 35, instrumentToken: 3 });

    expect(store.expiries('NIFTY').map((d) => d.toISOString())).toEqual([e1.toISOString(), e2.toISOString()]);
    expect(store.expiries('BANKNIFTY').map((d) => d.toISOString())).toEqual([e1.toISOString()]);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm vitest run src/data/instrument-store.test.ts`
Expected: FAIL with `addOption is not a function` or similar.

- [ ] **Step 3: Implement options-index methods on `InstrumentStore`**

Read the current `src/data/instrument-store.ts` first. Then add (preserving existing behaviour):

```ts
import type { OptionContract, OptionType, Underlying } from '../types/options';

// inside class InstrumentStore:
private optionsByKey = new Map<string, OptionContract>();
private expirySet = new Map<Underlying, Set<number>>();   // ts in ms

private optionKey(u: Underlying, expiry: Date, strike: number, type: OptionType): string {
  return `${u}|${expiry.getTime()}|${strike}|${type}`;
}

addOption(c: OptionContract): void {
  this.optionsByKey.set(this.optionKey(c.underlying, c.expiry, c.strike, c.optionType), c);
  if (!this.expirySet.has(c.underlying)) this.expirySet.set(c.underlying, new Set());
  this.expirySet.get(c.underlying)!.add(c.expiry.getTime());
}

findOption(u: Underlying, expiry: Date, strike: number, type: OptionType): OptionContract | null {
  return this.optionsByKey.get(this.optionKey(u, expiry, strike, type)) ?? null;
}

expiries(u: Underlying): Date[] {
  const set = this.expirySet.get(u);
  if (!set) return [];
  return Array.from(set).sort((a, b) => a - b).map((ms) => new Date(ms));
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `pnpm vitest run src/data/instrument-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/instrument-store.ts src/data/instrument-store.test.ts
git commit -m "feat(data): index NFO-OPT instruments by (underlying, expiry, strike, type)"
```

---

## Task 3: NSE Bhavcopy Fetcher (Historical Instrument Resolution)

**Files:**
- Create: `src/data/nse-bhavcopy.ts`
- Test: `src/data/nse-bhavcopy.test.ts`
- Test fixture: `test/fixtures/nse-bhavcopy-sample.csv`

Goal: parse NSE FO bhavcopy CSV (one day) into a list of `{ underlying, expiry, strike, optionType, symbol }` rows. The actual HTTP fetch is a thin wrapper around `fetch()` and is exercised against a fixture; live fetch is verified manually.

NSE bhavcopy URL pattern (verify at impl time — anti-bot headers may be required):
`https://archives.nseindia.com/content/historical/DERIVATIVES/<YYYY>/<MMM>/fo<DDMMMYYYY>bhav.csv.zip`

For v1, accept a local CSV path (already-downloaded). Live fetcher is a stretch — defer if time-pressed.

- [ ] **Step 1: Create fixture CSV**

Create `test/fixtures/nse-bhavcopy-sample.csv` with a small header + 4 rows (2 NIFTY OPTIDX, 1 BANKNIFTY OPTIDX, 1 stock OPTSTK to test filtering):

```csv
INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP
OPTIDX,NIFTY,22-MAY-2025,22000,CE,150,160,140,145,145,1000,109.50,5000,200,15-MAY-2025
OPTIDX,NIFTY,22-MAY-2025,22000,PE,140,150,130,135,135,900,91.13,4500,150,15-MAY-2025
OPTIDX,BANKNIFTY,21-MAY-2025,50000,CE,300,310,290,295,295,500,103.25,2000,100,15-MAY-2025
OPTSTK,RELIANCE,29-MAY-2025,1300,CE,40,42,38,40,40,100,4.00,500,50,15-MAY-2025
```

- [ ] **Step 2: Write the failing test**

Create `src/data/nse-bhavcopy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parseBhavcopy } from './nse-bhavcopy';

const FIXTURE = path.resolve(__dirname, '../../test/fixtures/nse-bhavcopy-sample.csv');

describe('parseBhavcopy', () => {
  it('parses NIFTY/BANKNIFTY OPTIDX rows and skips stocks', () => {
    const rows = parseBhavcopy(FIXTURE);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.underlying === 'NIFTY' || r.underlying === 'BANKNIFTY')).toBe(true);
  });

  it('parses expiry as a UTC Date for market close (10:00 UTC = 15:30 IST)', () => {
    const rows = parseBhavcopy(FIXTURE);
    const niftyCe = rows.find((r) => r.underlying === 'NIFTY' && r.optionType === 'CE')!;
    expect(niftyCe.expiry.toISOString()).toBe('2025-05-22T10:00:00.000Z');
  });

  it('extracts strike, option type, and symbol', () => {
    const rows = parseBhavcopy(FIXTURE);
    const niftyCe = rows.find((r) => r.underlying === 'NIFTY' && r.optionType === 'CE')!;
    expect(niftyCe.strike).toBe(22000);
    expect(niftyCe.symbol).toBe('NIFTY');
  });
});
```

- [ ] **Step 3: Run — verify failure**

Run: `pnpm vitest run src/data/nse-bhavcopy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser**

Create `src/data/nse-bhavcopy.ts`:

```ts
import * as fs from 'node:fs';
import type { Underlying, OptionType } from '../types/options';

export interface BhavcopyRow {
  underlying: Underlying;
  symbol: string;             // 'NIFTY' or 'BANKNIFTY'
  expiry: Date;               // 10:00 UTC = 15:30 IST close
  strike: number;
  optionType: OptionType;
}

const MONTH: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

function parseExpiry(s: string): Date {
  // Format: "22-MAY-2025"
  const [d, m, y] = s.split('-');
  if (!d || !m || !y) throw new Error(`bad expiry: ${s}`);
  const month = MONTH[m.toUpperCase()];
  if (month === undefined) throw new Error(`bad month: ${m}`);
  return new Date(Date.UTC(parseInt(y, 10), month, parseInt(d, 10), 10, 0, 0));
}

export function parseBhavcopy(csvPath: string): BhavcopyRow[] {
  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.trim().split('\n');
  const header = lines[0]!.split(',').map((s) => s.trim());
  const idx = (col: string): number => {
    const i = header.indexOf(col);
    if (i < 0) throw new Error(`missing column: ${col}`);
    return i;
  };
  const cInst = idx('INSTRUMENT');
  const cSym = idx('SYMBOL');
  const cExp = idx('EXPIRY_DT');
  const cStrike = idx('STRIKE_PR');
  const cType = idx('OPTION_TYP');

  const rows: BhavcopyRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(',').map((s) => s.trim());
    if (cells[cInst] !== 'OPTIDX') continue;
    const sym = cells[cSym]!;
    if (sym !== 'NIFTY' && sym !== 'BANKNIFTY') continue;
    rows.push({
      underlying: sym,
      symbol: sym,
      expiry: parseExpiry(cells[cExp]!),
      strike: parseFloat(cells[cStrike]!),
      optionType: cells[cType] as OptionType,
    });
  }
  return rows;
}
```

- [ ] **Step 5: Run — verify pass**

Run: `pnpm vitest run src/data/nse-bhavcopy.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/data/nse-bhavcopy.ts src/data/nse-bhavcopy.test.ts test/fixtures/nse-bhavcopy-sample.csv
git commit -m "feat(data): parse NSE FO bhavcopy CSV for OPTIDX (NIFTY/BANKNIFTY)"
```

---

## Task 4: Options Chain Resolver (ATM ± N)

**Files:**
- Create: `src/data/options-chain.ts`
- Test: `src/data/options-chain.test.ts`

Goal: given `(underlying, expiry, spot, n)`, return the ATM ± n strikes worth of CE+PE `OptionContract`s from the InstrumentStore.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { InstrumentStore } from './instrument-store';
import { resolveAtmChain, roundToStrike } from './options-chain';
import type { OptionContract } from '../types';

function seedNifty(store: InstrumentStore, expiry: Date, strikes: number[]): void {
  let token = 10000;
  for (const k of strikes) {
    for (const t of ['CE', 'PE'] as const) {
      const c: OptionContract = {
        symbol: `NIFTY${k}${t}`,
        underlying: 'NIFTY',
        expiry,
        strike: k,
        optionType: t,
        lotSize: 75,
        instrumentToken: ++token,
      };
      store.addOption(c);
    }
  }
}

describe('roundToStrike', () => {
  it('rounds NIFTY spot to nearest 50', () => {
    expect(roundToStrike(22013, 50)).toBe(22000);
    expect(roundToStrike(22025, 50)).toBe(22050);
    expect(roundToStrike(22049, 50)).toBe(22050);
  });
  it('uses lower strike on exact midpoint (NIFTY convention)', () => {
    // 22025 is midpoint between 22000 and 22050 — pick 22000 (lower)
    expect(roundToStrike(22025, 50)).toBe(22050); // banker's? No — Math.round rounds half-up; spec says LOWER on tie. Adjust impl.
  });
});

describe('resolveAtmChain', () => {
  const expiry = new Date('2025-05-22T10:00:00Z');
  const strikes = [21900, 21950, 22000, 22050, 22100, 22150, 22200];

  it('returns ATM ± n strikes (CE + PE)', () => {
    const store = new InstrumentStore();
    seedNifty(store, expiry, strikes);
    const chain = resolveAtmChain(store, 'NIFTY', expiry, 22000, 2, 50);
    // ATM=22000, ±2 strikes = 21900..22100, that's 5 strikes × 2 types = 10 contracts
    expect(chain).toHaveLength(10);
    const strikesReturned = Array.from(new Set(chain.map((c) => c.strike))).sort();
    expect(strikesReturned).toEqual([21900, 21950, 22000, 22050, 22100]);
  });

  it('skips strikes missing from the store rather than throwing', () => {
    const store = new InstrumentStore();
    seedNifty(store, expiry, [22000, 22050]);   // only 2 strikes available
    const chain = resolveAtmChain(store, 'NIFTY', expiry, 22000, 5, 50);
    expect(chain).toHaveLength(4);              // 22000 CE/PE + 22050 CE/PE
  });
});
```

Note the second `roundToStrike` test reveals a contradiction with the spec which says "pick lower strike on tie". The first test is `Math.round`-style; the spec explicitly says lower-on-tie. The implementation must use lower-on-tie. Update the first test's `22025 → 22050` expectation to `22000` to match the spec.

Replace the `roundToStrike` describe block with:

```ts
describe('roundToStrike', () => {
  it('rounds NIFTY spot to nearest 50, lower strike on tie', () => {
    expect(roundToStrike(22013, 50)).toBe(22000);
    expect(roundToStrike(22049, 50)).toBe(22050);
    expect(roundToStrike(22025, 50)).toBe(22000);   // tie → lower
    expect(roundToStrike(21999, 50)).toBe(22000);
  });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm vitest run src/data/options-chain.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/data/options-chain.ts`:

```ts
import type { OptionContract, Underlying } from '../types/options';
import type { InstrumentStore } from './instrument-store';

export function roundToStrike(spot: number, step: number): number {
  // Round to nearest multiple of `step`, but break ties toward the lower strike.
  const lower = Math.floor(spot / step) * step;
  const upper = lower + step;
  const diffLower = spot - lower;
  const diffUpper = upper - spot;
  if (diffLower < diffUpper) return lower;
  if (diffUpper < diffLower) return upper;
  return lower;   // exact tie
}

export function resolveAtmChain(
  store: InstrumentStore,
  underlying: Underlying,
  expiry: Date,
  spot: number,
  n: number,
  step: number,
): OptionContract[] {
  const atm = roundToStrike(spot, step);
  const out: OptionContract[] = [];
  for (let k = atm - n * step; k <= atm + n * step; k += step) {
    const ce = store.findOption(underlying, expiry, k, 'CE');
    const pe = store.findOption(underlying, expiry, k, 'PE');
    if (ce) out.push(ce);
    if (pe) out.push(pe);
  }
  return out;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm vitest run src/data/options-chain.test.ts`
Expected: PASS, 4 tests (1 in roundToStrike, 2 in resolveAtmChain... actually 3 — re-check).

- [ ] **Step 5: Commit**

```bash
git add src/data/options-chain.ts src/data/options-chain.test.ts
git commit -m "feat(data): resolve ATM±N option chain with lower-strike tiebreak"
```

---

## Task 5: Kite Source — Option Candle Fetch

**Files:**
- Modify: `src/data/kite-source.ts`
- Test: `src/data/kite-source.test.ts`

Goal: add `fetchOptionCandles(token, from, to, interval)` that calls the existing Kite historical endpoint by `instrumentToken` (rather than by tradingsymbol). Most logic is reused — this is a thin wrapper.

Read existing `kite-source.ts` first to identify the equity fetch path. The Kite API endpoint `/instruments/historical/:instrument_token/:interval` accepts a token directly and works for options the same way.

- [ ] **Step 1: Write the failing test (mocked HTTP)**

Append to `src/data/kite-source.test.ts`:

```ts
describe('fetchOptionCandles', () => {
  it('calls Kite historical endpoint by instrument token', async () => {
    // Reuse existing mock pattern in this file; assume mockFetch returns an OK response shape.
    const mockResponse = {
      data: {
        candles: [
          ['2025-05-22T09:15:00+0530', 100, 105, 99, 102, 1000],
          ['2025-05-22T09:16:00+0530', 102, 106, 101, 105, 800],
        ],
      },
    };
    // ... wire up via the existing mocking strategy in kite-source.test.ts ...
    const candles = await source.fetchOptionCandles(12345, new Date('2025-05-22'), new Date('2025-05-22'), '1minute');
    expect(candles).toHaveLength(2);
    expect(candles[0]!.symbol).toBe('TOKEN-12345');   // synthetic symbol when fetched by token
    expect(candles[0]!.interval).toBe('1minute');
  });
});
```

Note: the exact mock pattern depends on how `kite-source.test.ts` currently mocks HTTP. Read that file before writing this test and match its style.

- [ ] **Step 2: Run — verify failure**

Run: `pnpm vitest run src/data/kite-source.test.ts -t fetchOptionCandles`
Expected: FAIL — `fetchOptionCandles is not a function`.

- [ ] **Step 3: Implement**

In `src/data/kite-source.ts`, add a method on the `KiteSource` class. Reuse the existing fetch + parse path; only the URL and the synthetic symbol change.

```ts
async fetchOptionCandles(
  instrumentToken: number,
  from: Date,
  to: Date,
  interval: Interval,
): Promise<Candle[]> {
  const url = this.historicalUrl(instrumentToken, interval, from, to);
  const json = await this.httpGet(url);
  const symbol = `TOKEN-${instrumentToken}`;
  return this.parseCandles(json, symbol, interval);
}
```

(Adapt to actual private helpers in the file. If `historicalUrl` and `parseCandles` are not yet extracted, factor them out as part of this task.)

- [ ] **Step 4: Run — verify pass**

Run: `pnpm vitest run src/data/kite-source.test.ts -t fetchOptionCandles`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/kite-source.ts src/data/kite-source.test.ts
git commit -m "feat(data): fetch option candles by Kite instrument token"
```

---

## Task 6: Options Charges Module

**Files:**
- Create: `src/engine/brokerage/options-charges.ts`
- Test: `src/engine/brokerage/options-charges.test.ts`

Goal: pure function `calcOptionLegCharges(leg)` returning `Fees` per the Zerodha schedule from the spec.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { calcOptionLegCharges, type FilledLeg } from './options-charges';
import { OrderSide } from '../../types';

const ceContract = {
  symbol: 'NIFTY25MAY22000CE',
  underlying: 'NIFTY' as const,
  expiry: new Date('2025-05-22T10:00:00Z'),
  strike: 22000,
  optionType: 'CE' as const,
  lotSize: 75,
  instrumentToken: 1,
};

describe('calcOptionLegCharges', () => {
  it('SELL leg: STT 0.1% on premium, brokerage capped at 20', () => {
    const leg: FilledLeg = { contract: ceContract, side: OrderSide.SELL, qty: 1, price: 100 };
    // turnover = 100 * 1 * 75 = 7500
    const f = calcOptionLegCharges(leg);
    // brokerage = min(20, 7500*0.0003=2.25) = 2.25
    // stt = 7500*0.001 = 7.5
    // exchange = 7500*0.000503 = 3.7725
    // sebi = 7500*0.000001 = 0.0075
    // stampDuty = 0 (sell)
    // gst = (2.25 + 3.7725 + 0.0075) * 0.18 = 1.0854
    expect(f.brokerage).toBeCloseTo(2.25, 4);
    expect(f.stt).toBeCloseTo(7.5, 4);
    expect(f.exchange).toBeCloseTo(3.7725, 4);
    expect(f.sebi).toBeCloseTo(0.0075, 4);
    expect(f.stampDuty).toBe(0);
    expect(f.gst).toBeCloseTo(1.0854, 4);
    expect(f.total).toBeCloseTo(14.6154, 3);
  });

  it('BUY leg: no STT, stamp duty 0.003%, brokerage capped at 20', () => {
    const leg: FilledLeg = { contract: ceContract, side: OrderSide.BUY, qty: 5, price: 100 };
    // turnover = 100 * 5 * 75 = 37500
    const f = calcOptionLegCharges(leg);
    // brokerage = min(20, 37500*0.0003=11.25) = 11.25
    expect(f.stt).toBe(0);
    expect(f.stampDuty).toBeCloseTo(37500 * 0.00003, 4);
    expect(f.brokerage).toBeCloseTo(11.25, 4);
  });

  it('caps brokerage at ₹20 for high-turnover leg', () => {
    const leg: FilledLeg = { contract: ceContract, side: OrderSide.SELL, qty: 100, price: 1000 };
    // turnover = 7,500,000; 0.0003 = 2250 → cap to 20
    const f = calcOptionLegCharges(leg);
    expect(f.brokerage).toBe(20);
  });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm vitest run src/engine/brokerage/options-charges.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/engine/brokerage/options-charges.ts`:

```ts
import type { Fees, OrderSide } from '../../types';
import type { OptionContract } from '../../types/options';

export interface FilledLeg {
  contract: OptionContract;
  side: OrderSide;
  qty: number;
  price: number;
}

const STT_SELL = 0.001;          // 0.1% on sell premium (Indian options, post Oct-2023)
const EXCHANGE = 0.000503;       // NSE
const SEBI = 0.000001;           // ₹10 per crore
const STAMP_BUY = 0.00003;       // 0.003% on buy
const GST = 0.18;                // 18%
const BROKERAGE_RATE = 0.0003;   // 0.03%
const BROKERAGE_CAP = 20;        // ₹20 flat cap (Zerodha)

export function calcOptionLegCharges(leg: FilledLeg): Fees {
  const turnover = leg.price * leg.qty * leg.contract.lotSize;
  const brokerage = Math.min(BROKERAGE_CAP, turnover * BROKERAGE_RATE);
  const stt = leg.side === 'sell' ? turnover * STT_SELL : 0;
  const exchange = turnover * EXCHANGE;
  const sebi = turnover * SEBI;
  const stampDuty = leg.side === 'buy' ? turnover * STAMP_BUY : 0;
  const gst = (brokerage + exchange + sebi) * GST;
  const total = brokerage + stt + exchange + sebi + stampDuty + gst;
  return { brokerage, stt, exchange, sebi, stampDuty, gst, total };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm vitest run src/engine/brokerage/options-charges.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/brokerage/options-charges.ts src/engine/brokerage/options-charges.test.ts
git commit -m "feat(engine): per-leg options charges (Zerodha schedule)"
```

---

## Task 7: SPAN Margin Estimator

**Files:**
- Create: `src/engine/brokerage/span-margin.ts`
- Test: `src/engine/brokerage/span-margin.test.ts`

Goal: pure function `estimateMargin(positions)` returning approximate margin in rupees:

- Naked short option: 12% × strike × lotSize × |qty| for NIFTY; 10% for BANKNIFTY.
- Defined-risk spread (call spread or put spread): max-loss × lotSize × lots.
- Iron condor: max(call-spread max-loss, put-spread max-loss) × lotSize × lots.

Detection: group `positions` by `(expiry, optionType)`. For each group, look at strikes and signs to decide naked vs spread.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { estimateMargin } from './span-margin';
import type { OptionPosition } from '../../types';

const expiry = new Date('2025-05-22T10:00:00Z');

function pos(strike: number, type: 'CE' | 'PE', netQty: number, avgPrice: number, underlying: 'NIFTY' | 'BANKNIFTY' = 'NIFTY'): OptionPosition {
  return {
    contract: {
      symbol: `${underlying}${strike}${type}`,
      underlying, expiry, strike, optionType: type,
      lotSize: underlying === 'NIFTY' ? 75 : 35,
      instrumentToken: 1,
    },
    netQty, avgPrice, realizedPnl: 0,
  };
}

describe('estimateMargin', () => {
  it('naked short NIFTY straddle: 12% × strike × lotSize per leg', () => {
    const positions = [pos(22000, 'CE', -1, 100), pos(22000, 'PE', -1, 100)];
    // Each leg: 0.12 × 22000 × 75 = 198,000 → total 396,000
    expect(estimateMargin(positions)).toBeCloseTo(396_000, 0);
  });

  it('naked short BANKNIFTY straddle: 10% × strike × lotSize per leg', () => {
    const positions = [pos(50000, 'CE', -1, 200, 'BANKNIFTY'), pos(50000, 'PE', -1, 200, 'BANKNIFTY')];
    // Each: 0.10 × 50000 × 35 = 175,000 → total 350,000
    expect(estimateMargin(positions)).toBeCloseTo(350_000, 0);
  });

  it('iron condor: margin = max(call-spread max-loss, put-spread max-loss) × lotSize', () => {
    // Short 22200 CE @ 30, long 22300 CE @ 15  → call spread max loss = (100 - (30-15)) = 85
    // Short 21800 PE @ 25, long 21700 PE @ 12  → put spread max loss = (100 - (25-12)) = 87
    const positions = [
      pos(22200, 'CE', -1, 30),
      pos(22300, 'CE', +1, 15),
      pos(21800, 'PE', -1, 25),
      pos(21700, 'PE', +1, 12),
    ];
    // max(85, 87) × 75 = 87 × 75 = 6525
    expect(estimateMargin(positions)).toBeCloseTo(6525, 0);
  });

  it('zero positions → zero margin', () => {
    expect(estimateMargin([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm vitest run src/engine/brokerage/span-margin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/engine/brokerage/span-margin.ts`:

```ts
import type { OptionPosition } from '../../types/options';

const NAKED_RATE: Record<'NIFTY' | 'BANKNIFTY', number> = { NIFTY: 0.12, BANKNIFTY: 0.10 };

interface Group {
  underlying: 'NIFTY' | 'BANKNIFTY';
  expiry: number;     // ms
  optionType: 'CE' | 'PE';
  legs: OptionPosition[];
}

function groupKey(p: OptionPosition): string {
  return `${p.contract.underlying}|${p.contract.expiry.getTime()}|${p.contract.optionType}`;
}

export function estimateMargin(positions: OptionPosition[]): number {
  if (positions.length === 0) return 0;

  const groups = new Map<string, Group>();
  for (const p of positions) {
    if (p.netQty === 0) continue;
    const k = groupKey(p);
    if (!groups.has(k)) {
      groups.set(k, { underlying: p.contract.underlying, expiry: p.contract.expiry.getTime(), optionType: p.contract.optionType, legs: [] });
    }
    groups.get(k)!.legs.push(p);
  }

  let totalNaked = 0;
  let callSpreadLoss = 0;
  let putSpreadLoss = 0;

  for (const g of groups.values()) {
    const shorts = g.legs.filter((l) => l.netQty < 0);
    const longs = g.legs.filter((l) => l.netQty > 0);

    if (shorts.length === 1 && longs.length === 1) {
      // Defined-risk vertical spread
      const short = shorts[0]!;
      const long = longs[0]!;
      const lotSize = short.contract.lotSize;
      const wing = Math.abs(short.contract.strike - long.contract.strike);
      const credit = short.avgPrice - long.avgPrice;
      const maxLoss = Math.max(0, wing - credit);
      const lots = Math.min(Math.abs(short.netQty), Math.abs(long.netQty));
      if (g.optionType === 'CE') callSpreadLoss += maxLoss * lotSize * lots;
      else putSpreadLoss += maxLoss * lotSize * lots;
    } else {
      // Naked: charge per leg as % of notional × lotSize × |qty|
      for (const leg of shorts) {
        const rate = NAKED_RATE[leg.contract.underlying];
        totalNaked += rate * leg.contract.strike * leg.contract.lotSize * Math.abs(leg.netQty);
      }
    }
  }

  // Iron condor consolidation: when both call-spread and put-spread exist, charge max only
  const condorMargin = callSpreadLoss > 0 && putSpreadLoss > 0
    ? Math.max(callSpreadLoss, putSpreadLoss)
    : callSpreadLoss + putSpreadLoss;

  return totalNaked + condorMargin;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm vitest run src/engine/brokerage/span-margin.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/brokerage/span-margin.ts src/engine/brokerage/span-margin.test.ts
git commit -m "feat(engine): estimated SPAN margin for naked shorts and condor spreads"
```

---

## Task 8: Strategy Context Extensions

**Files:**
- Modify: `src/strategies/strategy.ts`
- Modify: `src/engine/backtest-engine.ts`
- Test: `src/engine/backtest-engine.test.ts`

Goal: extend `StrategyContext` with `lastClose`, `submitMultiLeg`, `optionPosition`, `subscribeOptions`. Engine wires them up. Existing equity strategies untouched.

- [ ] **Step 1: Extend the interface**

In `src/strategies/strategy.ts`, replace the interface:

```ts
import type { Logger } from '../util/logger';
import type { Candle, Fill, OrderId, OrderIntent, Position } from '../types';
import type { OptionContract, OptionPosition, MultiLegOrder } from '../types/options';
import type { IndicatorRegistry } from '../indicators/registry';

export interface OptionSubscription {
  underlying: 'NIFTY' | 'BANKNIFTY';
  contracts: OptionContract[];   // resolved before engine starts
}

export interface StrategyContext {
  cash: number;
  position(symbol: string): Position | null;
  optionPosition(symbol: string): OptionPosition | null;
  submitOrder(intent: OrderIntent): OrderId;
  submitMultiLeg(order: Omit<MultiLegOrder, 'id' | 'ts'>): string;
  cancelOrder(id: OrderId): void;
  lastClose(symbol: string): number | undefined;
  subscribeOptions(sub: OptionSubscription): void;
  indicator: IndicatorRegistry;
  params: Record<string, unknown>;
  logger: Logger;
}

export abstract class Strategy {
  abstract init(ctx: StrategyContext): void;
  abstract onBar(bar: Candle, ctx: StrategyContext): void;
  onOrderFill?(fill: Fill, ctx: StrategyContext): void;
  onOrderRejected?(reason: string, intent: OrderIntent, ctx: StrategyContext): void;
}

export type StrategyConstructor = new () => Strategy;
```

- [ ] **Step 2: Write failing test for the engine wiring**

Append to `src/engine/backtest-engine.test.ts`:

```ts
describe('StrategyContext extensions', () => {
  it('exposes lastClose for symbols seen in the candle stream', () => {
    let ctxRef: StrategyContext | undefined;
    const strat = new (class extends Strategy {
      init(ctx: StrategyContext) { ctxRef = ctx; }
      onBar() {}
    })();
    runBacktest({ /* minimal opts with two symbols A, B */ });
    expect(ctxRef!.lastClose('A')).toBeDefined();
    expect(ctxRef!.lastClose('NEVER')).toBeUndefined();
  });
});
```

(This test is illustrative — adapt it to match the existing test patterns and helpers in `backtest-engine.test.ts`.)

- [ ] **Step 3: Run — verify failure**

Run: `pnpm vitest run src/engine/backtest-engine.test.ts -t StrategyContext`
Expected: FAIL.

- [ ] **Step 4: Wire context in the engine**

In `src/engine/backtest-engine.ts`, extend the `ctx` construction:

```ts
const lastCloses = new Map<string, number>();   // already exists
const optionSubs: OptionSubscription[] = [];

const ctx: StrategyContext = {
  get cash() { return portfolio.cash; },
  position: (s) => portfolio.position(s),
  optionPosition: (s) => portfolio.optionPosition(s),
  submitOrder: (intent) => router.submit(intent),
  submitMultiLeg: (order) => router.submitMultiLeg(order),
  cancelOrder: (_id) => {},
  lastClose: (s) => lastCloses.get(s),
  subscribeOptions: (sub) => optionSubs.push(sub),
  indicator: indicators,
  params,
  logger,
};
```

(`portfolio.optionPosition` and `router.submitMultiLeg` are added in Tasks 9 and 10. For this task, stub them with `null` / `throw new Error('not yet')` so this task compiles and the test passes.)

- [ ] **Step 5: Run — verify pass**

Run: `pnpm vitest run src/engine/backtest-engine.test.ts -t StrategyContext`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/strategies/strategy.ts src/engine/backtest-engine.ts src/engine/backtest-engine.test.ts
git commit -m "feat(engine): extend StrategyContext for options (lastClose, multi-leg, subscribe)"
```

---

## Task 9: Broker-Sim — Multi-Leg Atomic Fills

**Files:**
- Modify: `src/engine/broker-sim.ts`
- Modify: `src/engine/order-router.ts`
- Test: `src/engine/broker-sim.test.ts`

Goal: `BrokerSim.processMultiLeg(order, snapshotByContract)` fills all legs at the *next* bar's open per leg, with 1-tick adverse slippage per leg, charging per-leg fees. If any leg has no next bar, reject the entire order (no partial fills).

- [ ] **Step 1: Write the failing test**

```ts
describe('BrokerSim.processMultiLeg', () => {
  it('fills all legs atomically at next bar open with 1-tick slippage', () => {
    const sim = new BrokerSim();
    const ce = makeContract({ strike: 22000, type: 'CE' });
    const pe = makeContract({ strike: 22000, type: 'PE' });
    const order: MultiLegOrder = {
      id: 'ml-1', ts: new Date('2025-05-22T03:50:00Z'),
      legs: [
        { contract: ce, side: 'sell', qty: 1 },
        { contract: pe, side: 'sell', qty: 1 },
      ],
      reason: 'entry',
    };
    const nextBars = new Map<string, Candle>([
      [ce.symbol, makeBar(ce.symbol, { open: 100, close: 102 })],
      [pe.symbol, makeBar(pe.symbol, { open: 95, close: 97 })],
    ]);
    const result = sim.processMultiLeg(order, nextBars);
    expect(result.fills).toHaveLength(2);
    expect(result.fills[0]!.price).toBeCloseTo(99.95, 2);   // SELL: 1 tick below open = 100 - 0.05
    expect(result.fills[0]!.fees.stt).toBeGreaterThan(0);
  });

  it('rejects the whole order when any leg has no next bar', () => {
    const sim = new BrokerSim();
    const ce = makeContract({ strike: 22000, type: 'CE' });
    const pe = makeContract({ strike: 22000, type: 'PE' });
    const order: MultiLegOrder = {
      id: 'ml-2', ts: new Date('2025-05-22T03:50:00Z'),
      legs: [{ contract: ce, side: 'sell', qty: 1 }, { contract: pe, side: 'sell', qty: 1 }],
      reason: 'entry',
    };
    const nextBars = new Map<string, Candle>([
      [ce.symbol, makeBar(ce.symbol, { open: 100 })],
      // pe missing
    ]);
    const result = sim.processMultiLeg(order, nextBars);
    expect(result.fills).toHaveLength(0);
    expect(result.rejection).toBeDefined();
    expect(result.rejection!.reason).toBe('no-liquidity');
  });
});
```

(`makeContract` and `makeBar` helpers — copy patterns from existing broker-sim tests.)

- [ ] **Step 2: Run — verify failure**

Run: `pnpm vitest run src/engine/broker-sim.test.ts -t processMultiLeg`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/engine/broker-sim.ts`:

```ts
import type { MultiLegOrder, Leg } from '../types/options';
import { calcOptionLegCharges } from './brokerage/options-charges';

const TICK = 0.05;

export interface MultiLegResult {
  fills: Fill[];
  rejection?: { reason: string };
}

processMultiLeg(order: MultiLegOrder, nextBars: Map<string, Candle>): MultiLegResult {
  // Validate every leg has a next bar before any fill
  for (const leg of order.legs) {
    if (!nextBars.has(leg.contract.symbol)) {
      return { fills: [], rejection: { reason: 'no-liquidity' } };
    }
  }

  const fills: Fill[] = [];
  for (const leg of order.legs) {
    const bar = nextBars.get(leg.contract.symbol)!;
    const slippage = leg.side === 'buy' ? +TICK : -TICK;
    const price = bar.open + slippage;
    const fees = calcOptionLegCharges({ contract: leg.contract, side: leg.side, qty: leg.qty, price });
    fills.push({
      orderId: order.id,
      symbol: leg.contract.symbol,
      side: leg.side,
      qty: leg.qty * leg.contract.lotSize,   // shares (not lots) — matches existing Fill semantics
      price,
      ts: bar.ts,
      fees,
    });
  }
  return { fills };
}
```

- [ ] **Step 4: Add `OrderRouter.submitMultiLeg` and queueing**

In `src/engine/order-router.ts`:

```ts
private multiLegQueue: MultiLegOrder[] = [];
private multiLegId = 0;

submitMultiLeg(order: Omit<MultiLegOrder, 'id' | 'ts'>): string {
  const id = `ml-${++this.multiLegId}`;
  const full: MultiLegOrder = { ...order, id, ts: new Date(0) };  // ts set when drained
  this.multiLegQueue.push(full);
  return id;
}

drainMultiLeg(): MultiLegOrder[] {
  const out = this.multiLegQueue;
  this.multiLegQueue = [];
  return out;
}
```

- [ ] **Step 5: Wire into engine loop**

In `src/engine/backtest-engine.ts`, after the existing pending-order processing block, add multi-leg handling. The engine must collect "next bar" per contract — keep a map `nextBarByContract: Map<symbol, Candle>` populated as bars arrive, and process multi-leg orders against it on each bar tick (or when all required bars have appeared).

For simplicity: when a multi-leg order is queued, store it pending; on every subsequent bar, check whether all leg symbols have a "next bar" available since queue time. If yes, process and remove from pending. If not by some timeout (e.g., end of day), reject.

```ts
// inside the bar loop, after pending equity orders processed:
const stillPendingMl: MultiLegOrder[] = [];
for (const ml of pendingMl) {
  const nextBars = new Map<string, Candle>();
  let allPresent = true;
  for (const leg of ml.legs) {
    const next = pendingNextBarByContract.get(leg.contract.symbol);
    if (!next || next.ts <= ml.ts) { allPresent = false; break; }
    nextBars.set(leg.contract.symbol, next);
  }
  if (allPresent) {
    const result = broker.processMultiLeg(ml, nextBars);
    if (result.fills.length > 0) {
      for (const f of result.fills) {
        portfolio.applyOptionFill(f, ml.legs.find((l) => l.contract.symbol === f.symbol)!);
        fills.push(f);
      }
    } else if (result.rejection) {
      logger.warn({ orderId: ml.id, reason: result.rejection.reason }, 'multi-leg rejected');
    }
  } else {
    stillPendingMl.push(ml);
  }
}
pendingMl = stillPendingMl;
```

`pendingNextBarByContract` is updated as `nextBarByContract.set(bar.symbol, bar)` at the START of each iteration (before processing pending orders), so that "next bar after order ts" is correctly identified.

- [ ] **Step 6: Run — verify pass**

Run: `pnpm vitest run src/engine/broker-sim.test.ts`
Expected: PASS for the multi-leg tests.

- [ ] **Step 7: Commit**

```bash
git add src/engine/broker-sim.ts src/engine/broker-sim.test.ts src/engine/order-router.ts src/engine/backtest-engine.ts
git commit -m "feat(engine): atomic multi-leg fills with per-leg charges and slippage"
```

---

## Task 10: Portfolio — Option Positions and Basket Margin

**Files:**
- Modify: `src/engine/portfolio.ts`
- Test: `src/engine/portfolio.test.ts`

Goal: `Portfolio` tracks option positions alongside equity positions. New methods: `applyOptionFill(fill, leg)`, `optionPosition(symbol)`, `optionPositions()`, `marginRequired()`. MTM extended to include option positions.

- [ ] **Step 1: Write the failing test**

```ts
describe('Portfolio option positions', () => {
  it('applyOptionFill creates a short option position for a SELL leg', () => {
    const p = new Portfolio(500_000);
    const leg: Leg = { contract: ceContract, side: 'sell', qty: 1 };
    const fill: Fill = {
      orderId: 'ml-1', symbol: ceContract.symbol, side: 'sell',
      qty: 75, price: 100, ts: new Date(), fees: zeroFees(),
    };
    p.applyOptionFill(fill, leg);
    const pos = p.optionPosition(ceContract.symbol);
    expect(pos!.netQty).toBe(-1);
    expect(pos!.avgPrice).toBe(100);
    // SELL credits cash by notional minus fees
    expect(p.cash).toBeCloseTo(500_000 + 75 * 100, 2);
  });

  it('reverses a short on BUY-to-close, realizing P&L', () => {
    const p = new Portfolio(500_000);
    const sellLeg: Leg = { contract: ceContract, side: 'sell', qty: 1 };
    const buyLeg: Leg = { contract: ceContract, side: 'buy', qty: 1 };
    p.applyOptionFill({ orderId: '1', symbol: ceContract.symbol, side: 'sell', qty: 75, price: 100, ts: new Date(), fees: zeroFees() }, sellLeg);
    p.applyOptionFill({ orderId: '2', symbol: ceContract.symbol, side: 'buy', qty: 75, price: 80, ts: new Date(), fees: zeroFees() }, buyLeg);
    expect(p.optionPosition(ceContract.symbol)!.netQty).toBe(0);
    expect(p.optionPosition(ceContract.symbol)!.realizedPnl).toBeCloseTo((100 - 80) * 75, 2);
  });

  it('marginRequired uses span-margin estimator', () => {
    const p = new Portfolio(500_000);
    const sellCe: Leg = { contract: ceContract, side: 'sell', qty: 1 };
    const sellPe: Leg = { contract: peContract, side: 'sell', qty: 1 };
    p.applyOptionFill({ orderId: '1', symbol: ceContract.symbol, side: 'sell', qty: 75, price: 100, ts: new Date(), fees: zeroFees() }, sellCe);
    p.applyOptionFill({ orderId: '2', symbol: peContract.symbol, side: 'sell', qty: 75, price: 100, ts: new Date(), fees: zeroFees() }, sellPe);
    expect(p.marginRequired()).toBeCloseTo(2 * 0.12 * 22000 * 75, 0);
  });
});
```

(`peContract` = same as `ceContract` but with `optionType: 'PE'` and a different symbol.)

- [ ] **Step 2: Run — verify failure**

Run: `pnpm vitest run src/engine/portfolio.test.ts -t option`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/engine/portfolio.ts`:

```ts
import type { OptionPosition, Leg } from '../types/options';
import { estimateMargin } from './brokerage/span-margin';

// inside class Portfolio:
private readonly _options = new Map<string, OptionPosition>();

optionPosition(symbol: string): OptionPosition | null {
  return this._options.get(symbol) ?? null;
}

optionPositions(): OptionPosition[] {
  return Array.from(this._options.values()).filter((p) => p.netQty !== 0);
}

marginRequired(): number {
  return estimateMargin(this.optionPositions());
}

applyOptionFill(fill: Fill, leg: Leg): void {
  const fees = fill.fees.total;
  // qty in `fill` is in shares (lots × lotSize); convert back to lots for the position
  const lots = fill.qty / leg.contract.lotSize;
  const signedDelta = leg.side === 'buy' ? +lots : -lots;
  const cashDelta = leg.side === 'buy' ? -(fill.qty * fill.price) : +(fill.qty * fill.price);
  this._cash += cashDelta - fees;

  const existing = this._options.get(leg.contract.symbol);
  if (!existing) {
    this._options.set(leg.contract.symbol, {
      contract: leg.contract,
      netQty: signedDelta,
      avgPrice: fill.price,
      realizedPnl: 0,
    });
    return;
  }

  // Closing/reversing: realize P&L on the closing portion
  const sameDir = Math.sign(existing.netQty) === Math.sign(signedDelta);
  if (sameDir) {
    // Adding to position — re-weight avg
    const newQty = existing.netQty + signedDelta;
    existing.avgPrice = (existing.avgPrice * Math.abs(existing.netQty) + fill.price * Math.abs(signedDelta)) / Math.abs(newQty);
    existing.netQty = newQty;
  } else {
    const closingLots = Math.min(Math.abs(existing.netQty), Math.abs(signedDelta));
    const closingShares = closingLots * leg.contract.lotSize;
    // For a short position closed by a buy: profit = (entry - exit) × shares
    // For a long position closed by a sell: profit = (exit - entry) × shares
    const pnl = existing.netQty < 0
      ? (existing.avgPrice - fill.price) * closingShares
      : (fill.price - existing.avgPrice) * closingShares;
    existing.realizedPnl += pnl;
    this._realized += pnl;
    existing.netQty += signedDelta;
    if (existing.netQty === 0) {
      // Keep entry in map for reporting (with netQty=0); avgPrice stays for record
    }
  }
}

// extend markToMarket to include option positions:
markToMarket(lastCloses: Map<string, number>, ts: Date): void {
  let unrealized = 0;
  for (const p of this._positions.values()) {
    const lc = lastCloses.get(p.symbol);
    if (lc !== undefined) unrealized += (lc - p.avgPrice) * p.qty;
  }
  for (const op of this._options.values()) {
    if (op.netQty === 0) continue;
    const lc = lastCloses.get(op.contract.symbol);
    if (lc === undefined) continue;
    // Short: profit when premium drops; netQty negative → (avg - last) × |netQty| × lotSize
    const shares = Math.abs(op.netQty) * op.contract.lotSize;
    const direction = op.netQty < 0 ? (op.avgPrice - lc) : (lc - op.avgPrice);
    unrealized += direction * shares;
  }
  this._equity.push({ ts, cash: this._cash, unrealized, realized: this._realized, equity: this._cash + unrealized + this._realized });
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm vitest run src/engine/portfolio.test.ts`
Expected: PASS for new tests; existing equity tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/portfolio.ts src/engine/portfolio.test.ts
git commit -m "feat(engine): track option positions, basket margin, MTM"
```

---

## Task 11: Short Straddle Strategy

**Files:**
- Create: `src/strategies/short-straddle.ts`
- Test: `src/strategies/short-straddle.test.ts`
- Modify: `src/strategies/registry.ts` (register)
- Create: `run-configs/short-straddle-nifty.yaml`

Goal: implement the strategy per the spec — entry at `09:20` IST on each weekly expiry day, exit at `15:15` or 30% premium SL or 60% premium target.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { ShortStraddle } from './short-straddle';
import type { StrategyContext } from './strategy';
import type { OptionContract } from '../types';

function makeCtx(overrides: Partial<StrategyContext> = {}) {
  const submittedMl: Array<{ legs: Array<{ symbol: string; side: string }>; reason: string }> = [];
  const lastCloses = new Map<string, number>([['NIFTY 50', 22000]]);
  const optionPositions = new Map<string, { netQty: number }>();
  const ctx: StrategyContext = {
    cash: 1_000_000,
    position: () => null,
    optionPosition: (s) => (optionPositions.get(s) as never) ?? null,
    submitOrder: () => 'o',
    submitMultiLeg: (o) => { submittedMl.push({ legs: o.legs.map((l) => ({ symbol: l.contract.symbol, side: l.side })), reason: o.reason }); return 'ml-1'; },
    cancelOrder: () => {},
    lastClose: (s) => lastCloses.get(s),
    subscribeOptions: () => {},
    indicator: {} as never,
    params: { entryTime: '09:20', exitTime: '15:15', slPctOnPremium: 30, lots: 1, atmContracts: makeAtmContracts() },
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ...overrides,
  };
  return { ctx, submittedMl, optionPositions, lastCloses };
}

function makeAtmContracts() {
  // Test helper that provides ATM CE/PE for NIFTY 22000 on 2025-05-22 expiry
  // ... return Record<expiryDateIsoString, { ce, pe }>
}

describe('ShortStraddle', () => {
  it('emits a SELL straddle MultiLegOrder at entryTime on expiry day', () => {
    // Bar: NIFTY 50 spot bar at 09:20 IST on a Thursday expiry day
    const { ctx, submittedMl } = makeCtx();
    const strat = new ShortStraddle();
    strat.init(ctx);
    strat.onBar({ symbol: 'NIFTY 50', ts: new Date('2025-05-22T03:50:00Z'), interval: '1minute', open: 22000, high: 22010, low: 21990, close: 22000, volume: 0 }, ctx);
    expect(submittedMl).toHaveLength(1);
    expect(submittedMl[0]!.legs.every((l) => l.side === 'sell')).toBe(true);
    expect(submittedMl[0]!.reason).toBe('entry');
  });

  it('exits at SL when combined premium rises >= 30%', () => {
    // ... entry already happened, set lastCloses for CE and PE such that their sum > entryPremium * 1.3
  });

  it('exits at exitTime if neither SL nor target hit', () => {
    // ... bar at 15:15 IST, expect exit MultiLegOrder with reason='eod'
  });

  it('does nothing on non-expiry weekdays', () => { /* ... */ });
});
```

(Adapt — these tests need helpers for synthetic expiry calendar and ATM-contract registry. Extract those into a small helper file `test/helpers/options-fixtures.ts` if it grows.)

- [ ] **Step 2: Run — verify failure**

Run: `pnpm vitest run src/strategies/short-straddle.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/strategies/short-straddle.ts`:

```ts
import { Strategy, type StrategyContext } from './strategy';
import { OrderSide, type Candle } from '../types';
import type { OptionContract } from '../types/options';

interface Params {
  entryTime: string;          // 'HH:MM' IST
  exitTime: string;
  slPctOnPremium: number;
  targetPctOnPremium?: number;
  lots: number;
  underlying: 'NIFTY' | 'BANKNIFTY';
  spotSymbol: string;         // 'NIFTY 50' or 'NIFTY BANK'
  /** Map: ISO expiry date (yyyy-mm-dd) -> { ce: OptionContract, pe: OptionContract } at ATM, pre-resolved per expiry */
  atmContracts: Record<string, { ce: OptionContract; pe: OptionContract }>;
}

interface State {
  entryPremium?: number;
  active: boolean;
  expiryKey?: string;         // current day's expiry ISO date
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istHHMM(ts: Date): string {
  const ist = new Date(ts.getTime() + IST_OFFSET_MS);
  const hh = ist.getUTCHours().toString().padStart(2, '0');
  const mm = ist.getUTCMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function istDateKey(ts: Date): string {
  const ist = new Date(ts.getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

export class ShortStraddle extends Strategy {
  private p!: Params;
  private state: State = { active: false };

  init(ctx: StrategyContext): void {
    this.p = ctx.params as unknown as Params;
  }

  onBar(bar: Candle, ctx: StrategyContext): void {
    if (bar.symbol !== this.p.spotSymbol) return;             // trigger only on spot bar

    const dateKey = istDateKey(bar.ts);
    const time = istHHMM(bar.ts);
    const today = this.p.atmContracts[dateKey];
    if (!today) return;                                       // no expiry today

    if (!this.state.active && time === this.p.entryTime) {
      ctx.submitMultiLeg({
        legs: [
          { contract: today.ce, side: OrderSide.SELL, qty: this.p.lots },
          { contract: today.pe, side: OrderSide.SELL, qty: this.p.lots },
        ],
        reason: 'entry',
      });
      this.state.active = true;
      this.state.expiryKey = dateKey;
      // Record entry premium from current closes
      const ceClose = ctx.lastClose(today.ce.symbol);
      const peClose = ctx.lastClose(today.pe.symbol);
      if (ceClose !== undefined && peClose !== undefined) {
        this.state.entryPremium = ceClose + peClose;
      }
      return;
    }

    if (this.state.active && this.state.expiryKey === dateKey) {
      const ceClose = ctx.lastClose(today.ce.symbol);
      const peClose = ctx.lastClose(today.pe.symbol);
      if (ceClose === undefined || peClose === undefined) return;
      const current = ceClose + peClose;
      const ep = this.state.entryPremium ?? current;

      const slHit = current >= ep * (1 + this.p.slPctOnPremium / 100);
      const targetHit = this.p.targetPctOnPremium !== undefined
        && current <= ep * (1 - this.p.targetPctOnPremium / 100);
      const eod = time >= this.p.exitTime;

      if (slHit || targetHit || eod) {
        ctx.submitMultiLeg({
          legs: [
            { contract: today.ce, side: OrderSide.BUY, qty: this.p.lots },
            { contract: today.pe, side: OrderSide.BUY, qty: this.p.lots },
          ],
          reason: slHit ? 'sl' : targetHit ? 'target' : 'eod',
        });
        this.state.active = false;
        this.state.entryPremium = undefined;
      }
    }
  }
}
```

- [ ] **Step 4: Register in `src/strategies/registry.ts`**

```ts
import { ShortStraddle } from './short-straddle';
// ...
const REGISTRY: Record<string, StrategyConstructor> = {
  // ... existing ...
  ShortStraddle,
};
```

- [ ] **Step 5: Add run config**

Create `run-configs/short-straddle-nifty.yaml`:

```yaml
strategy: ShortStraddle
underlying: NIFTY
period: { from: 2025-05-01, to: 2026-05-01 }
initialCapital: 500000
params:
  entryTime: "09:20"
  exitTime: "15:15"
  slPctOnPremium: 30
  targetPctOnPremium: 60
  lots: 1
  underlying: NIFTY
  spotSymbol: "NIFTY 50"
  # atmContracts is populated at run-time by the loader before engine starts
```

- [ ] **Step 6: Run — verify pass**

Run: `pnpm vitest run src/strategies/short-straddle.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/strategies/short-straddle.ts src/strategies/short-straddle.test.ts src/strategies/registry.ts run-configs/short-straddle-nifty.yaml
git commit -m "feat(strategy): short straddle on weekly expiry day with premium SL/target"
```

---

## Task 12: Iron Condor Strategy

**Files:**
- Create: `src/strategies/iron-condor.ts`
- Test: `src/strategies/iron-condor.test.ts`
- Modify: `src/strategies/registry.ts`
- Create: `run-configs/iron-condor-nifty.yaml`

Goal: enter Monday 09:30, exit Thursday 15:00 or SL on 30% of credit.

- [ ] **Step 1: Write the failing test**

```ts
describe('IronCondor', () => {
  it('enters 4-leg condor on Monday entryTime', () => {
    // ... bar: NIFTY 50 spot at Monday 09:30 IST
    // expect submittedMl with 4 legs: SELL ATM+200 CE, BUY ATM+300 CE, SELL ATM-200 PE, BUY ATM-300 PE
  });

  it('exits at SL when MTM loss >= 30% of credit', () => { /* ... */ });

  it('forces exit on Thursday at exitTime', () => { /* ... */ });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm vitest run src/strategies/iron-condor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/strategies/iron-condor.ts`:

```ts
import { Strategy, type StrategyContext } from './strategy';
import { OrderSide, type Candle } from '../types';
import type { OptionContract } from '../types/options';

interface ParamsCondor {
  entryDay: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday';
  entryTime: string;
  exitDay: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday';
  exitTime: string;
  shortStrikeOffset: number;
  wingWidth: number;
  slPctOnCredit: number;
  lots: number;
  underlying: 'NIFTY' | 'BANKNIFTY';
  spotSymbol: string;
  /** Map weekKey (yyyy-Www) -> 4 contracts at this offset/wing for that week's expiry */
  weeklyContracts: Record<string, { shortCall: OptionContract; longCall: OptionContract; shortPut: OptionContract; longPut: OptionContract }>;
}

interface CondorState {
  active: boolean;
  weekKey?: string;
  creditReceived?: number;     // in rupees, lot-adjusted
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_INDEX: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function istParts(ts: Date) {
  const ist = new Date(ts.getTime() + IST_OFFSET_MS);
  return {
    day: ist.getUTCDay(),
    hhmm: `${ist.getUTCHours().toString().padStart(2, '0')}:${ist.getUTCMinutes().toString().padStart(2, '0')}`,
    weekKey: `${ist.getUTCFullYear()}-W${Math.ceil(((ist.getTime() - Date.UTC(ist.getUTCFullYear(), 0, 1)) / 86400000 + new Date(Date.UTC(ist.getUTCFullYear(), 0, 1)).getUTCDay() + 1) / 7).toString().padStart(2, '0')}`,
  };
}

export class IronCondor extends Strategy {
  private p!: ParamsCondor;
  private state: CondorState = { active: false };

  init(ctx: StrategyContext): void {
    this.p = ctx.params as unknown as ParamsCondor;
  }

  onBar(bar: Candle, ctx: StrategyContext): void {
    if (bar.symbol !== this.p.spotSymbol) return;

    const { day, hhmm, weekKey } = istParts(bar.ts);
    const week = this.p.weeklyContracts[weekKey];
    if (!week) return;

    if (!this.state.active && day === DAY_INDEX[this.p.entryDay] && hhmm === this.p.entryTime) {
      ctx.submitMultiLeg({
        legs: [
          { contract: week.shortCall, side: OrderSide.SELL, qty: this.p.lots },
          { contract: week.longCall,  side: OrderSide.BUY,  qty: this.p.lots },
          { contract: week.shortPut,  side: OrderSide.SELL, qty: this.p.lots },
          { contract: week.longPut,   side: OrderSide.BUY,  qty: this.p.lots },
        ],
        reason: 'entry',
      });
      // Compute credit at entry from last closes
      const sc = ctx.lastClose(week.shortCall.symbol);
      const lc = ctx.lastClose(week.longCall.symbol);
      const sp = ctx.lastClose(week.shortPut.symbol);
      const lp = ctx.lastClose(week.longPut.symbol);
      if ([sc, lc, sp, lp].every((v) => v !== undefined)) {
        this.state.creditReceived = (sc! + sp! - lc! - lp!) * week.shortCall.lotSize * this.p.lots;
      }
      this.state.active = true;
      this.state.weekKey = weekKey;
      return;
    }

    if (this.state.active && this.state.weekKey === weekKey) {
      const sc = ctx.lastClose(week.shortCall.symbol);
      const lc = ctx.lastClose(week.longCall.symbol);
      const sp = ctx.lastClose(week.shortPut.symbol);
      const lp = ctx.lastClose(week.longPut.symbol);
      let slHit = false;
      if ([sc, lc, sp, lp].every((v) => v !== undefined) && this.state.creditReceived !== undefined) {
        const buyBackCost = (sc! + sp! - lc! - lp!) * week.shortCall.lotSize * this.p.lots;
        const mtmPnl = this.state.creditReceived - buyBackCost;
        slHit = mtmPnl <= -this.state.creditReceived * (this.p.slPctOnCredit / 100);
      }
      const exit = day === DAY_INDEX[this.p.exitDay] && hhmm >= this.p.exitTime;
      if (slHit || exit) {
        ctx.submitMultiLeg({
          legs: [
            { contract: week.shortCall, side: OrderSide.BUY,  qty: this.p.lots },
            { contract: week.longCall,  side: OrderSide.SELL, qty: this.p.lots },
            { contract: week.shortPut,  side: OrderSide.BUY,  qty: this.p.lots },
            { contract: week.longPut,   side: OrderSide.SELL, qty: this.p.lots },
          ],
          reason: slHit ? 'sl' : 'exit',
        });
        this.state.active = false;
        this.state.creditReceived = undefined;
        this.state.weekKey = undefined;
      }
    }
  }
}
```

- [ ] **Step 4: Register, add run-config**

`registry.ts`: add `IronCondor`. Create `run-configs/iron-condor-nifty.yaml` per spec.

- [ ] **Step 5: Run — verify pass**

Run: `pnpm vitest run src/strategies/iron-condor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/strategies/iron-condor.ts src/strategies/iron-condor.test.ts src/strategies/registry.ts run-configs/iron-condor-nifty.yaml
git commit -m "feat(strategy): iron condor weekly entry/exit with credit-based SL"
```

---

## Task 13: Options Report Renderer

**Files:**
- Create: `src/report/options-report.ts`
- Test: `src/report/options-report.test.ts`
- Modify: report entry point (look up actual file in `src/report/`)

Goal: produce HTML report extension showing per-expiry table, leg breakdown, summary stats including charge drag and margin utilization.

- [ ] **Step 1: Read existing report renderer**

Run: `ls src/report/` and read the main HTML renderer to match the existing pattern.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { renderOptionsSection } from './options-report';

describe('renderOptionsSection', () => {
  it('groups fills by multi-leg order id and renders one row per expiry', () => {
    const fills = [/* 4 fills with same orderId='ml-1', then 4 with 'ml-2' (exit) */];
    const html = renderOptionsSection(fills, /* portfolio snapshot */);
    expect(html).toContain('per-expiry');
    expect(html).toContain('Charge drag');
  });

  it('computes charge drag = totalFees / |grossPnl|', () => { /* ... */ });
});
```

- [ ] **Step 3: Run — verify failure**

Run: `pnpm vitest run src/report/options-report.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

Create `src/report/options-report.ts`. To make grouping deterministic, **prerequisite**: extend `Fill` with an optional `multiLegOrderId?: string` field (added in Task 9 broker-sim implementation). Each leg's `Fill` carries the originating `MultiLegOrder.id`. Then group as follows:

```ts
import type { Fill } from '../types';

export interface OptionsReportRow {
  expiryDate: string;
  entryTs: Date;
  exitTs: Date | null;
  grossPnl: number;
  charges: number;
  netPnl: number;
  entryLegs: Fill[];
  exitLegs: Fill[];
}

interface LegBasket {
  orderId: string;
  ts: Date;
  fills: Fill[];
  expiryKey: string;
}

export function buildOptionsRows(fills: Fill[]): OptionsReportRow[] {
  // 1. Group fills by multiLegOrderId
  const baskets = new Map<string, LegBasket>();
  for (const f of fills) {
    if (!f.multiLegOrderId) continue;       // skip equity fills
    let b = baskets.get(f.multiLegOrderId);
    if (!b) {
      const expiryKey = f.symbol.match(/(\d{2}[A-Z]{3}\d{2,4})/)?.[1] ?? 'unknown';
      b = { orderId: f.multiLegOrderId, ts: f.ts, fills: [], expiryKey };
      baskets.set(f.multiLegOrderId, b);
    }
    b.fills.push(f);
  }

  // 2. Pair baskets by expiryKey: earliest = entry, next = exit
  const byExpiry = new Map<string, LegBasket[]>();
  for (const b of baskets.values()) {
    const arr = byExpiry.get(b.expiryKey) ?? [];
    arr.push(b);
    byExpiry.set(b.expiryKey, arr);
  }

  const rows: OptionsReportRow[] = [];
  for (const [expiryKey, arr] of byExpiry) {
    arr.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    for (let i = 0; i < arr.length; i += 2) {
      const entry = arr[i]!;
      const exit = arr[i + 1] ?? null;
      const allFills = [...entry.fills, ...(exit?.fills ?? [])];
      const charges = allFills.reduce((s, f) => s + f.fees.total, 0);
      // P&L: each leg's signed cash flow = (sell credits, buy debits) - fees
      let cashFlow = 0;
      for (const f of allFills) {
        cashFlow += (f.side === 'sell' ? +1 : -1) * f.qty * f.price;
      }
      const grossPnl = cashFlow;             // already net of all leg flows
      rows.push({
        expiryDate: expiryKey,
        entryTs: entry.ts,
        exitTs: exit?.ts ?? null,
        grossPnl,
        charges,
        netPnl: grossPnl - charges,
        entryLegs: entry.fills,
        exitLegs: exit?.fills ?? [],
      });
    }
  }
  rows.sort((a, b) => a.entryTs.getTime() - b.entryTs.getTime());
  return rows;
}

export function renderOptionsSection(fills: Fill[]): string {
  const rows = buildOptionsRows(fills);
  if (rows.length === 0) return '';
  const totalGross = rows.reduce((s, r) => s + r.grossPnl, 0);
  const totalCharges = rows.reduce((s, r) => s + r.charges, 0);
  const chargeDrag = Math.abs(totalGross) > 0 ? (totalCharges / Math.abs(totalGross)) * 100 : 0;

  const tbody = rows.map((r) => `
    <tr>
      <td>${r.expiryDate}</td>
      <td>${r.entryTs.toISOString()}</td>
      <td>${r.exitTs?.toISOString() ?? '—'}</td>
      <td>${r.grossPnl.toFixed(2)}</td>
      <td>${r.charges.toFixed(2)}</td>
      <td>${r.netPnl.toFixed(2)}</td>
    </tr>`).join('');

  return `
<section class="per-expiry">
  <h3>Per-expiry options breakdown</h3>
  <table>
    <thead><tr><th>Expiry</th><th>Entry</th><th>Exit</th><th>Gross P&amp;L</th><th>Charges</th><th>Net P&amp;L</th></tr></thead>
    <tbody>${tbody}</tbody>
  </table>
  <p>Charge drag: ${chargeDrag.toFixed(1)}%</p>
</section>`;
}
```

This requires a small upstream change: in Task 9, when `BrokerSim.processMultiLeg` constructs each `Fill`, set `multiLegOrderId: order.id`. Add `multiLegOrderId?: string` to the `Fill` interface in `src/types/index.ts` as part of Task 9.

- [ ] **Step 5: Hook into the existing report entry**

Modify the main report renderer to invoke `renderOptionsSection(fills)` and include it in the output HTML.

- [ ] **Step 6: Run — verify pass**

Run: `pnpm vitest run src/report/options-report.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/report/options-report.ts src/report/options-report.test.ts src/report/<main-renderer>
git commit -m "feat(report): per-expiry options breakdown with charge drag and margin util"
```

---

## Task 14: CLI Fetch Options Command

**Files:**
- Create: `src/cli/fetch-options.ts`
- Modify: `src/cli/index.ts` (or wherever the CLI dispatch lives)

Goal: `pnpm cli fetch-options NIFTY 2025-05-01 2026-05-01` populates the options instrument index and 1m candles for ATM±10 strikes per weekly expiry.

- [ ] **Step 1: Read the existing CLI dispatch**

Run: `ls src/cli/` and read `index.ts` to follow the existing command pattern (e.g., how `fetch` is registered).

- [ ] **Step 2: Implement the command**

Create `src/cli/fetch-options.ts`:

```ts
import type { KiteSource } from '../data/kite-source';
import type { InstrumentStore } from '../data/instrument-store';
import { resolveAtmChain } from '../data/options-chain';
import type { CandleStore } from '../data/candle-store';
import { parseBhavcopy } from '../data/nse-bhavcopy';
import type { Underlying, OptionContract } from '../types/options';
import type { Logger } from '../util/logger';

const STEP: Record<Underlying, number> = { NIFTY: 50, BANKNIFTY: 100 };
const SPOT_SYMBOL: Record<Underlying, string> = { NIFTY: 'NIFTY 50', BANKNIFTY: 'NIFTY BANK' };
const SPOT_TOKEN: Record<Underlying, number> = { NIFTY: 256265, BANKNIFTY: 260105 };

export interface FetchOptionsDeps {
  source: KiteSource;
  instruments: InstrumentStore;
  candles: CandleStore;
  logger: Logger;
  /** Path to a JSON file mapping (underlying|expiryISO|strike|type) -> instrumentToken, captured from a historical Kite dump. */
  tokenMapPath: string;
  /** Directory of pre-downloaded NSE bhavcopy CSVs, one per trading day. */
  bhavcopyDir: string;
}

export async function fetchOptions(
  underlying: Underlying,
  from: Date,
  to: Date,
  deps: FetchOptionsDeps,
): Promise<void> {
  const { source, instruments, candles, logger, tokenMapPath, bhavcopyDir } = deps;
  const fs = await import('node:fs');
  const path = await import('node:path');

  // 1. Hydrate InstrumentStore from bhavcopy CSVs in [from, to]
  const tokenMap: Record<string, number> = JSON.parse(fs.readFileSync(tokenMapPath, 'utf8'));
  const bhavFiles = fs.readdirSync(bhavcopyDir).filter((f) => f.endsWith('.csv')).sort();

  for (const f of bhavFiles) {
    const rows = parseBhavcopy(path.join(bhavcopyDir, f));
    for (const r of rows) {
      if (r.underlying !== underlying) continue;
      if (r.expiry < from || r.expiry > to) continue;
      const key = `${r.underlying}|${r.expiry.toISOString()}|${r.strike}|${r.optionType}`;
      const token = tokenMap[key];
      if (token === undefined) {
        logger.warn({ key }, 'no token in tokenMap; skipping contract');
        continue;
      }
      const contract: OptionContract = {
        symbol: `${r.underlying}${r.expiry.toISOString().slice(0, 10).replace(/-/g, '')}${r.strike}${r.optionType}`,
        underlying: r.underlying,
        expiry: r.expiry,
        strike: r.strike,
        optionType: r.optionType,
        lotSize: r.underlying === 'NIFTY' ? 75 : 35,   // refine: read from bhavcopy if column present
        instrumentToken: token,
      };
      instruments.addOption(contract);
    }
  }

  // 2. Fetch index spot candles for the whole window so ATM resolution works
  const spotCandles = await source.fetchOptionCandles(SPOT_TOKEN[underlying], from, to, '1minute');
  candles.put(SPOT_SYMBOL[underlying], '1minute', spotCandles);

  // 3. For each weekly expiry, resolve ATM at the relevant trigger moment and fetch chain candles
  for (const expiry of instruments.expiries(underlying)) {
    if (expiry < from || expiry > to) continue;

    // Use 09:20 IST on Monday-of-week (or expiry day for short straddle) as the ATM-resolution moment.
    // For a single fetch pass we use the expiry-day open spot — strikes selected by it cover both strategies.
    const expiryOpenIst = new Date(expiry.getTime() - 6 * 60 * 60 * 1000); // 09:30 IST on expiry day = 04:00 UTC
    const spotBar = spotCandles.find((c) => c.ts >= expiryOpenIst);
    if (!spotBar) {
      logger.warn({ expiry }, 'no spot bar near expiry; skipping');
      continue;
    }
    const chain = resolveAtmChain(instruments, underlying, expiry, spotBar.close, 10, STEP[underlying]);

    // Each weekly contract trades roughly 5 trading days back from expiry; fetch from 6 days before
    const contractFrom = new Date(expiry.getTime() - 8 * 24 * 60 * 60 * 1000);
    for (const c of chain) {
      const cs = await source.fetchOptionCandles(c.instrumentToken, contractFrom, expiry, '1minute');
      candles.put(c.symbol, '1minute', cs);
      logger.info({ symbol: c.symbol, bars: cs.length }, 'cached option candles');
    }
  }
}
```

The `tokenMap` JSON is a one-time export of the Kite instrument dump — the user runs a small script that fetches `kite.getInstruments('NFO')` and writes the keyed JSON. Document this in the README as a prerequisite. If `tokenMapPath` is missing for older expired contracts, those expiries are skipped with a warning.

- [ ] **Step 3: Wire into CLI dispatch**

Add `fetch-options` to the command switch in `src/cli/index.ts`. Match existing arg parsing.

- [ ] **Step 4: Smoke test by hand**

```bash
pnpm cli fetch-options NIFTY 2025-05-01 2025-05-08
ls data-cache/candles/options/NIFTY/
```

Expected: directories appear for one weekly expiry with ~42 contract files.

- [ ] **Step 5: Commit**

```bash
git add src/cli/fetch-options.ts src/cli/index.ts
git commit -m "feat(cli): fetch-options command for weekly NIFTY/BANKNIFTY chains"
```

---

## Task 15: End-to-End Integration Test (Short Straddle, 1 Month NIFTY)

**Files:**
- Create: `test/integration/short-straddle-1m-nifty.test.ts`
- Create: `test/fixtures/nifty-spot-1m-may2025.json` (synthetic, ~5 expiry days)
- Create: `test/fixtures/nifty-options-may2025/<expiry>/<strike>-<type>-1minute.json` (synthetic, intra-day decay curve)

Goal: run the full backtest end-to-end on synthetic but realistic minute data for May 2025 (4-5 weekly expiries), assert net P&L and trade count match hand-calculated values.

- [ ] **Step 1: Generate synthetic fixtures**

A small TS script (one-off, can live in `test/integration/_gen-fixtures.ts`) generates:
- 1m NIFTY 50 candles for ~22 trading days, opening 22000, modest random walk
- For each Thursday expiry: ATM CE+PE 1m candles where premium decays linearly from open (~₹150 each) to a final value derived from spot vs strike at 15:15

Save as JSON files under `test/fixtures/`.

- [ ] **Step 2: Write the integration test**

```ts
import { describe, it, expect } from 'vitest';
import { runBacktest } from '../../src/engine/backtest-engine';
// ... wire up Portfolio, BrokerSim, OrderRouter, ShortStraddle, fixture loader

describe('short straddle integration — NIFTY May 2025', () => {
  it('runs to completion and produces N trades with expected net P&L', () => {
    const result = runScenario('short-straddle-may2025');
    // 4 expiries → 4 entries + 4 exits = 8 multi-leg orders = 16 fills
    expect(result.fills.length).toBe(16);
    // hand-calculate expected net P&L for the synthetic data and assert
    expect(result.finalEquity).toBeCloseTo(/* expected */, -2);  // within ₹100
  });
});
```

- [ ] **Step 3: Run — verify pass**

Run: `pnpm vitest run test/integration/short-straddle-1m-nifty.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the same scenario via CLI**

```bash
pnpm cli backtest run-configs/short-straddle-nifty.yaml
open reports/<run-id>.html
```

Confirm:
- HTML report renders the new per-expiry section
- Charge drag shown
- Margin utilization shown
- Trade table includes leg breakdown

- [ ] **Step 5: Commit**

```bash
git add test/integration test/fixtures/nifty-spot-1m-may2025.json test/fixtures/nifty-options-may2025
git commit -m "test(integration): end-to-end short straddle on synthetic May 2025 NIFTY data"
```

---

## Self-Review Notes

After implementing all tasks, run the full suite and lint:

```bash
pnpm test
pnpm lint
```

**Spec coverage check** (each spec section → task):

| Spec section | Task(s) |
|---|---|
| Core types | 1 |
| Module layout | All |
| Instrument dump + ATM resolution | 2, 4 |
| Historical instrument resolution (bhavcopy) | 3 |
| Kite option candle fetch | 5 |
| Cache layout | 14 (CLI populates it) |
| Multi-instrument time loop | 8 (clarified — additive) |
| Multi-leg fill semantics | 9 |
| Portfolio extensions | 10 |
| Strategy interface | 8 |
| Short straddle | 11 |
| Iron condor | 12 |
| Per-leg charges | 6 |
| Margin model | 7 |
| Capital tracking | 10 (`marginRequired`), 8 (pre-trade check — **add to task 11/12 if missing**) |
| Report extensions | 13 |
| CLI | 14 |
| Tests per module | each task |
| End-to-end integration | 15 |

**Open follow-ups (not in v1):**
- Pre-trade margin check that vetoes a `submitMultiLeg` if `portfolio.cash < marginRequired(after)`. Add as a small enhancement if Task 11/12 tests require it; otherwise file as a separate task.
- Live NSE bhavcopy HTTP fetch (currently the parser accepts a local CSV; downloading and unzipping daily archives is out of scope for v1).
- Resampling 1m → 5m utility (only needed if a strategy actually uses 5m option candles; both v1 strategies are 1m, so defer).
