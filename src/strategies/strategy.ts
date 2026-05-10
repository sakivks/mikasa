import type { Logger } from '../util/logger';
import type { Candle, Fill, OrderId, OrderIntent, Position } from '../types';
import type { IndicatorRegistry } from '../indicators/registry';
import type { OptionPosition, MultiLegOrder } from '../types/options';

export interface StrategyContext {
  cash: number;
  position(symbol: string): Position | null;
  submitOrder(intent: OrderIntent): OrderId;
  cancelOrder(id: OrderId): void;
  indicator: IndicatorRegistry;
  params: Record<string, unknown>;
  logger: Logger;
  optionPosition(symbol: string): OptionPosition | null;
  submitMultiLeg(order: Omit<MultiLegOrder, 'id' | 'ts'>): string;
  lastClose(symbol: string): number | undefined;
}

export abstract class Strategy {
  abstract init(ctx: StrategyContext): void;
  abstract onBar(bar: Candle, ctx: StrategyContext): void;
  onOrderFill?(fill: Fill, ctx: StrategyContext): void;
  onOrderRejected?(reason: string, intent: OrderIntent, ctx: StrategyContext): void;
}

export type StrategyConstructor = new () => Strategy;
