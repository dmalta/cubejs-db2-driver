/**
 * @fileoverview Result typing and row normalization.
 *
 * ibm_db returns CHAR/GRAPHIC values blank-padded, TIMESTAMPs as
 * 'YYYY-MM-DD HH:MM:SS.ffffff', DECIMAL/DECFLOAT as (lossy) doubles and
 * BIGINT as strings. Rows are normalized using the result-set metadata, so
 * only genuinely fixed-width columns are trimmed.
 */

import type { Db2ColumnMetadata, Db2Result } from './ibm';

/** ODBC type name → Cube generic type. */
const ODBC_TO_GENERIC: Record<string, string> = {
  BOOLEAN: 'boolean',
  SMALLINT: 'int',
  INTEGER: 'int',
  INT: 'int',
  BIGINT: 'bigint',
  DECIMAL: 'decimal',
  NUMERIC: 'decimal',
  DECFLOAT: 'decimal',
  REAL: 'float',
  FLOAT: 'double',
  DOUBLE: 'double',
  CHAR: 'text',
  CHARACTER: 'text',
  VARCHAR: 'text',
  'LONG VARCHAR': 'text',
  GRAPHIC: 'text',
  VARGRAPHIC: 'text',
  'LONG VARGRAPHIC': 'text',
  CLOB: 'text',
  DBCLOB: 'text',
  XML: 'text',
  DATE: 'date',
  TIME: 'string',
  TIMESTAMP: 'timestamp',
  TIMESTMP: 'timestamp',
  'TIMESTAMP WITH TIME ZONE': 'timestamp',
  TIMESTZ: 'timestamp',
};

/** DB2 catalog `COLTYPE` (SYSIBM.SYSCOLUMNS, space-padded) → Cube generic type. */
const COLTYPE_TO_GENERIC: Record<string, string> = {
  ...ODBC_TO_GENERIC,
  LONGVAR: 'text',
  VARG: 'text',
  LONGVARG: 'text',
  BINARY: 'string',
  VARBIN: 'string',
  VARBINARY: 'string',
  BLOB: 'string',
  ROWID: 'string',
  DISTINCT: 'string',
};

export function odbcTypeToGeneric(typeName: string): string {
  return ODBC_TO_GENERIC[typeName.trim().toUpperCase()] || 'text';
}

/**
 * Maps a DB2 catalog or ODBC type name to a Cube generic type, or undefined
 * when the type is unknown.
 */
export function colTypeToGeneric(colType: string): string | undefined {
  return COLTYPE_TO_GENERIC[colType.trim().toUpperCase()];
}

const FIXED_WIDTH_TYPES = new Set(['CHAR', 'CHARACTER', 'GRAPHIC']);
const DECIMAL_TYPES = new Set(['DECIMAL', 'NUMERIC', 'DECFLOAT']);
const TIMESTAMP_TYPES = new Set(['TIMESTAMP', 'TIMESTMP']);

/**
 * '2026-01-02 13:14:15.123456' → '2026-01-02T13:14:15.123'
 * '2026-01-02 00:00:00'        → '2026-01-02T00:00:00.000'
 */
export function normalizeTimestamp(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T-](\d{2})[:.](\d{2})[:.](\d{2})(?:\.(\d{1,12}))?$/.exec(value);
  if (!m) {
    return value;
  }
  const fraction = (m[5] || '').padEnd(3, '0').slice(0, 3);
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${fraction}`;
}

type Transform = (value: unknown) => unknown;

/**
 * Builds a per-row transform from result-set metadata. Returns null when no
 * column needs transforming, so callers can skip the per-row work.
 */
export function buildRowTransform(meta: Db2ColumnMetadata[]): ((row: Record<string, unknown>) => void) | null {
  const transforms: [string, Transform][] = [];

  for (const column of meta) {
    const type = column.SQL_DESC_TYPE_NAME.toUpperCase();
    const name = column.SQL_DESC_NAME;

    if (FIXED_WIDTH_TYPES.has(type)) {
      transforms.push([name, v => (typeof v === 'string' ? v.trimEnd() : v)]);
    } else if (TIMESTAMP_TYPES.has(type)) {
      transforms.push([name, v => (typeof v === 'string' ? normalizeTimestamp(v) : v)]);
    } else if (DECIMAL_TYPES.has(type)) {
      transforms.push([name, v => (typeof v === 'number' ? String(v) : v)]);
    }
  }

  if (!transforms.length) {
    return null;
  }

  return (row) => {
    for (const [name, fn] of transforms) {
      if (row[name] !== null && row[name] !== undefined) {
        row[name] = fn(row[name]);
      }
    }
  };
}

export function metadataToTypes(meta: Db2ColumnMetadata[]): { name: string; type: string }[] {
  return meta.map(column => ({
    name: column.SQL_DESC_NAME,
    type: odbcTypeToGeneric(column.SQL_DESC_TYPE_NAME),
  }));
}

/** Rows read per synchronous batch before yielding to the event loop. */
export const FETCH_BATCH_SIZE = 500;

export const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * Reads up to `max` rows synchronously. fetchSync() mostly returns rows from
 * the CLI's block-fetch buffer, so a batch is cheap; the async fetch() and
 * fetchAll() pay a thread-pool round trip per call and are far slower
 * (20x on Node 26). Returns `done` when the cursor is exhausted.
 */
export function fetchBatch(result: Db2Result, max: number): { rows: Record<string, unknown>[]; done: boolean } {
  const rows: Record<string, unknown>[] = [];
  while (rows.length < max) {
    const row = result.fetchSync();
    if (!row) {
      return { rows, done: true };
    }
    rows.push(row);
  }
  return { rows, done: false };
}

/**
 * Reads every remaining row, yielding to the event loop between batches.
 */
export async function fetchAllRows(result: Db2Result): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (;;) {
    const { rows, done } = fetchBatch(result, FETCH_BATCH_SIZE);
    for (const row of rows) {
      all.push(row);
    }
    if (done) {
      return all;
    }
    await yieldToEventLoop();
  }
}
