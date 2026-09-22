import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Db2Driver } from '../../src/Db2Driver';
import { REAL, targets } from './env';

const D = 'FROM SYSIBM.SYSDUMMY1';
/** A 1000-row generator with an integer counter: no SQL0347W. */
const THOUSAND_ROWS = `WITH s(i) AS (SELECT 1 ${D} UNION ALL SELECT i + 1 FROM s WHERE i < 1000) SELECT i AS "i", CAST('r' || CAST(i AS VARCHAR(10)) AS CHAR(8)) AS "label" FROM s`;

describe.skipIf(!REAL)('Db2Driver against real DB2', () => {
  for (const target of targets()) {
    describe(`${target.name} (${target.platform})`, () => {
      let driver: Db2Driver;

      beforeAll(() => {
        driver = new Db2Driver(target.config);
      });

      afterAll(async () => {
        await driver?.release();
      });

      it('testConnection()', async () => {
        await driver.testConnection();
      });

      it('query() with parameters, quoted lowercase aliases and normalized values', async () => {
        const rows = await driver.query(
          `SELECT CAST(? AS INTEGER) AS "some_alias",
                  CAST('ab' AS CHAR(5)) AS "chr",
                  CAST('ab' AS VARCHAR(5)) AS "vc",
                  TIMESTAMP('2026-01-02-13.14.15.123456') AS "ts",
                  CAST(345.43 AS DECIMAL(9,3)) AS "dec",
                  CAST(42 AS BIGINT) AS "big",
                  CAST(NULL AS INTEGER) AS "nul"
           ${D} WHERE IBMREQD = ?`,
          [7, 'Y']
        );
        expect(rows).toEqual([{
          some_alias: 7, chr: 'ab', vc: 'ab', ts: '2026-01-02T13:14:15.123', dec: '345.43', big: '42', nul: null,
        }]);
      });

      it('queryWithTypes() reports generic types from result metadata', async () => {
        const { types } = await driver.queryWithTypes(`SELECT CAST(1 AS BIGINT) AS "b", CURRENT TIMESTAMP AS "t", CAST(1 AS DECIMAL(5,2)) AS "d", CAST('x' AS VARCHAR(3)) AS "s" ${D}`);
        expect(types).toEqual([
          { name: 'b', type: 'bigint' }, { name: 't', type: 'timestamp' }, { name: 'd', type: 'decimal' }, { name: 's', type: 'text' },
        ]);
      });

      it('wrapQueryWithLimit() produces SQL the server accepts', async () => {
        const q = { query: THOUSAND_ROWS, limit: 5 };
        driver.wrapQueryWithLimit(q);
        expect(await driver.query(q.query)).toHaveLength(5);
      });

      it('stream() delivers every row with backpressure and returns the connection', async () => {
        const { rowStream, types, release } = await driver.stream(THOUSAND_ROWS, [], { highWaterMark: 16 });
        expect(types).toEqual([{ name: 'i', type: 'int' }, { name: 'label', type: 'text' }]);
        let count = 0;
        let last: any;
        for await (const row of rowStream as AsyncIterable<any>) {
          count++;
          last = row;
        }
        await release!();
        expect(count).toBe(1000);
        expect(last).toEqual({ i: 1000, label: 'r1000' });
        await driver.testConnection();
      });

      it('downloadQueryResults() with streamImport false and true', async () => {
        const mem: any = await driver.downloadQueryResults(THOUSAND_ROWS, [], { highWaterMark: 100 } as any);
        expect(mem.rows).toHaveLength(1000);
        const streamed: any = await driver.downloadQueryResults(THOUSAND_ROWS, [], { highWaterMark: 100, streamImport: true } as any);
        let n = 0;
        for await (const _ of streamed.rowStream) n++;
        await streamed.release();
        expect(n).toBe(1000);
      });

      it('abandoning a stream early does not poison the pool', async () => {
        const { rowStream, release } = await driver.stream(THOUSAND_ROWS, [], { highWaterMark: 4 });
        const it2 = (rowStream as AsyncIterable<any>)[Symbol.asyncIterator]();
        await it2.next();
        await release!();
        await driver.testConnection();
      });

      it('SQL errors carry the SQLCODE name and leave the driver usable', async () => {
        await expect(driver.query('SELECT * FROM SYSIBM.NO_SUCH_TABLE_XYZ')).rejects.toMatchObject({ sqlcode: -204 });
        await driver.testConnection();
      });

      it('positive-SQLCODE warnings surface as errors and the connection is replaced', async () => {
        const unbounded = `WITH s(d) AS (SELECT TIMESTAMP('2026-01-01-00.00.00') ${D} UNION ALL SELECT d + 1 DAYS FROM s WHERE d < TIMESTAMP('2026-01-05-00.00.00')) SELECT d FROM s`;
        await expect(driver.query(unbounded)).rejects.toMatchObject({ sqlcode: 347 });
        await driver.testConnection();
      });

      it('catalog: schemas, tables and columns through SYSIBM', async () => {
        const schemas = await driver.getSchemas();
        expect(schemas.length).toBeGreaterThan(0);
        expect(schemas.map(s => s.schema_name)).not.toContain('SYSIBM');

        const tables = await driver.getTablesForSpecificSchemas([{ schema_name: 'SYSIBM' }]);
        expect(tables).toContainEqual({ schema_name: 'SYSIBM', table_name: 'SYSDUMMY1' });

        const columns = await driver.getColumnsForSpecificTables([{ schema_name: 'SYSIBM', table_name: 'SYSDUMMY1' }]);
        expect(columns).toEqual([expect.objectContaining({ schema_name: 'SYSIBM', table_name: 'SYSDUMMY1', column_name: 'IBMREQD', data_type: 'CHAR', foreign_keys: [] })]);

        expect(await driver.tableColumnTypes('SYSIBM.SYSDUMMY1')).toEqual([{ name: 'IBMREQD', type: 'text' }]);
        // Folded (upper-case) names come back lower-case, as Cube's pre-aggregation loader expects.
        expect(await driver.getTablesQuery('SYSIBM')).toContainEqual({ table_name: 'sysdummy1' });
      });

      it('primary-key catalog query runs (KEYSEQ exists on this platform)', async () => {
        const pks = await (driver as any).primaryKeys("c.TBCREATOR = 'SYSIBM' AND c.TBNAME = 'SYSTABLES'");
        expect(Array.isArray(pks)).toBe(true);
      });

      it('queryColumnTypes() describes a query without fetching rows', async () => {
        expect(await driver.queryColumnTypes(`SELECT CAST(? AS INTEGER) AS "n", CURRENT DATE AS "d" ${D}`, [1]))
          .toEqual([{ name: 'n', type: 'int' }, { name: 'd', type: 'date' }]);
      });

      it('runs concurrent queries on a bounded pool', async () => {
        const results = await Promise.all(Array.from({ length: 6 }, (_, i) => driver.query(`SELECT CAST(? AS INTEGER) AS "n" ${D}`, [i])));
        expect(results.map(r => (r[0] as any).n)).toEqual([0, 1, 2, 3, 4, 5]);
      });
    });
  }
});
