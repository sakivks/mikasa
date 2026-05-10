import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { KiteConnect } from 'kiteconnect';
import type { Logger } from '../../util/logger';

export interface AuthArgs {
  requestToken: string;
  envPath: string;
  logger: Logger;
  /** Test seam: override the SDK constructor. Defaults to real KiteConnect. */
  kiteFactory?: (apiKey: string) => KiteConnectLike;
}

export interface KiteConnectLike {
  generateSession(
    requestToken: string,
    apiSecret: string,
  ): Promise<{
    access_token: string;
    user_id?: string;
    user_name?: string;
    user_shortname?: string;
  }>;
}

export interface AuthResult {
  accessToken: string;
  userId?: string;
  userName?: string;
  envUpdated: boolean;
}

export async function authenticate(args: AuthArgs): Promise<AuthResult> {
  const env = parseEnvLoose(args.envPath);
  if (!env.KITE_API_KEY) throw new Error('KITE_API_KEY missing in .env');
  if (!env.KITE_API_SECRET) throw new Error('KITE_API_SECRET missing in .env');

  const factory =
    args.kiteFactory ??
    ((apiKey: string) => new KiteConnect({ api_key: apiKey }) as unknown as KiteConnectLike);
  const kc = factory(env.KITE_API_KEY);
  const session = await kc.generateSession(args.requestToken, env.KITE_API_SECRET);

  const updated = upsertEnvVar(args.envPath, 'KITE_ACCESS_TOKEN', session.access_token);
  args.logger.info(
    { userId: session.user_id, userName: session.user_name, envPath: args.envPath },
    'Kite auth complete',
  );
  const result: AuthResult = {
    accessToken: session.access_token,
    envUpdated: updated,
  };
  if (session.user_id !== undefined) result.userId = session.user_id;
  if (session.user_name !== undefined) result.userName = session.user_name;
  return result;
}

/** Read .env without strict validation (we don't yet have ACCESS_TOKEN, full parseEnv would throw). */
function parseEnvLoose(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]!] = v;
  }
  return out;
}

/** Upsert KEY=VALUE in a .env file. Returns true if file changed. */
export function upsertEnvVar(path: string, key: string, value: string): boolean {
  const old = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const escaped = value.replace(/"/g, '\\"');
  const newLine = `${key}=${escaped}`;
  const lines = old.split('\n');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (new RegExp(`^\\s*${key}\\s*=`).test(line)) {
      lines[i] = newLine;
      found = true;
      break;
    }
  }
  if (!found) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push(newLine);
    else lines.splice(lines.length - 1, 0, newLine);
  }
  const next = lines.join('\n');
  if (next === old) return false;
  writeFileSync(path, next);
  return true;
}

/** Build the Kite login URL for the given API key. */
export function loginUrl(apiKey: string): string {
  return `https://kite.zerodha.com/connect/login?api_key=${encodeURIComponent(apiKey)}&v=3`;
}
