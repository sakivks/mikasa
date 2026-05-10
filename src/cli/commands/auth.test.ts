import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticate, upsertEnvVar, loginUrl } from './auth';
import { createLogger } from '../../util/logger';

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auth-'));
  envPath = join(dir, '.env');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('upsertEnvVar', () => {
  it('inserts a new key into a fresh file', () => {
    const changed = upsertEnvVar(envPath, 'FOO', 'bar');
    expect(changed).toBe(true);
    expect(readFileSync(envPath, 'utf8')).toContain('FOO=bar');
  });

  it('updates an existing key in place', () => {
    writeFileSync(envPath, 'A=1\nFOO=old\nB=2\n');
    const changed = upsertEnvVar(envPath, 'FOO', 'new');
    expect(changed).toBe(true);
    const text = readFileSync(envPath, 'utf8');
    expect(text).toContain('FOO=new');
    expect(text).toContain('A=1');
    expect(text).toContain('B=2');
    expect(text).not.toContain('FOO=old');
  });

  it('returns false when value unchanged', () => {
    writeFileSync(envPath, 'FOO=bar\n');
    expect(upsertEnvVar(envPath, 'FOO', 'bar')).toBe(false);
  });
});

describe('loginUrl', () => {
  it('builds the Kite login URL', () => {
    expect(loginUrl('abc123')).toBe('https://kite.zerodha.com/connect/login?api_key=abc123&v=3');
  });
});

describe('authenticate', () => {
  it('exchanges request_token and updates KITE_ACCESS_TOKEN in .env', async () => {
    writeFileSync(envPath, 'KITE_API_KEY=key1\nKITE_API_SECRET=sec1\nKITE_ACCESS_TOKEN=\n');
    const fakeKite = {
      async generateSession(rt: string, secret: string) {
        if (rt !== 'rt-1' || secret !== 'sec1') throw new Error('bad creds');
        return { access_token: 'tok-fresh', user_id: 'AB1234', user_name: 'Vikas' };
      },
    };
    const logger = createLogger({ runId: 'test', level: 'error' });
    const result = await authenticate({
      requestToken: 'rt-1',
      envPath,
      logger,
      kiteFactory: (apiKey: string) => {
        expect(apiKey).toBe('key1');
        return fakeKite;
      },
    });
    expect(result.accessToken).toBe('tok-fresh');
    expect(result.userId).toBe('AB1234');
    expect(result.envUpdated).toBe(true);
    const text = readFileSync(envPath, 'utf8');
    expect(text).toContain('KITE_ACCESS_TOKEN=tok-fresh');
    expect(text).toContain('KITE_API_KEY=key1');
  });

  it('throws if KITE_API_KEY missing', async () => {
    writeFileSync(envPath, 'KITE_API_SECRET=sec1\n');
    const logger = createLogger({ runId: 'test', level: 'error' });
    await expect(
      authenticate({
        requestToken: 'rt-1',
        envPath,
        logger,
        kiteFactory: () => ({
          async generateSession() {
            throw new Error('should not call');
          },
        }),
      }),
    ).rejects.toThrow(/KITE_API_KEY/);
  });
});
