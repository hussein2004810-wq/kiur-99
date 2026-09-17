import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: {
    duration?: number;
    size_after?: number;
    rows_read?: number;
    rows_written?: number;
    last_row_id?: number;
    changes?: number;
  };
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

export class MockD1PreparedStatement {
  private query: string;
  private params: any[] = [];
  private db: any;

  constructor(db: any, query: string, params: any[] = []) {
    this.db = db;
    this.query = query;
    this.params = params;
  }

  bind(...values: any[]): MockD1PreparedStatement {
    const sanitized = values.map(v => {
      if (v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v;
    });
    return new MockD1PreparedStatement(this.db, this.query, sanitized);
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    try {
      const stmt = this.db.prepare(this.query);
      const row = stmt.get(...this.params) as any;
      if (!row) return null;
      if (colName) return row[colName] ?? null;
      return row as T;
    } catch (err) {
      console.error('D1 first error on query:', this.query, this.params, err);
      throw err;
    }
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    try {
      const stmt = this.db.prepare(this.query);
      const rows = stmt.all(...this.params) as T[];
      return {
        results: rows || [],
        success: true,
        meta: {
          rows_read: rows.length,
          rows_written: 0,
        },
      };
    } catch (err) {
      console.error('D1 all error on query:', this.query, this.params, err);
      throw err;
    }
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    try {
      const stmt = this.db.prepare(this.query);
      const info = stmt.run(...this.params);
      return {
        results: [],
        success: true,
        meta: {
          changes: Number(info.changes),
          last_row_id: Number(info.lastInsertRowid),
          rows_written: Number(info.changes),
        },
      };
    } catch (err) {
      console.error('D1 run error on query:', this.query, this.params, err);
      throw err;
    }
  }

  async raw<T = unknown>(): Promise<T[]> {
    try {
      const stmt = this.db.prepare(this.query);
      stmt.setReturnArrays(true);
      const rows = stmt.all(...this.params) as T[];
      return rows;
    } catch (err) {
      console.error('D1 raw error on query:', this.query, this.params, err);
      throw err;
    }
  }
}

export class MockD1Database {
  public db: any;

  constructor(memory = true) {
    this.db = new DatabaseSync(memory ? ':memory:' : 'test.sqlite');
  }

  prepare(query: string): MockD1PreparedStatement {
    return new MockD1PreparedStatement(this.db, query);
  }

  async batch<T = unknown>(statements: MockD1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      const results: D1Result<T>[] = [];
      for (const stmt of statements) {
        const res = await stmt.run<T>();
        results.push(res);
      }
      this.db.exec('COMMIT;');
      return results;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  async exec(query: string): Promise<D1ExecResult> {
    const startTime = Date.now();
    this.db.exec(query);
    return {
      count: 1,
      duration: Date.now() - startTime,
    };
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }

  close() {
    this.db.close();
  }
}
