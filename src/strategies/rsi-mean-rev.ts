import { OrderSide, OrderType, type Candle } from '../types';
import { RSI } from '../indicators/rsi';
import { Strategy, type StrategyContext } from './strategy';

/**
 * RSI mean-reversion (long-only).
 *
 * Computes RSI(`period`, default 14) per symbol. Buys when RSI dips below
 * `oversoldLevel` (default 30) while flat, exits when RSI rises back above
 * `exitLevel` (default 50) or a fixed-bps stop is hit. The OrderRouter
 * handles the 15:15 IST squareoff.
 */
export class RsiMeanRev extends Strategy {
  private symbols: string[] = [];
  private period = 14;
  private oversoldLevel = 30;
  private exitLevel = 50;
  private stopBps = 100;

  init(ctx: StrategyContext): void {
    this.symbols = (ctx.params.symbols as string[] | undefined) ?? [];
    this.period = (ctx.params.period as number | undefined) ?? this.period;
    this.oversoldLevel = (ctx.params.oversoldLevel as number | undefined) ?? this.oversoldLevel;
    this.exitLevel = (ctx.params.exitLevel as number | undefined) ?? this.exitLevel;
    this.stopBps = (ctx.params.stopBps as number | undefined) ?? this.stopBps;
    if (this.oversoldLevel >= this.exitLevel) {
      throw new Error(`oversoldLevel (${this.oversoldLevel}) must be < exitLevel (${this.exitLevel})`);
    }
    if (this.stopBps <= 0) throw new Error(`stopBps must be > 0`);
    for (const s of this.symbols) {
      ctx.indicator.register(s, 'rsi', new RSI(this.period));
    }
  }

  onBar(bar: Candle, ctx: StrategyContext): void {
    const raw = ctx.indicator.get(bar.symbol, 'rsi')?.value;
    const rsi = typeof raw === 'number' ? raw : undefined;
    if (rsi === undefined) return;

    const pos = ctx.position(bar.symbol);
    if (!pos || pos.qty === 0) {
      if (rsi < this.oversoldLevel) {
        const qty = Math.floor((ctx.cash * 0.5) / bar.close);
        if (qty > 0) {
          ctx.submitOrder({
            symbol: bar.symbol,
            side: OrderSide.BUY,
            qty,
            type: OrderType.MARKET,
            tag: 'rsi_oversold',
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
          tag: 'rsi_stop',
        });
      } else if (rsi > this.exitLevel) {
        ctx.submitOrder({
          symbol: bar.symbol,
          side: OrderSide.SELL,
          qty: pos.qty,
          type: OrderType.MARKET,
          tag: 'rsi_exit',
        });
      }
    }
  }
}
