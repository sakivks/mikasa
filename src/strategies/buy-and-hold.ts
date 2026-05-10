import { OrderSide, OrderType, type Candle } from '../types';
import { Strategy, type StrategyContext } from './strategy';

/**
 * Equal-weight buy-and-hold across a symbol basket. Buys each symbol once on
 * its first onBar call (post-warmup) sized as `capital * fraction / price`,
 * then holds. Used as a basket B&H baseline.
 */
export class BuyAndHold extends Strategy {
  private fraction = 1 / 50;
  private initialCapital: number | undefined;
  private readonly bought = new Set<string>();
  private symbols: string[] = [];

  init(ctx: StrategyContext): void {
    this.symbols = (ctx.params.symbols as string[] | undefined) ?? [];
    const f = ctx.params.fraction as number | undefined;
    this.fraction = f ?? 1 / Math.max(1, this.symbols.length);
  }

  onBar(bar: Candle, ctx: StrategyContext): void {
    // Snapshot starting capital once. After this, cash drains as fills happen
    // but per-symbol target stays equal-weight against the original pot.
    if (this.initialCapital === undefined) this.initialCapital = ctx.cash;
    if (this.bought.has(bar.symbol)) return;
    const target = this.initialCapital * this.fraction;
    const cap = ctx.cash * 0.95;
    const notional = Math.min(target, cap);
    const qty = Math.floor(notional / bar.close);
    if (qty > 0) {
      ctx.submitOrder({
        symbol: bar.symbol,
        side: OrderSide.BUY,
        qty,
        type: OrderType.MARKET,
        tag: 'bh_init',
      });
      this.bought.add(bar.symbol);
    }
  }
}
