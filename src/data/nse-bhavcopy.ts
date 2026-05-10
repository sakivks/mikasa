import * as fs from 'node:fs';
import type { Underlying, OptionType } from '../types/options';

export interface BhavcopyRow {
  underlying: Underlying;
  symbol: string;             // 'NIFTY' or 'BANKNIFTY'
  expiry: Date;               // 10:00 UTC = 15:30 IST close
  strike: number;
  optionType: OptionType;
}

const MONTH: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

function parseExpiry(s: string): Date {
  // Format: "22-MAY-2025"
  const [d, m, y] = s.split('-');
  if (!d || !m || !y) throw new Error(`bad expiry: ${s}`);
  const month = MONTH[m.toUpperCase()];
  if (month === undefined) throw new Error(`bad month: ${m}`);
  return new Date(Date.UTC(parseInt(y, 10), month, parseInt(d, 10), 10, 0, 0));
}

export function parseBhavcopy(csvPath: string): BhavcopyRow[] {
  const text = fs.readFileSync(csvPath, 'utf8');
  const stripped = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const normalized = stripped.replace(/\r\n?/g, '\n');
  const lines = normalized.trim().split('\n');
  const header = lines[0]!.split(',').map((s) => s.trim());
  const idx = (col: string): number => {
    const i = header.indexOf(col);
    if (i < 0) throw new Error(`missing column: ${col}`);
    return i;
  };
  const cInst = idx('INSTRUMENT');
  const cSym = idx('SYMBOL');
  const cExp = idx('EXPIRY_DT');
  const cStrike = idx('STRIKE_PR');
  const cType = idx('OPTION_TYP');

  const rows: BhavcopyRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(',').map((s) => s.trim());
    if (cells[cInst] !== 'OPTIDX') continue;
    const sym = cells[cSym]!;
    if (sym !== 'NIFTY' && sym !== 'BANKNIFTY') continue;
    const t = cells[cType];
    if (t !== 'CE' && t !== 'PE') continue;
    rows.push({
      underlying: sym,
      symbol: sym,
      expiry: parseExpiry(cells[cExp]!),
      strike: parseFloat(cells[cStrike]!),
      optionType: t,
    });
  }
  return rows;
}
