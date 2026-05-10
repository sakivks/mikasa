import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandleStore } from './candle-store';
import { DataLoader } from './data-loader';
import type { Candle } from '../types';
import type { FetchHistoricalArgs, HistoricalSource } from './source';

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
  it('on cache miss fetches from source and upserts', async () => {
    const fetched: string[] = [];
    const fakeSource: HistoricalSource = {
      async getHistorical(args: FetchHistoricalArgs) {
        fetched.push(`${args.symbol}:${args.from.toISOString()}->${args.to.toISOString()}`);
        return sampleBars(args.symbol, '2025-01-02T03:45:00Z', 5);
      },
    };
    const loader = new DataLoader({ source: fakeSource, store });
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
    const fakeSource: HistoricalSource = {
      async getHistorical(args: FetchHistoricalArgs) {
        fetched.push({ from: args.from, to: args.to });
        return sampleBars(args.symbol, args.from.toISOString(), 2);
      },
    };
    const loader = new DataLoader({ source: fakeSource, store });
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
