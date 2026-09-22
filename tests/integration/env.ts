import fs from 'fs';
import path from 'path';

import type { Db2DriverConfiguration } from '../../src/Db2Driver';

const envFile = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export const REAL = process.env.DB2_REAL_TEST === 'true';

export interface Target {
  name: string;
  platform: 'zos' | 'luw';
  config: Db2DriverConfiguration;
  writeSchema?: string;
  preAggregationDatabase?: string;
  preAggregationTablespace?: string;
  sourceTable?: string;
  sourceTimeColumn?: string;
}

function read(target: string, key: string): string | undefined {
  return process.env[`DB2_IT_${target}_${key}`] || undefined;
}

export function targets(): Target[] {
  return (process.env.DB2_IT_TARGETS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(name => ({
      name,
      platform: (read(name, 'PLATFORM') || 'luw') as 'zos' | 'luw',
      config: {
        host: read(name, 'HOST'),
        port: read(name, 'PORT'),
        database: read(name, 'NAME'),
        user: read(name, 'USER'),
        password: read(name, 'PASS'),
        sslServerCertificate: read(name, 'SSL_SERVER_CERTIFICATE'),
        sslHostnameValidation: read(name, 'SSL_HOSTNAME_VALIDATION'),
        currentPackageSet: read(name, 'CURRENT_PACKAGE_SET'),
        maxPoolSize: 2,
      },
      writeSchema: read(name, 'WRITE_SCHEMA'),
      preAggregationDatabase: read(name, 'PREAGG_DATABASE'),
      preAggregationTablespace: read(name, 'PREAGG_TABLESPACE'),
      sourceTable: read(name, 'SOURCE_TABLE'),
      sourceTimeColumn: read(name, 'SOURCE_TIME_COLUMN'),
    }));
}
