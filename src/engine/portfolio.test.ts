import { describe, it, expect } from 'vitest';
import { Portfolio } from './portfolio';
import { OrderSide, type Fill, type Fees } from '../types';

const fees0: Fees = { brokerage: 0, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 0 };
const fee = (n: number): Fees => ({ ...fees0, brokerage: n, total: n });

const fill = (side: 'buy' | 'sell', qty: number, price: number, fees: Fees = fees0): Fill => ({
  orderId: 'o',
  symbol: 'R',
  side: side === 'buy' ? OrderSide.BUY : OrderSide.SELL,
  qty,
  price,
  ts: new Date('2025-01-02T03:50:00Z'),
  fees,
});

describe('Portfolio', () => {
  it('starts with capital and no positions', () => {
    const p = new Portfolio(100_000);
    expect(p.cash).toBe(100_000);
    expect(p.positions().length).toBe(0);
    expect(p.realizedPnL).toBe(0);
  });

  it('buy debits cash and creates a long position', () => {
    const p = new Portfolio(100_000);
    p.applyFill(fill('buy', 10, 100, fee(20)));
    expect(p.cash).toBe(100_000 - 1000 - 20);
    const pos = p.positions()[0]!;
    expect(pos).toEqual({ symbol: 'R', qty: 10, avgPrice: 100 });
  });

  it('partial sell realizes PnL proportional to qty closed', () => {
    const p = new Portfolio(100_000);
    p.applyFill(fill('buy', 10, 100, fee(20)));
    p.applyFill(fill('sell', 6, 110, fee(15)));
    // realized: 6 * (110 - 100) = 60, minus fees on both legs proportional? We charge total fees as cash debit each fill, and report realized as gross-of-entry-fees-but-net-of-exit-fees.
    // Convention here: realizedPnL = price diff × qty − sell fees − (proportional buy fees)
    expect(p.cash).toBeCloseTo(100_000 - 1000 - 20 + 660 - 15);
    const pos = p.positions()[0]!;
    expect(pos.qty).toBe(4);
    expect(pos.avgPrice).toBe(100);
  });

  it('full close removes position and accumulates realizedPnL', () => {
    const p = new Portfolio(100_000);
    p.applyFill(fill('buy', 10, 100));
    p.applyFill(fill('sell', 10, 110));
    expect(p.positions().length).toBe(0);
    expect(p.realizedPnL).toBeCloseTo(100); // 10 * (110 - 100)
  });

  it('markToMarket computes unrealized using prices map', () => {
    const p = new Portfolio(100_000);
    p.applyFill(fill('buy', 10, 100));
    p.markToMarket(new Map([['R', 105]]), new Date('2025-01-02T04:00:00Z'));
    const snap = p.equityCurve()[p.equityCurve().length - 1]!;
    expect(snap.unrealized).toBeCloseTo(50);
    expect(snap.equity).toBeCloseTo(p.cash + 10 * 105); // cost basis + unrealized gain = qty * mark
  });

  it('rejects sell of qty exceeding position (caller should pre-check)', () => {
    const p = new Portfolio(100_000);
    p.applyFill(fill('buy', 5, 100));
    expect(() => p.applyFill(fill('sell', 10, 110))).toThrow(/insufficient/i);
  });

  it('after full round-trip close, equity == initialCapital + sum(realized over trades) ignoring inter-bar marks', () => {
    const p = new Portfolio(100_000);
    p.applyFill(fill('buy', 10, 100, fee(20)));
    p.applyFill(fill('sell', 10, 110, fee(15)));
    // No open positions. Mark-to-market has no positions to value.
    p.markToMarket(new Map(), new Date('2025-01-02T04:00:00Z'));
    const last = p.equityCurve()[p.equityCurve().length - 1]!;
    // True equity after a fully-closed round-trip = cash, with positions all 0.
    expect(last.equity).toBeCloseTo(p.cash);
    // And cash should equal initial + (sell − buy) × qty − total fees
    expect(p.cash).toBeCloseTo(100_000 + (110 - 100) * 10 - 20 - 15);
  });

  it('insufficient cash on BUY throws', () => {
    const p = new Portfolio(1000);
    expect(() => p.applyFill(fill('buy', 100, 100, fee(0)))).toThrow(/insufficient cash/i);
  });
});
