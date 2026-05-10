import type { Candle, Interval } from '../types';
import type { CandleStore, CoverageRange } from './candle-store';
import type { KiteClient } from './kite-client';

export type SymbolResolver = (symbol: string) => Promise<{ tradingsymbol: string; instrumentToken: number }>;

export interface DataLoaderOpts {
  kite: KiteClient;
  store: CandleStore;
  resolveSymbol: SymbolResolver;
}

export class DataLoader {
  constructor(private readonly opts: DataLoaderOpts) {}

  async load(symbol: string, from: Date, to: Date, interval: Interval): Promise<Candle[]> {
    const cov = await this.opts.store.coverage(symbol, interval);
    const missing = subtractCoverage({ from, to }, cov);
    if (missing.length > 0) {
      const { instrumentToken } = await this.opts.resolveSymbol(symbol);
      for (const m of missing) {
        const fetched = await this.opts.kite.getHistorical({
          symbol,
          instrumentToken,
          interval,
          from: m.from,
          to: m.to,
        });
        if (fetched.length > 0) {
          await this.opts.store.upsert(fetched);
        }
        await this.opts.store.recordCoverage(symbol, interval, m.from, m.to);
      }
    }
    return this.opts.store.query(symbol, from, to, interval);
  }
}

/** Subtract a list of covered ranges from a target range. Coverage need not be sorted/merged. */
export function subtractCoverage(target: CoverageRange, covered: CoverageRange[]): CoverageRange[] {
  // Merge overlapping covered ranges first
  const merged: CoverageRange[] = [];
  for (const r of [...covered].sort((a, b) => a.from.getTime() - b.from.getTime())) {
    const last = merged[merged.length - 1];
    if (last && r.from.getTime() <= last.to.getTime()) {
      if (r.to.getTime() > last.to.getTime()) last.to = r.to;
    } else {
      merged.push({ from: r.from, to: r.to });
    }
  }
  // Subtract
  const out: CoverageRange[] = [];
  let cursor = target.from.getTime();
  const end = target.to.getTime();
  for (const r of merged) {
    const rFrom = r.from.getTime();
    const rTo = r.to.getTime();
    if (rTo <= cursor) continue;
    if (rFrom >= end) break;
    if (rFrom > cursor) out.push({ from: new Date(cursor), to: new Date(Math.min(rFrom, end)) });
    cursor = Math.max(cursor, rTo);
    if (cursor >= end) break;
  }
  if (cursor < end) out.push({ from: new Date(cursor), to: new Date(end) });
  return out;
}
