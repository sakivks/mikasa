import type { OptionContract, Underlying } from '../types/options';
import type { InstrumentStore } from './instrument-store';

export function roundToStrike(spot: number, step: number): number {
  // Round to nearest multiple of `step`, but break ties toward the lower strike.
  const lower = Math.floor(spot / step) * step;
  const upper = lower + step;
  const diffLower = spot - lower;
  const diffUpper = upper - spot;
  if (diffLower < diffUpper) return lower;
  if (diffUpper < diffLower) return upper;
  return lower;   // exact tie
}

export async function resolveAtmChain(
  store: InstrumentStore,
  underlying: Underlying,
  expiry: Date,
  spot: number,
  n: number,
  step: number,
): Promise<OptionContract[]> {
  const atm = roundToStrike(spot, step);
  const out: OptionContract[] = [];
  for (let k = atm - n * step; k <= atm + n * step; k += step) {
    const ce = await store.findOption(underlying, expiry, k, 'CE');
    const pe = await store.findOption(underlying, expiry, k, 'PE');
    if (ce) out.push(ce);
    if (pe) out.push(pe);
  }
  return out;
}
