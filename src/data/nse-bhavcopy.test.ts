import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parseBhavcopy } from './nse-bhavcopy';

const FIXTURE = path.resolve(__dirname, '../../test/fixtures/nse-bhavcopy-sample.csv');

describe('parseBhavcopy', () => {
  it('parses NIFTY/BANKNIFTY OPTIDX rows and skips stocks', () => {
    const rows = parseBhavcopy(FIXTURE);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.underlying === 'NIFTY' || r.underlying === 'BANKNIFTY')).toBe(true);
  });

  it('parses expiry as a UTC Date for market close (10:00 UTC = 15:30 IST)', () => {
    const rows = parseBhavcopy(FIXTURE);
    const niftyCe = rows.find((r) => r.underlying === 'NIFTY' && r.optionType === 'CE')!;
    expect(niftyCe.expiry.toISOString()).toBe('2025-05-22T10:00:00.000Z');
  });

  it('extracts strike, option type, and symbol', () => {
    const rows = parseBhavcopy(FIXTURE);
    const niftyCe = rows.find((r) => r.underlying === 'NIFTY' && r.optionType === 'CE')!;
    expect(niftyCe.strike).toBe(22000);
    expect(niftyCe.symbol).toBe('NIFTY');
  });
});
