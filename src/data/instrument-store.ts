import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { OptionContract, OptionType, Underlying } from '../types/options';

export interface Instrument {
  instrumentToken: number;
  tradingsymbol: string;
  exchange: string; // 'NSE' | 'BSE' | 'NFO' etc.
  segment: string;
  instrumentType: string; // 'EQ' | 'FUT' | ...
}

export class InstrumentStore {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {}

  static async open(path: string): Promise<InstrumentStore> {
    const instance = await DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(`
      CREATE TABLE IF NOT EXISTS instruments (
        instrument_token BIGINT NOT NULL,
        tradingsymbol VARCHAR NOT NULL,
        exchange VARCHAR NOT NULL,
        segment VARCHAR,
        instrument_type VARCHAR,
        PRIMARY KEY (instrument_token, exchange)
      );
      CREATE INDEX IF NOT EXISTS idx_instruments_lookup ON instruments(tradingsymbol, exchange);
      CREATE TABLE IF NOT EXISTS options_instruments (
        underlying VARCHAR NOT NULL,
        expiry_ts BIGINT NOT NULL,
        strike DOUBLE NOT NULL,
        option_type VARCHAR NOT NULL,
        symbol VARCHAR NOT NULL,
        lot_size INTEGER NOT NULL,
        instrument_token BIGINT NOT NULL,
        PRIMARY KEY (underlying, expiry_ts, strike, option_type)
      );
      CREATE INDEX IF NOT EXISTS idx_options_underlying_expiry ON options_instruments(underlying, expiry_ts);
    `);
    return new InstrumentStore(instance, conn);
  }

  async close(): Promise<void> {
    this.conn.closeSync();
    this.instance.closeSync();
  }

  async upsert(rows: Instrument[]): Promise<void> {
    if (rows.length === 0) return;
    const stmt = await this.conn.prepare(`
      INSERT INTO instruments (instrument_token, tradingsymbol, exchange, segment, instrument_type)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (instrument_token, exchange) DO UPDATE SET
        tradingsymbol = EXCLUDED.tradingsymbol,
        segment = EXCLUDED.segment,
        instrument_type = EXCLUDED.instrument_type
    `);
    try {
      for (const r of rows) {
        stmt.bindBigInt(1, BigInt(r.instrumentToken));
        stmt.bindVarchar(2, r.tradingsymbol);
        stmt.bindVarchar(3, r.exchange);
        stmt.bindVarchar(4, r.segment);
        stmt.bindVarchar(5, r.instrumentType);
        await stmt.run();
      }
    } finally {
      stmt.destroySync();
    }
  }

  async resolve(
    tradingsymbol: string,
    exchange = 'NSE',
  ): Promise<{ tradingsymbol: string; instrumentToken: number } | null> {
    const stmt = await this.conn.prepare(
      `SELECT instrument_token FROM instruments WHERE tradingsymbol = $1 AND exchange = $2 LIMIT 1`,
    );
    try {
      stmt.bindVarchar(1, tradingsymbol);
      stmt.bindVarchar(2, exchange);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects() as Array<{ instrument_token: bigint | number }>;
      if (rows.length === 0) return null;
      const tok = rows[0]!.instrument_token;
      return { tradingsymbol, instrumentToken: typeof tok === 'bigint' ? Number(tok) : tok };
    } finally {
      stmt.destroySync();
    }
  }

  async addOption(c: OptionContract): Promise<void> {
    const stmt = await this.conn.prepare(`
      INSERT INTO options_instruments (underlying, expiry_ts, strike, option_type, symbol, lot_size, instrument_token)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (underlying, expiry_ts, strike, option_type) DO UPDATE SET
        symbol = EXCLUDED.symbol,
        lot_size = EXCLUDED.lot_size,
        instrument_token = EXCLUDED.instrument_token
    `);
    try {
      stmt.bindVarchar(1, c.underlying);
      stmt.bindBigInt(2, BigInt(c.expiry.getTime()));
      stmt.bindDouble(3, c.strike);
      stmt.bindVarchar(4, c.optionType);
      stmt.bindVarchar(5, c.symbol);
      stmt.bindInteger(6, c.lotSize);
      stmt.bindBigInt(7, BigInt(c.instrumentToken));
      await stmt.run();
    } finally {
      stmt.destroySync();
    }
  }

  async findOption(
    underlying: Underlying,
    expiry: Date,
    strike: number,
    type: OptionType,
  ): Promise<OptionContract | null> {
    const stmt = await this.conn.prepare(`
      SELECT symbol, lot_size, instrument_token
      FROM options_instruments
      WHERE underlying = $1 AND expiry_ts = $2 AND strike = $3 AND option_type = $4
      LIMIT 1
    `);
    try {
      stmt.bindVarchar(1, underlying);
      stmt.bindBigInt(2, BigInt(expiry.getTime()));
      stmt.bindDouble(3, strike);
      stmt.bindVarchar(4, type);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects() as Array<{
        symbol: string;
        lot_size: number;
        instrument_token: bigint | number;
      }>;
      if (rows.length === 0) return null;
      const r = rows[0]!;
      const tok = r.instrument_token;
      return {
        symbol: r.symbol,
        underlying,
        expiry,
        strike,
        optionType: type,
        lotSize: r.lot_size,
        instrumentToken: typeof tok === 'bigint' ? Number(tok) : tok,
      };
    } finally {
      stmt.destroySync();
    }
  }

  async expiries(underlying: Underlying): Promise<Date[]> {
    const stmt = await this.conn.prepare(
      `SELECT DISTINCT expiry_ts FROM options_instruments WHERE underlying = $1 ORDER BY expiry_ts ASC`,
    );
    try {
      stmt.bindVarchar(1, underlying);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects() as Array<{ expiry_ts: bigint | number }>;
      return rows.map(
        (r) => new Date(typeof r.expiry_ts === 'bigint' ? Number(r.expiry_ts) : r.expiry_ts),
      );
    } finally {
      stmt.destroySync();
    }
  }
}
