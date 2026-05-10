import type { OptionPosition } from '../../types/options';

const NAKED_RATE: Record<'NIFTY' | 'BANKNIFTY', number> = { NIFTY: 0.12, BANKNIFTY: 0.10 };

interface Group {
  underlying: 'NIFTY' | 'BANKNIFTY';
  expiry: number;     // ms
  optionType: 'CE' | 'PE';
  legs: OptionPosition[];
}

function groupKey(p: OptionPosition): string {
  return `${p.contract.underlying}|${p.contract.expiry.getTime()}|${p.contract.optionType}`;
}

export function estimateMargin(positions: OptionPosition[]): number {
  if (positions.length === 0) return 0;

  const groups = new Map<string, Group>();
  for (const p of positions) {
    if (p.netQty === 0) continue;
    const k = groupKey(p);
    if (!groups.has(k)) {
      groups.set(k, { underlying: p.contract.underlying, expiry: p.contract.expiry.getTime(), optionType: p.contract.optionType, legs: [] });
    }
    groups.get(k)!.legs.push(p);
  }

  let totalNaked = 0;
  let callSpreadLoss = 0;
  let putSpreadLoss = 0;

  for (const g of groups.values()) {
    const shorts = g.legs.filter((l) => l.netQty < 0);
    const longs = g.legs.filter((l) => l.netQty > 0);

    if (shorts.length === 1 && longs.length === 1) {
      // Defined-risk vertical spread
      const short = shorts[0]!;
      const long = longs[0]!;
      const lotSize = short.contract.lotSize;
      const wing = Math.abs(short.contract.strike - long.contract.strike);
      const credit = short.avgPrice - long.avgPrice;
      const maxLoss = Math.max(0, wing - credit);
      const lots = Math.min(Math.abs(short.netQty), Math.abs(long.netQty));
      if (g.optionType === 'CE') callSpreadLoss += maxLoss * lotSize * lots;
      else putSpreadLoss += maxLoss * lotSize * lots;
    } else {
      // Naked: charge per leg as % of notional × lotSize × |qty|
      for (const leg of shorts) {
        const rate = NAKED_RATE[leg.contract.underlying];
        totalNaked += rate * leg.contract.strike * leg.contract.lotSize * Math.abs(leg.netQty);
      }
    }
  }

  // Iron condor consolidation: when both call-spread and put-spread exist, charge max only
  const condorMargin = callSpreadLoss > 0 && putSpreadLoss > 0
    ? Math.max(callSpreadLoss, putSpreadLoss)
    : callSpreadLoss + putSpreadLoss;

  return totalNaked + condorMargin;
}
