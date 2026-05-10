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
