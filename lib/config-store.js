const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const revision = content => crypto.createHash('sha256').update(content).digest('hex');

function createConfigStore(configPath, run, settle = () => new Promise(resolve => setTimeout(resolve, 1500))) {
  let busy = false;
  async function read() {
    try { return await fs.readFile(configPath, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
  }
  async function apply(config, expectedRevision) {
    if (busy) throw Object.assign(new Error('另一個設定操作正在進行，請稍後重試'), { status: 409 });
    if (typeof config !== 'string' || !config.trim()) throw Object.assign(new Error('設定不得為空'), { status: 400 });
    // Let the installed sing-box validate its complete configuration, including JSON comments.
    busy = true;
    const tmp = configPath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    let previous, metadata, replaced = false, wasRunning = false;
    async function preserveAccess() {
      if (!metadata) return;
      if (process.platform !== 'win32') await fs.chown(tmp, metadata.uid, metadata.gid);
      await fs.chmod(tmp, metadata.mode & 0o777);
    }
    try {
      previous = await read();
      metadata = await fs.stat(configPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (expectedRevision !== revision(previous)) throw Object.assign(new Error('設定已變更，請重新載入後再儲存'), { status: 409 });
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(tmp, config, { mode: 0o600, flag: 'wx', flush: true });
      const check = await run('sing-box', ['check', '-c', tmp]);
      if (!check.ok) throw Object.assign(new Error('設定驗證失敗：' + (check.stderr || check.stdout)), { status: 400 });
      wasRunning = (await run('systemctl', ['is-active', 'sing-box'])).stdout === 'active';
      if (await read() !== previous) throw Object.assign(new Error('驗證期間設定已被外部修改，請重新載入'), { status: 409 });
      if (previous) {
        await fs.writeFile(configPath + '.bak', previous, { mode: 0o600 });
        await fs.chmod(configPath + '.bak', 0o600);
      }
      await preserveAccess();
      await fs.rename(tmp, configPath);
      replaced = true;
      const restart = await run('systemctl', ['restart', 'sing-box']);
      await settle();
      const status = await run('systemctl', ['is-active', 'sing-box']);
      if (!restart.ok || status.stdout !== 'active') throw new Error('重啟失敗：' + (restart.stderr || status.stdout));
      return { ok: true, revision: revision(config) };
    } catch (e) {
      if (replaced) {
        try {
          if (previous) {
            await fs.writeFile(tmp, previous, { mode: 0o600 });
            await preserveAccess();
            await fs.rename(tmp, configPath);
          } else await fs.unlink(configPath);
          const restored = await run('systemctl', [wasRunning ? 'restart' : 'stop', 'sing-box']);
          await settle();
          const state = await run('systemctl', ['is-active', 'sing-box']);
          if (!restored.ok || (wasRunning && state.stdout !== 'active')) throw new Error(restored.stderr || state.stdout);
          e.message += '；已還原原設定與服務狀態';
        } catch (rollback) { e.message += '；還原失敗，請檢查 .bak 與服務日誌：' + rollback.message; }
      }
      throw e;
    } finally {
      await fs.unlink(tmp).catch(() => {});
      busy = false;
    }
  }
  // 只驗證、不寫入：暫存檔放在設定目錄，讓相對路徑（rule-set 等）與正式執行一致
  async function check(config) {
    if (typeof config !== 'string' || !config.trim()) throw Object.assign(new Error('設定不得為空'), { status: 400 });
    const tmp = configPath + '.' + crypto.randomBytes(8).toString('hex') + '.check';
    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(tmp, config, { mode: 0o600, flag: 'wx' });
      const result = await run('sing-box', ['check', '-c', tmp]);
      if (!result.ok) throw Object.assign(new Error('設定驗證失敗：' + (result.stderr || result.stdout)), { status: 400 });
      return { ok: true };
    } finally { await fs.unlink(tmp).catch(() => {}); }
  }
  async function control(action) {
    if (busy) throw Object.assign(new Error('另一個服務操作正在進行'), { status: 409 });
    busy = true;
    try {
      const result = await run('systemctl', [action, 'sing-box']);
      if (!result.ok) throw new Error(result.stderr || '服務操作失敗');
      await settle();
      const status = await run('systemctl', ['is-active', 'sing-box']);
      if (action !== 'stop' && status.stdout !== 'active') {
        const log = await run('journalctl', ['-u', 'sing-box', '-n', '3', '--no-pager', '--output=cat']);
        throw new Error('服務未正常啟動：' + (log.stdout || status.stdout));
      }
      return { ok: true, status: status.stdout };
    } finally { busy = false; }
  }
  return { read, apply, check, control, get busy() { return busy; } };
}

module.exports = { createConfigStore, revision };
