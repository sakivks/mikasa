import { describe, it, expect, vi } from 'vitest';
import { ShortStraddle } from './short-straddle';
import type { StrategyContext } from './strategy';
import type { OptionContract, MultiLegOrder } from '../types/options';
import { OrderSide, type Candle } from '../types';

const expiry = new Date('2025-05-22T10:00:00Z');
const ce: OptionContract = {
  symbol: 'NIFTY25MAY22000CE',
  underlying: 'NIFTY',
  expiry,
  strike: 22000,
  optionType: 'CE',
  lotSize: 75,
  instrumentToken: 1,
};
const pe: OptionContract = {
  ...ce,
  symbol: 'NIFTY25MAY22000PE',
  optionType: 'PE',
  instrumentToken: 2,
};

function makeCtx(
  closes: Map<string, number> = new Map(),
  paramOverrides: Record<string, unknown> = {},
): { ctx: StrategyContext; submitted: Array<Omit<MultiLegOrder, 'id' | 'ts'>> } {
  const submitted: Array<Omit<MultiLegOrder, 'id' | 'ts'>> = [];
  const ctx: StrategyContext = {
    cash: 1_000_000,
    position: () => null,
    optionPosition: () => null,
    submitOrder: () => 'o-1',
    submitMultiLeg: (o) => {
      submitted.push(o);
      return `ml-${submitted.length}`;
    },
    cancelOrder: () => {},
    lastClose: (s) => closes.get(s),
    indicator: {} as never,
    params: {
      entryTime: '09:20',
      exitTime: '15:15',
      slPctOnPremium: 30,
      targetPctOnPremium: 60,
      lots: 1,
      underlying: 'NIFTY',
      spotSymbol: 'NIFTY 50',
      atmContracts: { '2025-05-22': { ce, pe } },
      ...paramOverrides,
    },
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  };
  return { ctx, submitted };
}

/** Build a Candle whose `ts` (UTC) corresponds to the given IST HH:MM on 2025-05-22. */
const spotBar = (timeIst: string, symbol = 'NIFTY 50', dateIst = '2025-05-22'): Candle => {
  const [hh, mm] = timeIst.split(':').map(Number);
  const [y, mo, d] = dateIst.split('-').map(Number);
  const istMs = Date.UTC(y!, mo! - 1, d!, hh!, mm!) - 5.5 * 3600 * 1000;
  return {
    symbol,
    ts: new Date(istMs),
    interval: '1minute',
    open: 22000,
    high: 22010,
    low: 21990,
    close: 22000,
    volume: 0,
  };
};

describe('ShortStraddle', () => {
  it('emits SELL straddle at entry time on expiry day', () => {
    const closes = new Map<string, number>([
      ['NIFTY25MAY22000CE', 100],
      ['NIFTY25MAY22000PE', 95],
    ]);
    const { ctx, submitted } = makeCtx(closes);
    const s = new ShortStraddle();
    s.init(ctx);
    s.onBar(spotBar('09:20'), ctx);

    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.legs).toHaveLength(2);
    expect(submitted[0]!.legs.every((l) => l.side === OrderSide.SELL)).toBe(true);
    expect(submitted[0]!.reason).toBe('entry');
    expect(submitted[0]!.legs[0]!.contract.symbol).toBe('NIFTY25MAY22000CE');
    expect(submitted[0]!.legs[1]!.contract.symbol).toBe('NIFTY25MAY22000PE');
  });

  it('exits on SL when combined premium up 30%', () => {
    const closes = new Map<string, number>([
      ['NIFTY25MAY22000CE', 100],
      ['NIFTY25MAY22000PE', 95],
    ]);
    const { ctx, submitted } = makeCtx(closes);
    const s = new ShortStraddle();
    s.init(ctx);
    s.onBar(spotBar('09:20'), ctx);
    expect(submitted).toHaveLength(1);

    // Spike: 195 * 1.31 = 255.45 ≥ 195 * 1.30 = 253.5 → SL hit
    closes.set('NIFTY25MAY22000CE', 130);
    closes.set('NIFTY25MAY22000PE', 130);
    s.onBar(spotBar('09:25'), ctx);

    expect(submitted).toHaveLength(2);
    expect(submitted[1]!.legs.every((l) => l.side === OrderSide.BUY)).toBe(true);
    expect(submitted[1]!.reason).toBe('sl');
  });

  it('exits on target when combined premium drops 60%', () => {
    const closes = new Map<string, number>([
      ['NIFTY25MAY22000CE', 100],
      ['NIFTY25MAY22000PE', 100],
    ]);
    const { ctx, submitted } = makeCtx(closes);
    const s = new ShortStraddle();
    s.init(ctx);
    s.onBar(spotBar('09:20'), ctx);

    // Drop: 200 * 0.4 = 80 ≤ threshold 200 * (1 - 0.6) = 80 → target hit
    closes.set('NIFTY25MAY22000CE', 40);
    closes.set('NIFTY25MAY22000PE', 40);
    s.onBar(spotBar('11:00'), ctx);

    expect(submitted).toHaveLength(2);
    expect(submitted[1]!.legs.every((l) => l.side === OrderSide.BUY)).toBe(true);
    expect(submitted[1]!.reason).toBe('target');
  });

  it('exits at EOD when neither SL nor target triggered', () => {
    const closes = new Map<string, number>([
      ['NIFTY25MAY22000CE', 100],
      ['NIFTY25MAY22000PE', 95],
    ]);
    const { ctx, submitted } = makeCtx(closes);
    const s = new ShortStraddle();
    s.init(ctx);
    s.onBar(spotBar('09:20'), ctx);

    // Mild change — no SL, no target
    closes.set('NIFTY25MAY22000CE', 105);
    closes.set('NIFTY25MAY22000PE', 100);
    s.onBar(spotBar('15:15'), ctx);

    expect(submitted).toHaveLength(2);
    expect(submitted[1]!.legs.every((l) => l.side === OrderSide.BUY)).toBe(true);
    expect(submitted[1]!.reason).toBe('eod');
  });

  it('does nothing on a non-expiry day', () => {
    const closes = new Map<string, number>([
      ['NIFTY25MAY22000CE', 100],
      ['NIFTY25MAY22000PE', 95],
    ]);
    const { ctx, submitted } = makeCtx(closes);
    const s = new ShortStraddle();
    s.init(ctx);
    // 2025-05-21 is not in atmContracts
    s.onBar(spotBar('09:20', 'NIFTY 50', '2025-05-21'), ctx);
    s.onBar(spotBar('15:15', 'NIFTY 50', '2025-05-21'), ctx);

    expect(submitted).toHaveLength(0);
  });

  it('ignores non-spot symbol bars (e.g. option contract bars)', () => {
    const closes = new Map<string, number>([
      ['NIFTY25MAY22000CE', 100],
      ['NIFTY25MAY22000PE', 95],
    ]);
    const { ctx, submitted } = makeCtx(closes);
    const s = new ShortStraddle();
    s.init(ctx);
    // Same expiry day, same time, but bar is for an option contract, not the spot
    s.onBar(spotBar('09:20', 'NIFTY25MAY22000CE'), ctx);
    s.onBar(spotBar('09:20', 'NIFTY25MAY22000PE'), ctx);

    expect(submitted).toHaveLength(0);
  });
});
