import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { parseBhavcopy } from './nse-bhavcopy';

const FIXTURE = path.resolve(__dirname, '../../test/fixtures/nse-bhavcopy-sample.csv');

describe('parseBhavcopy', () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    while (tempFiles.length > 0) {
      const f = tempFiles.pop()!;
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
  });

  const writeTemp = (name: string, content: string): string => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bhavcopy-')), name);
    fs.writeFileSync(p, content);
    tempFiles.push(p);
    return p;
  };

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

  it('tolerates UTF-8 BOM and CRLF line endings (NSE archive format)', () => {
    const lf = fs.readFileSync(FIXTURE, 'utf8');
    const crlf = '﻿' + lf.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
    const tempPath = writeTemp('nse-crlf-bom.csv', crlf);

    const rows = parseBhavcopy(tempPath);
    const expected = parseBhavcopy(FIXTURE);

    expect(rows).toHaveLength(expected.length);
    expect(rows.map((r) => ({ ...r, expiry: r.expiry.toISOString() }))).toEqual(
      expected.map((r) => ({ ...r, expiry: r.expiry.toISOString() })),
    );
  });

  it('filters out rows with malformed OPTION_TYP values', () => {
    const csv = [
      'INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP',
      'OPTIDX,NIFTY,22-MAY-2025,22000,CE,150,160,140,145,145,1000,109.50,5000,200,15-MAY-2025',
      'OPTIDX,NIFTY,22-MAY-2025,22100,XX,150,160,140,145,145,1000,109.50,5000,200,15-MAY-2025',
      'OPTIDX,BANKNIFTY,21-MAY-2025,50000,PE,300,310,290,295,295,500,103.25,2000,100,15-MAY-2025',
    ].join('\n');
    const tempPath = writeTemp('nse-bad-option-type.csv', csv);

    const rows = parseBhavcopy(tempPath);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.optionType === 'CE' || r.optionType === 'PE')).toBe(true);
    expect(rows.find((r) => r.strike === 22100)).toBeUndefined();
    expect(rows.find((r) => r.strike === 22000 && r.optionType === 'CE')).toBeDefined();
    expect(rows.find((r) => r.strike === 50000 && r.optionType === 'PE')).toBeDefined();
  });
});
