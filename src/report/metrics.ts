import { OrderSide, type EquitySnapshot, type Fill, type Trade } from '../types';

export interface Metrics {
  initialCapital: number;
  finalEquity: number;
  totalReturn: number; // fraction
  maxDrawdownPct: number; // negative fraction (e.g. -0.18)
  maxDrawdownAbs: number; // absolute, positive
  sharpe: number; // annualized, daily returns, rf=0
  sortino: number; // annualized
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number; // > 0
  avgLoss: number; // <= 0
  expectancy: number;
  profitFactor: number; // sum(wins) / |sum(losses)|; Infinity if no losses
  totalFees: number;
}

export interface ComputeMetricsInput {
  equityCurve: EquitySnapshot[];
  trades: Trade[];
  initialCapital: number;
  tradingDaysPerYear?: number; // default 252
}

export function computeMetrics({
  equityCurve,
  trades,
  initialCapital,
  tradingDaysPerYear = 252,
}: ComputeMetricsInput): Metrics {
  const finalEquity =
    equityCurve.length > 0 ? equityCurve[equityCurve.length - 1]!.equity : initialCapital;
  const totalReturn = finalEquity / initialCapital - 1;

  // Drawdown over equity curve
  let peak = equityCurve.length > 0 ? equityCurve[0]!.equity : initialCapital;
  let maxDdPct = 0;
  let maxDdAbs = 0;
  for (const s of equityCurve) {
    if (s.equity > peak) peak = s.equity;
    const ddAbs = peak - s.equity;
    const ddPct = peak > 0 ? -ddAbs / peak : 0;
    if (ddPct < maxDdPct) maxDdPct = ddPct;
    if (ddAbs > maxDdAbs) maxDdAbs = ddAbs;
  }

  // Daily returns from equity curve (group by IST date)
  const dailyReturns = computeDailyReturns(equityCurve);
  const sharpe = annualizedSharpe(dailyReturns, tradingDaysPerYear);
  const sortino = annualizedSortino(dailyReturns, tradingDaysPerYear);

  // Trade-level stats
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  const sumWins = wins.reduce((a, t) => a + t.pnl, 0);
  const sumLosses = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = sumLosses === 0 ? (sumWins > 0 ? Infinity : 0) : sumWins / sumLosses;
  const totalFees = trades.reduce((a, t) => a + t.fees, 0);

  return {
    initialCapital,
    finalEquity,
    totalReturn,
    maxDrawdownPct: maxDdPct,
    maxDrawdownAbs: maxDdAbs,
    sharpe,
    sortino,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy,
    profitFactor,
    totalFees,
  };
}

function computeDailyReturns(curve: EquitySnapshot[]): number[] {
  if (curve.length < 2) return [];
  // Group by yyyy-mm-dd (UTC) — IST conversion not strictly needed for return calc
  const byDay = new Map<string, number>();
  for (const s of curve) {
    const key = s.ts.toISOString().slice(0, 10);
    byDay.set(key, s.equity); // last snapshot of the day wins
  }
  const days = Array.from(byDay.keys()).sort();
  const rets: number[] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = byDay.get(days[i - 1]!)!;
    const cur = byDay.get(days[i]!)!;
    if (prev > 0) rets.push(cur / prev - 1);
  }
  return rets;
}

function annualizedSharpe(returns: number[], daysPerYear: number): number {
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(daysPerYear);
}

function annualizedSortino(returns: number[], daysPerYear: number): number {
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const downside = returns.filter((r) => r < 0);
  if (downside.length === 0) return mean === 0 ? 0 : Infinity;
  const variance = downside.reduce((a, b) => a + b ** 2, 0) / downside.length;
  const dd = Math.sqrt(variance);
  if (dd === 0) return 0;
  return (mean / dd) * Math.sqrt(daysPerYear);
}

/**
 * Pair entry and exit fills into Trades using FIFO matching, supporting both
 * long-first (buy-to-open, sell-to-close) and short-first (sell-to-open,
 * buy-to-close) sequences. Per-symbol queue holds open lots tagged with side;
 * an opposite-side fill consumes lots and emits Trades, with any remainder
 * opening new lots in the fill's direction (reversals).
 */
export function buildTrades(fills: Fill[]): Trade[] {
  interface OpenLot {
    side: OrderSide; // direction of the open position (BUY = long, SELL = short)
    qty: number;
    price: number;
    ts: Date;
    fees: number;
  }
  const open = new Map<string, OpenLot[]>();
  const trades: Trade[] = [];
  for (const f of fills) {
    let q = open.get(f.symbol);
    if (!q) {
      q = [];
      open.set(f.symbol, q);
    }

    // If queue is empty or fill matches queue's side, push as a new open lot.
    if (q.length === 0 || q[0]!.side === f.side) {
      q.push({ side: f.side, qty: f.qty, price: f.price, ts: f.ts, fees: f.fees.total });
      continue;
    }

    // Opposite-side fill: consume from front of queue, emitting a Trade per
    // closed lot. If the fill exceeds the open quantity, the remainder opens
    // a new lot in the fill's direction (reversal).
    let remaining = f.qty;
    let exitFeesRemaining = f.fees.total;
    while (remaining > 0 && q.length > 0 && q[0]!.side !== f.side) {
      const lot = q[0]!;
      const matchQty = Math.min(remaining, lot.qty);
      const proportionalEntryFees = (lot.fees * matchQty) / lot.qty;
      const proportionalExitFees = (exitFeesRemaining * matchQty) / f.qty;
      // Long lot closed by SELL: pnl = (exit - entry) × qty
      // Short lot closed by BUY: pnl = (entry - exit) × qty
      const grossPnl =
        lot.side === OrderSide.BUY
          ? (f.price - lot.price) * matchQty
          : (lot.price - f.price) * matchQty;
      const pnl = grossPnl - proportionalEntryFees - proportionalExitFees;
      trades.push({
        symbol: f.symbol,
        qty: matchQty,
        entryPrice: lot.price,
        exitPrice: f.price,
        entryTs: lot.ts,
        exitTs: f.ts,
        side: lot.side, // entry leg's side
        pnl,
        fees: proportionalEntryFees + proportionalExitFees,
      });
      lot.qty -= matchQty;
      lot.fees -= proportionalEntryFees;
      remaining -= matchQty;
      exitFeesRemaining -= proportionalExitFees;
      if (lot.qty === 0) q.shift();
    }

    // Reversal: any unmatched remainder opens a new lot in the fill's direction.
    if (remaining > 0) {
      q.push({
        side: f.side,
        qty: remaining,
        price: f.price,
        ts: f.ts,
        fees: exitFeesRemaining,
      });
    }
  }
  return trades;
}
