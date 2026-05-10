import { OrderSide, OrderType, type Candle } from '../types';
import { Bollinger } from '../indicators/bollinger';
import { Strategy, type StrategyContext } from './strategy';

/**
 * Bollinger band reversion (long-only).
 *
 * Computes Bollinger(`period`, `stddev`) per symbol — defaults 20 and 2.
 * Buys when bar close drops below the lower band while flat; exits when
 * close rises above the middle band or a fixed-bps stop is hit. The
 * OrderRouter handles the 15:15 IST squareoff.
 */
export class BollingerReversion extends Strategy {
  private symbols: string[] = [];
  private period = 20;
  private stddev = 2;
  private stopBps = 100;

  init(ctx: StrategyContext): void {
    this.symbols = (ctx.params.symbols as string[] | undefined) ?? [];
    this.period = (ctx.params.period as number | undefined) ?? this.period;
    this.stddev = (ctx.params.stddev as number | undefined) ?? this.stddev;
    this.stopBps = (ctx.params.stopBps as number | undefined) ?? this.stopBps;
    if (this.stopBps <= 0) throw new Error(`stopBps must be > 0`);
    for (const s of this.symbols) {
      ctx.indicator.register(s, 'bb', new Bollinger(this.period, this.stddev));
    }
  }

  onBar(bar: Candle, ctx: StrategyContext): void {
    const raw = ctx.indicator.get(bar.symbol, 'bb')?.value;
    if (!raw || typeof raw === 'number') return;
    const { middle, lower } = raw;
    const pos = ctx.position(bar.symbol);

    if (!pos || pos.qty === 0) {
      if (bar.close < lower) {
        const qty = Math.floor((ctx.cash * 0.5) / bar.close);
        if (qty > 0) {
          ctx.submitOrder({
            symbol: bar.symbol,
            side: OrderSide.BUY,
            qty,
            type: OrderType.MARKET,
            tag: 'bb_below_lower',
          });
        }
      }
    } else if (pos.qty > 0) {
      const stopPrice = pos.avgPrice * (1 - this.stopBps / 10_000);
      if (bar.low <= stopPrice) {
        ctx.submitOrder({
          symbol: bar.symbol,
          side: OrderSide.SELL,
          qty: pos.qty,
          type: OrderType.MARKET,
          tag: 'bb_stop',
        });
      } else if (bar.close > middle) {
        ctx.submitOrder({
          symbol: bar.symbol,
          side: OrderSide.SELL,
          qty: pos.qty,
          type: OrderType.MARKET,
          tag: 'bb_exit',
        });
      }
    }
  }
}
