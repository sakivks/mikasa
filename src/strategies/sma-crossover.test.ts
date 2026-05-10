import { describe, it, expect } from 'vitest';
import { SmaCrossover } from './sma-crossover';
import { IndicatorRegistry } from '../indicators/registry';
import type { StrategyContext } from './strategy';
import { OrderSide, OrderType, type Candle, type OrderIntent, type Position } from '../types';
import { SMA } from '../indicators/sma';

function makeCtx(positions: Map<string, Position> = new Map()): {
  ctx: StrategyContext;
  submitted: OrderIntent[];
  reg: IndicatorRegistry;
} {
  const submitted: OrderIntent[] = [];
  const reg = new IndicatorRegistry();
  const ctx: StrategyContext = {
    cash: 100_000,
    position: (s) => positions.get(s) ?? null,
    submitOrder: (intent) => {
      submitted.push(intent);
      return `o-${submitted.length}`;
    },
    cancelOrder: () => {},
    indicator: reg,
    params: { fast: 2, slow: 4 },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
    optionPosition: () => null,
    submitMultiLeg: () => 'mlg-1',
    lastClose: () => undefined,
  };
  return { ctx, submitted, reg };
}

const bar = (close: number, ts = '2025-01-02T03:45:00Z'): Candle => ({
  symbol: 'R', ts: new Date(ts), interval: '5minute', open: close, high: close, low: close, close, volume: 1,
});

describe('SmaCrossover', () => {
  it('init registers fast and slow SMAs for each symbol in params.symbols', () => {
    const { ctx, reg } = makeCtx();
    ctx.params.symbols = ['R'];
    const s = new SmaCrossover();
    s.init(ctx);
    expect(reg.get('R', 'sma_fast')).toBeInstanceOf(SMA);
    expect(reg.get('R', 'sma_slow')).toBeInstanceOf(SMA);
  });

  it('buys when fast crosses above slow with no position', () => {
    const { ctx, submitted, reg } = makeCtx();
    ctx.params.symbols = ['R'];
    const s = new SmaCrossover();
    s.init(ctx);
    // Feed a series where fast crosses above slow at the last bar.
    // closes: 10,10,10,10 → flat, then 20 makes fast (last 2: 10,20=15) > slow (last 4: 10,10,10,20=12.5)
    for (const c of [10, 10, 10, 10]) {
      reg.feedClose('R', c);
      s.onBar(bar(c), ctx);
    }
    expect(submitted.length).toBe(0);
    reg.feedClose('R', 20);
    s.onBar(bar(20), ctx);
    expect(submitted.length).toBe(1);
    expect(submitted[0]!.side).toBe(OrderSide.BUY);
    expect(submitted[0]!.type).toBe(OrderType.MARKET);
    expect(submitted[0]!.qty).toBeGreaterThan(0);
  });

  it('sells (exits) when fast crosses below slow while long', () => {
    const positions = new Map<string, Position>([['R', { symbol: 'R', qty: 5, avgPrice: 15 }]]);
    const { ctx, submitted, reg } = makeCtx(positions);
    ctx.params.symbols = ['R'];
    const s = new SmaCrossover();
    s.init(ctx);
    for (const c of [20, 20, 20, 20]) {
      reg.feedClose('R', c);
      s.onBar(bar(c), ctx);
    }
    submitted.length = 0;
    // Drop pulls fast below slow
    reg.feedClose('R', 5);
    s.onBar(bar(5), ctx);
    expect(submitted.length).toBe(1);
    expect(submitted[0]!.side).toBe(OrderSide.SELL);
    expect(submitted[0]!.qty).toBe(5);
  });
});
