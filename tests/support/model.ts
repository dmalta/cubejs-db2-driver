/**
 * An in-memory Cube data model over synthetic data, for compiling real Cube
 * queries with the Db2Query dialect (both planners) and running them on DB2.
 *
 * The data is a UNION ALL of literal rows from SYSIBM.SYSDUMMY1, so it needs
 * no tables and exists on every DB2 platform. Every UNION branch names its
 * columns: z/OS only names a union column when every branch does.
 */
import { compile } from '@cubejs-backend/schema-compiler';

import { Db2Query } from '../../src/Db2Query';

export interface Order {
  id: number;
  status: string;
  amount: number;
  createdAt: string; // 'YYYY-MM-DD HH:MM:SS' (UTC)
}

export interface LineItem {
  id: number;
  orderId: number;
  product: string;
  qty: number;
}

export const ORDERS: Order[] = [
  { id: 1, status: 'completed', amount: 100.5, createdAt: '2026-01-05 10:30:00' },
  { id: 2, status: 'completed', amount: 20, createdAt: '2026-01-05 23:45:00' },
  { id: 3, status: 'processing', amount: 35.25, createdAt: '2026-01-12 08:00:00' },
  { id: 4, status: 'shipped', amount: 250, createdAt: '2026-02-01 00:00:00' },
  { id: 5, status: 'completed', amount: 75, createdAt: '2026-02-14 12:00:00' },
  { id: 6, status: 'cancelled', amount: 10, createdAt: '2026-03-31 23:59:59' },
  { id: 7, status: 'shipped', amount: 60, createdAt: '2026-04-01 00:00:00' },
  { id: 8, status: 'completed', amount: 42, createdAt: '2026-07-04 16:20:00' },
  { id: 9, status: 'processing', amount: 5, createdAt: '2026-12-31 23:00:00' },
  { id: 10, status: "O'Brien 50% off", amount: 1, createdAt: '2027-01-01 05:00:00' },
];

export const LINE_ITEMS: LineItem[] = [
  { id: 1, orderId: 1, product: 'Widget', qty: 2 },
  { id: 2, orderId: 1, product: 'Gadget', qty: 1 },
  { id: 3, orderId: 2, product: 'Widget', qty: 5 },
  { id: 4, orderId: 4, product: 'Gizmo', qty: 3 },
  { id: 5, orderId: 5, product: 'Widget', qty: 1 },
  { id: 6, orderId: 8, product: 'Gadget', qty: 4 },
];

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ts = (s: string) => `CAST(${q(s.replace(' ', '-').replace(/:/g, '.'))} AS TIMESTAMP)`;

function ordersSql(): string {
  return ORDERS.map(o => `SELECT ${o.id} AS ID, CAST(${q(o.status)} AS VARCHAR(40)) AS STATUS, ` +
    `CAST(${o.amount} AS DECIMAL(10,2)) AS AMOUNT, ${ts(o.createdAt)} AS CREATED_AT FROM SYSIBM.SYSDUMMY1`)
    .join(' UNION ALL ');
}

function lineItemsSql(): string {
  return LINE_ITEMS.map(l => `SELECT ${l.id} AS ID, ${l.orderId} AS ORDER_ID, CAST(${q(l.product)} AS VARCHAR(40)) AS PRODUCT, ` +
    `${l.qty} AS QTY FROM SYSIBM.SYSDUMMY1`)
    .join(' UNION ALL ');
}

export function modelFiles() {
  const model = `
cube('orders', {
  sql: \`${ordersSql()}\`,
  joins: {
    line_items: { relationship: 'one_to_many', sql: \`\${CUBE}.ID = \${line_items}.ORDER_ID\` },
  },
  measures: {
    count: { type: 'count' },
    total_amount: { sql: 'AMOUNT', type: 'sum' },
    average_amount: { sql: 'AMOUNT', type: 'avg' },
    max_amount: { sql: 'AMOUNT', type: 'max' },
    completed_count: { type: 'count', filters: [{ sql: \`\${CUBE}.STATUS = 'completed'\` }] },
    distinct_statuses: { sql: 'STATUS', type: 'count_distinct' },
    rolling_amount_7d: {
      sql: 'AMOUNT', type: 'sum',
      rolling_window: { trailing: '7 day' },
    },
    running_total_amount: {
      sql: 'AMOUNT', type: 'sum',
      rolling_window: { trailing: 'unbounded' },
    },
    a_measure_with_a_really_quite_long_name_for_aliases: { sql: 'AMOUNT', type: 'sum' },
  },
  dimensions: {
    id: { sql: 'ID', type: 'number', primary_key: true, shown: true },
    status: { sql: 'STATUS', type: 'string' },
    amount: { sql: 'AMOUNT', type: 'number' },
    created_at: {
      sql: 'CREATED_AT', type: 'time',
      granularities: {
        half_year: { interval: '6 months', origin: '2026-01-01' },
        twelve_hours: { interval: '12 hours', origin: '2026-01-01' },
      },
    },
    size: {
      type: 'string',
      case: {
        when: [
          { sql: \`\${CUBE}.AMOUNT >= 100\`, label: 'large' },
          { sql: \`\${CUBE}.AMOUNT >= 30\`, label: 'medium' },
        ],
        else: { label: 'small' },
      },
    },
    a_dimension_with_a_really_quite_long_name_for_aliases: { sql: 'STATUS', type: 'string' },
  },
  segments: {
    completed: { sql: \`\${CUBE}.STATUS = 'completed'\` },
  },
});

// Same data as orders, with a pre-aggregation stored in DB2 itself. A
// separate cube, so the dialect cases on \`orders\` never match a rollup.
cube('orders_pa', {
  extends: orders,
  pre_aggregations: {
    by_status_month: {
      type: 'rollup',
      external: false,
      measures: [CUBE.count, CUBE.total_amount, CUBE.a_measure_with_a_really_quite_long_name_for_aliases],
      dimensions: [CUBE.status],
      time_dimension: CUBE.created_at,
      granularity: 'month',
      indexes: {
        by_status: { columns: [CUBE.status] },
      },
    },
  },
});

cube('line_items', {
  sql: \`${lineItemsSql()}\`,
  measures: {
    count: { type: 'count' },
    total_qty: { sql: 'QTY', type: 'sum' },
  },
  dimensions: {
    id: { sql: 'ID', type: 'number', primary_key: true },
    product: { sql: 'PRODUCT', type: 'string' },
  },
});
`;
  return [{ fileName: 'model.js', content: model }];
}

let compiled: Promise<any> | null = null;

export function compilers(): Promise<any> {
  if (!compiled) {
    compiled = compile({
      localPath: () => __dirname,
      dataSchemaFiles: async () => modelFiles(),
    } as any, { adapter: 'db2' });
  }
  return compiled;
}

export type Planner = 'legacy' | 'tesseract';

/**
 * Mirrors the API gateway's normalization (api-gateway query.js): `limit`
 * becomes `rowLimit` (default 10000) and `order` pairs become { id, desc }.
 */
function options(query: Record<string, unknown>, planner: Planner) {
  const order = query.order as [string, string][] | undefined;
  return {
    ...query,
    ...(order ? { order: order.map(([id, direction]) => ({ id, desc: direction === 'desc' })) } : {}),
    rowLimit: query.limit ?? 10000,
    useNativeSqlPlanner: planner === 'tesseract',
  };
}

/**
 * Compiles a Cube query with the DB2 dialect and returns [sql, params].
 */
export async function buildSql(query: Record<string, unknown>, planner: Planner): Promise<[string, unknown[]]> {
  const c = await compilers();
  const dbQuery = new Db2Query(c, options(query, planner));
  return dbQuery.buildSqlAndParams() as [string, unknown[]];
}

/**
 * Builds the query object Cube uses for result mapping (aliasNameToMember).
 */
export async function queryFor(query: Record<string, unknown>, planner: Planner): Promise<any> {
  const c = await compilers();
  return new Db2Query(c, options(query, planner));
}

export interface PreAggregationPlan {
  /** Unversioned table name, e.g. `schema.orders_pa_by_status_month`. */
  tableName: string;
  loadSql: [string, unknown[]];
  indexesSql: { indexName: string; sql: [string, unknown[]] }[];
  /** The query's own SQL, reading from `tableName`. */
  querySql: [string, unknown[]];
}

/**
 * What Cube's orchestrator receives for a query served by a pre-aggregation:
 * its build SQL and the query that reads it.
 */
export async function preAggregationPlan(
  query: Record<string, unknown>,
  planner: Planner,
  preAggregationsSchema: string
): Promise<PreAggregationPlan> {
  const c = await compilers();
  const q = new Db2Query(c, { ...options(query, planner), preAggregationsSchema });
  const [description] = q.preAggregations.preAggregationsDescription();
  if (!description) {
    throw new Error('Query is not served by a pre-aggregation');
  }
  return {
    tableName: description.tableName,
    loadSql: description.loadSql,
    indexesSql: description.indexesSql,
    querySql: q.buildSqlAndParams(),
  };
}
