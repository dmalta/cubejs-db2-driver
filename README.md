# @dmalta/db2-cubejs-driver

A [Cube](https://cube.dev) data source driver for **IBM DB2 for z/OS** and **DB2 LUW**, built on
[`ibm_db`](https://github.com/ibmdb/node-ibm_db).

> Status: under active development. The read path (queries, streaming, schema introspection)
> works against DB2 12 for z/OS and DB2 11.x LUW. The SQL dialect and pre-aggregation support
> are in progress.

## Install

Install the driver under the name Cube looks up for `CUBEJS_DB_TYPE=db2`, using an npm alias.
With the alias, no `cube.js` configuration is needed:

```bash
npm i db2-cubejs-driver@npm:@dmalta/db2-cubejs-driver ibm_db@4
```

```bash
npm approve-scripts ibm_db
```

`ibm_db` downloads IBM's CLI driver (`clidriver`) in its install script. If your npm blocks
install scripts, the driver never materialises until the script is approved.

### Platforms

| Platform | Supported |
|---|---|
| macOS arm64 / x64 | ✅ |
| Linux x64 (`linux/amd64` containers) | ✅ |
| Linux arm64 (`linux/arm64` containers) | ❌ IBM publishes no clidriver for it |
| Windows x64 | ✅ |

### DB2 Connect license (z/OS and IBM i only)

Connecting to DB2 for z/OS through the v12.1 clidriver fails with `SQL1598N` unless a DB2 Connect
license file is present. Copy it into the clidriver before the first connection:

```bash
cp db2consv_*.lic node_modules/ibm_db/installer/clidriver/license/
```

The license's version must match the clidriver's (12.1 for `ibm_db` 4.x). LUW targets need no
license.

## Configuration

| Variable | Purpose |
|---|---|
| `CUBEJS_DB_TYPE` | `db2` |
| `CUBEJS_DB_HOST`, `CUBEJS_DB_PORT` | server |
| `CUBEJS_DB_NAME` | database name (LUW) or location name (z/OS) |
| `CUBEJS_DB_USER`, `CUBEJS_DB_PASS` | credentials |
| `CUBEJS_DB_SSL` | `true` adds `Security=SSL` |
| `CUBEJS_DB_MAX_POOL` | connection pool size (default 8) |
| `CUBEJS_DB_DB2_SSL_SERVER_CERTIFICATE` | path to the root CA (PEM/ARM); implies TLS |
| `CUBEJS_DB_DB2_SSL_CLIENT_KEYSTOREDB`, `CUBEJS_DB_DB2_SSL_CLIENT_KEYSTASH` | GSKit `.kdb` / `.sth` keystore instead of a PEM file |
| `CUBEJS_DB_DB2_SSL_HOSTNAME_VALIDATION` | e.g. `OFF` when the certificate's name doesn't match the host you connect to |
| `CUBEJS_DB_DB2_AUTHENTICATION` | e.g. `SERVER` |
| `CUBEJS_DB_DB2_CURRENT_SCHEMA` | default schema for unqualified names |
| `CUBEJS_DB_DB2_CURRENT_PACKAGE_SET` | driver package collection, e.g. one bound at a higher `APPLCOMPAT` (z/OS) |
| `CUBEJS_DB_DB2_CONNECT_TIMEOUT` | seconds (default 30) |
| `CUBEJS_DB_DB2_EXTRA` | raw `KEY=VALUE;…` CLI keywords appended to the connection string |

With multiple data sources, each variable is read as `CUBEJS_DS_<NAME>_…` in the usual Cube way.

Use CLI keywords only: JDBC-style keywords such as `sslConnection=true` are silently ignored by
the CLI driver and leave the connection unencrypted.

## Known limitations

- **DECIMAL precision.** `ibm_db` fetches DECIMAL, NUMERIC and DECFLOAT as doubles, so values
  beyond ~15–17 significant digits lose precision. The driver returns them as strings, but the
  precision is already gone.
- **Cancellation.** `ibm_db` can't interrupt a running statement. A canceled query's connection
  is discarded instead of reused, and the server-side work runs to completion.
- **Node 26.** Node 26 delays `ibm_db` completions while long timers are pending. The driver works
  around it, but Node 24 is the tested runtime.

## Development

```bash
npm test                      # unit tests, ibm_db mocked
npm run test:integration      # against real DB2, configured in .env (see .env.example)
```

In VS Code, the recommended Vitest extension shows both suites in the Test Explorer. Integration
tests are skipped there unless `DB2_REAL_TEST` is set to `true` in `.vscode/settings.json`.

See [docs/db2-validation.md](docs/db2-validation.md) for the platform behaviour the driver is
built on.

## License

Apache-2.0
