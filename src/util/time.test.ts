import { describe, it, expect } from 'vitest';
import { toIST, parseHHMMtoUTC, isMarketHoursIST, isSquareoffBarIST } from './time';

describe('time util', () => {
  it('converts UTC Date to IST formatted string', () => {
    // 03:45 UTC == 09:15 IST
    const d = new Date('2025-01-02T03:45:00Z');
    expect(toIST(d, 'HH:mm')).toBe('09:15');
    expect(toIST(d, 'yyyy-MM-dd HH:mm')).toBe('2025-01-02 09:15');
  });

  it('parseHHMMtoUTC produces UTC Date for given calendar day in IST', () => {
    // 09:15 IST on 2025-01-02 == 03:45 UTC
    const d = parseHHMMtoUTC('2025-01-02', '09:15');
    expect(d.toISOString()).toBe('2025-01-02T03:45:00.000Z');
  });

  it('isMarketHoursIST: true between 09:15 and 15:30 IST inclusive of bar starts', () => {
    const open = new Date('2025-01-02T03:45:00Z'); // 09:15 IST
    const mid = new Date('2025-01-02T06:00:00Z');  // 11:30 IST
    const lastStart = new Date('2025-01-02T09:55:00Z'); // 15:25 IST
    const close = new Date('2025-01-02T10:00:00Z'); // 15:30 IST -- bar START at 15:30 is OUT
    const after = new Date('2025-01-02T10:05:00Z'); // 15:35 IST
    const before = new Date('2025-01-02T03:40:00Z'); // 09:10 IST
    expect(isMarketHoursIST(open)).toBe(true);
    expect(isMarketHoursIST(mid)).toBe(true);
    expect(isMarketHoursIST(lastStart)).toBe(true);
    expect(isMarketHoursIST(close)).toBe(false);
    expect(isMarketHoursIST(after)).toBe(false);
    expect(isMarketHoursIST(before)).toBe(false);
  });

  it('isSquareoffBarIST(ts, "15:15") matches only the 15:15 IST bar', () => {
    const target = new Date('2025-01-02T09:45:00Z'); // 15:15 IST
    const before = new Date('2025-01-02T09:40:00Z'); // 15:10 IST
    const after = new Date('2025-01-02T09:50:00Z');  // 15:20 IST
    expect(isSquareoffBarIST(target, '15:15')).toBe(true);
    expect(isSquareoffBarIST(before, '15:15')).toBe(false);
    expect(isSquareoffBarIST(after, '15:15')).toBe(false);
  });
});
