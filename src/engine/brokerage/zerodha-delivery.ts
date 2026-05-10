import type { Fees } from '../../types';
import { OrderSide as Side } from '../../types';
import type { BrokerageFn, BrokerageInput } from './zerodha-intraday';

/**
 * Zerodha equity *delivery* (positional / multi-day) fee schedule (NSE).
 *  - brokerage: zero
 *  - STT: 0.1% on both buy and sell turnovers
 *  - Exchange txn (NSE): 0.00322% turnover
 *  - GST: 18% on (brokerage + exchange + SEBI)
 *  - SEBI: 0.0001% turnover
 *  - Stamp duty: 0.015% on buy turnover
 */
export const zerodhaDelivery: BrokerageFn = ({ side, qty, price }: BrokerageInput): Fees => {
  const turnover = qty * price;
  const brokerage = 0;
  const stt = turnover * 0.001; // both sides
  const exchange = turnover * 0.0000322;
  const sebi = turnover * 0.000001;
  const stampDuty = side === Side.BUY ? turnover * 0.00015 : 0;
  const gst = (brokerage + exchange + sebi) * 0.18;
  const total = brokerage + stt + exchange + gst + sebi + stampDuty;
  return { brokerage, stt, exchange, gst, sebi, stampDuty, total };
};
