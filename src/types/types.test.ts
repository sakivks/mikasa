import { describe, it, expect } from 'vitest';
import type { Candle, OrderIntent, Order, Fill, Position, Trade, Fees } from './index';
import { OrderSide, OrderType, OrderStatus } from './index';

describe('core types', () => {
  it('constructs a Candle', () => {
    const c: Candle = {
      symbol: 'RELIANCE',
      ts: new Date('2025-01-02T03:45:00Z'),
      interval: '5minute',
      open: 1200,
      high: 1205,
      low: 1199,
      close: 1203,
      volume: 100_000,
    };
    expect(c.close).toBe(1203);
  });

  it('exposes order enums', () => {
    expect(OrderSide.BUY).toBe('buy');
    expect(OrderSide.SELL).toBe('sell');
    expect(OrderType.MARKET).toBe('market');
    expect(OrderType.LIMIT).toBe('limit');
    expect(OrderType.STOP).toBe('stop');
    expect(OrderStatus.SUBMITTED).toBe('submitted');
    expect(OrderStatus.FILLED).toBe('filled');
    expect(OrderStatus.REJECTED).toBe('rejected');
    expect(OrderStatus.PENDING).toBe('pending');
    expect(OrderStatus.EXPIRED).toBe('expired');
  });

  it('constructs an OrderIntent and Order/Fill/Position/Trade/Fees', () => {
    const intent: OrderIntent = {
      symbol: 'RELIANCE',
      side: OrderSide.BUY,
      qty: 10,
      type: OrderType.MARKET,
    };
    const order: Order = {
      id: 'ord-1',
      submittedAt: new Date(),
      status: OrderStatus.SUBMITTED,
      intent,
    };
    const fees: Fees = { brokerage: 20, stt: 1, exchange: 0.1, gst: 3.6, sebi: 0.001, stampDuty: 0.05, total: 24.751 };
    const fill: Fill = {
      orderId: order.id,
      symbol: 'RELIANCE',
      side: OrderSide.BUY,
      qty: 10,
      price: 1200,
      ts: new Date(),
      fees,
    };
    const pos: Position = { symbol: 'RELIANCE', qty: 10, avgPrice: 1200 };
    const trade: Trade = {
      symbol: 'RELIANCE',
      qty: 10,
      entryPrice: 1200,
      exitPrice: 1210,
      entryTs: new Date(),
      exitTs: new Date(),
      side: OrderSide.BUY,
      pnl: 100 - fees.total,
      fees: fees.total,
    };
    expect(order.intent.qty).toBe(10);
    expect(fill.fees.total).toBeCloseTo(24.751);
    expect(pos.avgPrice).toBe(1200);
    expect(trade.pnl).toBeCloseTo(100 - fees.total);
  });
});
