import { describe, it, expect } from 'vitest';
import { SMA } from './sma';
import { EMA } from './ema';
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
