import type { StrategyConstructor } from './strategy';
import { SmaCrossover } from './sma-crossover';

const REGISTRY: Record<string, StrategyConstructor> = {
  SmaCrossover,
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
