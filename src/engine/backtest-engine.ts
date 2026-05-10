import type { Logger } from '../util/logger';
import type { Candle, EquitySnapshot, Fees, Fill, OrderId, OrderIntent, Position } from '../types';
import { OrderStatus } from '../types';
import type { IndicatorRegistry } from '../indicators/registry';
import type { Strategy, StrategyContext } from '../strategies/strategy';
import type { Portfolio } from './portfolio';
import type { BrokerSim } from './broker-sim';
import type { OrderRouter } from './order-router';

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

export interface BacktestResult {
  fills: Fill[];
  equityCurve: EquitySnapshot[];
  finalEquity: number;
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
    } as StrategyContext;

    strategy.init(ctx);

    // Pending orders carry across bars; queued() reads-write; engine processes against next bar.
    let pending: ReturnType<OrderRouter['drain']> = [];
    // Last known close per symbol — used to mark all open positions (not just current bar's symbol).
    const lastCloses = new Map<string, number>();

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i]!;

      // Process pending orders against THIS bar
      const stillPending: typeof pending = [];
      for (const order of pending) {
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

      const isWarmup = i < warmupBars;
      if (!isWarmup) {
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
    return {
      fills,
      equityCurve: equity,
      finalEquity: equity.length > 0 ? equity[equity.length - 1]!.equity : portfolio.cash,
    };
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
