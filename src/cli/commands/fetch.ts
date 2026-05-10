import { KiteConnect } from 'kiteconnect';
import { CandleStore } from '../../data/candle-store';
import { InstrumentStore } from '../../data/instrument-store';
import { KiteClient } from '../../data/kite-client';
import { DataLoader } from '../../data/data-loader';
import type { Interval } from '../../types';
import type { Logger } from '../../util/logger';
import { parseEnv } from '../../config/env';

export interface FetchArgs {
  dbPath: string;
  instrumentsPath: string;
  symbol: string;
  exchange?: string;
  from: Date;
  to: Date;
  interval: Interval;
  logger: Logger;
}

export async function fetchCandles(args: FetchArgs): Promise<number> {
  const env = parseEnv();
  const kite = new KiteConnect({ api_key: env.KITE_API_KEY });
  kite.setAccessToken(env.KITE_ACCESS_TOKEN);

  const candleStore = await CandleStore.open(args.dbPath);
  const instrumentStore = await InstrumentStore.open(args.instrumentsPath);
  try {
    const exchange = args.exchange ?? 'NSE';
    let resolved = await instrumentStore.resolve(args.symbol, exchange);
    if (!resolved) {
      args.logger.info(
        { symbol: args.symbol, exchange },
        'instrument not in cache; fetching instruments dump',
      );
      // Cast through unknown to accept any exchange string regardless of the SDK's narrow Exchanges union.
      const dump = (await (kite.getInstruments as unknown as (ex: string) => Promise<unknown[]>)(
        exchange,
      )) as Array<Record<string, unknown>>;
      const rows = dump.map((r) => ({
        instrumentToken: Number(r.instrument_token),
        tradingsymbol: String(r.tradingsymbol),
        exchange: String(r.exchange),
        segment: String(r.segment ?? ''),
        instrumentType: String(r.instrument_type ?? ''),
      }));
      await instrumentStore.upsert(rows);
      resolved = await instrumentStore.resolve(args.symbol, exchange);
      if (!resolved) throw new Error(`symbol not found in ${exchange} instruments: ${args.symbol}`);
    }

    const client = new KiteClient({
      kite: {
        getHistoricalData: (token, interval, from, to) =>
          // Cast through unknown: SDK's interval union doesn't include '1minute' but the live API accepts it.
          (
            kite.getHistoricalData as unknown as (
              token: number | string,
              interval: string,
              from: Date | string,
              to: Date | string,
            ) => Promise<unknown[]>
          )(token, interval, from, to),
      },
    });

    const loader = new DataLoader({
      kite: client,
      store: candleStore,
      resolveSymbol: async (sym) => {
        const r = await instrumentStore.resolve(sym, exchange);
        if (!r) throw new Error(`unknown symbol: ${sym}`);
        return r;
      },
    });

    const rows = await loader.load(args.symbol, args.from, args.to, args.interval);
    args.logger.info({ symbol: args.symbol, count: rows.length }, 'fetch complete');
    return rows.length;
  } finally {
    await candleStore.close();
    await instrumentStore.close();
  }
}
