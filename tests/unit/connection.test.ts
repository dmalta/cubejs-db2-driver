import { afterEach, describe, expect, it } from 'vitest';

import { buildConnectionString, connectionConfigFromEnv, maskConnectionString } from '../../src/connection';
import { baseConfig } from './mock-ibm';

describe('buildConnectionString', () => {
  it('builds a plain CLI connection string', () => {
    expect(buildConnectionString(baseConfig)).toBe(
      'DRIVER=IBM DB2 ODBC DRIVER;DATABASE=LOCATION1;HOSTNAME=db.example.com;PORT=446;PROTOCOL=TCPIP;UID=user1;PWD=secret'
    );
  });

  it('implies Security=SSL from a server certificate and uses CLI (not JDBC) keywords', () => {
    const dsn = buildConnectionString({
      ...baseConfig,
      sslServerCertificate: '/certs/root.pem',
      sslHostnameValidation: 'OFF',
    });
    expect(dsn).toContain(';Security=SSL;SSLServerCertificate=/certs/root.pem;SSLClientHostnameValidation=OFF');
    expect(dsn).not.toMatch(/sslConnection|sslCertLocation/i);
  });

  it('supports a GSKit keystore, AUTHENTICATION, CURRENTSCHEMA and CurrentPackageSet', () => {
    const dsn = buildConnectionString({
      ...baseConfig,
      sslClientKeystoredb: '/k/key.kdb',
      sslClientKeystash: '/k/key.sth',
      authentication: 'SERVER',
      currentSchema: 'APP',
      currentPackageSet: 'NULLID_V12R1M500',
    });
    expect(dsn).toContain('Security=SSL;SSLClientKeystoredb=/k/key.kdb;SSLClientKeystash=/k/key.sth');
    expect(dsn).toContain('AUTHENTICATION=SERVER;CURRENTSCHEMA=APP;CurrentPackageSet=NULLID_V12R1M500');
  });

  it('adds Security=SSL for CUBEJS_DB_SSL=true alone', () => {
    expect(buildConnectionString({ ...baseConfig, ssl: true })).toContain(';Security=SSL');
  });

  it('appends a raw extra fragment last, trimming stray separators', () => {
    expect(buildConnectionString({ ...baseConfig, extra: ';ConnectTimeout=10;' })).toMatch(/;PWD=secret;ConnectTimeout=10$/);
  });

  it('reports every missing required setting', () => {
    expect(() => buildConnectionString({ host: 'h' })).toThrow(/missing: port, database, user, password/);
  });

  it('rejects ";" in settings so one value cannot inject another keyword', () => {
    expect(() => buildConnectionString({ ...baseConfig, user: 'u;Security=NONE' })).toThrow(/must not contain ';'/);
  });

  it('brace-quotes a password containing ";"', () => {
    expect(buildConnectionString({ ...baseConfig, password: 'a;b}c' })).toMatch(/PWD=\{a;b\}\}c\}$/);
  });
});

describe('maskConnectionString', () => {
  it('masks plain and brace-quoted passwords', () => {
    expect(maskConnectionString('UID=u;PWD=secret;X=1')).toBe('UID=u;PWD=[REDACTED];X=1');
    expect(maskConnectionString('UID=u;PWD={a;b}}c};X=1')).toBe('UID=u;PWD=[REDACTED];X=1');
  });
});

describe('connectionConfigFromEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('reads the generic CUBEJS_DB_* and driver-specific variables', () => {
    Object.assign(process.env, {
      CUBEJS_DB_HOST: 'h', CUBEJS_DB_PORT: '447', CUBEJS_DB_NAME: 'LOC', CUBEJS_DB_USER: 'u', CUBEJS_DB_PASS: 'p',
      CUBEJS_DB_DB2_SSL_SERVER_CERTIFICATE: '/ca.pem',
      CUBEJS_DB_DB2_CURRENT_PACKAGE_SET: 'COLL',
    });
    const config = connectionConfigFromEnv('default', false);
    expect(config).toMatchObject({ host: 'h', database: 'LOC', user: 'u', password: 'p', sslServerCertificate: '/ca.pem', currentPackageSet: 'COLL' });
    expect(String(config.port)).toBe('447');
  });

  it('reads CUBEJS_PRE_AGGREGATIONS_* variables for the pre-aggregations driver', () => {
    Object.assign(process.env, {
      CUBEJS_DB_DB2_CURRENT_SCHEMA: 'READ',
      CUBEJS_PRE_AGGREGATIONS_DB_DB2_CURRENT_SCHEMA: 'WRITE',
    });
    expect(connectionConfigFromEnv('default', true).currentSchema).toBe('WRITE');
    expect(connectionConfigFromEnv('default', false).currentSchema).toBe('READ');
  });
});
