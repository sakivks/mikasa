import { OrderSide, OrderStatus, OrderType, type Candle, type Fill, type Order } from '../types';
import type { MultiLegOrder } from '../types/options';
import type { BrokerageFn } from './brokerage/zerodha-intraday';
import { calcOptionLegCharges } from './brokerage/options-charges';

export interface BrokerSimOpts {
  slippageBps: number;
  brokerage: BrokerageFn;
}

export interface ProcessResult {
  order: Order;
  fill: Fill | null;
}

export type MultiLegRejectionReason = 'no-liquidity';

export interface MultiLegResult {
  fills: Fill[];
  rejection?: { reason: MultiLegRejectionReason };
}

// 1 tick = ₹0.05 on NSE F&O.
const OPTION_TICK = 0.05;

export class BrokerSim {
  constructor(private readonly opts: BrokerSimOpts) {}

  /** Process a single order against the next bar. Mutates and returns the order. */
  processOrder(order: Order, nextBar: Candle): ProcessResult {
    const intent = order.intent;
    const price = this.computeFillPrice(intent.side, intent.type, intent.limitPrice, intent.stopPrice, nextBar);
    if (price === null) {
      // Limit/stop didn't trigger — keep pending
      if (order.status === OrderStatus.SUBMITTED) order.status = OrderStatus.PENDING;
      return { order, fill: null };
    }
    const adjusted = this.applySlippage(intent.side, price);
    const fees = this.opts.brokerage({ side: intent.side, qty: intent.qty, price: adjusted });
    const fill: Fill = {
      orderId: order.id,
      symbol: intent.symbol,
      side: intent.side,
      qty: intent.qty,
      price: adjusted,
      ts: nextBar.ts,
      fees,
    };
    order.status = OrderStatus.FILLED;
    return { order, fill };
  }

  private computeFillPrice(
    side: OrderSide,
    type: OrderType,
    limit: number | undefined,
    stop: number | undefined,
    bar: Candle,
  ): number | null {
    if (type === OrderType.MARKET) return bar.open;
    if (type === OrderType.LIMIT) {
      if (limit === undefined) throw new Error('limit order requires limitPrice');
      if (side === OrderSide.BUY) {
        return bar.low <= limit ? Math.min(limit, bar.open) : null;
      }
      return bar.high >= limit ? Math.max(limit, bar.open) : null;
    }
    if (type === OrderType.STOP) {
      if (stop === undefined) throw new Error('stop order requires stopPrice');
      if (side === OrderSide.BUY) {
        return bar.high >= stop ? Math.max(stop, bar.open) : null;
      }
      return bar.low <= stop ? Math.min(stop, bar.open) : null;
    }
    throw new Error(`unknown order type: ${type as string}`);
  }

  private applySlippage(side: OrderSide, price: number): number {
    const bps = this.opts.slippageBps;
    return side === OrderSide.BUY ? price * (1 + bps / 10_000) : price * (1 - bps / 10_000);
  }

  /**
   * Slippage for option premiums (absolute ₹ amount, not %).
   * - slippageBps === 0 → 0 slippage (preserves zero-friction tests).
   * - slippageBps  >  0 → max(1 tick, price × bps/10_000): floors tiny derived
   *   values at one NSE F&O tick (₹0.05) so the cost is never sub-tick.
   */
  private optionSlippage(price: number): number {
    if (this.opts.slippageBps === 0) return 0;
    return Math.max(OPTION_TICK, price * (this.opts.slippageBps / 10_000));
  }

  /**
   * Process a multi-leg options order atomically against next bars (one per leg symbol).
   * Either every leg fills at its next bar's open ± 1 tick, or none do (no partial fills).
   * Charges are computed per leg via `calcOptionLegCharges` (Zerodha schedule).
   */
  processMultiLeg(order: MultiLegOrder, nextBars: Map<string, Candle>): MultiLegResult {
    // Atomicity gate: if any leg lacks a next bar, reject the whole basket.
    for (const leg of order.legs) {
      if (!nextBars.has(leg.contract.symbol)) {
        return { fills: [], rejection: { reason: 'no-liquidity' } };
      }
    }

    const fills: Fill[] = [];
    for (let legIndex = 0; legIndex < order.legs.length; legIndex++) {
      const leg = order.legs[legIndex]!;
      const bar = nextBars.get(leg.contract.symbol)!;
      const tick = this.optionSlippage(bar.open);
      const slippage = leg.side === OrderSide.BUY ? +tick : -tick;
      const price = bar.open + slippage;
      const fees = calcOptionLegCharges({
        contract: leg.contract,
        side: leg.side,
        qty: leg.qty, // lots — calcOptionLegCharges multiplies by lotSize internally
        price,
      });
      fills.push({
        orderId: `${order.id}-${legIndex}`,
        multiLegOrderId: order.id,
        symbol: leg.contract.symbol,
        side: leg.side,
        qty: leg.qty * leg.contract.lotSize, // shares (matches existing Fill semantics)
        price,
        ts: bar.ts,
        fees,
      });
    }
    return { fills };
  }
}
