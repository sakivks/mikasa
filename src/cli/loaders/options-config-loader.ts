import type { Candle, Interval } from '../../types';
import type { OptionContract, Underlying } from '../../types/options';
import type { InstrumentStore } from '../../data/instrument-store';
import { roundToStrike } from '../../data/options-chain';
import { istDateKey, istWeekKey, utcAtIstHHMM } from '../../util/time';
import type { Logger } from '../../util/logger';

/**
 * The options run-config loader populates `params.atmContracts` (ShortStraddle)
 * or `params.weeklyContracts` (IronCondor) before the engine starts.
 *
 * The CLI run-config YAMLs cannot encode resolved options contracts statically
 * — those depend on the spot price at the entry trigger time, which is only
 * known once spot candles are cached. This loader bridges the gap by walking
 * the available expiries in the InstrumentStore, looking up the relevant spot
 * bar from the CandleStore, and resolving ATM (and offset/wing) contracts
 * via the existing `findOption` API.
 */

/** Subset of CandleStore the loader needs. Kept narrow to simplify testing. */
export interface CandleStoreLike {
  query(symbol: string, from: Date, to: Date, interval: Interval): Promise<Candle[]>;
}

const DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** ±2-hour window around the IST entry instant — wide enough to absorb a
 * non-trading minute or a slightly delayed open while still bounding the
 * candle scan. We then take the FIRST bar at-or-after `istEntryUtc`. */
const SPOT_LOOKUP_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Look up the first cached spot bar at or after the IST entry instant on a
 * given calendar date. Returns undefined if none is available — the caller
 * should log a warning and skip that expiry.
 */
async function findSpotBarAt(
  candles: CandleStoreLike,
  spotSymbol: string,
  dateInIst: Date,
  entryTime: string,
  interval: Interval = '1minute',
): Promise<Candle | undefined> {
  const istEntryUtc = utcAtIstHHMM(dateInIst, entryTime);
  const windowEnd = new Date(istEntryUtc.getTime() + SPOT_LOOKUP_WINDOW_MS);
  const bars = await candles.query(spotSymbol, istEntryUtc, windowEnd, interval);
  return bars.find((c) => c.ts.getTime() >= istEntryUtc.getTime());
}

// ---------------------------------------------------------------------------
// Short straddle
// ---------------------------------------------------------------------------

export interface ShortStraddleLoaderInput {
  underlying: Underlying;
  spotSymbol: string;
  entryTime: string;          // 'HH:MM' IST
  from: Date;
  to: Date;
  step: number;               // 50 NIFTY / 100 BANKNIFTY
  instruments: InstrumentStore;
  candles: CandleStoreLike;
  logger: Logger;
  /** Spot candle interval to scan; defaults to '1minute'. */
  interval?: Interval;
}

/**
 * For each expiry in [from, to], find the spot bar at IST entryTime on the
 * expiry day, round to ATM, and resolve the ATM CE+PE.
 * Skipped expiries (no spot bar / no contract) emit a logger.warn and produce
 * no entry in the returned map — the engine will simply not trade them.
 */
export async function buildShortStraddleAtmContracts(
  input: ShortStraddleLoaderInput,
): Promise<Record<string, { ce: OptionContract; pe: OptionContract }>> {
  const { underlying, spotSymbol, entryTime, from, to, step, instruments, candles, logger } = input;
  const interval = input.interval ?? '1minute';
  const result: Record<string, { ce: OptionContract; pe: OptionContract }> = {};

  const expiries = await instruments.expiries(underlying);
  for (const expiry of expiries) {
    if (expiry < from || expiry > to) continue;

    const spotBar = await findSpotBarAt(candles, spotSymbol, expiry, entryTime, interval);
    if (!spotBar) {
      logger.warn(
        { expiry: expiry.toISOString(), spotSymbol, entryTime },
        'no spot bar at entryTime; skipping expiry',
      );
      continue;
    }

    const atm = roundToStrike(spotBar.close, step);
    const ce = await instruments.findOption(underlying, expiry, atm, 'CE');
    const pe = await instruments.findOption(underlying, expiry, atm, 'PE');
    if (!ce || !pe) {
      logger.warn(
        { expiry: expiry.toISOString(), atm, ce: !!ce, pe: !!pe },
        'ATM CE/PE not found in instrument store; skipping expiry',
      );
      continue;
    }

    const dateKey = istDateKey(expiry);
    result[dateKey] = { ce, pe };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Iron condor
// ---------------------------------------------------------------------------

export interface IronCondorLoaderInput {
  underlying: Underlying;
  spotSymbol: string;
  entryDay: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday';
  entryTime: string;
  shortStrikeOffset: number;
  wingWidth: number;
  from: Date;
  to: Date;
  step: number;
  instruments: InstrumentStore;
  candles: CandleStoreLike;
  logger: Logger;
  interval?: Interval;
}

/**
 * Find the date in the same calendar week (Sun..Sat) as `expiry` whose IST
 * weekday matches `targetDay`. Returns a UTC Date whose IST date matches.
 *
 * The week containment is computed in IST — i.e. the date returned shares the
 * same `istWeekKey` as `expiry`. This is critical: the strategy looks up
 * contracts under the spot bar's `istWeekKey`, which is the entryDay's
 * weekKey. If we computed entryDay using a different week definition (e.g.
 * UTC), entries on weeks that wrap a midnight could end up in the wrong week.
 */
function findEntryDayInExpiryWeek(expiry: Date, targetDay: number): Date {
  // Walk back up to 6 days from expiry; pick the day whose IST weekday matches
  // targetDay AND whose istWeekKey matches the expiry's istWeekKey.
  const expiryWeek = istWeekKey(expiry);
  for (let delta = 0; delta < 7; delta++) {
    const candidate = new Date(expiry.getTime() - delta * 86400000);
    // IST weekday of candidate
    const ist = new Date(candidate.getTime() + 5.5 * 60 * 60 * 1000);
    const istDay = ist.getUTCDay();
    if (istDay !== targetDay) continue;
    if (istWeekKey(candidate) !== expiryWeek) continue;
    return candidate;
  }
  // Fallback: try forward (e.g. expiry on Monday and entryDay later in week
  // would be in the NEXT week — unusual but handle gracefully).
  for (let delta = 1; delta < 7; delta++) {
    const candidate = new Date(expiry.getTime() + delta * 86400000);
    const ist = new Date(candidate.getTime() + 5.5 * 60 * 60 * 1000);
    const istDay = ist.getUTCDay();
    if (istDay !== targetDay) continue;
    if (istWeekKey(candidate) !== expiryWeek) continue;
    return candidate;
  }
  // Should be unreachable for any reasonable weekday/expiry combination.
  return expiry;
}

/**
 * For each expiry in [from, to], find the entryDay's spot bar at IST entryTime,
 * round to ATM, and resolve the four condor legs (shortCall, longCall,
 * shortPut, longPut) using the configured offset+wing.
 */
export async function buildIronCondorWeeklyContracts(
  input: IronCondorLoaderInput,
): Promise<
  Record<
    string,
    {
      shortCall: OptionContract;
      longCall: OptionContract;
      shortPut: OptionContract;
      longPut: OptionContract;
    }
  >
> {
  const {
    underlying,
    spotSymbol,
    entryDay,
    entryTime,
    shortStrikeOffset,
    wingWidth,
    from,
    to,
    step,
    instruments,
    candles,
    logger,
  } = input;
  const interval = input.interval ?? '1minute';
  const targetDay = DAY_INDEX[entryDay];
  if (targetDay === undefined) throw new Error(`invalid entryDay: ${entryDay}`);

  const result: Record<
    string,
    {
      shortCall: OptionContract;
      longCall: OptionContract;
      shortPut: OptionContract;
      longPut: OptionContract;
    }
  > = {};

  const expiries = await instruments.expiries(underlying);
  for (const expiry of expiries) {
    if (expiry < from || expiry > to) continue;

    const entryDate = findEntryDayInExpiryWeek(expiry, targetDay);
    const spotBar = await findSpotBarAt(candles, spotSymbol, entryDate, entryTime, interval);
    if (!spotBar) {
      logger.warn(
        { expiry: expiry.toISOString(), entryDate: entryDate.toISOString(), entryTime },
        'no spot bar at entryTime on entry day; skipping expiry',
      );
      continue;
    }

    const atm = roundToStrike(spotBar.close, step);
    const shortCallStrike = atm + shortStrikeOffset;
    const longCallStrike = shortCallStrike + wingWidth;
    const shortPutStrike = atm - shortStrikeOffset;
    const longPutStrike = shortPutStrike - wingWidth;

    const [shortCall, longCall, shortPut, longPut] = await Promise.all([
      instruments.findOption(underlying, expiry, shortCallStrike, 'CE'),
      instruments.findOption(underlying, expiry, longCallStrike, 'CE'),
      instruments.findOption(underlying, expiry, shortPutStrike, 'PE'),
      instruments.findOption(underlying, expiry, longPutStrike, 'PE'),
    ]);

    if (!shortCall || !longCall || !shortPut || !longPut) {
      logger.warn(
        {
          expiry: expiry.toISOString(),
          atm,
          missing: {
            shortCall: !shortCall,
            longCall: !longCall,
            shortPut: !shortPut,
            longPut: !longPut,
          },
        },
        'condor leg(s) not found in instrument store; skipping expiry',
      );
      continue;
    }

    // weekKey is keyed off the spot bar's timestamp — same formula the
    // strategy uses at runtime. This guarantees matching keys.
    const weekKey = istWeekKey(spotBar.ts);
    result[weekKey] = { shortCall, longCall, shortPut, longPut };
  }

  return result;
}
