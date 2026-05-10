export class RSI {
  private prevPrice: number | undefined;
  private readonly gains: number[] = [];
  private readonly losses: number[] = [];
  private avgGain: number | undefined;
  private avgLoss: number | undefined;
  private cur: number | undefined;

  constructor(private readonly period: number = 14) {
    if (period <= 0 || !Number.isInteger(period)) {
      throw new Error(`RSI period must be a positive integer, got ${period}`);
    }
  }

  update(price: number): number | undefined {
    if (this.prevPrice === undefined) {
      this.prevPrice = price;
      return undefined;
    }
    const change = price - this.prevPrice;
    this.prevPrice = price;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (this.avgGain === undefined) {
      this.gains.push(gain);
      this.losses.push(loss);
      if (this.gains.length < this.period) {
        return undefined;
      }
      this.avgGain = this.gains.reduce((a, b) => a + b, 0) / this.period;
      this.avgLoss = this.losses.reduce((a, b) => a + b, 0) / this.period;
    } else {
      this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
      this.avgLoss = (this.avgLoss! * (this.period - 1) + loss) / this.period;
    }
    if (this.avgLoss === 0) {
      this.cur = 100;
    } else {
      const rs = this.avgGain / this.avgLoss;
      this.cur = 100 - 100 / (1 + rs);
    }
    return this.cur;
  }

  get value(): number | undefined {
    return this.cur;
  }
}
