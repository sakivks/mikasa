import { describe, it, expect } from 'vitest';
import { KiteClient } from './kite-client';
import type { Candle } from '../types';

class FakeKite {
  calls: Array<{ token: number; interval: string; from: Date; to: Date }> = [];
  failuresFirst = 0;
  constructor(private readonly responses: Array<Array<Record<string, unknown>>>) {}
  async getHistoricalData(token: number, interval: string, from: Date, to: Date): Promise<unknown[]> {
    if (this.failuresFirst > 0) {
      this.failuresFirst -= 1;
      const err = new Error('429 too many') as Error & { status?: number };
      err.status = 429;
      throw err;
    }
    this.calls.push({ token, interval, from, to });
    return this.responses[this.calls.length - 1] ?? [];
  }
}

const SAMPLE = [
  { date: new Date('2025-01-02T03:45:00Z'), open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
  { date: new Date('2025-01-02T03:50:00Z'), open: 100.5, high: 102, low: 100, close: 101.5, volume: 1500 },
];

describe('KiteClient', () => {
  it('chunks date range and concatenates results', async () => {
    const fake = new FakeKite([SAMPLE, SAMPLE]);
    const client = new KiteClient({ kite: fake as never, chunkDays: 30 });
    const candles: Candle[] = await client.getHistorical({
      symbol: 'RELIANCE',
      instrumentToken: 738561,
      interval: '5minute',
      from: new Date('2025-01-01T00:00:00Z'),
      to: new Date('2025-02-15T00:00:00Z'), // > 30 days, forces 2 chunks
    });
    expect(fake.calls.length).toBe(2);
    expect(candles.length).toBe(4);
    expect(candles[0]!.symbol).toBe('RELIANCE');
    expect(candles[0]!.interval).toBe('5minute');
  });

  it('retries on 429 with backoff (mocked sleep)', async () => {
    const fake = new FakeKite([SAMPLE]);
    fake.failuresFirst = 2;
    const sleeps: number[] = [];
    const client = new KiteClient({
      kite: fake as never,
      chunkDays: 60,
      maxRetries: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const candles = await client.getHistorical({
      symbol: 'RELIANCE',
      instrumentToken: 738561,
      interval: '5minute',
      from: new Date('2025-01-01T00:00:00Z'),
      to: new Date('2025-01-05T00:00:00Z'),
    });
    expect(candles.length).toBe(2);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('fails after max retries', async () => {
    const fake = new FakeKite([SAMPLE]);
    fake.failuresFirst = 5;
    const client = new KiteClient({
      kite: fake as never,
      chunkDays: 60,
      maxRetries: 2,
      sleep: async () => {},
    });
    await expect(
      client.getHistorical({
        symbol: 'X',
        instrumentToken: 1,
        interval: '5minute',
        from: new Date('2025-01-01T00:00:00Z'),
        to: new Date('2025-01-05T00:00:00Z'),
      }),
    ).rejects.toThrow(/429|retry/i);
  });
});
