import type { Candle, Interval } from '../types';
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

  /**
   * Fetch historical candles for an option contract by Kite instrument token.
   *
   * Reuses the same underlying KiteClient HTTP/auth path as equity fetches; the
   * only difference is that we skip the InstrumentStore resolve step (the caller
   * has the token already, e.g. from the NFO-OPT instrument index) and label
   * candles with a synthetic `TOKEN-<token>` symbol. Callers typically rewrite
   * this to the option's tradingsymbol when persisting.
   */
  async fetchOptionCandles(
    instrumentToken: number,
    from: Date,
    to: Date,
    interval: Interval,
  ): Promise<Candle[]> {
    return this.opts.kite.getHistorical({
      symbol: `TOKEN-${instrumentToken}`,
      instrumentToken,
      interval,
      from,
      to,
    });
  }
}
