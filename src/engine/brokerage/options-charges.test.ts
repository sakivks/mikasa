import { describe, it, expect } from 'vitest';
import { calcOptionLegCharges, type FilledLeg } from './options-charges';
import { OrderSide } from '../../types';
import type { OptionContract } from '../../types';

const ceContract: OptionContract = {
  symbol: 'NIFTY25MAY22000CE',
  underlying: 'NIFTY',
  expiry: new Date('2025-05-22T10:00:00Z'),
  strike: 22000,
  optionType: 'CE',
  lotSize: 75,
  instrumentToken: 1,
};

describe('calcOptionLegCharges', () => {
  it('SELL leg: STT 0.1% on premium, brokerage capped at 20', () => {
    const leg: FilledLeg = { contract: ceContract, side: OrderSide.SELL, qty: 1, price: 100 };
    // turnover = 100 * 1 * 75 = 7500
    const f = calcOptionLegCharges(leg);
    // brokerage = min(20, 7500*0.0003=2.25) = 2.25
    // stt = 7500*0.001 = 7.5
    // exchange = 7500*0.000503 = 3.7725
    // sebi = 7500*0.000001 = 0.0075
    // stampDuty = 0 (sell)
    // gst = (2.25 + 3.7725 + 0.0075) * 0.18 = 1.0854
    expect(f.brokerage).toBeCloseTo(2.25, 4);
    expect(f.stt).toBeCloseTo(7.5, 4);
    expect(f.exchange).toBeCloseTo(3.7725, 4);
    expect(f.sebi).toBeCloseTo(0.0075, 4);
    expect(f.stampDuty).toBe(0);
    expect(f.gst).toBeCloseTo(1.0854, 4);
    expect(f.total).toBeCloseTo(14.6154, 3);
  });

  it('BUY leg: no STT, stamp duty 0.003%, brokerage capped at 20', () => {
    const leg: FilledLeg = { contract: ceContract, side: OrderSide.BUY, qty: 5, price: 100 };
    // turnover = 100 * 5 * 75 = 37500
    const f = calcOptionLegCharges(leg);
    // brokerage = min(20, 37500*0.0003=11.25) = 11.25
    expect(f.stt).toBe(0);
    expect(f.stampDuty).toBeCloseTo(37500 * 0.00003, 4);
    expect(f.brokerage).toBeCloseTo(11.25, 4);
  });

  it('caps brokerage at ₹20 for high-turnover leg', () => {
    const leg: FilledLeg = { contract: ceContract, side: OrderSide.SELL, qty: 100, price: 1000 };
    // turnover = 7,500,000; 0.0003 = 2250 → cap to 20
    const f = calcOptionLegCharges(leg);
    expect(f.brokerage).toBe(20);
  });
});
