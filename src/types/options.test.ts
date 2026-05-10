import { describe, it, expect } from 'vitest';
import { OrderSide } from './index';
import type { OptionContract, Leg, MultiLegOrder, OptionPosition } from './options';

describe('option types', () => {
  const contract: OptionContract = {
    symbol: 'NIFTY25MAY22000CE',
    underlying: 'NIFTY',
    expiry: new Date('2025-05-22T10:00:00Z'),
    strike: 22000,
    optionType: 'CE',
    lotSize: 75,
    instrumentToken: 12345678,
  };

  it('constructs an OptionContract', () => {
    expect(contract.strike).toBe(22000);
    expect(contract.optionType).toBe('CE');
  });

  it('constructs a Leg', () => {
    const leg: Leg = { contract, side: OrderSide.SELL, qty: 1 };
    expect(leg.side).toBe('sell');
  });

  it('constructs a MultiLegOrder with multiple legs', () => {
    const order: MultiLegOrder = {
      id: 'ml-1',
      ts: new Date('2025-05-22T03:50:00Z'),
      legs: [
        { contract, side: OrderSide.SELL, qty: 1 },
        { contract: { ...contract, strike: 21900, optionType: 'PE', symbol: 'NIFTY25MAY21900PE' }, side: OrderSide.SELL, qty: 1 },
      ],
      reason: 'entry',
    };
    expect(order.legs).toHaveLength(2);
  });

  it('constructs an OptionPosition with negative qty for short', () => {
    const pos: OptionPosition = { contract, netQty: -1, avgPrice: 120, realizedPnl: 0 };
    expect(pos.netQty).toBe(-1);
  });
});
