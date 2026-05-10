import type { Logger } from '../util/logger';
import type { Candle, Fill, OrderId, OrderIntent, Position } from '../types';
import type { IndicatorRegistry } from '../indicators/registry';
import type { OptionContract, OptionPosition, MultiLegOrder } from '../types/options';

export interface OptionSubscription {
  underlying: 'NIFTY' | 'BANKNIFTY';
  contracts: OptionContract[]; // pre-resolved by the run-config loader
}

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
  subscribeOptions(sub: OptionSubscription): void;
}

export abstract class Strategy {
  abstract init(ctx: StrategyContext): void;
  abstract onBar(bar: Candle, ctx: StrategyContext): void;
  onOrderFill?(fill: Fill, ctx: StrategyContext): void;
  onOrderRejected?(reason: string, intent: OrderIntent, ctx: StrategyContext): void;
}

export type StrategyConstructor = new () => Strategy;
