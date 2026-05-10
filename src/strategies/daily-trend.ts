import { OrderSide, OrderType, type Candle } from '../types';
import { SMA } from '../indicators/sma';
import { Strategy, type StrategyContext } from './strategy';

interface State {
  prevFast: number | undefined;
  prevSlow: number | undefined;
  lastClose: number | undefined;
}

/**
 * Daily trend-following SMA crossover for a multi-symbol basket.
 *
 *  - Long-only.
 *  - Cross-up (fast above slow) → buy with `(equity * fraction) / price` qty,
 *    capped to available cash with a small headroom for fees/slippage.
 *  - Cross-down (fast below slow) while long → exit full position.
 *  - No intraday squareoff (positions held overnight). Configure
 *    `squareoff_time: null` in the run config so OrderRouter does not flatten.
 */
export class DailyTrend extends Strategy {
  private symbols: string[] = [];
  private fast = 20;
  private slow = 50;
  private fraction = 0.2;
  private readonly state = new Map<string, State>();

  init(ctx: StrategyContext): void {
    this.symbols = (ctx.params.symbols as string[] | undefined) ?? [];
    this.fast = (ctx.params.fast as number | undefined) ?? this.fast;
    this.slow = (ctx.params.slow as number | undefined) ?? this.slow;
    this.fraction = (ctx.params.fraction as number | undefined) ?? this.fraction;
    if (this.fast >= this.slow) throw new Error(`fast (${this.fast}) must be < slow (${this.slow})`);
    if (this.fraction <= 0 || this.fraction > 1) {
      throw new Error(`fraction must be in (0, 1], got ${this.fraction}`);
    }
    for (const s of this.symbols) {
      ctx.indicator.register(s, 'sma_fast', new SMA(this.fast));
      ctx.indicator.register(s, 'sma_slow', new SMA(this.slow));
      this.state.set(s, { prevFast: undefined, prevSlow: undefined, lastClose: undefined });
    }
  }

  onBar(bar: Candle, ctx: StrategyContext): void {
    const st = this.state.get(bar.symbol);
    if (!st) return;
    st.lastClose = bar.close;

    const fastV = ctx.indicator.get(bar.symbol, 'sma_fast')?.value;
    const slowV = ctx.indicator.get(bar.symbol, 'sma_slow')?.value;
    if (typeof fastV !== 'number' || typeof slowV !== 'number') return;

    const pf = st.prevFast;
    const ps = st.prevSlow;
    st.prevFast = fastV;
    st.prevSlow = slowV;
    if (pf === undefined || ps === undefined) return;

    const crossUp = pf <= ps && fastV > slowV;
    const crossDown = pf >= ps && fastV < slowV;
    const pos = ctx.position(bar.symbol);

    if (crossUp && (!pos || pos.qty <= 0)) {
      const equity = this.computeEquity(ctx);
      const targetNotional = equity * this.fraction;
      const cashCap = ctx.cash * 0.95; // small headroom for fees + slippage
      const notional = Math.min(targetNotional, cashCap);
      const qty = Math.floor(notional / bar.close);
      if (qty > 0) {
        ctx.submitOrder({
          symbol: bar.symbol,
          side: OrderSide.BUY,
          qty,
          type: OrderType.MARKET,
          tag: 'trend_up',
        });
      }
    } else if (crossDown && pos && pos.qty > 0) {
      ctx.submitOrder({
        symbol: bar.symbol,
        side: OrderSide.SELL,
        qty: pos.qty,
        type: OrderType.MARKET,
        tag: 'trend_down',
      });
    }
  }

  private computeEquity(ctx: StrategyContext): number {
    let equity = ctx.cash;
    for (const s of this.symbols) {
      const p = ctx.position(s);
      const close = this.state.get(s)?.lastClose;
      if (p && p.qty !== 0 && typeof close === 'number') {
        equity += p.qty * close;
      }
    }
    return equity;
  }
}
