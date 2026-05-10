import { describe, it, expect } from 'vitest';
import { zerodhaDelivery } from './zerodha-delivery';
import { OrderSide } from '../../types';

describe('zerodhaDelivery', () => {
  it('charges zero brokerage and applies STT, stamp duty, exchange, sebi on the buy side', () => {
    const turnover = 10 * 100; // qty 10 × price 100 = 1000
    const fees = zerodhaDelivery({ side: OrderSide.BUY, qty: 10, price: 100 });
    expect(fees.brokerage).toBe(0);
    expect(fees.stt).toBeCloseTo(turnover * 0.001); // 0.1% on buy
    expect(fees.stampDuty).toBeCloseTo(turnover * 0.00015); // 0.015% buy only
    expect(fees.exchange).toBeCloseTo(turnover * 0.0000322);
    expect(fees.sebi).toBeCloseTo(turnover * 0.000001);
    expect(fees.gst).toBeCloseTo((0 + fees.exchange + fees.sebi) * 0.18);
  });

  it('charges STT on the sell side and zero stamp duty', () => {
    const turnover = 10 * 100;
    const fees = zerodhaDelivery({ side: OrderSide.SELL, qty: 10, price: 100 });
    expect(fees.brokerage).toBe(0);
    expect(fees.stt).toBeCloseTo(turnover * 0.001); // 0.1% also on sell
    expect(fees.stampDuty).toBe(0);
    expect(fees.exchange).toBeCloseTo(turnover * 0.0000322);
    expect(fees.sebi).toBeCloseTo(turnover * 0.000001);
  });

  it('total equals sum of components', () => {
    const buy = zerodhaDelivery({ side: OrderSide.BUY, qty: 1000, price: 1000 });
    const sumBuy = buy.brokerage + buy.stt + buy.exchange + buy.gst + buy.sebi + buy.stampDuty;
    expect(buy.total).toBeCloseTo(sumBuy);

    const sell = zerodhaDelivery({ side: OrderSide.SELL, qty: 1000, price: 1000 });
    const sumSell = sell.brokerage + sell.stt + sell.exchange + sell.gst + sell.sebi + sell.stampDuty;
    expect(sell.total).toBeCloseTo(sumSell);
  });
});
