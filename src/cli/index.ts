#!/usr/bin/env node
import { Command } from 'commander';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchCandles } from './commands/fetch';
import { runBacktestCli } from './commands/backtest';
import { cacheInfo } from './commands/cache-info';
import { createLogger, makeRunId } from '../util/logger';
import type { Interval } from '../types';

const program = new Command();
program.name('mikasa').description('Algo trading bot CLI').version('0.0.1');

const DATA_DIR = process.env.MIKASA_DATA_DIR ?? join(process.cwd(), 'data-cache');
const REPORTS_DIR = process.env.MIKASA_REPORTS_DIR ?? join(process.cwd(), 'reports');
const DB_PATH = join(DATA_DIR, 'candles.duckdb');
const INSTRUMENTS_PATH = join(DATA_DIR, 'instruments.duckdb');

function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

program
  .command('fetch')
  .argument('<symbol>', 'tradingsymbol, e.g. RELIANCE')
  .argument('<from>', 'YYYY-MM-DD')
  .argument('<to>', 'YYYY-MM-DD')
  .argument('<interval>', '1minute|5minute|15minute|day|...')
  .option('--exchange <ex>', 'exchange', 'NSE')
  .option('--source <src>', 'data source: kite | yahoo', 'kite')
  .action(
    async (
      symbol: string,
      from: string,
      to: string,
      interval: string,
      opts: { exchange: string; source: string },
    ) => {
      ensureDataDir();
      const logger = createLogger({ runId: makeRunId('fetch') });
      if (opts.source !== 'kite' && opts.source !== 'yahoo') {
        throw new Error(`invalid --source: ${opts.source} (expected 'kite' or 'yahoo')`);
      }
      const n = await fetchCandles({
        dbPath: DB_PATH,
        instrumentsPath: INSTRUMENTS_PATH,
        symbol,
        exchange: opts.exchange,
        source: opts.source,
        from: new Date(`${from}T00:00:00Z`),
        to: new Date(`${to}T00:00:00Z`),
        interval: interval as Interval,
        logger,
      });
      process.stdout.write(`Fetched: ${n} bars\n`);
    },
  );

program
  .command('backtest')
  .argument('<config>', 'path to YAML run-config')
  .option('--no-fetch', 'do not fetch missing data; fail if cache is short')
  .action(async (configPath: string, opts: { fetch: boolean }) => {
    ensureDataDir();
    const res = await runBacktestCli({
      configPath,
      dbPath: DB_PATH,
      instrumentsPath: INSTRUMENTS_PATH,
      reportsDir: REPORTS_DIR,
      fetchOnDemand: opts.fetch !== false,
    });
    process.stdout.write(
      `Run: ${res.runId}\nReport: ${res.reportPath}\nFinal equity: ${res.finalEquity}\n`,
    );
  });

program
  .command('cache-info')
  .option('--symbol <s>', 'filter by symbol')
  .action(async (opts: { symbol?: string }) => {
    ensureDataDir();
    const rows = await cacheInfo({ dbPath: DB_PATH, ...(opts.symbol ? { symbol: opts.symbol } : {}) });
    if (rows.length === 0) {
      process.stdout.write('Cache is empty.\n');
      return;
    }
    process.stdout.write('symbol\tinterval\tfrom\tto\n');
    for (const r of rows) {
      process.stdout.write(`${r.symbol}\t${r.interval}\t${r.from}\t${r.to}\n`);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
});
