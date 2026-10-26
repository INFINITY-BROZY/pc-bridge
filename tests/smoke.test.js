'use strict';

/**
 * End-to-end smoke test. Copies the server to a temporary folder, starts it on
 * an isolated port with a test token, and exercises the public API.
 *
 * No dependencies, no changes to the real workspace, config, or token.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
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
  let remote = null;

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
    assert.strictEqual(ping.version, '1.3.0', 'server version should be 1.3.0');
    assert.strictEqual(ping.paused, false, 'server starts unpaused');
    assert.ok(ping.workspace.endsWith('workspace'), 'default workspace should be used');
    assert.strictEqual(ping.toolCount, 17, 'ping should report 17 server tools');
    for (const tool of ['edit', 'grep', 'find', 'copy', 'hash', 'download', 'fetch', 'system']) {
      assert.ok(ping.tools.includes(tool), `ping tools should include ${tool}`);
    }
    assert.ok(Array.isArray(ping.platforms.builtin), 'ping should list built-in platforms');
    assert.ok(ping.platforms.builtin.some((p) => p.origin === 'https://chat.deepseek.com'), 'DeepSeek should be built in');
    assert.deepStrictEqual(ping.platforms.custom, [], 'no custom platforms by default');
    const workspaceDir = ping.workspace;

    remote = http.createServer((req, res) => {
      if (req.url === '/hello.txt') {
        const body = 'remote hello';
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      } else if (req.url === '/long.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 5000 });
        res.end('x'.repeat(5000));
      } else if (req.url === '/blob.bin') {
        const body = Buffer.from([0x41, 0x00, 0x42, 0x43]);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
        res.end(body);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('missing');
      }
    });
    await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve));
    const remoteBase = `http://127.0.0.1:${remote.address().port}`;

    const dashboard = await fetch(base + '/');
    assert.strictEqual(dashboard.status, 200, 'dashboard should load');
    const html = await dashboard.text();
    assert.ok(html.includes('PC Bridge'), 'dashboard should contain the app name');
    assert.ok(html.includes('Project location'), 'dashboard should contain the location controls');
    assert.ok(html.includes('AI platforms'), 'dashboard should contain the platform manager');

    const unauthorized = await request('/api/ping', { method: 'GET', auth: false });
    assert.strictEqual(unauthorized.status, 401, 'missing token must be rejected');

    /* ---- platforms ---- */

    const platformList = await request('/api/platforms', { method: 'GET' });
    assert.strictEqual(platformList.status, 200);
    assert.deepStrictEqual(platformList.json.custom, []);
    assert.strictEqual(platformList.json.maxCustom, 50);

    const addSite = await request('/api/platforms', {
      body: { action: 'add', origin: 'https://chat.example.com/room/1?x=1' }
    });
    assert.strictEqual(addSite.status, 200, 'custom platform should be added');
    assert.strictEqual(addSite.json.added, true);
    assert.deepStrictEqual(addSite.json.custom, ['https://chat.example.com'], 'site should be stored as an exact origin');
    const savedConfig = JSON.parse(fs.readFileSync(path.join(serverDir, 'config.json'), 'utf8'));
    assert.deepStrictEqual(savedConfig.customPlatforms, ['https://chat.example.com'], 'custom platform should persist');

    const preflight = await fetch(base + '/api/ping', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://chat.example.com',
        'Access-Control-Request-Method': 'GET'
      }
    });
    assert.strictEqual(preflight.status, 204, 'approved custom origin should pass preflight');
    assert.strictEqual(preflight.headers.get('access-control-allow-origin'), 'https://chat.example.com');

    const preflightDenied = await fetch(base + '/api/ping', {
      method: 'OPTIONS',
      headers: { Origin: 'https://not-allowed.example' }
    });
    assert.strictEqual(preflightDenied.status, 403, 'unknown origin must fail preflight');

    const duplicateSite = await request('/api/platforms', {
      body: { action: 'add', origin: 'https://chat.example.com' }
    });
    assert.strictEqual(duplicateSite.status, 200);
    assert.strictEqual(duplicateSite.json.added, false, 'duplicate site should not be added twice');

    const builtinSite = await request('/api/platforms', {
      body: { action: 'add', origin: 'https://chatgpt.com/' }
    });
    assert.strictEqual(builtinSite.status, 200);
    assert.strictEqual(builtinSite.json.isBuiltin, true, 'built-in site should be detected');
    assert.strictEqual(builtinSite.json.added, false);

    for (const origin of ['', 'ftp://chat.example.com', 'javascript:alert(1)', 'https://user:pass@chat.example.com', 'not a url']) {
      const badSite = await request('/api/platforms', { body: { action: 'add', origin } });
      assert.strictEqual(badSite.status, 400, `invalid platform must be rejected: ${origin}`);
    }

    const addSecondSite = await request('/api/platforms', {
      body: { action: 'add', origin: 'https://chat.example.org' }
    });
    assert.strictEqual(addSecondSite.status, 200);
    assert.deepStrictEqual(addSecondSite.json.custom, ['https://chat.example.com', 'https://chat.example.org']);

    const removeSite = await request('/api/platforms', {
      body: { action: 'remove', origin: 'https://chat.example.com' }
    });
    assert.strictEqual(removeSite.status, 200);
    assert.strictEqual(removeSite.json.removed, 'https://chat.example.com');
    assert.deepStrictEqual(removeSite.json.custom, ['https://chat.example.org']);

    const removeBuiltin = await request('/api/platforms', {
      body: { action: 'remove', origin: 'https://chatgpt.com' }
    });
    assert.strictEqual(removeBuiltin.status, 400, 'built-in platforms cannot be removed');

    const removeMissing = await request('/api/platforms', {
      body: { action: 'remove', origin: 'https://chat.example.com' }
    });
    assert.strictEqual(removeMissing.status, 404);

    const clearSites = await request('/api/platforms', { body: { action: 'clear' } });
    assert.strictEqual(clearSites.status, 200);
    assert.deepStrictEqual(clearSites.json.removed, ['https://chat.example.org']);
    assert.deepStrictEqual(clearSites.json.custom, []);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(serverDir, 'config.json'), 'utf8')).customPlatforms,
      [],
      'cleared platforms should persist'
    );

    const unknownSiteAction = await request('/api/platforms', { body: { action: 'nope' } });
    assert.strictEqual(unknownSiteAction.status, 400);

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

    /* ---- v1.3 tools ---- */

    const writeTool = await request('/api/write', {
      body: { path: 'tools/sample.txt', content: 'alpha\nbeta\ngamma\nbeta' }
    });
    assert.strictEqual(writeTool.status, 200);
    assert.strictEqual(writeTool.json.path, 'tools/sample.txt');

    const appendTool = await request('/api/write', {
      body: { path: 'tools/sample.txt', content: '\ndelta', mode: 'append' }
    });
    assert.strictEqual(appendTool.status, 200);
    assert.strictEqual(appendTool.json.mode, 'append');

    const readAll = await request('/api/read', { body: { path: 'tools/sample.txt' } });
    assert.strictEqual(readAll.json.output, 'alpha\nbeta\ngamma\nbeta\ndelta', 'append should preserve existing content');

    const readRange = await request('/api/read', {
      body: { path: 'tools/sample.txt', offset: 2, limit: 2 }
    });
    assert.strictEqual(readRange.status, 200);
    assert.strictEqual(readRange.json.startLine, 2);
    assert.strictEqual(readRange.json.endLine, 3);
    assert.strictEqual(readRange.json.totalLines, 5);
    assert.ok(readRange.json.output.startsWith('beta\ngamma'), 'read range should return the requested lines');

    const longText = 'x'.repeat(2000);
    await request('/api/write', { body: { path: 'tools/long.txt', content: longText } });
    const readLong = await request('/api/read', { body: { path: 'tools/long.txt', maxBytes: 1024 } });
    assert.strictEqual(readLong.status, 200);
    assert.strictEqual(readLong.json.size, 2000);
    assert.strictEqual(readLong.json.truncated, true, 'read should honor maxBytes');

    const largeContent = 'line\n'.repeat(1300000);
    const largeWrite = await request('/api/write', {
      body: { path: 'tools/large.txt', content: largeContent }
    });
    assert.strictEqual(largeWrite.status, 200, 'write should accept 6.5 MB even after JSON escaping');
    assert.strictEqual(largeWrite.json.bytes, Buffer.byteLength(largeContent, 'utf8'));

    await request('/api/write', { body: { path: 'tools/blob.bin', content: 'AB\u0000CD' } });
    const readBinary = await request('/api/read', { body: { path: 'tools/blob.bin' } });
    assert.strictEqual(readBinary.status, 200);
    assert.strictEqual(readBinary.json.binary, true, 'read should detect binary files');

    const editOne = await request('/api/edit', {
      body: { path: 'tools/sample.txt', oldText: 'alpha', newText: 'ALPHA' }
    });
    assert.strictEqual(editOne.status, 200);
    assert.strictEqual(editOne.json.replacements, 1);

    const editAmbiguous = await request('/api/edit', {
      body: { path: 'tools/sample.txt', oldText: 'beta', newText: 'BETA' }
    });
    assert.strictEqual(editAmbiguous.status, 409, 'edit must refuse ambiguous oldText without replaceAll');

    const editAll = await request('/api/edit', {
      body: { path: 'tools/sample.txt', oldText: 'beta', newText: 'BETA', replaceAll: true }
    });
    assert.strictEqual(editAll.status, 200);
    assert.strictEqual(editAll.json.replacements, 2);

    const editArray = await request('/api/edit', {
      body: {
        path: 'tools/sample.txt',
        edits: [
          { oldText: 'gamma', newText: 'GAMMA' },
          { oldText: 'delta', newText: 'DELTA' }
        ]
      }
    });
    assert.strictEqual(editArray.status, 200);
    assert.strictEqual(editArray.json.edits, 2);

    const editMissingText = await request('/api/edit', {
      body: { path: 'tools/sample.txt', oldText: 'not-present', newText: 'x' }
    });
    assert.strictEqual(editMissingText.status, 409);

    const editBinary = await request('/api/edit', {
      body: { path: 'tools/blob.bin', oldText: 'AB', newText: 'ZZ' }
    });
    assert.strictEqual(editBinary.status, 400, 'edit must refuse binary files');

    await request('/api/write', { body: { path: 'search/a.js', content: 'const a = 1; // TODO: alpha\nconst b = 2;\n' } });
    await request('/api/write', { body: { path: 'search/b.txt', content: 'TODO: beta\nno match here\n' } });
    await request('/api/write', { body: { path: 'search/nested/c.jsx', content: 'export default function C() { return null; } // TODO gamma\n' } });
    await request('/api/write', { body: { path: 'search/.hidden.js', content: 'TODO hidden\n' } });

    const grep = await request('/api/grep', {
      body: { path: 'search', pattern: 'TODO', include: '**/*.{js,jsx}' }
    });
    assert.strictEqual(grep.status, 200);
    assert.strictEqual(grep.json.matches, 2, 'grep should honor include globs and skip hidden files');
    assert.ok(grep.json.output.includes('search/a.js'));
    assert.ok(grep.json.output.includes('search/nested/c.jsx'));

    const grepLiteral = await request('/api/grep', {
      body: { path: 'search', pattern: 'TODO:', literal: true, include: '**/*.txt' }
    });
    assert.strictEqual(grepLiteral.json.matches, 1);

    const grepIgnore = await request('/api/grep', {
      body: { path: 'search', pattern: 'gamma', ignoreCase: true }
    });
    assert.strictEqual(grepIgnore.json.matches, 1);

    const grepContext = await request('/api/grep', {
      body: { path: 'search/a.js', pattern: 'alpha', context: 1 }
    });
    assert.strictEqual(grepContext.status, 200);
    assert.ok(grepContext.json.output.includes('search/a.js-2-'), 'grep should include context lines');

    const grepHidden = await request('/api/grep', {
      body: { path: 'search', pattern: 'TODO', includeHidden: true, include: '**/*.js' }
    });
    assert.strictEqual(grepHidden.json.matches, 2, 'grep should include hidden files when asked');

    const grepInvalid = await request('/api/grep', { body: { path: 'search', pattern: '[' } });
    assert.strictEqual(grepInvalid.status, 400, 'grep should reject invalid regular expressions');

    const findJs = await request('/api/find', {
      body: { path: 'search', pattern: '**/*.js', type: 'file' }
    });
    assert.strictEqual(findJs.status, 200);
    assert.strictEqual(findJs.json.entries.length, 1);
    assert.strictEqual(findJs.json.entries[0].path, 'a.js');

    const findDirs = await request('/api/find', {
      body: { path: 'search', pattern: 'nested', type: 'dir' }
    });
    assert.strictEqual(findDirs.json.entries.length, 1);
    assert.strictEqual(findDirs.json.entries[0].type, 'dir');

    const findHidden = await request('/api/find', {
      body: { path: 'search', pattern: '**/*.js', includeHidden: true, type: 'file' }
    });
    assert.strictEqual(findHidden.json.entries.length, 2, 'find should include hidden files when asked');

    const findLimited = await request('/api/find', {
      body: { path: 'search', pattern: '*', limit: 1 }
    });
    assert.strictEqual(findLimited.json.entries.length, 1);
    assert.strictEqual(findLimited.json.truncated, true);

    const findNone = await request('/api/find', { body: { path: 'search', pattern: '*.nope' } });
    assert.strictEqual(findNone.json.entries.length, 0);

    const listAll = await request('/api/list', { body: { path: 'search' } });
    assert.ok(listAll.json.entries.some((e) => e.path === '.hidden.js'), 'list should include hidden entries by default');

    const listVisible = await request('/api/list', { body: { path: 'search', all: false } });
    assert.ok(!listVisible.json.entries.some((e) => e.path === '.hidden.js'), 'list should hide dotfiles when all is false');

    const listRecursive = await request('/api/list', {
      body: { path: 'search', recursive: true, depth: 2 }
    });
    assert.strictEqual(listRecursive.status, 200);
    assert.ok(listRecursive.json.output.includes('nested/c.jsx'), 'recursive list should include nested files');

    const listShallow = await request('/api/list', {
      body: { path: 'search', recursive: true, depth: 1 }
    });
    assert.ok(!listShallow.json.output.includes('nested/c.jsx'), 'depth should limit recursive listing');

    const listLimited = await request('/api/list', {
      body: { path: 'search', recursive: true, limit: 2 }
    });
    assert.strictEqual(listLimited.json.entries.length, 2);
    assert.strictEqual(listLimited.json.truncated, true);

    await request('/api/write', { body: { path: 'tools/copy-src.txt', content: 'copy me' } });
    const copyFile = await request('/api/copy', {
      body: { from: 'tools/copy-src.txt', to: 'tools/copy-dest.txt' }
    });
    assert.strictEqual(copyFile.status, 200);
    assert.strictEqual(fs.readFileSync(path.join(workspaceDir, 'tools', 'copy-dest.txt'), 'utf8'), 'copy me');

    const copyAgain = await request('/api/copy', {
      body: { from: 'tools/copy-src.txt', to: 'tools/copy-dest.txt' }
    });
    assert.strictEqual(copyAgain.status, 409, 'copy must not overwrite without permission');

    const copyOverwrite = await request('/api/copy', {
      body: { from: 'tools/copy-src.txt', to: 'tools/copy-dest.txt', overwrite: true }
    });
    assert.strictEqual(copyOverwrite.status, 200);

    await request('/api/write', { body: { path: 'tools/dir-src/sub/nested.txt', content: 'nested' } });
    const copyDir = await request('/api/copy', {
      body: { from: 'tools/dir-src', to: 'tools/dir-copy' }
    });
    assert.strictEqual(copyDir.status, 200);
    assert.strictEqual(
      fs.readFileSync(path.join(workspaceDir, 'tools', 'dir-copy', 'sub', 'nested.txt'), 'utf8'),
      'nested',
      'copy should include folder contents'
    );

    const copyInside = await request('/api/copy', {
      body: { from: 'tools/dir-src', to: 'tools/dir-src/sub/inner' }
    });
    assert.strictEqual(copyInside.status, 400, 'copy must refuse to copy a folder inside itself');

    await request('/api/write', { body: { path: 'tools/move-src.txt', content: 'move me' } });
    await request('/api/write', { body: { path: 'tools/move-existing.txt', content: 'old' } });
    const moveNoOverwrite = await request('/api/move', {
      body: { from: 'tools/move-src.txt', to: 'tools/move-existing.txt' }
    });
    assert.strictEqual(moveNoOverwrite.status, 409, 'move must not overwrite without permission');

    const moveOverwrite = await request('/api/move', {
      body: { from: 'tools/move-src.txt', to: 'tools/move-existing.txt', overwrite: true }
    });
    assert.strictEqual(moveOverwrite.status, 200);
    assert.strictEqual(fs.readFileSync(path.join(workspaceDir, 'tools', 'move-existing.txt'), 'utf8'), 'move me');

    const moveTypeMismatch = await request('/api/move', {
      body: { from: 'tools/copy-src.txt', to: 'tools/dir-src' }
    });
    assert.strictEqual(moveTypeMismatch.status, 409, 'move must refuse a file/folder type mismatch');

    const moveInside = await request('/api/move', {
      body: { from: 'tools/dir-src', to: 'tools/dir-src/sub' }
    });
    assert.strictEqual(moveInside.status, 400, 'move must refuse to move a folder inside itself');

    const moveMissing = await request('/api/move', {
      body: { from: 'tools/no-such-file.txt', to: 'tools/anywhere.txt' }
    });
    assert.strictEqual(moveMissing.status, 404);

    const removeMissingTool = await request('/api/remove', { body: { path: 'tools/no-such-file.txt' } });
    assert.strictEqual(removeMissingTool.status, 404);

    await request('/api/write', { body: { path: 'tools/remove-dir/sub/file.txt', content: 'x' } });
    const removeNonEmpty = await request('/api/remove', { body: { path: 'tools/remove-dir' } });
    assert.strictEqual(removeNonEmpty.status, 400, 'remove must require recursive for non-empty folders');

    const removeDir = await request('/api/remove', { body: { path: 'tools/remove-dir', recursive: true } });
    assert.strictEqual(removeDir.status, 200);

    const removeFile = await request('/api/remove', { body: { path: 'tools/copy-dest.txt' } });
    assert.strictEqual(removeFile.status, 200);

    const removeRoot = await request('/api/remove', { body: { path: '.' } });
    assert.strictEqual(removeRoot.status, 400, 'remove must refuse the workspace root');

    const expectedSha = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(workspaceDir, 'tools', 'sample.txt')))
      .digest('hex');
    const hashOne = await request('/api/hash', { body: { path: 'tools/sample.txt', algorithm: 'sha256' } });
    assert.strictEqual(hashOne.status, 200);
    assert.strictEqual(hashOne.json.results[0].hash, expectedSha);

    const expectedMd5 = crypto.createHash('md5')
      .update(fs.readFileSync(path.join(workspaceDir, 'tools', 'sample.txt')))
      .digest('hex');
    const hashMd5 = await request('/api/hash', { body: { path: 'tools/sample.txt', algorithm: 'md5' } });
    assert.strictEqual(hashMd5.json.results[0].hash, expectedMd5);

    const hashMany = await request('/api/hash', {
      body: { paths: ['tools/sample.txt', 'tools/copy-src.txt'], algorithm: 'sha1' }
    });
    assert.strictEqual(hashMany.json.results.length, 2);

    const hashBadAlgorithm = await request('/api/hash', {
      body: { path: 'tools/sample.txt', algorithm: 'crc32' }
    });
    assert.strictEqual(hashBadAlgorithm.status, 400);

    const hashMissing = await request('/api/hash', { body: { path: 'tools/no-such-file.txt' } });
    assert.strictEqual(hashMissing.status, 404);

    const hashDirectory = await request('/api/hash', { body: { path: 'tools/dir-src' } });
    assert.strictEqual(hashDirectory.status, 400, 'hash should require a file');

    const statTool = await request('/api/stat', { body: { path: 'tools/sample.txt' } });
    assert.strictEqual(statTool.status, 200);
    assert.strictEqual(statTool.json.type, 'file');
    assert.strictEqual(statTool.json.symlink, false);
    assert.ok(statTool.json.birthtime);
    assert.ok(statTool.json.atime);

    const fetchText = await request('/api/fetch', {
      body: { url: remoteBase + '/hello.txt', maxBytes: 1024 }
    });
    assert.strictEqual(fetchText.status, 200);
    assert.strictEqual(fetchText.json.httpStatus, 200);
    assert.strictEqual(fetchText.json.binary, false);
    assert.strictEqual(fetchText.json.output, 'remote hello');

    const fetchMissing = await request('/api/fetch', { body: { url: remoteBase + '/missing' } });
    assert.strictEqual(fetchMissing.status, 200);
    assert.strictEqual(fetchMissing.json.httpStatus, 404);
    assert.strictEqual(fetchMissing.json.httpOk, false);
    assert.ok(fetchMissing.json.output.includes('missing'));

    const fetchLong = await request('/api/fetch', {
      body: { url: remoteBase + '/long.txt', maxBytes: 1024 }
    });
    assert.strictEqual(fetchLong.json.truncated, true);
    assert.strictEqual(fetchLong.json.bytes, 1024);

    const fetchBinary = await request('/api/fetch', { body: { url: remoteBase + '/blob.bin' } });
    assert.strictEqual(fetchBinary.json.binary, true);
    assert.ok(fetchBinary.json.output.includes('binary response'));

    const fetchBadUrl = await request('/api/fetch', { body: { url: 'ftp://example.com/file' } });
    assert.strictEqual(fetchBadUrl.status, 400);

    const fetchCredentials = await request('/api/fetch', {
      body: { url: 'https://user:pass@example.com/' }
    });
    assert.strictEqual(fetchCredentials.status, 400, 'fetch must refuse embedded credentials');

    const download = await request('/api/download', {
      body: { url: remoteBase + '/hello.txt', path: 'downloads/remote.txt' }
    });
    assert.strictEqual(download.status, 200);
    assert.strictEqual(download.json.bytes, 12);
    assert.strictEqual(
      fs.readFileSync(path.join(workspaceDir, 'downloads', 'remote.txt'), 'utf8'),
      'remote hello'
    );

    const downloadAgain = await request('/api/download', {
      body: { url: remoteBase + '/hello.txt', path: 'downloads/remote.txt' }
    });
    assert.strictEqual(downloadAgain.status, 409, 'download must not overwrite without permission');

    const downloadOverwrite = await request('/api/download', {
      body: { url: remoteBase + '/hello.txt', path: 'downloads/remote.txt', overwrite: true }
    });
    assert.strictEqual(downloadOverwrite.status, 200);

    const downloadFolder = await request('/api/download', {
      body: { url: remoteBase + '/hello.txt', path: 'downloads', overwrite: true }
    });
    assert.strictEqual(downloadFolder.status, 409, 'download must refuse to overwrite a folder');

    const downloadTooLarge = await request('/api/download', {
      body: { url: remoteBase + '/long.txt', path: 'downloads/long.txt', maxBytes: 1024 }
    });
    assert.strictEqual(downloadTooLarge.status, 413, 'download should enforce maxBytes');
    assert.strictEqual(fs.existsSync(path.join(workspaceDir, 'downloads', 'long.txt.pcb-part')), false);

    const systemTool = await request('/api/system', { body: {} });
    assert.strictEqual(systemTool.status, 200);
    assert.strictEqual(systemTool.json.system.platform, process.platform);
    assert.ok(systemTool.json.system.cpu.count > 0);
    assert.ok(systemTool.json.system.memory.total > 0);
    assert.ok(systemTool.json.output.includes('OS:'));

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
    console.log('  checks: auth, platforms, custom CORS, write, append, read ranges, edit, grep, find, copy, hash, fetch, download, system, move, remove, exec, traversal, full PC access, workspace, pause');
  } finally {
    if (child) {
      child.kill();
      await sleep(300);
    }
    if (remote) {
      await new Promise((resolve) => remote.close(resolve));
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
