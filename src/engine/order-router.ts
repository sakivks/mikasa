import { OrderSide, OrderStatus, OrderType, type Order, type OrderIntent, type Position } from '../types';
import type { MultiLegOrder } from '../types/options';
import { isSquareoffBarIST } from '../util/time';

export interface OrderRouterOpts {
  squareoffTime: string | null; // 'HH:mm' IST, or null to disable
}

export class OrderRouter {
  private readonly _queue: Order[] = [];
  private readonly _multiLegQueue: MultiLegOrder[] = [];
  private nextId = 1;
  private nextMultiLegId = 1;
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

  submitMultiLeg(order: Omit<MultiLegOrder, 'id' | 'ts'>): string {
    const id = `ml-${this.nextMultiLegId++}`;
    // ts is assigned by the engine when it processes the order against the current bar.
    const full: MultiLegOrder = { ...order, id, ts: new Date(0) };
    this._multiLegQueue.push(full);
    return id;
  }

  drainMultiLeg(): MultiLegOrder[] {
    return this._multiLegQueue.splice(0, this._multiLegQueue.length);
  }

  queued(): Order[] {
    return this._queue;
  }

  drain(): Order[] {
    const out = this._queue.splice(0, this._queue.length);
    return out;
  }

  maybeSquareoff(barTs: Date, positions: Position[]): void {
    if (!this.opts.squareoffTime) return;
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
