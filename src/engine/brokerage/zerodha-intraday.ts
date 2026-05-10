import type { Fees, OrderSide } from '../../types';
import { OrderSide as Side } from '../../types';

export interface BrokerageInput {
  side: OrderSide;
  qty: number;
  price: number;
}

export type BrokerageFn = (i: BrokerageInput) => Fees;

/**
 * Zerodha equity intraday fee schedule (NSE):
 *  - brokerage: min(0.03% of turnover, ₹20) per executed order
 *  - STT/CTT: 0.025% on sell-side turnover
 *  - Exchange txn charge (NSE): 0.00322% turnover
 *  - GST: 18% on (brokerage + exchange + SEBI)
 *  - SEBI: ₹10 per crore (= 0.0001% turnover)
 *  - Stamp duty: 0.003% on buy-side turnover
 */
export const zerodhaIntraday: BrokerageFn = ({ side, qty, price }) => {
  const turnover = qty * price;
  const brokerage = Math.min(turnover * 0.0003, 20);
  const stt = side === Side.SELL ? turnover * 0.00025 : 0;
  const exchange = turnover * 0.0000322;
  const sebi = turnover * 0.000001;
  const stampDuty = side === Side.BUY ? turnover * 0.00003 : 0;
  const gst = (brokerage + exchange + sebi) * 0.18;
  const total = brokerage + stt + exchange + gst + sebi + stampDuty;
  return { brokerage, stt, exchange, gst, sebi, stampDuty, total };
};

export const zeroBrokerage: BrokerageFn = () => ({
  brokerage: 0,
  stt: 0,
  exchange: 0,
  gst: 0,
  sebi: 0,
  stampDuty: 0,
  total: 0,
});
