import { OrderSide, OrderType, type Candle } from '../types';
import { Strategy, type StrategyContext } from './strategy';
import { toIST } from '../util/time';

interface DayState {
  date: string;
  high: number;
  low: number;
  barCount: number;
  established: boolean;
}

/**
 * Opening Range Breakout (intraday, long-only).
 *
 * Each new IST trading day, accumulate the high/low of the first
 * `openingMinutes` (default 30) of bars after market open. Once the
 * opening range is established, buy on a bar close above the opening
 * high (when flat). Exit on a fixed-bps stop below the entry price.
 * The OrderRouter handles the 15:15 squareoff.
 */
export class ORB extends Strategy {
  private symbols: string[] = [];
  private openingMinutes = 30;
  private intervalMin = 5;
  private stopBps = 50;
  private readonly state = new Map<string, DayState>();

  init(ctx: StrategyContext): void {
    this.symbols = (ctx.params.symbols as string[] | undefined) ?? [];
    this.openingMinutes = (ctx.params.openingMinutes as number | undefined) ?? this.openingMinutes;
    this.intervalMin = (ctx.params.intervalMin as number | undefined) ?? this.intervalMin;
    this.stopBps = (ctx.params.stopBps as number | undefined) ?? this.stopBps;
    if (this.openingMinutes <= 0) throw new Error(`openingMinutes must be > 0`);
    if (this.intervalMin <= 0) throw new Error(`intervalMin must be > 0`);
    if (this.stopBps <= 0) throw new Error(`stopBps must be > 0`);
  }

  onBar(bar: Candle, ctx: StrategyContext): void {
    const day = toIST(bar.ts, 'yyyy-MM-dd');
    let st = this.state.get(bar.symbol);
    if (!st || st.date !== day) {
      st = { date: day, high: bar.high, low: bar.low, barCount: 1, established: false };
      this.state.set(bar.symbol, st);
      // Single-bar opening range edge case: still mark established when
      // openingMinutes <= intervalMin so we can trade the first day.
      const barsForOpening = Math.max(1, Math.ceil(this.openingMinutes / this.intervalMin));
      if (st.barCount >= barsForOpening) st.established = true;
      return;
    }
    const barsForOpening = Math.max(1, Math.ceil(this.openingMinutes / this.intervalMin));
    if (!st.established) {
      st.high = Math.max(st.high, bar.high);
      st.low = Math.min(st.low, bar.low);
      st.barCount += 1;
      if (st.barCount >= barsForOpening) st.established = true;
      return;
    }
    const pos = ctx.position(bar.symbol);
    if (!pos || pos.qty === 0) {
      if (bar.close > st.high) {
        const qty = Math.floor((ctx.cash * 0.5) / bar.close);
        if (qty > 0) {
          ctx.submitOrder({
            symbol: bar.symbol,
            side: OrderSide.BUY,
            qty,
            type: OrderType.MARKET,
            tag: 'orb_long',
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
          tag: 'orb_stop',
        });
      }
    }
  }
}
