import { describe, it, expect } from 'vitest';
import { Portfolio } from './portfolio';
import { OrderSide, type Fill, type Fees } from '../types';
import type { OptionContract, Leg } from '../types/options';

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

const expiry = new Date('2025-05-22T10:00:00Z');
const ceContract: OptionContract = {
  symbol: 'NIFTY25MAY22000CE',
  underlying: 'NIFTY',
  expiry,
  strike: 22000,
  optionType: 'CE',
  lotSize: 75,
  instrumentToken: 1,
};
const peContract: OptionContract = { ...ceContract, symbol: 'NIFTY25MAY22000PE', optionType: 'PE', instrumentToken: 2 };

function zeroFees(): Fees {
  return { brokerage: 0, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 0 };
}

describe('Portfolio option positions', () => {
  it('SELL fill creates short option position; cash credited', () => {
    const p = new Portfolio(500_000);
    const leg: Leg = { contract: ceContract, side: OrderSide.SELL, qty: 1 };
    const f: Fill = {
      orderId: 'ml-1',
      symbol: ceContract.symbol,
      side: OrderSide.SELL,
      qty: 75,
      price: 100,
      ts: new Date(),
      fees: zeroFees(),
    };
    p.applyOptionFill(f, leg);
    const pos = p.optionPosition(ceContract.symbol);
    expect(pos!.netQty).toBe(-1);
    expect(pos!.avgPrice).toBe(100);
    expect(p.cash).toBeCloseTo(500_000 + 75 * 100, 2);
  });

  it('BUY-to-close realizes P&L and reduces position', () => {
    const p = new Portfolio(500_000);
    const sellLeg: Leg = { contract: ceContract, side: OrderSide.SELL, qty: 1 };
    const buyLeg: Leg = { contract: ceContract, side: OrderSide.BUY, qty: 1 };
    p.applyOptionFill(
      { orderId: '1', symbol: ceContract.symbol, side: OrderSide.SELL, qty: 75, price: 100, ts: new Date(), fees: zeroFees() },
      sellLeg,
    );
    p.applyOptionFill(
      { orderId: '2', symbol: ceContract.symbol, side: OrderSide.BUY, qty: 75, price: 80, ts: new Date(), fees: zeroFees() },
      buyLeg,
    );
    const pos = p.optionPosition(ceContract.symbol)!;
    expect(pos.netQty).toBe(0);
    expect(pos.realizedPnl).toBeCloseTo((100 - 80) * 75, 2);
    // Cash: +7500 from sell, -6000 from buy = 1500 profit; cash = 500_000 + 1500 = 501_500
    expect(p.cash).toBeCloseTo(501_500, 2);
  });

  it('marginRequired uses span-margin estimator on open shorts', () => {
    const p = new Portfolio(500_000);
    const sellCe: Leg = { contract: ceContract, side: OrderSide.SELL, qty: 1 };
    const sellPe: Leg = { contract: peContract, side: OrderSide.SELL, qty: 1 };
    p.applyOptionFill(
      { orderId: '1', symbol: ceContract.symbol, side: OrderSide.SELL, qty: 75, price: 100, ts: new Date(), fees: zeroFees() },
      sellCe,
    );
    p.applyOptionFill(
      { orderId: '2', symbol: peContract.symbol, side: OrderSide.SELL, qty: 75, price: 100, ts: new Date(), fees: zeroFees() },
      sellPe,
    );
    expect(p.marginRequired()).toBeCloseTo(2 * 0.12 * 22000 * 75, 0); // 2 × 198,000 = 396,000
  });

  it('markToMarket includes option positions in unrealized', () => {
    const p = new Portfolio(500_000);
    const sellLeg: Leg = { contract: ceContract, side: OrderSide.SELL, qty: 1 };
    p.applyOptionFill(
      { orderId: '1', symbol: ceContract.symbol, side: OrderSide.SELL, qty: 75, price: 100, ts: new Date(), fees: zeroFees() },
      sellLeg,
    );
    p.markToMarket(new Map([[ceContract.symbol, 80]]), new Date('2025-05-22T03:50:00Z'));
    const last = p.equityCurve()[p.equityCurve().length - 1]!;
    // Short @ 100, mark @ 80 → (100-80)*75 = 1500 unrealized profit
    expect(last.unrealized).toBeCloseTo(1500, 2);
    // Equity must NOT double-count entry premium. Cash = 507_500 (pre-MTM credit),
    // option market value = -75 × 80 = -6000 (liability to close), so:
    //   equity = 507_500 + 0 + (-6000) = 501_500
    // (Equivalently: 500_000 initial + 1_500 unrealized profit.)
    expect(last.equity).toBeCloseTo(501_500, 2);
  });

  it('full reversal: short 1 then buy 2 flips to long 1 at the new fill price', () => {
    const p = new Portfolio(500_000);
    const sellLeg: Leg = { contract: ceContract, side: OrderSide.SELL, qty: 1 };
    const buyLeg: Leg = { contract: ceContract, side: OrderSide.BUY, qty: 2 };
    p.applyOptionFill(
      { orderId: '1', symbol: ceContract.symbol, side: OrderSide.SELL, qty: 75, price: 100, ts: new Date(), fees: zeroFees() },
      sellLeg,
    );
    p.applyOptionFill(
      { orderId: '2', symbol: ceContract.symbol, side: OrderSide.BUY, qty: 150, price: 80, ts: new Date(), fees: zeroFees() },
      buyLeg,
    );
    const pos = p.optionPosition(ceContract.symbol)!;
    expect(pos.netQty).toBe(+1);
    expect(pos.avgPrice).toBe(80);
    // Realized: closing the short leg at 80 → (100 - 80) × 75 = 1500
    expect(pos.realizedPnl).toBeCloseTo(1500, 2);
    // Cash: 500_000 + 7500 (sell credit) - 12_000 (buy debit) = 495_500
    expect(p.cash).toBeCloseTo(495_500, 2);
  });

  it('re-open from netQty=0 resets contract+avgPrice to the new fill', () => {
    const p = new Portfolio(500_000);
    const sellLeg: Leg = { contract: ceContract, side: OrderSide.SELL, qty: 1 };
    const buyLeg: Leg = { contract: ceContract, side: OrderSide.BUY, qty: 1 };
    const reopenLeg: Leg = { contract: ceContract, side: OrderSide.SELL, qty: 1 };
    p.applyOptionFill(
      { orderId: '1', symbol: ceContract.symbol, side: OrderSide.SELL, qty: 75, price: 100, ts: new Date(), fees: zeroFees() },
      sellLeg,
    );
    p.applyOptionFill(
      { orderId: '2', symbol: ceContract.symbol, side: OrderSide.BUY, qty: 75, price: 80, ts: new Date(), fees: zeroFees() },
      buyLeg,
    );
    // After close: netQty 0
    expect(p.optionPosition(ceContract.symbol)!.netQty).toBe(0);
    // Re-open at a new price
    p.applyOptionFill(
      { orderId: '3', symbol: ceContract.symbol, side: OrderSide.SELL, qty: 75, price: 90, ts: new Date(), fees: zeroFees() },
      reopenLeg,
    );
    const pos = p.optionPosition(ceContract.symbol)!;
    expect(pos.netQty).toBe(-1);
    expect(pos.avgPrice).toBe(90);
  });

  it('same-direction stacking weights avgPrice by absolute qty', () => {
    const p = new Portfolio(500_000);
    const sellLeg1: Leg = { contract: ceContract, side: OrderSide.SELL, qty: 1 };
    const sellLeg2: Leg = { contract: ceContract, side: OrderSide.SELL, qty: 1 };
    p.applyOptionFill(
      { orderId: '1', symbol: ceContract.symbol, side: OrderSide.SELL, qty: 75, price: 100, ts: new Date(), fees: zeroFees() },
      sellLeg1,
    );
    p.applyOptionFill(
      { orderId: '2', symbol: ceContract.symbol, side: OrderSide.SELL, qty: 75, price: 120, ts: new Date(), fees: zeroFees() },
      sellLeg2,
    );
    const pos = p.optionPosition(ceContract.symbol)!;
    expect(pos.netQty).toBe(-2);
    expect(pos.avgPrice).toBeCloseTo(110, 6); // (100*1 + 120*1) / 2
  });

  it('fees are deducted from cash on each fill', () => {
    const p = new Portfolio(500_000);
    const leg: Leg = { contract: ceContract, side: OrderSide.SELL, qty: 1 };
    const fees: Fees = { brokerage: 2.25, stt: 7.5, exchange: 3.77, gst: 1.08, sebi: 0.01, stampDuty: 0, total: 14.61 };
    const f: Fill = {
      orderId: '1',
      symbol: ceContract.symbol,
      side: OrderSide.SELL,
      qty: 75,
      price: 100,
      ts: new Date(),
      fees,
    };
    p.applyOptionFill(f, leg);
    // 500_000 + 7500 - 14.61
    expect(p.cash).toBeCloseTo(507485.39, 2);
  });
});
