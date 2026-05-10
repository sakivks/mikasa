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
