const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createConfigStore, revision } = require('../lib/config-store');

async function fixture(t, handler = () => null, initial = '{"dns":{"servers":[]},"custom":true}') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kuobox-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  if (initial !== null) await fs.writeFile(file, initial);
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    return await handler(cmd, args) || { ok: true, stdout: args[0] === 'is-active' ? 'active' : '', stderr: '' };
  };
  return { file, dir, calls, store: createConfigStore(file, run, async () => {}), initial: initial || '' };
}

test('preserves arbitrary config and comments, validates before replacement', async t => {
  const f = await fixture(t, async (cmd, args) => {
    if (cmd === 'sing-box') {
      assert.equal(await fs.readFile(f.file, 'utf8'), f.initial);
      assert.notEqual(args[2], f.file);
    }
  });
  const next = '// comment\n{"dns":{},"route":{"rules":[]},"experimental":{"cache_file":{"enabled":true}}}';
  const result = await f.store.apply(next, revision(f.initial));
  assert.equal(result.revision, revision(next));
  assert.equal(await f.store.read(), next);
  assert.equal(await fs.readFile(f.file + '.bak', 'utf8'), f.initial);
});
test('invalid config never changes or restarts the active service', async t => {
  const f = await fixture(t, cmd => cmd === 'sing-box' ? { ok: false, stdout: 'invalid config', stderr: '' } : null);
  await assert.rejects(f.store.apply('bad', revision(f.initial)), /invalid config/);
  assert.equal(await f.store.read(), f.initial);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await fs.readdir(f.dir), ['config.json']);
});
test('missing core cannot silently bypass validation', async t => {
  const f = await fixture(t, cmd => cmd === 'sing-box' ? { ok: false, stderr: 'ENOENT' } : null);
  await assert.rejects(f.store.apply('{}', revision(f.initial)), /ENOENT/);
  assert.equal(await f.store.read(), f.initial);
});
test('restart failure restores original config and restarts previous service', async t => {
  let restarts = 0;
  const f = await fixture(t, (cmd, args) => args[0] === 'restart' && ++restarts === 1 ? { ok: false, stderr: 'start failed' } : null);
  await assert.rejects(f.store.apply('{}', revision(f.initial)), /已還原/);
  assert.equal(await f.store.read(), f.initial);
  assert.equal(restarts, 2);
});
test('first-install failure removes rejected config and preserves stopped state', async t => {
  const f = await fixture(t, (cmd, args) => args[0] === 'is-active' ? { ok: false, stdout: 'inactive' } : null, null);
  await assert.rejects(f.store.apply('{}', revision('')), /已還原/);
  assert.equal(await f.store.read(), '');
  assert.ok(f.calls.some(([, args]) => args[0] === 'stop'));
});
test('rollback failure is explicitly reported', async t => {
  const f = await fixture(t, (cmd, args) => args[0] === 'restart' ? { ok: false, stderr: 'failed' } : null);
  await assert.rejects(f.store.apply('{}', revision(f.initial)), /還原失敗/);
});
test('stale or absent revisions do not overwrite config', async t => {
  const f = await fixture(t);
  for (const rev of [undefined, revision('old')]) await assert.rejects(f.store.apply('{}', rev), { status: 409 });
  assert.equal(f.calls.length, 0);
});
test('external changes during validation are preserved', async t => {
  const f = await fixture(t, async cmd => { if (cmd === 'sing-box') await fs.writeFile(f.file, 'external'); });
  await assert.rejects(f.store.apply('{}', revision(f.initial)), { status: 409 });
  assert.equal(await f.store.read(), 'external');
});
test('concurrent writes and service operations are rejected', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async cmd => { if (cmd === 'sing-box') await waiting; });
  const first = f.store.apply('{}', revision(f.initial));
  await assert.rejects(f.store.apply('{}', revision(f.initial)), { status: 409 });
  await assert.rejects(f.store.control('stop'), { status: 409 });
  release(); await first;
  assert.equal(f.store.busy, false);
});
