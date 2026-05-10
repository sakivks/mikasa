import { describe, it, expect } from 'vitest';
import { KiteSource } from './kite-source';
import type { KiteClient } from './kite-client';
import type { InstrumentStore } from './instrument-store';
import type { Candle } from '../types';

const sampleCandles: Candle[] = [
  {
    symbol: 'RELIANCE',
    ts: new Date('2025-01-02T03:45:00Z'),
    interval: '5minute',
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
  },
];

describe('KiteSource', () => {
  it('resolves symbol via instruments store and forwards to kite client with the resolved token', async () => {
    const calls: Array<{
      symbol: string;
      instrumentToken: number;
      interval: string;
      from: Date;
      to: Date;
    }> = [];
    const fakeKite = {
      async getHistorical(args: {
        symbol: string;
        instrumentToken: number;
        interval: string;
        from: Date;
        to: Date;
      }): Promise<Candle[]> {
        calls.push(args);
        return sampleCandles;
      },
    } as unknown as KiteClient;
    const resolveCalls: Array<{ tradingsymbol: string; exchange: string }> = [];
    const fakeInstruments = {
      async resolve(tradingsymbol: string, exchange: string) {
        resolveCalls.push({ tradingsymbol, exchange });
        return { tradingsymbol, instrumentToken: 738561 };
      },
    } as unknown as InstrumentStore;

    const source = new KiteSource({ kite: fakeKite, instruments: fakeInstruments });
    const out = await source.getHistorical({
      symbol: 'RELIANCE',
      interval: '5minute',
      from: new Date('2025-01-02T03:00:00Z'),
      to: new Date('2025-01-02T05:00:00Z'),
    });

    expect(out).toEqual(sampleCandles);
    expect(resolveCalls).toEqual([{ tradingsymbol: 'RELIANCE', exchange: 'NSE' }]);
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({
      symbol: 'RELIANCE',
      instrumentToken: 738561,
      interval: '5minute',
    });
    expect(calls[0]!.from.toISOString()).toBe('2025-01-02T03:00:00.000Z');
    expect(calls[0]!.to.toISOString()).toBe('2025-01-02T05:00:00.000Z');
  });

  it('throws when symbol not found in instrument store', async () => {
    const fakeKite = {
      async getHistorical(): Promise<Candle[]> {
        throw new Error('should not be called');
      },
    } as unknown as KiteClient;
    const fakeInstruments = {
      async resolve() {
        return null;
      },
    } as unknown as InstrumentStore;

    const source = new KiteSource({ kite: fakeKite, instruments: fakeInstruments, exchange: 'BSE' });
    await expect(
      source.getHistorical({
        symbol: 'NOPE',
        interval: '5minute',
        from: new Date('2025-01-02T03:00:00Z'),
        to: new Date('2025-01-02T05:00:00Z'),
      }),
    ).rejects.toThrow(/unknown symbol on BSE: NOPE/);
  });

  describe('fetchOptionCandles', () => {
    it('forwards instrument token to kite client and labels candles with TOKEN-<token>', async () => {
      const calls: Array<{
        symbol: string;
        instrumentToken: number;
        interval: string;
        from: Date;
        to: Date;
      }> = [];
      const optionToken = 12345678;
      const optionCandles: Candle[] = [
        {
          symbol: `TOKEN-${optionToken}`,
          ts: new Date('2025-01-02T03:45:00Z'),
          interval: '1minute',
          open: 50.5,
          high: 52.0,
          low: 49.75,
          close: 51.25,
          volume: 200,
        },
        {
          symbol: `TOKEN-${optionToken}`,
          ts: new Date('2025-01-02T03:46:00Z'),
          interval: '1minute',
          open: 51.25,
          high: 51.5,
          low: 50.0,
          close: 50.5,
          volume: 150,
        },
      ];
      const fakeKite = {
        async getHistorical(args: {
          symbol: string;
          instrumentToken: number;
          interval: string;
          from: Date;
          to: Date;
        }): Promise<Candle[]> {
          calls.push(args);
          // Echo the symbol the caller asked for, mirroring KiteClient's own
          // labeling behavior (it stamps `args.symbol` onto each candle).
          return optionCandles.map((c) => ({ ...c, symbol: args.symbol, interval: args.interval as Candle['interval'] }));
        },
      } as unknown as KiteClient;
      const fakeInstruments = {
        async resolve() {
          throw new Error('instrument store should not be consulted for token-based fetch');
        },
      } as unknown as InstrumentStore;

      const source = new KiteSource({ kite: fakeKite, instruments: fakeInstruments });
      const from = new Date('2025-01-02T03:00:00Z');
      const to = new Date('2025-01-02T05:00:00Z');
      const out = await source.fetchOptionCandles(optionToken, from, to, '1minute');

      expect(calls.length).toBe(1);
      expect(calls[0]).toMatchObject({
        symbol: `TOKEN-${optionToken}`,
        instrumentToken: optionToken,
        interval: '1minute',
      });
      expect(calls[0]!.from.toISOString()).toBe('2025-01-02T03:00:00.000Z');
      expect(calls[0]!.to.toISOString()).toBe('2025-01-02T05:00:00.000Z');

      expect(out.length).toBe(2);
      for (const c of out) {
        expect(c.symbol).toBe(`TOKEN-${optionToken}`);
        expect(c.interval).toBe('1minute');
      }
      expect(out[0]).toMatchObject({
        open: 50.5,
        high: 52.0,
        low: 49.75,
        close: 51.25,
        volume: 200,
      });
      expect(out[1]).toMatchObject({
        open: 51.25,
        high: 51.5,
        low: 50.0,
        close: 50.5,
        volume: 150,
      });
    });
  });
});
