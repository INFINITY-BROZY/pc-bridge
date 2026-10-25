'use strict';

/**
 * End-to-end smoke test. Copies the server to a temporary folder, starts it on
 * an isolated port with a test token, and exercises the public API.
 *
 * No dependencies, no changes to the real workspace, config, or token.
 */

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bridge-smoke-'));
  const serverDir = path.join(tmp, 'server');
  const firstWorkspace = path.join(tmp, 'projects-one');
  const secondWorkspace = path.join(tmp, 'projects-two');
  const token = 'smoke-test-token-0123456789abcdef';
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  let output = '';

  fs.mkdirSync(serverDir, { recursive: true });
  for (const name of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(ROOT, 'server', name), path.join(serverDir, name));
  }
  fs.cpSync(path.join(ROOT, 'server', 'public'), path.join(serverDir, 'public'), { recursive: true });

  async function request(endpoint, { method = 'POST', body, auth = true } = {}) {
    const res = await fetch(base + endpoint, {
      method,
      headers: {
        ...(auth ? { 'X-Bridge-Token': token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  async function waitForServer() {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const res = await request('/api/ping', { method: 'GET' });
        if (res.status === 200 && res.json.ok) return res.json;
      } catch {
        /* not up yet */
      }
      await sleep(150);
    }
    throw new Error(`Server did not start.\n${output}`);
  }

  try {
    child = spawn(process.execPath, ['server.js'], {
      cwd: serverDir,
      env: {
        ...process.env,
        PC_BRIDGE_PORT: String(port),
        PC_BRIDGE_TOKEN: token,
        PC_BRIDGE_DEV: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });

    const ping = await waitForServer();
    assert.strictEqual(ping.ok, true, 'ping should succeed');
    assert.strictEqual(ping.paused, false, 'server starts unpaused');
    assert.ok(ping.workspace.endsWith('workspace'), 'default workspace should be used');

    const dashboard = await fetch(base + '/');
    assert.strictEqual(dashboard.status, 200, 'dashboard should load');
    const html = await dashboard.text();
    assert.ok(html.includes('PC Bridge'), 'dashboard should contain the app name');
    assert.ok(html.includes('Project location'), 'dashboard should contain the location controls');

    const unauthorized = await request('/api/ping', { method: 'GET', auth: false });
    assert.strictEqual(unauthorized.status, 401, 'missing token must be rejected');

    const write = await request('/api/write', { body: { path: 'hello.txt', content: 'hello bridge' } });
    assert.strictEqual(write.status, 200, 'write should succeed');
    assert.strictEqual(write.json.ok, true);

    const read = await request('/api/read', { body: { path: 'hello.txt' } });
    assert.strictEqual(read.json.output, 'hello bridge', 'read should return written content');

    const dotWrite = await request('/api/write', { body: { path: '..notes/inside.txt', content: 'dots' } });
    assert.strictEqual(dotWrite.status, 200, 'folder names beginning with two dots must remain inside the workspace');

    const list = await request('/api/list', { body: { path: '.' } });
    assert.strictEqual(list.status, 200);
    assert.ok(JSON.stringify(list.json).includes('hello.txt'), 'list should include the file');

    const mkdir = await request('/api/mkdir', { body: { path: 'src' } });
    assert.strictEqual(mkdir.status, 200);

    const move = await request('/api/move', { body: { from: 'hello.txt', to: 'src/hello.txt' } });
    assert.strictEqual(move.status, 200);

    const stat = await request('/api/stat', { body: { path: 'src/hello.txt' } });
    assert.strictEqual(stat.status, 200);
    assert.strictEqual(stat.json.type, 'file');

    const command = process.platform === 'win32' ? 'Write-Output SMOKE_OK' : 'echo SMOKE_OK';
    const exec = await request('/api/exec', { body: { command, cwd: 'src' } });
    assert.strictEqual(exec.status, 200);
    assert.strictEqual(exec.json.exitCode, 0);
    assert.ok(exec.json.output.includes('SMOKE_OK'), 'exec should return stdout');

    const escape = await request('/api/write', { body: { path: '../escape.txt', content: 'nope' } });
    assert.strictEqual(escape.status, 403, 'path traversal must be rejected');

    const noConfirm = await request('/api/access', { body: { fullPcAccess: true } });
    assert.strictEqual(noConfirm.status, 400, 'full PC access must require confirmation');

    const wrongConfirm = await request('/api/access', { body: { fullPcAccess: true, confirmation: 'yes' } });
    assert.strictEqual(wrongConfirm.status, 400, 'wrong confirmation must be rejected');

    const enableFull = await request('/api/access', { body: { fullPcAccess: true, confirmation: 'FULL PC ACCESS' } });
    assert.strictEqual(enableFull.status, 200);
    assert.strictEqual(enableFull.json.fullPcAccess, true);

    const pingFull = await request('/api/ping', { method: 'GET' });
    assert.strictEqual(pingFull.json.fullPcAccess, true, 'ping should report full access');

    const outsideFile = path.join(tmp, 'outside-workspace.txt');
    const outsideWrite = await request('/api/write', { body: { path: outsideFile, content: 'outside' } });
    assert.strictEqual(outsideWrite.status, 200, 'full access should allow an absolute outside path');
    assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), 'outside');

    const outsideRead = await request('/api/read', { body: { path: outsideFile } });
    assert.strictEqual(outsideRead.status, 200);
    assert.strictEqual(outsideRead.json.output, 'outside');

    const rootMove = await request('/api/move', { body: { from: outsideFile, to: path.parse(outsideFile).root } });
    assert.strictEqual(rootMove.status, 400, 'full access must still refuse a drive root destination');

    const protectedRemove = await request('/api/remove', {
      body: { path: path.join(serverDir, 'guard-test-does-not-exist') }
    });
    assert.strictEqual(protectedRemove.status, 400, 'full access must still refuse the Bridge server folder');

    const disableFull = await request('/api/access', { body: { fullPcAccess: false } });
    assert.strictEqual(disableFull.status, 200);
    assert.strictEqual(disableFull.json.fullPcAccess, false);

    const blockedAgain = await request('/api/write', { body: { path: outsideFile, content: 'nope' } });
    assert.strictEqual(blockedAgain.status, 403, 'disabling full access must restore workspace confinement');

    const change = await request('/api/workspace', { body: { path: secondWorkspace } });
    assert.strictEqual(change.status, 200);
    assert.strictEqual(change.json.workspace, secondWorkspace);

    const isolated = await request('/api/write', { body: { path: 'only-here.txt', content: 'moved' } });
    assert.strictEqual(isolated.status, 200);
    assert.strictEqual(fs.readFileSync(path.join(secondWorkspace, 'only-here.txt'), 'utf8'), 'moved');
    assert.strictEqual(fs.existsSync(path.join(firstWorkspace, 'only-here.txt')), false);

    const root = path.parse(os.tmpdir()).root;
    const badWorkspace = await request('/api/workspace', { body: { path: root } });
    assert.strictEqual(badWorkspace.status, 400, 'drive root must be rejected');

    const pause = await request('/api/control', { body: { paused: true } });
    assert.strictEqual(pause.json.ok, true);
    assert.strictEqual(pause.json.paused, true);

    const blocked = await request('/api/exec', { body: { command } });
    assert.strictEqual(blocked.status, 423, 'paused server must block tools');

    const resume = await request('/api/control', { body: { paused: false } });
    assert.strictEqual(resume.json.paused, false);

    const log = await request('/api/log', { method: 'GET' });
    assert.strictEqual(log.status, 200);
    assert.ok(Array.isArray(log.json.entries), 'log entries should be an array');

    console.log('SMOKE TEST PASSED');
    console.log(`  port: ${port}`);
    console.log(`  workspace: ${firstWorkspace} -> ${secondWorkspace}`);
    console.log(`  checks: auth, write, read, list, mkdir, move, stat, exec, traversal, full PC access, workspace, pause`);
  } finally {
    if (child) {
      child.kill();
      await sleep(300);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED');
  console.error(err.stack || err.message);
  process.exit(1);
});
