import { OrderSide, OrderStatus, OrderType, type Candle, type Fill, type Order } from '../types';
import type { BrokerageFn } from './brokerage/zerodha-intraday';

export interface BrokerSimOpts {
  slippageBps: number;
  brokerage: BrokerageFn;
}

export interface ProcessResult {
  order: Order;
  fill: Fill | null;
}

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
}
