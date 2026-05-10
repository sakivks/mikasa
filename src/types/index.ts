export type Interval = '1minute' | '3minute' | '5minute' | '10minute' | '15minute' | '30minute' | '60minute' | 'day';

export interface Candle {
  symbol: string;
  ts: Date;       // UTC; consumers convert to IST as needed
  interval: Interval;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const OrderSide = { BUY: 'buy', SELL: 'sell' } as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const OrderType = { MARKET: 'market', LIMIT: 'limit', STOP: 'stop' } as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const OrderStatus = {
  SUBMITTED: 'submitted',
  PENDING: 'pending',
  FILLED: 'filled',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export type OrderId = string;

export interface OrderIntent {
  symbol: string;
  side: OrderSide;
  qty: number;
  type: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  tag?: string;             // optional strategy-supplied label
}

export interface Order {
  id: OrderId;
  submittedAt: Date;
  status: OrderStatus;
  intent: OrderIntent;
  rejectionReason?: string;
}

export interface Fees {
  brokerage: number;
  stt: number;
  exchange: number;
  gst: number;
  sebi: number;
  stampDuty: number;
  total: number;
}

export interface Fill {
  orderId: OrderId;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  ts: Date;
  fees: Fees;
}

export interface Position {
  symbol: string;
  qty: number;            // signed: positive long, negative short
  avgPrice: number;
}

export interface Trade {
  symbol: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryTs: Date;
  exitTs: Date;
  side: OrderSide;        // side of the entry leg
  pnl: number;            // net of fees
  fees: number;           // total fees across entry + exit
}

export interface EquitySnapshot {
  ts: Date;
  cash: number;
  unrealized: number;
  realized: number;
  equity: number;         // cash + unrealized + realized
}
