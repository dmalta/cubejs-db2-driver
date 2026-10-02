import type { Db2ColumnMetadata, Db2Connection, Db2Result, IbmDbModule } from '../../src/ibm';

export type Handler = (sql: string, params: unknown[]) => {
  meta?: Partial<Db2ColumnMetadata>[];
  rows?: Record<string, unknown>[];
  error?: Error & { sqlcode?: number; sqlstate?: string };
};

export function db2Error(sqlcode: number, sqlstate = 'XXXXX', message = `SQLCODE ${sqlcode}`) {
  return Object.assign(new Error(message), { sqlcode, sqlstate });
}

export function col(name: string, type: string): Partial<Db2ColumnMetadata> {
  return { SQL_DESC_NAME: name, SQL_DESC_TYPE_NAME: type };
}

export class MockConnection implements Db2Connection {
  public connected = true;

  public closed = false;

  public statements: { sql: string; params: unknown[] }[] = [];

  public resultsClosed = 0;

  public constructor(public readonly id: number, private readonly handler: Handler) {}

  public async queryResult(sql: string, params: unknown[] = []): Promise<[Db2Result | null, unknown]> {
    this.statements.push({ sql, params });
    const out = this.handler(sql, params);
    if (out.error) {
      throw out.error;
    }
    const rows = [...(out.rows || [])].map(r => ({ ...r }));
    const meta = (out.meta || []) as Db2ColumnMetadata[];
    const result: Db2Result = {
      getColumnMetadataSync: () => meta,
      fetchSync: () => rows.shift() || null,
      close: async () => { this.resultsClosed++; return true; },
      closeSync: () => { this.resultsClosed++; },
    };
    return [result, undefined];
  }

  public async query(sql: string, params?: unknown[]) {
    const [r] = await this.queryResult(sql, params);
    const out: Record<string, unknown>[] = [];
    let row;
    while (r && (row = r.fetchSync())) out.push(row);
    return out;
  }

  public prepareSync(): never {
    throw new Error('not mocked');
  }

  public getInfoSync(): string {
    return 'DB2';
  }

  public async beginTransaction() { return true; }

  public async commitTransaction() { return true; }

  public async rollbackTransaction() { return true; }

  public autocommit = false;

  public attrs: [number, unknown][] = [];

  public async setAttr(attr: number, value: number | string | null) {
    this.attrs.push([attr, value]);
    if (attr === 102) this.autocommit = value === 1;
    return true;
  }

  public async close() {
    this.closed = true;
    this.connected = false;
    return true;
  }
}

export function mockIbmDb(handler: Handler) {
  const connections: MockConnection[] = [];
  const dsns: string[] = [];
  const module: IbmDbModule = {
    open: async (dsn: string) => {
      dsns.push(dsn);
      const c = new MockConnection(connections.length + 1, handler);
      connections.push(c);
      return c;
    },
  };
  return { module, connections, dsns };
}

export const baseConfig = {
  host: 'db.example.com',
  port: 446,
  database: 'LOCATION1',
  user: 'user1',
  password: 'secret',
};
