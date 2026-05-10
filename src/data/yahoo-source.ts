import YahooFinance from 'yahoo-finance2';
import type { Candle, Interval } from '../types';
import type { FetchHistoricalArgs, HistoricalSource } from './source';

/**
 * Minimal structural shape of the `yahoo-finance2` client surface we depend on.
 * Defined here so tests can inject fakes without pulling in the real SDK.
 */
export interface YahooFinanceLike {
  chart(
    symbol: string,
    opts: { period1: Date; period2: Date; interval: string },
    runtimeOpts?: { validateResult?: boolean },
  ): Promise<{
    quotes: Array<{
      date: Date;
      open: number | null;
      high: number | null;
      low: number | null;
      close: number | null;
      volume: number | null;
    }>;
  }>;
}

export interface YahooSourceOpts {
  /** Suffix to append to the symbol when calling Yahoo. NSE = '.NS', BSE = '.BO'. Default '.NS'. */
  exchangeSuffix?: string;
  /** Inject a custom client (for testing). Defaults to a fresh `new YahooFinance()` instance. */
  client?: YahooFinanceLike;
}

/**
 * Map mikasa intervals to Yahoo Finance intervals.
 * NOTE: Yahoo doesn't support 3m or 10m bars; those map to 5m and 15m respectively (lossy).
 */
const INTERVAL_MAP: Record<Interval, string> = {
  '1minute': '1m',
  '3minute': '5m',
  '5minute': '5m',
  '10minute': '15m',
  '15minute': '15m',
  '30minute': '30m',
  '60minute': '60m',
  day: '1d',
};

/**
 * `HistoricalSource` backed by Yahoo Finance via the `yahoo-finance2` package.
 *
 * Symbols are auto-suffixed with the configured exchange suffix (default `.NS` for NSE)
 * unless they already contain a `.` (e.g. `RELIANCE.NS`).
 *
 * Bars where any OHLCV field is `null` (low-liquidity intraday intervals) are filtered out
 * rather than coerced to zero.
 */
export class YahooSource implements HistoricalSource {
  private readonly suffix: string;
  private readonly client: YahooFinanceLike;

  constructor(opts: YahooSourceOpts = {}) {
    this.suffix = opts.exchangeSuffix ?? '.NS';
    this.client = opts.client ?? (new YahooFinance() as unknown as YahooFinanceLike);
  }

  async getHistorical(args: FetchHistoricalArgs): Promise<Candle[]> {
    const yahooSymbol = this.toYahooSymbol(args.symbol);
    const yahooInterval = INTERVAL_MAP[args.interval];
    const result = await this.client.chart(
      yahooSymbol,
      { period1: args.from, period2: args.to, interval: yahooInterval },
      { validateResult: false },
    );
    const out: Candle[] = [];
    for (const q of result.quotes) {
      if (q.open == null || q.high == null || q.low == null || q.close == null || q.volume == null) {
        continue; // skip null-OHLCV bars (low-liquidity intervals)
      }
      out.push({
        symbol: args.symbol,
        ts: q.date instanceof Date ? q.date : new Date(q.date),
        interval: args.interval,
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume,
      });
    }
    return out;
  }

  private toYahooSymbol(s: string): string {
    if (s.includes('.')) return s; // already fully-qualified (e.g. RELIANCE.NS)
    return `${s}${this.suffix}`;
  }
}
