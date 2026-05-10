import { CandleStore } from '../../data/candle-store';
import type { Interval } from '../../types';

export interface CacheInfoArgs {
  dbPath: string;
  symbol?: string;
}

export interface CoverageReport {
  symbol: string;
  interval: string;
  from: string;
  to: string;
}

const INTERVALS: readonly Interval[] = [
  '1minute',
  '3minute',
  '5minute',
  '10minute',
  '15minute',
  '30minute',
  '60minute',
  'day',
] as const;

export async function cacheInfo(args: CacheInfoArgs): Promise<CoverageReport[]> {
  const store = await CandleStore.open(args.dbPath);
  try {
    const reports: CoverageReport[] = [];
    const symbols = args.symbol ? [args.symbol] : await store.allSymbols();
    for (const s of symbols) {
      for (const i of INTERVALS) {
        const ranges = await store.coverage(s, i);
        for (const r of ranges) {
          reports.push({
            symbol: s,
            interval: i,
            from: r.from.toISOString(),
            to: r.to.toISOString(),
          });
        }
      }
    }
    return reports;
  } finally {
    await store.close();
  }
}
