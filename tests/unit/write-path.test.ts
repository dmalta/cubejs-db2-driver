import { afterEach, describe, expect, it } from 'vitest';

import { columnDefinitionType, Db2Driver, foldIdentifier } from '../../src/Db2Driver';
import type { Db2ColumnMetadata } from '../../src/ibm';
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
  await driver?.release();
  driver = null;
  setIbmDbModule(null);
});

const meta = (name: string, type: string, length: number, scale = 0): Db2ColumnMetadata => ({
  ...(col(name, type) as Db2ColumnMetadata), SQL_DESC_LENGTH: length, SQL_DESC_SCALE: scale, SQL_DESC_PRECISION: 0,
});

describe('loadPreAggregationIntoTable', () => {
  const table = 'dev_pre_aggregations.orders_main_abc_def_1700000000';
  const select = 'SELECT "o".STATUS "orders__status", count(*) "orders__count" FROM T AS "o" WHERE "o".TS >= CAST(? AS TIMESTAMP) GROUP BY "o".STATUS';

  it('describes the select, creates explicit columns in the configured tablespace, then INSERT ... SELECT', async () => {
    const { driver: d, connections } = makeDriver(
      (sql) => (sql.includes('WHERE 1 = 0')
        ? { meta: [meta('orders__status', 'VARCHAR', 40), meta('orders__count', 'INTEGER', 11), meta('orders__total', 'DECIMAL', 33, 2)] }
        : { meta: [] }),
      { preAggregationDatabase: 'DB1', preAggregationTablespace: 'TS1' }
    );

    await d.loadPreAggregationIntoTable(table, `CREATE TABLE ${table} AS ${select}`, ['2026-01-01T00:00:00.000'], {});

    const statements = connections.flatMap(c => c.statements);
    expect(statements.map(s => s.sql)).toEqual([
      `SELECT * FROM (${select}) AS "q" WHERE 1 = 0`,
      `CREATE TABLE ${table} ("orders__status" VARCHAR(40), "orders__count" INTEGER, "orders__total" DECIMAL(31,2)) IN DB1.TS1`,
      `INSERT INTO ${table} ${select}`,
    ]);
    expect(statements[0].params).toEqual(['2026-01-01T00:00:00.000']);
    expect(statements[1].params).toEqual([]);
    expect(statements[2].params).toEqual(['2026-01-01T00:00:00.000']);
  });

  it('drops the half-built table when the INSERT fails', async () => {
    const { driver: d, connections } = makeDriver((sql) => {
      if (sql.includes('WHERE 1 = 0')) return { meta: [meta('a', 'INTEGER', 11)] };
      if (sql.startsWith('INSERT')) return { error: db2Error(-302, '22001') };
      return { meta: [] };
    });

    await expect(d.loadPreAggregationIntoTable(table, `CREATE TABLE ${table} AS SELECT 1 AS "a" FROM X`, [], {}))
      .rejects.toMatchObject({ sqlcode: -302 });
    expect(connections.flatMap(c => c.statements).map(s => s.sql).pop()).toBe(`DROP TABLE ${table}`);
  });

  it('keeps the table when the INSERT only warns that NULLs were eliminated (01003)', async () => {
    const { driver: d, connections } = makeDriver((sql) => {
      if (sql.includes('WHERE 1 = 0')) return { meta: [meta('a', 'INTEGER', 11)] };
      if (sql.startsWith('INSERT')) return { error: db2Error(0, '01003') };
      return { meta: [] };
    });

    await expect(d.loadPreAggregationIntoTable(table, `CREATE TABLE ${table} AS SELECT sum(x) AS "a" FROM X`, [], {}))
      .resolves.toEqual([]);
    expect(connections.flatMap(c => c.statements).map(s => s.sql).pop()).toBe(`INSERT INTO ${table} SELECT sum(x) AS "a" FROM X`);
  });

  it('refuses load SQL it does not recognise instead of guessing', async () => {
    const { driver: d } = makeDriver(() => ({ meta: [] }));
    await expect(d.loadPreAggregationIntoTable(table, 'INSERT INTO x SELECT 1', [], {})).rejects.toThrow(/Unexpected pre-aggregation load SQL/);
  });

  it('shortens long column names consistently in the DDL and the INSERT', async () => {
    const long = 'orders__a_measure_with_a_really_quite_long_name_for_aliases';
    const { driver: d, connections } = makeDriver((sql) => (sql.includes('WHERE 1 = 0')
      ? { meta: [meta(sql.match(/"(orders__a_[^"]+)"/)![1], 'DECIMAL', 33, 2)] }
      : { meta: [] }));

    await d.loadPreAggregationIntoTable(table, `CREATE TABLE ${table} AS SELECT sum(x) "${long}" FROM T`, [], {});
    const [, ddl, insert] = connections.flatMap(c => c.statements).map(s => s.sql);
    const short = ddl.match(/\("([^"]+)"/)![1];
    expect(Buffer.byteLength(short)).toBe(30);
    expect(insert).toContain(`"${short}"`);
    expect(ddl).not.toContain(long);
  });
});

describe('table listing and dropping', () => {
  it('folds the schema like DB2 and returns folded table names in lower case', async () => {
    const { driver: d, connections } = makeDriver(() => ({
      meta: [col('table_name', 'VARCHAR')],
      rows: [{ table_name: 'ORDERS_MAIN_ABC_DEF_123' }, { table_name: 'MixedCase' }],
    }));
    expect(await d.getTablesQuery('dev_pre_aggregations')).toEqual([{ table_name: 'orders_main_abc_def_123' }, { table_name: 'MixedCase' }]);
    expect(connections[0].statements[0].params).toEqual(['DEV_PRE_AGGREGATIONS']);
  });

  it('dropTable tolerates a missing table (-204) but not other errors', async () => {
    let code = -204;
    const { driver: d } = makeDriver(() => ({ error: db2Error(code) }));
    await expect(d.dropTable('s.t')).resolves.toEqual([]);
    code = -551;
    await expect(d.dropTable('s.t')).rejects.toMatchObject({ sqlcode: -551 });
  });

  it('stays read-only so Cube Store builds stream out instead of writing temp tables', () => {
    const { driver: d } = makeDriver(() => ({}), { preAggregationDatabase: 'DB1', preAggregationTablespace: 'TS1' });
    expect(d.readOnly()).toBe(true);
  });
});

describe('column definitions from result metadata', () => {
  it.each([
    [meta('a', 'VARCHAR', 40), 'VARCHAR(40)'],
    [meta('a', 'CHAR', 3), 'CHAR(3)'],
    [meta('a', 'DECIMAL', 17, 2), 'DECIMAL(15,2)'],
    [meta('a', 'DECIMAL', 6, 0), 'DECIMAL(5,0)'],
    [meta('a', 'DECIMAL', 33, 2), 'DECIMAL(31,2)'],
    [meta('a', 'TIMESTAMP', 26, 6), 'TIMESTAMP(6)'],
    [meta('a', 'INTEGER', 11), 'INTEGER'],
    [meta('a', 'BIGINT', 20), 'BIGINT'],
    [meta('a', 'DOUBLE', 22), 'DOUBLE'],
    [meta('a', 'DATE', 10), 'DATE'],
    [meta('a', 'DECFLOAT', 42), 'DECFLOAT(34)'],
  ])('%j → %s', (m, expected) => {
    expect(columnDefinitionType(m)).toBe(expected);
  });

  it('folds identifiers like DB2', () => {
    expect(foldIdentifier('dev_pre_aggregations')).toBe('DEV_PRE_AGGREGATIONS');
    expect(foldIdentifier('"MySchema"')).toBe('MySchema');
  });
});
