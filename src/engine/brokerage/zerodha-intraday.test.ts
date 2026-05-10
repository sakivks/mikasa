import { describe, it, expect } from 'vitest';
import { zerodhaIntraday } from './zerodha-intraday';
import { OrderSide } from '../../types';

describe('zerodhaIntraday', () => {
  it('caps brokerage at ₹20 per executed order', () => {
    const fees = zerodhaIntraday({ side: OrderSide.BUY, qty: 1000, price: 1000 });
    expect(fees.brokerage).toBe(20); // 0.03% × 1_000_000 = 300, capped to 20
  });

  it('uses 0.03% when below cap', () => {
    const fees = zerodhaIntraday({ side: OrderSide.BUY, qty: 10, price: 100 }); // turnover 1000
    expect(fees.brokerage).toBeCloseTo(0.3);
  });

  it('STT applies only to sell side at 0.025% turnover', () => {
    const buy = zerodhaIntraday({ side: OrderSide.BUY, qty: 10, price: 100 });
    const sell = zerodhaIntraday({ side: OrderSide.SELL, qty: 10, price: 100 });
    expect(buy.stt).toBe(0);
    expect(sell.stt).toBeCloseTo(0.25); // 0.025% × 1000 = 0.25
  });

  it('total equals sum of components', () => {
    const f = zerodhaIntraday({ side: OrderSide.SELL, qty: 1000, price: 1000 });
    const sum = f.brokerage + f.stt + f.exchange + f.gst + f.sebi + f.stampDuty;
    expect(f.total).toBeCloseTo(sum);
  });
});
