/**
 * @fileoverview DB2 SQL dialect for Cube's query planners.
 *
 * Targets SQL that works on DB2 for z/OS at application compatibility V10R1
 * and on DB2 LUW 11.x alike: no LIMIT/OFFSET
 * keywords, no VALUES table constructor, no positional GROUP BY, no
 * parameter markers in DDL or select lists, and timestamps without a 'Z'.
 *
 * A time dimension may be a DATE column, which z/OS won't compare with a
 * TIMESTAMP: expressions that already hide the column wrap it in TIMESTAMP(),
 * and compared columns are marked for the driver (see timestampOperands.ts).
 */

import { BaseFilter, BaseQuery, UserError } from '@cubejs-backend/schema-compiler';
import { getEnv, MAX_SOURCE_ROW_LIMIT, parseSqlInterval, QueryAlias } from '@cubejs-backend/shared';
import moment from 'moment-timezone';

import { markedColumnTemplate, markedComparisonTemplate, markTimestampOperand } from './timestampOperands';

const DUMMY = 'SYSIBM.SYSDUMMY1';

/** Granularity → TRUNC_TIMESTAMP format (IW = ISO week, starting Monday). */
const GRANULARITY_TO_TRUNC_FORMAT: Record<string, string> = {
  minute: 'MI',
  hour: 'HH',
  day: 'DD',
  week: 'IW',
  month: 'MM',
  quarter: 'Q',
  year: 'YYYY',
};

/** Parsed interval part → DB2 labeled-duration unit. Weeks and quarters are folded in. */
const LABELED_DURATIONS: [string, string, number][] = [
  ['year', 'YEARS', 1],
  ['quarter', 'MONTHS', 3],
  ['month', 'MONTHS', 1],
  ['week', 'DAYS', 7],
  ['day', 'DAYS', 1],
  ['hour', 'HOURS', 1],
  ['minute', 'MINUTES', 1],
  ['second', 'SECONDS', 1],
];

/**
 * `(<expr> + 1 YEARS + 2 MONTHS)` for an interval such as '1 year 2 months'.
 */
export function labeledDurations(expr: string, interval: string, sign: '+' | '-'): string {
  const parsed = parseSqlInterval(interval) as Record<string, number | undefined>;
  const totals = new Map<string, number>();
  for (const [part, unit, factor] of LABELED_DURATIONS) {
    const value = parsed[part];
    if (value) {
      totals.set(unit, (totals.get(unit) || 0) + value * factor);
    }
  }
  if (!totals.size) {
    return expr;
  }
  return `(${expr}${[...totals].map(([unit, value]) => ` ${sign} ${value} ${unit}`).join('')})`;
}

/** Seconds between two timestamps; BIGINT so it doesn't overflow for long spans. */
function secondsBetween(from: string, to: string): string {
  return `((CAST(DAYS(${to}) AS BIGINT) - DAYS(${from})) * 86400 + (MIDNIGHT_SECONDS(${to}) - MIDNIGHT_SECONDS(${from})))`;
}

/** Whole months between two timestamps, rounded down. */
function monthsBetween(from: string, to: string): string {
  return `((YEAR(${to}) - YEAR(${from})) * 12 + MONTH(${to}) - MONTH(${from})` +
    ` - CASE WHEN ${to} < ${from} + ((YEAR(${to}) - YEAR(${from})) * 12 + MONTH(${to}) - MONTH(${from})) MONTHS THEN 1 ELSE 0 END)`;
}

class Db2Filter extends BaseFilter {
  /**
   * DB2 has no ILIKE; compare upper-cased values. The ESCAPE clause makes the
   * backslash escaping of % and _ (escapeWildcardChars) effective.
   */
  public likeIgnoreCase(column: string, not: boolean, param: unknown, type: string): string {
    const p = (!type || type === 'contains' || type === 'ends') ? '\'%\' || ' : '';
    const s = (!type || type === 'contains' || type === 'starts') ? ' || \'%\'' : '';
    return `UPPER(${column})${not ? ' NOT' : ''} LIKE UPPER(${p}${this.allocateParam(param)}${s}) ESCAPE '\\'`;
  }
}

export class Db2Query extends BaseQuery {
  public newFilter(filter: unknown) {
    return new Db2Filter(this, filter);
  }

  // ------------------------------------------------------------- timestamps

  /**
   * DB2 rejects the trailing 'Z' of ISO-8601 in timestamp strings
   * (SQLCODE -180 / -20497), so params are rendered without it.
   */
  public timestampFormat(): string {
    return 'YYYY-MM-DDTHH:mm:ss.SSS';
  }

  public timeStampCast(value: string): string {
    return `CAST(${value} AS TIMESTAMP)`;
  }

  public dateTimeCast(value: string): string {
    return `CAST(${value} AS TIMESTAMP)`;
  }

  public timeRangeFilter(dimensionSql: string, from: string, to: string): string {
    return super.timeRangeFilter(markTimestampOperand(dimensionSql), from, to);
  }

  public timeNotInRangeFilter(dimensionSql: string, from: string, to: string): string {
    return super.timeNotInRangeFilter(markTimestampOperand(dimensionSql), from, to);
  }

  public beforeDateFilter(dimensionSql: string, param: string): string {
    return super.beforeDateFilter(markTimestampOperand(dimensionSql), param);
  }

  public beforeOrOnDateFilter(dimensionSql: string, param: string): string {
    return super.beforeOrOnDateFilter(markTimestampOperand(dimensionSql), param);
  }

  public afterDateFilter(dimensionSql: string, param: string): string {
    return super.afterDateFilter(markTimestampOperand(dimensionSql), param);
  }

  public afterOrOnDateFilter(dimensionSql: string, param: string): string {
    return super.afterOrOnDateFilter(markTimestampOperand(dimensionSql), param);
  }

  /**
   * DB2 for z/OS has no time zone database. Timestamps are shifted by the
   * query time zone's current UTC offset: exact for fixed-offset zones, and
   * off by the DST difference for rows on the other side of a transition.
   * Unshifted, the field is marked: the legacy planner compares it in rolling
   * window joins.
   */
  public convertTz(field: string): string {
    const minutes = this.timezoneOffsetMinutes();
    if (!minutes) {
      return markTimestampOperand(field);
    }
    return `(TIMESTAMP(${field}) ${minutes > 0 ? '+' : '-'} ${Math.abs(minutes)} MINUTES)`;
  }

  protected timezoneOffsetMinutes(): number {
    const tz = this.timezone;
    if (!tz || tz === 'UTC' || tz === 'Etc/UTC') {
      return 0;
    }
    const zone = moment.tz.zone(tz);
    if (!zone) {
      throw new UserError(`Unknown time zone: ${tz}`);
    }
    // moment's utcOffset is minutes *behind* UTC.
    return -zone.utcOffset(Date.now());
  }

  public timeGroupedColumn(granularity: string, dimension: string): string {
    if (!granularity) {
      return dimension;
    }
    const ts = `TIMESTAMP(${dimension})`;
    if (granularity === 'second') {
      return `(${ts} - MICROSECOND(${ts}) MICROSECONDS)`;
    }
    const format = GRANULARITY_TO_TRUNC_FORMAT[granularity];
    if (!format) {
      throw new UserError(`Granularity "${granularity}" is not supported by the DB2 dialect`);
    }
    return `TRUNC_TIMESTAMP(${ts}, '${format}')`;
  }

  /**
   * Custom granularities: bins of whole months, or of a fixed number of
   * seconds, counted from the origin.
   */
  public dateBin(interval: string, source: string, origin: string): string {
    const parsed = parseSqlInterval(interval) as Record<string, number | undefined>;
    const months = (parsed.year || 0) * 12 + (parsed.quarter || 0) * 3 + (parsed.month || 0);
    const seconds = (parsed.week || 0) * 604800 + (parsed.day || 0) * 86400 +
      (parsed.hour || 0) * 3600 + (parsed.minute || 0) * 60 + (parsed.second || 0);
    const originTs = `CAST('${origin.replace(/Z$/, '')}' AS TIMESTAMP)`;
    const sourceTs = `TIMESTAMP(${source})`;

    if (months > 0 && seconds === 0) {
      return `(${originTs} + (FLOOR(CAST(${monthsBetween(originTs, sourceTs)} AS DOUBLE) / ${months}) * ${months}) MONTHS)`;
    }
    if (seconds > 0 && months === 0) {
      return `(${originTs} + BIGINT(FLOOR(CAST(${secondsBetween(originTs, sourceTs)} AS DOUBLE) / ${seconds}) * ${seconds}) SECONDS)`;
    }
    throw new UserError(`Mixed month and time intervals are not supported for DB2 custom granularities: ${interval}`);
  }

  public addInterval(date: string, interval: string): string {
    return labeledDurations(date, interval, '+');
  }

  public subtractInterval(date: string, interval: string): string {
    return labeledDurations(date, interval, '-');
  }

  /** UTC now: CURRENT TIMESTAMP is server-local time on DB2. */
  public nowTimestampSql(): string {
    return '(CURRENT TIMESTAMP - CURRENT TIMEZONE)';
  }

  public unixTimestampSql(): string {
    const now = this.nowTimestampSql();
    return `((CAST(DAYS(${now}) AS BIGINT) - DAYS('1970-01-01')) * 86400 + MIDNIGHT_SECONDS(${now}))`;
  }

  /**
   * DB2 has no SELECT without FROM. Cube also renders refresh keys meant for
   * Cube Store through this method (with Cube Store's own expression, e.g.
   * UNIX_TIMESTAMP()), so the FROM clause is added only to DB2 expressions:
   * those are all built on CURRENT TIMESTAMP (see nowTimestampSql).
   */
  public refreshKeySelect(sql: string): string {
    const select = `SELECT ${sql} AS ${this.escapeColumnName('refresh_key')}`;
    return /\bCURRENT\s+TIMESTAMP\b/i.test(sql) ? `${select} FROM ${DUMMY}` : select;
  }

  /**
   * Time series as UNION ALL rows: z/OS has no VALUES table constructor, and
   * names a union column only when every branch does.
   */
  public seriesSql(timeDimension: any): string {
    const rows = timeDimension.timeSeries().map(([from, to]: [string, string]) => (
      `SELECT CAST('${from}' AS TIMESTAMP) AS ${this.escapeColumnName('date_from')}, ` +
      `CAST('${to}' AS TIMESTAMP) AS ${this.escapeColumnName('date_to')} FROM ${DUMMY}`
    ));
    return rows.join(' UNION ALL ');
  }

  // ----------------------------------------------------------------- strings

  public castToString(sql: string): string {
    return `CAST(${sql} AS VARCHAR(4000))`;
  }

  // ---------------------------------------------------- grouping and limits

  /** DB2 has no positional GROUP BY; group by the select expressions. */
  public groupByClause(): string {
    if (this.ungrouped) {
      return '';
    }
    const columns = this.dimensionsForSelect()
      .map((d: any) => d.selectColumns() && d.dimensionSql())
      .flat()
      .filter((s: string | null) => !!s);
    return columns.length ? ` GROUP BY ${columns.join(', ')}` : '';
  }

  public aggregateSubQueryGroupByClause(): string {
    const columns = this.dimensionColumns(this.escapeColumnName(QueryAlias.AGG_SUB_QUERY_KEYS));
    return columns.length ? ` GROUP BY ${columns.join(', ')}` : '';
  }

  public overTimeSeriesSelect(
    cumulativeMeasures: unknown[],
    dateSeriesSql: string,
    baseQuery: string,
    dateJoinConditionSql: string,
    baseQueryAlias: string,
    dateSeriesGranularity?: string
  ): string {
    const forSelect = this.overTimeSeriesForSelect(cumulativeMeasures, dateSeriesGranularity);
    // Group by exactly what dateSeriesSelectColumn selects.
    const timeColumns = this.timeDimensions
      .filter((t: any) => t.granularityObj)
      .map((t: any) => {
        const dateFrom = `${t.dateSeriesAliasName()}.${this.escapeColumnName('date_from')}`;
        return dateSeriesGranularity && t.granularityObj.granularity !== dateSeriesGranularity
          ? this.dimensionTimeGroupedColumn(dateFrom, t.granularityObj)
          : dateFrom;
      });
    const dimensionColumns = this.dimensions
      .map((d: any) => d.selectColumns() && d.dimensionSql() && d.aliasName())
      .flat()
      .filter((s: string | null) => !!s);
    const groupBy = timeColumns.concat(dimensionColumns);
    return `SELECT ${forSelect} FROM ${dateSeriesSql}` +
      ` LEFT JOIN (${baseQuery}) ${this.asSyntaxJoin} ${baseQueryAlias} ON ${dateJoinConditionSql}` +
      (groupBy.length ? ` GROUP BY ${groupBy.join(', ')}` : '');
  }

  /**
   * FETCH FIRST with a literal row count. Cube passes its maximum source row
   * limit as a bind parameter, but z/OS at V10R1 rejects FETCH FIRST ? (and
   * LIMIT / OFFSET altogether, SQLCODE -4743). OFFSET is emitted in the
   * standard form: it works on LUW, and on z/OS once the driver packages run
   * at APPLCOMPAT V12R1M500 or later.
   */
  public groupByDimensionLimit(): string {
    let limit: number | null = null;
    if (this.rowLimit !== null) {
      if (this.rowLimit === MAX_SOURCE_ROW_LIMIT) {
        limit = getEnv('maxSourceRowLimit');
      } else if (typeof this.rowLimit === 'number') {
        limit = this.rowLimit;
      }
    }
    const offset = this.offset ? parseInt(this.offset, 10) : null;
    return this.limitOffsetClause(limit, offset);
  }

  public limitOffsetClause(limit: number | null, offset: number | null): string {
    if (offset) {
      return ` OFFSET ${offset} ROWS${limit != null ? ` FETCH NEXT ${limit} ROWS ONLY` : ''}`;
    }
    return limit != null ? ` FETCH FIRST ${limit} ROWS ONLY` : '';
  }

  public preAggregationPreviewSql(tableName: string) {
    return this.paramAllocator.buildSqlAndParams(`SELECT * FROM ${tableName} FETCH FIRST 1000 ROWS ONLY`);
  }

  // ---------------------------------------------------------- SQL templates

  /**
   * Templates for the Tesseract planner and SQL API push-down.
   */
  public sqlTemplates() {
    const templates = super.sqlTemplates();

    templates.functions.UTCTIMESTAMP = '(CURRENT TIMESTAMP - CURRENT TIMEZONE)';
    templates.functions.ROUND = 'ROUND({{ args_concat }}{% if args | length < 2 %}, 0{% endif %})';
    templates.functions.STDDEV_POP = 'STDDEV({{ args_concat }})';
    templates.functions.VAR_POP = 'VARIANCE({{ args_concat }})';
    templates.functions.VAR_SAMP = 'VARIANCE_SAMP({{ args_concat }})';
    templates.functions.COVAR_POP = 'COVARIANCE({{ args_concat }})';
    templates.functions.COVAR_SAMP = 'COVARIANCE_SAMP({{ args_concat }})';
    templates.functions.BTRIM = 'TRIM({{ args_concat }})';
    templates.functions.SUBSTR = 'SUBSTR({{ args_concat }})';
    templates.functions.CHARACTERLENGTH = 'LENGTH({{ args[0] }})';
    templates.functions.STRPOS = 'LOCATE({{ args[1] }}, {{ args[0] }})';
    // Postgres LOG is base 10; DB2's LOG is the natural logarithm.
    templates.functions.LOG = 'LOG10({{ args_concat }})';
    // Not available on z/OS at V10R1 (LISTAGG, PERCENTILE_CONT need V12 function levels).
    delete templates.functions.STRING_AGG;
    delete templates.functions.PERCENTILECONT;
    delete templates.functions.WIDTH_BUCKET;
    delete templates.functions.NTH_VALUE;
    delete templates.functions.DATEDIFF;

    templates.statements.select = '{% if ctes %}WITH\n' +
      '{{ ctes | join(\',\n\') }}\n' +
      '{% endif %}' +
      'SELECT {% if distinct %}DISTINCT {% endif %}' +
      '{{ select_concat | map(attribute=\'aliased\') | join(\', \') }} {% if from %}\n' +
      'FROM (\n' +
      '{{ from | indent(2, true) }}\n' +
      ') AS {{ from_alias }}{% elif from_prepared %}\n' +
      'FROM {{ from_prepared }}' +
      '{% else %}\nFROM SYSIBM.SYSDUMMY1' +
      '{% endif %}' +
      '{% for join in joins %}\n{{ join }}{% endfor %}' +
      '{% if filter %}\nWHERE {{ filter }}{% endif %}' +
      '{% if group_by %}\nGROUP BY {{ group_by }}{% endif %}' +
      '{% if having %}\nHAVING {{ having }}{% endif %}' +
      '{% if order_by %}\nORDER BY {{ order_by | map(attribute=\'expr\') | join(\', \') }}{% endif %}' +
      '{% if offset is not none and offset | int > 0 %}\nOFFSET {{ offset }} ROWS' +
      '{% if limit is not none %} FETCH NEXT {{ limit }} ROWS ONLY{% endif %}' +
      '{% elif limit is not none %}\nFETCH FIRST {{ limit }} ROWS ONLY{% endif %}';
    templates.statements.union = '{% for query in queries %}(\n' +
      '{{ query | indent(2, true) }}\n' +
      ')' +
      '{% if not loop.last %}\nUNION {% if not distinct %}ALL {% endif %}{% endif %}' +
      '{% endfor %}' +
      '{% if limit is not none %}\nFETCH FIRST {{ limit }} ROWS ONLY{% endif %}';
    templates.statements.group_by_exprs = '{{ group_by | map(attribute=\'expr\') | join(\', \') }}';
    templates.statements.time_series_select =
      '{% for time_item in seria %}' +
      'SELECT CAST(\'{{ time_item[0] }}\' AS TIMESTAMP) AS "date_from", ' +
      'CAST(\'{{ time_item[1] }}\' AS TIMESTAMP) AS "date_to" FROM SYSIBM.SYSDUMMY1' +
      '{% if not loop.last %}\nUNION ALL\n{% endif %}' +
      '{% endfor %}';
    templates.statements.calc_groups_join = '{% if original_sql %}{{ original_sql }}\n{% endif %}' +
      '{% for group in groups %}' +
      '{% if original_sql or not loop.first %}CROSS JOIN\n{% endif %}' +
      '(\n' +
      '{% for value in group.values %}' +
      'SELECT {{ value }} AS {{ group.name }} FROM SYSIBM.SYSDUMMY1' +
      '{% if not loop.last %} UNION ALL\n{% endif %}' +
      '{% endfor %}' +
      ') AS {{ group.alias }}\n' +
      '{% endfor %}';

    templates.filters.time_range_filter = markedColumnTemplate(templates.filters.time_range_filter);
    templates.filters.time_not_in_range_filter = markedColumnTemplate(templates.filters.time_not_in_range_filter);
    templates.filters.gt = markedComparisonTemplate('>');
    templates.filters.gte = markedComparisonTemplate('>=');
    templates.filters.lt = markedComparisonTemplate('<');
    templates.filters.lte = markedComparisonTemplate('<=');

    templates.expressions.like = '{{ expr }} {% if negated %}NOT {% endif %}LIKE {{ pattern }}{% if default_escape %} ESCAPE \'\\\'{% endif %}';
    delete templates.expressions.ilike;
    templates.tesseract.ilike = 'UPPER({{ expr }}) {% if negated %}NOT {% endif %}LIKE UPPER({{ pattern }}) ESCAPE \'\\\'';
    // NULLS FIRST/LAST needs a V12 function level on z/OS; order nulls explicitly.
    templates.expressions.sort = 'CASE WHEN {{ expr }} IS NULL THEN {% if nulls_first %}0{% else %}1{% endif %} ELSE {% if nulls_first %}1{% else %}0{% endif %} END, ' +
      '{{ expr }} {% if asc %}ASC{% else %}DESC{% endif %}';
    templates.expressions.order_by = '{% if index %} {{ index }} {% else %} {{ expr }} {% endif %} {% if asc %}ASC{% else %}DESC{% endif %}';
    // No BOOLEAN literals on z/OS before V13.
    templates.expressions.true = '(1 = 1)';
    templates.expressions.false = '(1 = 0)';
    templates.expressions.add_interval = '{{ date }} + {{ interval }}';
    templates.expressions.sub_interval = '{{ date }} - {{ interval }}';
    templates.expressions.timestamp_literal = 'CAST(\'{{ value | replace("Z", "") }}\' AS TIMESTAMP)';

    templates.types.string = 'VARCHAR(4000)';
    templates.types.boolean = 'SMALLINT';
    templates.types.tinyint = 'SMALLINT';
    templates.types.binary = 'VARBINARY(4000)';
    delete templates.types.interval;

    return templates;
  }
}
