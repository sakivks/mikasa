import { Strategy, type StrategyContext } from './strategy';
import { OrderSide, type Candle } from '../types';
import type { OptionContract } from '../types/options';
import { istHHMM, istWeekday, istWeekKey } from '../util/time';

export interface IronCondorParams {
  entryDay: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday';
  entryTime: string;
  exitDay: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday';
  exitTime: string;
  shortStrikeOffset: number;     // short call = ATM + offset, short put = ATM - offset
  wingWidth: number;             // long call = short call + wing, long put = short put - wing
  slPctOnCredit: number;
  lots: number;
  underlying: 'NIFTY' | 'BANKNIFTY';
  spotSymbol: string;
  /** weekKey 'YYYY-Www' → 4 contracts for that week's expiry */
  weeklyContracts: Record<string, {
    shortCall: OptionContract;
    longCall: OptionContract;
    shortPut: OptionContract;
    longPut: OptionContract;
  }>;
}

interface CondorState {
  active: boolean;
  weekKey?: string;
  creditReceived?: number;       // rupees, lot-adjusted (i.e., × lotSize × lots)
}

const DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function istParts(ts: Date): { day: number; hhmm: string; weekKey: string } {
  return { day: istWeekday(ts), hhmm: istHHMM(ts), weekKey: istWeekKey(ts) };
}

export { DAY_INDEX };

export class IronCondor extends Strategy {
  private p!: IronCondorParams;
  private state: CondorState = { active: false };

  init(ctx: StrategyContext): void {
    this.p = ctx.params as unknown as IronCondorParams;
  }

  onBar(bar: Candle, ctx: StrategyContext): void {
    if (bar.symbol !== this.p.spotSymbol) return;

    const { day, hhmm, weekKey } = istParts(bar.ts);
    const week = this.p.weeklyContracts[weekKey];
    if (!week) return;

    if (!this.state.active && day === DAY_INDEX[this.p.entryDay] && hhmm === this.p.entryTime) {
      ctx.submitMultiLeg({
        legs: [
          { contract: week.shortCall, side: OrderSide.SELL, qty: this.p.lots },
          { contract: week.longCall,  side: OrderSide.BUY,  qty: this.p.lots },
          { contract: week.shortPut,  side: OrderSide.SELL, qty: this.p.lots },
          { contract: week.longPut,   side: OrderSide.BUY,  qty: this.p.lots },
        ],
        reason: 'entry',
      });
      const sc = ctx.lastClose(week.shortCall.symbol);
      const lc = ctx.lastClose(week.longCall.symbol);
      const sp = ctx.lastClose(week.shortPut.symbol);
      const lp = ctx.lastClose(week.longPut.symbol);
      this.state.active = true;
      this.state.weekKey = weekKey;
      if ([sc, lc, sp, lp].every((v) => v !== undefined)) {
        this.state.creditReceived = (sc! + sp! - lc! - lp!) * week.shortCall.lotSize * this.p.lots;
      }
      return;
    }

    if (this.state.active && this.state.weekKey === weekKey) {
      const sc = ctx.lastClose(week.shortCall.symbol);
      const lc = ctx.lastClose(week.longCall.symbol);
      const sp = ctx.lastClose(week.shortPut.symbol);
      const lp = ctx.lastClose(week.longPut.symbol);
      let slHit = false;
      if ([sc, lc, sp, lp].every((v) => v !== undefined) && this.state.creditReceived !== undefined) {
        const buyBackCost = (sc! + sp! - lc! - lp!) * week.shortCall.lotSize * this.p.lots;
        const mtmPnl = this.state.creditReceived - buyBackCost;
        slHit = mtmPnl <= -this.state.creditReceived * (this.p.slPctOnCredit / 100);
      }
      const exit = day === DAY_INDEX[this.p.exitDay] && hhmm >= this.p.exitTime;
      if (slHit || exit) {
        ctx.submitMultiLeg({
          legs: [
            { contract: week.shortCall, side: OrderSide.BUY,  qty: this.p.lots },
            { contract: week.longCall,  side: OrderSide.SELL, qty: this.p.lots },
            { contract: week.shortPut,  side: OrderSide.BUY,  qty: this.p.lots },
            { contract: week.longPut,   side: OrderSide.SELL, qty: this.p.lots },
          ],
          reason: slHit ? 'sl' : 'exit',
        });
        this.state.active = false;
        delete this.state.creditReceived;
        delete this.state.weekKey;
      }
    }
  }
}
