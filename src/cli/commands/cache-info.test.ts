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
    await store.upsert([
      {
        symbol: 'R',
        ts: new Date('2025-01-02T03:45:00Z'),
        interval: '5minute',
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
      },
    ]);
    await store.recordCoverage(
      'R',
      '5minute',
      new Date('2025-01-01T00:00:00Z'),
      new Date('2025-01-31T00:00:00Z'),
    );
    await store.close();
    const rows = await cacheInfo({ dbPath });
    expect(rows.length).toBeGreaterThan(0);
    const r = rows.find((x) => x.symbol === 'R')!;
    expect(r.interval).toBe('5minute');
  });
});
