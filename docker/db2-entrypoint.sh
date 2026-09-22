#!/bin/sh
# Copies DB2 Connect license files into the clidriver, then starts Cube.
# The clidriver registers them on first connect (license/nodelock), so its
# directory must stay writable at runtime.
set -e

LICENSE_SRC="${DB2_LICENSE_DIR:-/db2-license}"
CLIDRIVER="$(dirname "$(node -p "require.resolve('ibm_db/package.json')")")/installer/clidriver"

if [ -d "$LICENSE_SRC" ] && ls "$LICENSE_SRC"/*.lic > /dev/null 2>&1; then
  cp "$LICENSE_SRC"/*.lic "$CLIDRIVER/license/"
fi

exec docker-entrypoint.sh "$@"
