import { describe, it, expect } from 'vitest';
import { buildOptionsRows, renderOptionsSection } from './options-report';
import type { Fill, Fees } from '../types';

const fees0: Fees = { brokerage: 0, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 0 };
const feesSmall: Fees = { brokerage: 1, stt: 1, exchange: 1, gst: 1, sebi: 0, stampDuty: 0, total: 4 };

function fill(opts: Partial<Fill> & { symbol: string; side: 'buy' | 'sell'; price: number; ts: Date; orderId: string }): Fill {
  return {
    qty: 75,
    multiLegOrderId: opts.orderId,
    fees: feesSmall,
    ...opts,
  };
}

describe('buildOptionsRows', () => {
  it('groups fills by multiLegOrderId and pairs entry/exit per expiry', () => {
    const t1 = new Date('2025-05-22T03:50:00Z');
    const t2 = new Date('2025-05-22T09:45:00Z');
    const fills: Fill[] = [
      // Entry basket (ml-1): SELL CE @ 100, SELL PE @ 95
      fill({ symbol: 'NIFTY25MAY22000CE', side: 'sell', price: 100, ts: t1, orderId: 'ml-1' }),
      fill({ symbol: 'NIFTY25MAY22000PE', side: 'sell', price: 95, ts: t1, orderId: 'ml-1' }),
      // Exit basket (ml-2): BUY both back @ lower premium
      fill({ symbol: 'NIFTY25MAY22000CE', side: 'buy', price: 80, ts: t2, orderId: 'ml-2' }),
      fill({ symbol: 'NIFTY25MAY22000PE', side: 'buy', price: 70, ts: t2, orderId: 'ml-2' }),
    ];
    const rows = buildOptionsRows(fills);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiryDate).toBe('25MAY');
    // Gross: +100*75 + 95*75 - 80*75 - 70*75 = 75*(100+95-80-70) = 75*45 = 3375
    expect(rows[0]!.grossPnl).toBeCloseTo(3375, 2);
    // Charges: 4 × 4 fills = 16
    expect(rows[0]!.charges).toBeCloseTo(16, 2);
    expect(rows[0]!.netPnl).toBeCloseTo(3375 - 16, 2);
  });

  it('returns empty when no multi-leg fills', () => {
    const fills: Fill[] = [
      { symbol: 'A', side: 'buy', price: 10, qty: 1, ts: new Date(), orderId: 'eq-1', fees: fees0 },
    ];
    expect(buildOptionsRows(fills)).toEqual([]);
  });
});

describe('renderOptionsSection', () => {
  it('returns empty string when no option fills', () => {
    expect(renderOptionsSection([])).toBe('');
  });
  it('renders per-expiry table and charge drag', () => {
    const t1 = new Date('2025-05-22T03:50:00Z');
    const t2 = new Date('2025-05-22T09:45:00Z');
    const fills: Fill[] = [
      fill({ symbol: 'NIFTY25MAY22000CE', side: 'sell', price: 100, ts: t1, orderId: 'ml-1' }),
      fill({ symbol: 'NIFTY25MAY22000PE', side: 'sell', price: 95, ts: t1, orderId: 'ml-1' }),
      fill({ symbol: 'NIFTY25MAY22000CE', side: 'buy', price: 80, ts: t2, orderId: 'ml-2' }),
      fill({ symbol: 'NIFTY25MAY22000PE', side: 'buy', price: 70, ts: t2, orderId: 'ml-2' }),
    ];
    const html = renderOptionsSection(fills);
    expect(html).toContain('Per-expiry options breakdown');
    expect(html).toContain('Charge drag');
    expect(html).toContain('25MAY');
    expect(html).toContain('3375.00'); // gross
  });
});
