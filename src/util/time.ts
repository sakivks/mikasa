import { DateTime } from 'luxon';

const IST_ZONE = 'Asia/Kolkata';

export function toIST(d: Date, fmt: string): string {
  return DateTime.fromJSDate(d, { zone: 'utc' }).setZone(IST_ZONE).toFormat(fmt);
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
