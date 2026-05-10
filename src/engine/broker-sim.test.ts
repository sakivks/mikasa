import { describe, it, expect } from 'vitest';
import { BrokerSim } from './broker-sim';
import { zeroBrokerage } from './brokerage/zerodha-intraday';
import { OrderSide, OrderType, OrderStatus, type Order, type Candle } from '../types';
import type { MultiLegOrder, OptionContract, OptionType } from '../types/options';

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

const makeContract = (over: { strike: number; type: OptionType }): OptionContract => ({
  symbol: `NIFTY25MAY${over.strike}${over.type}`,
  underlying: 'NIFTY',
  expiry: new Date('2025-05-29T10:00:00Z'),
  strike: over.strike,
  optionType: over.type,
  lotSize: 75,
  instrumentToken: over.strike * 10 + (over.type === 'CE' ? 1 : 2),
});

const makeBar = (symbol: string, over: { open: number; close: number; ts?: string }): Candle => ({
  symbol,
  ts: new Date(over.ts ?? '2025-05-22T03:55:00Z'),
  interval: '5minute',
  open: over.open,
  high: Math.max(over.open, over.close) + 1,
  low: Math.min(over.open, over.close) - 1,
  close: over.close,
  volume: 1000,
});

describe('BrokerSim.processMultiLeg', () => {
  it('fills all legs atomically at next bar open with 1-tick adverse slippage', () => {
    const sim = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const ce = makeContract({ strike: 22000, type: 'CE' });
    const pe = makeContract({ strike: 22000, type: 'PE' });
    const ml: MultiLegOrder = {
      id: 'ml-1',
      ts: new Date('2025-05-22T03:50:00Z'),
      legs: [
        { contract: ce, side: OrderSide.SELL, qty: 1 },
        { contract: pe, side: OrderSide.SELL, qty: 1 },
      ],
      reason: 'entry',
    };
    const nextBars = new Map<string, Candle>([
      [ce.symbol, makeBar(ce.symbol, { open: 100, close: 102 })],
      [pe.symbol, makeBar(pe.symbol, { open: 95, close: 97 })],
    ]);
    const res = sim.processMultiLeg(ml, nextBars);
    expect(res.rejection).toBeUndefined();
    expect(res.fills).toHaveLength(2);
    // SELL: 1 tick (₹0.05) BELOW open — adverse to seller.
    expect(res.fills[0]!.price).toBeCloseTo(99.95, 5);
    expect(res.fills[1]!.price).toBeCloseTo(94.95, 5);
    // Sell-side STT > 0 verifies real options charges schedule was used.
    expect(res.fills[0]!.fees.stt).toBeGreaterThan(0);
    expect(res.fills[0]!.multiLegOrderId).toBe('ml-1');
    expect(res.fills[1]!.multiLegOrderId).toBe('ml-1');
    // qty in fills is in shares (lots × lotSize).
    expect(res.fills[0]!.qty).toBe(1 * ce.lotSize);
    expect(res.fills[1]!.qty).toBe(1 * pe.lotSize);
    // ts copied from each leg's next bar.
    expect(res.fills[0]!.ts).toEqual(nextBars.get(ce.symbol)!.ts);
  });

  it('applies +tick slippage to BUY legs and -tick to SELL legs in the same basket', () => {
    const sim = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const ce = makeContract({ strike: 22000, type: 'CE' });
    const pe = makeContract({ strike: 22000, type: 'PE' });
    const ml: MultiLegOrder = {
      id: 'ml-mix',
      ts: new Date('2025-05-22T03:50:00Z'),
      legs: [
        { contract: ce, side: OrderSide.BUY, qty: 2 },
        { contract: pe, side: OrderSide.SELL, qty: 1 },
      ],
      reason: 'entry',
    };
    const nextBars = new Map<string, Candle>([
      [ce.symbol, makeBar(ce.symbol, { open: 50, close: 51 })],
      [pe.symbol, makeBar(pe.symbol, { open: 80, close: 79 })],
    ]);
    const res = sim.processMultiLeg(ml, nextBars);
    expect(res.fills[0]!.price).toBeCloseTo(50.05, 5); // BUY pays +tick
    expect(res.fills[1]!.price).toBeCloseTo(79.95, 5); // SELL receives -tick
    // BUY incurs stamp duty (no STT); SELL incurs STT (no stamp duty).
    expect(res.fills[0]!.fees.stampDuty).toBeGreaterThan(0);
    expect(res.fills[0]!.fees.stt).toBe(0);
    expect(res.fills[1]!.fees.stt).toBeGreaterThan(0);
    expect(res.fills[1]!.fees.stampDuty).toBe(0);
  });

  it('rejects the whole basket when any leg has no next bar (atomic fail)', () => {
    const sim = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const ce = makeContract({ strike: 22000, type: 'CE' });
    const pe = makeContract({ strike: 22000, type: 'PE' });
    const ml: MultiLegOrder = {
      id: 'ml-2',
      ts: new Date('2025-05-22T03:50:00Z'),
      legs: [
        { contract: ce, side: OrderSide.SELL, qty: 1 },
        { contract: pe, side: OrderSide.SELL, qty: 1 },
      ],
      reason: 'entry',
    };
    // Only the CE leg has a next bar — PE is missing.
    const nextBars = new Map<string, Candle>([[ce.symbol, makeBar(ce.symbol, { open: 100, close: 102 })]]);
    const res = sim.processMultiLeg(ml, nextBars);
    expect(res.fills).toHaveLength(0);
    expect(res.rejection).toBeDefined();
    expect(res.rejection!.reason).toBe('no-liquidity');
  });
});
