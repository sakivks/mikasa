import { OrderSide, type EquitySnapshot, type Fill, type Position } from '../types';

export class Portfolio {
  private _cash: number;
  private _realized = 0;
  private readonly _positions = new Map<string, Position>();
  private readonly _equity: EquitySnapshot[] = [];

  constructor(initialCapital: number) {
    if (initialCapital <= 0) throw new Error('initialCapital must be > 0');
    this._cash = initialCapital;
  }

  get cash(): number {
    return this._cash;
  }

  get realizedPnL(): number {
    return this._realized;
  }

  positions(): Position[] {
    return Array.from(this._positions.values());
  }

  position(symbol: string): Position | null {
    return this._positions.get(symbol) ?? null;
  }

  // Stub: real implementation lands in Task 9 (options portfolio extension).
  optionPosition(_symbol: string): import('../types/options').OptionPosition | null {
    return null;
  }

  equityCurve(): EquitySnapshot[] {
    return this._equity;
  }

  applyFill(fill: Fill): void {
    const notional = fill.qty * fill.price;
    const fees = fill.fees.total;
    const pos = this._positions.get(fill.symbol);
    if (fill.side === OrderSide.BUY) {
      if (this._cash < notional + fees) {
        throw new Error(`insufficient cash to buy ${fill.qty} of ${fill.symbol} at ${fill.price} (have ${this._cash}, need ${notional + fees})`);
      }
      this._cash -= notional + fees;
      if (!pos) {
        this._positions.set(fill.symbol, { symbol: fill.symbol, qty: fill.qty, avgPrice: fill.price });
      } else {
        const newQty = pos.qty + fill.qty;
        const newAvg = (pos.qty * pos.avgPrice + fill.qty * fill.price) / newQty;
        pos.qty = newQty;
        pos.avgPrice = newAvg;
      }
    } else {
      // SELL
      if (!pos || pos.qty < fill.qty) {
        throw new Error(`insufficient position to sell ${fill.qty} of ${fill.symbol} (have ${pos?.qty ?? 0})`);
      }
      this._cash += notional - fees;
      const realized = (fill.price - pos.avgPrice) * fill.qty - fees;
      this._realized += realized;
      pos.qty -= fill.qty;
      if (pos.qty === 0) this._positions.delete(fill.symbol);
    }
  }

  markToMarket(prices: Map<string, number>, ts: Date): EquitySnapshot {
    let unrealized = 0;
    let positionsMarketValue = 0;
    for (const p of this._positions.values()) {
      const px = prices.get(p.symbol);
      if (px === undefined) continue;
      unrealized += (px - p.avgPrice) * p.qty;
      positionsMarketValue += px * p.qty;
    }
    const snap: EquitySnapshot = {
      ts,
      cash: this._cash,
      unrealized,
      realized: this._realized,
      equity: this._cash + positionsMarketValue,
    };
    this._equity.push(snap);
    return snap;
  }
}
