// Used by the root-only management script. Values never enter shell expressions.
const path = require('node:path');
const { setEnv } = require('./env-file');

try {
  setEnv(path.join(__dirname, '..', '.env'), process.argv[2], process.env.KUOBOX_VALUE);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
