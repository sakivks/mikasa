import { describe, it, expect } from 'vitest';
import { OrderRouter } from './order-router';
import { OrderSide, OrderType, type Position } from '../types';

const pos = (qty: number): Position => ({ symbol: 'R', qty, avgPrice: 100 });

describe('OrderRouter', () => {
  it('passes through strategy intents as queued orders', () => {
    const r = new OrderRouter({ squareoffTime: '15:15' });
    const id = r.submit({ symbol: 'R', side: OrderSide.BUY, qty: 1, type: OrderType.MARKET });
    expect(typeof id).toBe('string');
    expect(r.queued().length).toBe(1);
    expect(r.queued()[0]!.intent.symbol).toBe('R');
  });

  it('emits exit-all market orders at squareoff time', () => {
    const r = new OrderRouter({ squareoffTime: '15:15' });
    const ts = new Date('2025-01-02T09:45:00Z'); // 15:15 IST
    r.maybeSquareoff(ts, [pos(10), { symbol: 'I', qty: -5, avgPrice: 1000 }]);
    const queued = r.queued();
    expect(queued.length).toBe(2);
    const long = queued.find((o) => o.intent.symbol === 'R')!;
    expect(long.intent.side).toBe(OrderSide.SELL);
    expect(long.intent.qty).toBe(10);
    expect(long.intent.tag).toMatch(/squareoff/);
    const short = queued.find((o) => o.intent.symbol === 'I')!;
    expect(short.intent.side).toBe(OrderSide.BUY);
    expect(short.intent.qty).toBe(5);
  });

  it('does not squareoff at non-squareoff bars', () => {
    const r = new OrderRouter({ squareoffTime: '15:15' });
    const ts = new Date('2025-01-02T06:00:00Z'); // 11:30 IST
    r.maybeSquareoff(ts, [pos(10)]);
    expect(r.queued().length).toBe(0);
  });

  it('drain() returns and clears queued orders', () => {
    const r = new OrderRouter({ squareoffTime: '15:15' });
    r.submit({ symbol: 'R', side: OrderSide.BUY, qty: 1, type: OrderType.MARKET });
    const drained = r.drain();
    expect(drained.length).toBe(1);
    expect(r.queued().length).toBe(0);
  });

  it('idempotent squareoff: calling at same bar twice does not double-emit', () => {
    const r = new OrderRouter({ squareoffTime: '15:15' });
    const ts = new Date('2025-01-02T09:45:00Z');
    r.maybeSquareoff(ts, [pos(10)]);
    r.maybeSquareoff(ts, [pos(10)]);
    expect(r.queued().length).toBe(1);
  });
});
