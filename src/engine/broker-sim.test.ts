import { describe, it, expect } from 'vitest';
import { BrokerSim } from './broker-sim';
import { zeroBrokerage } from './brokerage/zerodha-intraday';
import { OrderSide, OrderType, OrderStatus, type Order, type Candle } from '../types';

const candle = (open: number, high: number, low: number, close: number, ts = '2025-01-02T03:50:00Z'): Candle => ({
  symbol: 'R',
  ts: new Date(ts),
  interval: '5minute',
  open, high, low, close,
  volume: 1000,
});

const order = (over: Partial<Order['intent']> = {}, id = 'o1'): Order => ({
  id,
  submittedAt: new Date('2025-01-02T03:45:00Z'),
  status: OrderStatus.SUBMITTED,
  intent: { symbol: 'R', side: OrderSide.BUY, qty: 1, type: OrderType.MARKET, ...over },
});

describe('BrokerSim', () => {
  it('market buy fills at next bar open + slippage', () => {
    const sim = new BrokerSim({ slippageBps: 10, brokerage: zeroBrokerage });
    const res = sim.processOrder(order({ side: OrderSide.BUY, type: OrderType.MARKET, qty: 1 }), candle(100, 102, 99, 101));
    expect(res.fill).not.toBeNull();
    expect(res.fill!.price).toBeCloseTo(100 * (1 + 10 / 10_000));
    expect(res.order.status).toBe(OrderStatus.FILLED);
  });

  it('market sell fills at next bar open − slippage', () => {
    const sim = new BrokerSim({ slippageBps: 10, brokerage: zeroBrokerage });
    const res = sim.processOrder(order({ side: OrderSide.SELL, type: OrderType.MARKET, qty: 1 }), candle(100, 102, 99, 101));
    expect(res.fill!.price).toBeCloseTo(100 * (1 - 10 / 10_000));
  });

  it('limit buy fills only when bar low <= limit, at min(limit, open)+slippage', () => {
    const sim = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const noFill = sim.processOrder(order({ type: OrderType.LIMIT, limitPrice: 95 }), candle(100, 102, 99, 101));
    expect(noFill.fill).toBeNull();
    expect(noFill.order.status).toBe(OrderStatus.PENDING);
    const fill = sim.processOrder(order({ type: OrderType.LIMIT, limitPrice: 100 }), candle(101, 102, 99, 100.5));
    expect(fill.fill!.price).toBeCloseTo(100); // min(limit=100, open=101) = 100
  });

  it('limit sell fills only when bar high >= limit, at max(limit, open)−slippage', () => {
    const sim = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const noFill = sim.processOrder(order({ side: OrderSide.SELL, type: OrderType.LIMIT, limitPrice: 110 }), candle(100, 105, 99, 101));
    expect(noFill.fill).toBeNull();
    const fill = sim.processOrder(order({ side: OrderSide.SELL, type: OrderType.LIMIT, limitPrice: 100 }), candle(99, 102, 98, 101));
    expect(fill.fill!.price).toBeCloseTo(100); // max(limit=100, open=99) = 100
  });

  it('stop buy triggers when bar high >= stop, fills at max(stop, open)+slippage', () => {
    const sim = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const noFill = sim.processOrder(order({ type: OrderType.STOP, stopPrice: 110 }), candle(100, 105, 99, 101));
    expect(noFill.fill).toBeNull();
    const fill = sim.processOrder(order({ type: OrderType.STOP, stopPrice: 100 }), candle(99, 102, 98, 101));
    expect(fill.fill!.price).toBeCloseTo(100); // max(stop=100, open=99) = 100
  });

  it('stop sell triggers when bar low <= stop, fills at min(stop, open)−slippage', () => {
    const sim = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const fill = sim.processOrder(order({ side: OrderSide.SELL, type: OrderType.STOP, stopPrice: 100 }), candle(101, 102, 99, 100));
    expect(fill.fill!.price).toBeCloseTo(100); // min(stop=100, open=101) = 100
  });

  it('attaches brokerage fees to the fill', () => {
    const fees = { brokerage: 5, stt: 1, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 6 };
    const sim = new BrokerSim({ slippageBps: 0, brokerage: () => fees });
    const res = sim.processOrder(order({ type: OrderType.MARKET, qty: 10 }), candle(100, 102, 99, 101));
    expect(res.fill!.fees).toEqual(fees);
  });
});
