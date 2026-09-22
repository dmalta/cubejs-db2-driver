# Cube with the DB2 driver, for linux/amd64.
#
# linux/amd64 only: IBM publishes no DB2 CLI driver (clidriver) for linux/arm64,
# and ibm_db's installer refuses to install there. On Apple silicon, build and
# run it emulated:
#   docker build --platform=linux/amd64 -t cube-db2 docker/
#
# DB2 Connect licenses (needed for z/OS / IBM i targets) are not baked into the
# image: mount them at /db2-license (for example from a secret) and the
# entrypoint copies them into the clidriver before Cube starts.

ARG CUBE_VERSION=v1.7.43

FROM --platform=linux/amd64 docker.io/cubejs/cube:${CUBE_VERSION} AS builder

# ibm_db compiles a native addon with node-gyp; the clidriver's libdb2.so
# needs libxml2 at load time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends make g++ libxml2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /cube/conf

# Local tarballs (npm pack) for testing unreleased versions; empty otherwise.
COPY packages/ /tmp/packages/

ARG DRIVER_SPEC=db2-cubejs-driver@npm:@dmalta/db2-cubejs-driver
ARG IBM_DB_VERSION=^4.0.1

# --legacy-peer-deps: the driver's @cubejs-backend/* peers are the image's own
# copies in /cube/node_modules (on NODE_PATH), so none are installed twice.
RUN npm init -y > /dev/null \
  && npm install --omit=dev --legacy-peer-deps --foreground-scripts \
     "${DRIVER_SPEC}" "ibm_db@${IBM_DB_VERSION}" \
  && node -e "require('ibm_db'); require('db2-cubejs-driver')"

FROM --platform=linux/amd64 docker.io/cubejs/cube:${CUBE_VERSION}

# Runtime dependency of the clidriver's libdb2.so.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libxml2 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /cube/conf/node_modules /cube/conf/node_modules
RUN node -e "require('ibm_db'); require('db2-cubejs-driver')"
COPY db2-entrypoint.sh /usr/local/bin/db2-entrypoint.sh
RUN chmod +x /usr/local/bin/db2-entrypoint.sh

ENTRYPOINT ["db2-entrypoint.sh"]
CMD ["cubejs", "server"]
