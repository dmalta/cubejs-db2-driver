import { describe, expect, it } from 'vitest';

import { buildRowRenamer, MAX_COLUMN_NAME_BYTES, shortenLongIdentifiers, shortIdentifier } from '../../src/aliases';
import { labeledDurations } from '../../src/Db2Query';
import { castTimestampOperands, markTimestampOperand, unmarkTimestampOperands } from '../../src/timestampOperands';
import { cases } from '../support/cases';
import { buildSql, Planner, queryFor } from '../support/model';

/** Constructs DB2 (z/OS at V10R1, or both platforms) rejects. */
const FORBIDDEN: [string, RegExp][] = [
  ['Postgres :: cast', /::\s*(timestamp|timestamptz|date|text)/i],
  ['ILIKE', /\bILIKE\b/i],
  ['LIMIT', /\bLIMIT\s+\d/i],
  ['FETCH FIRST ? (parameter)', /FETCH\s+(FIRST|NEXT)\s+\?/i],
  ['VALUES table constructor', /FROM\s*\(\s*VALUES\b/i],
  ['positional GROUP BY', /GROUP BY\s+\d/i],
  ['interval literal', /\binterval\s+'/i],
  ['NOW()', /\bNOW\(\)/i],
  ['WITH RECURSIVE', /WITH\s+RECURSIVE/i],
  ['ISO timestamp with Z', /'\d{4}-\d{2}-\d{2}T[\d:.]+Z'/],
  ['NULLS FIRST/LAST', /NULLS\s+(FIRST|LAST)/i],
];

describe('Db2Query SQL generation', () => {
  for (const planner of ['legacy', 'tesseract'] as Planner[]) {
    describe(planner, () => {
      for (const c of cases()) {
        it(c.name, async () => {
          const [sql, params] = await buildSql(c.query, planner);
          for (const [label, pattern] of FORBIDDEN) {
            expect(sql, `${label} in:\n${sql}`).not.toMatch(pattern);
          }
          for (const p of params) {
            expect(String(p)).not.toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
          }
        });
      }
    });
  }

  it('renders refresh keys with a FROM clause and a UTC unix timestamp', async () => {
    const query = await queryFor({ measures: ['orders.count'] }, 'legacy');
    const [[sql]] = query.cacheKeyQueries();
    expect(sql).toMatch(/^SELECT FLOOR\(.*\) AS "refresh_key" FROM SYSIBM\.SYSDUMMY1$/s);
    expect(sql).toContain('CURRENT TIMESTAMP - CURRENT TIMEZONE');
  });

  it('leaves Cube Store refresh keys (rendered through this dialect) without a DB2 FROM clause', async () => {
    const query = await queryFor({ measures: ['orders.count'] }, 'legacy');
    expect(query.refreshKeySelect('FLOOR((UNIX_TIMESTAMP()) / 3600)')).toBe('SELECT FLOOR((UNIX_TIMESTAMP()) / 3600) AS "refresh_key"');
    expect(query.refreshKeySelect(`FLOOR((${query.unixTimestampSql()}) / 3600)`)).toMatch(/FROM SYSIBM\.SYSDUMMY1$/);
  });

  it('shifts timestamps by the zone offset for convertTz', async () => {
    const utc = await queryFor({ measures: ['orders.count'], timezone: 'UTC' }, 'legacy');
    expect(unmarkTimestampOperands(utc.convertTz('x'))).toBe('x');
    const kolkata = await queryFor({ measures: ['orders.count'], timezone: 'Asia/Kolkata' }, 'legacy');
    expect(kolkata.convertTz('x')).toBe('(TIMESTAMP(x) + 330 MINUTES)');
  });

  for (const planner of ['legacy', 'tesseract'] as Planner[]) {
    it(`${planner}: marks time filter columns, so DATE columns can be retried wrapped`, async () => {
      const [sql] = await buildSql({
        measures: ['orders.count'],
        timeDimensions: [{ dimension: 'orders.created_on', granularity: 'month', dateRange: ['2026-01-01', '2026-03-31'] }],
        filters: [
          { member: 'orders.created_at', operator: 'beforeDate', values: ['2026-03-01T00:00:00.000'] },
          { member: 'orders.amount', operator: 'gt', values: ['10'] },
        ],
        timezone: 'UTC',
      }, planner);
      const bare = unmarkTimestampOperands(sql);
      expect(bare).toMatch(/"orders"\.CREATED_ON >= CAST\(\? AS TIMESTAMP\) AND "orders"\.CREATED_ON <= CAST\(\? AS TIMESTAMP\)/);
      expect(bare).toMatch(/"orders"\.CREATED_AT < CAST\(\? AS TIMESTAMP\)/);
      expect(bare).toContain('TRUNC_TIMESTAMP(TIMESTAMP("orders".CREATED_ON), \'MM\')');
      const cast = castTimestampOperands(sql);
      expect(cast).toMatch(/TIMESTAMP\("orders"\.CREATED_ON\) >= CAST\(\? AS TIMESTAMP\)/);
      expect(cast).toMatch(/TIMESTAMP\("orders"\.CREATED_AT\) < CAST\(\? AS TIMESTAMP\)/);
      // Number filters share Tesseract's comparison templates; they are not marked.
      expect(cast).toMatch(/"orders"\.AMOUNT > \?/);
    });
  }

  it('builds FETCH FIRST / OFFSET clauses with literal counts', async () => {
    const q = await queryFor({ measures: ['orders.count'] }, 'legacy');
    expect(q.limitOffsetClause(10, null)).toBe(' FETCH FIRST 10 ROWS ONLY');
    expect(q.limitOffsetClause(10, 5)).toBe(' OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY');
    expect(q.limitOffsetClause(null, 5)).toBe(' OFFSET 5 ROWS');
    expect(q.limitOffsetClause(null, null)).toBe('');
  });
});

describe('time dimension operand markers', () => {
  it('unmarks or wraps marked operands, innermost first', () => {
    const inner = markTimestampOperand('"t".D');
    const sql = `SELECT ${markTimestampOperand(`TRUNC_TIMESTAMP(${inner}, 'MM')`)} FROM t WHERE ${inner} >= CAST(? AS TIMESTAMP)`;
    expect(unmarkTimestampOperands(sql)).toBe('SELECT TRUNC_TIMESTAMP("t".D, \'MM\') FROM t WHERE "t".D >= CAST(? AS TIMESTAMP)');
    expect(castTimestampOperands(sql))
      .toBe('SELECT TIMESTAMP(TRUNC_TIMESTAMP(TIMESTAMP("t".D), \'MM\')) FROM t WHERE TIMESTAMP("t".D) >= CAST(? AS TIMESTAMP)');
  });
});

describe('labeledDurations', () => {
  it.each([
    ['1 day', '+', '(x + 1 DAYS)'],
    ['7 day', '-', '(x - 7 DAYS)'],
    ['1 year 2 months', '+', '(x + 1 YEARS + 2 MONTHS)'],
    ['2 weeks', '+', '(x + 14 DAYS)'],
    ['1 quarter', '-', '(x - 3 MONTHS)'],
    ['3 hours 30 minutes', '+', '(x + 3 HOURS + 30 MINUTES)'],
  ])('%s %s', (interval, sign, expected) => {
    expect(labeledDurations('x', interval, sign as '+' | '-')).toBe(expected);
  });
});

describe('alias shortening for the z/OS 30-byte column-name limit', () => {
  const long = 'orders__a_measure_with_a_really_quite_long_name_for_aliases';

  it('produces deterministic, distinct 30-byte names', () => {
    const s = shortIdentifier(long);
    expect(Buffer.byteLength(s)).toBe(MAX_COLUMN_NAME_BYTES);
    expect(shortIdentifier(long)).toBe(s);
    expect(shortIdentifier(`${long}_2`)).not.toBe(s);
  });

  it('rewrites every occurrence of a long alias, and maps result columns back', () => {
    const sql = `SELECT sum(x) "${long}", "q"."${long}" AS "b" FROM t AS "q" ORDER BY "${long}"`;
    const { sql: out, restore } = shortenLongIdentifiers(sql);
    const short = shortIdentifier(long);
    expect(out).toBe(`SELECT sum(x) "${short}", "q"."${short}" AS "b" FROM t AS "q" ORDER BY "${short}"`);
    expect(buildRowRenamer(restore)!({ [short]: 1, b: 2 })).toEqual({ [long]: 1, b: 2 });
  });

  it('leaves table and index names alone (they may be 128 bytes)', () => {
    const table = 'orders_main_rollup20260922_hk3u2d1p_bqqvuzbz_1kdl3m9';
    const sql = `INSERT INTO "preaggs"."${table}" SELECT * FROM "${table}" JOIN "s"."${table}" ON 1 = 1`;
    expect(shortenLongIdentifiers(sql)).toEqual({ sql, restore: new Map() });
    const ddl = `CREATE INDEX "preaggs"."${table}_idx" ON "preaggs"."${table}" ("${long}")`;
    expect(shortenLongIdentifiers(ddl).sql).toBe(`CREATE INDEX "preaggs"."${table}_idx" ON "preaggs"."${table}" ("${shortIdentifier(long)}")`);
  });

  it('ignores string literals and short names, and leaves SQL without long names untouched', () => {
    const sql = `SELECT '"${long}"' AS "a", "short" FROM t`;
    expect(shortenLongIdentifiers(sql)).toEqual({ sql, restore: new Map() });
  });
});
