/**
 * @fileoverview DB2 SQLCODE classification.
 *
 * Classification is always by `sqlcode`, never by message text: the macOS
 * clidriver ships no message file for several z/OS-only codes (-4743,
 * -20497, ...) and reports them as a generic SQL0969N.
 */

/**
 * Human-readable names for SQLCODEs this driver is likely to surface.
 * Ported from @dmalta/knex-db2 and extended with codes seen in validation.
 */
export const DB2_ERROR_NAMES: Record<number, string> = {
  // Connection
  [-30081]: 'CONNECTION_FAILED',
  [-30080]: 'COMMUNICATION_ERROR',
  [-30108]: 'CONNECTION_REROUTED',
  [-1224]: 'DATABASE_AGENT_TERMINATED',
  [-1024]: 'DATABASE_NOT_FOUND',
  [-1336]: 'HOST_NOT_FOUND',
  [-1598]: 'DB2_CONNECT_LICENSE_MISSING',
  [-30082]: 'AUTHENTICATION_FAILED',
  [-30090]: 'SECURITY_ERROR',
  [-952]: 'PROCESSING_CANCELLED',
  [-924]: 'CONNECTION_ALREADY_EXISTS',

  // Authorization
  [-551]: 'INSUFFICIENT_PRIVILEGES',
  [-552]: 'AUTHORIZATION_FAILURE',
  [-922]: 'AUTHORIZATION_REQUIRED',

  // Syntax / semantics
  [-104]: 'SYNTAX_ERROR',
  [-199]: 'SYNTAX_ERROR',
  [-107]: 'NAME_TOO_LONG',
  [-132]: 'INVALID_LIKE_OR_STRING_ARGUMENT',
  [-171]: 'INVALID_FUNCTION_ARGUMENT',
  [-180]: 'INVALID_DATETIME_STRING',
  [-181]: 'INVALID_DATETIME_VALUE',
  [-20497]: 'INVALID_DATETIME_STRING',
  [-203]: 'AMBIGUOUS_COLUMN_REFERENCE',
  [-204]: 'OBJECT_NOT_FOUND',
  [-206]: 'COLUMN_NOT_FOUND',
  [-401]: 'INCOMPARABLE_OPERANDS',
  [-245]: 'AMBIGUOUS_FUNCTION_ARGUMENT',
  [-417]: 'PARAMETER_MARKERS_AS_OPERANDS',
  [-418]: 'UNTYPED_PARAMETER_MARKER',
  [-440]: 'FUNCTION_NOT_FOUND',
  [-713]: 'INVALID_SPECIAL_REGISTER_VALUE',
  [-874]: 'CCSID_MISMATCH',
  [-4743]: 'APPLCOMPAT_TOO_LOW',

  // Data
  [-302]: 'CONVERSION_ERROR',
  [-407]: 'NULL_VALUE_NOT_ALLOWED',
  [-413]: 'OVERFLOW_ERROR',
  [-420]: 'CHARACTER_CONVERSION_ERROR',
  [-803]: 'DUPLICATE_KEY',

  // Locking / resources
  [-904]: 'RESOURCE_UNAVAILABLE',
  [-911]: 'DEADLOCK_OR_TIMEOUT_ROLLED_BACK',
  [-913]: 'DEADLOCK_OR_TIMEOUT',
  [-668]: 'TABLE_REORG_PENDING',
  [-289]: 'TABLESPACE_FULL',
  [-971]: 'TABLESPACE_NOT_AVAILABLE',
};

/**
 * SQLCODEs that mean the connection itself is gone. A query that fails with
 * one of these may be retried on a fresh connection; nothing else may.
 */
const CONNECTION_LOST_CODES = new Set([-30081, -30080, -30108, -1224, -952]);

/**
 * SQLCODEs worth retrying on DDL: lock waits on the database descriptor.
 */
const LOCK_CODES = new Set([-911, -913]);

export interface Db2ErrorLike {
  sqlcode?: number;
  sqlstate?: string;
  state?: string;
  message?: string;
}

export function getSqlCode(error: unknown): number | undefined {
  const code = (error as Db2ErrorLike | undefined)?.sqlcode;
  return typeof code === 'number' ? code : undefined;
}

export function getSqlState(error: unknown): string | undefined {
  const e = error as Db2ErrorLike | undefined;
  return e?.sqlstate || e?.state;
}

export function isConnectionLost(error: unknown): boolean {
  const code = getSqlCode(error);
  if (code !== undefined && CONNECTION_LOST_CODES.has(code)) {
    return true;
  }
  // SQLSTATE class 08 is "connection exception".
  return (getSqlState(error) || '').startsWith('08');
}

export function isLockTimeout(error: unknown): boolean {
  const code = getSqlCode(error);
  return code !== undefined && LOCK_CODES.has(code);
}

/** Operands not comparable, e.g. a DATE with a TIMESTAMP on z/OS. */
export function isIncomparable(error: unknown): boolean {
  return getSqlCode(error) === -401;
}

export function isObjectNotFound(error: unknown): boolean {
  return getSqlCode(error) === -204;
}

/**
 * A positive SQLCODE is a warning. ibm_db surfaces some of them (for example
 * SQL0347W) as errors, and can leave the handle warning-pending, so a
 * connection that produced one is discarded rather than reused.
 */
export function isWarning(error: unknown): boolean {
  const code = getSqlCode(error);
  return code !== undefined && code > 0 && code !== 100;
}

/**
 * Decorates an ibm_db error with the SQLCODE name, keeping the original
 * object (and its `sqlcode` / `sqlstate`) intact for callers.
 */
export function describeError<T>(error: T): T {
  const code = getSqlCode(error);
  if (code === undefined || !(error instanceof Error)) {
    return error;
  }
  const name = DB2_ERROR_NAMES[code];
  if (name && !error.message.includes(`[${name}]`)) {
    error.message = `[${name}] ${error.message}`;
  }
  if (code === -1598) {
    error.message += ' A DB2 Connect license file whose version matches the clidriver ' +
      '(db2consv_*.lic) must be copied into node_modules/ibm_db/installer/clidriver/license/.';
  } else if (code === -4743) {
    error.message += ' The statement needs a higher application compatibility level. ' +
      'Set CUBEJS_DB_DB2_CURRENT_PACKAGE_SET to a driver package collection bound at a ' +
      'higher APPLCOMPAT, if your DBA has granted EXECUTE on it.';
  }
  return error;
}
