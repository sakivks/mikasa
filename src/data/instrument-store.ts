import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

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
}
