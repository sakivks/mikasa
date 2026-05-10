import { describe, it, expect, vi } from 'vitest';
import { BacktestEngine } from './backtest-engine';
import { Portfolio } from './portfolio';
import { BrokerSim } from './broker-sim';
import { OrderRouter } from './order-router';
import { IndicatorRegistry } from '../indicators/registry';
import { Strategy, type StrategyContext } from '../strategies/strategy';
import { zeroBrokerage } from './brokerage/zerodha-intraday';
import { OrderSide, OrderType, type Candle } from '../types';
import type { OptionContract } from '../types/options';
import { createLogger, type Logger } from '../util/logger';

class BuyOnceStrategy extends Strategy {
  private bought = false;
  init(): void {}
  onBar(bar: Candle, ctx: StrategyContext): void {
    if (!this.bought) {
      ctx.submitOrder({ symbol: bar.symbol, side: OrderSide.BUY, qty: 1, type: OrderType.MARKET });
      this.bought = true;
    }
  }
}

class PeekStrategy extends Strategy {
  init(): void {}
  // attempts to read a property only available if engine leaks future bars (simulated by inspecting ctx)
  onBar(_bar: Candle, ctx: StrategyContext): void {
    // engine should never expose future bars; if (ctx as any).futureBars exists this is a leak
    if ((ctx as unknown as { futureBars?: Candle[] }).futureBars) {
      throw new Error('lookahead leak detected');
    }
  }
}

const cb = (ts: string, open: number, close = open, high = Math.max(open, close), low = Math.min(open, close)): Candle => ({
  symbol: 'R', ts: new Date(ts), interval: '5minute', open, high, low, close, volume: 1,
});

function makeEngine(strategy: Strategy, candles: Candle[], opts: { warmup?: number; squareoff?: string } = {}) {
  const portfolio = new Portfolio(100_000);
  const broker = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
  const router = new OrderRouter({ squareoffTime: opts.squareoff ?? '15:15' });
  const registry = new IndicatorRegistry();
  const logger = createLogger({ runId: 'test', level: 'error' });
  return new BacktestEngine({
    candles,
    strategy,
    portfolio,
    broker,
    router,
    indicators: registry,
    logger,
    warmupBars: opts.warmup ?? 0,
    params: { symbols: ['R'] },
  });
}

describe('BacktestEngine', () => {
  it('asserts time-monotonic input', () => {
    const out = [
      cb('2025-01-02T03:50:00Z', 100),
      cb('2025-01-02T03:45:00Z', 100), // out of order
    ];
    const engine = makeEngine(new BuyOnceStrategy(), out);
    expect(() => engine.run()).toThrow(/monotonic|order/i);
  });

  it('skips first warmupBars without invoking strategy.onBar or accepting orders', () => {
    let bars = 0;
    class Counter extends Strategy {
      init(): void {}
      onBar(): void {
        bars += 1;
      }
    }
    const candles = [
      cb('2025-01-02T03:45:00Z', 100),
      cb('2025-01-02T03:50:00Z', 101),
      cb('2025-01-02T03:55:00Z', 102),
      cb('2025-01-02T04:00:00Z', 103),
    ];
    const engine = makeEngine(new Counter(), candles, { warmup: 2 });
    engine.run();
    expect(bars).toBe(2); // 4 bars - 2 warmup = 2 onBar calls
  });

  it('orders submitted on bar N fill on bar N+1 (no lookahead)', () => {
    const candles = [
      cb('2025-01-02T03:45:00Z', 100, 100),
      cb('2025-01-02T03:50:00Z', 110, 110),
      cb('2025-01-02T03:55:00Z', 120, 120),
    ];
    const engine = makeEngine(new BuyOnceStrategy(), candles);
    const result = engine.run();
    // Strategy submits on bar 0 (open=100), fills on bar 1 (open=110)
    expect(result.fills.length).toBe(1);
    expect(result.fills[0]!.price).toBe(110);
  });

  it('squareoffs at squareoff bar: positions closed by EOD', () => {
    // Build a session: 09:15..15:15 IST in 5min steps. Use a single buy at first bar.
    const start = new Date('2025-01-02T03:45:00Z'); // 09:15 IST
    const candles: Candle[] = [];
    for (let i = 0; i < 73; i++) { // 73 bars covers 09:15..15:25
      candles.push(cb(new Date(start.getTime() + i * 5 * 60_000).toISOString(), 100));
    }
    const engine = makeEngine(new BuyOnceStrategy(), candles, { squareoff: '15:15' });
    const result = engine.run();
    // Expect a buy fill and a squareoff sell fill
    const buys = result.fills.filter((f) => f.side === OrderSide.BUY);
    const sells = result.fills.filter((f) => f.side === OrderSide.SELL);
    expect(buys.length).toBe(1);
    expect(sells.length).toBe(1);
  });

  it('does not leak future bars to strategy', () => {
    const candles = [cb('2025-01-02T03:45:00Z', 100), cb('2025-01-02T03:50:00Z', 101)];
    const engine = makeEngine(new PeekStrategy(), candles);
    expect(() => engine.run()).not.toThrow();
  });

  it('fills multi-symbol orders against the order symbol\'s next bar, not whatever bar is current', () => {
    // Two symbols, A and B, interleaved by ts. A submits at t=1; the fill must
    // use A's t=2 open (200), not B's t=2 open (50). Regression test for a
    // bug where the engine processed orders against any bar, including bars
    // for other symbols.
    const mkA = (ts: string, open: number): Candle => ({
      symbol: 'A', ts: new Date(ts), interval: 'day', open, high: open, low: open, close: open, volume: 1,
    });
    const mkB = (ts: string, open: number): Candle => ({
      symbol: 'B', ts: new Date(ts), interval: 'day', open, high: open, low: open, close: open, volume: 1,
    });
    const candles: Candle[] = [
      mkA('2025-01-02T00:00:00Z', 100),
      mkB('2025-01-02T00:00:00Z', 10),
      mkA('2025-01-03T00:00:00Z', 200), // A's "next bar" after submit
      mkB('2025-01-03T00:00:00Z', 50),
    ];
    class BuyAonceStrategy extends Strategy {
      private done = false;
      init(): void {}
      onBar(bar: Candle, ctx: StrategyContext): void {
        if (!this.done && bar.symbol === 'A') {
          ctx.submitOrder({ symbol: 'A', side: OrderSide.BUY, qty: 1, type: OrderType.MARKET });
          this.done = true;
        }
      }
    }
    const engine = makeEngine(new BuyAonceStrategy(), candles);
    const result = engine.run();
    expect(result.fills.length).toBe(1);
    expect(result.fills[0]!.symbol).toBe('A');
    expect(result.fills[0]!.price).toBe(200); // would be 50 (B's open) if buggy
  });

  it('records equity snapshots per bar', () => {
    const candles = [
      cb('2025-01-02T03:45:00Z', 100),
      cb('2025-01-02T03:50:00Z', 101),
      cb('2025-01-02T03:55:00Z', 102),
    ];
    class Noop extends Strategy { init(): void {} onBar(): void {} }
    const engine = makeEngine(new Noop(), candles);
    const result = engine.run();
    expect(result.equityCurve.length).toBe(3);
  });
});

describe('StrategyContext extensions', () => {
  it('lastClose returns the most recent close for a seen symbol, undefined for unseen', () => {
    const mkA = (ts: string, close: number): Candle => ({
      symbol: 'A', ts: new Date(ts), interval: 'day', open: close, high: close, low: close, close, volume: 1,
    });
    const candles: Candle[] = [
      mkA('2025-01-02T00:00:00Z', 100),
      mkA('2025-01-03T00:00:00Z', 105),
      mkA('2025-01-04T00:00:00Z', 110),
    ];
    let captured: StrategyContext | null = null;
    class Capture extends Strategy {
      init(ctx: StrategyContext): void {
        captured = ctx;
      }
      onBar(): void {}
    }
    const portfolio = new Portfolio(100_000);
    const broker = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const router = new OrderRouter({ squareoffTime: null });
    const registry = new IndicatorRegistry();
    const logger = createLogger({ runId: 'test', level: 'error' });
    const engine = new BacktestEngine({
      candles,
      strategy: new Capture(),
      portfolio,
      broker,
      router,
      indicators: registry,
      logger,
      warmupBars: 0,
      params: {},
    });
    engine.run();
    expect(captured).not.toBeNull();
    expect(captured!.lastClose('A')).toBe(110);
    expect(captured!.lastClose('NEVER')).toBeUndefined();
  });

});

// --- Capital + bankruptcy tests --------------------------------------------------

const expiry = new Date('2025-05-29T10:00:00Z');
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

/** Build an option-leg candle on a given symbol/date. */
const optBar = (symbol: string, ts: string, open: number, close = open): Candle => ({
  symbol,
  ts: new Date(ts),
  interval: '1minute',
  open,
  high: Math.max(open, close),
  low: Math.min(open, close),
  close,
  volume: 100,
});

function spyLogger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

describe('engine: capital + bankruptcy', () => {
  it('skips multi-leg when projected margin exceeds available cash', () => {
    // Tiny portfolio — far below the ~₹3.96L margin a NIFTY 22000 short straddle
    // (75 lot × 12% × 22000 × 2 legs) would attract.
    const TINY_CAPITAL = 1_000;
    const portfolio = new Portfolio(TINY_CAPITAL);
    const broker = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const router = new OrderRouter({ squareoffTime: null });
    const registry = new IndicatorRegistry();
    const logger = spyLogger();

    // Strategy submits a short straddle on the very first bar.
    class SellStraddleOnce extends Strategy {
      private submitted = false;
      init(): void {}
      onBar(_bar: Candle, ctx: StrategyContext): void {
        if (this.submitted) return;
        this.submitted = true;
        ctx.submitMultiLeg({
          legs: [
            { contract: ce, side: OrderSide.SELL, qty: 1 },
            { contract: pe, side: OrderSide.SELL, qty: 1 },
          ],
          reason: 'entry',
        });
      }
    }

    // Two bars per leg-symbol so the multi-leg has a strict next bar.
    const candles: Candle[] = [
      optBar(ce.symbol, '2025-05-22T03:45:00Z', 100),
      optBar(pe.symbol, '2025-05-22T03:45:00Z', 95),
      optBar(ce.symbol, '2025-05-22T03:50:00Z', 100),
      optBar(pe.symbol, '2025-05-22T03:50:00Z', 95),
    ];

    const engine = new BacktestEngine({
      candles,
      strategy: new SellStraddleOnce(),
      portfolio,
      broker,
      router,
      indicators: registry,
      logger,
      warmupBars: 0,
      params: {},
    });
    const result = engine.run();

    expect(result.fills).toHaveLength(0);
    expect(result.bankruptcy).toBeUndefined();
    // Confirm the structured "insufficient_margin" warn was emitted.
    const warnCalls = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const insufficient = warnCalls.find((args) => {
      const payload = args[0] as { reason?: string } | undefined;
      return payload?.reason === 'insufficient_margin';
    });
    expect(insufficient).toBeDefined();
  });

  it('detects bankruptcy and forces exit when equity goes non-positive', () => {
    // Modest capital — enough to seat a 1-lot short straddle on cheap premiums,
    // but a subsequent ten-fold premium spike will overwhelm equity.
    const portfolio = new Portfolio(50_000);
    const broker = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const router = new OrderRouter({ squareoffTime: null });
    const registry = new IndicatorRegistry();
    const logger = spyLogger();

    let postBankruptcyOnBars = 0;

    // To exercise the *bankruptcy* path the entry order must clear the margin
    // gate. Use a fake low-strike contract so estimateMargin (12% × 100 × 75 ×
    // 2 legs = ₹1,800) fits well within 50k cash. Then spike premiums later
    // so MTM tanks equity below zero.
    const lowCe: OptionContract = { ...ce, symbol: 'TINYCE', strike: 100, instrumentToken: 11 };
    const lowPe: OptionContract = { ...pe, symbol: 'TINYPE', strike: 100, instrumentToken: 12 };

    class SellTinyStraddle extends Strategy {
      private submitted = false;
      init(): void {}
      onBar(bar: Candle, ctx: StrategyContext): void {
        if (!this.submitted) {
          this.submitted = true;
          ctx.submitMultiLeg({
            legs: [
              { contract: lowCe, side: OrderSide.SELL, qty: 1 },
              { contract: lowPe, side: OrderSide.SELL, qty: 1 },
            ],
            reason: 'entry',
          });
          return;
        }
        if (bar.ts.getTime() >= new Date('2025-05-22T04:00:00Z').getTime()) {
          postBankruptcyOnBars += 1;
        }
      }
    }

    // Bars (interleaved by symbol):
    //   t0: open=10 → entry submission
    //   t1: open=10 → fills at 10/leg (cash credit +1500 per leg, total +3000)
    //   t2: open=2000 → MTM: short P&L = (10 - 2000) × 75 × 2 = -298,500 → equity nuke
    //   t3: bars exist so reversals can fill
    const symC = lowCe.symbol;
    const symP = lowPe.symbol;
    const candles: Candle[] = [
      optBar(symC, '2025-05-22T03:45:00Z', 10),
      optBar(symP, '2025-05-22T03:45:00Z', 10),
      optBar(symC, '2025-05-22T03:50:00Z', 10),
      optBar(symP, '2025-05-22T03:50:00Z', 10),
      optBar(symC, '2025-05-22T03:55:00Z', 2000, 2000),
      optBar(symP, '2025-05-22T03:55:00Z', 2000, 2000),
      optBar(symC, '2025-05-22T04:00:00Z', 2000, 2000),
      optBar(symP, '2025-05-22T04:00:00Z', 2000, 2000),
      optBar(symC, '2025-05-22T04:05:00Z', 2000, 2000),
      optBar(symP, '2025-05-22T04:05:00Z', 2000, 2000),
    ];

    const engine = new BacktestEngine({
      candles,
      strategy: new SellTinyStraddle(),
      portfolio,
      broker,
      router,
      indicators: registry,
      logger,
      warmupBars: 0,
      params: {},
    });
    const result = engine.run();

    expect(result.bankruptcy).toBe(true);
    // We expect 2 entry fills + 2 reversal fills = 4 total.
    expect(result.fills.length).toBe(4);
    const reversalBuys = result.fills.filter((f) => f.side === OrderSide.BUY);
    expect(reversalBuys.length).toBe(2);
    // After bankruptcy is declared, no further onBar calls should run.
    expect(postBankruptcyOnBars).toBe(0);
    // Sanity: bankruptcy log fired.
    const errCalls = (logger.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const bankruptcyLog = errCalls.find((args) => args[1] === 'bankruptcy: forced exit');
    expect(bankruptcyLog).toBeDefined();
  });
});
