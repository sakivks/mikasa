import { describe, it, expect } from 'vitest';
import { renderHtml } from './html-report';
import { OrderSide } from '../types';

describe('renderHtml', () => {
  it('produces a self-contained HTML with all sections', () => {
    const html = renderHtml({
      runId: '20250102-100000-Test',
      strategy: 'TestStrategy',
      symbols: ['R'],
      from: '2025-01-01',
      to: '2025-01-31',
      interval: '5minute',
      metrics: {
        initialCapital: 100_000,
        finalEquity: 110_000,
        totalReturn: 0.1,
        maxDrawdownPct: -0.05,
        maxDrawdownAbs: 5000,
        sharpe: 1.2,
        sortino: 1.5,
        totalTrades: 5,
        wins: 3,
        losses: 2,
        winRate: 0.6,
        avgWin: 500,
        avgLoss: -200,
        expectancy: 220,
        profitFactor: 3.75,
        totalFees: 100,
      },
      equityCurve: [
        { ts: new Date('2025-01-02T03:45:00Z'), cash: 100_000, unrealized: 0, realized: 0, equity: 100_000 },
        { ts: new Date('2025-01-02T10:00:00Z'), cash: 100_000, unrealized: 10_000, realized: 0, equity: 110_000 },
      ],
      trades: [
        { symbol: 'R', qty: 1, entryPrice: 100, exitPrice: 110, entryTs: new Date('2025-01-02T03:50:00Z'), exitTs: new Date('2025-01-02T04:00:00Z'), side: OrderSide.BUY, pnl: 10, fees: 0 },
      ],
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('TestStrategy');
    expect(html).toContain('Equity Curve');
    expect(html).toContain('Drawdown');
    expect(html).toContain('Trade List');
    expect(html).toContain('Sharpe');
    expect(html).toMatch(/100000|100,000/);
    // Chart.js inlined or via script tag (we use CDN to keep file small but reproducible)
    expect(html).toMatch(/chart\.js|Chart\(/);
    // No NaN leaked
    expect(html).not.toContain('NaN');
  });
});
