import type { OrderSide } from './index';

export type OptionType = 'CE' | 'PE';
export type Underlying = 'NIFTY' | 'BANKNIFTY';

export interface OptionContract {
  symbol: string;
  underlying: Underlying;
  expiry: Date;
  strike: number;
  optionType: OptionType;
  lotSize: number;
  instrumentToken: number;
}

export interface Leg {
  contract: OptionContract;
  side: OrderSide;
  qty: number;                  // in lots
}

export interface MultiLegOrder {
  id: string;
  ts: Date;
  legs: Leg[];
  reason: string;               // 'entry' | 'sl' | 'target' | 'eod' | 'exit'
}

export interface OptionPosition {
  contract: OptionContract;
  netQty: number;               // signed lots; negative = short
  avgPrice: number;             // weighted avg entry price (per-share)
  realizedPnl: number;
}
