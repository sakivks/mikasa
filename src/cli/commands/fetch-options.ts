import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Underlying, OptionContract } from '../../types/options';
import type { KiteSource } from '../../data/kite-source';
import type { InstrumentStore } from '../../data/instrument-store';
import type { CandleStore } from '../../data/candle-store';
import { resolveAtmChain } from '../../data/options-chain';
import { parseBhavcopy } from '../../data/nse-bhavcopy';
import type { Logger } from '../../util/logger';

/** Strike step per underlying (NIFTY 50 spacing, BANKNIFTY 100). */
const STEP: Record<Underlying, number> = { NIFTY: 50, BANKNIFTY: 100 };

/** Spot index tradingsymbol used by strategies and to label cached spot candles. */
const SPOT_SYMBOL: Record<Underlying, string> = {
  NIFTY: 'NIFTY 50',
  BANKNIFTY: 'NIFTY BANK',
};

/** Kite instrument tokens for the spot indices. Stable, well-known constants. */
const SPOT_TOKEN: Record<Underlying, number> = {
  NIFTY: 256265,
  BANKNIFTY: 260105,
};

/** Lot sizes (Sept 2024 onward). */
const LOT_SIZE: Record<Underlying, number> = { NIFTY: 75, BANKNIFTY: 35 };

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Build the option tradingsymbol used by strategy/report code.
 * Format: <UNDERLYING><YY><MMM><STRIKE><CE|PE>
 * Example: NIFTY25MAY22000CE
 *
 * Note: this does NOT match Kite's weekly tradingsymbol convention
 * (which uses week-of-month encoding for weeklies); but the Task 11/12/13
 * test fixtures and report regex (`\d{2}[A-Z]{3}`) all use this monthly form,
 * so we keep it consistent with strategy expectations.
 */
export function buildOptionSymbol(c: {
  underlying: Underlying;
  expiry: Date;
  strike: number;
  optionType: 'CE' | 'PE';
}): string {
  const yy = String(c.expiry.getUTCFullYear()).slice(-2);
  const mmm = MONTHS[c.expiry.getUTCMonth()]!;
  // Strikes for index options are integers; use Math.round to be safe.
  const strike = String(Math.round(c.strike));
  return `${c.underlying}${yy}${mmm}${strike}${c.optionType}`;
}

export interface FetchOptionsDeps {
  source: KiteSource;
  instruments: InstrumentStore;
  candles: CandleStore;
  logger: Logger;
  /** Path to a JSON file mapping (underlying|expiryISO|strike|type) -> instrumentToken */
  tokenMapPath: string;
  /** Directory of pre-downloaded NSE bhavcopy CSVs */
  bhavcopyDir: string;
  /** Strikes either side of ATM to fetch (default 10). */
  atmRange?: number;
}

/**
 * Hydrate options instrument index from bhavcopy CSVs, then fetch index spot
 * candles and per-strike option candles for every weekly expiry in [from, to].
 *
 * Operational tooling — not invoked from strategies/tests at runtime.
 */
export async function fetchOptions(
  underlying: Underlying,
  from: Date,
  to: Date,
  deps: FetchOptionsDeps,
): Promise<void> {
  const { source, instruments, candles, logger, tokenMapPath, bhavcopyDir } = deps;
  const range = deps.atmRange ?? 10;

  // 1. Hydrate InstrumentStore from bhavcopy CSVs
  const tokenMap = JSON.parse(fs.readFileSync(tokenMapPath, 'utf8')) as Record<string, number>;
  const bhavFiles = fs
    .readdirSync(bhavcopyDir)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .sort();

  const seen = new Set<string>();
  let added = 0;
  for (const f of bhavFiles) {
    const rows = parseBhavcopy(path.join(bhavcopyDir, f));
    for (const r of rows) {
      if (r.underlying !== underlying) continue;
      if (r.expiry < from || r.expiry > to) continue;
      const key = `${r.underlying}|${r.expiry.toISOString()}|${r.strike}|${r.optionType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const token = tokenMap[key];
      if (token === undefined) {
        logger.warn({ key }, 'no token in tokenMap; skipping contract');
        continue;
      }
      const contract: OptionContract = {
        symbol: buildOptionSymbol({
          underlying: r.underlying,
          expiry: r.expiry,
          strike: r.strike,
          optionType: r.optionType,
        }),
        underlying: r.underlying,
        expiry: r.expiry,
        strike: r.strike,
        optionType: r.optionType,
        lotSize: LOT_SIZE[r.underlying],
        instrumentToken: token,
      };
      await instruments.addOption(contract);
      added += 1;
    }
  }
  logger.info({ underlying, contracts: added, files: bhavFiles.length }, 'instruments hydrated');

  // 2. Fetch index spot candles for the whole window. Re-label the synthetic
  //    `TOKEN-N` symbol to the canonical spot symbol so strategy code matches.
  const spotCandles = await source.fetchOptionCandles(SPOT_TOKEN[underlying], from, to, '1minute');
  const spotLabel = SPOT_SYMBOL[underlying];
  const reLabeledSpot = spotCandles.map((c) => ({ ...c, symbol: spotLabel }));
  await candles.upsert(reLabeledSpot);
  if (reLabeledSpot.length > 0) {
    await candles.recordCoverage(spotLabel, '1minute', from, to);
  }
  logger.info({ symbol: spotLabel, bars: reLabeledSpot.length }, 'cached spot candles');

  // 3. For each weekly expiry inside [from, to], resolve ATM ± N and fetch chain
  const allExpiries = await instruments.expiries(underlying);
  for (const expiry of allExpiries) {
    if (expiry < from || expiry > to) continue;

    // ATM resolution moment: 09:30 IST on the expiry day = 04:00 UTC.
    const atmTs = new Date(
      Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate(), 4, 0, 0),
    );
    const spotBar = reLabeledSpot.find((c) => c.ts >= atmTs);
    if (!spotBar) {
      logger.warn({ expiry }, 'no spot bar near expiry open; skipping chain fetch');
      continue;
    }

    const chain = await resolveAtmChain(
      instruments,
      underlying,
      expiry,
      spotBar.close,
      range,
      STEP[underlying],
    );

    // Weekly contracts list ~5 trading days before expiry; widen to 8 calendar days.
    const contractFrom = new Date(expiry.getTime() - 8 * 24 * 60 * 60 * 1000);
    const contractTo = new Date(expiry.getTime() + 1 * 60 * 60 * 1000); // small buffer past close

    for (const c of chain) {
      const cs = await source.fetchOptionCandles(
        c.instrumentToken,
        contractFrom,
        contractTo,
        '1minute',
      );
      const reLabeledOpt = cs.map((bar) => ({ ...bar, symbol: c.symbol }));
      await candles.upsert(reLabeledOpt);
      if (reLabeledOpt.length > 0) {
        await candles.recordCoverage(c.symbol, '1minute', contractFrom, contractTo);
      }
      logger.info(
        { symbol: c.symbol, bars: cs.length, expiry: expiry.toISOString() },
        'cached option candles',
      );
    }
  }
}
