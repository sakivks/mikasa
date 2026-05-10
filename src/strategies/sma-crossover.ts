import { OrderSide, OrderType, type Candle } from '../types';
import { SMA } from '../indicators/sma';
import { Strategy, type StrategyContext } from './strategy';

interface State {
  prevFast: number | undefined;
  prevSlow: number | undefined;
}

export class SmaCrossover extends Strategy {
  private symbols: string[] = [];
  private fast = 9;
  private slow = 21;
  private readonly state = new Map<string, State>();

  init(ctx: StrategyContext): void {
    this.symbols = (ctx.params.symbols as string[] | undefined) ?? [];
    this.fast = (ctx.params.fast as number | undefined) ?? this.fast;
    this.slow = (ctx.params.slow as number | undefined) ?? this.slow;
    if (this.fast >= this.slow) throw new Error(`fast (${this.fast}) must be < slow (${this.slow})`);
    for (const s of this.symbols) {
      ctx.indicator.register(s, 'sma_fast', new SMA(this.fast));
      ctx.indicator.register(s, 'sma_slow', new SMA(this.slow));
      this.state.set(s, { prevFast: undefined, prevSlow: undefined });
    }
  }

  onBar(bar: Candle, ctx: StrategyContext): void {
    const fast = ctx.indicator.get(bar.symbol, 'sma_fast')?.value;
    const slow = ctx.indicator.get(bar.symbol, 'sma_slow')?.value;
    const st = this.state.get(bar.symbol);
    if (!st || fast === undefined || slow === undefined) return;
    const pf = st.prevFast;
    const ps = st.prevSlow;
    st.prevFast = fast;
    st.prevSlow = slow;
    if (pf === undefined || ps === undefined) return;

    const crossUp = pf <= ps && fast > slow;
    const crossDown = pf >= ps && fast < slow;
    const pos = ctx.position(bar.symbol);

    if (crossUp && (!pos || pos.qty <= 0)) {
      const qty = sizeByCash(ctx.cash, bar.close);
      if (qty > 0) {
        ctx.submitOrder({ symbol: bar.symbol, side: OrderSide.BUY, qty, type: OrderType.MARKET, tag: 'sma_cross_up' });
      }
    } else if (crossDown && pos && pos.qty > 0) {
      ctx.submitOrder({ symbol: bar.symbol, side: OrderSide.SELL, qty: pos.qty, type: OrderType.MARKET, tag: 'sma_cross_down' });
    }
  }
}

/** Naive sizing: spend up to half of available cash per signal. Replace later with risk-based sizing. */
function sizeByCash(cash: number, price: number): number {
  if (price <= 0) return 0;
  return Math.floor((cash * 0.5) / price);
}
