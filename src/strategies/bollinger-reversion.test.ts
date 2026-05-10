import { describe, it, expect } from 'vitest';
import { BollingerReversion } from './bollinger-reversion';
import { IndicatorRegistry } from '../indicators/registry';
import type { StrategyContext } from './strategy';
import { OrderSide, type Candle, type OrderIntent, type Position } from '../types';

function makeCtx(positions: Map<string, Position> = new Map()): {
  ctx: StrategyContext;
  submitted: OrderIntent[];
  reg: IndicatorRegistry;
  positions: Map<string, Position>;
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
    params: {},
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
  };
  return { ctx, submitted, reg, positions };
}

const SYMBOL = 'R';
function bar(close: number, low?: number): Candle {
  return {
    symbol: SYMBOL,
    ts: new Date('2025-01-02T03:45:00Z'),
    interval: '5minute',
    open: close,
    high: close,
    low: low ?? close,
    close,
    volume: 1,
  };
}

describe('BollingerReversion', () => {
  it('init registers a Bollinger indicator per symbol', () => {
    const { ctx, reg } = makeCtx();
    ctx.params.symbols = [SYMBOL];
    ctx.params.period = 5;
    new BollingerReversion().init(ctx);
    expect(reg.get(SYMBOL, 'bb')).toBeDefined();
  });

  it('buys when close dips below lower band, exits when close rises above middle', () => {
    const { ctx, submitted, reg, positions } = makeCtx();
    ctx.params.symbols = [SYMBOL];
    // Use a longer period so a single dip bar doesn't dominate mean/stddev.
    ctx.params.period = 20;
    ctx.params.stddev = 2;
    ctx.params.stopBps = 5_000; // wide stop, isolate band logic
    const s = new BollingerReversion();
    s.init(ctx);

    // 20 quiet bars around 100 → very tight bands.
    const warm: number[] = [];
    for (let i = 0; i < 20; i++) warm.push(100 + (i % 2 === 0 ? 0.1 : -0.1));
    for (const p of warm) {
      reg.feedClose(SYMBOL, p);
      s.onBar(bar(p), ctx);
    }
    expect(submitted.length).toBe(0);

    // Sharp dip well below the lower band. With 20 quiet samples + 1 dip the
    // recomputed lower band is still well above the dip price.
    reg.feedClose(SYMBOL, 95);
    s.onBar(bar(95), ctx);
    expect(submitted.length).toBe(1);
    expect(submitted[0]!.side).toBe(OrderSide.BUY);
    expect(submitted[0]!.tag).toBe('bb_below_lower');
    positions.set(SYMBOL, { symbol: SYMBOL, qty: submitted[0]!.qty, avgPrice: 95 });
    submitted.length = 0;

    // Recover above the (~100) middle band.
    let exited = false;
    for (const p of [97, 99, 101, 103]) {
      reg.feedClose(SYMBOL, p);
      s.onBar(bar(p), ctx);
      if (submitted.length > 0) {
        exited = true;
        break;
      }
    }
    expect(exited).toBe(true);
    expect(submitted[0]!.side).toBe(OrderSide.SELL);
    expect(submitted[0]!.tag).toBe('bb_exit');
  });

  it('exits on stop when bar low breaches avgPrice * (1 - stopBps/10000)', () => {
    const positions = new Map<string, Position>([
      [SYMBOL, { symbol: SYMBOL, qty: 7, avgPrice: 100 }],
    ]);
    const { ctx, submitted, reg } = makeCtx(positions);
    ctx.params.symbols = [SYMBOL];
    ctx.params.period = 5;
    ctx.params.stopBps = 100; // 1% → stop at 99
    const s = new BollingerReversion();
    s.init(ctx);

    // Warm Bollinger up so it's defined.
    for (const p of [100, 100.5, 100.2, 100.7, 100.4]) {
      reg.feedClose(SYMBOL, p);
      s.onBar(bar(p), ctx);
    }
    submitted.length = 0;

    // Bar with low = 98 < stop (99) → sell.
    reg.feedClose(SYMBOL, 98.5);
    s.onBar(bar(98.5, 98), ctx);
    expect(submitted.length).toBe(1);
    expect(submitted[0]!.side).toBe(OrderSide.SELL);
    expect(submitted[0]!.tag).toBe('bb_stop');
    expect(submitted[0]!.qty).toBe(7);
  });
});
