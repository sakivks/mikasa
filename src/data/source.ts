import type { Candle, Interval } from '../types';

export interface FetchHistoricalArgs {
  symbol: string;
  interval: Interval;
  from: Date;
  to: Date;
}

/** A source of historical OHLCV candles. Implementations: KiteSource, YahooSource. */
export interface HistoricalSource {
  getHistorical(args: FetchHistoricalArgs): Promise<Candle[]>;
}
