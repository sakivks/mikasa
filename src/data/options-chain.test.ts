import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InstrumentStore } from './instrument-store';
import { resolveAtmChain, roundToStrike } from './options-chain';
import type { OptionContract } from '../types';

async function seedNifty(store: InstrumentStore, expiry: Date, strikes: number[]): Promise<void> {
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
      await store.addOption(c);
    }
  }
}

describe('roundToStrike', () => {
  it('rounds spot to nearest strike step, lower strike on tie', () => {
    expect(roundToStrike(22013, 50)).toBe(22000);
    expect(roundToStrike(22049, 50)).toBe(22050);
    expect(roundToStrike(22025, 50)).toBe(22000);   // tie → lower
    expect(roundToStrike(21999, 50)).toBe(22000);
  });
});

describe('resolveAtmChain', () => {
  let tmpDir: string;
  let store: InstrumentStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikasa-options-chain-'));
    store = await InstrumentStore.open(path.join(tmpDir, 'i.duckdb'));
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ATM ± n strikes (CE + PE) sorted by strike', async () => {
    const expiry = new Date('2025-05-22T10:00:00Z');
    await seedNifty(store, expiry, [21900, 21950, 22000, 22050, 22100, 22150, 22200]);
    const chain = await resolveAtmChain(store, 'NIFTY', expiry, 22000, 2, 50);
    // ATM=22000, ±2 strikes = 21900..22100, that's 5 strikes × 2 types = 10 contracts
    expect(chain).toHaveLength(10);
    const strikesReturned = Array.from(new Set(chain.map((c) => c.strike))).sort((a, b) => a - b);
    expect(strikesReturned).toEqual([21900, 21950, 22000, 22050, 22100]);
  });

  it('skips strikes missing from the store rather than throwing', async () => {
    const expiry = new Date('2025-05-22T10:00:00Z');
    await seedNifty(store, expiry, [22000, 22050]);   // only 2 strikes
    const chain = await resolveAtmChain(store, 'NIFTY', expiry, 22000, 5, 50);
    expect(chain).toHaveLength(4);              // 22000 CE/PE + 22050 CE/PE
  });
});
