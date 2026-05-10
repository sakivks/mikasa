import type { Candle, Interval } from '../types';

export interface KiteSdkLike {
  getHistoricalData(
    instrumentToken: number,
    interval: string,
    fromDate: Date,
    toDate: Date,
    continuous?: boolean,
    oi?: boolean,
  ): Promise<unknown[]>;
}

export interface KiteClientOpts {
  kite: KiteSdkLike;
  chunkDays?: number; // default 60 (Kite's minute-data window)
  maxRetries?: number; // default 5
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchHistoricalArgs {
  symbol: string; // tradingsymbol used to label returned candles
  instrumentToken: number; // Kite instrument token (resolve via InstrumentStore)
  interval: Interval;
  from: Date;
  to: Date;
}

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

export class KiteClient {
  private readonly kite: KiteSdkLike;
  private readonly chunkDays: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: KiteClientOpts) {
    this.kite = opts.kite;
    this.chunkDays = opts.chunkDays ?? 60;
    this.maxRetries = opts.maxRetries ?? 5;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async getHistorical(args: FetchHistoricalArgs): Promise<Candle[]> {
    const { symbol, instrumentToken, interval, from, to } = args;
    const out: Candle[] = [];
    for (const [chunkFrom, chunkTo] of this.chunks(from, to)) {
      const raw = await this.fetchOnce(instrumentToken, interval, chunkFrom, chunkTo);
      for (const r of raw) {
        const row = r as {
          date: Date | string;
          open: number;
          high: number;
          low: number;
          close: number;
          volume: number;
        };
        out.push({
          symbol,
          ts: row.date instanceof Date ? row.date : new Date(row.date),
          interval,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
        });
      }
    }
    return out;
  }

  private *chunks(from: Date, to: Date): IterableIterator<[Date, Date]> {
    const stepMs = this.chunkDays * 24 * 60 * 60 * 1000;
    let cursor = from.getTime();
    const end = to.getTime();
    while (cursor < end) {
      const next = Math.min(cursor + stepMs, end);
      yield [new Date(cursor), new Date(next)];
      cursor = next;
    }
  }

  private async fetchOnce(
    token: number,
    interval: Interval,
    from: Date,
    to: Date,
  ): Promise<unknown[]> {
    let attempt = 0;
    while (true) {
      try {
        return await this.kite.getHistoricalData(token, interval, from, to);
      } catch (err) {
        const status = (err as { status?: number }).status;
        const retriable =
          status === 429 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          /timeout|ECONN|ETIMEDOUT/i.test(String(err));
        if (!retriable || attempt >= this.maxRetries) {
          throw err;
        }
        const delay = 1000 * Math.pow(2, attempt);
        await this.sleep(delay);
        attempt += 1;
      }
    }
  }
}
