import { describe, it, expect } from 'vitest';
import { ORB } from './orb';
import { IndicatorRegistry } from '../indicators/registry';
import type { StrategyContext } from './strategy';
import { OrderSide, OrderType, type Candle, type OrderIntent, type Position } from '../types';
import { parseHHMMtoUTC } from '../util/time';

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
  };
  return { ctx, submitted, reg, positions };
}

function ohlc(symbol: string, ts: Date, o: number, h: number, l: number, c: number): Candle {
  return { symbol, ts, interval: '5minute', open: o, high: h, low: l, close: c, volume: 1 };
}

const SYMBOL = 'R';

/** Build a bar at IST hh:mm on the given yyyy-MM-dd. */
function ibar(date: string, hhmm: string, o: number, h: number, l: number, c: number): Candle {
  return ohlc(SYMBOL, parseHHMMtoUTC(date, hhmm), o, h, l, c);
}

describe('ORB strategy', () => {
  it('establishes opening range over the first 6 bars (30min @ 5min interval) and breaks out on bar 7', () => {
    const { ctx, submitted } = makeCtx();
    ctx.params.symbols = [SYMBOL];
    ctx.params.openingMinutes = 30;
    ctx.params.intervalMin = 5;
    const s = new ORB();
    s.init(ctx);

    // 6 bars at 09:15, 09:20, 09:25, 09:30, 09:35, 09:40 — opening range high = 105.
    const openingBars: Candle[] = [
      ibar('2025-04-01', '09:15', 100, 102, 99, 101),
      ibar('2025-04-01', '09:20', 101, 103, 100, 102),
      ibar('2025-04-01', '09:25', 102, 104, 101, 103),
      ibar('2025-04-01', '09:30', 103, 105, 102, 104),
      ibar('2025-04-01', '09:35', 104, 105, 103, 104),
      ibar('2025-04-01', '09:40', 104, 105, 103, 104),
    ];
    for (const b of openingBars) s.onBar(b, ctx);
    expect(submitted.length).toBe(0);

    // Bar 7 at 09:45 closes above opening high (105) → BUY.
    s.onBar(ibar('2025-04-01', '09:45', 105, 110, 105, 108), ctx);
    expect(submitted.length).toBe(1);
    expect(submitted[0]!.symbol).toBe(SYMBOL);
    expect(submitted[0]!.side).toBe(OrderSide.BUY);
    expect(submitted[0]!.type).toBe(OrderType.MARKET);
    expect(submitted[0]!.qty).toBeGreaterThan(0);
    expect(submitted[0]!.tag).toBe('orb_long');
  });

  it('exits on stop-loss when a subsequent bar dips below entry * (1 - stopBps)', () => {
    const positions = new Map<string, Position>([[SYMBOL, { symbol: SYMBOL, qty: 10, avgPrice: 108 }]]);
    const { ctx, submitted } = makeCtx(positions);
    ctx.params.symbols = [SYMBOL];
    ctx.params.openingMinutes = 30;
    ctx.params.intervalMin = 5;
    ctx.params.stopBps = 50; // 0.5% stop → 108 * 0.995 = 107.46
    const s = new ORB();
    s.init(ctx);

    // Establish opening range first (otherwise no trades).
    for (const t of ['09:15', '09:20', '09:25', '09:30', '09:35', '09:40']) {
      s.onBar(ibar('2025-04-01', t, 100, 105, 99, 102), ctx);
    }
    submitted.length = 0;

    // Bar with low = 107 (below 107.46 stop) → SELL.
    s.onBar(ibar('2025-04-01', '09:45', 108, 108, 107, 107.5), ctx);
    expect(submitted.length).toBe(1);
    expect(submitted[0]!.side).toBe(OrderSide.SELL);
    expect(submitted[0]!.qty).toBe(10);
    expect(submitted[0]!.tag).toBe('orb_stop');
  });

  it('resets the opening range on a new IST trading day', () => {
    const { ctx, submitted } = makeCtx();
    ctx.params.symbols = [SYMBOL];
    ctx.params.openingMinutes = 30;
    ctx.params.intervalMin = 5;
    const s = new ORB();
    s.init(ctx);

    // Day 1: establish range with high = 105 and break out.
    for (const t of ['09:15', '09:20', '09:25', '09:30', '09:35', '09:40']) {
      s.onBar(ibar('2025-04-01', t, 100, 105, 99, 102), ctx);
    }
    s.onBar(ibar('2025-04-01', '09:45', 106, 110, 106, 108), ctx);
    expect(submitted.length).toBe(1);
    submitted.length = 0;

    // Day 2: range must reset. First bar at 09:15 with high=200 should NOT
    // be enough to fire a buy yet (opening not established).
    s.onBar(ibar('2025-04-02', '09:15', 195, 200, 190, 198), ctx);
    expect(submitted.length).toBe(0);

    // Continue establishing the new day's opening range.
    for (const t of ['09:20', '09:25', '09:30', '09:35', '09:40']) {
      s.onBar(ibar('2025-04-02', t, 195, 200, 190, 198), ctx);
    }
    expect(submitted.length).toBe(0);

    // Now break the new opening high (200).
    s.onBar(ibar('2025-04-02', '09:45', 200, 205, 200, 203), ctx);
    expect(submitted.length).toBe(1);
    expect(submitted[0]!.tag).toBe('orb_long');
  });
});
