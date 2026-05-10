import { describe, it, expect } from 'vitest';
import { YahooSource, type YahooFinanceLike } from './yahoo-source';
import type { Interval } from '../types';

interface ChartCall {
  symbol: string;
  opts: { period1: Date; period2: Date; interval: string };
  runtimeOpts: { validateResult?: boolean } | undefined;
}

interface FakeQuote {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

function makeFakeClient(quotes: FakeQuote[]): { client: YahooFinanceLike; calls: ChartCall[] } {
  const calls: ChartCall[] = [];
  const client: YahooFinanceLike = {
    async chart(symbol, opts, runtimeOpts) {
      calls.push({ symbol, opts, runtimeOpts });
      return { quotes };
    },
  };
  return { client, calls };
}

const from = new Date('2025-01-02T03:00:00Z');
const to = new Date('2025-01-02T05:00:00Z');

describe('YahooSource', () => {
  it('appends default .NS suffix and respects custom exchangeSuffix', async () => {
    const { client: nseClient, calls: nseCalls } = makeFakeClient([]);
    const nse = new YahooSource({ client: nseClient });
    await nse.getHistorical({ symbol: 'RELIANCE', interval: '5minute', from, to });
    expect(nseCalls.length).toBe(1);
    expect(nseCalls[0]!.symbol).toBe('RELIANCE.NS');

    const { client: bseClient, calls: bseCalls } = makeFakeClient([]);
    const bse = new YahooSource({ client: bseClient, exchangeSuffix: '.BO' });
    await bse.getHistorical({ symbol: 'RELIANCE', interval: '5minute', from, to });
    expect(bseCalls.length).toBe(1);
    expect(bseCalls[0]!.symbol).toBe('RELIANCE.BO');
  });

  it('passes pre-suffixed symbols through without double-suffixing', async () => {
    const { client, calls } = makeFakeClient([]);
    const source = new YahooSource({ client });
    await source.getHistorical({ symbol: 'RELIANCE.NS', interval: '5minute', from, to });
    expect(calls.length).toBe(1);
    expect(calls[0]!.symbol).toBe('RELIANCE.NS');
  });

  it('maps mikasa intervals to yahoo intervals', async () => {
    const cases: Array<{ input: Interval; expected: string }> = [
      { input: '5minute', expected: '5m' },
      { input: 'day', expected: '1d' },
    ];
    for (const c of cases) {
      const { client, calls } = makeFakeClient([]);
      const source = new YahooSource({ client });
      await source.getHistorical({ symbol: 'RELIANCE', interval: c.input, from, to });
      expect(calls.length).toBe(1);
      expect(calls[0]!.opts.interval).toBe(c.expected);
    }
  });

  it('filters out bars with null OHLCV and preserves request-side symbol/interval on candles', async () => {
    const quotes: FakeQuote[] = [
      {
        date: new Date('2025-01-02T03:45:00Z'),
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 1000,
      },
      {
        date: new Date('2025-01-02T03:50:00Z'),
        open: null,
        high: null,
        low: null,
        close: null,
        volume: null,
      },
      {
        date: new Date('2025-01-02T03:55:00Z'),
        open: 102,
        high: 103,
        low: 101.5,
        close: 102.5,
        volume: 2000,
      },
    ];
    const { client } = makeFakeClient(quotes);
    const source = new YahooSource({ client });
    const out = await source.getHistorical({
      symbol: 'RELIANCE',
      interval: '5minute',
      from,
      to,
    });
    expect(out.length).toBe(2);
    for (const candle of out) {
      expect(candle.symbol).toBe('RELIANCE');
      expect(candle.interval).toBe('5minute');
    }
    expect(out[0]).toMatchObject({
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1000,
    });
    expect(out[1]).toMatchObject({
      open: 102,
      high: 103,
      low: 101.5,
      close: 102.5,
      volume: 2000,
    });
  });
});
