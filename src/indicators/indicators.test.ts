import { describe, it, expect } from 'vitest';
import { SMA } from './sma';
import { EMA } from './ema';
import { RSI } from './rsi';
import { IndicatorRegistry } from './registry';

describe('SMA', () => {
  it('returns undefined while warming up, then arithmetic mean', () => {
    const sma = new SMA(3);
    expect(sma.update(10)).toBeUndefined();
    expect(sma.update(20)).toBeUndefined();
    expect(sma.update(30)).toBe(20); // (10+20+30)/3
    expect(sma.update(40)).toBe(30); // (20+30+40)/3
    expect(sma.update(50)).toBe(40); // (30+40+50)/3
  });

  it('rejects non-positive period', () => {
    expect(() => new SMA(0)).toThrow();
    expect(() => new SMA(-1)).toThrow();
  });

  it('exposes current value', () => {
    const sma = new SMA(2);
    sma.update(10);
    sma.update(20);
    expect(sma.value).toBe(15);
  });
});

describe('EMA', () => {
  it('returns first SMA-of-period at warmup boundary, then EMA recurrence', () => {
    const ema = new EMA(3);
    expect(ema.update(10)).toBeUndefined();
    expect(ema.update(20)).toBeUndefined();
    const v0 = ema.update(30); // seed = (10+20+30)/3 = 20
    expect(v0).toBe(20);
    // alpha = 2/(period+1) = 0.5
    // next: 0.5*40 + 0.5*20 = 30
    expect(ema.update(40)).toBe(30);
    // next: 0.5*50 + 0.5*30 = 40
    expect(ema.update(50)).toBe(40);
  });
});

describe('RSI', () => {
  it('returns undefined for first 14 updates while warming up (period=14)', () => {
    const rsi = new RSI(14);
    // With Wilder smoothing the first call only seeds prevPrice; we then need
    // `period` gain/loss samples → first RSI on the (period+1)th update.
    for (let i = 0; i < 14; i++) {
      expect(rsi.update(10 + i)).toBeUndefined();
    }
    expect(rsi.update(25)).toBeDefined();
  });

  it('matches Wilder reference value on the canonical 14-price series', () => {
    // Classic 14-price Wilder example: feeding these 14 closes yields 13
    // change samples. With period=13 (so the first RSI fires on the final
    // input), the result is ≈ 70.46 — the well-known Wilder reference value.
    const rsi = new RSI(13);
    const prices = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28];
    let last: number | undefined;
    for (const p of prices) last = rsi.update(p);
    expect(last).toBeDefined();
    expect(Math.abs(last! - 70.46)).toBeLessThan(0.5);
  });

  it('rejects non-positive period', () => {
    expect(() => new RSI(0)).toThrow();
    expect(() => new RSI(-1)).toThrow();
    expect(() => new RSI(1.5)).toThrow();
  });

  it('returns 100 when there are no losses in the window', () => {
    const rsi = new RSI(3);
    rsi.update(10);
    rsi.update(11);
    rsi.update(12);
    const v = rsi.update(13);
    expect(v).toBe(100);
  });

  it('exposes current value via getter', () => {
    const rsi = new RSI(3);
    rsi.update(10);
    rsi.update(11);
    rsi.update(12);
    rsi.update(13);
    expect(rsi.value).toBe(100);
  });
});

describe('IndicatorRegistry', () => {
  it('registers and retrieves indicators by symbol+key', () => {
    const reg = new IndicatorRegistry();
    const sma = new SMA(5);
    reg.register('RELIANCE', 'sma_fast', sma);
    expect(reg.get('RELIANCE', 'sma_fast')).toBe(sma);
    expect(reg.get('RELIANCE', 'missing')).toBeUndefined();
  });

  it('feeds the close price into all indicators registered for a symbol', () => {
    const reg = new IndicatorRegistry();
    const fast = new SMA(2);
    const slow = new SMA(3);
    reg.register('R', 'fast', fast);
    reg.register('R', 'slow', slow);
    reg.feedClose('R', 10);
    reg.feedClose('R', 20);
    reg.feedClose('R', 30);
    expect(fast.value).toBe(25); // (20+30)/2
    expect(slow.value).toBe(20); // (10+20+30)/3
  });
});
