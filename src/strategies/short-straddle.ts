import { Strategy, type StrategyContext } from './strategy';
import { OrderSide, type Candle } from '../types';
import type { OptionContract } from '../types/options';
import { istDateKey, istHHMM } from '../util/time';

export interface ShortStraddleParams {
  entryTime: string;          // 'HH:MM' IST
  exitTime: string;           // 'HH:MM' IST
  slPctOnPremium: number;
  targetPctOnPremium?: number;
  lots: number;
  underlying: 'NIFTY' | 'BANKNIFTY';
  spotSymbol: string;         // e.g. 'NIFTY 50'
  /** Pre-resolved by run-config loader: ISO date 'YYYY-MM-DD' → ATM CE+PE for that expiry day */
  atmContracts: Record<string, { ce: OptionContract; pe: OptionContract }>;
}

interface State {
  active: boolean;
  expiryKey?: string;
  entryPremium?: number;
}

export class ShortStraddle extends Strategy {
  private p!: ShortStraddleParams;
  private state: State = { active: false };

  init(ctx: StrategyContext): void {
    this.p = ctx.params as unknown as ShortStraddleParams;
  }

  onBar(bar: Candle, ctx: StrategyContext): void {
    if (bar.symbol !== this.p.spotSymbol) return;        // trigger only on spot bar

    const dateKey = istDateKey(bar.ts);
    const time = istHHMM(bar.ts);
    const today = this.p.atmContracts[dateKey];
    if (!today) return;                                  // not an expiry day

    if (!this.state.active && time === this.p.entryTime) {
      ctx.submitMultiLeg({
        legs: [
          { contract: today.ce, side: OrderSide.SELL, qty: this.p.lots },
          { contract: today.pe, side: OrderSide.SELL, qty: this.p.lots },
        ],
        reason: 'entry',
      });
      const ceClose = ctx.lastClose(today.ce.symbol);
      const peClose = ctx.lastClose(today.pe.symbol);
      this.state.active = true;
      this.state.expiryKey = dateKey;
      if (ceClose !== undefined && peClose !== undefined) {
        this.state.entryPremium = ceClose + peClose;
      }
      return;
    }

    if (this.state.active && this.state.expiryKey === dateKey) {
      const ceClose = ctx.lastClose(today.ce.symbol);
      const peClose = ctx.lastClose(today.pe.symbol);
      if (ceClose === undefined || peClose === undefined) return;
      const current = ceClose + peClose;
      const ep = this.state.entryPremium ?? current;

      const slHit = current >= ep * (1 + this.p.slPctOnPremium / 100);
      const targetHit = this.p.targetPctOnPremium !== undefined
        && current <= ep * (1 - this.p.targetPctOnPremium / 100);
      const eod = time >= this.p.exitTime;

      if (slHit || targetHit || eod) {
        ctx.submitMultiLeg({
          legs: [
            { contract: today.ce, side: OrderSide.BUY, qty: this.p.lots },
            { contract: today.pe, side: OrderSide.BUY, qty: this.p.lots },
          ],
          reason: slHit ? 'sl' : targetHit ? 'target' : 'eod',
        });
        this.state.active = false;
        delete this.state.entryPremium;
        delete this.state.expiryKey;
      }
    }
  }
}
