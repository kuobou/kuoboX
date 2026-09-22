'use strict';
// .env 讀寫：值一律經過驗證，不經 shell 展開。
const fs = require('node:fs');

function validate(key, value) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw new Error('設定值不得為空或含換行');
  if (key === 'PANEL_PASSWORD' && value.length < 12) throw new Error('密碼至少需要 12 個字元');
  if (key === 'PANEL_PORT' && (!/^\d+$/.test(value) || +value < 1 || +value > 65535)) throw new Error('端口須為 1–65535');
}

function setEnv(file, key, value) {
  if (!['PANEL_PASSWORD', 'PANEL_PORT'].includes(key)) throw new Error('不允許修改此設定');
  validate(key, value);
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith(key + '=')) : [];
  lines.push(key + '=' + (key === 'PANEL_PORT' ? String(+value) : JSON.stringify(value)));
  fs.writeFileSync(file + '.tmp', lines.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

module.exports = { setEnv };
