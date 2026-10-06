# @dmalta/db2-cubejs-driver

A [Cube](https://cube.dev) data source driver for **IBM DB2 for z/OS** and **DB2 LUW**, built on
[`ibm_db`](https://github.com/ibmdb/node-ibm_db).

> Status: pre-release. Validated against DB2 12 for z/OS and DB2 11.x LUW with Cube 1.7: REST
> and SQL API queries through both of Cube's planners, the Playground, and pre-aggregations in
> Cube Store or in DB2 itself.

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

Cube itself (`@cubejs-backend/server`) provides the driver's `@cubejs-backend/*` peer
dependencies.

### Without the npm alias

If the package is installed under its own name, point Cube at it in `cube.js`:

```js
const Db2Driver = require('@dmalta/db2-cubejs-driver');

module.exports = {
  driverFactory: ({ dataSource }) => new Db2Driver({ dataSource }),
  dialectFactory: () => Db2Driver.dialectClass(),
};
```

Leave `CUBEJS_DB_TYPE` unset and set `CUBEJS_CONCURRENCY` (2 is the driver's default).
Otherwise Cube looks the driver up by type to read its default concurrency, and fails with
`Unsupported db type`.

### Docker

There's no prebuilt image to pull — you add three lines to *your own* Dockerfile, on top of
whatever official `cubejs/cube` image and version you already use. Nothing about Cube changes;
this is the same pattern as `FROM python:3.12` then `pip install`:

```dockerfile
FROM cubejs/cube:v1.7.43

# libxml2: runtime dependency of the clidriver's libdb2.so, not in the base image
RUN apt-get update && apt-get install -y --no-install-recommends libxml2 \
  && rm -rf /var/lib/apt/lists/*

# --legacy-peer-deps: the driver's @cubejs-backend/* peers are the image's own copies
# in /cube/node_modules (on NODE_PATH), so none get installed twice
RUN npm install --prefix /cube/conf --legacy-peer-deps \
  db2-cubejs-driver@npm:@dmalta/db2-cubejs-driver ibm_db@4
```

Build it for `linux/amd64` — IBM ships no `clidriver` for `linux/arm64`, so that's the only
Linux architecture `ibm_db` supports. On Apple silicon it runs emulated:

```bash
docker build --platform=linux/amd64 -t your-cube-image .
```

[`docker/Dockerfile`](docker/Dockerfile) is a complete, working example built the same way
(plus an entrypoint for DB2 Connect licenses, below) — copy from it rather than build against
it as a dependency.

#### DB2 Connect licenses in a container (z/OS / IBM i only)

Same requirement as the [native install](#db2-connect-license-zos-and-ibm-i-only) below, but
don't bake the license into the image — mount it at runtime and copy it into the clidriver from
your own entrypoint instead, since the clidriver directory must stay **writable** (it registers
the license there on first connect). [`docker/db2-entrypoint.sh`](docker/db2-entrypoint.sh) is a
minimal example:

```bash
docker run --platform=linux/amd64 -p 4000:4000 --env-file .env \
  -v "$PWD/model:/cube/conf/model" -v "$PWD/licenses:/db2-license:ro" \
  your-cube-image
```

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
| `CUBEJS_DB_DB2_AUTOCOMMIT` | `false` leaves new connections in the mode the CLI opens them in. Default: the driver turns autocommit on for every connection, so no statement leaves a unit of work (and its locks) open on the server |
| `CUBEJS_DB_DB2_SCHEMAS` | comma-separated schemas to introspect (Playground, data model generation). A z/OS catalog can hold tens of thousands of tables: all 37K took 55 s, one schema 4 s |
| `CUBEJS_DB_DB2_EXTRA` | raw `KEY=VALUE;…` CLI keywords appended to the connection string |

With multiple data sources, each variable is read as `CUBEJS_DS_<NAME>_…` in the usual Cube way.
For example, a z/OS default data source plus an LUW one:

```dotenv
CUBEJS_DATASOURCES=default,luw

CUBEJS_DB_TYPE=db2
CUBEJS_DB_HOST=zos.example.com
CUBEJS_DB_PORT=447
CUBEJS_DB_NAME=LOCATION1
CUBEJS_DB_DB2_SSL_SERVER_CERTIFICATE=/certs/root_ca.pem

CUBEJS_DS_LUW_DB_TYPE=db2
CUBEJS_DS_LUW_DB_HOST=luw.example.com
CUBEJS_DS_LUW_DB_PORT=50000
CUBEJS_DS_LUW_DB_NAME=SAMPLE
```

(plus the `USER`/`PASS` pair for each), and `data_source: luw` on the LUW cubes.

Use CLI keywords only: JDBC-style keywords such as `sslConnection=true` are silently ignored by
the CLI driver and leave the connection unencrypted.

If a connection over TLS fails with what looks like a password error, check the certificate first:
`SSLServerCertificate` must point at the **root** CA. If the certificate's name doesn't match the
host you connect to, the handshake fails (hostname validation is on by default in clidriver 12.1);
connect via the certificate's host name, or set `CUBEJS_DB_DB2_SSL_HOSTNAME_VALIDATION=OFF` on a
trusted network.

## Pre-aggregations

Two options, per pre-aggregation:

- **In Cube Store** (the default, `external: true`). Works with read-only DB2 access: Cube runs
  the rollup query and streams the rows out.
- **In DB2 itself** (`external: false`). The rollup lives in a DB2 table next to its source
  data. This needs write access:

  | Variable | Purpose |
  |---|---|
  | `CUBEJS_PRE_AGGREGATIONS_SCHEMA` | schema for the tables (you need `CREATEIN`, or implicit-schema authority) |
  | `CUBEJS_DB_DB2_PREAGG_DATABASE` | z/OS: database for the tables |
  | `CUBEJS_DB_DB2_PREAGG_TABLESPACE` | tablespace for the tables |

  Tables are created `IN <database>.<tablespace>` (or `IN <tablespace>`, or
  `IN DATABASE <database>`, depending on what's set).

  On z/OS, ask your DBA for a **dedicated database** for pre-aggregations. `CREATE TABLE` needs
  an exclusive lock on the database descriptor, and in a database shared with other
  applications it can wait minutes for their work to commit. The driver is tested with a classic
  segmented tablespace, which holds many tables; repeated build/drop cycles don't leave it
  REORG-pending. A universal (UTS) tablespace holds only one table, so it doesn't suit a
  schema of versioned pre-aggregation tables.

DB2 for z/OS has no `CREATE TABLE … AS SELECT` with data, so the driver builds each table in
three steps: describe the rollup query, `CREATE TABLE` with explicit columns, then
`INSERT … SELECT`. This also works when the source tables are Unicode and the target tablespace
is EBCDIC (or the reverse), which `CREATE TABLE … AS (…) WITH NO DATA` doesn't.

## Known limitations

- **Time zones.** DB2 for z/OS has no time zone database. A query's time zone is applied as its
  *current* UTC offset: exact for fixed-offset zones (UTC, Asia/Kolkata, …), but rows on the
  other side of a daylight-saving transition are shifted by the wrong hour. Store and query in
  UTC where that matters.
- **OFFSET on z/OS.** The default CLI packages run at application compatibility V10R1, which
  has no `OFFSET`/`LIMIT` (`SQLCODE -4743`). `FETCH FIRST` limits work. For offsets, ask your
  DBA for `EXECUTE` on a driver package collection bound at `APPLCOMPAT(V12R1M500)` or later,
  and set `CUBEJS_DB_DB2_CURRENT_PACKAGE_SET` to it.
- **DATE columns as time dimensions.** A `type: time` dimension can point straight at a DATE
  column. DB2 for z/OS won't compare a DATE with Cube's TIMESTAMP filter values
  (`SQLCODE -401`), so the driver sends time filters with the bare column first, which keeps
  predicates on TIMESTAMP columns indexable. If z/OS rejects the statement, the driver runs it
  again with those columns wrapped in `TIMESTAMP()`, and remembers to do so for that statement.
  The price: one failed prepare per statement shape, an index on the DATE column itself isn't
  used, and a query that filters a DATE and a TIMESTAMP column together wraps both. DB2 LUW
  compares DATE with TIMESTAMP directly.
- **`count_distinct_approx`** isn't supported: DB2 has no HyperLogLog functions.
- **Long member names.** z/OS limits column names to 30 bytes. The driver rewrites longer
  aliases in the SQL it runs and maps result columns back, so this is transparent, but the SQL
  you see in logs differs from what runs.
- **DECIMAL precision.** `ibm_db` fetches DECIMAL, NUMERIC and DECFLOAT as doubles, so values
  beyond ~15–17 significant digits lose precision. The driver returns them as strings, but the
  precision is already gone.
- **Cancellation.** `ibm_db` can't interrupt a running statement. A canceled query's connection
  is discarded instead of reused, and the server-side work runs to completion.
- **Node 26.** Node 26 delays `ibm_db` completions while long timers are pending (every new
  connection took ~30 s). The driver works around it, and its test suites run on Node 26. Node 24
  doesn't have the problem.

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
