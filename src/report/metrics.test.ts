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

  it('short → buy-to-close, single lot, profit', () => {
    const fills: Fill[] = [
      {
        orderId: '1',
        symbol: 'NIFTY25000CE',
        side: OrderSide.SELL,
        qty: 75,
        price: 100,
        ts: new Date('2025-01-02T03:50:00Z'),
        fees: { brokerage: 2, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 2 },
      },
      {
        orderId: '2',
        symbol: 'NIFTY25000CE',
        side: OrderSide.BUY,
        qty: 75,
        price: 80,
        ts: new Date('2025-01-02T04:00:00Z'),
        fees: { brokerage: 3, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 3 },
      },
    ];
    const trades = buildTrades(fills);
    expect(trades.length).toBe(1);
    const t = trades[0]!;
    expect(t.side).toBe(OrderSide.SELL);
    expect(t.entryPrice).toBe(100);
    expect(t.exitPrice).toBe(80);
    expect(t.qty).toBe(75);
    // pnl = (entry - exit) × qty - fees = (100 - 80) × 75 - (2 + 3) = 1500 - 5 = 1495
    expect(t.pnl).toBeCloseTo(1495);
    expect(t.fees).toBeCloseTo(5);
  });

  it('short → buy-to-close, partial close', () => {
    const fills: Fill[] = [
      {
        orderId: '1',
        symbol: 'NIFTY25000PE',
        side: OrderSide.SELL,
        qty: 100,
        price: 100,
        ts: new Date('2025-01-02T03:50:00Z'),
        fees: { brokerage: 5, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 5 },
      },
      {
        orderId: '2',
        symbol: 'NIFTY25000PE',
        side: OrderSide.BUY,
        qty: 60,
        price: 80,
        ts: new Date('2025-01-02T04:00:00Z'),
        fees: { brokerage: 3, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 3 },
      },
    ];
    const trades = buildTrades(fills);
    expect(trades.length).toBe(1);
    const t = trades[0]!;
    expect(t.side).toBe(OrderSide.SELL);
    expect(t.entryPrice).toBe(100);
    expect(t.exitPrice).toBe(80);
    expect(t.qty).toBe(60);
    // proportional entry fees = 5 × 60/100 = 3; exit fees = 3 (full)
    // pnl = (100 - 80) × 60 - 3 - 3 = 1200 - 6 = 1194
    expect(t.pnl).toBeCloseTo(1194);
    expect(t.fees).toBeCloseTo(6);

    // 40 lots remain open; closing them with another buy verifies the residual lot.
    const moreFills: Fill[] = [
      ...fills,
      {
        orderId: '3',
        symbol: 'NIFTY25000PE',
        side: OrderSide.BUY,
        qty: 40,
        price: 90,
        ts: new Date('2025-01-02T04:10:00Z'),
        fees: { brokerage: 2, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 2 },
      },
    ];
    const trades2 = buildTrades(moreFills);
    expect(trades2.length).toBe(2);
    const t2 = trades2[1]!;
    expect(t2.side).toBe(OrderSide.SELL);
    expect(t2.qty).toBe(40);
    expect(t2.entryPrice).toBe(100);
    expect(t2.exitPrice).toBe(90);
  });

  it('short → reversal (buy more than open) emits Trade and opens new long lot', () => {
    const fills: Fill[] = [
      {
        orderId: '1',
        symbol: 'NIFTY',
        side: OrderSide.SELL,
        qty: 50,
        price: 100,
        ts: new Date('2025-01-02T03:50:00Z'),
        fees: { brokerage: 2, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 2 },
      },
      {
        orderId: '2',
        symbol: 'NIFTY',
        side: OrderSide.BUY,
        qty: 80,
        price: 90,
        ts: new Date('2025-01-02T04:00:00Z'),
        fees: { brokerage: 4, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 4 },
      },
    ];
    const trades = buildTrades(fills);
    // Should emit exactly one Trade for the closed 50 short lots.
    expect(trades.length).toBe(1);
    const t = trades[0]!;
    expect(t.side).toBe(OrderSide.SELL);
    expect(t.qty).toBe(50);
    expect(t.entryPrice).toBe(100);
    expect(t.exitPrice).toBe(90);
    // proportional exit fees = 4 × 50/80 = 2.5
    // pnl = (100 - 90) × 50 - 2 - 2.5 = 500 - 4.5 = 495.5
    expect(t.pnl).toBeCloseTo(495.5);

    // Verify residual 30 long lots open at 90 by closing them with a sell.
    const closeFills: Fill[] = [
      ...fills,
      {
        orderId: '3',
        symbol: 'NIFTY',
        side: OrderSide.SELL,
        qty: 30,
        price: 95,
        ts: new Date('2025-01-02T04:10:00Z'),
        fees: { brokerage: 1, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 1 },
      },
    ];
    const trades2 = buildTrades(closeFills);
    expect(trades2.length).toBe(2);
    const t2 = trades2[1]!;
    expect(t2.side).toBe(OrderSide.BUY);
    expect(t2.qty).toBe(30);
    expect(t2.entryPrice).toBe(90);
    expect(t2.exitPrice).toBe(95);
  });
});
