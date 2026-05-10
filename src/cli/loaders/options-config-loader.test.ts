import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstrumentStore } from '../../data/instrument-store';
import {
  buildShortStraddleAtmContracts,
  buildIronCondorWeeklyContracts,
  type CandleStoreLike,
} from './options-config-loader';
import type { Candle } from '../../types';
import type { OptionContract } from '../../types/options';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Build a UTC Date corresponding to IST HH:MM on the given IST calendar date. */
function istBarTs(ymd: string, hhmm: string): Date {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, hh!, mm!) - IST_OFFSET_MS);
}

/** Build a single 1-minute spot candle. */
function spotBar(ymd: string, hhmm: string, close: number, symbol = 'NIFTY 50'): Candle {
  return {
    symbol,
    ts: istBarTs(ymd, hhmm),
    interval: '1minute',
    open: close,
    high: close + 5,
    low: close - 5,
    close,
    volume: 0,
  };
}

/** Minimal CandleStoreLike that returns canned bars filtered by symbol/window. */
function fakeCandleStore(bars: Candle[]): CandleStoreLike {
  return {
    async query(symbol, from, to, _interval) {
      return bars
        .filter((b) => b.symbol === symbol && b.ts >= from && b.ts < to)
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
    },
  };
}

const noopLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

let dir: string;
let store: InstrumentStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opt-loader-'));
  store = await InstrumentStore.open(join(dir, 'i.duckdb'));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** Helper to seed a single (CE, PE) pair at a given strike+expiry. */
async function seedPair(
  expiry: Date,
  strike: number,
  baseToken: number,
): Promise<{ ce: OptionContract; pe: OptionContract }> {
  const ce: OptionContract = {
    symbol: `NIFTY-${strike}-CE-${baseToken}`,
    underlying: 'NIFTY',
    expiry,
    strike,
    optionType: 'CE',
    lotSize: 75,
    instrumentToken: baseToken,
  };
  const pe: OptionContract = { ...ce, symbol: `NIFTY-${strike}-PE-${baseToken}`, optionType: 'PE', instrumentToken: baseToken + 1 };
  await store.addOption(ce);
  await store.addOption(pe);
  return { ce, pe };
}

describe('buildShortStraddleAtmContracts', () => {
  it('builds atmContracts for each expiry in window', async () => {
    // Two weekly Thursday expiries in late May 2025.
    const expiry1 = new Date(Date.UTC(2025, 4, 22, 10, 0, 0)); // 2025-05-22
    const expiry2 = new Date(Date.UTC(2025, 4, 29, 10, 0, 0)); // 2025-05-29

    // Seed ATM ± 2 strikes for each expiry. ATM = 22000.
    let token = 1000;
    for (const expiry of [expiry1, expiry2]) {
      for (const strike of [21900, 21950, 22000, 22050, 22100]) {
        await seedPair(expiry, strike, token);
        token += 10;
      }
    }

    // Spot bar at 09:20 IST on each expiry day, close = 22000 (clean ATM).
    const candles = fakeCandleStore([
      spotBar('2025-05-22', '09:20', 22000),
      spotBar('2025-05-22', '09:21', 22005),
      spotBar('2025-05-29', '09:20', 21998), // rounds to 22000
      spotBar('2025-05-29', '09:21', 22001),
    ]);

    const result = await buildShortStraddleAtmContracts({
      underlying: 'NIFTY',
      spotSymbol: 'NIFTY 50',
      entryTime: '09:20',
      from: new Date('2025-05-01T00:00:00Z'),
      to: new Date('2025-06-01T00:00:00Z'),
      step: 50,
      instruments: store,
      candles,
      logger: noopLogger,
    });

    expect(Object.keys(result).sort()).toEqual(['2025-05-22', '2025-05-29']);
    expect(result['2025-05-22']!.ce.strike).toBe(22000);
    expect(result['2025-05-22']!.ce.optionType).toBe('CE');
    expect(result['2025-05-22']!.pe.strike).toBe(22000);
    expect(result['2025-05-22']!.pe.optionType).toBe('PE');
    expect(result['2025-05-29']!.ce.strike).toBe(22000);
    expect(result['2025-05-29']!.pe.strike).toBe(22000);
  });

  it('skips expiry when no spot bar at entryTime', async () => {
    const expiry = new Date(Date.UTC(2025, 4, 22, 10, 0, 0));
    await seedPair(expiry, 22000, 1000);

    // No spot bars at all.
    const candles = fakeCandleStore([]);
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

    const result = await buildShortStraddleAtmContracts({
      underlying: 'NIFTY',
      spotSymbol: 'NIFTY 50',
      entryTime: '09:20',
      from: new Date('2025-05-01T00:00:00Z'),
      to: new Date('2025-06-01T00:00:00Z'),
      step: 50,
      instruments: store,
      candles,
      logger,
    });

    expect(Object.keys(result)).toHaveLength(0);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledTimes(1);
  });

  it('skips expiry when ATM contract not in instrument store', async () => {
    const expiry = new Date(Date.UTC(2025, 4, 22, 10, 0, 0));
    // Seed only ATM-50, not ATM=22000.
    await seedPair(expiry, 21950, 1000);

    const candles = fakeCandleStore([spotBar('2025-05-22', '09:20', 22000)]);
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

    const result = await buildShortStraddleAtmContracts({
      underlying: 'NIFTY',
      spotSymbol: 'NIFTY 50',
      entryTime: '09:20',
      from: new Date('2025-05-01T00:00:00Z'),
      to: new Date('2025-06-01T00:00:00Z'),
      step: 50,
      instruments: store,
      candles,
      logger,
    });

    expect(Object.keys(result)).toHaveLength(0);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledTimes(1);
  });
});

describe('buildIronCondorWeeklyContracts', () => {
  it('builds weeklyContracts with offset+wing', async () => {
    // Thursday expiry 2025-05-22. Monday of that week is 2025-05-19.
    const expiry = new Date(Date.UTC(2025, 4, 22, 10, 0, 0));

    // Seed ATM ± 5 strikes (50-step) so offset 200 + wing 100 lands inside.
    // ATM = 22000; shortCall=22200, longCall=22300, shortPut=21800, longPut=21700.
    let token = 2000;
    for (const strike of [21700, 21750, 21800, 21850, 21900, 21950, 22000, 22050, 22100, 22150, 22200, 22250, 22300]) {
      await seedPair(expiry, strike, token);
      token += 10;
    }

    // Monday spot bar at 09:30 IST.
    const candles = fakeCandleStore([
      spotBar('2025-05-19', '09:30', 22000),
      spotBar('2025-05-19', '09:31', 22005),
    ]);

    const result = await buildIronCondorWeeklyContracts({
      underlying: 'NIFTY',
      spotSymbol: 'NIFTY 50',
      entryDay: 'monday',
      entryTime: '09:30',
      shortStrikeOffset: 200,
      wingWidth: 100,
      from: new Date('2025-05-01T00:00:00Z'),
      to: new Date('2025-06-01T00:00:00Z'),
      step: 50,
      instruments: store,
      candles,
      logger: noopLogger,
    });

    const keys = Object.keys(result);
    expect(keys).toHaveLength(1);
    const week = result[keys[0]!]!;
    expect(week.shortCall.strike).toBe(22200);
    expect(week.shortCall.optionType).toBe('CE');
    expect(week.longCall.strike).toBe(22300);
    expect(week.longCall.optionType).toBe('CE');
    expect(week.shortPut.strike).toBe(21800);
    expect(week.shortPut.optionType).toBe('PE');
    expect(week.longPut.strike).toBe(21700);
    expect(week.longPut.optionType).toBe('PE');

    // Sanity: weekKey is consistent with the strategy's istParts formula.
    // For a Monday (2025-05-19) bar, the iron-condor's istParts produces
    // 2025-W21 — the loader must produce the SAME key.
    expect(keys[0]).toBe('2025-W21');
  });
});
