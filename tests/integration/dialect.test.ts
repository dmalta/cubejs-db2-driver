import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Db2Driver } from '../../src/Db2Driver';
import { cases, normalize, sortRows } from '../support/cases';
import { buildSql, Planner, queryFor } from '../support/model';
import { REAL, targets } from './env';

describe.skipIf(!REAL)('Cube queries through the DB2 dialect, on real DB2', () => {
  for (const target of targets()) {
    describe(`${target.name} (${target.platform})`, () => {
      let driver: Db2Driver;

      beforeAll(() => {
        driver = new Db2Driver(target.config);
      });

      afterAll(async () => {
        await driver?.release();
      });

      for (const planner of ['legacy', 'tesseract'] as Planner[]) {
        describe(planner, () => {
          for (const c of cases()) {
            it(c.name, async () => {
              const [sql, params] = await buildSql(c.query, planner);
              const expectedCode = c.expectError?.[target.platform];
              if (expectedCode !== undefined && !target.config.currentPackageSet) {
                await expect(driver.query(sql, params)).rejects.toMatchObject({ sqlcode: expectedCode });
                return;
              }
              let rows: Record<string, unknown>[];
              try {
                rows = await driver.query(sql, params);
              } catch (e) {
                throw new Error(`${(e as Error).message}\n--- SQL:\n${sql}\n--- params: ${JSON.stringify(params)}`);
              }
              const actual = normalize(rows);
              const expected = normalize(c.expected!);
              if (c.ordered) {
                expect(actual).toEqual(expected);
              } else {
                expect(sortRows(actual)).toEqual(sortRows(expected));
              }
            });
          }
        });
      }

      it('refresh key queries run', async () => {
        const query = await queryFor({ measures: ['orders.count'] }, 'legacy');
        for (const [sql, params] of query.cacheKeyQueries()) {
          const rows = await driver.query(sql, params);
          expect(rows).toHaveLength(1);
          expect(Number(Object.values(rows[0])[0])).toBeGreaterThan(0);
        }
      });

      it('unix timestamp matches the client clock (UTC)', async () => {
        const query = await queryFor({ measures: ['orders.count'] }, 'legacy');
        const [row] = await driver.query<{ t: number }>(`SELECT ${query.unixTimestampSql()} AS "t" FROM SYSIBM.SYSDUMMY1`);
        expect(Math.abs(Number(row.t) - Date.now() / 1000)).toBeLessThan(300);
      });
    });
  }
});
