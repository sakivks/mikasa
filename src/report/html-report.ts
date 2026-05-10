import type { EquitySnapshot, Trade } from '../types';
import type { Metrics } from './metrics';

export interface ReportInput {
  runId: string;
  strategy: string;
  symbols: string[];
  from: string;
  to: string;
  interval: string;
  metrics: Metrics;
  equityCurve: EquitySnapshot[];
  trades: Trade[];
}

const fmt = (n: number, opts: Intl.NumberFormatOptions = {}) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, ...opts }).format(n);

const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`;

export function renderHtml(r: ReportInput): string {
  const equityData = r.equityCurve.map((s) => ({ x: s.ts.toISOString(), y: s.equity }));
  const ddData = computeDrawdownSeries(r.equityCurve);
  const tradesRows = r.trades
    .map(
      (t) => `<tr>
        <td>${t.symbol}</td>
        <td>${t.entryTs.toISOString().replace('T', ' ').slice(0, 19)}</td>
        <td>${t.exitTs.toISOString().replace('T', ' ').slice(0, 19)}</td>
        <td>${t.side}</td>
        <td>${t.qty}</td>
        <td>${fmt(t.entryPrice)}</td>
        <td>${fmt(t.exitPrice)}</td>
        <td class="${t.pnl >= 0 ? 'pos' : 'neg'}">${fmt(t.pnl)}</td>
        <td>${fmt(t.fees)}</td>
      </tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Backtest — ${escapeHtml(r.strategy)} — ${r.runId}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0"></script>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 24px; color: #222; }
  h1 { margin: 0 0 4px; }
  .meta { color: #666; margin-bottom: 24px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #f7f7f8; border-radius: 8px; padding: 12px 16px; }
  .card .k { font-size: 12px; color: #666; }
  .card .v { font-size: 20px; font-weight: 600; margin-top: 4px; }
  .pos { color: #1a7f37; } .neg { color: #c62828; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border-bottom: 1px solid #eee; padding: 6px 8px; text-align: right; }
  th:first-child, td:first-child, th:nth-child(4), td:nth-child(4) { text-align: left; }
  .chart { height: 320px; margin-bottom: 32px; }
  h2 { margin-top: 32px; }
</style>
</head>
<body>
<h1>Backtest — ${escapeHtml(r.strategy)}</h1>
<div class="meta">
  Run <code>${r.runId}</code> · Symbols: ${r.symbols.map(escapeHtml).join(', ')} · ${r.from} → ${r.to} · Interval: ${r.interval}
</div>

<div class="grid">
  ${kv('Initial Capital', fmt(r.metrics.initialCapital))}
  ${kv('Final Equity', fmt(r.metrics.finalEquity))}
  ${kv('Total Return', fmtPct(r.metrics.totalReturn))}
  ${kv('Max Drawdown', fmtPct(r.metrics.maxDrawdownPct))}
  ${kv('Sharpe', fmt(r.metrics.sharpe))}
  ${kv('Sortino', fmt(r.metrics.sortino))}
  ${kv('Trades', String(r.metrics.totalTrades))}
  ${kv('Win Rate', fmtPct(r.metrics.winRate))}
  ${kv('Avg Win', fmt(r.metrics.avgWin))}
  ${kv('Avg Loss', fmt(r.metrics.avgLoss))}
  ${kv('Expectancy', fmt(r.metrics.expectancy))}
  ${kv('Profit Factor', Number.isFinite(r.metrics.profitFactor) ? fmt(r.metrics.profitFactor) : '∞')}
  ${kv('Total Fees', fmt(r.metrics.totalFees))}
</div>

<h2>Equity Curve</h2>
<div class="chart"><canvas id="eq"></canvas></div>

<h2>Drawdown</h2>
<div class="chart"><canvas id="dd"></canvas></div>

<h2>Trade List</h2>
<table>
  <thead><tr>
    <th>Symbol</th><th>Entry</th><th>Exit</th><th>Side</th><th>Qty</th><th>Entry Px</th><th>Exit Px</th><th>P&amp;L</th><th>Fees</th>
  </tr></thead>
  <tbody>
    ${tradesRows || '<tr><td colspan="9">No trades</td></tr>'}
  </tbody>
</table>

<script>
const equity = ${JSON.stringify(equityData)};
const dd = ${JSON.stringify(ddData)};
new Chart(document.getElementById('eq'), {
  type: 'line',
  data: { datasets: [{ label: 'Equity', data: equity, borderColor: '#0969da', borderWidth: 1.5, pointRadius: 0 }] },
  options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time' } } }
});
new Chart(document.getElementById('dd'), {
  type: 'line',
  data: { datasets: [{ label: 'Drawdown', data: dd, borderColor: '#c62828', backgroundColor: 'rgba(198,40,40,0.2)', fill: true, borderWidth: 1, pointRadius: 0 }] },
  options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time' }, y: { ticks: { callback: v => (v*100).toFixed(0)+'%' } } } }
});
</script>
</body>
</html>`;
}

function kv(k: string, v: string): string {
  return `<div class="card"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function computeDrawdownSeries(curve: EquitySnapshot[]): Array<{ x: string; y: number }> {
  let peak = curve.length > 0 ? curve[0]!.equity : 0;
  return curve.map((s) => {
    if (s.equity > peak) peak = s.equity;
    return { x: s.ts.toISOString(), y: peak > 0 ? (s.equity - peak) / peak : 0 };
  });
}
