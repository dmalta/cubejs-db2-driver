/**
 * Cube queries against the synthetic model, with the rows each must return.
 * Expected rows are derived from ORDERS / LINE_ITEMS in JS, not hand-typed.
 */
import moment from 'moment-timezone';

import { LINE_ITEMS, ORDERS, Order } from './model';

export type Row = Record<string, unknown>;

export interface Case {
  name: string;
  query: Record<string, unknown>;
  /** Expected rows; compared order-insensitively unless `ordered`. */
  expected?: Row[];
  ordered?: boolean;
  /** Platforms where the query must fail, with the expected SQLCODE. */
  expectError?: { zos?: number; luw?: number };
}

const utc = (s: string) => new Date(`${s.replace(' ', 'T')}Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 23);

export function truncate(d: Date, granularity: string): Date {
  const t = new Date(d.getTime());
  switch (granularity) {
    case 'second': t.setUTCMilliseconds(0); return t;
    case 'minute': t.setUTCSeconds(0, 0); return t;
    case 'hour': t.setUTCMinutes(0, 0, 0); return t;
    case 'day': t.setUTCHours(0, 0, 0, 0); return t;
    case 'week': {
      t.setUTCHours(0, 0, 0, 0);
      const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
      t.setUTCDate(t.getUTCDate() - dow);
      return t;
    }
    case 'month': return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
    case 'quarter': return new Date(Date.UTC(t.getUTCFullYear(), Math.floor(t.getUTCMonth() / 3) * 3, 1));
    case 'year': return new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    case 'half_year': {
      const months = (t.getUTCFullYear() - 2026) * 12 + t.getUTCMonth();
      const bin = Math.floor(months / 6) * 6;
      return new Date(Date.UTC(2026, bin, 1));
    }
    case 'twelve_hours': {
      const origin = Date.UTC(2026, 0, 1);
      const bin = Math.floor((t.getTime() - origin) / (12 * 3600 * 1000));
      return new Date(origin + bin * 12 * 3600 * 1000);
    }
    default: throw new Error(granularity);
  }
}

function groupBy<K>(orders: Order[], key: (o: Order) => K, measures: (os: Order[]) => Row, keyName: string): Row[] {
  const groups = new Map<string, { key: K; items: Order[] }>();
  for (const o of orders) {
    const k = key(o);
    const id = JSON.stringify(k);
    if (!groups.has(id)) groups.set(id, { key: k, items: [] });
    groups.get(id)!.items.push(o);
  }
  return [...groups.values()].map(g => ({ [keyName]: g.key, ...measures(g.items) }));
}

const sum = (os: Order[]) => os.reduce((a, o) => a + o.amount, 0);
const inRange = (o: Order, from: string, to: string) => {
  const t = utc(o.createdAt).getTime();
  return t >= utc(from).getTime() && t <= utc(to).getTime();
};

/** Shift used by Db2Query.convertTz: the zone's offset now (see its caveat). */
export function tzShiftMinutes(tz: string): number {
  return -moment.tz.zone(tz)!.utcOffset(Date.now());
}

export function cases(): Case[] {
  const all = ORDERS;
  const list: Case[] = [];

  // Row order follows the database collation (case-insensitive on some LUW
  // databases), so it is not compared here; the id cases cover ORDER BY.
  list.push({
    name: 'count and sum by status',
    query: { measures: ['orders.count', 'orders.total_amount'], dimensions: ['orders.status'], order: [['orders.status', 'asc']] },
    expected: groupBy(all, o => o.status, os => ({ orders__count: os.length, orders__total_amount: sum(os) }), 'orders__status'),
  });

  for (const g of ['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year', 'half_year', 'twelve_hours']) {
    list.push({
      name: `time dimension granularity ${g}`,
      query: {
        measures: ['orders.count'],
        timeDimensions: [{ dimension: 'orders.created_at', granularity: g, dateRange: ['2026-01-01', '2027-12-31'] }],
        timezone: 'UTC',
      },
      expected: groupBy(all, o => fmt(truncate(utc(o.createdAt), g)), os => ({ orders__count: os.length }), `orders__created_at_${g}`),
    });
  }

  list.push({
    name: 'date range excludes rows outside it',
    query: { measures: ['orders.count'], timeDimensions: [{ dimension: 'orders.created_at', dateRange: ['2026-02-01', '2026-03-31'] }], timezone: 'UTC' },
    expected: [{ orders__count: all.filter(o => inRange(o, '2026-02-01 00:00:00', '2026-03-31 23:59:59.999')).length }],
  });

  for (const tz of ['Asia/Kolkata', 'America/New_York']) {
    const shift = tzShiftMinutes(tz);
    list.push({
      name: `time zone ${tz} (fixed offset)`,
      query: {
        measures: ['orders.count'],
        timeDimensions: [{ dimension: 'orders.created_at', granularity: 'day', dateRange: ['2026-01-01', '2027-12-31'] }],
        timezone: tz,
      },
      expected: groupBy(all, o => fmt(truncate(new Date(utc(o.createdAt).getTime() + shift * 60000), 'day')),
        os => ({ orders__count: os.length }), 'orders__created_at_day'),
    });
  }

  const filterCase = (name: string, filter: Row, pred: (o: Order) => boolean) => list.push({
    name: `filter ${name}`,
    query: { measures: ['orders.count'], filters: [filter] },
    expected: [{ orders__count: all.filter(pred).length }],
  });
  filterCase('equals', { member: 'orders.status', operator: 'equals', values: ['completed'] }, o => o.status === 'completed');
  filterCase('equals (multiple)', { member: 'orders.status', operator: 'equals', values: ['shipped', 'cancelled'] }, o => ['shipped', 'cancelled'].includes(o.status));
  filterCase('notEquals', { member: 'orders.status', operator: 'notEquals', values: ['completed'] }, o => o.status !== 'completed');
  filterCase('contains, case-insensitive', { member: 'orders.status', operator: 'contains', values: ['PLET'] }, o => /plet/i.test(o.status));
  filterCase('notContains', { member: 'orders.status', operator: 'notContains', values: ['e'] }, o => !/e/i.test(o.status));
  filterCase('startsWith', { member: 'orders.status', operator: 'startsWith', values: ['Proc'] }, o => /^proc/i.test(o.status));
  filterCase('endsWith', { member: 'orders.status', operator: 'endsWith', values: ['ED'] }, o => /ed$/i.test(o.status));
  filterCase('contains a literal % (escaped wildcard)', { member: 'orders.status', operator: 'contains', values: ['50%'] }, o => o.status.includes('50%'));
  filterCase('contains a quote', { member: 'orders.status', operator: 'contains', values: ["'"] }, o => o.status.includes("'"));
  filterCase('gt', { member: 'orders.amount', operator: 'gt', values: ['50'] }, o => o.amount > 50);
  filterCase('gte', { member: 'orders.amount', operator: 'gte', values: ['60'] }, o => o.amount >= 60);
  filterCase('lt', { member: 'orders.amount', operator: 'lt', values: ['20'] }, o => o.amount < 20);
  filterCase('lte', { member: 'orders.amount', operator: 'lte', values: ['20'] }, o => o.amount <= 20);
  filterCase('set', { member: 'orders.status', operator: 'set' }, () => true);
  filterCase('notSet', { member: 'orders.status', operator: 'notSet' }, () => false);
  filterCase('inDateRange', { member: 'orders.created_at', operator: 'inDateRange', values: ['2026-01-01', '2026-01-31'] },
    o => inRange(o, '2026-01-01 00:00:00', '2026-01-31 23:59:59.999'));
  filterCase('notInDateRange', { member: 'orders.created_at', operator: 'notInDateRange', values: ['2026-01-01', '2026-01-31'] },
    o => !inRange(o, '2026-01-01 00:00:00', '2026-01-31 23:59:59.999'));
  filterCase('beforeDate', { member: 'orders.created_at', operator: 'beforeDate', values: ['2026-02-01T00:00:00.000'] }, o => utc(o.createdAt) < utc('2026-02-01 00:00:00'));
  // An explicit time: for a bare date the legacy planner compares against the
  // start of the day and Tesseract against its end (Cube behaviour, any dialect).
  filterCase('afterDate', { member: 'orders.created_at', operator: 'afterDate', values: ['2026-12-31T23:30:00.000'] }, o => utc(o.createdAt) > utc('2026-12-31 23:30:00'));
  filterCase('measure filter (HAVING)', { member: 'orders.total_amount', operator: 'gt', values: ['0'] }, () => true);

  list.push({
    name: 'filters combined with OR',
    query: {
      measures: ['orders.count'],
      filters: [{ or: [
        { member: 'orders.status', operator: 'equals', values: ['cancelled'] },
        { member: 'orders.amount', operator: 'gte', values: ['250'] },
      ] }],
    },
    expected: [{ orders__count: all.filter(o => o.status === 'cancelled' || o.amount >= 250).length }],
  });

  list.push({
    name: 'filtered measure, count distinct, avg and max',
    query: { measures: ['orders.completed_count', 'orders.distinct_statuses', 'orders.average_amount', 'orders.max_amount'] },
    expected: [{
      orders__completed_count: all.filter(o => o.status === 'completed').length,
      orders__distinct_statuses: new Set(all.map(o => o.status)).size,
      orders__average_amount: sum(all) / all.length,
      orders__max_amount: Math.max(...all.map(o => o.amount)),
    }],
  });

  list.push({
    name: 'segment',
    query: { measures: ['orders.count'], segments: ['orders.completed'] },
    expected: [{ orders__count: all.filter(o => o.status === 'completed').length }],
  });

  list.push({
    name: 'case dimension',
    query: { measures: ['orders.count'], dimensions: ['orders.size'] },
    expected: groupBy(all, o => (o.amount >= 100 ? 'large' : o.amount >= 30 ? 'medium' : 'small'), os => ({ orders__count: os.length }), 'orders__size'),
  });

  list.push({
    name: 'join to line_items (one_to_many)',
    query: { measures: ['orders.count', 'line_items.total_qty'], dimensions: ['orders.status'] },
    expected: groupBy(all, o => o.status, os => {
      const items = LINE_ITEMS.filter(l => os.some(o => o.id === l.orderId));
      return { orders__count: os.length, line_items__total_qty: items.length ? items.reduce((a, l) => a + l.qty, 0) : null };
    }, 'orders__status'),
  });

  list.push({
    name: 'long member names (> 30-byte aliases)',
    query: {
      measures: ['orders.a_measure_with_a_really_quite_long_name_for_aliases'],
      dimensions: ['orders.a_dimension_with_a_really_quite_long_name_for_aliases'],
    },
    expected: groupBy(all, o => o.status, os => ({ orders__a_measure_with_a_really_quite_long_name_for_aliases: sum(os) }),
      'orders__a_dimension_with_a_really_quite_long_name_for_aliases'),
  });

  const byId = [...all].sort((a, b) => a.id - b.id);
  list.push({
    name: 'limit',
    query: { dimensions: ['orders.id'], order: [['orders.id', 'asc']], limit: 3 },
    expected: byId.slice(0, 3).map(o => ({ orders__id: o.id })),
    ordered: true,
  });
  list.push({
    name: 'limit with offset',
    query: { dimensions: ['orders.id'], order: [['orders.id', 'asc']], limit: 3, offset: 2 },
    expected: byId.slice(2, 5).map(o => ({ orders__id: o.id })),
    ordered: true,
    // OFFSET needs APPLCOMPAT V12R1M500 on z/OS; see docs/db2-validation.md #6.
    expectError: { zos: -4743 },
  });
  list.push({
    name: 'ungrouped',
    query: { dimensions: ['orders.id', 'orders.status'], ungrouped: true, order: [['orders.id', 'asc']], limit: 100 },
    expected: byId.map(o => ({ orders__id: o.id, orders__status: o.status })),
    ordered: true,
  });

  const days = (from: string, to: string) => {
    const out: Date[] = [];
    for (let d = utc(`${from} 00:00:00`); d <= utc(`${to} 00:00:00`); d = new Date(d.getTime() + 86400000)) out.push(d);
    return out;
  };
  list.push({
    name: 'rolling window (7 day trailing)',
    query: {
      measures: ['orders.rolling_amount_7d'],
      timeDimensions: [{ dimension: 'orders.created_at', granularity: 'day', dateRange: ['2026-01-01', '2026-01-15'] }],
      timezone: 'UTC',
    },
    expected: days('2026-01-01', '2026-01-15').map(day => {
      const end = new Date(day.getTime() + 86400000 - 1);
      const start = new Date(end.getTime() - 7 * 86400000);
      const os = all.filter(o => {
        const t = truncate(utc(o.createdAt), 'day').getTime();
        return t > start.getTime() && t <= end.getTime();
      });
      return { orders__created_at_day: fmt(day), orders__rolling_amount_7d: os.length ? sum(os) : null };
    }),
  });
  list.push({
    name: 'rolling window (unbounded running total)',
    query: {
      measures: ['orders.running_total_amount'],
      timeDimensions: [{ dimension: 'orders.created_at', granularity: 'month', dateRange: ['2026-01-01', '2026-04-30'] }],
      timezone: 'UTC',
    },
    expected: ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'].map((m, i, arr) => {
      const next = i + 1 < arr.length ? utc(`${arr[i + 1]} 00:00:00`) : utc('2026-05-01 00:00:00');
      const os = all.filter(o => utc(o.createdAt) < next);
      return { orders__created_at_month: fmt(utc(`${m} 00:00:00`)), orders__running_total_amount: sum(os) };
    }),
  });

  return list;
}

/** Normalizes values for comparison: numeric strings → numbers (rounded), rest unchanged. */
export function normalize(rows: Row[]): Row[] {
  return rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => {
    if (typeof v === 'number') return [k, Math.round(v * 1e6) / 1e6];
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return [k, Math.round(Number(v) * 1e6) / 1e6];
    return [k, v];
  })));
}

export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}
