import { describe, it, expect, beforeAll } from 'vitest';
import { runBacktest } from '../../src/engine/backtest-engine';
import { Portfolio } from '../../src/engine/portfolio';
import { BrokerSim } from '../../src/engine/broker-sim';
import { OrderRouter } from '../../src/engine/order-router';
import { IndicatorRegistry } from '../../src/indicators/registry';
import { ShortStraddle } from '../../src/strategies/short-straddle';
import { zeroBrokerage } from '../../src/engine/brokerage/zerodha-intraday';
import type { Candle } from '../../src/types';
import type { OptionContract } from '../../src/types/options';
import { renderOptionsSection } from '../../src/report/options-report';

/**
 * End-to-end integration test: Short straddle strategy on synthetic-but-realistic
 * 1-minute candle data covering 4 weekly NIFTY expiries in May 2025.
 *
 * Fixtures are generated deterministically inline (no JSON committed, no RNG).
 * Premiums decay linearly over the trading session so the strategy reliably
 * exits at EOD with a positive net P&L per expiry.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const ATM_STRIKE = 22000;
const LOT_SIZE = 75;

const EXPIRIES = ['2025-05-08', '2025-05-15', '2025-05-22', '2025-05-29'] as const;

interface ExpiryDayData {
  spotCandles: Candle[];
  ceCandles: Candle[];
  peCandles: Candle[];
  ceContract: OptionContract;
  peContract: OptionContract;
}

/** Convert IST date+minute-offset to a UTC Date. minute=0 maps to 09:15 IST. */
function istBarTs(ymd: string, minutesFrom0915: number): Date {
  const [y, mo, d] = ymd.split('-').map(Number);
  const istUtcMs =
    Date.UTC(y!, mo! - 1, d!, 9, 15, 0, 0) + minutesFrom0915 * 60_000 - IST_OFFSET_MS;
  return new Date(istUtcMs);
}

/** Linear ramp from `start` to `end` across [0, totalBars-1]. */
function ramp(i: number, start: number, end: number, totalBars: number): number {
  if (totalBars <= 1) return start;
  return start + ((end - start) * i) / (totalBars - 1);
}

function generateExpiryDayData(expiryYmd: string, atmStrike: number): ExpiryDayData {
  // 09:15..15:30 IST inclusive at 1m → 376 bars (we cap at 375 to land exactly on 15:29).
  // Strategy entry at 09:20 (i=5), exit at 15:15 (i=360) → next bar 15:16 (i=361) for fill.
  const TOTAL_BARS = 376; // 0..375 → 09:15..15:31 (we'll keep through 15:31 to be safe)

  // Each weekly expiry gets a UNIQUE option symbol (otherwise ShortStraddle entries
  // across expiries pile into one position and net out incorrectly).
  // The options-report grouping regex is /(\d{4}-\d{2}-\d{2})/, matching the
  // hyphenated full-date form emitted by `buildOptionSymbol` — so each weekly
  // expiry naturally produces a distinct row in the per-expiry report.
  const expiry = istBarTs(expiryYmd, 6 * 60); // expiry "time" 15:15 IST (irrelevant for sim)
  const ceContract: OptionContract = {
    symbol: `NIFTY-${expiryYmd}-${atmStrike}-CE`,
    underlying: 'NIFTY',
    expiry,
    strike: atmStrike,
    optionType: 'CE',
    lotSize: LOT_SIZE,
    instrumentToken: 1000 + parseInt(expiryYmd.replace(/-/g, ''), 10),
  };
  const peContract: OptionContract = {
    ...ceContract,
    symbol: `NIFTY-${expiryYmd}-${atmStrike}-PE`,
    optionType: 'PE',
    instrumentToken: 2000 + parseInt(expiryYmd.replace(/-/g, ''), 10),
  };

  const spotCandles: Candle[] = [];
  const ceCandles: Candle[] = [];
  const peCandles: Candle[] = [];

  // Premium decays from 150 at 09:15 → 5 at 15:30 (linear).
  const PREM_START = 150;
  const PREM_END = 5;
  // Spot tiny deterministic wiggle around ATM so close === ATM at every bar
  // (keeps ATM resolution unambiguous and avoids any drift surprises).
  for (let i = 0; i < TOTAL_BARS; i++) {
    const ts = istBarTs(expiryYmd, i);

    spotCandles.push({
      symbol: 'NIFTY 50',
      ts,
      interval: '1minute',
      open: atmStrike,
      high: atmStrike + 5,
      low: atmStrike - 5,
      close: atmStrike,
      volume: 0,
    });

    const prem = ramp(i, PREM_START, PREM_END, TOTAL_BARS);
    // Tiny ε so high>=open>=close>=low always holds with strict numeric noise.
    const premNext = ramp(Math.min(i + 1, TOTAL_BARS - 1), PREM_START, PREM_END, TOTAL_BARS);
    const open = prem;
    const close = premNext;
    const high = Math.max(open, close) + 0.05;
    const low = Math.min(open, close) - 0.05;
    ceCandles.push({
      symbol: ceContract.symbol,
      ts,
      interval: '1minute',
      open,
      high,
      low,
      close,
      volume: 0,
    });
    peCandles.push({
      symbol: peContract.symbol,
      ts,
      interval: '1minute',
      open,
      high,
      low,
      close,
      volume: 0,
    });
  }

  return { spotCandles, ceCandles, peCandles, ceContract, peContract };
}

describe('short straddle integration — NIFTY May 2025', () => {
  let allCandles: Candle[];
  let atmContracts: Record<string, { ce: OptionContract; pe: OptionContract }>;

  beforeAll(() => {
    const buf: Candle[] = [];
    atmContracts = {};
    for (const ymd of EXPIRIES) {
      const data = generateExpiryDayData(ymd, ATM_STRIKE);
      buf.push(...data.spotCandles, ...data.ceCandles, ...data.peCandles);
      atmContracts[ymd] = { ce: data.ceContract, pe: data.peContract };
    }
    // Stable sort by ts ascending. For same ts, we want SPOT first so strategy.onBar
    // on the spot bar never sees the CE/PE bar of the same minute (no lookahead).
    // The push order above is [spot, ce, pe] per expiry, so a stable sort preserves
    // that intra-minute order.
    buf.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    allCandles = buf;
  });

  function runScenario() {
    const portfolio = new Portfolio(500_000);
    const broker = new BrokerSim({ slippageBps: 0, brokerage: zeroBrokerage });
    const router = new OrderRouter({ squareoffTime: null });
    const indicators = new IndicatorRegistry();
    const strategy = new ShortStraddle();
    const noopLogger = {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    } as never;

    return runBacktest({
      candles: allCandles,
      strategy,
      portfolio,
      broker,
      router,
      indicators,
      logger: noopLogger,
      warmupBars: 0,
      params: {
        entryTime: '09:20',
        exitTime: '15:15',
        slPctOnPremium: 30,
        targetPctOnPremium: 60,
        lots: 1,
        underlying: 'NIFTY',
        spotSymbol: 'NIFTY 50',
        atmContracts,
      },
    });
  }

  it('runs to completion and produces 16 multi-leg fills with non-zero net P&L', () => {
    const result = runScenario();

    // 4 expiries × (entry 2 fills + exit 2 fills) = 16 fills.
    expect(result.fills.length).toBe(16);

    // Every fill should carry a multiLegOrderId.
    const mlFills = result.fills.filter((f) => f.multiLegOrderId !== undefined);
    expect(mlFills.length).toBe(16);

    // Final equity must be positive and finite. Hand-calc:
    //   Entry @ 09:21 → CE+PE open ≈ 147.68 each, slipped to 147.63 SELL (per share).
    //   ep = 2 × CE/PE close at 09:19 = 296.12. target = ep × (1 - 0.60) = 118.45.
    //   Premium curve hits target at bar i ≈ 235 (~13:10 IST); exit fills at 13:11
    //   with BUY @ ramp(236) + 0.05 ≈ 58.80 each.
    //   Per-expiry net premium captured = 2 × (147.63 − 58.80) × 75 ≈ 13_325.
    //   Across 4 expiries: ~53_300, less ~52 charges per expiry round-trip ≈ −207.
    //   Expected final equity ≈ 500_000 + 53_300 − 207 ≈ 553_100.
    expect(Number.isFinite(result.finalEquity)).toBe(true);
    expect(result.finalEquity).toBeGreaterThan(540_000);
    expect(result.finalEquity).toBeLessThan(570_000);

    // Sanity: every multi-leg basket should have exactly 2 legs (CE + PE).
    const byMlId = new Map<string, number>();
    for (const f of mlFills) {
      byMlId.set(f.multiLegOrderId!, (byMlId.get(f.multiLegOrderId!) ?? 0) + 1);
    }
    // 4 entry baskets + 4 exit baskets = 8 baskets, each with 2 fills.
    expect(byMlId.size).toBe(8);
    for (const count of byMlId.values()) {
      expect(count).toBe(2);
    }

    // Sanity: 8 SELL fills (entries) and 8 BUY fills (exits).
    const sells = result.fills.filter((f) => f.side === 'sell');
    const buys = result.fills.filter((f) => f.side === 'buy');
    expect(sells.length).toBe(8);
    expect(buys.length).toBe(8);
  });

  it('renders the per-expiry options section in the HTML report', () => {
    const result = runScenario();
    const html = renderOptionsSection(result.fills);
    expect(html).toContain('Per-expiry options breakdown');
    expect(html).toContain('Charge drag');
    // Net P&L should appear in the table footer (Total row).
    expect(html).toMatch(/<tfoot>/);
    // No NaN should leak into the table cells.
    expect(html).not.toContain('NaN');
    // Each of the 4 weekly expiries must produce a distinct row — the old
    // month-only regex (`\d{2}[A-Z]{3}`) collapsed them into a single row.
    for (const ymd of EXPIRIES) {
      expect(html).toContain(ymd);
    }
  });

  it('runs deterministically: two runs produce identical final equity', () => {
    const r1 = runScenario();
    const r2 = runScenario();
    expect(r1.finalEquity).toBe(r2.finalEquity);
    expect(r1.fills.length).toBe(r2.fills.length);
  });
});
