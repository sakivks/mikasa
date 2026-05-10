import { describe, it, expect } from 'vitest';
import { DailyTrend } from './daily-trend';
import { IndicatorRegistry } from '../indicators/registry';
import { SMA } from '../indicators/sma';
import type { StrategyContext } from './strategy';
import { OrderSide, OrderType, type Candle, type OrderIntent, type Position } from '../types';

function makeCtx(
  positions: Map<string, Position> = new Map(),
  cash = 100_000,
): {
  ctx: StrategyContext;
  submitted: OrderIntent[];
  reg: IndicatorRegistry;
  positions: Map<string, Position>;
} {
  const submitted: OrderIntent[] = [];
  const reg = new IndicatorRegistry();
  const ctx: StrategyContext = {
    cash,
    position: (s) => positions.get(s) ?? null,
    submitOrder: (intent) => {
      submitted.push(intent);
      return `o-${submitted.length}`;
    },
    cancelOrder: () => {},
    indicator: reg,
    // Use small periods to keep test data short; fraction is the new knob.
    params: { fast: 2, slow: 4, fraction: 0.5 },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
    optionPosition: () => null,
    submitMultiLeg: () => 'mlg-1',
    lastClose: () => undefined,
  };
  return { ctx, submitted, reg, positions };
}

const bar = (close: number, ts = '2025-01-02T03:45:00Z'): Candle => ({
  symbol: 'R',
  ts: new Date(ts),
  interval: 'day',
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
});

describe('DailyTrend', () => {
  it('init registers fast and slow SMAs for each basket symbol; rejects fast >= slow', () => {
    const { ctx, reg } = makeCtx();
    ctx.params.symbols = ['R', 'I'];
    const s = new DailyTrend();
    s.init(ctx);
    expect(reg.get('R', 'sma_fast')).toBeInstanceOf(SMA);
    expect(reg.get('R', 'sma_slow')).toBeInstanceOf(SMA);
    expect(reg.get('I', 'sma_fast')).toBeInstanceOf(SMA);
    expect(reg.get('I', 'sma_slow')).toBeInstanceOf(SMA);

    const bad = makeCtx();
    bad.ctx.params.symbols = ['R'];
    bad.ctx.params.fast = 10;
    bad.ctx.params.slow = 5;
    expect(() => new DailyTrend().init(bad.ctx)).toThrow(/fast/);
  });

  it('cross-up triggers a BUY with qty proportional to fraction * equity / price', () => {
    const { ctx, submitted, reg } = makeCtx(new Map(), 100_000);
    ctx.params.symbols = ['R'];
    const s = new DailyTrend();
    s.init(ctx);
    // Flat closes: no cross-up yet.
    for (const c of [10, 10, 10, 10]) {
      reg.feedClose('R', c);
      s.onBar(bar(c), ctx);
    }
    expect(submitted.length).toBe(0);

    // Spike: fast (last 2: 10, 20 = 15) > slow (last 4: 10, 10, 10, 20 = 12.5) → cross up.
    reg.feedClose('R', 20);
    s.onBar(bar(20), ctx);
    expect(submitted.length).toBe(1);
    const o = submitted[0]!;
    expect(o.side).toBe(OrderSide.BUY);
    expect(o.type).toBe(OrderType.MARKET);
    expect(o.tag).toBe('trend_up');
    // No prior positions → equity = cash = 100_000. fraction 0.5 → notional 50_000 (within 95% cash cap).
    // qty = floor(50_000 / 20) = 2500.
    expect(o.qty).toBe(2500);
  });

  it('cross-down with an open position triggers a SELL of the full qty', () => {
    const positions = new Map<string, Position>([['R', { symbol: 'R', qty: 7, avgPrice: 18 }]]);
    const { ctx, submitted, reg } = makeCtx(positions);
    ctx.params.symbols = ['R'];
    const s = new DailyTrend();
    s.init(ctx);

    // Climb so fast > slow first.
    for (const c of [20, 20, 20, 20]) {
      reg.feedClose('R', c);
      s.onBar(bar(c), ctx);
    }
    submitted.length = 0;

    // Drop pulls fast below slow → cross-down.
    reg.feedClose('R', 5);
    s.onBar(bar(5), ctx);
    expect(submitted.length).toBe(1);
    const o = submitted[0]!;
    expect(o.side).toBe(OrderSide.SELL);
    expect(o.qty).toBe(7);
    expect(o.tag).toBe('trend_down');
  });
});
