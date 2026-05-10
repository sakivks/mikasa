import type { Logger } from '../util/logger';
import type { Candle, Fill, OrderId, OrderIntent, Position } from '../types';
import type { IndicatorRegistry } from '../indicators/registry';

export interface StrategyContext {
  cash: number;
  position(symbol: string): Position | null;
  submitOrder(intent: OrderIntent): OrderId;
  cancelOrder(id: OrderId): void;
  indicator: IndicatorRegistry;
  params: Record<string, unknown>;
  logger: Logger;
}

export abstract class Strategy {
  abstract init(ctx: StrategyContext): void;
  abstract onBar(bar: Candle, ctx: StrategyContext): void;
  onOrderFill?(fill: Fill, ctx: StrategyContext): void;
  onOrderRejected?(reason: string, intent: OrderIntent, ctx: StrategyContext): void;
}

export type StrategyConstructor = new () => Strategy;
