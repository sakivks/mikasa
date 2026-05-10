import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CandleStore } from '../../data/candle-store';
import { InstrumentStore } from '../../data/instrument-store';
import { KiteClient } from '../../data/kite-client';
import { KiteSource } from '../../data/kite-source';
import { YahooSource } from '../../data/yahoo-source';
import type { HistoricalSource } from '../../data/source';
import { DataLoader } from '../../data/data-loader';
import { BacktestEngine } from '../../engine/backtest-engine';
import { Portfolio } from '../../engine/portfolio';
import { BrokerSim } from '../../engine/broker-sim';
import { OrderRouter } from '../../engine/order-router';
import { IndicatorRegistry } from '../../indicators/registry';
import { resolveStrategy } from '../../strategies/registry';
import { zerodhaIntraday, zeroBrokerage } from '../../engine/brokerage/zerodha-intraday';
import { computeMetrics, buildTrades } from '../../report/metrics';
import { renderHtml } from '../../report/html-report';
import { loadRunConfig, type RunConfig } from '../../types/run-config';
import { createLogger, makeRunId } from '../../util/logger';
import { KiteConnect } from 'kiteconnect';
import { parseEnv } from '../../config/env';
import type { Candle } from '../../types';

export interface BacktestCliArgs {
  configPath: string;
  dbPath: string;
  instrumentsPath: string;
  reportsDir: string;
  fetchOnDemand: boolean; // if true, fetch missing data; else use only cached
}

export async function runBacktestCli(
  args: BacktestCliArgs,
): Promise<{ runId: string; reportPath: string; finalEquity: number }> {
  const cfg: RunConfig = loadRunConfig(args.configPath);
  const runId = makeRunId(cfg.strategy);
  const logger = createLogger({ runId });

  const candleStore = await CandleStore.open(args.dbPath);
  const instrumentStore = await InstrumentStore.open(args.instrumentsPath);

  try {
    let allBars: Candle[] = [];
    const warmupMs = approximateWarmupWindowMs(cfg.interval, cfg.warmup_bars);
    const fromWithWarmup = new Date(new Date(cfg.from).getTime() - warmupMs);
    const to = new Date(`${cfg.to}T00:00:00Z`);

    if (args.fetchOnDemand) {
      let source: HistoricalSource;
      if (cfg.source === 'yahoo') {
        source = new YahooSource();
      } else {
        const env = parseEnv();
        const kite = new KiteConnect({ api_key: env.KITE_API_KEY });
        kite.setAccessToken(env.KITE_ACCESS_TOKEN);
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
        source = new KiteSource({ kite: client, instruments: instrumentStore, exchange: 'NSE' });
      }
      const loader = new DataLoader({ source, store: candleStore });
      for (const symbol of cfg.symbols) {
        const bars = await loader.load(symbol, fromWithWarmup, to, cfg.interval);
        allBars = allBars.concat(bars);
      }
    } else {
      for (const symbol of cfg.symbols) {
        const bars = await candleStore.query(symbol, fromWithWarmup, to, cfg.interval);
        allBars = allBars.concat(bars);
      }
    }
    allBars.sort((a, b) => a.ts.getTime() - b.ts.getTime());

    const Strategy = resolveStrategy(cfg.strategy);
    const strategy = new Strategy();
    const portfolio = new Portfolio(cfg.capital);
    const broker = new BrokerSim({
      slippageBps: cfg.slippage_bps,
      brokerage: cfg.brokerage === 'zero' ? zeroBrokerage : zerodhaIntraday,
    });
    const router = new OrderRouter({ squareoffTime: cfg.squareoff_time });
    const indicators = new IndicatorRegistry();

    const result = new BacktestEngine({
      candles: allBars,
      strategy,
      portfolio,
      broker,
      router,
      indicators,
      logger,
      warmupBars: cfg.warmup_bars,
      params: { ...cfg.params, symbols: cfg.symbols },
    }).run();

    const trades = buildTrades(result.fills);
    const metrics = computeMetrics({
      equityCurve: result.equityCurve,
      trades,
      initialCapital: cfg.capital,
    });

    const html = renderHtml({
      runId,
      strategy: cfg.strategy,
      symbols: cfg.symbols,
      from: cfg.from,
      to: cfg.to,
      interval: cfg.interval,
      metrics,
      equityCurve: result.equityCurve,
      trades,
    });

    mkdirSync(args.reportsDir, { recursive: true });
    const reportPath = join(args.reportsDir, `${runId}.html`);
    writeFileSync(reportPath, html);
    logger.info({ reportPath, finalEquity: metrics.finalEquity }, 'backtest complete');
    return { runId, reportPath, finalEquity: metrics.finalEquity };
  } finally {
    await candleStore.close();
    await instrumentStore.close();
  }
}

function approximateWarmupWindowMs(interval: string, bars: number): number {
  const minPerBar: Record<string, number> = {
    '1minute': 1,
    '3minute': 3,
    '5minute': 5,
    '10minute': 10,
    '15minute': 15,
    '30minute': 30,
    '60minute': 60,
    day: 24 * 60,
  };
  const m = minPerBar[interval] ?? 5;
  // Multiply by 2 to be generous about non-trading hours
  return bars * m * 60_000 * 2;
}
