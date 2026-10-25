'use strict';

/**
 * PC Bridge — local server
 * Lets a browser chat (Chrome extension) execute commands and edit files
 * on this PC. Binds to 127.0.0.1 only and requires a token.
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

const VERSION = '1.2.0';
const SERVER_DIR = __dirname;
const BRIDGE_ROOT = path.resolve(SERVER_DIR, '..');
const PUBLIC_DIR = path.join(SERVER_DIR, 'public');
const CONFIG_PATH = path.join(SERVER_DIR, 'config.json');
const TOKEN_PATH = path.join(SERVER_DIR, 'token.txt');
const LOG_DIR = path.join(BRIDGE_ROOT, 'logs');
const ACTIVITY_LOG = path.join(LOG_DIR, 'activity.jsonl');
const DEV = process.env.PC_BRIDGE_DEV === '1';

const DEFAULT_CONFIG = {
  port: 8787,
  workspace: 'workspace',
  maxOutputBytes: 300000,
  defaultTimeoutSec: 180,
  maxTimeoutSec: 900,
  blockDangerousCommands: true,
  fullPcAccess: false
};

const config = loadConfig();
const TOKEN = loadToken();
const PORT = Number(process.env.PC_BRIDGE_PORT || config.port || 8787);

let paused = false;
let shuttingDown = false;
let activitySeq = 0;
const activity = [];
const counters = { exec: 0, write: 0, read: 0 };

/* ------------------------------------------------------------------ */
/* Setup                                                              */
/* ------------------------------------------------------------------ */

function ensureDirSync(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  ensureDirSync(SERVER_DIR);
  ensureDirSync(LOG_DIR);

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
  }

  const user = readJsonSafe(CONFIG_PATH, {});
  const cfg = { ...DEFAULT_CONFIG, ...user };

  cfg.port = Number(cfg.port) || DEFAULT_CONFIG.port;
  cfg.maxOutputBytes = clamp(Number(cfg.maxOutputBytes) || DEFAULT_CONFIG.maxOutputBytes, 10000, 5000000);
  cfg.defaultTimeoutSec = clamp(Number(cfg.defaultTimeoutSec) || DEFAULT_CONFIG.defaultTimeoutSec, 5, 900);
  cfg.maxTimeoutSec = clamp(Number(cfg.maxTimeoutSec) || DEFAULT_CONFIG.maxTimeoutSec, cfg.defaultTimeoutSec, 1800);
  cfg.fullPcAccess = cfg.fullPcAccess === true;

  const rawWorkspace = String(cfg.workspace || 'workspace');
  cfg.workspace = path.isAbsolute(rawWorkspace)
    ? path.normalize(rawWorkspace)
    : path.resolve(BRIDGE_ROOT, rawWorkspace);

  ensureDirSync(cfg.workspace);
  ensureDirSync(path.join(cfg.workspace, '.bridge'));
  return cfg;
}

function loadToken() {
  if (process.env.PC_BRIDGE_TOKEN) return process.env.PC_BRIDGE_TOKEN.trim();
  try {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* first run */
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_PATH, token + '\n', { encoding: 'utf8', mode: 0o600 });
  return token;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------------------------------------------ */
/* Workspace switching                                                */
/* ------------------------------------------------------------------ */

function samePath(a, b) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32'
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

function isOutside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !isOutside(child, parent);
}

function normalizeWorkspaceInput(input) {
  let raw = String(input == null ? '' : input).trim();
  if (!raw) throw new HttpError(400, 'Enter a folder path.');
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1).trim();
  }
  // Let people paste %USERPROFILE%\Projects or ~/Projects.
  raw = raw.replace(/%([^%]+)%/g, (m, name) => process.env[name] || m);
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = path.join(os.homedir(), raw.slice(1));
  }
  if (!raw) throw new HttpError(400, 'Enter a folder path.');
  return path.normalize(path.resolve(BRIDGE_ROOT, raw));
}

function validateWorkspace(abs) {
  const driveRoot = path.parse(abs).root;
  if (samePath(abs, driveRoot)) {
    throw new HttpError(400, 'Choose a folder, not an entire drive.');
  }

  if (samePath(abs, BRIDGE_ROOT) || isInside(BRIDGE_ROOT, abs)) {
    throw new HttpError(400, 'Choose a folder that does not contain the PC Bridge app. Try a subfolder such as Desktop\\Projects.');
  }

  const protectedExact = [
    BRIDGE_ROOT,
    SERVER_DIR,
    os.homedir(),
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData
  ].filter(Boolean);

  for (const bad of protectedExact) {
    if (samePath(abs, bad)) {
      throw new HttpError(400, `That folder is reserved. Choose a subfolder instead: ${abs}`);
    }
  }

  const protectedTrees = [
    SERVER_DIR,
    path.join(BRIDGE_ROOT, 'extension'),
    path.join(BRIDGE_ROOT, 'dev'),
    path.join(BRIDGE_ROOT, 'logs'),
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)']
  ].filter(Boolean);

  for (const bad of protectedTrees) {
    if (samePath(abs, bad) || isInside(abs, bad)) {
      throw new HttpError(400, `That location is inside a protected system or bridge folder: ${abs}`);
    }
  }
}

function prepareWorkspace(abs) {
  try {
    ensureDirSync(abs);
  } catch (err) {
    throw new HttpError(400, `Could not create that folder: ${err.message}`);
  }

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    throw new HttpError(400, `Could not open that folder: ${err.message}`);
  }
  if (!stat.isDirectory()) throw new HttpError(400, 'That path is a file, not a folder.');

  const marker = path.join(abs, '.bridge');
  try {
    ensureDirSync(marker);
    const probe = path.join(marker, '.write-test');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
  } catch (err) {
    throw new HttpError(400, `That folder is not writable: ${err.message}`);
  }
}

function persistConfig(patch) {
  const current = readJsonSafe(CONFIG_PATH, {});
  const next = { ...current, ...patch };
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

function persistWorkspace(abs) {
  persistConfig({ workspace: abs });
}

function setFullPcAccess(enabled) {
  const next = Boolean(enabled);
  if (next !== config.fullPcAccess) {
    persistConfig({ fullPcAccess: next });
    config.fullPcAccess = next;
  }
  return config.fullPcAccess;
}

function setWorkspace(input) {
  const abs = normalizeWorkspaceInput(input);
  validateWorkspace(abs);
  prepareWorkspace(abs);
  persistWorkspace(abs);
  config.workspace = abs;
  ensureDirSync(path.join(config.workspace, '.bridge'));
  return abs;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function timestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function relToWorkspace(abs) {
  const rel = path.relative(config.workspace, abs);
  if (!rel) return '.';
  if (isOutside(abs, config.workspace)) {
    return config.fullPcAccess ? path.normalize(abs) : rel.split(path.sep).join('/');
  }
  return rel.split(path.sep).join('/');
}

function expandFullPath(raw) {
  let value = String(raw);
  value = value.replace(/%([^%]+)%/g, (match, name) => process.env[name] || match);
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(1));
  }
  return value;
}

function resolveInside(input) {
  let raw = input == null || input === '' ? '.' : String(input);
  if (config.fullPcAccess) raw = expandFullPath(raw);
  const abs = path.resolve(config.workspace, raw);
  if (!config.fullPcAccess) {
    if (isOutside(abs, config.workspace)) {
      throw new HttpError(403, `Path is outside the workspace: ${raw}. Enable Full PC access in the dashboard or use a workspace-relative path.`);
    }
  }
  return abs;
}

/* Keep full-PC mode from becoming a one-command way to destroy the OS. */
function pathContains(parent, child) {
  return samePath(parent, child) || isInside(child, parent);
}

function protectedTrees() {
  return [
    SERVER_DIR,
    path.join(BRIDGE_ROOT, 'extension'),
    path.join(BRIDGE_ROOT, 'dev'),
    LOG_DIR,
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData
  ].filter(Boolean).map((p) => path.resolve(p));
}

function assertSafeDestructiveTarget(abs, action) {
  if (!config.fullPcAccess) return;
  const target = path.resolve(abs);
  const root = path.parse(target).root;
  if (samePath(target, root)) {
    throw new HttpError(400, `Refusing to ${action} a drive root: ${target}`);
  }
  const home = os.homedir();
  if (samePath(target, home) || pathContains(target, home)) {
    throw new HttpError(400, `Refusing to ${action} your user profile root: ${target}`);
  }
  for (const tree of protectedTrees()) {
    if (pathContains(tree, target) || pathContains(target, tree)) {
      throw new HttpError(400, `Refusing to ${action} a protected system or Bridge folder: ${target}`);
    }
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function stripAnsi(s) {
  return String(s)
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\u0000/g, '');
}

function normalizeText(s) {
  return stripAnsi(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function shortCommand(cmd) {
  const oneLine = String(cmd).replace(/\s+/g, ' ').trim();
  return oneLine.length > 140 ? oneLine.slice(0, 137) + '...' : oneLine;
}

/* ------------------------------------------------------------------ */
/* CORS / auth                                                        */
/* ------------------------------------------------------------------ */

const ALLOWED_ORIGINS = [
  /^chrome-extension:\/\/[a-p]{32}$/,
  /^https:\/\/chat\.deepseek\.com$/,
  /^https:\/\/chatgpt\.com$/,
  /^https:\/\/chat\.openai\.com$/,
  /^https:\/\/claude\.ai$/,
  /^https:\/\/gemini\.google\.com$/,
  /^https:\/\/grok\.com$/,
  /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/
];

function originAllowed(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGINS.some((re) => re.test(origin));
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Token, Authorization',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '86400'
  };
  if (origin && originAllowed(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function authorized(req) {
  const header = req.headers['x-bridge-token'] || '';
  const auth = req.headers['authorization'] || '';
  const supplied = header || (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '');
  if (!supplied) return false;
  const a = crypto.createHash('sha256').update(String(supplied)).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Activity log                                                       */
/* ------------------------------------------------------------------ */

function logActivity(entry) {
  const rec = {
    id: ++activitySeq,
    ts: new Date().toISOString(),
    ...entry
  };
  activity.unshift(rec);
  if (activity.length > 300) activity.pop();
  try {
    fs.appendFile(ACTIVITY_LOG, JSON.stringify(rec) + '\n', () => {});
  } catch {
    /* logging must never break a request */
  }
  const flag = rec.ok === false ? '[fail]' : '[ ok ]';
  console.log(`${flag} ${rec.tool} · ${rec.summary}${rec.error ? ' — ' + rec.error : ''}`);
  return rec;
}

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                      */
/* ------------------------------------------------------------------ */

function sendJson(res, status, obj, origin) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders(origin)
  });
  res.end(body);
}

function sendText(res, status, text, type, origin) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders(origin)
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function serveStatic(res, file, type) {
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

async function serveIndex(res) {
  try {
    let html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    html = html
      .replaceAll('{{TOKEN}}', escapeHtml(TOKEN))
      .replaceAll('{{WORKSPACE}}', escapeHtml(config.workspace))
      .replaceAll('{{VERSION}}', VERSION)
      .replaceAll('{{PORT}}', String(PORT));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'"
    });
    res.end(html);
  } catch (err) {
    sendText(res, 500, 'Dashboard files are missing: ' + err.message);
  }
}

/* ------------------------------------------------------------------ */
/* exec                                                               */
/* ------------------------------------------------------------------ */

const DANGEROUS_PATTERNS = [
  { re: /\bformat(?:\.com)?\s+[a-z]:/i, label: 'format a drive' },
  { re: /\bdiskpart\b/i, label: 'diskpart' },
  { re: /\bbcdedit\b/i, label: 'bcdedit' },
  { re: /\bshutdown(?:\.exe)?\b/i, label: 'shutdown' },
  { re: /\brestart-computer\b/i, label: 'restart the PC' },
  { re: /\bstop-computer\b/i, label: 'shut down the PC' },
  { re: /\bvssadmin\b[\s\S]*\bdelete\b/i, label: 'delete shadow copies' },
  { re: /\bwbadmin\b[\s\S]*\bdelete\b/i, label: 'delete backups' },
  { re: /\bcipher\b[\s\S]*\/w/i, label: 'wipe free space' },
  { re: /\breg(?:\.exe)?\s+delete\s+(?:hklm|hkcr|hku)/i, label: 'delete registry hives' },
  { re: /\b(?:rd|rmdir)\s+\/s\s+\/q\s+[a-z]:\\?\s*$/i, label: 'delete a drive' },
  { re: /\bdel\s+\/[fsq]+\s+[a-z]:\\?\*/i, label: 'delete a drive' },
  { re: /\brm\s+-rf\s+\/(?:\s|$)/i, label: 'rm -rf /' },
  { re: /\bmkfs\b/i, label: 'format a filesystem' },
  { re: /\bdd\s+if=/i, label: 'raw disk write' },
  { re: /\btakeown\b[\s\S]*\/r/i, label: 'take ownership recursively' },
  { re: /\bnet\s+user\b/i, label: 'modify Windows accounts' },
  { re: /\bwmic\b[\s\S]*\bdelete\b/i, label: 'wmic delete' },
  { re: /\bsc(?:\.exe)?\s+delete\b/i, label: 'delete a Windows service' }
];

function checkCommand(command) {
  if (!config.blockDangerousCommands) return null;
  for (const p of DANGEROUS_PATTERNS) {
    if (p.re.test(command)) return p.label;
  }
  return null;
}

function execCommand(command, cwdAbs, shell, timeoutSec) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    let file;
    let args;

    if (!isWin) {
      file = '/bin/sh';
      args = ['-c', command];
    } else if (shell === 'cmd') {
      file = 'cmd.exe';
      args = ['/d', '/s', '/c', 'chcp 65001>nul & ' + command];
    } else {
      file = 'powershell.exe';
      const prefix = '$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ';
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prefix + command];
    }

    const started = Date.now();
    let timedOut = false;
    let finished = false;
    const outChunks = [];
    const errChunks = [];
    let outTotal = 0;
    let errTotal = 0;
    let truncated = false;

    let child;
    try {
      child = spawn(file, args, {
        cwd: cwdAbs,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          npm_config_yes: 'true',
          PYTHONIOENCODING: 'utf-8',
          PC_BRIDGE: '1'
        }
      });
    } catch (err) {
      return resolve({
        exitCode: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: Date.now() - started,
        spawnError: err.message
      });
    }

    const cap = config.maxOutputBytes;
    const collect = (chunk, chunks, totalRef) => {
      const remaining = cap - totalRef.value;
      if (remaining > 0) {
        chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      }
      totalRef.value += chunk.length;
      if (totalRef.value > cap) truncated = true;
    };
    const outRef = { value: 0 };
    const errRef = { value: 0 };

    if (child.stdout) child.stdout.on('data', (d) => collect(d, outChunks, outRef));
    if (child.stderr) child.stderr.on('data', (d) => collect(d, errChunks, errRef));

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        } catch {
          child.kill();
        }
      } else {
        child.kill('SIGKILL');
      }
    }, timeoutSec * 1000);

    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : code == null ? (signal ? -1 : 0) : code,
        stdout: normalizeText(Buffer.concat(outChunks).toString('utf8')),
        stderr: normalizeText(Buffer.concat(errChunks).toString('utf8')),
        timedOut,
        truncated: truncated || outRef.value > cap || errRef.value > cap,
        durationMs: Date.now() - started,
        signal: signal || null
      });
    };

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: normalizeText(String(err.message || err)),
        timedOut: false,
        truncated: false,
        durationMs: Date.now() - started,
        spawnError: err.message
      });
    });
    child.on('close', finish);
  });
}

async function toolExec(body, res, origin) {
  if (paused) return sendJson(res, 423, { ok: false, tool: 'exec', error: 'Bridge is paused. Resume it in the dashboard or extension.' }, origin);

  const command = String(body.command || '').trim();
  if (!command) return sendJson(res, 400, { ok: false, tool: 'exec', error: 'command is required' }, origin);
  if (command.length > 20000) return sendJson(res, 400, { ok: false, tool: 'exec', error: 'Command is too long (max 20,000 chars)' }, origin);

  const blocked = checkCommand(command);
  if (blocked) {
    logActivity({ tool: 'exec', ok: false, summary: shortCommand(command), error: 'Blocked: ' + blocked });
    return sendJson(res, 403, { ok: false, tool: 'exec', error: `Blocked by the bridge safety policy (${blocked}). Run it yourself if you truly need it.` }, origin);
  }

  let cwdAbs;
  try {
    cwdAbs = resolveInside(body.cwd || '.');
    const stat = await fsp.stat(cwdAbs);
    if (!stat.isDirectory()) throw new HttpError(400, 'cwd is not a directory: ' + body.cwd);
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, tool: 'exec', error: err.message }, origin);
  }

  const shell = body.shell === 'cmd' ? 'cmd' : 'powershell';
  const timeoutSec = clamp(Number(body.timeout) || config.defaultTimeoutSec, 5, config.maxTimeoutSec);

  console.log(`\n$ ${shortCommand(command)}  (${relToWorkspace(cwdAbs)}, ${timeoutSec}s)`);
  const result = await execCommand(command, cwdAbs, shell, timeoutSec);
  counters.exec++;

  const logRel = path.join('.bridge', `exec-${timestamp()}-${crypto.randomBytes(2).toString('hex')}.log`).split(path.sep).join('/');
  const logAbs = path.join(config.workspace, logRel);
  const fullLog = [
    `$ ${command}`,
    `cwd: ${cwdAbs}`,
    `shell: ${shell}`,
    `exit: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`,
    '',
    '--- stdout ---',
    result.stdout,
    '',
    '--- stderr ---',
    result.stderr
  ].join('\n');
  try {
    await fsp.writeFile(logAbs, fullLog, 'utf8');
  } catch {
    /* non-fatal */
  }

  const outputParts = [];
  if (result.timedOut) outputParts.push(`[TIMED OUT after ${timeoutSec}s — the process tree was killed]`);
  if (result.stdout.trim()) outputParts.push(result.stdout.trimEnd());
  if (result.stderr.trim()) outputParts.push('[stderr]\n' + result.stderr.trimEnd());
  if (!outputParts.length) outputParts.push('(no output)');
  if (result.truncated) outputParts.push(`[output truncated by the bridge at ${formatBytes(config.maxOutputBytes)}; full log: ${logRel}]`);

  const summary = `${shortCommand(command)} → exit ${result.exitCode}`;
  logActivity({
    tool: 'exec',
    ok: true,
    summary: shortCommand(command),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    detail: result.stdout.slice(-600) || result.stderr.slice(-600)
  });

  return sendJson(res, 200, {
    ok: true,
    tool: 'exec',
    summary,
    output: outputParts.join('\n\n'),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    truncated: result.truncated,
    cwd: relToWorkspace(cwdAbs),
    data: { log: logRel, shell }
  }, origin);
}

/* ------------------------------------------------------------------ */
/* File tools                                                         */
/* ------------------------------------------------------------------ */

async function toolWrite(body, res, origin) {
  let abs;
  try {
    abs = resolveInside(body.path);
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, tool: 'write', error: err.message }, origin);
  }
  if (typeof body.content !== 'string') {
    return sendJson(res, 400, { ok: false, tool: 'write', error: 'content must be a string' }, origin);
  }
  if (Buffer.byteLength(body.content, 'utf8') > 8 * 1024 * 1024) {
    return sendJson(res, 413, { ok: false, tool: 'write', error: 'File is larger than 8 MB' }, origin);
  }
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, body.content, 'utf8');
  } catch (err) {
    logActivity({ tool: 'write', ok: false, summary: String(body.path), error: err.message });
    return sendJson(res, 500, { ok: false, tool: 'write', error: err.message }, origin);
  }
  const bytes = Buffer.byteLength(body.content, 'utf8');
  counters.write++;
  const rel = relToWorkspace(abs);
  logActivity({ tool: 'write', ok: true, summary: rel, bytes });
  return sendJson(res, 200, {
    ok: true,
    tool: 'write',
    summary: `Wrote ${rel} (${formatBytes(bytes)})`,
    output: `Wrote ${bytes} bytes to ${rel}.`,
    path: rel,
    bytes
  }, origin);
}

async function toolRead(body, res, origin) {
  let abs;
  try {
    abs = resolveInside(body.path);
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, tool: 'read', error: err.message }, origin);
  }
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) return sendJson(res, 400, { ok: false, tool: 'read', error: 'Not a file: ' + body.path }, origin);
    const max = 400 * 1024;
    const raw = await fsp.readFile(abs);
    const slice = raw.subarray(0, max);
    if (slice.includes(0)) {
      return sendJson(res, 200, {
        ok: true,
        tool: 'read',
        summary: `Binary file ${relToWorkspace(abs)} (${formatBytes(stat.size)})`,
        output: `[binary file: ${relToWorkspace(abs)}, ${formatBytes(stat.size)} — not shown]`,
        path: relToWorkspace(abs),
        size: stat.size
      }, origin);
    }
    let text = slice.toString('utf8');
    const truncated = raw.length > max;
    if (truncated) text += `\n… [truncated — file is ${formatBytes(raw.length)}]`;
    counters.read++;
    logActivity({ tool: 'read', ok: true, summary: relToWorkspace(abs), bytes: raw.length });
    return sendJson(res, 200, {
      ok: true,
      tool: 'read',
      summary: `Read ${relToWorkspace(abs)} (${formatBytes(raw.length)})`,
      output: text,
      path: relToWorkspace(abs),
      size: raw.length,
      truncated
    }, origin);
  } catch (err) {
    logActivity({ tool: 'read', ok: false, summary: String(body.path), error: err.message });
    return sendJson(res, err.code === 'ENOENT' ? 404 : 500, { ok: false, tool: 'read', error: err.message }, origin);
  }
}

async function toolList(body, res, origin) {
  let abs;
  try {
    abs = resolveInside(body.path || '.');
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, tool: 'list', error: err.message }, origin);
  }
  try {
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    const rows = [];
    const structured = [];
    for (const e of entries) {
      if (e.name === '.bridge' && relToWorkspace(abs) === '.') continue;
      const full = path.join(abs, e.name);
      let size = 0;
      try {
        size = (await fsp.stat(full)).size;
      } catch {
        /* ignore */
      }
      const type = e.isDirectory() ? 'dir' : 'file';
      rows.push(`${type === 'dir' ? 'd' : 'f'}  ${e.name}${type === 'dir' ? '/' : ''}${type === 'file' ? '  (' + formatBytes(size) + ')' : ''}`);
      structured.push({ name: e.name, type, size });
    }
    rows.sort((a, b) => (a.startsWith('d') === b.startsWith('d') ? a.localeCompare(b) : a.startsWith('d') ? -1 : 1));
    const rel = relToWorkspace(abs);
    const output = rows.length ? `${rel}/\n` + rows.join('\n') : `${rel}/ is empty.`;
    logActivity({ tool: 'list', ok: true, summary: rel });
    return sendJson(res, 200, {
      ok: true,
      tool: 'list',
      summary: `Listed ${rel} (${rows.length} entries)`,
      output,
      path: rel,
      entries: structured
    }, origin);
  } catch (err) {
    return sendJson(res, err.code === 'ENOENT' ? 404 : 500, { ok: false, tool: 'list', error: err.message }, origin);
  }
}

async function toolMkdir(body, res, origin) {
  try {
    const abs = resolveInside(body.path);
    await fsp.mkdir(abs, { recursive: true });
    const rel = relToWorkspace(abs);
    logActivity({ tool: 'mkdir', ok: true, summary: rel });
    return sendJson(res, 200, { ok: true, tool: 'mkdir', summary: `Created ${rel}/`, output: `Created folder ${rel}/.`, path: rel }, origin);
  } catch (err) {
    return sendJson(res, err.status || 500, { ok: false, tool: 'mkdir', error: err.message }, origin);
  }
}

async function toolMove(body, res, origin) {
  try {
    const from = resolveInside(body.from);
    const to = resolveInside(body.to);
    assertSafeDestructiveTarget(from, 'move');
    assertSafeDestructiveTarget(to, 'move');
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    const relFrom = relToWorkspace(from);
    const relTo = relToWorkspace(to);
    logActivity({ tool: 'move', ok: true, summary: `${relFrom} → ${relTo}` });
    return sendJson(res, 200, { ok: true, tool: 'move', summary: `Moved ${relFrom} → ${relTo}`, output: `Moved ${relFrom} to ${relTo}.` }, origin);
  } catch (err) {
    return sendJson(res, err.status || 500, { ok: false, tool: 'move', error: err.message }, origin);
  }
}

async function toolRemove(body, res, origin) {
  try {
    const abs = resolveInside(body.path);
    if (relToWorkspace(abs) === '.') throw new HttpError(400, 'Refusing to remove the workspace root');
    assertSafeDestructiveTarget(abs, 'remove');
    const stat = await fsp.lstat(abs);
    const recursive = Boolean(body.recursive);
    if (stat.isDirectory()) {
      if (!recursive) {
        const entries = await fsp.readdir(abs);
        if (entries.length) throw new HttpError(400, 'Directory is not empty — pass "recursive": true');
      }
      await fsp.rm(abs, { recursive: true, force: true });
    } else {
      await fsp.unlink(abs);
    }
    const rel = relToWorkspace(abs);
    logActivity({ tool: 'remove', ok: true, summary: rel });
    return sendJson(res, 200, { ok: true, tool: 'remove', summary: `Removed ${rel}`, output: `Removed ${rel}.` }, origin);
  } catch (err) {
    return sendJson(res, err.status || 500, { ok: false, tool: 'remove', error: err.message }, origin);
  }
}

async function toolStat(body, res, origin) {
  try {
    const abs = resolveInside(body.path);
    const stat = await fsp.stat(abs);
    const rel = relToWorkspace(abs);
    const type = stat.isDirectory() ? 'directory' : 'file';
    return sendJson(res, 200, {
      ok: true,
      tool: 'stat',
      summary: `${rel} is a ${type}`,
      output: `${rel}\ntype: ${type}\nsize: ${formatBytes(stat.size)}\nmodified: ${stat.mtime.toISOString()}`,
      type,
      size: stat.size,
      mtime: stat.mtime.toISOString()
    }, origin);
  } catch (err) {
    return sendJson(res, err.code === 'ENOENT' ? 404 : 500, { ok: false, tool: 'stat', error: err.message }, origin);
  }
}

async function toolOpen(body, res, origin) {
  try {
    const abs = resolveInside(body.path || '.');
    await fsp.access(abs);
    const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [abs], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    const rel = relToWorkspace(abs);
    return sendJson(res, 200, { ok: true, tool: 'open', summary: `Opened ${rel}`, output: `Opened ${rel} in the file manager.` }, origin);
  } catch (err) {
    return sendJson(res, err.status || 500, { ok: false, tool: 'open', error: err.message }, origin);
  }
}

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(tool, req, res, origin) {
  if (!originAllowed(origin)) {
    return sendJson(res, 403, { ok: false, error: 'Origin not allowed: ' + origin }, origin);
  }

  if (tool === 'ping') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'Invalid or missing token' }, origin);
    return sendJson(res, 200, {
      ok: true,
      name: 'PC Bridge',
      version: VERSION,
      platform: process.platform,
      os: `${os.type()} ${os.release()}`,
      node: process.version,
      shell: 'powershell',
      workspace: config.workspace,
      root: BRIDGE_ROOT,
      port: PORT,
      paused,
      fullPcAccess: config.fullPcAccess,
      fileAccess: config.fullPcAccess ? 'full' : 'workspace',
      uptimeSec: Math.floor(process.uptime()),
      counts: { ...counters },
      time: new Date().toISOString()
    }, origin);
  }

  if (tool === 'log') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'Invalid or missing token' }, origin);
    return sendJson(res, 200, { ok: true, entries: activity.slice(0, 100), paused, fullPcAccess: config.fullPcAccess, counters }, origin);
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Use POST for /api/' + tool }, origin);
  }
  if (!authorized(req)) {
    return sendJson(res, 401, { ok: false, error: 'Invalid or missing token. Copy it from the dashboard or server/token.txt.' }, origin);
  }

  const body = await readBody(req);

  if (tool === 'control') {
    if (typeof body.paused === 'boolean') paused = body.paused;
    logActivity({ tool: 'control', ok: true, summary: paused ? 'Bridge paused' : 'Bridge resumed' });
    return sendJson(res, 200, { ok: true, paused }, origin);
  }

  if (tool === 'access') {
    if (typeof body.fullPcAccess !== 'boolean') {
      return sendJson(res, 400, { ok: false, error: 'fullPcAccess must be true or false' }, origin);
    }
    if (body.fullPcAccess) {
      const phrase = String(body.confirmation || '').trim().toUpperCase();
      if (phrase !== 'FULL PC ACCESS') {
        return sendJson(res, 400, { ok: false, error: 'Type FULL PC ACCESS to confirm.' }, origin);
      }
    }
    const previous = config.fullPcAccess;
    const fullPcAccess = setFullPcAccess(body.fullPcAccess);
    if (previous !== fullPcAccess) {
      logActivity({
        tool: 'access',
        ok: true,
        summary: fullPcAccess ? 'FULL PC file access enabled' : 'File access limited to workspace',
        detail: fullPcAccess
          ? 'AI file tools can now read, write, move, and remove files outside the workspace.'
          : 'File tools are confined to the workspace again.'
      });
    }
    return sendJson(res, 200, { ok: true, fullPcAccess }, origin);
  }

  if (tool === 'workspace') {
    const previous = config.workspace;
    try {
      const workspace = setWorkspace(body.path);
      logActivity({
        tool: 'workspace',
        ok: true,
        summary: `Project location -> ${workspace}`,
        detail: previous === workspace ? 'No change' : `Previous: ${previous}`
      });
      return sendJson(res, 200, { ok: true, workspace, previous }, origin);
    } catch (err) {
      logActivity({
        tool: 'workspace',
        ok: false,
        summary: 'Could not change project location',
        error: err.message
      });
      return sendJson(res, err.status || 500, { ok: false, error: err.message }, origin);
    }
  }

  if (paused && !['control', 'ping', 'log', 'access'].includes(tool)) {
    return sendJson(res, 423, { ok: false, tool, error: 'Bridge is paused. Resume it in the dashboard or extension.' }, origin);
  }

  switch (tool) {
    case 'exec': return toolExec(body, res, origin);
    case 'write': return toolWrite(body, res, origin);
    case 'read': return toolRead(body, res, origin);
    case 'list': return toolList(body, res, origin);
    case 'mkdir': return toolMkdir(body, res, origin);
    case 'move': return toolMove(body, res, origin);
    case 'remove': return toolRemove(body, res, origin);
    case 'stat': return toolStat(body, res, origin);
    case 'open': return toolOpen(body, res, origin);
    default:
      return sendJson(res, 404, { ok: false, error: 'Unknown tool: ' + tool }, origin);
  }
}

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;

  try {
    if (req.method === 'OPTIONS') {
      if (origin && !originAllowed(origin)) return sendJson(res, 403, { ok: false, error: 'Origin not allowed' }, origin);
      res.writeHead(204, { ...corsHeaders(origin), 'Content-Length': '0' });
      return res.end();
    }

    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveIndex(res);
    }
    if (req.method === 'GET' && pathname === '/app.js') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'app.js'), 'text/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/style.css') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'style.css'), 'text/css; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/favicon.svg') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'favicon.svg'), 'image/svg+xml');
    }

    if (pathname.startsWith('/api/')) {
      return await handleApi(pathname.slice('/api/'.length), req, res, origin);
    }

    if (DEV && pathname === '/mock') {
      return serveIndexMock(res);
    }
    if (DEV && pathname.startsWith('/ext/')) {
      const file = pathname.slice('/ext/'.length);
      if (/^[a-zA-Z0-9._-]+$/.test(file)) {
        return serveStatic(res, path.join(BRIDGE_ROOT, 'extension', file), guessType(file));
      }
    }

    sendText(res, 404, 'Not found', 'text/plain; charset=utf-8', origin);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    console.error('[error]', err.message);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message }, origin);
    else res.end();
  }
});

function guessType(file) {
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

async function serveIndexMock(res) {
  try {
    let html = await fsp.readFile(path.join(BRIDGE_ROOT, 'dev', 'mock-chat.html'), 'utf8');
    html = html.replaceAll('{{TOKEN}}', escapeHtml(TOKEN)).replaceAll('{{WORKSPACE}}', escapeHtml(config.workspace));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch (err) {
    sendText(res, 500, 'Mock page missing: ' + err.message);
  }
}

function banner() {
  const line = '='.repeat(64);
  console.log('');
  console.log(line);
  console.log(`  PC BRIDGE  v${VERSION}  -  local server`);
  console.log(line);
  console.log(`  Dashboard : http://127.0.0.1:${PORT}`);
  console.log(`  Workspace : ${config.workspace}`);
  console.log(`  Files     : ${config.fullPcAccess ? 'FULL PC ACCESS - all drives' : 'workspace only'}`);
  console.log('  Token     : open the dashboard to copy it (server/token.txt)');
  console.log(`  Shell     : PowerShell (or cmd per request)`);
  console.log(`  Dev mode  : ${DEV ? 'ON (test page at /mock)' : 'off'}`);
  console.log(line);
  if (config.fullPcAccess) {
    console.log('  WARNING: full PC file access is ON. AI file tools can read/write');
    console.log('           outside the workspace. Turn it off in the dashboard.');
    console.log(line);
  }
  console.log('  Keep this window open. Press Ctrl+C to stop.');
  console.log('');
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Close the other PC Bridge window, or change "port" in server/config.json.\n`);
  } else {
    console.error('\nServer error:', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  banner();
  if (process.argv.includes('--open') || config.openOnStart) {
    setTimeout(() => openBrowser(`http://127.0.0.1:${PORT}`), 500);
  }
});

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* ignore */
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] Shutting down PC Bridge...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
