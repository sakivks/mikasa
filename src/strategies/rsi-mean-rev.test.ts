import { describe, it, expect } from 'vitest';
import { RsiMeanRev } from './rsi-mean-rev';
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
    optionPosition: () => null,
    submitMultiLeg: () => 'mlg-1',
    lastClose: () => undefined,
    subscribeOptions: () => {},
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

describe('RsiMeanRev', () => {
  it('init registers an RSI indicator per symbol', () => {
    const { ctx, reg } = makeCtx();
    ctx.params.symbols = [SYMBOL];
    ctx.params.period = 4;
    new RsiMeanRev().init(ctx);
    expect(reg.get(SYMBOL, 'rsi')).toBeDefined();
  });

  it('rejects oversoldLevel >= exitLevel', () => {
    const { ctx } = makeCtx();
    ctx.params.symbols = [SYMBOL];
    ctx.params.oversoldLevel = 60;
    ctx.params.exitLevel = 50;
    expect(() => new RsiMeanRev().init(ctx)).toThrow(/oversoldLevel/);
  });

  it('buys when RSI dips below oversoldLevel and exits when it rebounds above exitLevel', () => {
    const { ctx, submitted, reg, positions } = makeCtx();
    ctx.params.symbols = [SYMBOL];
    ctx.params.period = 4;
    ctx.params.oversoldLevel = 30;
    ctx.params.exitLevel = 50;
    // Set a wide stop so the stop doesn't trip during the synthetic series —
    // we want to isolate the RSI-rebound exit path here.
    ctx.params.stopBps = 5_000; // 50%
    const s = new RsiMeanRev();
    s.init(ctx);

    // Falling series → RSI eventually drops under 30.
    const downPrices = [100, 98, 96, 94, 92, 90, 88, 86, 84, 82, 80, 78, 76, 74, 72, 70];
    let bought = false;
    for (const p of downPrices) {
      reg.feedClose(SYMBOL, p);
      s.onBar(bar(p), ctx);
      if (submitted.length > 0 && !bought) {
        bought = true;
        expect(submitted[0]!.side).toBe(OrderSide.BUY);
        expect(submitted[0]!.tag).toBe('rsi_oversold');
        // Simulate the fill: install a long position at a low avg so the
        // wide stop never trips even at the bottom of the down-leg.
        positions.set(SYMBOL, { symbol: SYMBOL, qty: submitted[0]!.qty, avgPrice: p });
      }
    }
    expect(bought).toBe(true);
    submitted.length = 0;

    // Rising series → RSI climbs above 50, expect SELL exit.
    const upPrices = [72, 75, 78, 81, 84, 87, 90, 93, 96, 99];
    let exited = false;
    for (const p of upPrices) {
      reg.feedClose(SYMBOL, p);
      s.onBar(bar(p), ctx);
      if (submitted.length > 0 && !exited) {
        exited = true;
        expect(submitted[0]!.side).toBe(OrderSide.SELL);
        expect(submitted[0]!.tag).toBe('rsi_exit');
      }
    }
    expect(exited).toBe(true);
  });

  it('exits on stop when bar low breaches avgPrice * (1 - stopBps/10000)', () => {
    const positions = new Map<string, Position>([
      [SYMBOL, { symbol: SYMBOL, qty: 10, avgPrice: 100 }],
    ]);
    const { ctx, submitted, reg } = makeCtx(positions);
    ctx.params.symbols = [SYMBOL];
    ctx.params.period = 4;
    ctx.params.stopBps = 100; // 1% → stop at 99
    const s = new RsiMeanRev();
    s.init(ctx);

    // Warm RSI up so it's defined (RSI value doesn't matter here — stop fires
    // on price first).
    for (const p of [100, 100.5, 100.2, 100.7, 100.4, 100.6]) {
      reg.feedClose(SYMBOL, p);
      s.onBar(bar(p), ctx);
    }
    submitted.length = 0;

    // Bar with low = 98 < stop (99) → sell.
    reg.feedClose(SYMBOL, 98.5);
    s.onBar(bar(98.5, 98), ctx);
    expect(submitted.length).toBe(1);
    expect(submitted[0]!.side).toBe(OrderSide.SELL);
    expect(submitted[0]!.tag).toBe('rsi_stop');
    expect(submitted[0]!.qty).toBe(10);
  });
});
