/**
 * @fileoverview DB2 CLI connection-string building and environment config.
 */

import { getEnv, keyByDataSource } from '@cubejs-backend/shared';

export interface Db2ConnectionConfig {
  host?: string;
  port?: number | string;
  database?: string;
  user?: string;
  password?: string;
  /** Adds `Security=SSL`. Implied by any of the certificate/keystore options. */
  ssl?: boolean;
  /** `SSLServerCertificate`: path to a PEM/ARM root CA. */
  sslServerCertificate?: string;
  /** `SSLClientKeystoredb`: path to a GSKit `.kdb` keystore. */
  sslClientKeystoredb?: string;
  /** `SSLClientKeystash`: path to the keystore's `.sth` stash file. */
  sslClientKeystash?: string;
  /** `SSLClientHostnameValidation`, e.g. `OFF` or `BASIC`. */
  sslHostnameValidation?: string;
  /** `AUTHENTICATION`, e.g. `SERVER`. */
  authentication?: string;
  /** `CURRENTSCHEMA`: default schema for unqualified names. */
  currentSchema?: string;
  /** `CurrentPackageSet`: driver package collection, e.g. one bound at a higher APPLCOMPAT. */
  currentPackageSet?: string;
  /** Raw `KEY=VALUE;...` fragment appended verbatim. */
  extra?: string;
}

/**
 * Environment variables specific to this driver. Each is also read with the
 * data-source (`CUBEJS_DS_<NAME>_...`) and pre-aggregations
 * (`CUBEJS_PRE_AGGREGATIONS_...`) prefixes Cube uses for every other driver.
 */
export const DB2_ENV_VARIABLES = {
  sslServerCertificate: 'CUBEJS_DB_DB2_SSL_SERVER_CERTIFICATE',
  sslClientKeystoredb: 'CUBEJS_DB_DB2_SSL_CLIENT_KEYSTOREDB',
  sslClientKeystash: 'CUBEJS_DB_DB2_SSL_CLIENT_KEYSTASH',
  sslHostnameValidation: 'CUBEJS_DB_DB2_SSL_HOSTNAME_VALIDATION',
  authentication: 'CUBEJS_DB_DB2_AUTHENTICATION',
  currentSchema: 'CUBEJS_DB_DB2_CURRENT_SCHEMA',
  currentPackageSet: 'CUBEJS_DB_DB2_CURRENT_PACKAGE_SET',
  extra: 'CUBEJS_DB_DB2_EXTRA',
  connectTimeout: 'CUBEJS_DB_DB2_CONNECT_TIMEOUT',
  schemas: 'CUBEJS_DB_DB2_SCHEMAS',
  preAggregationDatabase: 'CUBEJS_DB_DB2_PREAGG_DATABASE',
  preAggregationTablespace: 'CUBEJS_DB_DB2_PREAGG_TABLESPACE',
  autocommit: 'CUBEJS_DB_DB2_AUTOCOMMIT',
} as const;

export type Db2EnvKey = keyof typeof DB2_ENV_VARIABLES;

/**
 * Reads one of the driver-specific variables for a data source.
 */
export function readDb2Env(
  key: Db2EnvKey,
  dataSource: string,
  preAggregations: boolean
): string | undefined {
  const value = process.env[keyByDataSource(DB2_ENV_VARIABLES[key], dataSource, preAggregations)];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Reads the connection settings for a data source from the environment.
 */
export function connectionConfigFromEnv(dataSource: string, preAggregations: boolean): Db2ConnectionConfig {
  const opts = { dataSource, preAggregations };
  return {
    host: getEnv('dbHost', opts),
    port: getEnv('dbPort', opts),
    database: getEnv('dbName', opts),
    user: getEnv('dbUser', opts),
    password: getEnv('dbPass', opts),
    ssl: getEnv('dbSsl', opts),
    sslServerCertificate: readDb2Env('sslServerCertificate', dataSource, preAggregations),
    sslClientKeystoredb: readDb2Env('sslClientKeystoredb', dataSource, preAggregations),
    sslClientKeystash: readDb2Env('sslClientKeystash', dataSource, preAggregations),
    sslHostnameValidation: readDb2Env('sslHostnameValidation', dataSource, preAggregations),
    authentication: readDb2Env('authentication', dataSource, preAggregations),
    currentSchema: readDb2Env('currentSchema', dataSource, preAggregations),
    currentPackageSet: readDb2Env('currentPackageSet', dataSource, preAggregations),
    extra: readDb2Env('extra', dataSource, preAggregations),
  };
}

function assertNoSeparator(name: string, value: string): void {
  // A ';' would let one setting inject others into the connection string.
  if (value.includes(';')) {
    throw new Error(`DB2 connection setting "${name}" must not contain ';'`);
  }
}

/**
 * Builds a DB2 CLI/ODBC connection string. Only CLI keywords are emitted:
 * JDBC-style keywords (sslConnection, sslCertLocation, ...) are silently
 * ignored by the CLI driver and would leave the connection in plaintext.
 */
export function buildConnectionString(config: Db2ConnectionConfig): string {
  const required: [string, unknown][] = [
    ['host', config.host],
    ['port', config.port],
    ['database', config.database],
    ['user', config.user],
    ['password', config.password],
  ];
  const missing = required.filter(([, v]) => v === undefined || v === null || v === '').map(([k]) => k);
  if (missing.length) {
    throw new Error(`DB2 connection is missing: ${missing.join(', ')} (CUBEJS_DB_HOST, CUBEJS_DB_PORT, CUBEJS_DB_NAME, CUBEJS_DB_USER, CUBEJS_DB_PASS)`);
  }

  const parts: [string, string][] = [
    ['DRIVER', 'IBM DB2 ODBC DRIVER'],
    ['DATABASE', String(config.database)],
    ['HOSTNAME', String(config.host)],
    ['PORT', String(config.port)],
    ['PROTOCOL', 'TCPIP'],
    ['UID', String(config.user)],
  ];

  const useSsl = config.ssl || config.sslServerCertificate || config.sslClientKeystoredb;
  if (useSsl) {
    parts.push(['Security', 'SSL']);
  }
  if (config.sslServerCertificate) parts.push(['SSLServerCertificate', config.sslServerCertificate]);
  if (config.sslClientKeystoredb) parts.push(['SSLClientKeystoredb', config.sslClientKeystoredb]);
  if (config.sslClientKeystash) parts.push(['SSLClientKeystash', config.sslClientKeystash]);
  if (config.sslHostnameValidation) parts.push(['SSLClientHostnameValidation', config.sslHostnameValidation]);
  if (config.authentication) parts.push(['AUTHENTICATION', config.authentication]);
  if (config.currentSchema) parts.push(['CURRENTSCHEMA', config.currentSchema]);
  if (config.currentPackageSet) parts.push(['CurrentPackageSet', config.currentPackageSet]);

  for (const [key, value] of parts) {
    assertNoSeparator(key, value);
  }

  // The password is the one value allowed to contain ';': CLI accepts it wrapped in braces.
  const password = String(config.password);
  const pwd = password.includes(';') ? `{${password.replace(/}/g, '}}')}}` : password;

  let dsn = `${parts.map(([k, v]) => `${k}=${v}`).join(';')};PWD=${pwd}`;
  if (config.extra) {
    dsn += `;${config.extra.replace(/^;+|;+$/g, '')}`;
  }
  return dsn;
}

/**
 * Masks the password in a connection string for logging.
 */
export function maskConnectionString(connectionString: string): string {
  return connectionString.replace(/(PWD=)(\{(?:[^}]|\}\})*\}|[^;]*)/i, '$1[REDACTED]');
}
