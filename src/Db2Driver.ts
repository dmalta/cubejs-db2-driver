/**
 * @fileoverview Cube driver for IBM DB2 for z/OS and DB2 LUW, over ibm_db.
 */

import {
  BaseDriver,
  createPoolName,
  DownloadQueryResultsOptions,
  DownloadQueryResultsResult,
  DriverCapabilities,
  DriverInterface,
  QueryOptions,
  StreamOptions,
  StreamTableDataWithTypes,
  TableStructure,
} from '@cubejs-backend/base-driver';
import { assertDataSource, getEnv, Pool } from '@cubejs-backend/shared';

import {
  buildConnectionString,
  connectionConfigFromEnv,
  Db2ConnectionConfig,
  DB2_ENV_VARIABLES,
  maskConnectionString,
  readDb2Env,
} from './connection';
import { buildRowRenamer, shortenLongIdentifiers } from './aliases';
import { describeError, isConnectionLost, isIncomparable, isObjectNotFound, isWarning } from './errors';
import { Db2ColumnMetadata, Db2Connection, Db2Result, keepLoopAwake, loadIbmDb } from './ibm';
import { Db2Query } from './Db2Query';
import { closeQuietly, QueryStream } from './QueryStream';
import { buildRowTransform, colTypeToGeneric, fetchAllRows, metadataToTypes } from './rows';
import { castTimestampOperands, hasTimestampOperands, unmarkTimestampOperands } from './timestampOperands';

export type Db2DriverConfiguration = Db2ConnectionConfig & {
  dataSource?: string;
  preAggregations?: boolean;
  maxPoolSize?: number;
  testConnectionTimeout?: number;
  /** Seconds to wait for a TCP/TLS connection. */
  connectTimeout?: number;
  /** Connections older than this are replaced on next borrow (ms). */
  maxConnectionAgeMs?: number;
  /** Idle connections are closed after this long (ms). */
  idleTimeoutMs?: number;
  readOnly?: boolean;
  /** z/OS database for pre-aggregation tables (`IN <database>.<tablespace>`). */
  preAggregationDatabase?: string;
  /** Tablespace for pre-aggregation tables. */
  preAggregationTablespace?: string;
  /**
   * Schemas to introspect (Playground, data model generation). A z/OS catalog
   * can hold tens of thousands of tables; all non-system schemas by default.
   */
  schemas?: string[];
};

interface PooledConnection {
  conn: Db2Connection;
  createdAt: number;
  /** Set when the connection must not be reused (warning-pending handle, lost link, cancel). */
  disposed: boolean;
}

/**
 * Schemas that hold DB2's own catalog and tooling objects, on z/OS or LUW.
 * Listed explicitly: user schemas such as SYSADM are common on z/OS.
 */
const SYSTEM_SCHEMAS = [
  'SYSIBM', 'SYSIBMADM', 'SYSIBMINTERNAL', 'SYSIBMTS', 'SYSCAT', 'SYSSTAT', 'SYSFUN',
  'SYSPROC', 'SYSPUBLIC', 'SYSTOOLS', 'SYSIBM_BACKUP', 'NULLID', 'SQLJ',
];
const SYSTEM_SCHEMA_FILTER = `NOT IN (${SYSTEM_SCHEMAS.map(s => `'${s}'`).join(', ')})`;

/** Table types exposed to Cube: tables and views (aliases would duplicate their targets). */
const TABLE_TYPES = "('T', 'V')";

/** Cube generic type → DB2 column type, for tables Cube creates (uploads, tests). */
const GENERIC_TO_DB2: Record<string, string> = {
  string: 'VARCHAR(4000)',
  text: 'VARCHAR(4000)',
  boolean: 'SMALLINT',
  int: 'INTEGER',
  bigint: 'BIGINT',
  float: 'DOUBLE',
  double: 'DOUBLE',
  decimal: 'DECIMAL(31,10)',
  timestamp: 'TIMESTAMP',
  date: 'DATE',
  time: 'TIME',
  uuid: 'CHAR(36)',
};

const DEFAULT_MAX_CONNECTION_AGE_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

type CancelablePromise<T> = Promise<T> & { cancel?: () => Promise<void> };

/**
 * IBM DB2 driver.
 */
export class Db2Driver extends BaseDriver implements DriverInterface {
  protected readonly config: Db2DriverConfiguration & { dataSource: string; preAggregations: boolean };

  protected readonly pool: Pool<PooledConnection>;

  private readonly connectionString: string;

  /**
   * Returns the dialect class, which Cube picks up as the default dialectFactory.
   */
  public static dialectClass() {
    return Db2Query;
  }

  /**
   * A DB2 subsystem is usually shared; keep the default concurrency low.
   */
  public static getDefaultConcurrency(): number {
    return 2;
  }

  /**
   * Returns the configurable driver options. Unprefixed: with multiple data
   * sources they are read as CUBEJS_DS_<NAME>_...
   */
  public static driverEnvVariables(): string[] {
    return [
      'CUBEJS_DB_HOST',
      'CUBEJS_DB_PORT',
      'CUBEJS_DB_NAME',
      'CUBEJS_DB_USER',
      'CUBEJS_DB_PASS',
      'CUBEJS_DB_SSL',
      'CUBEJS_DB_MAX_POOL',
      ...Object.values(DB2_ENV_VARIABLES),
    ];
  }

  public constructor(config: Db2DriverConfiguration = {}) {
    super({
      testConnectionTimeout: config.testConnectionTimeout,
    });

    const dataSource = config.dataSource || assertDataSource('default');
    const preAggregations = config.preAggregations || false;
    const envTimeout = readDb2Env('connectTimeout', dataSource, preAggregations);

    this.config = {
      ...connectionConfigFromEnv(dataSource, preAggregations),
      // Where pre-aggregation tables go is a property of the data source, so
      // these are read without the CUBEJS_PRE_AGGREGATIONS_ prefix.
      preAggregationDatabase: readDb2Env('preAggregationDatabase', dataSource, false),
      preAggregationTablespace: readDb2Env('preAggregationTablespace', dataSource, false),
      schemas: parseSchemaList(readDb2Env('schemas', dataSource, false)),
      connectTimeout: envTimeout ? parseInt(envTimeout, 10) : 30,
      maxConnectionAgeMs: DEFAULT_MAX_CONNECTION_AGE_MS,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      ...config,
      dataSource,
      preAggregations,
    };
    this.connectionString = buildConnectionString(this.config);

    const maxPool = config.maxPoolSize ||
      getEnv('dbMaxPoolSize', { dataSource, preAggregations }) ||
      8;

    this.pool = new Pool<PooledConnection>(
      createPoolName('db2', dataSource, preAggregations),
      {
        create: async () => {
          const ibmdb = loadIbmDb();
          try {
            const conn = await keepLoopAwake(() => ibmdb.open(this.connectionString, {
              connectTimeout: this.config.connectTimeout,
            }));
            return { conn, createdAt: Date.now(), disposed: false };
          } catch (e) {
            throw describeError(e);
          }
        },
        destroy: async (pc) => {
          try {
            await keepLoopAwake(() => pc.conn.close());
          } catch {
            // Closing a dead connection fails; it is gone either way.
          }
        },
        // Cheap checks only: a round trip per borrow costs ~140 ms on z/OS.
        // Lost links are handled by retrying read queries once (see execute).
        validate: async (pc) => !pc.disposed &&
          pc.conn.connected !== false &&
          Date.now() - pc.createdAt < (this.config.maxConnectionAgeMs as number),
      },
      {
        min: 0,
        max: maxPool,
        testOnBorrow: true,
        acquireTimeoutMillis: 60 * 1000,
        idleTimeoutMillis: this.config.idleTimeoutMs,
        evictionRunIntervalMillis: 60 * 1000,
      }
    );
    this.pool.on('factoryCreateError', (err) => this.databasePoolError(err));
  }

  /**
   * Connection string with the password masked, for diagnostics.
   */
  public maskedConnectionString(): string {
    return maskConnectionString(this.connectionString);
  }

  public async testConnection(): Promise<void> {
    await this.query('SELECT 1 AS "one" FROM SYSIBM.SYSDUMMY1');
  }

  public query<R = Record<string, unknown>>(
    query: string,
    values: unknown[] = [],
    _options?: QueryOptions
  ): CancelablePromise<R[]> {
    return this.execute(query, values, async (result, rename) => (await this.readAll(result, rename)).rows as R[]);
  }

  /**
   * Runs a statement and returns rows plus column types from the result metadata.
   */
  public queryWithTypes(query: string, values: unknown[] = []): CancelablePromise<{ rows: Record<string, unknown>[], types: TableStructure }> {
    return this.execute(query, values, (result, rename) => this.readAll(result, rename));
  }

  public async stream(sql: string, values: unknown[], { highWaterMark }: StreamOptions): Promise<StreamTableDataWithTypes> {
    const { sql: query, restore } = shortenLongIdentifiers(sql);
    const rename = buildRowRenamer(restore);
    const pc = await this.pool.acquire();
    let returned = false;
    const giveBack = async (error?: Error | null) => {
      if (returned) {
        return;
      }
      returned = true;
      if (error) {
        pc.disposed = true;
      }
      await (pc.disposed ? this.pool.destroy(pc) : this.pool.release(pc));
    };

    let result: Db2Result | null;
    try {
      result = await this.runStatement(pc, query, values);
    } catch (e) {
      if (isWarning(e) || isConnectionLost(e)) {
        pc.disposed = true;
      }
      await giveBack();
      throw describeError(e);
    }

    if (!result) {
      await giveBack();
      throw new Error('DB2 statement returned no result set to stream');
    }

    const meta = result.getColumnMetadataSync();
    // The stream hands the connection back itself, from onClose, once its
    // statement is closed: never while a close could still be in flight.
    let settled: () => void = () => undefined;
    const handedBack = new Promise<void>(resolve => { settled = resolve; });
    const rowStream = new QueryStream(
      result,
      buildRowTransform(meta),
      rename,
      async (error) => {
        try {
          await giveBack(error);
        } finally {
          settled();
        }
      },
      highWaterMark
    );

    return {
      rowStream,
      types: renameTypes(metadataToTypes(meta), rename),
      release: async () => {
        if (!rowStream.destroyed && !rowStream.readableEnded) {
          rowStream.destroy();
        }
        await handedBack;
      },
    };
  }

  public async downloadQueryResults(
    query: string,
    values: unknown[],
    options: DownloadQueryResultsOptions
  ): Promise<DownloadQueryResultsResult> {
    if (options?.streamImport) {
      return this.stream(query, values, options);
    }
    return this.queryWithTypes(query, values);
  }

  public async queryColumnTypes(sql: string, params: unknown[]): Promise<{ name: string; type: string }[]> {
    const { types } = await this.queryWithTypes(`SELECT * FROM (${sql}) AS "q" WHERE 1 = 0`, params);
    return types;
  }

  public readOnly(): boolean {
    return this.config.readOnly !== undefined ? this.config.readOnly : true;
  }

  public capabilities(): DriverCapabilities {
    return {
      incrementalSchemaLoading: true,
    };
  }

  public wrapQueryWithLimit(query: { query: string; limit: number }): void {
    query.query = wrapWithFetchFirst(query.query, parseInt(String(query.limit), 10));
  }

  public async release(): Promise<void> {
    await this.pool.drain();
    await this.pool.clear();
  }

  // ------------------------------------------------------------------ catalog

  /** `IN (...)` for the configured schemas, or the system-schema exclusion. */
  protected schemaFilter(column: string): string {
    const { schemas } = this.config;
    if (schemas && schemas.length) {
      return `${column} IN (${schemas.map(s => `'${s.replace(/'/g, "''")}'`).join(', ')})`;
    }
    return `${column} ${SYSTEM_SCHEMA_FILTER}`;
  }

  protected informationSchemaQuery(): string {
    return `
      SELECT RTRIM(c.NAME) AS ${this.quoteIdentifier('column_name')},
             RTRIM(c.TBNAME) AS ${this.quoteIdentifier('table_name')},
             RTRIM(c.TBCREATOR) AS ${this.quoteIdentifier('table_schema')},
             RTRIM(c.COLTYPE) AS ${this.quoteIdentifier('data_type')}
      FROM SYSIBM.SYSCOLUMNS c
      JOIN SYSIBM.SYSTABLES t ON t.CREATOR = c.TBCREATOR AND t.NAME = c.TBNAME
      WHERE t.TYPE IN ${TABLE_TYPES} AND ${this.schemaFilter('c.TBCREATOR')}
      WITH UR
    `;
  }

  protected getSchemasQuery(): string {
    // SYSIBM.SYSSCHEMATA does not exist on z/OS; derive schemas from tables.
    return `
      SELECT DISTINCT RTRIM(CREATOR) AS ${this.quoteIdentifier('schema_name')}
      FROM SYSIBM.SYSTABLES
      WHERE TYPE IN ${TABLE_TYPES} AND ${this.schemaFilter('CREATOR')}
      WITH UR
    `;
  }

  protected getTablesForSpecificSchemasQuery(schemasPlaceholders: string): string {
    return `
      SELECT RTRIM(CREATOR) AS ${this.quoteIdentifier('schema_name')},
             RTRIM(NAME) AS ${this.quoteIdentifier('table_name')}
      FROM SYSIBM.SYSTABLES
      WHERE TYPE IN ${TABLE_TYPES} AND CREATOR IN (${schemasPlaceholders})
      WITH UR
    `;
  }

  protected getColumnsForSpecificTablesQuery(conditionString: string): string {
    return `
      SELECT RTRIM(c.NAME) AS ${this.quoteIdentifier('column_name')},
             RTRIM(c.TBNAME) AS ${this.quoteIdentifier('table_name')},
             RTRIM(c.TBCREATOR) AS ${this.quoteIdentifier('schema_name')},
             RTRIM(c.COLTYPE) AS ${this.quoteIdentifier('data_type')}
      FROM SYSIBM.SYSCOLUMNS c
      WHERE ${conditionString}
      WITH UR
    `;
  }

  protected getColumnNameForSchemaName(): string {
    return 'c.TBCREATOR';
  }

  protected getColumnNameForTableName(): string {
    return 'c.TBNAME';
  }

  protected primaryKeysQuery(conditionString?: string): string | null {
    // KEYSEQ > 0 marks primary-key columns on both z/OS and LUW.
    return `
      SELECT RTRIM(c.TBCREATOR) AS ${this.quoteIdentifier('table_schema')},
             RTRIM(c.TBNAME) AS ${this.quoteIdentifier('table_name')},
             RTRIM(c.NAME) AS ${this.quoteIdentifier('column_name')}
      FROM SYSIBM.SYSCOLUMNS c
      WHERE c.KEYSEQ > 0 AND c.TBCREATOR ${SYSTEM_SCHEMA_FILTER}${conditionString ? ` AND (${conditionString})` : ''}
      WITH UR
    `;
  }

  /**
   * Lists a schema's tables for Cube's pre-aggregation loader, which finds
   * its tables by comparing these names with the lowercase, unquoted names it
   * created them with. DB2 folds those to upper case, so folded names are
   * returned in lower case again: otherwise the loader would never recognise
   * a built pre-aggregation, and would drop it as an orphan.
   */
  public async getTablesQuery(schemaName: string) {
    const rows = await this.query<{ table_name: string }>(
      `SELECT RTRIM(NAME) AS ${this.quoteIdentifier('table_name')}
       FROM SYSIBM.SYSTABLES
       WHERE TYPE IN ${TABLE_TYPES} AND CREATOR = ?
       WITH UR`,
      [foldIdentifier(schemaName)]
    );
    return rows.map(r => ({ table_name: r.table_name === r.table_name.toUpperCase() ? r.table_name.toLowerCase() : r.table_name }));
  }

  /**
   * Builds a pre-aggregation table stored in DB2 (`external: false`).
   *
   * Cube's load SQL is `CREATE TABLE <t> AS <select>`, which DB2 for z/OS
   * has no form of (only CREATE ... AS (...) WITH NO DATA, which in turn
   * accepts no parameter markers and fails when source and target encodings
   * differ). So: describe the select, create the table with explicit
   * columns in the configured database/tablespace, then INSERT ... SELECT.
   */
  public async loadPreAggregationIntoTable(
    preAggregationTableName: string,
    loadSql: string,
    params: unknown[],
    _options: unknown
  ): Promise<unknown[]> {
    const prefix = new RegExp(`^\\s*CREATE\\s+TABLE\\s+${escapeRegExp(preAggregationTableName)}\\s+AS\\s+`, 'i');
    if (!prefix.test(loadSql)) {
      throw new Error(`Unexpected pre-aggregation load SQL for ${preAggregationTableName}: ${loadSql.slice(0, 200)}`);
    }
    const select = loadSql.replace(prefix, '');
    const columns = await this.describeColumns(select, params);

    await this.query(this.createTableFromColumnsSql(preAggregationTableName, columns), []);
    try {
      await this.query(`INSERT INTO ${preAggregationTableName} ${select}`, params);
    } catch (e) {
      await this.dropTable(preAggregationTableName).catch(() => undefined);
      throw e;
    }
    return [];
  }

  public async dropTable(tableName: string, options?: QueryOptions): Promise<unknown> {
    try {
      return await this.query(`DROP TABLE ${tableName}`, [], options);
    } catch (e) {
      if (isObjectNotFound(e)) {
        return [];
      }
      throw e;
    }
  }

  /** `IN db.ts`, `IN ts` or `IN DATABASE db`, per the configured target. */
  protected tableSpaceClause(): string {
    const { preAggregationDatabase: db, preAggregationTablespace: ts } = this.config;
    if (db && ts) return ` IN ${db}.${ts}`;
    if (ts) return ` IN ${ts}`;
    if (db) return ` IN DATABASE ${db}`;
    return '';
  }

  protected createTableFromColumnsSql(tableName: string, columns: Db2ColumnMetadata[]): string {
    const definitions = columns.map(c => `${this.quoteIdentifier(c.SQL_DESC_NAME)} ${columnDefinitionType(c)}`);
    return `CREATE TABLE ${tableName} (${definitions.join(', ')})${this.tableSpaceClause()}`;
  }

  /**
   * Result-set metadata of a query, without fetching rows. Column names are
   * the query's own (long aliases restored).
   */
  public describeColumns(sql: string, params: unknown[]): Promise<Db2ColumnMetadata[]> {
    return this.execute(`SELECT * FROM (${sql}) AS "q" WHERE 1 = 0`, params, async (result, rename) => {
      const meta = result.getColumnMetadataSync() || [];
      return meta.map(m => ({
        ...m,
        SQL_DESC_NAME: rename ? Object.keys(rename({ [m.SQL_DESC_NAME]: null }))[0] : m.SQL_DESC_NAME,
      }));
    });
  }

  public async tableColumnTypes(table: string): Promise<TableStructure> {
    const [schema, name] = splitTableName(table);
    const columns = await this.query<{ column_name: string; data_type: string }>(
      `SELECT RTRIM(NAME) AS ${this.quoteIdentifier('column_name')},
              RTRIM(COLTYPE) AS ${this.quoteIdentifier('data_type')}
       FROM SYSIBM.SYSCOLUMNS
       WHERE TBCREATOR = ? AND TBNAME = ?
       ORDER BY COLNO
       WITH UR`,
      [schema, name]
    );
    return columns.map(c => ({ name: c.column_name, type: this.toGenericType(c.data_type) }));
  }

  public async createSchemaIfNotExists(_schemaName: string): Promise<void> {
    // DB2 creates schemas implicitly with the first object qualified by them
    // (subject to the IMPLICIT_SCHEMA / CREATEIN authority), and z/OS has no
    // CREATE SCHEMA statement for dynamic SQL. Nothing to do here.
  }

  protected fromGenericType(columnType: string): string {
    return GENERIC_TO_DB2[columnType.toLowerCase()] || super.fromGenericType(columnType);
  }

  protected toGenericType(columnType: string, precision?: number | null, scale?: number | null): string {
    return colTypeToGeneric(columnType) || super.toGenericType(columnType, precision, scale);
  }

  // ---------------------------------------------------------------- execution

  /**
   * Borrows a connection, runs a statement and hands its result set to `read`.
   * Read-only statements are retried once on a fresh connection when the link
   * was lost; nothing else is ever retried.
   */
  protected execute<T>(
    sql: string,
    values: unknown[],
    read: (result: Db2Result, rename: ((row: Record<string, unknown>) => Record<string, unknown>) | null) => Promise<T>
  ): CancelablePromise<T> {
    const { sql: query, restore } = shortenLongIdentifiers(sql);
    const rename = buildRowRenamer(restore);
    let current: PooledConnection | null = null;
    let canceled = false;

    const attempt = async (retriesLeft: number): Promise<T> => {
      const pc = await this.pool.acquire();
      current = pc;
      try {
        if (canceled) {
          pc.disposed = true;
          throw new Error('Query was canceled');
        }
        const result = await this.runStatement(pc, query, values);
        if (!result) {
          return (await read(emptyResult(), rename)) as T;
        }
        try {
          return await read(result, rename);
        } finally {
          await closeQuietly(result);
        }
      } catch (e) {
        if (isWarning(e) || isConnectionLost(e)) {
          pc.disposed = true;
        }
        if (isConnectionLost(e) && retriesLeft > 0 && !canceled && isReadOnlyStatement(query)) {
          await this.pool.destroy(pc);
          current = null;
          return attempt(retriesLeft - 1);
        }
        throw describeError(e);
      } finally {
        if (current === pc) {
          current = null;
          await (pc.disposed ? this.pool.destroy(pc) : this.pool.release(pc));
        }
      }
    };

    const promise: CancelablePromise<T> = attempt(1);
    // ibm_db cannot interrupt a running statement. Cancel marks the connection
    // for disposal so it is never reused; the server-side work runs to completion.
    promise.cancel = async () => {
      canceled = true;
      if (current) {
        (current as PooledConnection).disposed = true;
      }
    };
    return promise;
  }

  /**
   * Statements whose marked time dimension operands must be wrapped in
   * TIMESTAMP(), by their bare text (see timestampOperands.ts).
   */
  private readonly timestampCastStatements = new Set<string>();

  /**
   * Runs a statement, sending marked time dimension operands bare, and again
   * wrapped in TIMESTAMP() if DB2 won't compare them (DATE columns on z/OS).
   */
  protected async runStatement(pc: PooledConnection, sql: string, values: unknown[]): Promise<Db2Result | null> {
    const run = async (text: string) => (await keepLoopAwake(() => pc.conn.queryResult(text, values)))[0];
    if (!hasTimestampOperands(sql)) {
      return run(sql);
    }
    const bare = unmarkTimestampOperands(sql);
    if (this.timestampCastStatements.has(bare)) {
      return run(castTimestampOperands(sql));
    }
    try {
      return await run(bare);
    } catch (e) {
      if (!isIncomparable(e)) {
        throw e;
      }
      if (this.timestampCastStatements.size >= 1000) {
        this.timestampCastStatements.clear();
      }
      this.timestampCastStatements.add(bare);
      return run(castTimestampOperands(sql));
    }
  }

  protected async readAll(
    result: Db2Result,
    rename: ((row: Record<string, unknown>) => Record<string, unknown>) | null
  ): Promise<{ rows: Record<string, unknown>[], types: TableStructure }> {
    const meta = result.getColumnMetadataSync() || [];
    if (!meta.length) {
      return { rows: [], types: [] };
    }
    let rows = await fetchAllRows(result);
    const transform = buildRowTransform(meta);
    if (transform) {
      rows.forEach(transform);
    }
    if (rename) {
      rows = rows.map(rename);
    }
    return { rows, types: renameTypes(metadataToTypes(meta), rename) };
  }
}

function renameTypes(
  types: { name: string; type: string }[],
  rename: ((row: Record<string, unknown>) => Record<string, unknown>) | null
) {
  if (!rename) {
    return types;
  }
  return types.map(t => ({ ...t, name: Object.keys(rename({ [t.name]: null }))[0] }));
}

function emptyResult(): Db2Result {
  return {
    getColumnMetadataSync: () => [],
    fetchSync: () => null,
    close: async () => true,
    closeSync: () => undefined,
  };
}

/**
 * DB2 column type for a result column described by ibm_db. DECIMAL reports
 * precision 0; it is recovered from the display length (sign and point).
 */
export function columnDefinitionType(c: Db2ColumnMetadata): string {
  const type = c.SQL_DESC_TYPE_NAME.toUpperCase();
  const length = c.SQL_DESC_LENGTH;
  const scale = c.SQL_DESC_SCALE || 0;
  switch (type) {
    case 'CHAR':
    case 'CHARACTER':
      return `CHAR(${Math.max(1, Math.min(length, 255))})`;
    case 'VARCHAR':
      return `VARCHAR(${Math.max(1, length)})`;
    case 'GRAPHIC':
      return `GRAPHIC(${Math.max(1, length)})`;
    case 'VARGRAPHIC':
      return `VARGRAPHIC(${Math.max(1, length)})`;
    case 'DECIMAL':
    case 'NUMERIC': {
      const precision = c.SQL_DESC_PRECISION || length - (scale > 0 ? 2 : 1);
      return `DECIMAL(${Math.max(1, Math.min(31, precision))},${scale})`;
    }
    case 'DECFLOAT':
      return length > 16 ? 'DECFLOAT(34)' : 'DECFLOAT(16)';
    case 'TIMESTAMP':
      return `TIMESTAMP(${scale})`;
    case 'SMALLINT':
    case 'INTEGER':
    case 'BIGINT':
    case 'REAL':
    case 'DOUBLE':
    case 'DATE':
    case 'TIME':
      return type;
    case 'FLOAT':
      return 'DOUBLE';
    case 'CLOB':
    case 'BLOB':
    case 'DBCLOB':
      return `${type}(${Math.max(1, length)})`;
    default:
      return `VARCHAR(${Math.max(1, Math.min(length || 255, 32704))})`;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 'A, b ,C' → ['A', 'B', 'C'] (folded like unquoted identifiers); undefined when empty. */
export function parseSchemaList(value: string | undefined): string[] | undefined {
  const list = (value || '').split(',').map(s => s.trim()).filter(Boolean).map(foldIdentifier);
  return list.length ? list : undefined;
}

/** A single identifier as DB2 stores it: quoted keeps case, unquoted folds up. */
export function foldIdentifier(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name.toUpperCase();
}

/**
 * Limits a query to `limit` rows. A derived table is the safe general form,
 * but z/OS rejects a common table expression inside one (SQL0199N), so a
 * query that starts with WITH gets the clause appended instead (replacing
 * a trailing FETCH FIRST, and kept ahead of a trailing isolation clause).
 */
export function wrapWithFetchFirst(sql: string, limit: number): string {
  const query = sql.trim().replace(/;+\s*$/, '');
  const fetchFirst = `FETCH FIRST ${limit} ROWS ONLY`;
  if (!/^\(?\s*WITH\b/i.test(query)) {
    return `SELECT * FROM (${query}) AS "t" ${fetchFirst}`;
  }
  const isolation = /\s+WITH\s+(UR|CS|RS|RR)\s*$/i.exec(query);
  let body = isolation ? query.slice(0, isolation.index) : query;
  const existing = /\s+FETCH\s+FIRST\s+(\d+)\s+ROWS?\s+ONLY\s*$/i.exec(body);
  let effective = limit;
  if (existing) {
    effective = Math.min(limit, parseInt(existing[1], 10));
    body = body.slice(0, existing.index);
  }
  return `${body} FETCH FIRST ${effective} ROWS ONLY${isolation ? isolation[0] : ''}`;
}

/**
 * True for statements that are safe to re-run after a lost connection.
 */
export function isReadOnlyStatement(sql: string): boolean {
  return /^\s*(\(\s*)*(SELECT|WITH|VALUES)\b/i.test(sql);
}

/**
 * Splits `schema.table` (either part optionally double-quoted) into catalog
 * values: quoted parts keep their case, unquoted ones fold to upper case as
 * DB2 does.
 */
export function splitTableName(table: string): [string, string] {
  const parts = table.match(/"(?:[^"]|"")*"|[^.]+/g) || [];
  if (parts.length !== 2) {
    throw new Error(`Expected a schema-qualified table name, got: ${table}`);
  }
  const norm = (p: string) => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p.toUpperCase());
  return [norm(parts[0]), norm(parts[1])];
}
