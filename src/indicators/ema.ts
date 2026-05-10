export class EMA {
  private readonly seedBuf: number[] = [];
  private readonly alpha: number;
  private cur: number | undefined;

  constructor(private readonly period: number) {
    if (period <= 0 || !Number.isInteger(period)) {
      throw new Error(`EMA period must be a positive integer, got ${period}`);
    }
    this.alpha = 2 / (period + 1);
  }

  update(price: number): number | undefined {
    if (this.cur === undefined) {
      this.seedBuf.push(price);
      if (this.seedBuf.length < this.period) return undefined;
      this.cur = this.seedBuf.reduce((a, b) => a + b, 0) / this.period;
      return this.cur;
    }
    this.cur = this.alpha * price + (1 - this.alpha) * this.cur;
    return this.cur;
  }

  get value(): number | undefined {
    return this.cur;
  }
}
