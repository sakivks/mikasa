export interface Indicator {
  update(price: number): number | undefined;
  readonly value: number | undefined;
}

export class IndicatorRegistry {
  private readonly bySymbol = new Map<string, Map<string, Indicator>>();

  register(symbol: string, key: string, ind: Indicator): void {
    let m = this.bySymbol.get(symbol);
    if (!m) {
      m = new Map();
      this.bySymbol.set(symbol, m);
    }
    if (m.has(key)) throw new Error(`Indicator already registered: ${symbol}/${key}`);
    m.set(key, ind);
  }

  get(symbol: string, key: string): Indicator | undefined {
    return this.bySymbol.get(symbol)?.get(key);
  }

  feedClose(symbol: string, close: number): void {
    const m = this.bySymbol.get(symbol);
    if (!m) return;
    for (const ind of m.values()) ind.update(close);
  }
}
