import type { Fill } from '../types';

export interface OptionsReportRow {
  expiryDate: string;
  entryTs: Date;
  exitTs: Date | null;
  grossPnl: number;
  charges: number;
  netPnl: number;
  entryLegs: Fill[];
  exitLegs: Fill[];
}

interface LegBasket {
  orderId: string;
  ts: Date;
  fills: Fill[];
  expiryKey: string;
}

function extractExpiryKey(symbol: string): string {
  // Parses option tradingsymbols synthesized by `buildOptionSymbol`, e.g.
  // 'NIFTY-2025-05-22-22000-CE'. Returns the YYYY-MM-DD expiry date — unique
  // per weekly expiry, so multiple weeklies in the same month no longer
  // collapse into a single per-expiry row (the old `\d{2}[A-Z]{3}` regex
  // matched only the month code and conflated all four May weeklies).
  const m = symbol.match(/(\d{4}-\d{2}-\d{2})/);
  return m?.[1] ?? 'unknown';
}

export function buildOptionsRows(fills: Fill[]): OptionsReportRow[] {
  // 1) Group by multiLegOrderId — one basket per submitted order
  const baskets = new Map<string, LegBasket>();
  for (const f of fills) {
    if (!f.multiLegOrderId) continue;
    let b = baskets.get(f.multiLegOrderId);
    if (!b) {
      b = { orderId: f.multiLegOrderId, ts: f.ts, fills: [], expiryKey: extractExpiryKey(f.symbol) };
      baskets.set(f.multiLegOrderId, b);
    }
    b.fills.push(f);
    if (f.ts < b.ts) b.ts = f.ts;
  }

  // 2) Pair baskets by expiryKey — earliest = entry, next = exit
  const byExpiry = new Map<string, LegBasket[]>();
  for (const b of baskets.values()) {
    const arr = byExpiry.get(b.expiryKey) ?? [];
    arr.push(b);
    byExpiry.set(b.expiryKey, arr);
  }

  const rows: OptionsReportRow[] = [];
  for (const [expiryKey, arr] of byExpiry) {
    arr.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    for (let i = 0; i < arr.length; i += 2) {
      const entry = arr[i]!;
      const exit = arr[i + 1] ?? null;
      const allFills = [...entry.fills, ...(exit?.fills ?? [])];

      const charges = allFills.reduce((s, f) => s + f.fees.total, 0);
      // Cash flow from premium: SELL contributes +qty*price (premium received), BUY -qty*price (premium paid)
      let cashFlow = 0;
      for (const f of allFills) {
        cashFlow += (f.side === 'sell' ? +1 : -1) * f.qty * f.price;
      }
      const grossPnl = cashFlow;

      rows.push({
        expiryDate: expiryKey,
        entryTs: entry.ts,
        exitTs: exit?.ts ?? null,
        grossPnl,
        charges,
        netPnl: grossPnl - charges,
        entryLegs: entry.fills,
        exitLegs: exit?.fills ?? [],
      });
    }
  }
  rows.sort((a, b) => a.entryTs.getTime() - b.entryTs.getTime());
  return rows;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

export function renderOptionsSection(fills: Fill[]): string {
  const rows = buildOptionsRows(fills);
  if (rows.length === 0) return '';

  const totalGross = rows.reduce((s, r) => s + r.grossPnl, 0);
  const totalCharges = rows.reduce((s, r) => s + r.charges, 0);
  const totalNet = rows.reduce((s, r) => s + r.netPnl, 0);
  const chargeDrag = Math.abs(totalGross) > 0 ? (totalCharges / Math.abs(totalGross)) * 100 : 0;

  const tbody = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.expiryDate)}</td>
      <td>${r.entryTs.toISOString()}</td>
      <td>${r.exitTs?.toISOString() ?? '—'}</td>
      <td>${r.grossPnl.toFixed(2)}</td>
      <td>${r.charges.toFixed(2)}</td>
      <td>${r.netPnl.toFixed(2)}</td>
    </tr>`,
    )
    .join('');

  return `
<section class="per-expiry">
  <h3>Per-expiry options breakdown</h3>
  <table>
    <thead><tr><th>Expiry</th><th>Entry</th><th>Exit</th><th>Gross P&amp;L</th><th>Charges</th><th>Net P&amp;L</th></tr></thead>
    <tbody>${tbody}</tbody>
    <tfoot>
      <tr><th>Total</th><th></th><th></th><th>${totalGross.toFixed(2)}</th><th>${totalCharges.toFixed(2)}</th><th>${totalNet.toFixed(2)}</th></tr>
    </tfoot>
  </table>
  <p>Charge drag: ${chargeDrag.toFixed(1)}%</p>
</section>`;
}
