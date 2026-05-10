export interface BollingerValue {
  middle: number;
  upper: number;
  lower: number;
}

export class Bollinger {
  private readonly buf: number[] = [];
  private cur: BollingerValue | undefined;

  constructor(
    private readonly period: number = 20,
    private readonly stddev: number = 2,
  ) {
    if (period <= 0 || !Number.isInteger(period)) {
      throw new Error(`Bollinger period must be a positive integer, got ${period}`);
    }
    if (stddev <= 0) {
      throw new Error(`Bollinger stddev must be > 0, got ${stddev}`);
    }
  }

  update(price: number): BollingerValue | undefined {
    this.buf.push(price);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.cur = undefined;
      return undefined;
    }
    const mean = this.buf.reduce((a, b) => a + b, 0) / this.period;
    const variance = this.buf.reduce((a, b) => a + (b - mean) ** 2, 0) / this.period;
    const std = Math.sqrt(variance);
    this.cur = {
      middle: mean,
      upper: mean + this.stddev * std,
      lower: mean - this.stddev * std,
    };
    return this.cur;
  }

  get value(): BollingerValue | undefined {
    return this.cur;
  }
}
