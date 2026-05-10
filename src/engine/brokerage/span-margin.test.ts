import { describe, it, expect } from 'vitest';
import { estimateMargin } from './span-margin';
import type { OptionPosition } from '../../types';

const expiry = new Date('2025-05-22T10:00:00Z');

function pos(strike: number, type: 'CE' | 'PE', netQty: number, avgPrice: number, underlying: 'NIFTY' | 'BANKNIFTY' = 'NIFTY'): OptionPosition {
  return {
    contract: {
      symbol: `${underlying}${strike}${type}`,
      underlying, expiry, strike, optionType: type,
      lotSize: underlying === 'NIFTY' ? 75 : 35,
      instrumentToken: 1,
    },
    netQty, avgPrice, realizedPnl: 0,
  };
}

describe('estimateMargin', () => {
  it('naked short NIFTY straddle: 12% × strike × lotSize per leg', () => {
    const positions = [pos(22000, 'CE', -1, 100), pos(22000, 'PE', -1, 100)];
    // Each leg: 0.12 × 22000 × 75 = 198,000 → total 396,000
    expect(estimateMargin(positions)).toBeCloseTo(396_000, 0);
  });

  it('naked short BANKNIFTY straddle: 10% × strike × lotSize per leg', () => {
    const positions = [pos(50000, 'CE', -1, 200, 'BANKNIFTY'), pos(50000, 'PE', -1, 200, 'BANKNIFTY')];
    // Each: 0.10 × 50000 × 35 = 175,000 → total 350,000
    expect(estimateMargin(positions)).toBeCloseTo(350_000, 0);
  });

  it('iron condor: margin = max(call-spread max-loss, put-spread max-loss) × lotSize', () => {
    // Short 22200 CE @ 30, long 22300 CE @ 15  → call spread max loss = (100 - (30-15)) = 85
    // Short 21800 PE @ 25, long 21700 PE @ 12  → put spread max loss = (100 - (25-12)) = 87
    const positions = [
      pos(22200, 'CE', -1, 30),
      pos(22300, 'CE', +1, 15),
      pos(21800, 'PE', -1, 25),
      pos(21700, 'PE', +1, 12),
    ];
    // max(85, 87) × 75 = 87 × 75 = 6525
    expect(estimateMargin(positions)).toBeCloseTo(6525, 0);
  });

  it('zero positions → zero margin', () => {
    expect(estimateMargin([])).toBe(0);
  });
});
