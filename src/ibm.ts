/**
 * @fileoverview Typed, lazily-loaded access to the `ibm_db` native module.
 *
 * `ibm_db` is an optionalDependency: its native build can fail on some
 * platforms (there is no linux/arm64 clidriver). Loading it lazily keeps the
 * package importable for unit tests and tooling, and turns a missing module
 * into a clear error at connect time instead of at `require` time.
 */

export interface Db2ColumnMetadata {
  index: number;
  SQL_DESC_NAME: string;
  SQL_DESC_TYPE_NAME: string;
  SQL_DESC_CONSIZE_TYPE: number;
  SQL_DESC_DISPLAY_SIZE: number;
  SQL_DESC_PRECISION: number;
  SQL_DESC_SCALE: number;
  SQL_DESC_LENGTH: number;
}

export interface Db2Result {
  getColumnMetadataSync(): Db2ColumnMetadata[];
  /** Next row from the CLI's block-fetch buffer; null at the end. */
  fetchSync(): Record<string, unknown> | null;
  close(): Promise<unknown>;
  closeSync(): void;
}

export interface Db2Statement {
  executeSync(params?: unknown[]): Db2Result;
  closeSync(): void;
}

export interface Db2Connection {
  connected: boolean;
  queryResult(sql: string, params?: unknown[]): Promise<[Db2Result | null, unknown]>;
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  prepareSync(sql: string): Db2Statement;
  getInfoSync(infoType: number): string;
  beginTransaction(): Promise<boolean>;
  commitTransaction(): Promise<boolean>;
  rollbackTransaction(): Promise<boolean>;
  /** Sets a connection attribute (SQLSetConnectAttr), e.g. SQL_ATTR_AUTOCOMMIT. */
  setAttr(attr: number, value: number | string | null): Promise<boolean>;
  close(): Promise<boolean>;
}

export interface IbmDbModule {
  open(connStr: string, options?: { connectTimeout?: number }): Promise<Db2Connection>;
}

let keepAwakeUsers = 0;
let keepAwakeTimer: NodeJS.Timeout | null = null;

/**
 * Keeps the event loop ticking while an ibm_db call is in flight.
 *
 * On Node 26 (libuv 1.5x), completions of ibm_db's uv_queue_work jobs are
 * not picked up promptly while a long ref'd timer is pending: ibm_db.open()
 * took ~30 s instead of ~0.5 s whenever any long setTimeout was armed, which
 * is always the case in a Cube server, and async fetches were 20x slower.
 * Node 24 is unaffected. A short interval, shared by all in-flight calls,
 * makes the loop poll again. Rows are read with fetchSync() in batches
 * instead (see rows.ts), which is fastest on every Node version.
 */
export async function keepLoopAwake<T>(work: () => Promise<T>): Promise<T> {
  keepAwakeUsers++;
  if (!keepAwakeTimer) {
    keepAwakeTimer = setInterval(() => undefined, 5);
  }
  try {
    return await work();
  } finally {
    keepAwakeUsers--;
    if (keepAwakeUsers === 0 && keepAwakeTimer) {
      clearInterval(keepAwakeTimer);
      keepAwakeTimer = null;
    }
  }
}

let cached: IbmDbModule | null = null;

/**
 * Returns the `ibm_db` module, loading it on first use.
 */
export function loadIbmDb(): IbmDbModule {
  if (cached) {
    return cached;
  }

  try {
    // eslint-disable-next-line global-require
    cached = require('ibm_db') as IbmDbModule;
  } catch (e) {
    throw new Error(
      'Unable to load the "ibm_db" module, which the DB2 driver needs to connect. ' +
      'Install it with "npm install ibm_db" (and "npm approve-scripts ibm_db" if your npm ' +
      'blocks install scripts). Note that IBM publishes no clidriver for linux/arm64. ' +
      `Original error: ${(e as Error).message}`
    );
  }

  return cached;
}

/**
 * Replaces the `ibm_db` module; used by unit tests to inject a mock.
 */
export function setIbmDbModule(module: IbmDbModule | null): void {
  cached = module;
}
