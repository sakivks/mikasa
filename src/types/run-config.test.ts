import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunConfig, RunConfigSchema } from './run-config';

const tmp = mkdtempSync(join(tmpdir(), 'rc-'));

function writeYaml(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content);
  return p;
}

describe('RunConfigSchema', () => {
  it('parses a valid config', () => {
    const cfg = RunConfigSchema.parse({
      strategy: 'SmaCrossover',
      params: { fast: 9, slow: 21 },
      symbols: ['RELIANCE'],
      from: '2025-01-01',
      to: '2025-01-31',
      interval: '5minute',
      capital: 100000,
      slippage_bps: 5,
      brokerage: 'zerodha-intraday',
      warmup_bars: 200,
      squareoff_time: '15:15',
      seed: 42,
    });
    expect(cfg.strategy).toBe('SmaCrossover');
    expect(cfg.symbols).toEqual(['RELIANCE']);
  });

  it('applies defaults for warmup_bars and squareoff_time', () => {
    const cfg = RunConfigSchema.parse({
      strategy: 'SmaCrossover',
      params: {},
      symbols: ['INFY'],
      from: '2025-01-01',
      to: '2025-01-31',
      interval: '5minute',
      capital: 100000,
      slippage_bps: 5,
      brokerage: 'zerodha-intraday',
      seed: 1,
    });
    expect(cfg.warmup_bars).toBe(200);
    expect(cfg.squareoff_time).toBe('15:15');
  });

  it('rejects from > to', () => {
    expect(() =>
      RunConfigSchema.parse({
        strategy: 'X',
        params: {},
        symbols: ['A'],
        from: '2025-02-01',
        to: '2025-01-01',
        interval: '5minute',
        capital: 100000,
        slippage_bps: 0,
        brokerage: 'zerodha-intraday',
        seed: 0,
      }),
    ).toThrow(/from/);
  });

  it('accepts squareoff_time: null and round-trips', () => {
    const cfg = RunConfigSchema.parse({
      strategy: 'DailyTrend',
      params: {},
      symbols: ['INFY'],
      from: '2025-01-01',
      to: '2025-01-31',
      interval: 'day',
      capital: 100000,
      slippage_bps: 0,
      brokerage: 'zerodha-intraday',
      squareoff_time: null,
      seed: 0,
    });
    expect(cfg.squareoff_time).toBeNull();
  });

  it('source defaults to kite, accepts yahoo', () => {
    const cfg = RunConfigSchema.parse({
      strategy: 'X', params: {}, symbols: ['A'],
      from: '2025-01-01', to: '2025-01-31', interval: '5minute',
      capital: 100000, slippage_bps: 0, brokerage: 'zerodha-intraday', seed: 0,
    });
    expect(cfg.source).toBe('kite');

    const cfgYahoo = RunConfigSchema.parse({
      strategy: 'X', params: {}, symbols: ['A'],
      from: '2025-01-01', to: '2025-01-31', interval: '5minute',
      capital: 100000, slippage_bps: 0, brokerage: 'zerodha-intraday', seed: 0,
      source: 'yahoo',
    });
    expect(cfgYahoo.source).toBe('yahoo');
  });

  it('rejects empty symbols', () => {
    expect(() =>
      RunConfigSchema.parse({
        strategy: 'X',
        params: {},
        symbols: [],
        from: '2025-01-01',
        to: '2025-01-31',
        interval: '5minute',
        capital: 100000,
        slippage_bps: 0,
        brokerage: 'zerodha-intraday',
        seed: 0,
      }),
    ).toThrow();
  });
});

describe('loadRunConfig', () => {
  it('loads YAML and validates', () => {
    const p = writeYaml(
      'good.yaml',
      [
        'strategy: SmaCrossover',
        'params: { fast: 9, slow: 21 }',
        'symbols: [RELIANCE]',
        'from: 2025-01-01',
        'to: 2025-01-31',
        'interval: 5minute',
        'capital: 100000',
        'slippage_bps: 5',
        'brokerage: zerodha-intraday',
        'seed: 42',
      ].join('\n'),
    );
    const cfg = loadRunConfig(p);
    expect(cfg.strategy).toBe('SmaCrossover');
    expect(cfg.symbols).toEqual(['RELIANCE']);
    expect(cfg.warmup_bars).toBe(200);
  });

  it('throws with field path on invalid YAML', () => {
    const p = writeYaml(
      'bad.yaml',
      [
        'strategy: SmaCrossover',
        'params: {}',
        'symbols: []',
        'from: 2025-01-01',
        'to: 2025-01-31',
        'interval: 5minute',
        'capital: 100000',
        'slippage_bps: 5',
        'brokerage: zerodha-intraday',
        'seed: 0',
      ].join('\n'),
    );
    expect(() => loadRunConfig(p)).toThrow(/symbols/);
  });
});
