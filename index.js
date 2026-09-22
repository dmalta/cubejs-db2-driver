const fromExports = require('./dist/src');
const { Db2Driver } = require('./dist/src/Db2Driver');

const toExport = Db2Driver;

// eslint-disable-next-line no-restricted-syntax
for (const [key, module] of Object.entries(fromExports)) {
  toExport[key] = module;
}

module.exports = toExport;
