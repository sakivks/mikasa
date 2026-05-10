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

/**
 * Lot-size fallback used only when the tokenMap entry is the legacy `number`
 * shape (i.e., bare instrumentToken without lot-size).
 *
 * Transitional convenience — the canonical source of truth is the per-expiry
 * lot size carried in the new tokenMap object shape (`{ token, lotSize }`),
 * which mirrors what Kite's instrument dump emits per expiry. NIFTY's lot has
 * historically changed (75 → 50 → 75); never hardcode beyond this safety net.
 */
const LOT_SIZE_FALLBACK: Record<Underlying, number> = { NIFTY: 75, BANKNIFTY: 35 };

/**
 * Build the option tradingsymbol used by strategy/report code.
 * Format: <UNDERLYING>-<YYYY>-<MM>-<DD>-<STRIKE>-<CE|PE>
 * Example: NIFTY-2025-05-22-22000-CE
 *
 * Note: this does NOT match Kite's weekly tradingsymbol convention
 * (which uses week-of-year encoding for weeklies). We use a hyphen-separated
 * full-date form so that:
 *   1. The per-expiry report regex `(\d{4}-\d{2}-\d{2})` reliably extracts a
 *      unique key per weekly expiry — multiple May weeklies no longer collapse
 *      into a single row as they did with the old `25MAY` month-only form.
 *   2. Strategy/test fixtures can still synthesize symbols deterministically.
 */
export function buildOptionSymbol(c: {
  underlying: Underlying;
  expiry: Date;
  strike: number;
  optionType: 'CE' | 'PE';
}): string {
  const yyyy = String(c.expiry.getUTCFullYear());
  const mm = String(c.expiry.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(c.expiry.getUTCDate()).padStart(2, '0');
  // Strikes for index options are integers; use Math.round to be safe.
  const strike = String(Math.round(c.strike));
  return `${c.underlying}-${yyyy}-${mm}-${dd}-${strike}-${c.optionType}`;
}

/**
 * tokenMap entry shape. The canonical (new) form carries both the Kite
 * `instrumentToken` and the per-expiry `lotSize` lifted from the instrument
 * dump. The legacy form was a bare `number` (instrument token only); reads
 * fall back to {@link LOT_SIZE_FALLBACK} when encountered.
 */
export interface TokenMapEntry {
  token: number;
  lotSize: number;
}

export interface FetchOptionsDeps {
  source: KiteSource;
  instruments: InstrumentStore;
  candles: CandleStore;
  logger: Logger;
  /**
   * Path to a JSON file mapping (underlying|expiryISO|strike|type) -> entry.
   * Entry may be the new {@link TokenMapEntry} object shape, or a legacy
   * bare `number` (instrumentToken). New code must emit the object form.
   */
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

  // 1. Hydrate InstrumentStore from bhavcopy CSVs.
  //    tokenMap may be either the new object form ({ token, lotSize }) or the
  //    legacy bare-number form. Both are accepted; legacy entries fall back to
  //    LOT_SIZE_FALLBACK for the underlying.
  const tokenMap = JSON.parse(fs.readFileSync(tokenMapPath, 'utf8')) as Record<
    string,
    TokenMapEntry | number
  >;
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
      const entry = tokenMap[key];
      if (entry === undefined) {
        logger.warn({ key }, 'no token in tokenMap; skipping contract');
        continue;
      }
      const token = typeof entry === 'number' ? entry : entry.token;
      const lotSize =
        typeof entry === 'number' ? LOT_SIZE_FALLBACK[r.underlying] : entry.lotSize;
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
        lotSize,
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
