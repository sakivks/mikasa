import { DateTime } from 'luxon';

const IST_ZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function toIST(d: Date, fmt: string): string {
  return DateTime.fromJSDate(d, { zone: 'utc' }).setZone(IST_ZONE).toFormat(fmt);
}

/**
 * IST 'HH:MM' string for a UTC instant. Cheap pure-arithmetic helper used by
 * options strategies that compare against entry/exit time literals.
 */
export function istHHMM(ts: Date): string {
  const ist = new Date(ts.getTime() + IST_OFFSET_MS);
  const hh = ist.getUTCHours().toString().padStart(2, '0');
  const mm = ist.getUTCMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * IST calendar-date key 'YYYY-MM-DD' for a UTC instant. Used as a per-day
 * lookup key by ShortStraddle's atmContracts map.
 */
export function istDateKey(ts: Date): string {
  const ist = new Date(ts.getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

/**
 * Bespoke (non-ISO) week key 'YYYY-Www' used by IronCondor for weekly
 * contract lookup. The formula MUST stay identical between strategy and loader
 * — otherwise the strategy will see no contracts. Hence this single source.
 */
export function istWeekKey(ts: Date): string {
  const ist = new Date(ts.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const startOfYear = Date.UTC(year, 0, 1);
  const dayOfYear = Math.floor((ist.getTime() - startOfYear) / 86400000);
  const startWeekday = new Date(startOfYear).getUTCDay();
  const week = Math.ceil((dayOfYear + startWeekday + 1) / 7);
  return `${year}-W${week.toString().padStart(2, '0')}`;
}

/**
 * IST weekday (0=Sunday..6=Saturday) for a UTC instant.
 */
export function istWeekday(ts: Date): number {
  const ist = new Date(ts.getTime() + IST_OFFSET_MS);
  return ist.getUTCDay();
}

/**
 * Compute the UTC instant that corresponds to a given HH:MM in IST on the IST
 * calendar date of `dateInIst`. The input Date can be at any time-of-day; only
 * its IST calendar date is consulted.
 *
 * Example: dateInIst representing 2025-05-22 (any UTC time), hhmm '09:20' →
 * 2025-05-22 09:20 IST = 2025-05-22 03:50:00Z.
 */
export function utcAtIstHHMM(dateInIst: Date, hhmm: string): Date {
  const ist = new Date(dateInIst.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m, d, hh!, mm!) - IST_OFFSET_MS);
}

export function parseHHMMtoUTC(yyyyMmDd: string, hhmm: string): Date {
  const dt = DateTime.fromFormat(`${yyyyMmDd} ${hhmm}`, 'yyyy-MM-dd HH:mm', { zone: IST_ZONE });
  if (!dt.isValid) throw new Error(`Invalid date/time: ${yyyyMmDd} ${hhmm}: ${dt.invalidReason}`);
  return dt.toUTC().toJSDate();
}

/** True when the bar START timestamp falls in [09:15, 15:30) IST. */
export function isMarketHoursIST(d: Date): boolean {
  const ist = DateTime.fromJSDate(d, { zone: 'utc' }).setZone(IST_ZONE);
  const minutes = ist.hour * 60 + ist.minute;
  const open = 9 * 60 + 15;
  const close = 15 * 60 + 30; // bar starts at exactly 15:30 are out
  return minutes >= open && minutes < close;
}

/** True iff the bar's IST HH:mm equals `hhmm` (e.g. "15:15"). */
export function isSquareoffBarIST(d: Date, hhmm: string): boolean {
  return toIST(d, 'HH:mm') === hhmm;
}
