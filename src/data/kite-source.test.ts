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
});
