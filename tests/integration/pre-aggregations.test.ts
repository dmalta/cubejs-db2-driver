import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Db2Driver } from '../../src/Db2Driver';
import { normalize, sortRows } from '../support/cases';
import { ORDERS } from '../support/model';
import { Planner, preAggregationPlan } from '../support/model';
import { REAL, targets } from './env';

const writable = targets().filter(t => t.writeSchema);

/** Mirrors PreAggregations.targetTableName: <table>_<content>_<structure>_<updated>. */
function versioned(name: string, tag: string): string {
  return `${name}_it${tag}_itsv_${Date.now()}`;
}

describe.skipIf(!REAL || !writable.length)('pre-aggregations stored in DB2', () => {
  for (const target of writable) {
    describe(`${target.name} (${target.platform})`, () => {
      const schema = target.writeSchema!.toLowerCase();
      let driver: Db2Driver;
      const created: string[] = [];

      beforeAll(() => {
        driver = new Db2Driver({
          ...target.config,
          preAggregationDatabase: target.preAggregationDatabase,
          preAggregationTablespace: target.preAggregationTablespace,
        });
      });

      afterAll(async () => {
        for (const t of created) {
          await driver.dropTable(t).catch(() => undefined);
        }
        await driver?.release();
      });

      for (const planner of ['legacy', 'tesseract'] as Planner[]) {
        it(`${planner}: build, index, list, query and drop a rollup`, async () => {
          const byStatus = await preAggregationPlan({ measures: ['orders_pa.count', 'orders_pa.total_amount'], dimensions: ['orders_pa.status'] }, planner, schema);
          const target_ = versioned(byStatus.tableName, planner.slice(0, 3));
          created.push(target_);

          await driver.createSchemaIfNotExists(schema);
          const [loadSql, loadParams] = byStatus.loadSql;
          await driver.loadPreAggregationIntoTable(target_, loadSql.replace(byStatus.tableName, target_), loadParams, {});

          for (const { indexName, sql: [indexSql, indexParams] } of byStatus.indexesSql) {
            const versionedIndex = versioned(indexName, planner.slice(0, 3));
            await driver.query(indexSql.split(byStatus.tableName).join(target_).replace(indexName, versionedIndex), indexParams);
          }

          // The loader finds its tables by these names; they must match what it created.
          const listed = (await driver.getTablesQuery(schema)).map(t => `${schema}.${t.table_name}`);
          expect(listed).toContain(target_);
          expect(target_.split('.')[1]).toMatch(/(.+)_(.+)_(.+)_(.+)/);

          const read = async (plan: typeof byStatus) => {
            const [sql, params] = plan.querySql;
            return normalize(await driver.query(sql.split(plan.tableName).join(target_), params));
          };

          const statuses = [...new Set(ORDERS.map(o => o.status))];
          expect(sortRows(await read(byStatus))).toEqual(sortRows(normalize(statuses.map(s => ({
            orders_pa__status: s,
            orders_pa__count: ORDERS.filter(o => o.status === s).length,
            orders_pa__total_amount: ORDERS.filter(o => o.status === s).reduce((a, o) => a + o.amount, 0),
          })))));

          const longNames = await preAggregationPlan({
            measures: ['orders_pa.a_measure_with_a_really_quite_long_name_for_aliases'],
            timeDimensions: [{ dimension: 'orders_pa.created_at', granularity: 'month', dateRange: ['2026-01-01', '2026-03-31'] }],
            timezone: 'UTC',
          }, planner, schema);
          expect(longNames.tableName).toBe(byStatus.tableName);
          const months = ['2026-01', '2026-02', '2026-03'];
          expect(sortRows(await read(longNames))).toEqual(sortRows(normalize(months.map(m => ({
            'orders_pa__created_at_month': `${m}-01T00:00:00.000`,
            'orders_pa__a_measure_with_a_really_quite_long_name_for_aliases':
              ORDERS.filter(o => o.createdAt.startsWith(m)).reduce((a, o) => a + o.amount, 0),
          })))));

          await driver.dropTable(target_);
          await driver.dropTable(target_); // already gone: SQLCODE -204 is tolerated
          const after = (await driver.getTablesQuery(schema)).map(t => `${schema}.${t.table_name}`);
          expect(after).not.toContain(target_);
        });
      }

      it.skipIf(!target.sourceTable)('builds from a real source table (encoding may differ from the target tablespace)', async () => {
        const t = versioned(`${schema}.cube_it_source`, 'src');
        created.push(t);
        const col = target.sourceTimeColumn!;
        const select = `SELECT TRUNC_TIMESTAMP(s.${col}, 'MM') AS "src__month", COUNT(*) AS "src__count" ` +
          `FROM ${target.sourceTable} AS s WHERE s.${col} >= CAST(? AS TIMESTAMP) GROUP BY TRUNC_TIMESTAMP(s.${col}, 'MM')`;
        await driver.loadPreAggregationIntoTable(t, `CREATE TABLE ${t} AS ${select}`, ['2026-01-01T00:00:00.000'], {});
        const direct = normalize(await driver.query(select, ['2026-01-01T00:00:00.000']));
        const fromTable = normalize(await driver.query(`SELECT "src__month", "src__count" FROM ${t}`));
        expect(sortRows(fromTable)).toEqual(sortRows(direct));
        expect(fromTable.length).toBeGreaterThan(0);
        await driver.dropTable(t);
      });
    });
  }
});
