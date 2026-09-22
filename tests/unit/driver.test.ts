import { afterEach, describe, expect, it } from 'vitest';

import { Db2Driver, isReadOnlyStatement, splitTableName, wrapWithFetchFirst } from '../../src/Db2Driver';
import { Db2Query } from '../../src/Db2Query';
import { setIbmDbModule } from '../../src/ibm';
import { baseConfig, col, db2Error, Handler, mockIbmDb } from './mock-ibm';

let driver: Db2Driver | null = null;

function makeDriver(handler: Handler, extra: Record<string, unknown> = {}) {
  const mock = mockIbmDb(handler);
  setIbmDbModule(mock.module);
  driver = new Db2Driver({ ...baseConfig, ...extra });
  return { driver, ...mock };
}

afterEach(async () => {
  if (driver) {
    await driver.release();
    driver = null;
  }
  setIbmDbModule(null);
});

describe('Db2Driver.query', () => {
  it('returns normalized rows, closes the result and reuses the connection', async () => {
    const { driver: d, connections } = makeDriver(() => ({
      meta: [col('name', 'CHAR'), col('ts', 'TIMESTAMP')],
      rows: [{ name: 'ab  ', ts: '2026-01-02 03:04:05.678901' }],
    }));

    expect(await d.query('SELECT 1', [])).toEqual([{ name: 'ab', ts: '2026-01-02T03:04:05.678' }]);
    await d.query('SELECT 2', []);

    expect(connections).toHaveLength(1);
    expect(connections[0].resultsClosed).toBe(2);
    expect(connections[0].statements.map(s => s.sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('passes parameters through', async () => {
    const { driver: d, connections } = makeDriver(() => ({ meta: [], rows: [] }));
    await d.query('SELECT * FROM T WHERE A = ?', ['x']);
    expect(connections[0].statements[0].params).toEqual(['x']);
  });

  it('returns [] for statements without a result set', async () => {
    const { driver: d } = makeDriver(() => ({ meta: [] }));
    expect(await d.query('DROP TABLE X', [])).toEqual([]);
  });

  it('discards the connection after a positive-SQLCODE warning', async () => {
    let n = 0;
    const { driver: d, connections } = makeDriver(() => (n++ === 0 ? { error: db2Error(347, '01605') } : { meta: [col('a', 'INTEGER')], rows: [{ a: 1 }] }));

    await expect(d.query('WITH RECURSIVE_THING', [])).rejects.toMatchObject({ sqlcode: 347 });
    await d.query('SELECT 1', []);

    expect(connections).toHaveLength(2);
    expect(connections[0].closed).toBe(true);
  });

  it('keeps the connection after an ordinary SQL error, and never retries it', async () => {
    const { driver: d, connections } = makeDriver(() => ({ error: db2Error(-204, '42704') }));

    await expect(d.query('SELECT * FROM MISSING', [])).rejects.toThrow(/OBJECT_NOT_FOUND/);
    expect(connections).toHaveLength(1);
    expect(connections[0].statements).toHaveLength(1);
    expect(connections[0].closed).toBe(false);
  });

  it('retries a read-only query once on a fresh connection when the link is lost', async () => {
    let n = 0;
    const { driver: d, connections } = makeDriver(() => (n++ === 0 ? { error: db2Error(-30081, '08001') } : { meta: [col('a', 'INTEGER')], rows: [{ a: 1 }] }));

    expect(await d.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', [])).toEqual([{ a: 1 }]);
    expect(connections).toHaveLength(2);
    expect(connections[0].closed).toBe(true);
  });

  it('does not retry a write when the link is lost', async () => {
    const { driver: d, connections } = makeDriver(() => ({ error: db2Error(-30081, '08001') }));

    await expect(d.query('INSERT INTO T VALUES (1)', [])).rejects.toMatchObject({ sqlcode: -30081 });
    expect(connections).toHaveLength(1);
  });

  it('cancel() disposes the connection instead of returning it to the pool', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(r => { release = r; });
    const mock = mockIbmDb(() => ({ meta: [col('a', 'INTEGER')], rows: [{ a: 1 }] }));
    const open = mock.module.open;
    mock.module.open = async (dsn) => {
      const c = await open(dsn);
      const q = c.queryResult.bind(c);
      c.queryResult = async (s, p) => { await gate; return q(s, p); };
      return c;
    };
    setIbmDbModule(mock.module);
    driver = new Db2Driver(baseConfig);

    const p = driver.query('SELECT 1', []);
    await new Promise(r => setTimeout(r, 10));
    await (p as any).cancel();
    release();
    await p;

    expect(mock.connections[0].closed).toBe(true);
  });
});

describe('Db2Driver.stream', () => {
  it('streams normalized rows, reports types and releases the connection at the end', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: String(i), label: `r${i}  ` }));
    const { driver: d, connections } = makeDriver(() => ({ meta: [col('id', 'BIGINT'), col('label', 'CHAR')], rows }));

    const { rowStream, types, release } = await d.stream('SELECT id, label FROM T', [], { highWaterMark: 4 });
    expect(types).toEqual([{ name: 'id', type: 'bigint' }, { name: 'label', type: 'text' }]);

    const got: any[] = [];
    for await (const row of rowStream as AsyncIterable<any>) {
      got.push(row);
    }
    await release!();

    expect(got).toHaveLength(50);
    expect(got[49]).toEqual({ id: '49', label: 'r49' });
    expect(connections[0].resultsClosed).toBe(1);

    // Connection went back to the pool, not destroyed: next query reuses it.
    await d.query('SELECT 1', []);
    expect(connections).toHaveLength(1);
  });

  it('destroys the connection when the stream is abandoned early', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const { driver: d, connections } = makeDriver(() => ({ meta: [col('id', 'INTEGER')], rows }));

    const { rowStream, release } = await d.stream('SELECT id FROM T', [], { highWaterMark: 2 });
    const iterator = (rowStream as AsyncIterable<any>)[Symbol.asyncIterator]();
    await iterator.next();
    await release!();
    await new Promise(r => setTimeout(r, 10));

    expect(connections[0].closed).toBe(true);
  });

  it('downloadQueryResults uses the stream for streamImport, rows+types otherwise', async () => {
    const { driver: d } = makeDriver(() => ({ meta: [col('n', 'DECIMAL')], rows: [{ n: 1.5 }] }));

    const mem: any = await d.downloadQueryResults('SELECT n FROM T', [], { highWaterMark: 10 } as any);
    expect(mem).toEqual({ rows: [{ n: '1.5' }], types: [{ name: 'n', type: 'decimal' }] });

    const streamed: any = await d.downloadQueryResults('SELECT n FROM T', [], { highWaterMark: 10, streamImport: true } as any);
    expect(streamed.rowStream).toBeDefined();
    await streamed.release();
  });
});

describe('Db2Driver SQL shapes', () => {
  it('wraps limits with FETCH FIRST (LIMIT needs APPLCOMPAT V12R1M500 on z/OS)', () => {
    const { driver: d } = makeDriver(() => ({}));
    const q = { query: 'SELECT a FROM t', limit: 1000 };
    d.wrapQueryWithLimit(q);
    expect(q.query).toBe('SELECT * FROM (SELECT a FROM t) AS "t" FETCH FIRST 1000 ROWS ONLY');
  });

  it('appends FETCH FIRST to CTE queries (z/OS rejects WITH inside a derived table)', () => {
    expect(wrapWithFetchFirst('WITH s AS (SELECT 1 AS n FROM x) SELECT n FROM s', 10))
      .toBe('WITH s AS (SELECT 1 AS n FROM x) SELECT n FROM s FETCH FIRST 10 ROWS ONLY');
    expect(wrapWithFetchFirst('WITH s AS (SELECT 1) SELECT * FROM s ORDER BY 1 FETCH FIRST 50 ROWS ONLY WITH UR;', 10))
      .toBe('WITH s AS (SELECT 1) SELECT * FROM s ORDER BY 1 FETCH FIRST 10 ROWS ONLY WITH UR');
    expect(wrapWithFetchFirst('WITH s AS (SELECT 1) SELECT * FROM s FETCH FIRST 5 ROWS ONLY', 10))
      .toBe('WITH s AS (SELECT 1) SELECT * FROM s FETCH FIRST 5 ROWS ONLY');
  });

  it('reads the catalog through SYSIBM tables that exist on both z/OS and LUW', async () => {
    const { driver: d, connections } = makeDriver(() => ({ meta: [], rows: [] }));
    await d.getSchemas();
    await d.getTablesForSpecificSchemas([{ schema_name: 'APP' }]);
    await d.getColumnsForSpecificTables([{ schema_name: 'APP', table_name: 'T1' }]);
    await d.tablesSchema();

    const sqls = connections[0].statements.map(s => s.sql).join('\n');
    expect(sqls).not.toMatch(/FROM SYSCAT\.|SYSSCHEMATA|information_schema/i);
    expect(sqls).toMatch(/FROM SYSIBM\.SYSTABLES/);
    expect(sqls).toMatch(/c\.TBCREATOR = \? AND c\.TBNAME IN \(\?\)/);
    expect(connections[0].statements[2].params).toEqual(['APP', 'T1']);
  });

  it('resolves table names the way DB2 folds identifiers', async () => {
    expect(splitTableName('app.orders')).toEqual(['APP', 'ORDERS']);
    expect(splitTableName('"app"."my.table"')).toEqual(['app', 'my.table']);
    expect(() => splitTableName('orders')).toThrow();

    const { driver: d, connections } = makeDriver(() => ({ meta: [col('column_name', 'VARCHAR'), col('data_type', 'VARCHAR')], rows: [{ column_name: 'CREATED', data_type: 'TIMESTMP' }] }));
    expect(await d.tableColumnTypes('app.orders')).toEqual([{ name: 'CREATED', type: 'timestamp' }]);
    expect(connections[0].statements[0].params).toEqual(['APP', 'ORDERS']);
  });

  it('classifies read-only statements', () => {
    expect(isReadOnlyStatement('  select 1')).toBe(true);
    expect(isReadOnlyStatement('WITH s AS (SELECT 1) SELECT * FROM s')).toBe(true);
    expect(isReadOnlyStatement('(SELECT 1)')).toBe(true);
    expect(isReadOnlyStatement('INSERT INTO t SELECT 1')).toBe(false);
    expect(isReadOnlyStatement('CREATE TABLE t (a INT)')).toBe(false);
  });

  it('is read-only by default, wires its dialect, and advertises incremental schema loading', () => {
    const { driver: d } = makeDriver(() => ({}));
    expect(d.readOnly()).toBe(true);
    expect(Db2Driver.dialectClass()).toBe(Db2Query);
    expect(Db2Driver.getDefaultConcurrency()).toBe(2);
    expect(d.capabilities()).toEqual({ incrementalSchemaLoading: true });
    expect(d.maskedConnectionString()).toContain('PWD=[REDACTED]');
    expect(Db2Driver.driverEnvVariables()).toContain('CUBEJS_DB_DB2_SSL_SERVER_CERTIFICATE');
  });
});
