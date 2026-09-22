#!/usr/bin/env node
/**
 * Post-install checks. Prints guidance only: it never fails the install.
 */
const fs = require('fs');
const path = require('path');

function note(message) {
  console.log(`db2-cubejs-driver: ${message}`);
}

try {
  // Installed from a source checkout (nothing compiled yet): nothing to check.
  if (!fs.existsSync(path.join(__dirname, '..', 'dist'))) {
    process.exit(0);
  }

  let ibmDbDir;
  try {
    ibmDbDir = path.dirname(require.resolve('ibm_db/package.json'));
  } catch {
    note('"ibm_db" is not installed, so the driver cannot connect. Install it with ' +
      '"npm install ibm_db" (and "npm approve-scripts ibm_db" if npm blocks install scripts). ' +
      'There is no ibm_db build for linux/arm64.');
    process.exit(0);
  }

  const licenseDir = path.join(ibmDbDir, 'installer', 'clidriver', 'license');
  if (fs.existsSync(licenseDir)) {
    const hasLicense = fs.readdirSync(licenseDir).some(f => /^db2consv_.*\.lic$/i.test(f)) ||
      fs.existsSync(path.join(licenseDir, 'nodelock'));
    if (!hasLicense) {
      note('no DB2 Connect license in ' + licenseDir + '. Connecting to DB2 for z/OS or IBM i ' +
        'fails with SQL1598N until a db2consv_*.lic matching the clidriver version is copied there. ' +
        'DB2 LUW needs no license.');
    }
  }
} catch (e) {
  note(`post-install check skipped: ${e && e.message}`);
}
process.exit(0);
