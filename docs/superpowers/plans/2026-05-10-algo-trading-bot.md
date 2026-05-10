# Algo Trading Bot — Implementation Plan (Milestone 1: Backtest)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript algo-trading backtest engine for Indian intraday equities via Zerodha Kite Connect, with DuckDB-cached historical data, a pluggable strategy interface, and a self-contained HTML report.

**Architecture:** Single-package Node monolith with strict folder boundaries. Hand-rolled event loop over time-merged candles drives a pluggable `Strategy`; orders flow through `OrderRouter` → `BrokerSim` → `Portfolio`; metrics + HTML report on completion. Data is fetched on demand from Kite and cached idempotently in a local DuckDB file.

**Tech Stack:** Node 20+, TypeScript strict, pnpm, vitest, eslint, prettier, `kiteconnect`, `@duckdb/node-api`, `technicalindicators`, `zod`, `pino`, `yaml`, `commander`, Chart.js (inlined into HTML report).

**Spec:** [docs/superpowers/specs/2026-05-10-algo-trading-bot-design.md](../specs/2026-05-10-algo-trading-bot-design.md)

**Lib API note:** This plan grounds DuckDB code on `@duckdb/node-api` (Neo) and Kite code on `kiteconnect@latest`. If a method signature has drifted, query context7 (`/duckdb/duckdb-node-neo` or `/zerodha/kiteconnectjs`) before guessing.

---

## File Structure

```
mikasa/
  package.json
  tsconfig.json
  vitest.config.ts
  .eslintrc.cjs
  .prettierrc
  .gitignore
  .env.example
  README.md
  .github/workflows/ci.yml

  src/
    types/
      index.ts                # Candle, Order, Fill, Position, Trade, Fees, ids
      run-config.ts           # RunConfig zod schema + type
    util/
      logger.ts               # pino logger factory
      time.ts                 # IST helpers, market-hours filter
    config/
      env.ts                  # zod-validated env loader
    indicators/
      registry.ts             # IndicatorRegistry
      sma.ts                  # rolling SMA
      ema.ts                  # rolling EMA
    data/
      candle-store.ts         # DuckDB candle table CRUD
      instrument-store.ts     # DuckDB instruments table + symbol → token
      kite-client.ts          # KiteConnect SDK wrapper, retry, chunking
      data-loader.ts          # cache miss/hit/partial orchestration
    engine/
      portfolio.ts            # cash, positions, mark-to-market, equity curve
      broker-sim.ts           # fill model + slippage + fees
      brokerage/
        zerodha-intraday.ts   # Zerodha intraday fee schedule
      order-router.ts         # intent → order, EOD squareoff
      backtest-engine.ts      # warmup + main loop + invariants
    strategies/
      strategy.ts             # abstract Strategy + StrategyContext
      sma-crossover.ts        # reference strategy
    report/
      metrics.ts              # Sharpe, Sortino, MDD, etc.
      html-report.ts          # self-contained HTML writer
    cli/
      index.ts                # commander entry
      commands/
        fetch.ts
        backtest.ts
        cache-info.ts

  test/
    fixtures/
      reliance-5min-2025-01.csv   # one month of 5-min RELIANCE candles for integration tests
    integration/
      backtest.e2e.test.ts

  run-configs/
    sma-crossover-reliance.yaml
```

---

## Task 1: Project bootstrap

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.eslintrc.cjs`
- Create: `.prettierrc`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/index.ts` (placeholder)

- [ ] **Step 1: Initialize package.json**

```bash
cd /Users/vikas/sbx/mikasa
pnpm init
```

Then overwrite `package.json` with:

```json
{
  "name": "mikasa",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "lint": "eslint \"src/**/*.ts\" \"test/**/*.ts\"",
    "lint:fix": "eslint --fix \"src/**/*.ts\" \"test/**/*.ts\"",
    "format": "prettier --write \"**/*.{ts,md,json,yaml,yml}\"",
    "test": "vitest run",
    "test:watch": "vitest",
    "cli": "tsx src/cli/index.ts"
  },
  "dependencies": {
    "@duckdb/node-api": "^1.1.3",
    "kiteconnect": "^5.0.0",
    "technicalindicators": "^3.1.0",
    "zod": "^3.23.0",
    "pino": "^9.0.0",
    "pino-pretty": "^11.0.0",
    "yaml": "^2.5.0",
    "commander": "^12.0.0",
    "luxon": "^3.5.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "@types/node": "^20.16.0",
    "eslint": "^9.10.0",
    "@typescript-eslint/parser": "^8.5.0",
    "@typescript-eslint/eslint-plugin": "^8.5.0",
    "prettier": "^3.3.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: 'threads',
  },
});
```

- [ ] **Step 4: Create .eslintrc.cjs**

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'off',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
  ignorePatterns: ['dist/', 'node_modules/', 'data-cache/', 'reports/', 'logs/'],
};
```

- [ ] **Step 5: Create .prettierrc**

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "semi": true
}
```

- [ ] **Step 6: Create .gitignore**

```
node_modules/
dist/
data-cache/
reports/
logs/
.env
.env.local
*.log
.DS_Store
```

- [ ] **Step 7: Create .env.example**

```
# Zerodha Kite Connect API credentials
# Get from https://developers.kite.trade/
KITE_API_KEY=
KITE_API_SECRET=
KITE_ACCESS_TOKEN=

# Optional log level: trace|debug|info|warn|error  (default: info)
LOG_LEVEL=info
```

- [ ] **Step 8: Create placeholder src/index.ts**

```ts
export const VERSION = '0.0.1';
```

- [ ] **Step 9: Install dependencies**

Run: `pnpm install`
Expected: install completes; `node_modules/` populated.

- [ ] **Step 10: Verify typecheck and test runner work**

Run: `pnpm typecheck`
Expected: no errors (empty src is fine).

Run: `pnpm test`
Expected: "No test files found, exiting with code 1" (acceptable — we'll add tests next).

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: bootstrap TypeScript project with vitest, eslint, prettier"
```

---

## Task 2: Core types

**Files:**
- Create: `src/types/index.ts`
- Test: `src/types/types.test.ts`

- [ ] **Step 1: Write the failing test**

`src/types/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Candle, OrderIntent, Order, Fill, Position, Trade, Fees } from './index';
import { OrderSide, OrderType, OrderStatus } from './index';

describe('core types', () => {
  it('constructs a Candle', () => {
    const c: Candle = {
      symbol: 'RELIANCE',
      ts: new Date('2025-01-02T03:45:00Z'),
      interval: '5minute',
      open: 1200,
      high: 1205,
      low: 1199,
      close: 1203,
      volume: 100_000,
    };
    expect(c.close).toBe(1203);
  });

  it('exposes order enums', () => {
    expect(OrderSide.BUY).toBe('buy');
    expect(OrderSide.SELL).toBe('sell');
    expect(OrderType.MARKET).toBe('market');
    expect(OrderType.LIMIT).toBe('limit');
    expect(OrderType.STOP).toBe('stop');
    expect(OrderStatus.SUBMITTED).toBe('submitted');
    expect(OrderStatus.FILLED).toBe('filled');
    expect(OrderStatus.REJECTED).toBe('rejected');
    expect(OrderStatus.PENDING).toBe('pending');
    expect(OrderStatus.EXPIRED).toBe('expired');
  });

  it('constructs an OrderIntent and Order/Fill/Position/Trade/Fees', () => {
    const intent: OrderIntent = {
      symbol: 'RELIANCE',
      side: OrderSide.BUY,
      qty: 10,
      type: OrderType.MARKET,
    };
    const order: Order = {
      id: 'ord-1',
      submittedAt: new Date(),
      status: OrderStatus.SUBMITTED,
      intent,
    };
    const fees: Fees = { brokerage: 20, stt: 1, exchange: 0.1, gst: 3.6, sebi: 0.001, stampDuty: 0.05, total: 24.751 };
    const fill: Fill = {
      orderId: order.id,
      symbol: 'RELIANCE',
      side: OrderSide.BUY,
      qty: 10,
      price: 1200,
      ts: new Date(),
      fees,
    };
    const pos: Position = { symbol: 'RELIANCE', qty: 10, avgPrice: 1200 };
    const trade: Trade = {
      symbol: 'RELIANCE',
      qty: 10,
      entryPrice: 1200,
      exitPrice: 1210,
      entryTs: new Date(),
      exitTs: new Date(),
      side: OrderSide.BUY,
      pnl: 100 - fees.total,
      fees: fees.total,
    };
    expect(order.intent.qty).toBe(10);
    expect(fill.fees.total).toBeCloseTo(24.751);
    expect(pos.avgPrice).toBe(1200);
    expect(trade.pnl).toBeCloseTo(100 - fees.total);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/types/types.test.ts`
Expected: FAIL — `Cannot find module './index'` (or similar).

- [ ] **Step 3: Implement the types**

`src/types/index.ts`:

```ts
export type Interval = '1minute' | '3minute' | '5minute' | '10minute' | '15minute' | '30minute' | '60minute' | 'day';

export interface Candle {
  symbol: string;
  ts: Date;       // UTC; consumers convert to IST as needed
  interval: Interval;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const OrderSide = { BUY: 'buy', SELL: 'sell' } as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const OrderType = { MARKET: 'market', LIMIT: 'limit', STOP: 'stop' } as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const OrderStatus = {
  SUBMITTED: 'submitted',
  PENDING: 'pending',
  FILLED: 'filled',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export type OrderId = string;

export interface OrderIntent {
  symbol: string;
  side: OrderSide;
  qty: number;
  type: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  tag?: string;             // optional strategy-supplied label
}

export interface Order {
  id: OrderId;
  submittedAt: Date;
  status: OrderStatus;
  intent: OrderIntent;
  rejectionReason?: string;
}

export interface Fees {
  brokerage: number;
  stt: number;
  exchange: number;
  gst: number;
  sebi: number;
  stampDuty: number;
  total: number;
}

export interface Fill {
  orderId: OrderId;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  ts: Date;
  fees: Fees;
}

export interface Position {
  symbol: string;
  qty: number;            // signed: positive long, negative short
  avgPrice: number;
}

export interface Trade {
  symbol: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryTs: Date;
  exitTs: Date;
  side: OrderSide;        // side of the entry leg
  pnl: number;            // net of fees
  fees: number;           // total fees across entry + exit
}

export interface EquitySnapshot {
  ts: Date;
  cash: number;
  unrealized: number;
  realized: number;
  equity: number;         // cash + unrealized + realized
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/types/types.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/types
git commit -m "feat(types): add core domain types (Candle, Order, Fill, Position, Trade)"
```

---

## Task 3: Time util (IST helpers, market hours)

**Files:**
- Create: `src/util/time.ts`
- Test: `src/util/time.test.ts`

- [ ] **Step 1: Write the failing test**

`src/util/time.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toIST, parseHHMMtoUTC, isMarketHoursIST, isSquareoffBarIST } from './time';

describe('time util', () => {
  it('converts UTC Date to IST formatted string', () => {
    // 03:45 UTC == 09:15 IST
    const d = new Date('2025-01-02T03:45:00Z');
    expect(toIST(d, 'HH:mm')).toBe('09:15');
    expect(toIST(d, 'yyyy-MM-dd HH:mm')).toBe('2025-01-02 09:15');
  });

  it('parseHHMMtoUTC produces UTC Date for given calendar day in IST', () => {
    // 09:15 IST on 2025-01-02 == 03:45 UTC
    const d = parseHHMMtoUTC('2025-01-02', '09:15');
    expect(d.toISOString()).toBe('2025-01-02T03:45:00.000Z');
  });

  it('isMarketHoursIST: true between 09:15 and 15:30 IST inclusive of bar starts', () => {
    const open = new Date('2025-01-02T03:45:00Z'); // 09:15 IST
    const mid = new Date('2025-01-02T06:00:00Z');  // 11:30 IST
    const lastStart = new Date('2025-01-02T09:55:00Z'); // 15:25 IST
    const close = new Date('2025-01-02T10:00:00Z'); // 15:30 IST -- bar START at 15:30 is OUT
    const after = new Date('2025-01-02T10:05:00Z'); // 15:35 IST
    const before = new Date('2025-01-02T03:40:00Z'); // 09:10 IST
    expect(isMarketHoursIST(open)).toBe(true);
    expect(isMarketHoursIST(mid)).toBe(true);
    expect(isMarketHoursIST(lastStart)).toBe(true);
    expect(isMarketHoursIST(close)).toBe(false);
    expect(isMarketHoursIST(after)).toBe(false);
    expect(isMarketHoursIST(before)).toBe(false);
  });

  it('isSquareoffBarIST(ts, "15:15") matches only the 15:15 IST bar', () => {
    const target = new Date('2025-01-02T09:45:00Z'); // 15:15 IST
    const before = new Date('2025-01-02T09:40:00Z'); // 15:10 IST
    const after = new Date('2025-01-02T09:50:00Z');  // 15:20 IST
    expect(isSquareoffBarIST(target, '15:15')).toBe(true);
    expect(isSquareoffBarIST(before, '15:15')).toBe(false);
    expect(isSquareoffBarIST(after, '15:15')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/util/time.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/util/time.ts`:

```ts
import { DateTime } from 'luxon';

const IST_ZONE = 'Asia/Kolkata';

export function toIST(d: Date, fmt: string): string {
  return DateTime.fromJSDate(d, { zone: 'utc' }).setZone(IST_ZONE).toFormat(fmt);
}

export function parseHHMMtoUTC(yyyyMmDd: string, hhmm: string): Date {
  const dt = DateTime.fromFormat(`${yyyyMmDd} ${hhmm}`, 'yyyy-MM-dd HH:mm', { zone: IST_ZONE });
  if (!dt.isValid) throw new Error(`Invalid date/time: ${yyyyMmDd} ${hhmm}: ${dt.invalidReason}`);
  return dt.toUTC().toJSDate();
}

/** True when the bar START timestamp falls in [09:15, 15:30) IST. */
export function isMarketHoursIST(d: Date): boolean {
  const ist = DateTime.fromJSDate(d, { zone: 'utc' }).setZone(IST_ZONE);
  const minutes = ist.hour * 60 + ist.minute;
  const open = 9 * 60 + 15;
  const close = 15 * 60 + 30; // bar starts at exactly 15:30 are out
  return minutes >= open && minutes < close;
}

/** True iff the bar's IST HH:mm equals `hhmm` (e.g. "15:15"). */
export function isSquareoffBarIST(d: Date, hhmm: string): boolean {
  return toIST(d, 'HH:mm') === hhmm;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/util/time.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/util/time.ts src/util/time.test.ts
git commit -m "feat(util): IST time helpers and market-hours predicate"
```

---

## Task 4: Logger util

**Files:**
- Create: `src/util/logger.ts`
- Test: `src/util/logger.test.ts`

- [ ] **Step 1: Write the failing test**

`src/util/logger.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createLogger, makeRunId } from './logger';

describe('logger', () => {
  it('createLogger returns a pino logger with bound runId', () => {
    const log = createLogger({ runId: 'test-run', level: 'info' });
    expect(typeof log.info).toBe('function');
    expect(typeof log.error).toBe('function');
    expect((log.bindings() as { runId?: string }).runId).toBe('test-run');
  });

  it('makeRunId formats as YYYYMMDD-HHMMSS-<tag>', () => {
    const id = makeRunId('SmaCrossover', new Date('2025-04-30T07:08:09Z'));
    expect(id).toMatch(/^\d{8}-\d{6}-SmaCrossover$/);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/util/logger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/util/logger.ts`:

```ts
import pino, { type Logger, type LoggerOptions } from 'pino';

export interface CreateLoggerOpts {
  runId: string;
  level?: LoggerOptions['level'];
  destination?: NodeJS.WritableStream;
}

export function createLogger({ runId, level = 'info', destination }: CreateLoggerOpts): Logger {
  const opts: LoggerOptions = { level, base: { runId } };
  return destination ? pino(opts, destination) : pino(opts);
}

export function makeRunId(tag: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = now.getUTCFullYear();
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const HH = pad(now.getUTCHours());
  const MM = pad(now.getUTCMinutes());
  const SS = pad(now.getUTCSeconds());
  return `${yyyy}${mm}${dd}-${HH}${MM}${SS}-${tag}`;
}

export type { Logger };
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm test src/util/logger.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/util/logger.ts src/util/logger.test.ts
git commit -m "feat(util): pino logger factory and run-id helper"
```

---

## Task 5: Run-config schema and loader

**Files:**
- Create: `src/types/run-config.ts`
- Test: `src/types/run-config.test.ts`
- Create: `run-configs/sma-crossover-reliance.yaml`

- [ ] **Step 1: Write the failing test**

`src/types/run-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunConfig, RunConfigSchema } from './run-config';

const tmp = mkdtempSync(join(tmpdir(), 'rc-'));

function writeYaml(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content);
  return p;
}

describe('RunConfigSchema', () => {
  it('parses a valid config', () => {
    const cfg = RunConfigSchema.parse({
      strategy: 'SmaCrossover',
      params: { fast: 9, slow: 21 },
      symbols: ['RELIANCE'],
      from: '2025-01-01',
      to: '2025-01-31',
      interval: '5minute',
      capital: 100000,
      slippage_bps: 5,
      brokerage: 'zerodha-intraday',
      warmup_bars: 200,
      squareoff_time: '15:15',
      seed: 42,
    });
    expect(cfg.strategy).toBe('SmaCrossover');
    expect(cfg.symbols).toEqual(['RELIANCE']);
  });

  it('applies defaults for warmup_bars and squareoff_time', () => {
    const cfg = RunConfigSchema.parse({
      strategy: 'SmaCrossover',
      params: {},
      symbols: ['INFY'],
      from: '2025-01-01',
      to: '2025-01-31',
      interval: '5minute',
      capital: 100000,
      slippage_bps: 5,
      brokerage: 'zerodha-intraday',
      seed: 1,
    });
    expect(cfg.warmup_bars).toBe(200);
    expect(cfg.squareoff_time).toBe('15:15');
  });

  it('rejects from > to', () => {
    expect(() =>
      RunConfigSchema.parse({
        strategy: 'X',
        params: {},
        symbols: ['A'],
        from: '2025-02-01',
        to: '2025-01-01',
        interval: '5minute',
        capital: 100000,
        slippage_bps: 0,
        brokerage: 'zerodha-intraday',
        seed: 0,
      }),
    ).toThrow(/from/);
  });

  it('rejects empty symbols', () => {
    expect(() =>
      RunConfigSchema.parse({
        strategy: 'X',
        params: {},
        symbols: [],
        from: '2025-01-01',
        to: '2025-01-31',
        interval: '5minute',
        capital: 100000,
        slippage_bps: 0,
        brokerage: 'zerodha-intraday',
        seed: 0,
      }),
    ).toThrow();
  });
});

describe('loadRunConfig', () => {
  it('loads YAML and validates', () => {
    const p = writeYaml(
      'good.yaml',
      [
        'strategy: SmaCrossover',
        'params: { fast: 9, slow: 21 }',
        'symbols: [RELIANCE]',
        'from: 2025-01-01',
        'to: 2025-01-31',
        'interval: 5minute',
        'capital: 100000',
        'slippage_bps: 5',
        'brokerage: zerodha-intraday',
        'seed: 42',
      ].join('\n'),
    );
    const cfg = loadRunConfig(p);
    expect(cfg.strategy).toBe('SmaCrossover');
    expect(cfg.symbols).toEqual(['RELIANCE']);
    expect(cfg.warmup_bars).toBe(200);
  });

  it('throws with field path on invalid YAML', () => {
    const p = writeYaml(
      'bad.yaml',
      [
        'strategy: SmaCrossover',
        'params: {}',
        'symbols: []',
        'from: 2025-01-01',
        'to: 2025-01-31',
        'interval: 5minute',
        'capital: 100000',
        'slippage_bps: 5',
        'brokerage: zerodha-intraday',
        'seed: 0',
      ].join('\n'),
    );
    expect(() => loadRunConfig(p)).toThrow(/symbols/);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/types/run-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/types/run-config.ts`:

```ts
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const intervalEnum = z.enum(['1minute', '3minute', '5minute', '10minute', '15minute', '30minute', '60minute', 'day']);
const brokerageEnum = z.enum(['zerodha-intraday', 'zero']);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const hhmmStr = z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:mm');

export const RunConfigSchema = z
  .object({
    strategy: z.string().min(1),
    params: z.record(z.unknown()),
    symbols: z.array(z.string().min(1)).min(1, 'at least one symbol required'),
    from: dateStr,
    to: dateStr,
    interval: intervalEnum,
    capital: z.number().positive(),
    slippage_bps: z.number().min(0).max(1000),
    brokerage: brokerageEnum,
    warmup_bars: z.number().int().min(0).default(200),
    squareoff_time: hhmmStr.default('15:15'),
    seed: z.number().int().nonnegative(),
  })
  .refine((cfg) => cfg.from <= cfg.to, { message: 'from must be <= to', path: ['from'] });

export type RunConfig = z.infer<typeof RunConfigSchema>;

export function loadRunConfig(path: string): RunConfig {
  const text = readFileSync(path, 'utf8');
  const raw = parseYaml(text) as unknown;
  return RunConfigSchema.parse(raw);
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm test src/types/run-config.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Create run-configs/sma-crossover-reliance.yaml**

```yaml
strategy: SmaCrossover
params:
  fast: 9
  slow: 21
symbols: [RELIANCE]
from: 2025-01-01
to: 2025-01-31
interval: 5minute
capital: 100000
slippage_bps: 5
brokerage: zerodha-intraday
warmup_bars: 200
squareoff_time: "15:15"
seed: 42
```

- [ ] **Step 6: Commit**

```bash
git add src/types/run-config.ts src/types/run-config.test.ts run-configs
git commit -m "feat(config): zod-validated run config schema and YAML loader"
```

---

## Task 6: Env loader

**Files:**
- Create: `src/config/env.ts`
- Test: `src/config/env.test.ts`

- [ ] **Step 1: Write the failing test**

`src/config/env.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseEnv } from './env';

describe('parseEnv', () => {
  it('parses valid env', () => {
    const env = parseEnv({
      KITE_API_KEY: 'k',
      KITE_API_SECRET: 's',
      KITE_ACCESS_TOKEN: 'tok',
      LOG_LEVEL: 'debug',
    });
    expect(env.KITE_API_KEY).toBe('k');
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('defaults LOG_LEVEL to info', () => {
    const env = parseEnv({
      KITE_API_KEY: 'k',
      KITE_API_SECRET: 's',
      KITE_ACCESS_TOKEN: 'tok',
    });
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('throws when KITE_API_KEY missing', () => {
    expect(() =>
      parseEnv({ KITE_API_SECRET: 's', KITE_ACCESS_TOKEN: 't' }),
    ).toThrow(/KITE_API_KEY/);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/config/env.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/config/env.ts`:

```ts
import { z } from 'zod';

export const EnvSchema = z.object({
  KITE_API_KEY: z.string().min(1),
  KITE_API_SECRET: z.string().min(1),
  KITE_ACCESS_TOKEN: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(raw);
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm test src/config/env.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/config
git commit -m "feat(config): zod-validated env loader"
```

---

## Task 7: Indicator wrappers (registry + SMA + EMA)

**Files:**
- Create: `src/indicators/sma.ts`
- Create: `src/indicators/ema.ts`
- Create: `src/indicators/registry.ts`
- Test: `src/indicators/indicators.test.ts`

- [ ] **Step 1: Write failing tests for SMA**

`src/indicators/indicators.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SMA } from './sma';
import { EMA } from './ema';
import { IndicatorRegistry } from './registry';

describe('SMA', () => {
  it('returns undefined while warming up, then arithmetic mean', () => {
    const sma = new SMA(3);
    expect(sma.update(10)).toBeUndefined();
    expect(sma.update(20)).toBeUndefined();
    expect(sma.update(30)).toBe(20); // (10+20+30)/3
    expect(sma.update(40)).toBe(30); // (20+30+40)/3
    expect(sma.update(50)).toBe(40); // (30+40+50)/3
  });

  it('rejects non-positive period', () => {
    expect(() => new SMA(0)).toThrow();
    expect(() => new SMA(-1)).toThrow();
  });

  it('exposes current value', () => {
    const sma = new SMA(2);
    sma.update(10);
    sma.update(20);
    expect(sma.value).toBe(15);
  });
});

describe('EMA', () => {
  it('returns first SMA-of-period at warmup boundary, then EMA recurrence', () => {
    const ema = new EMA(3);
    expect(ema.update(10)).toBeUndefined();
    expect(ema.update(20)).toBeUndefined();
    const v0 = ema.update(30); // seed = (10+20+30)/3 = 20
    expect(v0).toBe(20);
    // alpha = 2/(period+1) = 0.5
    // next: 0.5*40 + 0.5*20 = 30
    expect(ema.update(40)).toBe(30);
    // next: 0.5*50 + 0.5*30 = 40
    expect(ema.update(50)).toBe(40);
  });
});

describe('IndicatorRegistry', () => {
  it('registers and retrieves indicators by symbol+key', () => {
    const reg = new IndicatorRegistry();
    const sma = new SMA(5);
    reg.register('RELIANCE', 'sma_fast', sma);
    expect(reg.get('RELIANCE', 'sma_fast')).toBe(sma);
    expect(reg.get('RELIANCE', 'missing')).toBeUndefined();
  });

  it('feeds the close price into all indicators registered for a symbol', () => {
    const reg = new IndicatorRegistry();
    const fast = new SMA(2);
    const slow = new SMA(3);
    reg.register('R', 'fast', fast);
    reg.register('R', 'slow', slow);
    reg.feedClose('R', 10);
    reg.feedClose('R', 20);
    reg.feedClose('R', 30);
    expect(fast.value).toBe(25); // (20+30)/2
    expect(slow.value).toBe(20); // (10+20+30)/3
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `pnpm test src/indicators/indicators.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement SMA**

`src/indicators/sma.ts`:

```ts
export class SMA {
  private readonly buf: number[] = [];
  private sum = 0;
  private cur: number | undefined;

  constructor(private readonly period: number) {
    if (period <= 0 || !Number.isInteger(period)) {
      throw new Error(`SMA period must be a positive integer, got ${period}`);
    }
  }

  update(price: number): number | undefined {
    this.buf.push(price);
    this.sum += price;
    if (this.buf.length > this.period) {
      this.sum -= this.buf.shift()!;
    }
    if (this.buf.length < this.period) {
      this.cur = undefined;
      return undefined;
    }
    this.cur = this.sum / this.period;
    return this.cur;
  }

  get value(): number | undefined {
    return this.cur;
  }
}
```

- [ ] **Step 4: Implement EMA**

`src/indicators/ema.ts`:

```ts
export class EMA {
  private readonly seedBuf: number[] = [];
  private readonly alpha: number;
  private cur: number | undefined;

  constructor(private readonly period: number) {
    if (period <= 0 || !Number.isInteger(period)) {
      throw new Error(`EMA period must be a positive integer, got ${period}`);
    }
    this.alpha = 2 / (period + 1);
  }

  update(price: number): number | undefined {
    if (this.cur === undefined) {
      this.seedBuf.push(price);
      if (this.seedBuf.length < this.period) return undefined;
      this.cur = this.seedBuf.reduce((a, b) => a + b, 0) / this.period;
      return this.cur;
    }
    this.cur = this.alpha * price + (1 - this.alpha) * this.cur;
    return this.cur;
  }

  get value(): number | undefined {
    return this.cur;
  }
}
```

- [ ] **Step 5: Implement IndicatorRegistry**

`src/indicators/registry.ts`:

```ts
export interface Indicator {
  update(price: number): number | undefined;
  readonly value: number | undefined;
}

export class IndicatorRegistry {
  private readonly bySymbol = new Map<string, Map<string, Indicator>>();

  register(symbol: string, key: string, ind: Indicator): void {
    let m = this.bySymbol.get(symbol);
    if (!m) {
      m = new Map();
      this.bySymbol.set(symbol, m);
    }
    if (m.has(key)) throw new Error(`Indicator already registered: ${symbol}/${key}`);
    m.set(key, ind);
  }

  get(symbol: string, key: string): Indicator | undefined {
    return this.bySymbol.get(symbol)?.get(key);
  }

  feedClose(symbol: string, close: number): void {
    const m = this.bySymbol.get(symbol);
    if (!m) return;
    for (const ind of m.values()) ind.update(close);
  }
}
```

- [ ] **Step 6: Run tests, expect PASS**

Run: `pnpm test src/indicators/indicators.test.ts`
Expected: PASS, 6 tests (3 SMA + 1 EMA + 2 registry).

- [ ] **Step 7: Commit**

```bash
git add src/indicators
git commit -m "feat(indicators): SMA, EMA, and registry with rolling-update API"
```

---

## Task 8: CandleStore (DuckDB)

**Files:**
- Create: `src/data/candle-store.ts`
- Test: `src/data/candle-store.test.ts`

- [ ] **Step 1: Write failing tests**

`src/data/candle-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandleStore } from './candle-store';
import type { Candle } from '../types';

let dir: string;
let store: CandleStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cs-'));
  store = await CandleStore.open(join(dir, 'test.duckdb'));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function bar(symbol: string, ts: string, close: number, vol = 100): Candle {
  return { symbol, ts: new Date(ts), interval: '5minute', open: close, high: close, low: close, close, volume: vol };
}

describe('CandleStore', () => {
  it('upsert + query roundtrips rows in order', async () => {
    await store.upsert([
      bar('R', '2025-01-02T03:45:00Z', 100),
      bar('R', '2025-01-02T03:50:00Z', 101),
    ]);
    const rows = await store.query('R', new Date('2025-01-02T03:45:00Z'), new Date('2025-01-02T03:55:00Z'), '5minute');
    expect(rows.length).toBe(2);
    expect(rows[0]!.close).toBe(100);
    expect(rows[1]!.close).toBe(101);
  });

  it('upsert is idempotent (same key overwrites)', async () => {
    await store.upsert([bar('R', '2025-01-02T03:45:00Z', 100)]);
    await store.upsert([bar('R', '2025-01-02T03:45:00Z', 999)]);
    const rows = await store.query('R', new Date('2025-01-02T03:00:00Z'), new Date('2025-01-02T04:00:00Z'), '5minute');
    expect(rows.length).toBe(1);
    expect(rows[0]!.close).toBe(999);
  });

  it('query respects symbol + interval filters', async () => {
    await store.upsert([
      bar('R', '2025-01-02T03:45:00Z', 100),
      { ...bar('R', '2025-01-02T03:45:00Z', 7), interval: 'day' },
      bar('I', '2025-01-02T03:45:00Z', 200),
    ]);
    const r = await store.query('R', new Date('2025-01-02T03:00:00Z'), new Date('2025-01-02T04:00:00Z'), '5minute');
    expect(r.length).toBe(1);
    expect(r[0]!.symbol).toBe('R');
  });

  it('coverage tracks merged ranges', async () => {
    await store.recordCoverage('R', '5minute', new Date('2025-01-01T00:00:00Z'), new Date('2025-01-05T23:59:00Z'));
    await store.recordCoverage('R', '5minute', new Date('2025-01-06T00:00:00Z'), new Date('2025-01-10T23:59:00Z'));
    const ranges = await store.coverage('R', '5minute');
    expect(ranges.length).toBeGreaterThan(0);
    // ranges sorted ascending
    const first = ranges[0]!;
    expect(first.from.getUTCFullYear()).toBe(2025);
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `pnpm test src/data/candle-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/data/candle-store.ts`:

```ts
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { Candle, Interval } from '../types';

export interface CoverageRange {
  from: Date;
  to: Date;
}

export class CandleStore {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {}

  static async open(path: string): Promise<CandleStore> {
    const instance = await DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(`
      CREATE TABLE IF NOT EXISTS candles (
        symbol   VARCHAR  NOT NULL,
        ts       TIMESTAMP NOT NULL,
        interval VARCHAR  NOT NULL,
        open     DOUBLE   NOT NULL,
        high     DOUBLE   NOT NULL,
        low      DOUBLE   NOT NULL,
        close    DOUBLE   NOT NULL,
        volume   BIGINT   NOT NULL,
        PRIMARY KEY (symbol, ts, interval)
      );
      CREATE TABLE IF NOT EXISTS coverage (
        symbol   VARCHAR NOT NULL,
        interval VARCHAR NOT NULL,
        from_ts  TIMESTAMP NOT NULL,
        to_ts    TIMESTAMP NOT NULL,
        PRIMARY KEY (symbol, interval, from_ts)
      );
    `);
    return new CandleStore(instance, conn);
  }

  async close(): Promise<void> {
    this.conn.closeSync();
    this.instance.closeSync();
  }

  async upsert(rows: Candle[]): Promise<void> {
    if (rows.length === 0) return;
    const stmt = await this.conn.prepare(`
      INSERT INTO candles (symbol, ts, interval, open, high, low, close, volume)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (symbol, ts, interval) DO UPDATE SET
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume
    `);
    try {
      for (const r of rows) {
        stmt.bind([r.symbol, r.ts, r.interval, r.open, r.high, r.low, r.close, BigInt(r.volume)]);
        await stmt.run();
      }
    } finally {
      stmt.destroySync();
    }
  }

  async query(symbol: string, from: Date, to: Date, interval: Interval): Promise<Candle[]> {
    const stmt = await this.conn.prepare(
      `SELECT symbol, ts, interval, open, high, low, close, volume
       FROM candles
       WHERE symbol = $1 AND interval = $2 AND ts >= $3 AND ts < $4
       ORDER BY ts ASC`,
    );
    try {
      stmt.bind([symbol, interval, from, to]);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects() as Array<{
        symbol: string;
        ts: Date;
        interval: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: bigint | number;
      }>;
      return rows.map((r) => ({
        symbol: r.symbol,
        ts: r.ts,
        interval: r.interval as Interval,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: typeof r.volume === 'bigint' ? Number(r.volume) : r.volume,
      }));
    } finally {
      stmt.destroySync();
    }
  }

  async recordCoverage(symbol: string, interval: Interval, from: Date, to: Date): Promise<void> {
    const stmt = await this.conn.prepare(
      `INSERT INTO coverage (symbol, interval, from_ts, to_ts)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (symbol, interval, from_ts) DO UPDATE SET to_ts = EXCLUDED.to_ts`,
    );
    try {
      stmt.bind([symbol, interval, from, to]);
      await stmt.run();
    } finally {
      stmt.destroySync();
    }
  }

  async coverage(symbol: string, interval: Interval): Promise<CoverageRange[]> {
    const stmt = await this.conn.prepare(
      `SELECT from_ts, to_ts FROM coverage WHERE symbol = $1 AND interval = $2 ORDER BY from_ts ASC`,
    );
    try {
      stmt.bind([symbol, interval]);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects() as Array<{ from_ts: Date; to_ts: Date }>;
      return rows.map((r) => ({ from: r.from_ts, to: r.to_ts }));
    } finally {
      stmt.destroySync();
    }
  }
}
```

> **Note:** Parameterized reads use `connection.prepare` + `runAndReadAll`. Plain `connection.runAndReadAll(sql)` does not accept params in the Neo API.

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test src/data/candle-store.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data/candle-store.ts src/data/candle-store.test.ts
git commit -m "feat(data): DuckDB-backed CandleStore with idempotent upsert and coverage tracking"
```

---

## Task 9: KiteClient

**Files:**
- Create: `src/data/kite-client.ts`
- Test: `src/data/kite-client.test.ts`

- [ ] **Step 1: Write failing tests (with mocked SDK)**

`src/data/kite-client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { KiteClient } from './kite-client';
import type { Candle } from '../types';

class FakeKite {
  calls: Array<{ token: number; interval: string; from: Date; to: Date }> = [];
  failuresFirst = 0;
  constructor(private readonly responses: Array<Array<Record<string, unknown>>>) {}
  async getHistoricalData(token: number, interval: string, from: Date, to: Date): Promise<unknown[]> {
    this.calls.push({ token, interval, from, to });
    if (this.failuresFirst > 0) {
      this.failuresFirst -= 1;
      const err = new Error('429 too many') as Error & { status?: number };
      err.status = 429;
      throw err;
    }
    return this.responses[this.calls.length - 1] ?? [];
  }
}

const SAMPLE = [
  { date: new Date('2025-01-02T03:45:00Z'), open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
  { date: new Date('2025-01-02T03:50:00Z'), open: 100.5, high: 102, low: 100, close: 101.5, volume: 1500 },
];

describe('KiteClient', () => {
  it('chunks date range and concatenates results', async () => {
    const fake = new FakeKite([SAMPLE, SAMPLE]);
    const client = new KiteClient({ kite: fake as never, chunkDays: 30 });
    const candles: Candle[] = await client.getHistorical({
      symbol: 'RELIANCE',
      instrumentToken: 738561,
      interval: '5minute',
      from: new Date('2025-01-01T00:00:00Z'),
      to: new Date('2025-02-15T00:00:00Z'), // > 30 days, forces 2 chunks
    });
    expect(fake.calls.length).toBe(2);
    expect(candles.length).toBe(4);
    expect(candles[0]!.symbol).toBe('RELIANCE');
    expect(candles[0]!.interval).toBe('5minute');
  });

  it('retries on 429 with backoff (mocked sleep)', async () => {
    const fake = new FakeKite([SAMPLE]);
    fake.failuresFirst = 2;
    const sleeps: number[] = [];
    const client = new KiteClient({
      kite: fake as never,
      chunkDays: 60,
      maxRetries: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const candles = await client.getHistorical({
      symbol: 'RELIANCE',
      instrumentToken: 738561,
      interval: '5minute',
      from: new Date('2025-01-01T00:00:00Z'),
      to: new Date('2025-01-05T00:00:00Z'),
    });
    expect(candles.length).toBe(2);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('fails after max retries', async () => {
    const fake = new FakeKite([SAMPLE]);
    fake.failuresFirst = 5;
    const client = new KiteClient({
      kite: fake as never,
      chunkDays: 60,
      maxRetries: 2,
      sleep: async () => {},
    });
    await expect(
      client.getHistorical({
        symbol: 'X',
        instrumentToken: 1,
        interval: '5minute',
        from: new Date('2025-01-01T00:00:00Z'),
        to: new Date('2025-01-05T00:00:00Z'),
      }),
    ).rejects.toThrow(/429|retry/i);
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `pnpm test src/data/kite-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/data/kite-client.ts`:

```ts
import type { Candle, Interval } from '../types';

export interface KiteSdkLike {
  getHistoricalData(
    instrumentToken: number,
    interval: string,
    fromDate: Date,
    toDate: Date,
    continuous?: boolean,
    oi?: boolean,
  ): Promise<unknown[]>;
}

export interface KiteClientOpts {
  kite: KiteSdkLike;
  chunkDays?: number;          // default 60 (Kite's minute-data window)
  maxRetries?: number;         // default 5
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchHistoricalArgs {
  symbol: string;              // tradingsymbol used to label returned candles
  instrumentToken: number;     // Kite instrument token (resolve via InstrumentStore)
  interval: Interval;
  from: Date;
  to: Date;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class KiteClient {
  private readonly kite: KiteSdkLike;
  private readonly chunkDays: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: KiteClientOpts) {
    this.kite = opts.kite;
    this.chunkDays = opts.chunkDays ?? 60;
    this.maxRetries = opts.maxRetries ?? 5;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async getHistorical(args: FetchHistoricalArgs): Promise<Candle[]> {
    const { symbol, instrumentToken, interval, from, to } = args;
    const out: Candle[] = [];
    for (const [chunkFrom, chunkTo] of this.chunks(from, to)) {
      const raw = await this.fetchOnce(instrumentToken, interval, chunkFrom, chunkTo);
      for (const r of raw) {
        const row = r as { date: Date; open: number; high: number; low: number; close: number; volume: number };
        out.push({
          symbol,
          ts: row.date instanceof Date ? row.date : new Date(row.date),
          interval,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
        });
      }
    }
    return out;
  }

  private *chunks(from: Date, to: Date): IterableIterator<[Date, Date]> {
    const stepMs = this.chunkDays * 24 * 60 * 60 * 1000;
    let cursor = from.getTime();
    const end = to.getTime();
    while (cursor < end) {
      const next = Math.min(cursor + stepMs, end);
      yield [new Date(cursor), new Date(next)];
      cursor = next;
    }
  }

  private async fetchOnce(token: number, interval: Interval, from: Date, to: Date): Promise<unknown[]> {
    let attempt = 0;
    while (true) {
      try {
        return await this.kite.getHistoricalData(token, interval, from, to);
      } catch (err) {
        const status = (err as { status?: number }).status;
        const retriable = status === 429 || status === 502 || status === 503 || status === 504 || /timeout|ECONN|ETIMEDOUT/i.test(String(err));
        if (!retriable || attempt >= this.maxRetries) {
          throw err;
        }
        const delay = 1000 * Math.pow(2, attempt);
        await this.sleep(delay);
        attempt += 1;
      }
    }
  }
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test src/data/kite-client.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data/kite-client.ts src/data/kite-client.test.ts
git commit -m "feat(data): KiteClient with chunked fetch and retry-with-backoff"
```

---

## Task 10: DataLoader (cache-aware orchestrator)

**Files:**
- Create: `src/data/data-loader.ts`
- Test: `src/data/data-loader.test.ts`

- [ ] **Step 1: Write failing test**

`src/data/data-loader.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandleStore } from './candle-store';
import { DataLoader, type SymbolResolver } from './data-loader';
import type { Candle } from '../types';
import type { KiteClient } from './kite-client';

let dir: string;
let store: CandleStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dl-'));
  store = await CandleStore.open(join(dir, 'd.duckdb'));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const sampleBars = (symbol: string, fromIso: string, n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    symbol,
    ts: new Date(new Date(fromIso).getTime() + i * 5 * 60_000),
    interval: '5minute' as const,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 1000,
  }));

describe('DataLoader', () => {
  it('on cache miss fetches from Kite and upserts', async () => {
    const fetched: string[] = [];
    const fakeKite = {
      async getHistorical(args: { symbol: string; instrumentToken: number; from: Date; to: Date }) {
        fetched.push(`${args.symbol}:${args.from.toISOString()}->${args.to.toISOString()}`);
        return sampleBars(args.symbol, '2025-01-02T03:45:00Z', 5);
      },
    } as unknown as KiteClient;
    const resolver: SymbolResolver = async (s) => ({ tradingsymbol: s, instrumentToken: 100 });
    const loader = new DataLoader({ kite: fakeKite, store, resolveSymbol: resolver });
    const rows = await loader.load('R', new Date('2025-01-02T03:00:00Z'), new Date('2025-01-02T05:00:00Z'), '5minute');
    expect(rows.length).toBeGreaterThan(0);
    expect(fetched.length).toBe(1);
    // re-load: cache hit, no fetch
    fetched.length = 0;
    const rows2 = await loader.load('R', new Date('2025-01-02T03:00:00Z'), new Date('2025-01-02T05:00:00Z'), '5minute');
    expect(rows2.length).toBe(rows.length);
    expect(fetched).toEqual([]);
  });

  it('on partial coverage fetches only the missing range', async () => {
    const fetched: Array<{ from: Date; to: Date }> = [];
    const fakeKite = {
      async getHistorical(args: { symbol: string; instrumentToken: number; from: Date; to: Date }) {
        fetched.push({ from: args.from, to: args.to });
        return sampleBars(args.symbol, args.from.toISOString(), 2);
      },
    } as unknown as KiteClient;
    const resolver: SymbolResolver = async (s) => ({ tradingsymbol: s, instrumentToken: 1 });
    const loader = new DataLoader({ kite: fakeKite, store, resolveSymbol: resolver });
    // First load covers [03:00, 04:00)
    await loader.load('R', new Date('2025-01-02T03:00:00Z'), new Date('2025-01-02T04:00:00Z'), '5minute');
    fetched.length = 0;
    // Second load extends to [03:00, 05:00) — should fetch only [04:00, 05:00)
    await loader.load('R', new Date('2025-01-02T03:00:00Z'), new Date('2025-01-02T05:00:00Z'), '5minute');
    expect(fetched.length).toBe(1);
    expect(fetched[0]!.from.toISOString()).toBe('2025-01-02T04:00:00.000Z');
    expect(fetched[0]!.to.toISOString()).toBe('2025-01-02T05:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/data/data-loader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/data/data-loader.ts`:

```ts
import type { Candle, Interval } from '../types';
import type { CandleStore, CoverageRange } from './candle-store';
import type { KiteClient } from './kite-client';

export type SymbolResolver = (symbol: string) => Promise<{ tradingsymbol: string; instrumentToken: number }>;

export interface DataLoaderOpts {
  kite: KiteClient;
  store: CandleStore;
  resolveSymbol: SymbolResolver;
}

export class DataLoader {
  constructor(private readonly opts: DataLoaderOpts) {}

  async load(symbol: string, from: Date, to: Date, interval: Interval): Promise<Candle[]> {
    const cov = await this.opts.store.coverage(symbol, interval);
    const missing = subtractCoverage({ from, to }, cov);
    if (missing.length > 0) {
      const { instrumentToken } = await this.opts.resolveSymbol(symbol);
      for (const m of missing) {
        const fetched = await this.opts.kite.getHistorical({
          symbol,
          instrumentToken,
          interval,
          from: m.from,
          to: m.to,
        });
        if (fetched.length > 0) {
          await this.opts.store.upsert(fetched);
        }
        await this.opts.store.recordCoverage(symbol, interval, m.from, m.to);
      }
    }
    return this.opts.store.query(symbol, from, to, interval);
  }
}

/** Subtract a list of covered ranges from a target range. Coverage need not be sorted/merged. */
export function subtractCoverage(target: CoverageRange, covered: CoverageRange[]): CoverageRange[] {
  // Merge overlapping covered ranges first
  const merged: CoverageRange[] = [];
  for (const r of [...covered].sort((a, b) => a.from.getTime() - b.from.getTime())) {
    const last = merged[merged.length - 1];
    if (last && r.from.getTime() <= last.to.getTime()) {
      if (r.to.getTime() > last.to.getTime()) last.to = r.to;
    } else {
      merged.push({ from: r.from, to: r.to });
    }
  }
  // Subtract
  const out: CoverageRange[] = [];
  let cursor = target.from.getTime();
  const end = target.to.getTime();
  for (const r of merged) {
    const rFrom = r.from.getTime();
    const rTo = r.to.getTime();
    if (rTo <= cursor) continue;
    if (rFrom >= end) break;
    if (rFrom > cursor) out.push({ from: new Date(cursor), to: new Date(Math.min(rFrom, end)) });
    cursor = Math.max(cursor, rTo);
    if (cursor >= end) break;
  }
  if (cursor < end) out.push({ from: new Date(cursor), to: new Date(end) });
  return out;
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm test src/data/data-loader.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data/data-loader.ts src/data/data-loader.test.ts
git commit -m "feat(data): cache-aware DataLoader orchestrating Kite + CandleStore"
```

---

## Task 11: InstrumentStore (symbol → instrument_token)

**Files:**
- Create: `src/data/instrument-store.ts`
- Test: `src/data/instrument-store.test.ts`

- [ ] **Step 1: Write failing test**

`src/data/instrument-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstrumentStore } from './instrument-store';

let dir: string;
let store: InstrumentStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'is-'));
  store = await InstrumentStore.open(join(dir, 'i.duckdb'));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('InstrumentStore', () => {
  it('upserts instruments and resolves symbol to token', async () => {
    await store.upsert([
      { instrumentToken: 738561, tradingsymbol: 'RELIANCE', exchange: 'NSE', segment: 'NSE', instrumentType: 'EQ' },
      { instrumentToken: 408065, tradingsymbol: 'INFY', exchange: 'NSE', segment: 'NSE', instrumentType: 'EQ' },
    ]);
    const r = await store.resolve('RELIANCE', 'NSE');
    expect(r).toEqual({ tradingsymbol: 'RELIANCE', instrumentToken: 738561 });
  });

  it('returns null when symbol not found', async () => {
    const r = await store.resolve('NOPE', 'NSE');
    expect(r).toBeNull();
  });

  it('upsert is idempotent', async () => {
    await store.upsert([{ instrumentToken: 1, tradingsymbol: 'A', exchange: 'NSE', segment: 'NSE', instrumentType: 'EQ' }]);
    await store.upsert([{ instrumentToken: 1, tradingsymbol: 'A', exchange: 'NSE', segment: 'NSE', instrumentType: 'EQ' }]);
    const r = await store.resolve('A', 'NSE');
    expect(r).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/data/instrument-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/data/instrument-store.ts`:

```ts
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

export interface Instrument {
  instrumentToken: number;
  tradingsymbol: string;
  exchange: string;       // 'NSE' | 'BSE' | 'NFO' etc.
  segment: string;
  instrumentType: string; // 'EQ' | 'FUT' | ...
}

export class InstrumentStore {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {}

  static async open(path: string): Promise<InstrumentStore> {
    const instance = await DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(`
      CREATE TABLE IF NOT EXISTS instruments (
        instrument_token BIGINT NOT NULL,
        tradingsymbol VARCHAR NOT NULL,
        exchange VARCHAR NOT NULL,
        segment VARCHAR,
        instrument_type VARCHAR,
        PRIMARY KEY (instrument_token, exchange)
      );
      CREATE INDEX IF NOT EXISTS idx_instruments_lookup ON instruments(tradingsymbol, exchange);
    `);
    return new InstrumentStore(instance, conn);
  }

  async close(): Promise<void> {
    this.conn.closeSync();
    this.instance.closeSync();
  }

  async upsert(rows: Instrument[]): Promise<void> {
    if (rows.length === 0) return;
    const stmt = await this.conn.prepare(`
      INSERT INTO instruments (instrument_token, tradingsymbol, exchange, segment, instrument_type)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (instrument_token, exchange) DO UPDATE SET
        tradingsymbol = EXCLUDED.tradingsymbol,
        segment = EXCLUDED.segment,
        instrument_type = EXCLUDED.instrument_type
    `);
    try {
      for (const r of rows) {
        stmt.bind([BigInt(r.instrumentToken), r.tradingsymbol, r.exchange, r.segment, r.instrumentType]);
        await stmt.run();
      }
    } finally {
      stmt.destroySync();
    }
  }

  async resolve(tradingsymbol: string, exchange = 'NSE'): Promise<{ tradingsymbol: string; instrumentToken: number } | null> {
    const stmt = await this.conn.prepare(
      `SELECT instrument_token FROM instruments WHERE tradingsymbol = $1 AND exchange = $2 LIMIT 1`,
    );
    try {
      stmt.bind([tradingsymbol, exchange]);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects() as Array<{ instrument_token: bigint | number }>;
      if (rows.length === 0) return null;
      const tok = rows[0]!.instrument_token;
      return { tradingsymbol, instrumentToken: typeof tok === 'bigint' ? Number(tok) : tok };
    } finally {
      stmt.destroySync();
    }
  }
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm test src/data/instrument-store.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data/instrument-store.ts src/data/instrument-store.test.ts
git commit -m "feat(data): InstrumentStore for symbol → instrument_token resolution"
```

---

## Task 12: Portfolio (cash, positions, mark-to-market)

**Files:**
- Create: `src/engine/portfolio.ts`
- Test: `src/engine/portfolio.test.ts`

- [ ] **Step 1: Write failing test**

`src/engine/portfolio.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Portfolio } from './portfolio';
import { OrderSide, type Fill, type Fees } from '../types';

const fees0: Fees = { brokerage: 0, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 0 };
const fee = (n: number): Fees => ({ ...fees0, brokerage: n, total: n });

const fill = (side: 'buy' | 'sell', qty: number, price: number, fees: Fees = fees0): Fill => ({
  orderId: 'o',
  symbol: 'R',
  side: side === 'buy' ? OrderSide.BUY : OrderSide.SELL,
  qty,
  price,
  ts: new Date('2025-01-02T03:50:00Z'),
  fees,
});

describe('Portfolio', () => {
  it('starts with capital and no positions', () => {
    const p = new Portfolio(100_000);
    expect(p.cash).toBe(100_000);
    expect(p.positions().length).toBe(0);
    expect(p.realizedPnL).toBe(0);
  });

  it('buy debits cash and creates a long position', () => {
    const p = new Portfolio(100_000);
    p.applyFill(fill('buy', 10, 100, fee(20)));
    expect(p.cash).toBe(100_000 - 1000 - 20);
    const pos = p.positions()[0]!;
    expect(pos).toEqual({ symbol: 'R', qty: 10, avgPrice: 100 });
  });

  it('partial sell realizes PnL proportional to qty closed', () => {
    const p = new Portfolio(100_000);
    p.applyFill(fill('buy', 10, 100, fee(20)));
    p.applyFill(fill('sell', 6, 110, fee(15)));
    // realized: 6 * (110 - 100) = 60, minus fees on both legs proportional? We charge total fees as cash debit each fill, and report realized as gross-of-entry-fees-but-net-of-exit-fees.
    // Convention here: realizedPnL = price diff × qty − sell fees − (proportional buy fees)
    expect(p.cash).toBeCloseTo(100_000 - 1000 - 20 + 660 - 15);
    const pos = p.positions()[0]!;
    expect(pos.qty).toBe(4);
    expect(pos.avgPrice).toBe(100);
  });

  it('full close removes position and accumulates realizedPnL', () => {
    const p = new Portfolio(100_000);
    p.applyFill(fill('buy', 10, 100));
    p.applyFill(fill('sell', 10, 110));
    expect(p.positions().length).toBe(0);
    expect(p.realizedPnL).toBeCloseTo(100); // 10 * (110 - 100)
  });

  it('markToMarket computes unrealized using prices map', () => {
    const p = new Portfolio(100_000);
    p.applyFill(fill('buy', 10, 100));
    p.markToMarket(new Map([['R', 105]]), new Date('2025-01-02T04:00:00Z'));
    const snap = p.equityCurve()[p.equityCurve().length - 1]!;
    expect(snap.unrealized).toBeCloseTo(50);
    expect(snap.equity).toBeCloseTo(p.cash + 50 + p.realizedPnL);
  });

  it('rejects sell of qty exceeding position (caller should pre-check)', () => {
    const p = new Portfolio(100_000);
    p.applyFill(fill('buy', 5, 100));
    expect(() => p.applyFill(fill('sell', 10, 110))).toThrow(/insufficient/i);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/engine/portfolio.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/engine/portfolio.ts`:

```ts
import { OrderSide, type EquitySnapshot, type Fill, type Position } from '../types';

export class Portfolio {
  private _cash: number;
  private _realized = 0;
  private readonly _positions = new Map<string, Position>();
  private readonly _equity: EquitySnapshot[] = [];

  constructor(initialCapital: number) {
    if (initialCapital <= 0) throw new Error('initialCapital must be > 0');
    this._cash = initialCapital;
  }

  get cash(): number {
    return this._cash;
  }

  get realizedPnL(): number {
    return this._realized;
  }

  positions(): Position[] {
    return Array.from(this._positions.values());
  }

  position(symbol: string): Position | null {
    return this._positions.get(symbol) ?? null;
  }

  equityCurve(): EquitySnapshot[] {
    return this._equity;
  }

  applyFill(fill: Fill): void {
    const notional = fill.qty * fill.price;
    const fees = fill.fees.total;
    const pos = this._positions.get(fill.symbol);
    if (fill.side === OrderSide.BUY) {
      this._cash -= notional + fees;
      if (!pos) {
        this._positions.set(fill.symbol, { symbol: fill.symbol, qty: fill.qty, avgPrice: fill.price });
      } else {
        const newQty = pos.qty + fill.qty;
        const newAvg = (pos.qty * pos.avgPrice + fill.qty * fill.price) / newQty;
        pos.qty = newQty;
        pos.avgPrice = newAvg;
      }
    } else {
      // SELL
      if (!pos || pos.qty < fill.qty) {
        throw new Error(`insufficient position to sell ${fill.qty} of ${fill.symbol} (have ${pos?.qty ?? 0})`);
      }
      this._cash += notional - fees;
      const realized = (fill.price - pos.avgPrice) * fill.qty - fees;
      this._realized += realized;
      pos.qty -= fill.qty;
      if (pos.qty === 0) this._positions.delete(fill.symbol);
    }
  }

  markToMarket(prices: Map<string, number>, ts: Date): EquitySnapshot {
    let unrealized = 0;
    for (const p of this._positions.values()) {
      const px = prices.get(p.symbol);
      if (px === undefined) continue;
      unrealized += (px - p.avgPrice) * p.qty;
    }
    const snap: EquitySnapshot = {
      ts,
      cash: this._cash,
      unrealized,
      realized: this._realized,
      equity: this._cash + unrealized + this._realized,
    };
    this._equity.push(snap);
    return snap;
  }
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm test src/engine/portfolio.test.ts`
Expected: PASS, 6 tests.

> **Note:** the partial-sell test asserts `cash = 100_000 - 1000 - 20 + 660 - 15`. Verify your impl produces this: buy 10@100 with ₹20 fees → cash 98980; sell 6@110 with ₹15 fees → cash 98980 + 660 − 15 = 99625. The realized PnL accumulator should be 60 − 15 = 45 (sell fees only counted in realized; buy fees were already debited).

- [ ] **Step 5: Commit**

```bash
git add src/engine/portfolio.ts src/engine/portfolio.test.ts
git commit -m "feat(engine): Portfolio with cash + positions + mark-to-market + equity curve"
```

---

## Task 13: Brokerage model — Zerodha intraday

**Files:**
- Create: `src/engine/brokerage/zerodha-intraday.ts`
- Test: `src/engine/brokerage/zerodha-intraday.test.ts`

- [ ] **Step 1: Write failing test**

`src/engine/brokerage/zerodha-intraday.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { zerodhaIntraday } from './zerodha-intraday';
import { OrderSide } from '../../types';

describe('zerodhaIntraday', () => {
  it('caps brokerage at ₹20 per executed order', () => {
    const fees = zerodhaIntraday({ side: OrderSide.BUY, qty: 1000, price: 1000 });
    expect(fees.brokerage).toBe(20); // 0.03% × 1_000_000 = 300, capped to 20
  });

  it('uses 0.03% when below cap', () => {
    const fees = zerodhaIntraday({ side: OrderSide.BUY, qty: 10, price: 100 }); // turnover 1000
    expect(fees.brokerage).toBeCloseTo(0.3);
  });

  it('STT applies only to sell side at 0.025% turnover', () => {
    const buy = zerodhaIntraday({ side: OrderSide.BUY, qty: 10, price: 100 });
    const sell = zerodhaIntraday({ side: OrderSide.SELL, qty: 10, price: 100 });
    expect(buy.stt).toBe(0);
    expect(sell.stt).toBeCloseTo(0.25); // 0.025% × 1000 = 0.25
  });

  it('total equals sum of components', () => {
    const f = zerodhaIntraday({ side: OrderSide.SELL, qty: 1000, price: 1000 });
    const sum = f.brokerage + f.stt + f.exchange + f.gst + f.sebi + f.stampDuty;
    expect(f.total).toBeCloseTo(sum);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/engine/brokerage/zerodha-intraday.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/engine/brokerage/zerodha-intraday.ts`:

```ts
import type { Fees, OrderSide } from '../../types';
import { OrderSide as Side } from '../../types';

export interface BrokerageInput {
  side: OrderSide;
  qty: number;
  price: number;
}

export type BrokerageFn = (i: BrokerageInput) => Fees;

/**
 * Zerodha equity intraday fee schedule (NSE):
 *  - brokerage: min(0.03% of turnover, ₹20) per executed order
 *  - STT/CTT: 0.025% on sell-side turnover
 *  - Exchange txn charge (NSE): 0.00322% turnover
 *  - GST: 18% on (brokerage + exchange + SEBI)
 *  - SEBI: ₹10 per crore (= 0.0001% turnover)
 *  - Stamp duty: 0.003% on buy-side turnover
 */
export const zerodhaIntraday: BrokerageFn = ({ side, qty, price }) => {
  const turnover = qty * price;
  const brokerage = Math.min(turnover * 0.0003, 20);
  const stt = side === Side.SELL ? turnover * 0.00025 : 0;
  const exchange = turnover * 0.0000322;
  const sebi = turnover * 0.000001;
  const stampDuty = side === Side.BUY ? turnover * 0.00003 : 0;
  const gst = (brokerage + exchange + sebi) * 0.18;
  const total = brokerage + stt + exchange + gst + sebi + stampDuty;
  return { brokerage, stt, exchange, gst, sebi, stampDuty, total };
};

export const zeroBrokerage: BrokerageFn = () => ({
  brokerage: 0, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 0,
});
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm test src/engine/brokerage/zerodha-intraday.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/brokerage
git commit -m "feat(engine): Zerodha equity-intraday brokerage model with all statutory fees"
```

---

## Task 14: BrokerSim (fill model)

**Files:**
- Create: `src/engine/broker-sim.ts`
- Test: `src/engine/broker-sim.test.ts`

- [ ] **Step 1: Write failing test**

`src/engine/broker-sim.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BrokerSim } from './broker-sim';
import { zeroBrokerage } from './brokerage/zerodha-intraday';
import { OrderSide, OrderType, OrderStatus, type Order, type Candle } from '../types';

const candle = (open: number, high: number, low: number, close: number, ts = '2025-01-02T03:50:00Z'): Candle => ({
  symbol: 'R',
  ts: new Date(ts),
  interval: '5minute',
  open, high, low, close,
  volume: 1000,
});

const order = (over: Partial<Order['intent']> = {}, id = 'o1'): Order => ({
  id,
  submittedAt: new Date('2025-01-02T03:45:00Z'),
  status: OrderStatus.SUBMITTED,
  intent: { symbol: 'R', side: OrderSide.BUY, qty: 1, type: OrderType.MARKET, ...over },
});

describe('BrokerSim', () => {
  it('market buy fills at next bar open + slippage', () => {
    const sim = new BrokerSim({ slippageBps: 10, brokerage: zeroBrokerage });
    const res = sim.processOrder(order({ side: OrderSide.BUY, type: OrderType.MARKET, qty: 1 }), candle(100, 102, 99, 101));
    expect(res.fill).not.toBeNull();
    expect(res.fill!.price).toBeCloseTo(100 * (1 + 10 / 10_000));
    expect(res.order.status).toBe(OrderStatus.FILLED);
  });

  it('market sell fills at next bar open − slippage', () => {
    const sim = new BrokerSim({ slippageBps: 10, brokerage: zeroBrokerage });
    const res = sim.processOrder(order({ side: OrderSide.SELL, type: OrderType.MARKET, qty: 1 }), candle(100, 102, 99, 101));
    expect(res.fill!.price).toBeCloseTo(100 * (1 - 10 / 10_000));
  });

  it('limit buy fills only when bar low <= limit, at min(limit, open)+slippage', () => {
    const sim = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const noFill = sim.processOrder(order({ type: OrderType.LIMIT, limitPrice: 95 }), candle(100, 102, 99, 101));
    expect(noFill.fill).toBeNull();
    expect(noFill.order.status).toBe(OrderStatus.PENDING);
    const fill = sim.processOrder(order({ type: OrderType.LIMIT, limitPrice: 100 }), candle(101, 102, 99, 100.5));
    expect(fill.fill!.price).toBeCloseTo(100); // min(limit=100, open=101) = 100
  });

  it('limit sell fills only when bar high >= limit, at max(limit, open)−slippage', () => {
    const sim = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const noFill = sim.processOrder(order({ side: OrderSide.SELL, type: OrderType.LIMIT, limitPrice: 110 }), candle(100, 105, 99, 101));
    expect(noFill.fill).toBeNull();
    const fill = sim.processOrder(order({ side: OrderSide.SELL, type: OrderType.LIMIT, limitPrice: 100 }), candle(99, 102, 98, 101));
    expect(fill.fill!.price).toBeCloseTo(100); // max(limit=100, open=99) = 100
  });

  it('stop buy triggers when bar high >= stop, fills at max(stop, open)+slippage', () => {
    const sim = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const noFill = sim.processOrder(order({ type: OrderType.STOP, stopPrice: 110 }), candle(100, 105, 99, 101));
    expect(noFill.fill).toBeNull();
    const fill = sim.processOrder(order({ type: OrderType.STOP, stopPrice: 100 }), candle(99, 102, 98, 101));
    expect(fill.fill!.price).toBeCloseTo(100); // max(stop=100, open=99) = 100
  });

  it('stop sell triggers when bar low <= stop, fills at min(stop, open)−slippage', () => {
    const sim = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const fill = sim.processOrder(order({ side: OrderSide.SELL, type: OrderType.STOP, stopPrice: 100 }), candle(101, 102, 99, 100));
    expect(fill.fill!.price).toBeCloseTo(100); // min(stop=100, open=101) = 100
  });

  it('attaches brokerage fees to the fill', () => {
    const fees = { brokerage: 5, stt: 1, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 6 };
    const sim = new BrokerSim({ slippageBps: 0, brokerage: () => fees });
    const res = sim.processOrder(order({ type: OrderType.MARKET, qty: 10 }), candle(100, 102, 99, 101));
    expect(res.fill!.fees).toEqual(fees);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/engine/broker-sim.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/engine/broker-sim.ts`:

```ts
import { OrderSide, OrderStatus, OrderType, type Candle, type Fill, type Order } from '../types';
import type { BrokerageFn } from './brokerage/zerodha-intraday';

export interface BrokerSimOpts {
  slippageBps: number;
  brokerage: BrokerageFn;
}

export interface ProcessResult {
  order: Order;
  fill: Fill | null;
}

export class BrokerSim {
  constructor(private readonly opts: BrokerSimOpts) {}

  /** Process a single order against the next bar. Mutates and returns the order. */
  processOrder(order: Order, nextBar: Candle): ProcessResult {
    const intent = order.intent;
    const price = this.computeFillPrice(intent.side, intent.type, intent.limitPrice, intent.stopPrice, nextBar);
    if (price === null) {
      // Limit/stop didn't trigger — keep pending
      if (order.status === OrderStatus.SUBMITTED) order.status = OrderStatus.PENDING;
      return { order, fill: null };
    }
    const adjusted = this.applySlippage(intent.side, price);
    const fees = this.opts.brokerage({ side: intent.side, qty: intent.qty, price: adjusted });
    const fill: Fill = {
      orderId: order.id,
      symbol: intent.symbol,
      side: intent.side,
      qty: intent.qty,
      price: adjusted,
      ts: nextBar.ts,
      fees,
    };
    order.status = OrderStatus.FILLED;
    return { order, fill };
  }

  private computeFillPrice(
    side: OrderSide,
    type: OrderType,
    limit: number | undefined,
    stop: number | undefined,
    bar: Candle,
  ): number | null {
    if (type === OrderType.MARKET) return bar.open;
    if (type === OrderType.LIMIT) {
      if (limit === undefined) throw new Error('limit order requires limitPrice');
      if (side === OrderSide.BUY) {
        return bar.low <= limit ? Math.min(limit, bar.open) : null;
      }
      return bar.high >= limit ? Math.max(limit, bar.open) : null;
    }
    if (type === OrderType.STOP) {
      if (stop === undefined) throw new Error('stop order requires stopPrice');
      if (side === OrderSide.BUY) {
        return bar.high >= stop ? Math.max(stop, bar.open) : null;
      }
      return bar.low <= stop ? Math.min(stop, bar.open) : null;
    }
    throw new Error(`unknown order type: ${type as string}`);
  }

  private applySlippage(side: OrderSide, price: number): number {
    const bps = this.opts.slippageBps;
    return side === OrderSide.BUY ? price * (1 + bps / 10_000) : price * (1 - bps / 10_000);
  }
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm test src/engine/broker-sim.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/broker-sim.ts src/engine/broker-sim.test.ts
git commit -m "feat(engine): BrokerSim fill model for market/limit/stop with directional slippage"
```

---

## Task 15: OrderRouter (squareoff enforcement)

**Files:**
- Create: `src/engine/order-router.ts`
- Test: `src/engine/order-router.test.ts`

- [ ] **Step 1: Write failing test**

`src/engine/order-router.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { OrderRouter } from './order-router';
import { OrderSide, OrderType, type Position } from '../types';

const pos = (qty: number): Position => ({ symbol: 'R', qty, avgPrice: 100 });

describe('OrderRouter', () => {
  it('passes through strategy intents as queued orders', () => {
    const r = new OrderRouter({ squareoffTime: '15:15' });
    const id = r.submit({ symbol: 'R', side: OrderSide.BUY, qty: 1, type: OrderType.MARKET });
    expect(typeof id).toBe('string');
    expect(r.queued().length).toBe(1);
    expect(r.queued()[0]!.intent.symbol).toBe('R');
  });

  it('emits exit-all market orders at squareoff time', () => {
    const r = new OrderRouter({ squareoffTime: '15:15' });
    const ts = new Date('2025-01-02T09:45:00Z'); // 15:15 IST
    r.maybeSquareoff(ts, [pos(10), { symbol: 'I', qty: -5, avgPrice: 1000 }]);
    const queued = r.queued();
    expect(queued.length).toBe(2);
    const long = queued.find((o) => o.intent.symbol === 'R')!;
    expect(long.intent.side).toBe(OrderSide.SELL);
    expect(long.intent.qty).toBe(10);
    expect(long.intent.tag).toMatch(/squareoff/);
    const short = queued.find((o) => o.intent.symbol === 'I')!;
    expect(short.intent.side).toBe(OrderSide.BUY);
    expect(short.intent.qty).toBe(5);
  });

  it('does not squareoff at non-squareoff bars', () => {
    const r = new OrderRouter({ squareoffTime: '15:15' });
    const ts = new Date('2025-01-02T06:00:00Z'); // 11:30 IST
    r.maybeSquareoff(ts, [pos(10)]);
    expect(r.queued().length).toBe(0);
  });

  it('drain() returns and clears queued orders', () => {
    const r = new OrderRouter({ squareoffTime: '15:15' });
    r.submit({ symbol: 'R', side: OrderSide.BUY, qty: 1, type: OrderType.MARKET });
    const drained = r.drain();
    expect(drained.length).toBe(1);
    expect(r.queued().length).toBe(0);
  });

  it('idempotent squareoff: calling at same bar twice does not double-emit', () => {
    const r = new OrderRouter({ squareoffTime: '15:15' });
    const ts = new Date('2025-01-02T09:45:00Z');
    r.maybeSquareoff(ts, [pos(10)]);
    r.maybeSquareoff(ts, [pos(10)]);
    expect(r.queued().length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/engine/order-router.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/engine/order-router.ts`:

```ts
import { OrderSide, OrderStatus, OrderType, type Order, type OrderIntent, type Position } from '../types';
import { isSquareoffBarIST } from '../util/time';

export interface OrderRouterOpts {
  squareoffTime: string; // 'HH:mm' IST
}

export class OrderRouter {
  private readonly _queue: Order[] = [];
  private nextId = 1;
  private squareoffEmittedAt: number | null = null;

  constructor(private readonly opts: OrderRouterOpts) {}

  submit(intent: OrderIntent): string {
    const id = `ord-${this.nextId++}`;
    this._queue.push({
      id,
      submittedAt: new Date(),
      status: OrderStatus.SUBMITTED,
      intent,
    });
    return id;
  }

  queued(): Order[] {
    return this._queue;
  }

  drain(): Order[] {
    const out = this._queue.splice(0, this._queue.length);
    return out;
  }

  maybeSquareoff(barTs: Date, positions: Position[]): void {
    if (!isSquareoffBarIST(barTs, this.opts.squareoffTime)) return;
    if (this.squareoffEmittedAt === barTs.getTime()) return;
    this.squareoffEmittedAt = barTs.getTime();
    for (const p of positions) {
      if (p.qty === 0) continue;
      const exit: OrderIntent = {
        symbol: p.symbol,
        side: p.qty > 0 ? OrderSide.SELL : OrderSide.BUY,
        qty: Math.abs(p.qty),
        type: OrderType.MARKET,
        tag: 'squareoff',
      };
      this.submit(exit);
    }
  }
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm test src/engine/order-router.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/order-router.ts src/engine/order-router.test.ts
git commit -m "feat(engine): OrderRouter with intent submission and EOD squareoff emission"
```

---

## Task 16: Strategy abstract + SmaCrossover example

**Files:**
- Create: `src/strategies/strategy.ts`
- Create: `src/strategies/sma-crossover.ts`
- Test: `src/strategies/sma-crossover.test.ts`

- [ ] **Step 1: Write failing test**

`src/strategies/sma-crossover.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SmaCrossover } from './sma-crossover';
import { IndicatorRegistry } from '../indicators/registry';
import type { StrategyContext } from './strategy';
import { OrderSide, OrderType, type Candle, type OrderIntent, type Position } from '../types';
import { SMA } from '../indicators/sma';

function makeCtx(positions: Map<string, Position> = new Map()): {
  ctx: StrategyContext;
  submitted: OrderIntent[];
  reg: IndicatorRegistry;
} {
  const submitted: OrderIntent[] = [];
  const reg = new IndicatorRegistry();
  const ctx: StrategyContext = {
    cash: 100_000,
    position: (s) => positions.get(s) ?? null,
    submitOrder: (intent) => {
      submitted.push(intent);
      return `o-${submitted.length}`;
    },
    cancelOrder: () => {},
    indicator: reg,
    params: { fast: 2, slow: 4 },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
  };
  return { ctx, submitted, reg };
}

const bar = (close: number, ts = '2025-01-02T03:45:00Z'): Candle => ({
  symbol: 'R', ts: new Date(ts), interval: '5minute', open: close, high: close, low: close, close, volume: 1,
});

describe('SmaCrossover', () => {
  it('init registers fast and slow SMAs for each symbol in params.symbols', () => {
    const { ctx, reg } = makeCtx();
    ctx.params.symbols = ['R'];
    const s = new SmaCrossover();
    s.init(ctx);
    expect(reg.get('R', 'sma_fast')).toBeInstanceOf(SMA);
    expect(reg.get('R', 'sma_slow')).toBeInstanceOf(SMA);
  });

  it('buys when fast crosses above slow with no position', () => {
    const { ctx, submitted, reg } = makeCtx();
    ctx.params.symbols = ['R'];
    const s = new SmaCrossover();
    s.init(ctx);
    // Feed a series where fast crosses above slow at the last bar.
    // closes: 10,10,10,10 → flat, then 20 makes fast (last 2: 10,20=15) > slow (last 4: 10,10,10,20=12.5)
    for (const c of [10, 10, 10, 10]) {
      reg.feedClose('R', c);
      s.onBar(bar(c), ctx);
    }
    expect(submitted.length).toBe(0);
    reg.feedClose('R', 20);
    s.onBar(bar(20), ctx);
    expect(submitted.length).toBe(1);
    expect(submitted[0]!.side).toBe(OrderSide.BUY);
    expect(submitted[0]!.type).toBe(OrderType.MARKET);
    expect(submitted[0]!.qty).toBeGreaterThan(0);
  });

  it('sells (exits) when fast crosses below slow while long', () => {
    const positions = new Map<string, Position>([['R', { symbol: 'R', qty: 5, avgPrice: 15 }]]);
    const { ctx, submitted, reg } = makeCtx(positions);
    ctx.params.symbols = ['R'];
    const s = new SmaCrossover();
    s.init(ctx);
    for (const c of [20, 20, 20, 20]) {
      reg.feedClose('R', c);
      s.onBar(bar(c), ctx);
    }
    submitted.length = 0;
    // Drop pulls fast below slow
    reg.feedClose('R', 5);
    s.onBar(bar(5), ctx);
    expect(submitted.length).toBe(1);
    expect(submitted[0]!.side).toBe(OrderSide.SELL);
    expect(submitted[0]!.qty).toBe(5);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/strategies/sma-crossover.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Strategy abstract**

`src/strategies/strategy.ts`:

```ts
import type { Logger } from '../util/logger';
import type { Candle, Fill, OrderId, OrderIntent, Position } from '../types';
import type { IndicatorRegistry } from '../indicators/registry';

export interface StrategyContext {
  cash: number;
  position(symbol: string): Position | null;
  submitOrder(intent: OrderIntent): OrderId;
  cancelOrder(id: OrderId): void;
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

- [ ] **Step 4: Implement SmaCrossover**

`src/strategies/sma-crossover.ts`:

```ts
import { OrderSide, OrderType, type Candle } from '../types';
import { SMA } from '../indicators/sma';
import { Strategy, type StrategyContext } from './strategy';

interface State {
  prevFast: number | undefined;
  prevSlow: number | undefined;
}

export class SmaCrossover extends Strategy {
  private symbols: string[] = [];
  private fast = 9;
  private slow = 21;
  private readonly state = new Map<string, State>();

  init(ctx: StrategyContext): void {
    this.symbols = (ctx.params.symbols as string[] | undefined) ?? [];
    this.fast = (ctx.params.fast as number | undefined) ?? this.fast;
    this.slow = (ctx.params.slow as number | undefined) ?? this.slow;
    if (this.fast >= this.slow) throw new Error(`fast (${this.fast}) must be < slow (${this.slow})`);
    for (const s of this.symbols) {
      ctx.indicator.register(s, 'sma_fast', new SMA(this.fast));
      ctx.indicator.register(s, 'sma_slow', new SMA(this.slow));
      this.state.set(s, { prevFast: undefined, prevSlow: undefined });
    }
  }

  onBar(bar: Candle, ctx: StrategyContext): void {
    const fast = ctx.indicator.get(bar.symbol, 'sma_fast')?.value;
    const slow = ctx.indicator.get(bar.symbol, 'sma_slow')?.value;
    const st = this.state.get(bar.symbol);
    if (!st || fast === undefined || slow === undefined) return;
    const pf = st.prevFast;
    const ps = st.prevSlow;
    st.prevFast = fast;
    st.prevSlow = slow;
    if (pf === undefined || ps === undefined) return;

    const crossUp = pf <= ps && fast > slow;
    const crossDown = pf >= ps && fast < slow;
    const pos = ctx.position(bar.symbol);

    if (crossUp && (!pos || pos.qty <= 0)) {
      const qty = sizeByCash(ctx.cash, bar.close);
      if (qty > 0) {
        ctx.submitOrder({ symbol: bar.symbol, side: OrderSide.BUY, qty, type: OrderType.MARKET, tag: 'sma_cross_up' });
      }
    } else if (crossDown && pos && pos.qty > 0) {
      ctx.submitOrder({ symbol: bar.symbol, side: OrderSide.SELL, qty: pos.qty, type: OrderType.MARKET, tag: 'sma_cross_down' });
    }
  }
}

/** Naive sizing: spend up to half of available cash per signal. Replace later with risk-based sizing. */
function sizeByCash(cash: number, price: number): number {
  if (price <= 0) return 0;
  return Math.floor((cash * 0.5) / price);
}
```

- [ ] **Step 5: Run test, expect PASS**

Run: `pnpm test src/strategies/sma-crossover.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/strategies
git commit -m "feat(strategies): Strategy abstract base and SmaCrossover reference impl"
```

---

## Task 17: BacktestEngine

**Files:**
- Create: `src/engine/backtest-engine.ts`
- Test: `src/engine/backtest-engine.test.ts`

- [ ] **Step 1: Write failing test**

`src/engine/backtest-engine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BacktestEngine } from './backtest-engine';
import { Portfolio } from './portfolio';
import { BrokerSim } from './broker-sim';
import { OrderRouter } from './order-router';
import { IndicatorRegistry } from '../indicators/registry';
import { Strategy, type StrategyContext } from '../strategies/strategy';
import { zeroBrokerage } from './brokerage/zerodha-intraday';
import { OrderSide, OrderType, type Candle } from '../types';
import { createLogger } from '../util/logger';

class BuyOnceStrategy extends Strategy {
  private bought = false;
  init(): void {}
  onBar(bar: Candle, ctx: StrategyContext): void {
    if (!this.bought) {
      ctx.submitOrder({ symbol: bar.symbol, side: OrderSide.BUY, qty: 1, type: OrderType.MARKET });
      this.bought = true;
    }
  }
}

class PeekStrategy extends Strategy {
  init(): void {}
  // attempts to read a property only available if engine leaks future bars (simulated by inspecting ctx)
  onBar(_bar: Candle, ctx: StrategyContext): void {
    // engine should never expose future bars; if (ctx as any).futureBars exists this is a leak
    if ((ctx as unknown as { futureBars?: Candle[] }).futureBars) {
      throw new Error('lookahead leak detected');
    }
  }
}

const cb = (ts: string, open: number, close = open, high = Math.max(open, close), low = Math.min(open, close)): Candle => ({
  symbol: 'R', ts: new Date(ts), interval: '5minute', open, high, low, close, volume: 1,
});

function makeEngine(strategy: Strategy, candles: Candle[], opts: { warmup?: number; squareoff?: string } = {}) {
  const portfolio = new Portfolio(100_000);
  const broker = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
  const router = new OrderRouter({ squareoffTime: opts.squareoff ?? '15:15' });
  const registry = new IndicatorRegistry();
  const logger = createLogger({ runId: 'test', level: 'error' });
  return new BacktestEngine({
    candles,
    strategy,
    portfolio,
    broker,
    router,
    indicators: registry,
    logger,
    warmupBars: opts.warmup ?? 0,
    params: { symbols: ['R'] },
  });
}

describe('BacktestEngine', () => {
  it('asserts time-monotonic input', () => {
    const out = [
      cb('2025-01-02T03:50:00Z', 100),
      cb('2025-01-02T03:45:00Z', 100), // out of order
    ];
    const engine = makeEngine(new BuyOnceStrategy(), out);
    expect(() => engine.run()).toThrow(/monotonic|order/i);
  });

  it('skips first warmupBars without invoking strategy.onBar or accepting orders', () => {
    let bars = 0;
    class Counter extends Strategy {
      init(): void {}
      onBar(): void {
        bars += 1;
      }
    }
    const candles = [
      cb('2025-01-02T03:45:00Z', 100),
      cb('2025-01-02T03:50:00Z', 101),
      cb('2025-01-02T03:55:00Z', 102),
      cb('2025-01-02T04:00:00Z', 103),
    ];
    const engine = makeEngine(new Counter(), candles, { warmup: 2 });
    engine.run();
    expect(bars).toBe(2); // 4 bars - 2 warmup = 2 onBar calls
  });

  it('orders submitted on bar N fill on bar N+1 (no lookahead)', () => {
    const candles = [
      cb('2025-01-02T03:45:00Z', 100, 100),
      cb('2025-01-02T03:50:00Z', 110, 110),
      cb('2025-01-02T03:55:00Z', 120, 120),
    ];
    const engine = makeEngine(new BuyOnceStrategy(), candles);
    const result = engine.run();
    // Strategy submits on bar 0 (open=100), fills on bar 1 (open=110)
    expect(result.fills.length).toBe(1);
    expect(result.fills[0]!.price).toBe(110);
  });

  it('squareoffs at squareoff bar: positions closed by EOD', () => {
    // Build a session: 09:15..15:15 IST in 5min steps. Use a single buy at first bar.
    const start = new Date('2025-01-02T03:45:00Z'); // 09:15 IST
    const candles: Candle[] = [];
    for (let i = 0; i < 73; i++) { // 73 bars covers 09:15..15:25
      candles.push(cb(new Date(start.getTime() + i * 5 * 60_000).toISOString(), 100));
    }
    const engine = makeEngine(new BuyOnceStrategy(), candles, { squareoff: '15:15' });
    const result = engine.run();
    // Expect a buy fill and a squareoff sell fill
    const buys = result.fills.filter((f) => f.side === OrderSide.BUY);
    const sells = result.fills.filter((f) => f.side === OrderSide.SELL);
    expect(buys.length).toBe(1);
    expect(sells.length).toBe(1);
  });

  it('does not leak future bars to strategy', () => {
    const candles = [cb('2025-01-02T03:45:00Z', 100), cb('2025-01-02T03:50:00Z', 101)];
    const engine = makeEngine(new PeekStrategy(), candles);
    expect(() => engine.run()).not.toThrow();
  });

  it('records equity snapshots per bar', () => {
    const candles = [
      cb('2025-01-02T03:45:00Z', 100),
      cb('2025-01-02T03:50:00Z', 101),
      cb('2025-01-02T03:55:00Z', 102),
    ];
    class Noop extends Strategy { init(): void {} onBar(): void {} }
    const engine = makeEngine(new Noop(), candles);
    const result = engine.run();
    expect(result.equityCurve.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/engine/backtest-engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/engine/backtest-engine.ts`:

```ts
import type { Logger } from '../util/logger';
import type { Candle, EquitySnapshot, Fill, OrderId, OrderIntent, Position } from '../types';
import { OrderStatus } from '../types';
import type { IndicatorRegistry } from '../indicators/registry';
import type { Strategy, StrategyContext } from '../strategies/strategy';
import type { Portfolio } from './portfolio';
import type { BrokerSim } from './broker-sim';
import type { OrderRouter } from './order-router';

export interface BacktestEngineOpts {
  candles: Candle[];                    // sorted ascending by ts; merge across symbols upstream
  strategy: Strategy;
  portfolio: Portfolio;
  broker: BrokerSim;
  router: OrderRouter;
  indicators: IndicatorRegistry;
  logger: Logger;
  warmupBars: number;
  params: Record<string, unknown>;
}

export interface BacktestResult {
  fills: Fill[];
  equityCurve: EquitySnapshot[];
  finalEquity: number;
}

export function runBacktest(opts: BacktestEngineOpts): BacktestResult {
  return new BacktestEngine(opts).run();
}

export class BacktestEngine {
  constructor(private readonly opts: BacktestEngineOpts) {}

  run(): BacktestResult {
    const { candles, strategy, portfolio, broker, router, indicators, logger, warmupBars, params } = this.opts;
    this.assertMonotonic(candles);

    // Build context — note: spread of params is shallow-copied so strategy can read but engine controls cash etc.
    const fills: Fill[] = [];
    const ctx: StrategyContext = {
      get cash(): number {
        return portfolio.cash;
      },
      position: (s: string): Position | null => portfolio.position(s),
      submitOrder: (intent: OrderIntent): OrderId => router.submit(intent),
      cancelOrder: (_id: OrderId): void => {
        // Not implemented in milestone 1
      },
      indicator: indicators,
      params,
      logger,
    } as StrategyContext;

    strategy.init(ctx);

    // Pending orders carry across bars; queued() reads-write; engine processes against next bar.
    let pending: ReturnType<OrderRouter['drain']> = [];

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i]!;

      // Process pending orders against THIS bar
      const stillPending: typeof pending = [];
      for (const order of pending) {
        const res = broker.processOrder(order, bar);
        if (res.fill) {
          try {
            portfolio.applyFill(res.fill);
            fills.push(res.fill);
            strategy.onOrderFill?.(res.fill, ctx);
          } catch (err) {
            order.status = OrderStatus.REJECTED;
            order.rejectionReason = (err as Error).message;
            logger.warn({ orderId: order.id, reason: order.rejectionReason }, 'order rejected at fill apply');
            strategy.onOrderRejected?.(order.rejectionReason, order.intent, ctx);
          }
        } else if (order.status === OrderStatus.PENDING) {
          stillPending.push(order);
        }
      }

      // Update indicators with this bar's close
      indicators.feedClose(bar.symbol, bar.close);

      // Mark to market with this bar's close
      portfolio.markToMarket(new Map([[bar.symbol, bar.close]]), bar.ts);

      const isWarmup = i < warmupBars;
      if (!isWarmup) {
        // EOD squareoff (queued like any strategy intent; fills on next bar)
        router.maybeSquareoff(bar.ts, portfolio.positions());

        // Strategy gets a turn
        try {
          strategy.onBar(bar, ctx);
        } catch (err) {
          logger.error({ err, bar }, 'strategy threw in onBar');
          throw err;
        }
      }

      // New orders submitted this bar enter pending queue, joined with carryovers
      pending = stillPending.concat(router.drain());
    }

    // Final fallback: if positions remain open after last bar, force-close at last bar's close
    const last = candles[candles.length - 1];
    if (last && portfolio.positions().length > 0) {
      logger.warn('force-closing open positions at final bar close');
      for (const p of portfolio.positions()) {
        const side = p.qty > 0 ? 'sell' : 'buy';
        const qty = Math.abs(p.qty);
        const fees = { brokerage: 0, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 0 };
        const fill: Fill = {
          orderId: 'force-close',
          symbol: p.symbol,
          side: side === 'sell' ? ('sell' as const) : ('buy' as const),
          qty,
          price: last.close,
          ts: last.ts,
          fees,
        } as Fill;
        portfolio.applyFill(fill);
        fills.push(fill);
      }
    }

    const equity = portfolio.equityCurve();
    return {
      fills,
      equityCurve: equity,
      finalEquity: equity.length > 0 ? equity[equity.length - 1]!.equity : portfolio.cash,
    };
  }

  private assertMonotonic(candles: Candle[]): void {
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1]!.ts.getTime();
      const cur = candles[i]!.ts.getTime();
      if (cur < prev) {
        throw new Error(`candles must be in monotonic order; index ${i} (${candles[i]!.ts.toISOString()}) precedes index ${i - 1} (${candles[i - 1]!.ts.toISOString()})`);
      }
    }
  }
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm test src/engine/backtest-engine.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/backtest-engine.ts src/engine/backtest-engine.test.ts
git commit -m "feat(engine): BacktestEngine with warmup, no-lookahead, monotonic invariant, EOD squareoff"
```

---

## Task 18: Metrics

**Files:**
- Create: `src/report/metrics.ts`
- Test: `src/report/metrics.test.ts`

- [ ] **Step 1: Write failing test**

`src/report/metrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeMetrics, buildTrades } from './metrics';
import { OrderSide, type EquitySnapshot, type Fill } from '../types';

const snap = (ts: string, equity: number): EquitySnapshot => ({
  ts: new Date(ts), cash: 0, unrealized: 0, realized: 0, equity,
});

describe('computeMetrics', () => {
  it('totalReturn = (final/initial) - 1', () => {
    const curve = [snap('2025-01-02T03:45:00Z', 100_000), snap('2025-01-02T10:00:00Z', 110_000)];
    const m = computeMetrics({ equityCurve: curve, trades: [], initialCapital: 100_000 });
    expect(m.totalReturn).toBeCloseTo(0.1);
    expect(m.finalEquity).toBe(110_000);
  });

  it('maxDrawdown is the largest peak-to-trough decline', () => {
    const curve = [
      snap('2025-01-02T03:45:00Z', 100_000),
      snap('2025-01-02T03:50:00Z', 110_000),
      snap('2025-01-02T03:55:00Z', 90_000), // -18.18% from 110k
      snap('2025-01-02T04:00:00Z', 95_000),
      snap('2025-01-02T04:05:00Z', 105_000),
    ];
    const m = computeMetrics({ equityCurve: curve, trades: [], initialCapital: 100_000 });
    expect(m.maxDrawdownPct).toBeCloseTo((90_000 - 110_000) / 110_000, 4);
    expect(m.maxDrawdownAbs).toBeCloseTo(20_000);
  });

  it('winRate, avgWin, avgLoss, expectancy from trades', () => {
    const trades = [
      { symbol: 'R', qty: 1, entryPrice: 100, exitPrice: 110, entryTs: new Date(), exitTs: new Date(), side: OrderSide.BUY, pnl: 10, fees: 0 },
      { symbol: 'R', qty: 1, entryPrice: 100, exitPrice: 95, entryTs: new Date(), exitTs: new Date(), side: OrderSide.BUY, pnl: -5, fees: 0 },
      { symbol: 'R', qty: 1, entryPrice: 100, exitPrice: 105, entryTs: new Date(), exitTs: new Date(), side: OrderSide.BUY, pnl: 5, fees: 0 },
    ];
    const m = computeMetrics({ equityCurve: [], trades, initialCapital: 100_000 });
    expect(m.totalTrades).toBe(3);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.winRate).toBeCloseTo(2 / 3);
    expect(m.avgWin).toBeCloseTo((10 + 5) / 2);
    expect(m.avgLoss).toBeCloseTo(-5);
    expect(m.expectancy).toBeCloseTo((2 / 3) * 7.5 + (1 / 3) * -5);
  });

  it('sharpe from synthetic daily returns: known mean and std', () => {
    // Build curve where daily returns are [0.01, -0.005, 0.015, 0.0, 0.005]
    // mean = 0.005, std = sqrt(((0.005)^2 + (-0.01)^2 + (0.01)^2 + (-0.005)^2 + (0)^2) / 5) ≈ 0.0070710678
    // Sharpe (rf=0, daily) = mean/std ≈ 0.7071, annualized × sqrt(252)
    const start = 100_000;
    const rets = [0.01, -0.005, 0.015, 0.0, 0.005];
    const equities = [start];
    let v = start;
    for (const r of rets) {
      v = v * (1 + r);
      equities.push(v);
    }
    const curve: EquitySnapshot[] = equities.map((e, i) => snap(`2025-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`, e));
    const m = computeMetrics({ equityCurve: curve, trades: [], initialCapital: start });
    expect(m.sharpe).toBeGreaterThan(0);
    expect(Number.isFinite(m.sharpe)).toBe(true);
  });
});

describe('buildTrades', () => {
  it('pairs entry and exit fills into Trades (long-only, FIFO)', () => {
    const fills: Fill[] = [
      { orderId: '1', symbol: 'R', side: OrderSide.BUY, qty: 5, price: 100, ts: new Date('2025-01-02T03:50:00Z'), fees: { brokerage: 1, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 1 } },
      { orderId: '2', symbol: 'R', side: OrderSide.SELL, qty: 5, price: 110, ts: new Date('2025-01-02T04:00:00Z'), fees: { brokerage: 1, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 1 } },
    ];
    const trades = buildTrades(fills);
    expect(trades.length).toBe(1);
    expect(trades[0]!.entryPrice).toBe(100);
    expect(trades[0]!.exitPrice).toBe(110);
    expect(trades[0]!.qty).toBe(5);
    expect(trades[0]!.pnl).toBeCloseTo(5 * 10 - 2);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/report/metrics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/report/metrics.ts`:

```ts
import { OrderSide, type EquitySnapshot, type Fill, type Trade } from '../types';

export interface Metrics {
  initialCapital: number;
  finalEquity: number;
  totalReturn: number;          // fraction
  maxDrawdownPct: number;       // negative fraction (e.g. -0.18)
  maxDrawdownAbs: number;       // absolute, positive
  sharpe: number;               // annualized, daily returns, rf=0
  sortino: number;              // annualized
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;               // > 0
  avgLoss: number;              // <= 0
  expectancy: number;
  profitFactor: number;         // sum(wins) / |sum(losses)|; Infinity if no losses
  totalFees: number;
}

export interface ComputeMetricsInput {
  equityCurve: EquitySnapshot[];
  trades: Trade[];
  initialCapital: number;
  tradingDaysPerYear?: number;  // default 252
}

export function computeMetrics({
  equityCurve,
  trades,
  initialCapital,
  tradingDaysPerYear = 252,
}: ComputeMetricsInput): Metrics {
  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1]!.equity : initialCapital;
  const totalReturn = finalEquity / initialCapital - 1;

  // Drawdown over equity curve
  let peak = equityCurve.length > 0 ? equityCurve[0]!.equity : initialCapital;
  let maxDdPct = 0;
  let maxDdAbs = 0;
  for (const s of equityCurve) {
    if (s.equity > peak) peak = s.equity;
    const ddAbs = peak - s.equity;
    const ddPct = peak > 0 ? -ddAbs / peak : 0;
    if (ddPct < maxDdPct) maxDdPct = ddPct;
    if (ddAbs > maxDdAbs) maxDdAbs = ddAbs;
  }

  // Daily returns from equity curve (group by IST date)
  const dailyReturns = computeDailyReturns(equityCurve);
  const sharpe = annualizedSharpe(dailyReturns, tradingDaysPerYear);
  const sortino = annualizedSortino(dailyReturns, tradingDaysPerYear);

  // Trade-level stats
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  const sumWins = wins.reduce((a, t) => a + t.pnl, 0);
  const sumLosses = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = sumLosses === 0 ? (sumWins > 0 ? Infinity : 0) : sumWins / sumLosses;
  const totalFees = trades.reduce((a, t) => a + t.fees, 0);

  return {
    initialCapital,
    finalEquity,
    totalReturn,
    maxDrawdownPct: maxDdPct,
    maxDrawdownAbs: maxDdAbs,
    sharpe,
    sortino,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy,
    profitFactor,
    totalFees,
  };
}

function computeDailyReturns(curve: EquitySnapshot[]): number[] {
  if (curve.length < 2) return [];
  // Group by yyyy-mm-dd (UTC) — IST conversion not strictly needed for return calc
  const byDay = new Map<string, number>();
  for (const s of curve) {
    const key = s.ts.toISOString().slice(0, 10);
    byDay.set(key, s.equity); // last snapshot of the day wins
  }
  const days = Array.from(byDay.keys()).sort();
  const rets: number[] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = byDay.get(days[i - 1]!)!;
    const cur = byDay.get(days[i]!)!;
    if (prev > 0) rets.push(cur / prev - 1);
  }
  return rets;
}

function annualizedSharpe(returns: number[], daysPerYear: number): number {
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(daysPerYear);
}

function annualizedSortino(returns: number[], daysPerYear: number): number {
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const downside = returns.filter((r) => r < 0);
  if (downside.length === 0) return mean === 0 ? 0 : Infinity;
  const variance = downside.reduce((a, b) => a + b ** 2, 0) / downside.length;
  const dd = Math.sqrt(variance);
  if (dd === 0) return 0;
  return (mean / dd) * Math.sqrt(daysPerYear);
}

/** Pair entry and exit fills (long-only FIFO). For milestone 1 we only support one open position per symbol. */
export function buildTrades(fills: Fill[]): Trade[] {
  const open = new Map<string, Array<{ qty: number; price: number; ts: Date; fees: number }>>();
  const trades: Trade[] = [];
  for (const f of fills) {
    if (f.side === OrderSide.BUY) {
      let q = open.get(f.symbol);
      if (!q) {
        q = [];
        open.set(f.symbol, q);
      }
      q.push({ qty: f.qty, price: f.price, ts: f.ts, fees: f.fees.total });
    } else {
      // SELL — match against FIFO open lots
      let remaining = f.qty;
      let exitFeesRemaining = f.fees.total;
      const q = open.get(f.symbol) ?? [];
      while (remaining > 0 && q.length > 0) {
        const lot = q[0]!;
        const matchQty = Math.min(remaining, lot.qty);
        const proportionalEntryFees = (lot.fees * matchQty) / lot.qty;
        const proportionalExitFees = (exitFeesRemaining * matchQty) / f.qty;
        const pnl = (f.price - lot.price) * matchQty - proportionalEntryFees - proportionalExitFees;
        trades.push({
          symbol: f.symbol,
          qty: matchQty,
          entryPrice: lot.price,
          exitPrice: f.price,
          entryTs: lot.ts,
          exitTs: f.ts,
          side: OrderSide.BUY,
          pnl,
          fees: proportionalEntryFees + proportionalExitFees,
        });
        lot.qty -= matchQty;
        lot.fees -= proportionalEntryFees;
        remaining -= matchQty;
        exitFeesRemaining -= proportionalExitFees;
        if (lot.qty === 0) q.shift();
      }
    }
  }
  return trades;
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm test src/report/metrics.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/report/metrics.ts src/report/metrics.test.ts
git commit -m "feat(report): metrics (Sharpe/Sortino/MDD/win-rate/expectancy) and FIFO trade builder"
```

---

## Task 19: HtmlReport

**Files:**
- Create: `src/report/html-report.ts`
- Test: `src/report/html-report.test.ts`

- [ ] **Step 1: Write failing test**

`src/report/html-report.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderHtml } from './html-report';
import { OrderSide } from '../types';

describe('renderHtml', () => {
  it('produces a self-contained HTML with all sections', () => {
    const html = renderHtml({
      runId: '20250102-100000-Test',
      strategy: 'TestStrategy',
      symbols: ['R'],
      from: '2025-01-01',
      to: '2025-01-31',
      interval: '5minute',
      metrics: {
        initialCapital: 100_000,
        finalEquity: 110_000,
        totalReturn: 0.1,
        maxDrawdownPct: -0.05,
        maxDrawdownAbs: 5000,
        sharpe: 1.2,
        sortino: 1.5,
        totalTrades: 5,
        wins: 3,
        losses: 2,
        winRate: 0.6,
        avgWin: 500,
        avgLoss: -200,
        expectancy: 220,
        profitFactor: 3.75,
        totalFees: 100,
      },
      equityCurve: [
        { ts: new Date('2025-01-02T03:45:00Z'), cash: 100_000, unrealized: 0, realized: 0, equity: 100_000 },
        { ts: new Date('2025-01-02T10:00:00Z'), cash: 100_000, unrealized: 10_000, realized: 0, equity: 110_000 },
      ],
      trades: [
        { symbol: 'R', qty: 1, entryPrice: 100, exitPrice: 110, entryTs: new Date('2025-01-02T03:50:00Z'), exitTs: new Date('2025-01-02T04:00:00Z'), side: OrderSide.BUY, pnl: 10, fees: 0 },
      ],
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('TestStrategy');
    expect(html).toContain('Equity Curve');
    expect(html).toContain('Drawdown');
    expect(html).toContain('Trade List');
    expect(html).toContain('Sharpe');
    expect(html).toMatch(/100000|100,000/);
    // Chart.js inlined or via script tag (we use CDN to keep file small but reproducible)
    expect(html).toMatch(/chart\.js|Chart\(/);
    // No NaN leaked
    expect(html).not.toContain('NaN');
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/report/html-report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/report/html-report.ts`:

```ts
import type { EquitySnapshot, Trade } from '../types';
import type { Metrics } from './metrics';

export interface ReportInput {
  runId: string;
  strategy: string;
  symbols: string[];
  from: string;
  to: string;
  interval: string;
  metrics: Metrics;
  equityCurve: EquitySnapshot[];
  trades: Trade[];
}

const fmt = (n: number, opts: Intl.NumberFormatOptions = {}) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, ...opts }).format(n);

const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`;

export function renderHtml(r: ReportInput): string {
  const equityData = r.equityCurve.map((s) => ({ x: s.ts.toISOString(), y: s.equity }));
  const ddData = computeDrawdownSeries(r.equityCurve);
  const tradesRows = r.trades
    .map(
      (t) => `<tr>
        <td>${t.symbol}</td>
        <td>${t.entryTs.toISOString().replace('T', ' ').slice(0, 19)}</td>
        <td>${t.exitTs.toISOString().replace('T', ' ').slice(0, 19)}</td>
        <td>${t.side}</td>
        <td>${t.qty}</td>
        <td>${fmt(t.entryPrice)}</td>
        <td>${fmt(t.exitPrice)}</td>
        <td class="${t.pnl >= 0 ? 'pos' : 'neg'}">${fmt(t.pnl)}</td>
        <td>${fmt(t.fees)}</td>
      </tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Backtest — ${escapeHtml(r.strategy)} — ${r.runId}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0"></script>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 24px; color: #222; }
  h1 { margin: 0 0 4px; }
  .meta { color: #666; margin-bottom: 24px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #f7f7f8; border-radius: 8px; padding: 12px 16px; }
  .card .k { font-size: 12px; color: #666; }
  .card .v { font-size: 20px; font-weight: 600; margin-top: 4px; }
  .pos { color: #1a7f37; } .neg { color: #c62828; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border-bottom: 1px solid #eee; padding: 6px 8px; text-align: right; }
  th:first-child, td:first-child, th:nth-child(4), td:nth-child(4) { text-align: left; }
  .chart { height: 320px; margin-bottom: 32px; }
  h2 { margin-top: 32px; }
</style>
</head>
<body>
<h1>Backtest — ${escapeHtml(r.strategy)}</h1>
<div class="meta">
  Run <code>${r.runId}</code> · Symbols: ${r.symbols.map(escapeHtml).join(', ')} · ${r.from} → ${r.to} · Interval: ${r.interval}
</div>

<div class="grid">
  ${kv('Initial Capital', fmt(r.metrics.initialCapital))}
  ${kv('Final Equity', fmt(r.metrics.finalEquity))}
  ${kv('Total Return', fmtPct(r.metrics.totalReturn))}
  ${kv('Max Drawdown', fmtPct(r.metrics.maxDrawdownPct))}
  ${kv('Sharpe', fmt(r.metrics.sharpe))}
  ${kv('Sortino', fmt(r.metrics.sortino))}
  ${kv('Trades', String(r.metrics.totalTrades))}
  ${kv('Win Rate', fmtPct(r.metrics.winRate))}
  ${kv('Avg Win', fmt(r.metrics.avgWin))}
  ${kv('Avg Loss', fmt(r.metrics.avgLoss))}
  ${kv('Expectancy', fmt(r.metrics.expectancy))}
  ${kv('Profit Factor', Number.isFinite(r.metrics.profitFactor) ? fmt(r.metrics.profitFactor) : '∞')}
  ${kv('Total Fees', fmt(r.metrics.totalFees))}
</div>

<h2>Equity Curve</h2>
<div class="chart"><canvas id="eq"></canvas></div>

<h2>Drawdown</h2>
<div class="chart"><canvas id="dd"></canvas></div>

<h2>Trade List</h2>
<table>
  <thead><tr>
    <th>Symbol</th><th>Entry</th><th>Exit</th><th>Side</th><th>Qty</th><th>Entry Px</th><th>Exit Px</th><th>P&amp;L</th><th>Fees</th>
  </tr></thead>
  <tbody>
    ${tradesRows || '<tr><td colspan="9">No trades</td></tr>'}
  </tbody>
</table>

<script>
const equity = ${JSON.stringify(equityData)};
const dd = ${JSON.stringify(ddData)};
new Chart(document.getElementById('eq'), {
  type: 'line',
  data: { datasets: [{ label: 'Equity', data: equity, borderColor: '#0969da', borderWidth: 1.5, pointRadius: 0 }] },
  options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time' } } }
});
new Chart(document.getElementById('dd'), {
  type: 'line',
  data: { datasets: [{ label: 'Drawdown', data: dd, borderColor: '#c62828', backgroundColor: 'rgba(198,40,40,0.2)', fill: true, borderWidth: 1, pointRadius: 0 }] },
  options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time' }, y: { ticks: { callback: v => (v*100).toFixed(0)+'%' } } } }
});
</script>
</body>
</html>`;
}

function kv(k: string, v: string): string {
  return `<div class="card"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function computeDrawdownSeries(curve: EquitySnapshot[]): Array<{ x: string; y: number }> {
  let peak = curve.length > 0 ? curve[0]!.equity : 0;
  return curve.map((s) => {
    if (s.equity > peak) peak = s.equity;
    return { x: s.ts.toISOString(), y: peak > 0 ? (s.equity - peak) / peak : 0 };
  });
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm test src/report/html-report.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/report/html-report.ts src/report/html-report.test.ts
git commit -m "feat(report): self-contained HTML report with equity, drawdown, trade list"
```

---

## Task 20: CLI (commander) — fetch, backtest, cache-info

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/commands/fetch.ts`
- Create: `src/cli/commands/backtest.ts`
- Create: `src/cli/commands/cache-info.ts`
- Create: `src/strategies/registry.ts` (strategy name → constructor lookup)
- Test: `src/cli/commands/cache-info.test.ts` (smoke test of one command)

- [ ] **Step 1: Implement strategies registry**

`src/strategies/registry.ts`:

```ts
import type { StrategyConstructor } from './strategy';
import { SmaCrossover } from './sma-crossover';

const REGISTRY: Record<string, StrategyConstructor> = {
  SmaCrossover,
};

export function resolveStrategy(name: string): StrategyConstructor {
  const ctor = REGISTRY[name];
  if (!ctor) {
    throw new Error(`Unknown strategy: ${name}. Known: ${Object.keys(REGISTRY).join(', ')}`);
  }
  return ctor;
}

export function registerStrategy(name: string, ctor: StrategyConstructor): void {
  REGISTRY[name] = ctor;
}
```

- [ ] **Step 2: Implement cache-info command**

`src/cli/commands/cache-info.ts`:

```ts
import { CandleStore } from '../../data/candle-store';

export interface CacheInfoArgs {
  dbPath: string;
  symbol?: string;
}

export interface CoverageReport {
  symbol: string;
  interval: string;
  from: string;
  to: string;
}

export async function cacheInfo(args: CacheInfoArgs): Promise<CoverageReport[]> {
  const store = await CandleStore.open(args.dbPath);
  try {
    // List coverage for all (symbol, interval) pairs the store has seen
    const reports: CoverageReport[] = [];
    const intervals = ['1minute', '3minute', '5minute', '10minute', '15minute', '30minute', '60minute', 'day'] as const;
    const symbols = args.symbol ? [args.symbol] : await store.allSymbols();
    for (const s of symbols) {
      for (const i of intervals) {
        const ranges = await store.coverage(s, i);
        for (const r of ranges) {
          reports.push({ symbol: s, interval: i, from: r.from.toISOString(), to: r.to.toISOString() });
        }
      }
    }
    return reports;
  } finally {
    await store.close();
  }
}
```

- [ ] **Step 3: Add `allSymbols()` to CandleStore**

Edit `src/data/candle-store.ts`: append method to the class.

```ts
  async allSymbols(): Promise<string[]> {
    const reader = await this.conn.runAndReadAll(`SELECT DISTINCT symbol FROM candles ORDER BY symbol`);
    const rows = reader.getRowObjects() as Array<{ symbol: string }>;
    return rows.map((r) => r.symbol);
  }
```

- [ ] **Step 4: Write smoke test for cache-info**

`src/cli/commands/cache-info.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandleStore } from '../../data/candle-store';
import { cacheInfo } from './cache-info';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-'));
  dbPath = join(dir, 'd.duckdb');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cacheInfo', () => {
  it('returns coverage rows from the store', async () => {
    const store = await CandleStore.open(dbPath);
    await store.upsert([{ symbol: 'R', ts: new Date('2025-01-02T03:45:00Z'), interval: '5minute', open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    await store.recordCoverage('R', '5minute', new Date('2025-01-01T00:00:00Z'), new Date('2025-01-31T00:00:00Z'));
    await store.close();
    const rows = await cacheInfo({ dbPath });
    expect(rows.length).toBeGreaterThan(0);
    const r = rows.find((x) => x.symbol === 'R')!;
    expect(r.interval).toBe('5minute');
  });
});
```

- [ ] **Step 5: Run test, expect PASS**

Run: `pnpm test src/cli/commands/cache-info.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 6: Implement fetch command**

`src/cli/commands/fetch.ts`:

```ts
import { KiteConnect } from 'kiteconnect';
import { CandleStore } from '../../data/candle-store';
import { InstrumentStore } from '../../data/instrument-store';
import { KiteClient } from '../../data/kite-client';
import { DataLoader } from '../../data/data-loader';
import type { Interval } from '../../types';
import type { Logger } from '../../util/logger';
import { parseEnv } from '../../config/env';

export interface FetchArgs {
  dbPath: string;
  instrumentsPath: string;
  symbol: string;
  exchange?: string;
  from: Date;
  to: Date;
  interval: Interval;
  logger: Logger;
}

export async function fetchCandles(args: FetchArgs): Promise<number> {
  const env = parseEnv();
  const kite = new KiteConnect({ api_key: env.KITE_API_KEY });
  kite.setAccessToken(env.KITE_ACCESS_TOKEN);

  const candleStore = await CandleStore.open(args.dbPath);
  const instrumentStore = await InstrumentStore.open(args.instrumentsPath);
  try {
    const exchange = args.exchange ?? 'NSE';
    let resolved = await instrumentStore.resolve(args.symbol, exchange);
    if (!resolved) {
      args.logger.info({ symbol: args.symbol, exchange }, 'instrument not in cache; fetching instruments dump');
      const dump = await kite.getInstruments(exchange);
      const rows = (dump as Array<Record<string, unknown>>).map((r) => ({
        instrumentToken: Number(r.instrument_token),
        tradingsymbol: String(r.tradingsymbol),
        exchange: String(r.exchange),
        segment: String(r.segment ?? ''),
        instrumentType: String(r.instrument_type ?? ''),
      }));
      await instrumentStore.upsert(rows);
      resolved = await instrumentStore.resolve(args.symbol, exchange);
      if (!resolved) throw new Error(`symbol not found in ${exchange} instruments: ${args.symbol}`);
    }

    const client = new KiteClient({
      kite: {
        getHistoricalData: (token, interval, from, to) =>
          kite.getHistoricalData(token, interval, from, to) as Promise<unknown[]>,
      },
    });

    const loader = new DataLoader({
      kite: client,
      store: candleStore,
      resolveSymbol: async (sym) => (await instrumentStore.resolve(sym, exchange)) ?? Promise.reject(new Error(`unknown symbol: ${sym}`)),
    });

    const rows = await loader.load(args.symbol, args.from, args.to, args.interval);
    args.logger.info({ symbol: args.symbol, count: rows.length }, 'fetch complete');
    return rows.length;
  } finally {
    await candleStore.close();
    await instrumentStore.close();
  }
}
```

- [ ] **Step 7: Implement backtest command**

`src/cli/commands/backtest.ts`:

```ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CandleStore } from '../../data/candle-store';
import { InstrumentStore } from '../../data/instrument-store';
import { KiteClient } from '../../data/kite-client';
import { DataLoader } from '../../data/data-loader';
import { BacktestEngine } from '../../engine/backtest-engine';
import { Portfolio } from '../../engine/portfolio';
import { BrokerSim } from '../../engine/broker-sim';
import { OrderRouter } from '../../engine/order-router';
import { IndicatorRegistry } from '../../indicators/registry';
import { resolveStrategy } from '../../strategies/registry';
import { zerodhaIntraday, zeroBrokerage } from '../../engine/brokerage/zerodha-intraday';
import { computeMetrics, buildTrades } from '../../report/metrics';
import { renderHtml } from '../../report/html-report';
import { loadRunConfig, type RunConfig } from '../../types/run-config';
import { createLogger, makeRunId } from '../../util/logger';
import { KiteConnect } from 'kiteconnect';
import { parseEnv } from '../../config/env';
import type { Candle } from '../../types';

export interface BacktestCliArgs {
  configPath: string;
  dbPath: string;
  instrumentsPath: string;
  reportsDir: string;
  fetchOnDemand: boolean; // if true, fetch missing data; else use only cached
}

export async function runBacktestCli(args: BacktestCliArgs): Promise<{ runId: string; reportPath: string; finalEquity: number }> {
  const cfg: RunConfig = loadRunConfig(args.configPath);
  const runId = makeRunId(cfg.strategy);
  const logger = createLogger({ runId });

  const candleStore = await CandleStore.open(args.dbPath);
  const instrumentStore = await InstrumentStore.open(args.instrumentsPath);

  try {
    let allBars: Candle[] = [];
    if (args.fetchOnDemand) {
      const env = parseEnv();
      const kite = new KiteConnect({ api_key: env.KITE_API_KEY });
      kite.setAccessToken(env.KITE_ACCESS_TOKEN);
      const client = new KiteClient({
        kite: {
          getHistoricalData: (token, interval, from, to) =>
            kite.getHistoricalData(token, interval, from, to) as Promise<unknown[]>,
        },
      });
      const loader = new DataLoader({
        kite: client,
        store: candleStore,
        resolveSymbol: async (s) => (await instrumentStore.resolve(s, 'NSE')) ?? Promise.reject(new Error(`unknown symbol: ${s}`)),
      });
      const warmupMs = approximateWarmupWindowMs(cfg.interval, cfg.warmup_bars);
      const fromWithWarmup = new Date(new Date(cfg.from).getTime() - warmupMs);
      const to = new Date(`${cfg.to}T00:00:00Z`);
      for (const symbol of cfg.symbols) {
        const bars = await loader.load(symbol, fromWithWarmup, to, cfg.interval);
        allBars = allBars.concat(bars);
      }
    } else {
      const warmupMs = approximateWarmupWindowMs(cfg.interval, cfg.warmup_bars);
      const fromWithWarmup = new Date(new Date(cfg.from).getTime() - warmupMs);
      const to = new Date(`${cfg.to}T00:00:00Z`);
      for (const symbol of cfg.symbols) {
        const bars = await candleStore.query(symbol, fromWithWarmup, to, cfg.interval);
        allBars = allBars.concat(bars);
      }
    }
    allBars.sort((a, b) => a.ts.getTime() - b.ts.getTime());

    const Strategy = resolveStrategy(cfg.strategy);
    const strategy = new Strategy();
    const portfolio = new Portfolio(cfg.capital);
    const broker = new BrokerSim({
      slippageBps: cfg.slippage_bps,
      brokerage: cfg.brokerage === 'zero' ? zeroBrokerage : zerodhaIntraday,
    });
    const router = new OrderRouter({ squareoffTime: cfg.squareoff_time });
    const indicators = new IndicatorRegistry();

    const result = new BacktestEngine({
      candles: allBars,
      strategy,
      portfolio,
      broker,
      router,
      indicators,
      logger,
      warmupBars: cfg.warmup_bars,
      params: { ...cfg.params, symbols: cfg.symbols },
    }).run();

    const trades = buildTrades(result.fills);
    const metrics = computeMetrics({
      equityCurve: result.equityCurve,
      trades,
      initialCapital: cfg.capital,
    });

    const html = renderHtml({
      runId,
      strategy: cfg.strategy,
      symbols: cfg.symbols,
      from: cfg.from,
      to: cfg.to,
      interval: cfg.interval,
      metrics,
      equityCurve: result.equityCurve,
      trades,
    });

    mkdirSync(args.reportsDir, { recursive: true });
    const reportPath = join(args.reportsDir, `${runId}.html`);
    writeFileSync(reportPath, html);
    logger.info({ reportPath, finalEquity: metrics.finalEquity }, 'backtest complete');
    return { runId, reportPath, finalEquity: metrics.finalEquity };
  } finally {
    await candleStore.close();
    await instrumentStore.close();
  }
}

function approximateWarmupWindowMs(interval: string, bars: number): number {
  const minPerBar: Record<string, number> = {
    '1minute': 1, '3minute': 3, '5minute': 5, '10minute': 10, '15minute': 15, '30minute': 30, '60minute': 60, day: 24 * 60,
  };
  const m = minPerBar[interval] ?? 5;
  // Multiply by 2 to be generous about non-trading hours
  return bars * m * 60_000 * 2;
}
```

- [ ] **Step 8: Implement CLI entry**

`src/cli/index.ts`:

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { join } from 'node:path';
import { fetchCandles } from './commands/fetch';
import { runBacktestCli } from './commands/backtest';
import { cacheInfo } from './commands/cache-info';
import { createLogger, makeRunId } from '../util/logger';
import type { Interval } from '../types';

const program = new Command();
program.name('mikasa').description('Algo trading bot CLI').version('0.0.1');

const DATA_DIR = process.env.MIKASA_DATA_DIR ?? join(process.cwd(), 'data-cache');
const REPORTS_DIR = process.env.MIKASA_REPORTS_DIR ?? join(process.cwd(), 'reports');
const DB_PATH = join(DATA_DIR, 'candles.duckdb');
const INSTRUMENTS_PATH = join(DATA_DIR, 'instruments.duckdb');

program
  .command('fetch')
  .argument('<symbol>', 'tradingsymbol, e.g. RELIANCE')
  .argument('<from>', 'YYYY-MM-DD')
  .argument('<to>', 'YYYY-MM-DD')
  .argument('<interval>', '1minute|5minute|15minute|day|...')
  .option('--exchange <ex>', 'exchange', 'NSE')
  .action(async (symbol: string, from: string, to: string, interval: string, opts: { exchange: string }) => {
    const logger = createLogger({ runId: makeRunId('fetch') });
    const n = await fetchCandles({
      dbPath: DB_PATH,
      instrumentsPath: INSTRUMENTS_PATH,
      symbol,
      exchange: opts.exchange,
      from: new Date(`${from}T00:00:00Z`),
      to: new Date(`${to}T00:00:00Z`),
      interval: interval as Interval,
      logger,
    });
    process.stdout.write(`Fetched: ${n} bars\n`);
  });

program
  .command('backtest')
  .argument('<config>', 'path to YAML run-config')
  .option('--no-fetch', 'do not fetch missing data; fail if cache is short')
  .action(async (configPath: string, opts: { fetch: boolean }) => {
    const res = await runBacktestCli({
      configPath,
      dbPath: DB_PATH,
      instrumentsPath: INSTRUMENTS_PATH,
      reportsDir: REPORTS_DIR,
      fetchOnDemand: opts.fetch !== false,
    });
    process.stdout.write(`Run: ${res.runId}\nReport: ${res.reportPath}\nFinal equity: ${res.finalEquity}\n`);
  });

program
  .command('cache-info')
  .option('--symbol <s>', 'filter by symbol')
  .action(async (opts: { symbol?: string }) => {
    const rows = await cacheInfo({ dbPath: DB_PATH, symbol: opts.symbol });
    if (rows.length === 0) {
      process.stdout.write('Cache is empty.\n');
      return;
    }
    process.stdout.write('symbol\tinterval\tfrom\tto\n');
    for (const r of rows) {
      process.stdout.write(`${r.symbol}\t${r.interval}\t${r.from}\t${r.to}\n`);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 9: Verify CLI compiles and `--help` works**

Run: `pnpm typecheck`
Expected: no errors.

Run: `pnpm cli -- --help`
Expected: prints command list (`fetch`, `backtest`, `cache-info`).

Run: `pnpm cli -- cache-info`
Expected: `Cache is empty.` (since no data has been cached yet in a clean repo).

- [ ] **Step 10: Commit**

```bash
git add src/cli src/strategies/registry.ts src/data/candle-store.ts
git commit -m "feat(cli): commander-based CLI with fetch, backtest, and cache-info commands"
```

---

## Task 21: Integration test (end-to-end backtest on fixture CSV)

**Files:**
- Create: `test/fixtures/reliance-5min-2025-01.csv`
- Create: `test/integration/backtest.e2e.test.ts`

- [ ] **Step 1: Generate the fixture CSV**

Write a tiny script to create a deterministic synthetic 1-month 5-min RELIANCE series. For reproducibility, generate it with a fixed PRNG and check it in. Run once, then commit the output.

Create `test/fixtures/generate-fixture.mjs`:

```js
// Run: node test/fixtures/generate-fixture.mjs > test/fixtures/reliance-5min-2025-01.csv
// Deterministic synthetic OHLCV with seeded PRNG for the 2025-01 NSE intraday session.

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(42);
const start = new Date('2025-01-02T03:45:00Z'); // 09:15 IST
const sessionsPerDay = 75; // 09:15..15:30 in 5min
const businessDays = 22;
let price = 1200;

console.log('symbol,ts_iso,interval,open,high,low,close,volume');
for (let d = 0; d < businessDays; d++) {
  for (let i = 0; i < sessionsPerDay; i++) {
    const ts = new Date(start.getTime() + d * 24 * 60 * 60_000 + i * 5 * 60_000).toISOString();
    const open = price;
    const drift = (rng() - 0.5) * 4; // ±2
    price = Math.max(1, price + drift);
    const close = price;
    const high = Math.max(open, close) + rng() * 1.5;
    const low = Math.min(open, close) - rng() * 1.5;
    const volume = Math.floor(1000 + rng() * 5000);
    console.log(`RELIANCE,${ts},5minute,${open.toFixed(2)},${high.toFixed(2)},${low.toFixed(2)},${close.toFixed(2)},${volume}`);
  }
}
```

Then run:

```bash
node test/fixtures/generate-fixture.mjs > test/fixtures/reliance-5min-2025-01.csv
```

- [ ] **Step 2: Write the integration test**

`test/integration/backtest.e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CandleStore } from '../../src/data/candle-store';
import { InstrumentStore } from '../../src/data/instrument-store';
import { runBacktestCli } from '../../src/cli/commands/backtest';
import type { Candle } from '../../src/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

let dir: string;
let dbPath: string;
let instrumentsPath: string;
let cfgPath: string;
let reportsDir: string;

function parseFixture(path: string): Candle[] {
  const text = readFileSync(path, 'utf8').trim();
  const lines = text.split('\n').slice(1); // skip header
  return lines.map((line) => {
    const [symbol, ts, interval, open, high, low, close, volume] = line.split(',');
    return {
      symbol: symbol!,
      ts: new Date(ts!),
      interval: interval as Candle['interval'],
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    };
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  dbPath = join(dir, 'candles.duckdb');
  instrumentsPath = join(dir, 'instruments.duckdb');
  cfgPath = join(dir, 'cfg.yaml');
  reportsDir = join(dir, 'reports');
  // Seed candle store from fixture
  const candles = parseFixture(resolve(__dirname, '../fixtures/reliance-5min-2025-01.csv'));
  const cs = await CandleStore.open(dbPath);
  await cs.upsert(candles);
  // Record coverage for the full month
  const from = candles[0]!.ts;
  const to = candles[candles.length - 1]!.ts;
  await cs.recordCoverage('RELIANCE', '5minute', from, new Date(to.getTime() + 5 * 60_000));
  await cs.close();
  // Seed instrument store
  const is = await InstrumentStore.open(instrumentsPath);
  await is.upsert([{ instrumentToken: 738561, tradingsymbol: 'RELIANCE', exchange: 'NSE', segment: 'NSE', instrumentType: 'EQ' }]);
  await is.close();
  // Write run-config
  writeFileSync(
    cfgPath,
    [
      'strategy: SmaCrossover',
      'params: { fast: 9, slow: 21 }',
      'symbols: [RELIANCE]',
      'from: 2025-01-02',
      'to: 2025-01-31',
      'interval: 5minute',
      'capital: 100000',
      'slippage_bps: 5',
      'brokerage: zerodha-intraday',
      'warmup_bars: 50',
      'squareoff_time: "15:15"',
      'seed: 42',
    ].join('\n'),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('backtest e2e', () => {
  it('runs against fixture CSV and produces an HTML report', async () => {
    const res = await runBacktestCli({
      configPath: cfgPath,
      dbPath,
      instrumentsPath,
      reportsDir,
      fetchOnDemand: false,
    });
    expect(res.runId).toMatch(/SmaCrossover/);
    expect(Number.isFinite(res.finalEquity)).toBe(true);
    const html = readFileSync(res.reportPath, 'utf8');
    expect(html).toContain('SmaCrossover');
    expect(html).toContain('Equity Curve');
    expect(html).not.toContain('NaN');
  });

  it('is deterministic: two runs produce identical final equity', async () => {
    const res1 = await runBacktestCli({ configPath: cfgPath, dbPath, instrumentsPath, reportsDir, fetchOnDemand: false });
    const res2 = await runBacktestCli({ configPath: cfgPath, dbPath, instrumentsPath, reportsDir, fetchOnDemand: false });
    expect(res1.finalEquity).toBe(res2.finalEquity);
  });
});
```

- [ ] **Step 3: Run integration test**

Run: `pnpm test test/integration/backtest.e2e.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 4: Commit**

```bash
git add test/fixtures test/integration
git commit -m "test(integration): end-to-end backtest on deterministic fixture CSV"
```

---

## Task 22: README + CI workflow

**Files:**
- Create: `README.md`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write README.md**

```markdown
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
```

- [ ] **Step 2: Write CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add README.md .github/workflows/ci.yml
git commit -m "chore: add README and CI workflow (typecheck + lint + test)"
```

---

## Done

After all tasks pass, you should have:

- A clean monorepo at `/Users/vikas/sbx/mikasa` with strict TS, full test coverage on each unit
- A working CLI that can `fetch`, `backtest`, and `cache-info`
- An end-to-end deterministic integration test on a checked-in fixture
- A self-contained HTML report per backtest run
- CI that gates on typecheck + lint + test

Open questions for milestone 2 (paper / live) are intentionally out of scope here.
