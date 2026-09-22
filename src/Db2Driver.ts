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
import { describeError, isConnectionLost, isWarning } from './errors';
import { Db2Connection, Db2Result, keepLoopAwake, loadIbmDb } from './ibm';
import { Db2Query } from './Db2Query';
import { closeQuietly, QueryStream } from './QueryStream';
import { buildRowTransform, colTypeToGeneric, fetchAllRows, metadataToTypes } from './rows';

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
      [result] = await keepLoopAwake(() => pc.conn.queryResult(query, values));
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

  protected informationSchemaQuery(): string {
    return `
      SELECT RTRIM(c.NAME) AS ${this.quoteIdentifier('column_name')},
             RTRIM(c.TBNAME) AS ${this.quoteIdentifier('table_name')},
             RTRIM(c.TBCREATOR) AS ${this.quoteIdentifier('table_schema')},
             RTRIM(c.COLTYPE) AS ${this.quoteIdentifier('data_type')}
      FROM SYSIBM.SYSCOLUMNS c
      JOIN SYSIBM.SYSTABLES t ON t.CREATOR = c.TBCREATOR AND t.NAME = c.TBNAME
      WHERE t.TYPE IN ${TABLE_TYPES} AND c.TBCREATOR ${SYSTEM_SCHEMA_FILTER}
      WITH UR
    `;
  }

  protected getSchemasQuery(): string {
    // SYSIBM.SYSSCHEMATA does not exist on z/OS; derive schemas from tables.
    return `
      SELECT DISTINCT RTRIM(CREATOR) AS ${this.quoteIdentifier('schema_name')}
      FROM SYSIBM.SYSTABLES
      WHERE TYPE IN ${TABLE_TYPES} AND CREATOR ${SYSTEM_SCHEMA_FILTER}
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

  public async getTablesQuery(schemaName: string) {
    return this.query<{ table_name: string }>(
      `SELECT RTRIM(NAME) AS ${this.quoteIdentifier('table_name')}
       FROM SYSIBM.SYSTABLES
       WHERE TYPE IN ${TABLE_TYPES} AND CREATOR = ?
       WITH UR`,
      [schemaName]
    );
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
        const [result] = await keepLoopAwake(() => pc.conn.queryResult(query, values));
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
