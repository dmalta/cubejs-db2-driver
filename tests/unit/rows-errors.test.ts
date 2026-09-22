import { describe, expect, it } from 'vitest';

import { buildRowTransform, colTypeToGeneric, metadataToTypes, normalizeTimestamp, odbcTypeToGeneric } from '../../src/rows';
import { describeError, isConnectionLost, isLockTimeout, isObjectNotFound, isWarning } from '../../src/errors';
import { col, db2Error } from './mock-ibm';
import type { Db2ColumnMetadata } from '../../src/ibm';

describe('normalizeTimestamp', () => {
  it.each([
    ['2026-01-02 13:14:15.123456', '2026-01-02T13:14:15.123'],
    ['2026-03-19 00:00:00', '2026-03-19T00:00:00.000'],
    ['2026-01-02-13.14.15.1', '2026-01-02T13:14:15.100'],
    ['not a timestamp', 'not a timestamp'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeTimestamp(input)).toBe(expected);
  });
});

describe('buildRowTransform', () => {
  const meta = [
    col('c', 'CHAR'), col('v', 'VARCHAR'), col('t', 'TIMESTAMP'), col('d', 'DECIMAL'), col('i', 'INTEGER'),
  ] as Db2ColumnMetadata[];

  it('trims CHAR only, normalizes timestamps, stringifies decimals', () => {
    const row = { c: 'ab   ', v: 'ab   ', t: '2026-01-02 13:14:15.123456', d: 345.43, i: 7 };
    buildRowTransform(meta)!(row);
    expect(row).toEqual({ c: 'ab', v: 'ab   ', t: '2026-01-02T13:14:15.123', d: '345.43', i: 7 });
  });

  it('leaves nulls alone', () => {
    const row = { c: null, v: null, t: null, d: null, i: null };
    buildRowTransform(meta)!(row);
    expect(row).toEqual({ c: null, v: null, t: null, d: null, i: null });
  });

  it('returns null when no column needs work', () => {
    expect(buildRowTransform([col('i', 'INTEGER')] as Db2ColumnMetadata[])).toBeNull();
  });
});

describe('type mapping', () => {
  it('maps ODBC result types', () => {
    expect(metadataToTypes([col('a', 'BIGINT'), col('b', 'TIMESTAMP'), col('c', 'CHAR'), col('d', 'DECFLOAT')] as Db2ColumnMetadata[]))
      .toEqual([{ name: 'a', type: 'bigint' }, { name: 'b', type: 'timestamp' }, { name: 'c', type: 'text' }, { name: 'd', type: 'decimal' }]);
    expect(odbcTypeToGeneric('SOMETHING_NEW')).toBe('text');
  });

  it('maps space-padded catalog COLTYPEs', () => {
    expect(colTypeToGeneric('TIMESTMP')).toBe('timestamp');
    expect(colTypeToGeneric('CHAR    ')).toBe('text');
    expect(colTypeToGeneric('FLOAT   ')).toBe('double');
    expect(colTypeToGeneric('LONGVAR ')).toBe('text');
    expect(colTypeToGeneric('UNKNOWN')).toBeUndefined();
  });
});

describe('errors', () => {
  it('classifies by sqlcode / sqlstate', () => {
    expect(isConnectionLost(db2Error(-30081, '08001'))).toBe(true);
    expect(isConnectionLost(db2Error(-99999, '08003'))).toBe(true);
    expect(isConnectionLost(db2Error(-204, '42704'))).toBe(false);
    expect(isWarning(db2Error(347, '01605'))).toBe(true);
    expect(isWarning(db2Error(100, '02000'))).toBe(false);
    expect(isWarning(db2Error(-104))).toBe(false);
    expect(isLockTimeout(db2Error(-913))).toBe(true);
    expect(isObjectNotFound(db2Error(-204))).toBe(true);
  });

  it('prefixes the SQLCODE name and adds remediation for licensing and APPLCOMPAT', () => {
    expect(describeError(db2Error(-204)).message).toMatch(/^\[OBJECT_NOT_FOUND\]/);
    expect(describeError(db2Error(-1598)).message).toMatch(/license file whose version matches the clidriver/);
    expect(describeError(db2Error(-4743)).message).toMatch(/CUBEJS_DB_DB2_CURRENT_PACKAGE_SET/);
  });

  it('is idempotent and keeps sqlcode', () => {
    const e = describeError(describeError(db2Error(-204)));
    expect(e.message.match(/OBJECT_NOT_FOUND/g)).toHaveLength(1);
    expect(e.sqlcode).toBe(-204);
  });
});
