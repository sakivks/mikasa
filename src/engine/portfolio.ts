import { OrderSide, type EquitySnapshot, type Fill, type Position } from '../types';
import type { Leg, OptionPosition } from '../types/options';
import { estimateMargin } from './brokerage/span-margin';

export class Portfolio {
  private readonly _initialCapital: number;
  private _cash: number;
  private _realized = 0;
  private readonly _positions = new Map<string, Position>();
  private readonly _options = new Map<string, OptionPosition>();
  private readonly _equity: EquitySnapshot[] = [];

  constructor(initialCapital: number) {
    if (initialCapital <= 0) throw new Error('initialCapital must be > 0');
    this._initialCapital = initialCapital;
    this._cash = initialCapital;
  }

  get initialCapital(): number {
    return this._initialCapital;
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

  optionPosition(symbol: string): OptionPosition | null {
    return this._options.get(symbol) ?? null;
  }

  optionPositions(): OptionPosition[] {
    return Array.from(this._options.values()).filter((p) => p.netQty !== 0);
  }

  marginRequired(): number {
    return estimateMargin(this.optionPositions());
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

  /**
   * Apply an option fill to the portfolio.
   *
   * Convention: `fill.qty` is in shares (lots × lotSize); option positions are
   * tracked in signed lots. Cash impact is `-(qty × price)` on buy and
   * `+(qty × price)` on sell, with `fees.total` always subtracted.
   */
  applyOptionFill(fill: Fill, leg: Leg): void {
    const lotSize = leg.contract.lotSize;
    const lots = fill.qty / lotSize;
    const signedDelta = leg.side === OrderSide.BUY ? +lots : -lots;
    const cashDelta = leg.side === OrderSide.BUY ? -(fill.qty * fill.price) : +(fill.qty * fill.price);
    const fees = fill.fees.total;

    this._cash += cashDelta - fees;

    const existing = this._options.get(leg.contract.symbol);
    if (!existing) {
      this._options.set(leg.contract.symbol, {
        contract: leg.contract,
        netQty: signedDelta,
        avgPrice: fill.price,
        realizedPnl: 0,
      });
      return;
    }

    if (existing.netQty === 0) {
      // Re-opening from a closed position
      existing.contract = leg.contract;
      existing.netQty = signedDelta;
      existing.avgPrice = fill.price;
      return;
    }

    const sameDir = Math.sign(existing.netQty) === Math.sign(signedDelta);
    if (sameDir) {
      // Adding to same-direction position — re-weight avg price by abs qty
      const totalAbs = Math.abs(existing.netQty) + Math.abs(signedDelta);
      existing.avgPrice =
        (existing.avgPrice * Math.abs(existing.netQty) + fill.price * Math.abs(signedDelta)) / totalAbs;
      existing.netQty += signedDelta;
      return;
    }

    // Opposite direction: realize P&L on the closing portion
    const closingLots = Math.min(Math.abs(existing.netQty), Math.abs(signedDelta));
    const closingShares = closingLots * lotSize;
    // Short closed by buy: profit = (entry - exit) × shares
    // Long closed by sell:  profit = (exit - entry) × shares
    const pnl =
      existing.netQty < 0
        ? (existing.avgPrice - fill.price) * closingShares
        : (fill.price - existing.avgPrice) * closingShares;
    existing.realizedPnl += pnl;
    this._realized += pnl;

    if (Math.abs(signedDelta) <= Math.abs(existing.netQty)) {
      // Closing only — residual stays in the same direction at original avg
      existing.netQty += signedDelta;
    } else {
      // Full reversal — residual flips into the new direction at fill.price
      const residualLots = Math.abs(signedDelta) - closingLots;
      existing.netQty = leg.side === OrderSide.BUY ? +residualLots : -residualLots;
      existing.avgPrice = fill.price;
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
    let optionMarketValue = 0;
    let optionUnrealized = 0;
    for (const op of this._options.values()) {
      if (op.netQty === 0) continue;
      const px = prices.get(op.contract.symbol);
      if (px === undefined) continue;
      // Signed share quantity: negative for shorts, positive for longs.
      // For shorts, cash already contains the entry premium credit, so equity
      // reconciles via a *negative* market-value contribution (liability to close).
      const signedShares = op.netQty * op.contract.lotSize;
      optionMarketValue += signedShares * px;
      // Short profits when premium drops; long profits when premium rises.
      const direction = op.netQty < 0 ? op.avgPrice - px : px - op.avgPrice;
      optionUnrealized += direction * Math.abs(signedShares);
    }
    unrealized += optionUnrealized;
    const snap: EquitySnapshot = {
      ts,
      cash: this._cash,
      unrealized,
      realized: this._realized,
      equity: this._cash + positionsMarketValue + optionMarketValue,
    };
    this._equity.push(snap);
    return snap;
  }
}
