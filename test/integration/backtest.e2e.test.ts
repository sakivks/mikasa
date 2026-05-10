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
