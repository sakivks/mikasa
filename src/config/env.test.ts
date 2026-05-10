import { describe, it, expect } from 'vitest';
import { parseEnv } from './env';

describe('parseEnv', () => {
  it('parses valid env', () => {
    const env = parseEnv({
      KITE_API_KEY: 'k',
      KITE_API_SECRET: 's',
      KITE_ACCESS_TOKEN: 'tok',
      LOG_LEVEL: 'debug',
    });
    expect(env.KITE_API_KEY).toBe('k');
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('defaults LOG_LEVEL to info', () => {
    const env = parseEnv({
      KITE_API_KEY: 'k',
      KITE_API_SECRET: 's',
      KITE_ACCESS_TOKEN: 'tok',
    });
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('throws when KITE_API_KEY missing', () => {
    expect(() =>
      parseEnv({ KITE_API_SECRET: 's', KITE_ACCESS_TOKEN: 't' }),
    ).toThrow(/KITE_API_KEY/);
  });
});
