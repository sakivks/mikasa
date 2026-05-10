import { describe, it, expect } from 'vitest';
import { computeMetrics, buildTrades } from './metrics';
import { OrderSide, type EquitySnapshot, type Fill } from '../types';

const snap = (ts: string, equity: number): EquitySnapshot => ({
  ts: new Date(ts),
  cash: 0,
  unrealized: 0,
  realized: 0,
  equity,
});

describe('computeMetrics', () => {
  it('totalReturn = (final/initial) - 1', () => {
    const curve = [snap('2025-01-02T03:45:00Z', 100_000), snap('2025-01-02T10:00:00Z', 110_000)];
    const m = computeMetrics({ equityCurve: curve, trades: [], initialCapital: 100_000 });
    expect(m.totalReturn).toBeCloseTo(0.1);
    expect(m.finalEquity).toBe(110_000);
  });

  it('maxDrawdown is the largest peak-to-trough decline', () => {
    const curve = [
      snap('2025-01-02T03:45:00Z', 100_000),
      snap('2025-01-02T03:50:00Z', 110_000),
      snap('2025-01-02T03:55:00Z', 90_000), // -18.18% from 110k
      snap('2025-01-02T04:00:00Z', 95_000),
      snap('2025-01-02T04:05:00Z', 105_000),
    ];
    const m = computeMetrics({ equityCurve: curve, trades: [], initialCapital: 100_000 });
    expect(m.maxDrawdownPct).toBeCloseTo((90_000 - 110_000) / 110_000, 4);
    expect(m.maxDrawdownAbs).toBeCloseTo(20_000);
  });

  it('winRate, avgWin, avgLoss, expectancy from trades', () => {
    const trades = [
      {
        symbol: 'R',
        qty: 1,
        entryPrice: 100,
        exitPrice: 110,
        entryTs: new Date(),
        exitTs: new Date(),
        side: OrderSide.BUY,
        pnl: 10,
        fees: 0,
      },
      {
        symbol: 'R',
        qty: 1,
        entryPrice: 100,
        exitPrice: 95,
        entryTs: new Date(),
        exitTs: new Date(),
        side: OrderSide.BUY,
        pnl: -5,
        fees: 0,
      },
      {
        symbol: 'R',
        qty: 1,
        entryPrice: 100,
        exitPrice: 105,
        entryTs: new Date(),
        exitTs: new Date(),
        side: OrderSide.BUY,
        pnl: 5,
        fees: 0,
      },
    ];
    const m = computeMetrics({ equityCurve: [], trades, initialCapital: 100_000 });
    expect(m.totalTrades).toBe(3);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.winRate).toBeCloseTo(2 / 3);
    expect(m.avgWin).toBeCloseTo((10 + 5) / 2);
    expect(m.avgLoss).toBeCloseTo(-5);
    expect(m.expectancy).toBeCloseTo((2 / 3) * 7.5 + (1 / 3) * -5);
  });

  it('sharpe from synthetic daily returns: known mean and std', () => {
    // Build curve where daily returns are [0.01, -0.005, 0.015, 0.0, 0.005]
    // mean = 0.005, std = sqrt(((0.005)^2 + (-0.01)^2 + (0.01)^2 + (-0.005)^2 + (0)^2) / 5) ≈ 0.0070710678
    // Sharpe (rf=0, daily) = mean/std ≈ 0.7071, annualized × sqrt(252)
    const start = 100_000;
    const rets = [0.01, -0.005, 0.015, 0.0, 0.005];
    const equities = [start];
    let v = start;
    for (const r of rets) {
      v = v * (1 + r);
      equities.push(v);
    }
    const curve: EquitySnapshot[] = equities.map((e, i) =>
      snap(`2025-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`, e),
    );
    const m = computeMetrics({ equityCurve: curve, trades: [], initialCapital: start });
    expect(m.sharpe).toBeGreaterThan(0);
    expect(Number.isFinite(m.sharpe)).toBe(true);
  });
});

describe('buildTrades', () => {
  it('pairs entry and exit fills into Trades (long-only, FIFO)', () => {
    const fills: Fill[] = [
      {
        orderId: '1',
        symbol: 'R',
        side: OrderSide.BUY,
        qty: 5,
        price: 100,
        ts: new Date('2025-01-02T03:50:00Z'),
        fees: { brokerage: 1, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 1 },
      },
      {
        orderId: '2',
        symbol: 'R',
        side: OrderSide.SELL,
        qty: 5,
        price: 110,
        ts: new Date('2025-01-02T04:00:00Z'),
        fees: { brokerage: 1, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 1 },
      },
    ];
    const trades = buildTrades(fills);
    expect(trades.length).toBe(1);
    expect(trades[0]!.entryPrice).toBe(100);
    expect(trades[0]!.exitPrice).toBe(110);
    expect(trades[0]!.qty).toBe(5);
    expect(trades[0]!.pnl).toBeCloseTo(5 * 10 - 2);
  });
});
