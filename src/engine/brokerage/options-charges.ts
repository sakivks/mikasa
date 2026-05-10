import type { Fees, OrderSide } from '../../types';
import type { OptionContract } from '../../types/options';

export interface FilledLeg {
  contract: OptionContract;
  side: OrderSide;
  qty: number;            // in lots
  price: number;
}

// Zerodha options fee schedule (NSE F&O), per leg:
const STT_SELL = 0.001;          // 0.1% on sell-side premium (post Oct-2023)
const EXCHANGE = 0.000503;       // NSE exchange txn charge: 0.0503% of premium turnover
const SEBI = 0.000001;           // SEBI turnover fee: ₹10 per crore = 0.0001%
const STAMP_BUY = 0.00003;       // Stamp duty: 0.003% on buy-side turnover
const GST = 0.18;                // 18% GST on (brokerage + exchange + SEBI)
const BROKERAGE_RATE = 0.0003;   // 0.03% of turnover
const BROKERAGE_CAP = 20;        // Flat ₹20 cap per executed order (Zerodha)

/**
 * Compute per-leg charges for an executed option leg per the Zerodha fee schedule.
 * Pure function, no I/O. `qty` is in lots; turnover = price × qty × lotSize.
 */
export function calcOptionLegCharges(leg: FilledLeg): Fees {
  const turnover = leg.price * leg.qty * leg.contract.lotSize;
  const brokerage = Math.min(BROKERAGE_CAP, turnover * BROKERAGE_RATE);
  const stt = leg.side === 'sell' ? turnover * STT_SELL : 0;
  const exchange = turnover * EXCHANGE;
  const sebi = turnover * SEBI;
  const stampDuty = leg.side === 'buy' ? turnover * STAMP_BUY : 0;
  const gst = (brokerage + exchange + sebi) * GST;
  const total = brokerage + stt + exchange + sebi + stampDuty + gst;
  return { brokerage, stt, exchange, sebi, stampDuty, gst, total };
}
