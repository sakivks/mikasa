import type { Candle } from '../types';
import type { KiteClient } from './kite-client';
import type { InstrumentStore } from './instrument-store';
import type { FetchHistoricalArgs, HistoricalSource } from './source';

export interface KiteSourceOpts {
  kite: KiteClient;
  instruments: InstrumentStore;
  exchange?: string; // default 'NSE'
}

export class KiteSource implements HistoricalSource {
  private readonly exchange: string;

  constructor(private readonly opts: KiteSourceOpts) {
    this.exchange = opts.exchange ?? 'NSE';
  }

  async getHistorical(args: FetchHistoricalArgs): Promise<Candle[]> {
    const resolved = await this.opts.instruments.resolve(args.symbol, this.exchange);
    if (!resolved) {
      throw new Error(`unknown symbol on ${this.exchange}: ${args.symbol}`);
    }
    return this.opts.kite.getHistorical({
      symbol: args.symbol,
      instrumentToken: resolved.instrumentToken,
      interval: args.interval,
      from: args.from,
      to: args.to,
    });
  }
}
