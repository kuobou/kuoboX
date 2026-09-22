// Used by the root-only management script. Values never enter shell expressions.
const fs = require('node:fs');
const path = require('node:path');
const key = process.argv[2];
const value = process.env.KUOBOX_VALUE;
if (!['PANEL_PASSWORD', 'PANEL_PORT'].includes(key) || !value || /[\r\n\0]/.test(value)) throw new Error('Invalid setting');
if (key === 'PANEL_PASSWORD' && value.length < 12) throw new Error('Password requires at least 12 characters');
if (key === 'PANEL_PORT' && (!/^\d+$/.test(value) || +value < 1 || +value > 65535)) throw new Error('Invalid port');
const file = path.join(__dirname, '..', '.env');
const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.startsWith(key + '=')) : [];
lines.push(key + '=' + (key === 'PANEL_PORT' ? String(+value) : JSON.stringify(value)));
fs.writeFileSync(file + '.tmp', lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
fs.renameSync(file + '.tmp', file);
