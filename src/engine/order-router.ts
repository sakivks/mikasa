import { OrderSide, OrderStatus, OrderType, type Order, type OrderIntent, type Position } from '../types';
import { isSquareoffBarIST } from '../util/time';

export interface OrderRouterOpts {
  squareoffTime: string; // 'HH:mm' IST
}

export class OrderRouter {
  private readonly _queue: Order[] = [];
  private nextId = 1;
  private squareoffEmittedAt: number | null = null;

  constructor(private readonly opts: OrderRouterOpts) {}

  submit(intent: OrderIntent): string {
    const id = `ord-${this.nextId++}`;
    this._queue.push({
      id,
      submittedAt: new Date(),
      status: OrderStatus.SUBMITTED,
      intent,
    });
    return id;
  }

  queued(): Order[] {
    return this._queue;
  }

  drain(): Order[] {
    const out = this._queue.splice(0, this._queue.length);
    return out;
  }

  maybeSquareoff(barTs: Date, positions: Position[]): void {
    if (!isSquareoffBarIST(barTs, this.opts.squareoffTime)) return;
    if (this.squareoffEmittedAt === barTs.getTime()) return;
    this.squareoffEmittedAt = barTs.getTime();
    for (const p of positions) {
      if (p.qty === 0) continue;
      const exit: OrderIntent = {
        symbol: p.symbol,
        side: p.qty > 0 ? OrderSide.SELL : OrderSide.BUY,
        qty: Math.abs(p.qty),
        type: OrderType.MARKET,
        tag: 'squareoff',
      };
      this.submit(exit);
    }
  }
}
