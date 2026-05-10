import type { StrategyConstructor } from './strategy';
import { SmaCrossover } from './sma-crossover';
import { ORB } from './orb';
import { RsiMeanRev } from './rsi-mean-rev';
import { BollingerReversion } from './bollinger-reversion';

const REGISTRY: Record<string, StrategyConstructor> = {
  SmaCrossover,
  ORB,
  RsiMeanRev,
  BollingerReversion,
};

export function resolveStrategy(name: string): StrategyConstructor {
  const ctor = REGISTRY[name];
  if (!ctor) {
    throw new Error(`Unknown strategy: ${name}. Known: ${Object.keys(REGISTRY).join(', ')}`);
  }
  return ctor;
}

export function registerStrategy(name: string, ctor: StrategyConstructor): void {
  REGISTRY[name] = ctor;
}
