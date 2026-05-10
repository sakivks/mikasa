#!/usr/bin/env node
import { Command } from 'commander';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Load .env from cwd if present. Lightweight, no dotenv dep. Existing process.env wins.
const _envPath = join(process.cwd(), '.env');
if (existsSync(_envPath)) {
  for (const line of readFileSync(_envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]!] === undefined || process.env[m[1]!] === '') process.env[m[1]!] = v;
  }
}
import { KiteConnect } from 'kiteconnect';
import { fetchCandles } from './commands/fetch';
import { fetchOptions } from './commands/fetch-options';
import { runBacktestCli } from './commands/backtest';
import { cacheInfo } from './commands/cache-info';
import { CandleStore } from '../data/candle-store';
import { InstrumentStore } from '../data/instrument-store';
import { KiteClient } from '../data/kite-client';
import { KiteSource } from '../data/kite-source';
import { parseEnv } from '../config/env';
import { createLogger, makeRunId } from '../util/logger';
import type { Interval } from '../types';
import type { Underlying } from '../types/options';

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
  .command('fetch-options')
  .argument('<underlying>', 'NIFTY | BANKNIFTY')
  .argument('<from>', 'YYYY-MM-DD')
  .argument('<to>', 'YYYY-MM-DD')
  .option('--bhavcopy-dir <dir>', 'directory of NSE FO bhavcopy CSVs', process.env.MIKASA_BHAVCOPY_DIR)
  .option('--token-map <path>', 'JSON file: (underlying|expiryISO|strike|type) -> token', process.env.MIKASA_TOKEN_MAP)
  .option('--atm-range <n>', 'strikes either side of ATM to fetch', '10')
  .action(
    async (
      underlying: string,
      from: string,
      to: string,
      opts: { bhavcopyDir?: string; tokenMap?: string; atmRange: string },
    ) => {
      ensureDataDir();
      if (underlying !== 'NIFTY' && underlying !== 'BANKNIFTY') {
        throw new Error(`invalid underlying: ${underlying} (expected NIFTY or BANKNIFTY)`);
      }
      if (!opts.bhavcopyDir) {
        throw new Error('--bhavcopy-dir is required (or set MIKASA_BHAVCOPY_DIR)');
      }
      if (!opts.tokenMap) {
        throw new Error('--token-map is required (or set MIKASA_TOKEN_MAP)');
      }
      const logger = createLogger({ runId: makeRunId('fetch-options') });
      const env = parseEnv();
      const kite = new KiteConnect({ api_key: env.KITE_API_KEY });
      kite.setAccessToken(env.KITE_ACCESS_TOKEN);
      const candleStore = await CandleStore.open(DB_PATH);
      const instrumentStore = await InstrumentStore.open(INSTRUMENTS_PATH);
      try {
        const client = new KiteClient({
          kite: {
            getHistoricalData: (token, interval, fromD, toD) =>
              (
                kite.getHistoricalData as unknown as (
                  token: number | string,
                  interval: string,
                  from: Date | string,
                  to: Date | string,
                ) => Promise<unknown[]>
              )(token, interval, fromD, toD),
          },
        });
        const source = new KiteSource({
          kite: client,
          instruments: instrumentStore,
          exchange: 'NFO',
        });
        await fetchOptions(underlying as Underlying, new Date(`${from}T00:00:00Z`), new Date(`${to}T00:00:00Z`), {
          source,
          instruments: instrumentStore,
          candles: candleStore,
          logger,
          tokenMapPath: opts.tokenMap,
          bhavcopyDir: opts.bhavcopyDir,
          atmRange: Number(opts.atmRange),
        });
        process.stdout.write(`fetch-options complete for ${underlying} ${from}..${to}\n`);
      } finally {
        await candleStore.close();
        await instrumentStore.close();
      }
    },
  );

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

program
  .command('auth')
  .argument('[request_token]', 'Kite request_token from the login redirect URL')
  .option('--login', 'Print the Kite login URL and exit')
  .action(async (requestToken: string | undefined, opts: { login?: boolean }) => {
    const logger = createLogger({ runId: makeRunId('auth') });
    const envPath = join(process.cwd(), '.env');
    if (opts.login) {
      const fs = await import('node:fs');
      if (!fs.existsSync(envPath)) throw new Error('.env not found in cwd');
      const text = fs.readFileSync(envPath, 'utf8');
      const m = text.match(/^\s*KITE_API_KEY\s*=\s*(.*)$/m);
      if (!m) throw new Error('KITE_API_KEY missing in .env');
      const apiKey = m[1]!.trim().replace(/^["']|["']$/g, '');
      const { loginUrl } = await import('./commands/auth');
      process.stdout.write(`${loginUrl(apiKey)}\n`);
      return;
    }
    if (!requestToken) {
      process.stderr.write('Usage: mikasa auth <request_token>\n  or:  mikasa auth --login\n');
      process.exit(1);
    }
    const { authenticate } = await import('./commands/auth');
    const result = await authenticate({ requestToken, envPath, logger });
    process.stdout.write(
      `Access token updated. user=${result.userId ?? '?'} (${result.userName ?? '?'})\n`,
    );
    process.stdout.write(`KITE_ACCESS_TOKEN written to ${envPath}\n`);
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
});
