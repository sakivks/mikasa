import { describe, it, expect, vi } from 'vitest';
import { IronCondor } from './iron-condor';
import type { StrategyContext } from './strategy';
import type { OptionContract, MultiLegOrder } from '../types/options';
import { OrderSide, type Candle } from '../types';

const expiry = new Date('2025-05-22T10:00:00Z');

const shortCall: OptionContract = {
  symbol: 'NIFTY25MAY22200CE',
  underlying: 'NIFTY',
  expiry,
  strike: 22200,
  optionType: 'CE',
  lotSize: 75,
  instrumentToken: 1,
};
const longCall: OptionContract = {
  ...shortCall,
  symbol: 'NIFTY25MAY22300CE',
  strike: 22300,
  instrumentToken: 2,
};
const shortPut: OptionContract = {
  ...shortCall,
  symbol: 'NIFTY25MAY21800PE',
  strike: 21800,
  optionType: 'PE',
  instrumentToken: 3,
};
const longPut: OptionContract = {
  ...shortCall,
  symbol: 'NIFTY25MAY21700PE',
  strike: 21700,
  optionType: 'PE',
  instrumentToken: 4,
};

const weeklyContracts = {
  '2025-W21': { shortCall, longCall, shortPut, longPut },
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
      entryDay: 'monday',
      entryTime: '09:30',
      exitDay: 'thursday',
      exitTime: '15:00',
      shortStrikeOffset: 200,
      wingWidth: 100,
      slPctOnCredit: 30,
      lots: 1,
      underlying: 'NIFTY',
      spotSymbol: 'NIFTY 50',
      weeklyContracts,
      ...paramOverrides,
    },
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  };
  return { ctx, submitted };
}

/** Build a Candle whose `ts` (UTC) corresponds to the given IST HH:MM on the given IST date. */
const spotBar = (timeIst: string, symbol = 'NIFTY 50', dateIst = '2025-05-19'): Candle => {
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

describe('IronCondor', () => {
  it('emits a 4-leg condor at entry time on Monday', () => {
    const closes = new Map<string, number>([
      ['NIFTY25MAY22200CE', 100],
      ['NIFTY25MAY22300CE', 30],
      ['NIFTY25MAY21800PE', 95],
      ['NIFTY25MAY21700PE', 25],
    ]);
    const { ctx, submitted } = makeCtx(closes);
    const s = new IronCondor();
    s.init(ctx);
    s.onBar(spotBar('09:30', 'NIFTY 50', '2025-05-19'), ctx);

    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.legs).toHaveLength(4);
    expect(submitted[0]!.reason).toBe('entry');
    expect(submitted[0]!.legs[0]!.contract.symbol).toBe('NIFTY25MAY22200CE');
    expect(submitted[0]!.legs[0]!.side).toBe(OrderSide.SELL);
    expect(submitted[0]!.legs[1]!.contract.symbol).toBe('NIFTY25MAY22300CE');
    expect(submitted[0]!.legs[1]!.side).toBe(OrderSide.BUY);
    expect(submitted[0]!.legs[2]!.contract.symbol).toBe('NIFTY25MAY21800PE');
    expect(submitted[0]!.legs[2]!.side).toBe(OrderSide.SELL);
    expect(submitted[0]!.legs[3]!.contract.symbol).toBe('NIFTY25MAY21700PE');
    expect(submitted[0]!.legs[3]!.side).toBe(OrderSide.BUY);
  });

  it('exits on Thursday at exitTime with reversed sides', () => {
    const closes = new Map<string, number>([
      ['NIFTY25MAY22200CE', 100],
      ['NIFTY25MAY22300CE', 30],
      ['NIFTY25MAY21800PE', 95],
      ['NIFTY25MAY21700PE', 25],
    ]);
    const { ctx, submitted } = makeCtx(closes);
    const s = new IronCondor();
    s.init(ctx);
    // Monday entry
    s.onBar(spotBar('09:30', 'NIFTY 50', '2025-05-19'), ctx);
    expect(submitted).toHaveLength(1);

    // Mild drift — no SL
    closes.set('NIFTY25MAY22200CE', 80);
    closes.set('NIFTY25MAY22300CE', 20);
    closes.set('NIFTY25MAY21800PE', 80);
    closes.set('NIFTY25MAY21700PE', 20);

    // Thursday exit at exitTime
    s.onBar(spotBar('15:00', 'NIFTY 50', '2025-05-22'), ctx);

    expect(submitted).toHaveLength(2);
    expect(submitted[1]!.legs).toHaveLength(4);
    expect(submitted[1]!.reason).toBe('exit');
    expect(submitted[1]!.legs[0]!.contract.symbol).toBe('NIFTY25MAY22200CE');
    expect(submitted[1]!.legs[0]!.side).toBe(OrderSide.BUY);
    expect(submitted[1]!.legs[1]!.contract.symbol).toBe('NIFTY25MAY22300CE');
    expect(submitted[1]!.legs[1]!.side).toBe(OrderSide.SELL);
    expect(submitted[1]!.legs[2]!.contract.symbol).toBe('NIFTY25MAY21800PE');
    expect(submitted[1]!.legs[2]!.side).toBe(OrderSide.BUY);
    expect(submitted[1]!.legs[3]!.contract.symbol).toBe('NIFTY25MAY21700PE');
    expect(submitted[1]!.legs[3]!.side).toBe(OrderSide.SELL);
  });

  it('exits on SL when MTM loss exceeds 30% of credit received', () => {
    const closes = new Map<string, number>([
      ['NIFTY25MAY22200CE', 100],
      ['NIFTY25MAY22300CE', 30],
      ['NIFTY25MAY21800PE', 95],
      ['NIFTY25MAY21700PE', 25],
    ]);
    const { ctx, submitted } = makeCtx(closes);
    const s = new IronCondor();
    s.init(ctx);
    // Entry: credit per share = (100+95)-(30+25) = 140; total credit = 140*75 = 10500
    s.onBar(spotBar('09:30', 'NIFTY 50', '2025-05-19'), ctx);
    expect(submitted).toHaveLength(1);

    // Spike: shorts blow up. buyBack/share = (180+180)-(40+40) = 280; cost = 280*75 = 21000
    // mtmPnl = 10500 - 21000 = -10500 ≤ -10500*0.30 = -3150 → SL hit
    closes.set('NIFTY25MAY22200CE', 180);
    closes.set('NIFTY25MAY22300CE', 40);
    closes.set('NIFTY25MAY21800PE', 180);
    closes.set('NIFTY25MAY21700PE', 40);
    s.onBar(spotBar('11:00', 'NIFTY 50', '2025-05-20'), ctx);

    expect(submitted).toHaveLength(2);
    expect(submitted[1]!.reason).toBe('sl');
    expect(submitted[1]!.legs[0]!.side).toBe(OrderSide.BUY);   // close shortCall
    expect(submitted[1]!.legs[1]!.side).toBe(OrderSide.SELL);  // close longCall
    expect(submitted[1]!.legs[2]!.side).toBe(OrderSide.BUY);   // close shortPut
    expect(submitted[1]!.legs[3]!.side).toBe(OrderSide.SELL);  // close longPut
  });

  it('does not enter on a non-Monday weekday', () => {
    const closes = new Map<string, number>([
      ['NIFTY25MAY22200CE', 100],
      ['NIFTY25MAY22300CE', 30],
      ['NIFTY25MAY21800PE', 95],
      ['NIFTY25MAY21700PE', 25],
    ]);
    const { ctx, submitted } = makeCtx(closes);
    const s = new IronCondor();
    s.init(ctx);
    // 2025-05-20 is Tuesday — should be ignored even at entryTime
    s.onBar(spotBar('09:30', 'NIFTY 50', '2025-05-20'), ctx);
    expect(submitted).toHaveLength(0);
  });

  it('ignores non-spot symbol bars', () => {
    const closes = new Map<string, number>([
      ['NIFTY25MAY22200CE', 100],
      ['NIFTY25MAY22300CE', 30],
      ['NIFTY25MAY21800PE', 95],
      ['NIFTY25MAY21700PE', 25],
    ]);
    const { ctx, submitted } = makeCtx(closes);
    const s = new IronCondor();
    s.init(ctx);
    // Same Monday at entryTime, but bar is for an option contract, not spot
    s.onBar(spotBar('09:30', 'NIFTY25MAY22200CE', '2025-05-19'), ctx);
    s.onBar(spotBar('09:30', 'NIFTY25MAY21800PE', '2025-05-19'), ctx);
    expect(submitted).toHaveLength(0);
  });
});
