/**
 * @fileoverview DB2 SQL dialect for Cube's query planner.
 */

import { BaseQuery } from '@cubejs-backend/schema-compiler';

const GRANULARITY_TO_TRUNC_FORMAT: Record<string, string> = {
  second: 'SS',
  minute: 'MI',
  hour: 'HH',
  day: 'DD',
  week: 'IW',
  month: 'MM',
  quarter: 'Q',
  year: 'YYYY',
};

export class Db2Query extends BaseQuery {
  public convertTz(field: string): string {
    return field;
  }

  public timeGroupedColumn(granularity: string, dimension: string): string {
    const format = GRANULARITY_TO_TRUNC_FORMAT[granularity];
    if (!format) {
      throw new Error(`Granularity "${granularity}" is not supported by the DB2 dialect`);
    }
    return `TRUNC_TIMESTAMP(${dimension}, '${format}')`;
  }
}
