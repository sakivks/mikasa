export class SMA {
  private readonly buf: number[] = [];
  private sum = 0;
  private cur: number | undefined;

  constructor(private readonly period: number) {
    if (period <= 0 || !Number.isInteger(period)) {
      throw new Error(`SMA period must be a positive integer, got ${period}`);
    }
  }

  update(price: number): number | undefined {
    this.buf.push(price);
    this.sum += price;
    if (this.buf.length > this.period) {
      this.sum -= this.buf.shift()!;
    }
    if (this.buf.length < this.period) {
      this.cur = undefined;
      return undefined;
    }
    this.cur = this.sum / this.period;
    return this.cur;
  }

  get value(): number | undefined {
    return this.cur;
  }
}
