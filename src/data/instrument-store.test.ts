import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstrumentStore } from './instrument-store';
import type { OptionContract } from '../types';

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

describe('options index', () => {
  it('indexes options instruments and resolves by (underlying, expiry, strike, type)', async () => {
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
    await store.addOption(ce);
    await store.addOption(pe);

    const ceFound = await store.findOption('NIFTY', expiry, 22000, 'CE');
    const peFound = await store.findOption('NIFTY', expiry, 22000, 'PE');
    const missing = await store.findOption('NIFTY', expiry, 21900, 'CE');

    expect(ceFound).toEqual(ce);
    expect(peFound).toEqual(pe);
    expect(missing).toBeNull();
  });

  it('lists distinct expiries per underlying, sorted ascending', async () => {
    const e1 = new Date('2025-05-22T10:00:00Z');
    const e2 = new Date('2025-05-29T10:00:00Z');
    await store.addOption({ symbol: 'a', underlying: 'NIFTY', expiry: e2, strike: 22000, optionType: 'CE', lotSize: 75, instrumentToken: 1 });
    await store.addOption({ symbol: 'b', underlying: 'NIFTY', expiry: e1, strike: 22000, optionType: 'CE', lotSize: 75, instrumentToken: 2 });
    await store.addOption({ symbol: 'c', underlying: 'BANKNIFTY', expiry: e1, strike: 50000, optionType: 'CE', lotSize: 35, instrumentToken: 3 });

    const niftyExpiries = await store.expiries('NIFTY');
    const bnfExpiries = await store.expiries('BANKNIFTY');

    expect(niftyExpiries.map((d) => d.toISOString())).toEqual([e1.toISOString(), e2.toISOString()]);
    expect(bnfExpiries.map((d) => d.toISOString())).toEqual([e1.toISOString()]);
  });

  it('upsert: re-adding the same key updates the row', async () => {
    const expiry = new Date('2025-05-22T10:00:00Z');
    const v1: OptionContract = { symbol: 'NIFTY25MAY22000CE', underlying: 'NIFTY', expiry, strike: 22000, optionType: 'CE', lotSize: 75, instrumentToken: 1 };
    const v2: OptionContract = { ...v1, instrumentToken: 999 };
    await store.addOption(v1);
    await store.addOption(v2);
    const found = await store.findOption('NIFTY', expiry, 22000, 'CE');
    expect(found!.instrumentToken).toBe(999);
  });
});
