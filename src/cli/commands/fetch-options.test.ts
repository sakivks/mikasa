import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchOptions, buildOptionSymbol } from './fetch-options';
import type { OptionContract, Underlying } from '../../types/options';
import type { Candle, Interval } from '../../types';

let dir: string;
let bhavcopyDir: string;
let tokenMapPath: string;

const sampleCsv = [
  'INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP',
  'OPTIDX,NIFTY,22-MAY-2025,22000,CE,150,160,140,145,145,1000,109.50,5000,200,15-MAY-2025',
  'OPTIDX,NIFTY,22-MAY-2025,22000,PE,140,150,130,135,135,900,91.13,4500,150,15-MAY-2025',
  'OPTIDX,NIFTY,22-MAY-2025,22050,CE,120,130,110,115,115,800,80.00,3000,100,15-MAY-2025',
  'OPTIDX,NIFTY,22-MAY-2025,22050,PE,120,130,110,115,115,800,80.00,3000,100,15-MAY-2025',
  'OPTIDX,BANKNIFTY,21-MAY-2025,50000,CE,300,310,290,295,295,500,103.25,2000,100,15-MAY-2025',
  'OPTSTK,RELIANCE,29-MAY-2025,1300,CE,40,42,38,40,40,100,4.00,500,50,15-MAY-2025',
].join('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fetchopt-'));
  bhavcopyDir = join(dir, 'bhav');
  mkdirSync(bhavcopyDir, { recursive: true });
  writeFileSync(join(bhavcopyDir, 'fo01MAY2025bhav.csv'), sampleCsv);

  tokenMapPath = join(dir, 'tokens.json');
  // New tokenMap shape: per-key object carrying both token and lotSize.
  const tokenMap: Record<string, { token: number; lotSize: number }> = {
    'NIFTY|2025-05-22T10:00:00.000Z|22000|CE': { token: 11111, lotSize: 75 },
    'NIFTY|2025-05-22T10:00:00.000Z|22000|PE': { token: 11112, lotSize: 75 },
    'NIFTY|2025-05-22T10:00:00.000Z|22050|CE': { token: 11113, lotSize: 75 },
    'NIFTY|2025-05-22T10:00:00.000Z|22050|PE': { token: 11114, lotSize: 75 },
  };
  writeFileSync(tokenMapPath, JSON.stringify(tokenMap));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const makeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
});

describe('buildOptionSymbol', () => {
  it('synthesizes the hyphenated full-date format', () => {
    const sym = buildOptionSymbol({
      underlying: 'NIFTY',
      expiry: new Date('2025-05-22T10:00:00.000Z'),
      strike: 22000,
      optionType: 'CE',
    });
    expect(sym).toBe('NIFTY-2025-05-22-22000-CE');
  });

  it('rounds non-integer strikes', () => {
    const sym = buildOptionSymbol({
      underlying: 'BANKNIFTY',
      expiry: new Date('2025-05-22T10:00:00.000Z'),
      strike: 50000.0,
      optionType: 'PE',
    });
    expect(sym).toBe('BANKNIFTY-2025-05-22-50000-PE');
  });

  it('encodes each weekly expiry uniquely (no per-month collapse)', () => {
    const w1 = buildOptionSymbol({
      underlying: 'NIFTY',
      expiry: new Date('2025-05-08T10:00:00.000Z'),
      strike: 22000,
      optionType: 'CE',
    });
    const w2 = buildOptionSymbol({
      underlying: 'NIFTY',
      expiry: new Date('2025-05-15T10:00:00.000Z'),
      strike: 22000,
      optionType: 'CE',
    });
    const w3 = buildOptionSymbol({
      underlying: 'NIFTY',
      expiry: new Date('2025-05-22T10:00:00.000Z'),
      strike: 22000,
      optionType: 'CE',
    });
    const w4 = buildOptionSymbol({
      underlying: 'NIFTY',
      expiry: new Date('2025-05-29T10:00:00.000Z'),
      strike: 22000,
      optionType: 'CE',
    });
    expect(new Set([w1, w2, w3, w4]).size).toBe(4);
  });
});

describe('fetchOptions', () => {
  it('hydrates instruments from bhavcopy, fetches spot once, fetches per-strike chain', async () => {
    // Mock InstrumentStore: capture addOption calls; expiries() returns the set we hydrated
    const added: OptionContract[] = [];
    const findMap = new Map<string, OptionContract>();
    const instruments = {
      addOption: vi.fn(async (c: OptionContract) => {
        added.push(c);
        const k = `${c.underlying}|${c.expiry.toISOString()}|${c.strike}|${c.optionType}`;
        findMap.set(k, c);
      }),
      expiries: vi.fn(async (_u: Underlying) => {
        const set = new Set(added.map((c) => c.expiry.getTime()));
        return Array.from(set)
          .sort((a, b) => a - b)
          .map((t) => new Date(t));
      }),
      findOption: vi.fn(async (u: Underlying, exp: Date, strike: number, t: 'CE' | 'PE') => {
        return findMap.get(`${u}|${exp.toISOString()}|${strike}|${t}`) ?? null;
      }),
    };

    // Mock CandleStore: capture upsert / coverage
    const upserted: Candle[] = [];
    const coverages: Array<{ symbol: string; from: Date; to: Date }> = [];
    const candles = {
      upsert: vi.fn(async (rows: Candle[]) => {
        upserted.push(...rows);
      }),
      recordCoverage: vi.fn(async (symbol: string, _i: Interval, from: Date, to: Date) => {
        coverages.push({ symbol, from, to });
      }),
    };

    // Mock KiteSource: spot returns one open bar at 04:00 UTC; option fetches return one bar each
    const fetchCalls: Array<{ token: number; from: Date; to: Date }> = [];
    const source = {
      fetchOptionCandles: vi.fn(
        async (token: number, from: Date, to: Date, _interval: Interval): Promise<Candle[]> => {
          fetchCalls.push({ token, from, to });
          if (token === 256265) {
            // Spot: one bar at 04:00 UTC on expiry day with close=22030
            return [
              {
                symbol: `TOKEN-${token}`,
                ts: new Date('2025-05-22T04:00:00.000Z'),
                interval: '1minute',
                open: 22030,
                high: 22035,
                low: 22025,
                close: 22030,
                volume: 1000,
              },
            ];
          }
          // Option contract
          return [
            {
              symbol: `TOKEN-${token}`,
              ts: new Date('2025-05-22T04:00:00.000Z'),
              interval: '1minute',
              open: 100,
              high: 105,
              low: 95,
              close: 100,
              volume: 50,
            },
          ];
        },
      ),
    };

    await fetchOptions(
      'NIFTY',
      new Date('2025-05-01T00:00:00Z'),
      new Date('2025-05-31T00:00:00Z'),
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        source: source as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        instruments: instruments as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        candles: candles as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: makeLogger() as any,
        tokenMapPath,
        bhavcopyDir,
        atmRange: 1, // restrict so chain = ATM ± 1 step (3 strikes × 2 types = 6, but only 4 strikes hydrated)
      },
    );

    // Hydration: NIFTY-only bhav rows in the window, BANKNIFTY excluded by underlying filter
    expect(added).toHaveLength(4);
    expect(added.every((c) => c.underlying === 'NIFTY')).toBe(true);
    expect(added.map((c) => c.symbol).sort()).toEqual([
      'NIFTY-2025-05-22-22000-CE',
      'NIFTY-2025-05-22-22000-PE',
      'NIFTY-2025-05-22-22050-CE',
      'NIFTY-2025-05-22-22050-PE',
    ]);
    // lotSize must come from the tokenMap entry, not from a hardcoded constant.
    expect(added.every((c) => c.lotSize === 75)).toBe(true);
    expect(added.find((c) => c.strike === 22000 && c.optionType === 'CE')!.instrumentToken).toBe(
      11111,
    );

    // Spot fetch: exactly once with the spot token, for the full window
    const spotFetches = fetchCalls.filter((f) => f.token === 256265);
    expect(spotFetches).toHaveLength(1);

    // Per-strike chain: ATM = 22050 (spot 22030 rounds to 22050 with 50 step on tie -> upper since
    // upper diff < lower diff: 20 vs 30). Actually 22030 -> lower=22000(diff 30), upper=22050(diff 20) -> 22050.
    // With atmRange=1 step=50, strikes are 22000, 22050, 22100. We hydrated only 22000 & 22050,
    // so we expect 2 strikes × 2 types = 4 option fetches.
    const optionFetches = fetchCalls.filter((f) => f.token !== 256265);
    expect(optionFetches).toHaveLength(4);
    expect(optionFetches.map((f) => f.token).sort()).toEqual([11111, 11112, 11113, 11114]);

    // Spot was relabeled to 'NIFTY 50'
    const spotBars = upserted.filter((c) => c.symbol === 'NIFTY 50');
    expect(spotBars).toHaveLength(1);

    // Option bars relabeled to synthetic symbols
    const optBars = upserted.filter((c) => c.symbol.startsWith('NIFTY-2025-05-22-'));
    expect(optBars).toHaveLength(4);
    expect(new Set(optBars.map((b) => b.symbol))).toEqual(
      new Set([
        'NIFTY-2025-05-22-22000-CE',
        'NIFTY-2025-05-22-22000-PE',
        'NIFTY-2025-05-22-22050-CE',
        'NIFTY-2025-05-22-22050-PE',
      ]),
    );

    // Coverage recorded for spot + each option
    expect(coverages.find((c) => c.symbol === 'NIFTY 50')).toBeDefined();
    expect(coverages.filter((c) => c.symbol.startsWith('NIFTY-2025-05-22-'))).toHaveLength(4);
  });

  it('reads lotSize from the tokenMap entry per expiry (not a hardcoded constant)', async () => {
    // Custom tokenMap with a non-standard lotSize (50, NIFTY's pre-Sept-2024 size).
    // Hydration must surface 50, proving lot size is not hardcoded.
    const customLot = 50;
    writeFileSync(
      tokenMapPath,
      JSON.stringify({
        'NIFTY|2025-05-22T10:00:00.000Z|22000|CE': { token: 11111, lotSize: customLot },
        'NIFTY|2025-05-22T10:00:00.000Z|22000|PE': { token: 11112, lotSize: customLot },
        'NIFTY|2025-05-22T10:00:00.000Z|22050|CE': { token: 11113, lotSize: customLot },
        'NIFTY|2025-05-22T10:00:00.000Z|22050|PE': { token: 11114, lotSize: customLot },
      }),
    );

    const added: OptionContract[] = [];
    const instruments = {
      addOption: vi.fn(async (c: OptionContract) => {
        added.push(c);
      }),
      expiries: vi.fn(async () => []),
      findOption: vi.fn(async () => null),
    };
    const candles = {
      upsert: vi.fn(),
      recordCoverage: vi.fn(),
    };
    const source = {
      fetchOptionCandles: vi.fn(async (_t: number, _f: Date, _to: Date, _i: Interval) => []),
    };

    await fetchOptions(
      'NIFTY',
      new Date('2025-05-01T00:00:00Z'),
      new Date('2025-05-31T00:00:00Z'),
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        source: source as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        instruments: instruments as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        candles: candles as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: makeLogger() as any,
        tokenMapPath,
        bhavcopyDir,
      },
    );

    expect(added).toHaveLength(4);
    expect(added.every((c) => c.lotSize === customLot)).toBe(true);
  });

  it('falls back to default lotSize when tokenMap entry is the legacy bare-number form', async () => {
    // Legacy shape: bare number (instrumentToken). Lot size comes from the
    // LOT_SIZE_FALLBACK constant — kept as a transitional safety net.
    writeFileSync(
      tokenMapPath,
      JSON.stringify({
        'NIFTY|2025-05-22T10:00:00.000Z|22000|CE': 11111,
        'NIFTY|2025-05-22T10:00:00.000Z|22000|PE': 11112,
        'NIFTY|2025-05-22T10:00:00.000Z|22050|CE': 11113,
        'NIFTY|2025-05-22T10:00:00.000Z|22050|PE': 11114,
      }),
    );

    const added: OptionContract[] = [];
    const instruments = {
      addOption: vi.fn(async (c: OptionContract) => {
        added.push(c);
      }),
      expiries: vi.fn(async () => []),
      findOption: vi.fn(async () => null),
    };
    const candles = {
      upsert: vi.fn(),
      recordCoverage: vi.fn(),
    };
    const source = {
      fetchOptionCandles: vi.fn(async (_t: number, _f: Date, _to: Date, _i: Interval) => []),
    };

    await fetchOptions(
      'NIFTY',
      new Date('2025-05-01T00:00:00Z'),
      new Date('2025-05-31T00:00:00Z'),
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        source: source as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        instruments: instruments as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        candles: candles as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: makeLogger() as any,
        tokenMapPath,
        bhavcopyDir,
      },
    );

    expect(added).toHaveLength(4);
    // Fallback for NIFTY = 75
    expect(added.every((c) => c.lotSize === 75)).toBe(true);
    expect(added.find((c) => c.strike === 22000 && c.optionType === 'CE')!.instrumentToken).toBe(
      11111,
    );
  });

  it('skips contracts with no token in the tokenMap and warns', async () => {
    // Empty tokenMap → every bhav row should be skipped with a warn
    writeFileSync(tokenMapPath, JSON.stringify({}));
    const logger = makeLogger();
    const instruments = {
      addOption: vi.fn(),
      expiries: vi.fn(async () => []),
      findOption: vi.fn(async () => null),
    };
    const candles = {
      upsert: vi.fn(),
      recordCoverage: vi.fn(),
    };
    const source = {
      fetchOptionCandles: vi.fn(async (_t: number, _f: Date, _to: Date, _i: Interval) => []),
    };

    await fetchOptions(
      'NIFTY',
      new Date('2025-05-01T00:00:00Z'),
      new Date('2025-05-31T00:00:00Z'),
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        source: source as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        instruments: instruments as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        candles: candles as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: logger as any,
        tokenMapPath,
        bhavcopyDir,
      },
    );

    expect(instruments.addOption).not.toHaveBeenCalled();
    // 4 NIFTY rows in fixture, each missing → 4 warns (plus one warn possible per loop)
    expect(logger.warn).toHaveBeenCalled();
    // Spot fetch still happened (operates on the static spot token, not on hydrated contracts)
    expect(source.fetchOptionCandles).toHaveBeenCalledWith(
      256265,
      expect.any(Date),
      expect.any(Date),
      '1minute',
    );
  });

  it('does not fetch chains for expiries outside [from, to]', async () => {
    // Set a token map but a [from, to] window that excludes 22-MAY-2025 expiry
    const instruments = {
      addOption: vi.fn(),
      expiries: vi.fn(async () => [new Date('2025-05-22T10:00:00.000Z')]),
      findOption: vi.fn(async () => null),
    };
    const candles = {
      upsert: vi.fn(),
      recordCoverage: vi.fn(),
    };
    const fetchCalls: number[] = [];
    const source = {
      fetchOptionCandles: vi.fn(async (token: number) => {
        fetchCalls.push(token);
        return [];
      }),
    };

    await fetchOptions(
      'NIFTY',
      new Date('2025-06-01T00:00:00Z'),
      new Date('2025-06-30T00:00:00Z'),
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        source: source as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        instruments: instruments as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        candles: candles as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: makeLogger() as any,
        tokenMapPath,
        bhavcopyDir,
      },
    );

    // Only the spot fetch (256265). The 22-MAY-2025 expiry is outside [Jun 1, Jun 30] → no chain fetch.
    expect(fetchCalls).toEqual([256265]);
  });
});
