import { DuckDBInstance, DuckDBTimestampValue, type DuckDBConnection } from '@duckdb/node-api';
import type { Candle, Interval } from '../types';

export interface CoverageRange {
  from: Date;
  to: Date;
}

function dateToTimestamp(d: Date): DuckDBTimestampValue {
  // DuckDB TIMESTAMP stores microseconds since the Unix epoch.
  return new DuckDBTimestampValue(BigInt(d.getTime()) * 1000n);
}

function timestampToDate(v: DuckDBTimestampValue | Date): Date {
  if (v instanceof Date) return v;
  return new Date(Number(v.micros / 1000n));
}

export class CandleStore {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {}

  static async open(path: string): Promise<CandleStore> {
    const instance = await DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(`
      CREATE TABLE IF NOT EXISTS candles (
        symbol   VARCHAR  NOT NULL,
        ts       TIMESTAMP NOT NULL,
        interval VARCHAR  NOT NULL,
        open     DOUBLE   NOT NULL,
        high     DOUBLE   NOT NULL,
        low      DOUBLE   NOT NULL,
        close    DOUBLE   NOT NULL,
        volume   BIGINT   NOT NULL,
        PRIMARY KEY (symbol, ts, interval)
      );
      CREATE TABLE IF NOT EXISTS coverage (
        symbol   VARCHAR NOT NULL,
        interval VARCHAR NOT NULL,
        from_ts  TIMESTAMP NOT NULL,
        to_ts    TIMESTAMP NOT NULL,
        PRIMARY KEY (symbol, interval, from_ts)
      );
    `);
    return new CandleStore(instance, conn);
  }

  async close(): Promise<void> {
    this.conn.closeSync();
    this.instance.closeSync();
  }

  async upsert(rows: Candle[]): Promise<void> {
    if (rows.length === 0) return;
    const stmt = await this.conn.prepare(`
      INSERT INTO candles (symbol, ts, interval, open, high, low, close, volume)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (symbol, ts, interval) DO UPDATE SET
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume
    `);
    try {
      for (const r of rows) {
        stmt.bindVarchar(1, r.symbol);
        stmt.bindTimestamp(2, dateToTimestamp(r.ts));
        stmt.bindVarchar(3, r.interval);
        stmt.bindDouble(4, r.open);
        stmt.bindDouble(5, r.high);
        stmt.bindDouble(6, r.low);
        stmt.bindDouble(7, r.close);
        stmt.bindBigInt(8, BigInt(r.volume));
        await stmt.run();
      }
    } finally {
      stmt.destroySync();
    }
  }

  async query(symbol: string, from: Date, to: Date, interval: Interval): Promise<Candle[]> {
    const stmt = await this.conn.prepare(
      `SELECT symbol, ts, interval, open, high, low, close, volume
       FROM candles
       WHERE symbol = $1 AND interval = $2 AND ts >= $3 AND ts < $4
       ORDER BY ts ASC`,
    );
    try {
      stmt.bindVarchar(1, symbol);
      stmt.bindVarchar(2, interval);
      stmt.bindTimestamp(3, dateToTimestamp(from));
      stmt.bindTimestamp(4, dateToTimestamp(to));
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects() as Array<{
        symbol: string;
        ts: DuckDBTimestampValue | Date;
        interval: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: bigint | number;
      }>;
      return rows.map((r) => ({
        symbol: r.symbol,
        ts: timestampToDate(r.ts),
        interval: r.interval as Interval,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: typeof r.volume === 'bigint' ? Number(r.volume) : r.volume,
      }));
    } finally {
      stmt.destroySync();
    }
  }

  async recordCoverage(symbol: string, interval: Interval, from: Date, to: Date): Promise<void> {
    const stmt = await this.conn.prepare(
      `INSERT INTO coverage (symbol, interval, from_ts, to_ts)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (symbol, interval, from_ts) DO UPDATE SET to_ts = EXCLUDED.to_ts`,
    );
    try {
      stmt.bindVarchar(1, symbol);
      stmt.bindVarchar(2, interval);
      stmt.bindTimestamp(3, dateToTimestamp(from));
      stmt.bindTimestamp(4, dateToTimestamp(to));
      await stmt.run();
    } finally {
      stmt.destroySync();
    }
  }

  async coverage(symbol: string, interval: Interval): Promise<CoverageRange[]> {
    const stmt = await this.conn.prepare(
      `SELECT from_ts, to_ts FROM coverage WHERE symbol = $1 AND interval = $2 ORDER BY from_ts ASC`,
    );
    try {
      stmt.bindVarchar(1, symbol);
      stmt.bindVarchar(2, interval);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects() as Array<{
        from_ts: DuckDBTimestampValue | Date;
        to_ts: DuckDBTimestampValue | Date;
      }>;
      return rows.map((r) => ({ from: timestampToDate(r.from_ts), to: timestampToDate(r.to_ts) }));
    } finally {
      stmt.destroySync();
    }
  }
}
