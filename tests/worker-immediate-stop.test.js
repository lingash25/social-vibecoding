'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildTurnStopScript } = require('../src/services/worker');

// Execute the shipped shell algorithm against real, disposable processes.
// A scoped procfs view contains ONLY processes spawned by this test: the
// production process matcher is never allowed to signal anything on the host.
test('hard Stop terminates an agent and its tool child, preserves unrelated work, and confirms exit', { skip: process.platform !== 'linux' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'immediate-stop-'));
  const proc = path.join(dir, 'proc');
  fs.mkdirSync(proc);
  const token = `stop-fixture-${process.pid}-${Date.now()}`;
  const tree = spawn(process.execPath, ['-e', `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.on('SIGTERM', () => {});
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `, token], { stdio: ['ignore', 'pipe', 'pipe'] });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  let childPid;
  const gone = (pid) => {
    try { return /^[ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return true; throw error; }
  };
  try {
    childPid = await new Promise((resolve, reject) => {
      let stderr = '';
      tree.stderr.on('data', (data) => { stderr += data; });
      const timer = setTimeout(() => reject(new Error(`Fixture did not start: ${stderr}`)), 15000);
      tree.once('error', (error) => { clearTimeout(timer); reject(error); });
      tree.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${stderr}`)); });
      tree.stdout.once('data', (data) => { clearTimeout(timer); resolve(Number(String(data).trim())); });
    });
    assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
    for (const pid of [tree.pid, childPid, unrelated.pid]) fs.symlinkSync(`/proc/${pid}`, path.join(proc, String(pid)));
    const journal = path.join(dir, 'turn.log');
    fs.writeFileSync(journal, 'existing progress\n');
    const production = buildTurnStopScript(journal, { force: true });
    const matchers = [...production.matchAll(/grep -qE '([^']+)'/g)].map((m) => m[1]);
    assert.equal(matchers.length, 1, 'one root selection before walking children');
    const script = production.replaceAll('/proc/', `${proc}/`)
      .replace(matchers[0], `(^| )${token}( |$)`);
    const start = performance.now();
    const { stdout } = await promisify(execFile)('sh', ['-c', script], { timeout: 15000 });
    const elapsed = performance.now() - start;
    assert.match(stdout, /__USERNODE_STOP_CONFIRMED__/);
    assert.equal(gone(tree.pid), true);
    assert.equal(gone(childPid), true, 'a tool child must not keep writing after its agent is killed');
    assert.equal(gone(unrelated.pid), false, 'the warm worker/unrelated work is preserved');
    assert.match(fs.readFileSync(journal, 'utf8'), /^existing progress\n__USERNODE_EXIT__ 137\n$/);
    // Record latency without making a loaded CI runner satisfy a wall-clock
    // benchmark. worker-stop-turn.test.js pins the absence of grace timers.
    console.log(`Immediate Stop process-tree test: ${elapsed.toFixed(0)} ms`);
  } finally {
    for (const pid of [tree.pid, childPid, unrelated.pid]) if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
