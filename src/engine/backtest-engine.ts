import type { Logger } from '../util/logger';
import type { Candle, EquitySnapshot, Fees, Fill, OrderId, OrderIntent, Position } from '../types';
import { OrderSide, OrderStatus } from '../types';
import type { Leg, MultiLegOrder, OptionPosition } from '../types/options';
import type { IndicatorRegistry } from '../indicators/registry';
import type { Strategy, StrategyContext } from '../strategies/strategy';
import type { Portfolio } from './portfolio';
import type { BrokerSim } from './broker-sim';
import type { OrderRouter } from './order-router';
import { estimateMargin } from './brokerage/span-margin';

// Conservative one-tick buffer when projecting fill price for the margin gate.
// 1 NSE F&O tick = ₹0.05.
const PROJECTED_FILL_TICK = 0.05;

/**
 * Project the basket margin requirement *after* applying a candidate set of legs
 * on top of the current option positions. Used by the pre-trade margin gate to
 * decide whether a multi-leg order can be filled without exceeding available
 * cash. Mirrors the structure consumed by `estimateMargin` so spread vs naked
 * classification is preserved.
 */
function projectMargin(
  currentPositions: OptionPosition[],
  legs: Leg[],
  fillPrice: (leg: Leg) => number,
): number {
  const projected = new Map<string, OptionPosition>();
  for (const p of currentPositions) {
    projected.set(p.contract.symbol, { ...p });
  }
  for (const leg of legs) {
    const sign = leg.side === OrderSide.SELL ? -1 : +1;
    const lots = leg.qty * sign;
    const existing = projected.get(leg.contract.symbol);
    if (!existing) {
      projected.set(leg.contract.symbol, {
        contract: leg.contract,
        netQty: lots,
        avgPrice: fillPrice(leg),
        realizedPnl: 0,
      });
    } else {
      // avgPrice is only used by estimateMargin for spread credit; keep the
      // existing avgPrice as a rough approximation — this is a conservative
      // pre-trade check, not a precise mark.
      existing.netQty += lots;
    }
  }
  return estimateMargin(Array.from(projected.values()).filter((p) => p.netQty !== 0));
}

export interface BacktestEngineOpts {
  candles: Candle[]; // sorted ascending by ts; merge across symbols upstream
  strategy: Strategy;
  portfolio: Portfolio;
  broker: BrokerSim;
  router: OrderRouter;
  indicators: IndicatorRegistry;
  logger: Logger;
  warmupBars: number;
  params: Record<string, unknown>;
}

export interface MarginStats {
  peakMargin: number;
  avgMargin: number;
  minMargin: number;
  peakUtilizationPct: number;
  avgUtilizationPct: number;
}

export interface BacktestResult {
  fills: Fill[];
  equityCurve: EquitySnapshot[];
  finalEquity: number;
  /** True when equity went non-positive during the run and forced exits were issued. */
  bankruptcy?: boolean;
  /** Present when at least one bar had a positive margin requirement. */
  marginStats?: MarginStats;
}

function summarizeMargin(
  marginCurve: Array<{ ts: Date; margin: number }>,
  initialCapital: number,
): MarginStats | undefined {
  if (marginCurve.length === 0) return undefined;
  const values = marginCurve.map((p) => p.margin);
  const peak = Math.max(...values);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const min = Math.min(...values);
  return {
    peakMargin: peak,
    avgMargin: avg,
    minMargin: min,
    peakUtilizationPct: (peak / initialCapital) * 100,
    avgUtilizationPct: (avg / initialCapital) * 100,
  };
}

export function runBacktest(opts: BacktestEngineOpts): BacktestResult {
  return new BacktestEngine(opts).run();
}

export class BacktestEngine {
  constructor(private readonly opts: BacktestEngineOpts) {}

  run(): BacktestResult {
    const { candles, strategy, portfolio, broker, router, indicators, logger, warmupBars, params } = this.opts;
    this.assertMonotonic(candles);

    // Build context — note: spread of params is shallow-copied so strategy can read but engine controls cash etc.
    const fills: Fill[] = [];
    // Last known close per symbol — used to mark all open positions (not just current bar's symbol).
    const lastCloses = new Map<string, number>();
    const ctx: StrategyContext = {
      get cash(): number {
        return portfolio.cash;
      },
      position: (s: string): Position | null => portfolio.position(s),
      submitOrder: (intent: OrderIntent): OrderId => router.submit(intent),
      cancelOrder: (_id: OrderId): void => {
        // Not implemented in milestone 1
      },
      indicator: indicators,
      params,
      logger,
      optionPosition: (s) => portfolio.optionPosition(s),
      submitMultiLeg: (order) => router.submitMultiLeg(order),
      lastClose: (s) => lastCloses.get(s),
    } as StrategyContext;

    strategy.init(ctx);

    // Pending orders carry across bars; queued() reads-write; engine processes against next bar.
    let pending: ReturnType<OrderRouter['drain']> = [];
    // Pending multi-leg orders waiting for next bars on every leg's symbol.
    let pendingMl: MultiLegOrder[] = [];
    // Per-bar margin samples for utilization stats — we only record bars where any
    // option position has a positive margin requirement so idle stretches don't
    // dilute the average.
    const marginCurve: Array<{ ts: Date; margin: number }> = [];
    // Once true, the engine stops feeding new bars to strategy.onBar — only the
    // forced-exit reversal orders that were submitted at bankruptcy time will fill.
    let bankrupt = false;
    // Most recent bar seen per symbol — serves as "next bar" for orders submitted in
    // earlier iterations. Updated at the START of each iteration so an ML submitted at
    // bar t becomes eligible to fill at bar t+1 (or later, on a leg's own next bar).
    const nextBarByContract = new Map<string, Candle>();

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i]!;

      // Refresh "next bar" for this symbol BEFORE we attempt multi-leg fills, so a
      // pending ML can pick up the freshly-arrived bar as its next-bar-after-submission.
      nextBarByContract.set(bar.symbol, bar);

      // Try to fill pending multi-leg orders. An ML fills only when EVERY leg has a
      // next bar with ts > order.ts. Until then it stays pending. Atomicity is enforced
      // inside BrokerSim.processMultiLeg — we just gate on bar availability here.
      const stillPendingMl: MultiLegOrder[] = [];
      for (const ml of pendingMl) {
        const legBars = new Map<string, Candle>();
        let ready = true;
        for (const leg of ml.legs) {
          const candidate = nextBarByContract.get(leg.contract.symbol);
          if (!candidate || candidate.ts.getTime() <= ml.ts.getTime()) {
            ready = false;
            break;
          }
          legBars.set(leg.contract.symbol, candidate);
        }
        if (!ready) {
          stillPendingMl.push(ml);
          continue;
        }

        // Pre-trade margin check: project what total basket margin would be
        // *after* this fill applied to current positions. If it exceeds available
        // cash, drop the order with a structured warn log — do not retry, do not
        // partially fill. (estimateMargin classifies spreads vs naked correctly.)
        // Bypass for forced-exit (bankruptcy) reversals — those must fill so the
        // portfolio can flatten regardless of current cash state.
        if (ml.reason !== 'bankruptcy') {
          const fillPriceFor = (leg: Leg): number => {
            const candidate = legBars.get(leg.contract.symbol)!;
            const sign = leg.side === OrderSide.BUY ? +1 : -1;
            return candidate.open + sign * PROJECTED_FILL_TICK;
          };
          const projectedMargin = projectMargin(portfolio.optionPositions(), ml.legs, fillPriceFor);
          if (projectedMargin > portfolio.cash) {
            logger.warn(
              { mlId: ml.id, projectedMargin, cash: portfolio.cash, reason: 'insufficient_margin' },
              'multi-leg skipped: insufficient_margin',
            );
            continue;
          }
        }

        const res = broker.processMultiLeg(ml, legBars);
        if (res.rejection) {
          logger.warn({ mlId: ml.id, reason: res.rejection.reason }, 'multi-leg order rejected');
          continue;
        }
        for (let li = 0; li < res.fills.length; li++) {
          const fill = res.fills[li]!;
          const leg = ml.legs[li]!;
          try {
            portfolio.applyOptionFill(fill, leg);
            fills.push(fill);
            strategy.onOrderFill?.(fill, ctx);
          } catch (err) {
            logger.warn({ mlId: ml.id, err: (err as Error).message }, 'multi-leg fill apply failed');
          }
        }
      }
      pendingMl = stillPendingMl;

      // Process pending orders against THIS bar — but only for orders whose
      // symbol matches this bar's symbol. Multi-symbol backtests interleave
      // bars across instruments, so an order on stock A must wait for A's
      // next bar to fill, not fire against B's open price.
      const stillPending: typeof pending = [];
      for (const order of pending) {
        if (order.intent.symbol !== bar.symbol) {
          stillPending.push(order);
          continue;
        }
        const res = broker.processOrder(order, bar);
        if (res.fill) {
          try {
            portfolio.applyFill(res.fill);
            fills.push(res.fill);
            strategy.onOrderFill?.(res.fill, ctx);
          } catch (err) {
            order.status = OrderStatus.REJECTED;
            order.rejectionReason = (err as Error).message;
            logger.warn({ orderId: order.id, reason: order.rejectionReason }, 'order rejected at fill apply');
            strategy.onOrderRejected?.(order.rejectionReason, order.intent, ctx);
          }
        } else if (order.status === OrderStatus.PENDING) {
          stillPending.push(order);
        }
      }

      // Update indicators with this bar's close
      indicators.feedClose(bar.symbol, bar.close);

      // Track last-known close for ALL symbols so multi-symbol positions mark correctly.
      lastCloses.set(bar.symbol, bar.close);

      // Mark to market: pass the full last-close map (not just current bar's symbol),
      // otherwise other open positions would mark to 0 and corrupt the equity curve / MDD.
      portfolio.markToMarket(lastCloses, bar.ts);

      // Sample margin requirement after MTM. Skip zero-margin bars so the average
      // reflects utilization while positions are actually open.
      const marginNow = portfolio.marginRequired();
      if (marginNow > 0) {
        marginCurve.push({ ts: bar.ts, margin: marginNow });
      }

      // Bankruptcy detection: equity ≤ 0 means losses exceeded available capital.
      // Bundle reversals for every open option position into a single multi-leg
      // order so they fill atomically on the next bar. After this, the strategy
      // is suppressed so no new intents are generated, but in-flight reversals
      // continue to settle.
      if (!bankrupt) {
        const curve = portfolio.equityCurve();
        const last = curve[curve.length - 1];
        if (last && last.equity <= 0) {
          bankrupt = true;
          logger.error({ ts: bar.ts, equity: last.equity }, 'bankruptcy: forced exit');
          const openPositions = portfolio.optionPositions();
          if (openPositions.length > 0) {
            const reversalLegs: Leg[] = openPositions.map((op) => ({
              contract: op.contract,
              side: op.netQty > 0 ? OrderSide.SELL : OrderSide.BUY,
              qty: Math.abs(op.netQty),
            }));
            router.submitMultiLeg({ legs: reversalLegs, reason: 'bankruptcy' });
          }
        }
      }

      const isWarmup = i < warmupBars;
      if (!isWarmup && !bankrupt) {
        // EOD squareoff (queued like any strategy intent; fills on next bar)
        router.maybeSquareoff(bar.ts, portfolio.positions());

        // Strategy gets a turn
        try {
          strategy.onBar(bar, ctx);
        } catch (err) {
          logger.error({ err, bar }, 'strategy threw in onBar');
          throw err;
        }
      }

      // New orders submitted this bar enter pending queue, joined with carryovers
      pending = stillPending.concat(router.drain());

      // Newly submitted multi-leg orders inherit this bar's ts (so they fill on a
      // strictly later bar) and join the pending ML queue.
      const newMl = router.drainMultiLeg();
      for (const ml of newMl) {
        ml.ts = bar.ts;
        pendingMl.push(ml);
      }
    }

    // Final fallback: if positions remain open after last bar AND there are unfilled pending orders
    // (e.g. EOD squareoff order had no next bar to fill on), force-close at last bar's close.
    // We do NOT force-close when the strategy simply chose to hold — that would inject phantom fills.
    const last = candles[candles.length - 1];
    if (last && pending.length > 0 && portfolio.positions().length > 0) {
      logger.warn('force-closing open positions at final bar close');
      for (const p of portfolio.positions()) {
        const side = p.qty > 0 ? 'sell' : 'buy';
        const qty = Math.abs(p.qty);
        const fees: Fees = { brokerage: 0, stt: 0, exchange: 0, gst: 0, sebi: 0, stampDuty: 0, total: 0 };
        const fill: Fill = {
          orderId: 'force-close',
          symbol: p.symbol,
          side: side === 'sell' ? ('sell' as const) : ('buy' as const),
          qty,
          price: last.close,
          ts: last.ts,
          fees,
        };
        portfolio.applyFill(fill);
        fills.push(fill);
      }
    }

    const equity = portfolio.equityCurve();
    const result: BacktestResult = {
      fills,
      equityCurve: equity,
      finalEquity: equity.length > 0 ? equity[equity.length - 1]!.equity : portfolio.cash,
    };
    if (bankrupt) result.bankruptcy = true;
    const marginStats = summarizeMargin(marginCurve, portfolio.initialCapital);
    if (marginStats) result.marginStats = marginStats;
    return result;
  }

  private assertMonotonic(candles: Candle[]): void {
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1]!.ts.getTime();
      const cur = candles[i]!.ts.getTime();
      if (cur < prev) {
        throw new Error(
          `candles must be in monotonic order; index ${i} (${candles[i]!.ts.toISOString()}) precedes index ${i - 1} (${candles[i - 1]!.ts.toISOString()})`,
        );
      }
    }
  }
}
