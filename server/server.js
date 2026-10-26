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

const VERSION = '1.3.0';
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
  fullPcAccess: false,
  customPlatforms: []
};

const BUILTIN_PLATFORMS = [
  { id: 'deepseek', name: 'DeepSeek', origin: 'https://chat.deepseek.com' },
  { id: 'chatgpt', name: 'ChatGPT', origin: 'https://chatgpt.com' },
  { id: 'chatgpt-legacy', name: 'ChatGPT (legacy)', origin: 'https://chat.openai.com' },
  { id: 'claude', name: 'Claude', origin: 'https://claude.ai' },
  { id: 'gemini', name: 'Gemini', origin: 'https://gemini.google.com' },
  { id: 'grok', name: 'Grok', origin: 'https://grok.com' }
];

const BUILTIN_ORIGINS = new Set(BUILTIN_PLATFORMS.map((p) => p.origin));
const MAX_CUSTOM_PLATFORMS = 50;
// JSON escaping can roughly double an 8 MB write, and edit batches carry two
// copies of the changed text. Keep the transport cap comfortably above both.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const TOOL_NAMES = [
  'exec', 'write', 'read', 'list', 'mkdir', 'move', 'remove', 'stat', 'open',
  'edit', 'grep', 'find', 'copy', 'hash', 'download', 'fetch', 'system'
];

const config = loadConfig();
const TOKEN = loadToken();
const PORT = Number(process.env.PC_BRIDGE_PORT || config.port || 8787);

let paused = false;
let shuttingDown = false;
let activitySeq = 0;
const activity = [];
const counters = Object.fromEntries([...TOOL_NAMES, 'control', 'access', 'workspace', 'platforms'].map((name) => [name, 0]));

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

/**
 * Normalise a user-entered website into an exact http(s) origin.
 * Paths/query strings are intentionally discarded: the browser Origin header
 * never contains them. Returns null for anything unsafe or invalid.
 */
function canonicalOrigin(raw) {
  let value = String(raw == null ? '' : raw).trim();
  if (!value || value.length > 2048) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
    value = 'https://' + value;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!parsed.hostname || parsed.username || parsed.password) return null;
  return parsed.origin;
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

  const seen = new Set();
  cfg.customPlatforms = (Array.isArray(cfg.customPlatforms) ? cfg.customPlatforms : [])
    .map(canonicalOrigin)
    .filter((origin) => {
      if (!origin || BUILTIN_ORIGINS.has(origin) || seen.has(origin)) return false;
      seen.add(origin);
      return true;
    })
    .slice(0, MAX_CUSTOM_PLATFORMS);

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

function setCustomPlatforms(next) {
  const clean = [];
  const seen = new Set();
  for (const value of Array.isArray(next) ? next : []) {
    const origin = canonicalOrigin(value);
    if (!origin || BUILTIN_ORIGINS.has(origin) || seen.has(origin)) continue;
    seen.add(origin);
    clean.push(origin);
  }
  const limited = clean.slice(0, MAX_CUSTOM_PLATFORMS);
  persistConfig({ customPlatforms: limited });
  config.customPlatforms = limited;
  return limited;
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
  const target = path.resolve(abs);
  const root = path.parse(target).root;
  if (samePath(target, root)) {
    throw new HttpError(400, `Refusing to ${action} a drive root: ${target}`);
  }
  if (samePath(target, config.workspace)) {
    throw new HttpError(400, `Refusing to ${action} the workspace root: ${target}`);
  }
  if (!config.fullPcAccess) return;
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

function intOption(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, min, max);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob) {
  const pattern = String(glob || '*').trim().replace(/\\/g, '/') || '*';
  const flags = process.platform === 'win32' ? 'i' : '';
  const brace = /\{([^{}]+)\}/.exec(pattern);
  if (brace) {
    const choices = brace[1].split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    if (!choices.length) return /$^/;
    const parts = choices.map((choice) =>
      globToRegExp(pattern.slice(0, brace.index) + choice + pattern.slice(brace.index + brace[0].length)).source
    );
    return new RegExp('(?:' + parts.join('|') + ')', flags);
  }
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegExp(ch);
    }
  }
  const prefix = pattern.includes('/') ? '^' : '(?:^|/)';
  return new RegExp(prefix + out + '$', flags);
}

function matchesGlob(relPath, pattern) {
  return globToRegExp(pattern).test(String(relPath).replace(/\\/g, '/'));
}

const DEFAULT_IGNORED_DIRS = new Set(['.git', 'node_modules', '.bridge', 'dist', 'build', 'coverage']);

/**
 * Depth-first walk with hard caps. Directory symlinks are never followed.
 * visit() returns true to stop the walk.
 */
async function walkPaths(rootAbs, options, visit) {
  const maxDepth = intOption(options.maxDepth, 12, 1, 30);
  const maxVisited = intOption(options.maxVisited, 20000, 1, 200000);
  const includeHidden = options.includeHidden === true;
  const includeIgnored = options.includeIgnored === true;
  let visited = 0;
  let stopped = false;

  async function visitPath(abs, rel, name, dirent, depth) {
    if (stopped) return;
    visited++;
    if (visited > maxVisited) {
      stopped = true;
      return;
    }
    const stop = await visit({ abs, rel: rel.replace(/\\/g, '/'), name, dirent, depth });
    if (stop) stopped = true;
  }

  async function recurse(dir, relPrefix, depth) {
    if (stopped) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (stopped) return;
      if (!includeHidden && entry.name.startsWith('.')) continue;
      if (!includeIgnored && entry.isDirectory() && DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = relPrefix ? relPrefix + '/' + entry.name : entry.name;
      await visitPath(abs, rel, entry.name, entry, depth);
      if (stopped) return;
      if (entry.isDirectory() && depth < maxDepth) await recurse(abs, rel, depth + 1);
    }
  }

  let stat;
  try {
    stat = await fsp.stat(rootAbs);
  } catch (err) {
    throw new HttpError(err.code === 'ENOENT' ? 404 : 500, err.message);
  }
  if (stat.isDirectory()) {
    await recurse(rootAbs, '', 1);
  } else {
    await visitPath(rootAbs, path.basename(rootAbs), path.basename(rootAbs), null, 1);
  }
  return { visited, stopped };
}

function hashFile(abs, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(abs);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function validateHttpUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || '').trim());
  } catch {
    throw new HttpError(400, 'Enter a valid http(s) URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'Only http:// and https:// URLs are supported.');
  }
  if (parsed.username || parsed.password) {
    throw new HttpError(400, 'URLs with embedded credentials are not allowed.');
  }
  return parsed;
}

async function fetchWithTimeout(url, timeoutSec) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': `PC-Bridge/${VERSION}`, Accept: '*/*' }
    });
    return {
      response,
      finish() {
        clearTimeout(timer);
      }
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function readResponseBuffer(response, maxBytes) {
  if (!response.body) return { buffer: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - size;
      if (remaining <= 0) {
        truncated = true;
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
      const chunk = Buffer.from(value);
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        size += remaining;
        truncated = true;
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

function outputPath(abs) {
  return relToWorkspace(abs);
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
  if (ALLOWED_ORIGINS.some((re) => re.test(origin))) return true;
  return config.customPlatforms.includes(origin);
}

function bump(tool) {
  counters[tool] = (counters[tool] || 0) + 1;
}

function platformsPayload() {
  return {
    builtin: BUILTIN_PLATFORMS,
    custom: [...config.customPlatforms],
    maxCustom: MAX_CUSTOM_PLATFORMS
  };
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Token, Authorization',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
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
      if (size > MAX_BODY_BYTES) {
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
  const append = body.mode === 'append';
  const createDirs = body.createDirs !== false;
  try {
    if (createDirs) await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (append) await fsp.appendFile(abs, body.content, 'utf8');
    else await fsp.writeFile(abs, body.content, 'utf8');
  } catch (err) {
    logActivity({ tool: 'write', ok: false, summary: String(body.path), error: err.message });
    return sendJson(res, err.code === 'ENOENT' ? 404 : 500, { ok: false, tool: 'write', error: err.message }, origin);
  }
  const bytes = Buffer.byteLength(body.content, 'utf8');
  bump('write');
  const rel = relToWorkspace(abs);
  const verb = append ? 'Appended' : 'Wrote';
  logActivity({ tool: 'write', ok: true, summary: `${verb.toLowerCase()} ${rel}`, bytes });
  return sendJson(res, 200, {
    ok: true,
    tool: 'write',
    summary: `${verb} ${rel} (${formatBytes(bytes)})`,
    output: `${verb} ${bytes} bytes ${append ? 'to the end of ' : 'to '}${rel}.`,
    path: rel,
    bytes,
    mode: append ? 'append' : 'overwrite'
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
    const max = intOption(body.maxBytes, 400 * 1024, 1024, 2 * 1024 * 1024);
    const raw = await fsp.readFile(abs);
    const slice = raw.subarray(0, max);
    if (slice.includes(0)) {
      bump('read');
      return sendJson(res, 200, {
        ok: true,
        tool: 'read',
        summary: `Binary file ${relToWorkspace(abs)} (${formatBytes(stat.size)})`,
        output: `[binary file: ${relToWorkspace(abs)}, ${formatBytes(stat.size)} — not shown. Use hash or download if you need to inspect it.]`,
        path: relToWorkspace(abs),
        size: stat.size,
        binary: true
      }, origin);
    }
    let text = slice.toString('utf8');
    const truncated = raw.length > max;
    let startLine;
    let endLine;
    let totalLines;

    if (body.offset !== undefined || body.limit !== undefined) {
      const lines = text.split('\n');
      totalLines = lines.length;
      startLine = intOption(body.offset, 1, 1, Math.max(1, totalLines));
      const take = body.limit === undefined ? 0 : intOption(body.limit, 0, 0, 5000);
      endLine = take > 0 ? Math.min(totalLines, startLine + take - 1) : totalLines;
      text = lines.slice(startLine - 1, endLine).join('\n');
      if (endLine < totalLines) text += `\n… [showing lines ${startLine}-${endLine} of ${totalLines}]`;
    }
    if (truncated) text += `\n… [truncated — file is ${formatBytes(raw.length)}]`;
    bump('read');
    logActivity({ tool: 'read', ok: true, summary: relToWorkspace(abs), bytes: raw.length });
    return sendJson(res, 200, {
      ok: true,
      tool: 'read',
      summary: `Read ${relToWorkspace(abs)} (${formatBytes(raw.length)})`,
      output: text,
      path: relToWorkspace(abs),
      size: raw.length,
      truncated,
      ...(totalLines !== undefined ? { startLine, endLine, totalLines } : {})
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
  const recursive = body.recursive === true;
  const includeHidden = body.all !== false;
  const maxDepth = intOption(body.depth, recursive ? 2 : 1, 1, 12);
  const limit = intOption(body.limit, 500, 1, 5000);
  try {
    const rootStat = await fsp.stat(abs);
    if (!rootStat.isDirectory()) {
      return sendJson(res, 400, { ok: false, tool: 'list', error: 'Not a directory: ' + body.path }, origin);
    }
    const structured = [];
    let truncated = false;

    async function walk(dir, prefix, depth) {
      if (structured.length >= limit) {
        truncated = true;
        return;
      }
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        if (structured.length >= limit) {
          truncated = true;
          return;
        }
        if (!includeHidden && entry.name.startsWith('.')) continue;
        if (entry.name === '.bridge' && !prefix) continue;
        const full = path.join(dir, entry.name);
        let size = 0;
        let type = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file';
        try {
          const st = await fsp.stat(full);
          size = st.size;
        } catch {
          /* ignore */
        }
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        structured.push({
          name: rel + (type === 'dir' ? '/' : ''),
          path: rel,
          type,
          size
        });
        if (recursive && entry.isDirectory() && depth < maxDepth) {
          await walk(full, rel, depth + 1);
        }
      }
    }

    await walk(abs, '', 1);
    const rows = structured.map((e) => {
      if (e.type === 'dir') return `d  ${e.name}`;
      return `f  ${e.name}${e.type === 'file' ? '  (' + formatBytes(e.size) + ')' : ''}`;
    });
    const rel = relToWorkspace(abs);
    let output = rows.length ? `${rel}/\n` + rows.join('\n') : `${rel}/ is empty.`;
    if (truncated) output += `\n… [limited to ${limit} entries; use depth/limit or a narrower path]`;
    bump('list');
    logActivity({ tool: 'list', ok: true, summary: rel, count: rows.length });
    return sendJson(res, 200, {
      ok: true,
      tool: 'list',
      summary: `Listed ${rel} (${rows.length} entries)`,
      output,
      path: rel,
      entries: structured,
      recursive,
      truncated
    }, origin);
  } catch (err) {
    return sendJson(res, err.code === 'ENOENT' ? 404 : err.status || 500, { ok: false, tool: 'list', error: err.message }, origin);
  }
}

async function toolMkdir(body, res, origin) {
  try {
    const abs = resolveInside(body.path);
    await fsp.mkdir(abs, { recursive: body.recursive !== false });
    bump('mkdir');
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
    if (samePath(from, to)) throw new HttpError(400, 'Source and destination are the same path.');
    assertSafeDestructiveTarget(from, 'move');
    assertSafeDestructiveTarget(to, 'move');
    const fromStat = await fsp.lstat(from);
    if (fromStat.isDirectory() && (samePath(from, to) || isInside(to, from))) {
      throw new HttpError(400, 'Cannot move a folder inside itself.');
    }
    const overwrite = body.overwrite === true;
    let destExists = false;
    let destStat = null;
    try {
      destStat = await fsp.lstat(to);
      destExists = true;
    } catch { /* missing is fine */ }
    if (destExists) {
      if (fromStat.isDirectory() !== destStat.isDirectory()) {
        throw new HttpError(409, 'Source and destination must both be files or both be folders.');
      }
      if (destStat.isDirectory() && (isInside(from, to) || isInside(to, from))) {
        throw new HttpError(400, 'Cannot move a folder into itself or over one of its own parent folders.');
      }
      if (!overwrite) throw new HttpError(409, `Destination already exists: ${relToWorkspace(to)}. Pass "overwrite": true to replace it.`);
      assertSafeDestructiveTarget(to, 'overwrite');
      await fsp.rm(to, { recursive: true, force: true });
    }
    await fsp.mkdir(path.dirname(to), { recursive: true });
    try {
      await fsp.rename(from, to);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: true });
      await fsp.rm(from, { recursive: true, force: true });
    }
    bump('move');
    const relFrom = relToWorkspace(from);
    const relTo = relToWorkspace(to);
    logActivity({ tool: 'move', ok: true, summary: `${relFrom} → ${relTo}` });
    return sendJson(res, 200, {
      ok: true,
      tool: 'move',
      summary: `Moved ${relFrom} → ${relTo}`,
      output: `Moved ${relFrom} to ${relTo}${overwrite ? ' (overwrote existing destination)' : ''}.`,
      from: relFrom,
      to: relTo
    }, origin);
  } catch (err) {
    return sendJson(res, err.status || (err.code === 'ENOENT' ? 404 : 500), { ok: false, tool: 'move', error: err.message }, origin);
  }
}

async function toolRemove(body, res, origin) {
  try {
    const abs = resolveInside(body.path);
    if (relToWorkspace(abs) === '.') throw new HttpError(400, 'Refusing to remove the workspace root');
    assertSafeDestructiveTarget(abs, 'remove');
    let stat;
    try {
      stat = await fsp.lstat(abs);
    } catch (err) {
      if (err.code === 'ENOENT') throw new HttpError(404, 'Path does not exist: ' + relToWorkspace(abs));
      throw err;
    }
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
    bump('remove');
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
    const stat = await fsp.lstat(abs);
    const isLink = stat.isSymbolicLink();
    const follows = isLink ? await fsp.stat(abs) : stat;
    const rel = relToWorkspace(abs);
    const type = follows.isDirectory() ? 'directory' : follows.isFile() ? 'file' : isLink ? 'link' : 'other';
    bump('stat');
    return sendJson(res, 200, {
      ok: true,
      tool: 'stat',
      summary: `${rel} is a ${type}`,
      output: [
        rel,
        `type: ${type}${isLink ? ' (symlink)' : ''}`,
        `size: ${formatBytes(follows.size)} (${follows.size} bytes)`,
        `modified: ${follows.mtime.toISOString()}`,
        `created: ${follows.birthtime.toISOString()}`,
        `accessed: ${follows.atime.toISOString()}`
      ].join('\n'),
      type,
      size: follows.size,
      mtime: follows.mtime.toISOString(),
      birthtime: follows.birthtime.toISOString(),
      atime: follows.atime.toISOString(),
      symlink: isLink
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
    bump('open');
    const rel = relToWorkspace(abs);
    logActivity({ tool: 'open', ok: true, summary: rel });
    return sendJson(res, 200, { ok: true, tool: 'open', summary: `Opened ${rel}`, output: `Opened ${rel} in the file manager.` }, origin);
  } catch (err) {
    return sendJson(res, err.status || 500, { ok: false, tool: 'open', error: err.message }, origin);
  }
}

async function toolEdit(body, res, origin) {
  let abs;
  try {
    abs = resolveInside(body.path);
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, tool: 'edit', error: err.message }, origin);
  }

  const edits = Array.isArray(body.edits)
    ? body.edits
    : [{ oldText: body.oldText ?? body.find, newText: body.newText ?? body.replace, replaceAll: body.replaceAll }];

  if (!edits.length) {
    return sendJson(res, 400, { ok: false, tool: 'edit', error: 'Provide oldText/newText, or an edits array.' }, origin);
  }
  if (edits.length > 50) {
    return sendJson(res, 400, { ok: false, tool: 'edit', error: 'At most 50 edits per call.' }, origin);
  }

  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw new HttpError(400, 'Not a file: ' + body.path);
    if (stat.size > 8 * 1024 * 1024) throw new HttpError(413, 'File is larger than 8 MB; use exec with a targeted script instead.');
    let text = await fsp.readFile(abs, 'utf8');
    if (text.includes('\u0000')) throw new HttpError(400, 'Refusing to edit a binary file.');

    let replacements = 0;
    for (let i = 0; i < edits.length; i++) {
      const item = edits[i] || {};
      const oldText = item.oldText ?? item.find;
      const newText = item.newText ?? item.replace;
      if (typeof oldText !== 'string' || !oldText.length) {
        throw new HttpError(400, `Edit ${i + 1}: oldText must be a non-empty string.`);
      }
      if (typeof newText !== 'string') {
        throw new HttpError(400, `Edit ${i + 1}: newText must be a string.`);
      }
      const count = text.split(oldText).length - 1;
      if (count === 0) {
        throw new HttpError(409, `Edit ${i + 1}: oldText was not found in ${relToWorkspace(abs)}. Read the file again and copy the exact text.`);
      }
      const all = item.replaceAll === true || body.replaceAll === true;
      if (!all && count > 1) {
        throw new HttpError(409, `Edit ${i + 1}: oldText appears ${count} times. Add more surrounding context or pass "replaceAll": true.`);
      }
      if (all) {
        text = text.split(oldText).join(newText);
        replacements += count;
      } else {
        const at = text.indexOf(oldText);
        text = text.slice(0, at) + newText + text.slice(at + oldText.length);
        replacements += 1;
      }
    }
    if (Buffer.byteLength(text, 'utf8') > 8 * 1024 * 1024) {
      throw new HttpError(413, 'Resulting file would be larger than 8 MB.');
    }
    await fsp.writeFile(abs, text, 'utf8');
    bump('edit');
    const rel = relToWorkspace(abs);
    logActivity({ tool: 'edit', ok: true, summary: rel, replacements });
    return sendJson(res, 200, {
      ok: true,
      tool: 'edit',
      summary: `Edited ${rel} (${replacements} replacement${replacements === 1 ? '' : 's'})`,
      output: `Edited ${rel}: ${replacements} replacement${replacements === 1 ? '' : 's'} across ${edits.length} change${edits.length === 1 ? '' : 's'}.`,
      path: rel,
      replacements,
      edits: edits.length,
      bytes: Buffer.byteLength(text, 'utf8')
    }, origin);
  } catch (err) {
    logActivity({ tool: 'edit', ok: false, summary: String(body.path), error: err.message });
    return sendJson(res, err.status || (err.code === 'ENOENT' ? 404 : 500), { ok: false, tool: 'edit', error: err.message }, origin);
  }
}

async function toolGrep(body, res, origin) {
  let abs;
  try {
    abs = resolveInside(body.path || '.');
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, tool: 'grep', error: err.message }, origin);
  }
  const pattern = String(body.pattern || '');
  if (!pattern) return sendJson(res, 400, { ok: false, tool: 'grep', error: 'pattern is required' }, origin);
  if (pattern.length > 500) return sendJson(res, 400, { ok: false, tool: 'grep', error: 'pattern is too long (max 500 chars)' }, origin);

  let regex;
  try {
    const flags = (body.ignoreCase ? 'i' : '') + 'g';
    regex = new RegExp(body.literal ? escapeRegExp(pattern) : pattern, flags);
  } catch (err) {
    return sendJson(res, 400, { ok: false, tool: 'grep', error: 'Invalid regular expression: ' + err.message }, origin);
  }

  const maxResults = intOption(body.maxResults, 200, 1, 2000);
  const maxFiles = intOption(body.maxFiles, 2000, 1, 10000);
  const maxFileBytes = intOption(body.maxFileBytes, 1024 * 1024, 1024, 8 * 1024 * 1024);
  const contextLines = intOption(body.context, 0, 0, 5);
  const include = String(body.include || body.glob || '**/*');
  const lines = [];
  let filesScanned = 0;
  let matches = 0;
  let skipped = 0;
  let truncated = false;

  try {
    const rootStat = await fsp.stat(abs);
    const files = [];
    if (rootStat.isDirectory()) {
      await walkPaths(abs, {
        maxDepth: body.maxDepth,
        maxVisited: body.maxVisited,
        includeHidden: body.includeHidden === true,
        includeIgnored: body.includeIgnored === true
      }, async ({ abs: fileAbs, rel, dirent }) => {
        if (dirent && dirent.isDirectory()) return false;
        if (!dirent && !rootStat.isDirectory()) { /* direct file */ }
        if (!matchesGlob(rel, include)) return false;
        files.push({ abs: fileAbs, rel });
        if (files.length >= maxFiles) {
          truncated = true;
          return true;
        }
        return false;
      });
    } else {
      files.push({ abs, rel: path.basename(abs) });
    }

    for (const file of files) {
      if (lines.length >= maxResults) {
        truncated = true;
        break;
      }
      let st;
      try {
        st = await fsp.stat(file.abs);
      } catch {
        skipped++;
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > maxFileBytes) {
        skipped++;
        continue;
      }
      filesScanned++;
      let content;
      try {
        content = await fsp.readFile(file.abs, 'utf8');
      } catch {
        skipped++;
        continue;
      }
      if (content.includes('\u0000')) {
        skipped++;
        continue;
      }
      const fileLines = content.split(/\r?\n/);
      const display = relToWorkspace(file.abs);
      for (let i = 0; i < fileLines.length; i++) {
        regex.lastIndex = 0;
        if (!regex.test(fileLines[i])) continue;
        matches++;
        const from = Math.max(0, i - contextLines);
        const to = Math.min(fileLines.length - 1, i + contextLines);
        for (let j = from; j <= to; j++) {
          const mark = j === i ? ':' : '-';
          lines.push(`${display}${mark}${j + 1}${mark === ':' ? ':' : '-'} ${fileLines[j]}`);
        }
        if (matches >= maxResults) {
          truncated = true;
          break;
        }
      }
    }

    const output = lines.length
      ? lines.join('\n') + (truncated ? `\n… [stopped at ${maxResults} matches]` : '')
      : `No matches for ${body.literal ? 'literal' : 'regex'} "${pattern}" in ${filesScanned} file(s).`;
    bump('grep');
    logActivity({
      tool: 'grep',
      ok: true,
      summary: `${pattern} in ${relToWorkspace(abs)}`,
      matches,
      files: filesScanned
    });
    return sendJson(res, 200, {
      ok: true,
      tool: 'grep',
      summary: `Found ${matches} match${matches === 1 ? '' : 'es'} in ${filesScanned} file(s)`,
      output,
      path: relToWorkspace(abs),
      matches,
      filesScanned,
      skipped,
      truncated
    }, origin);
  } catch (err) {
    logActivity({ tool: 'grep', ok: false, summary: pattern, error: err.message });
    return sendJson(res, err.status || 500, { ok: false, tool: 'grep', error: err.message }, origin);
  }
}

async function toolFind(body, res, origin) {
  let abs;
  try {
    abs = resolveInside(body.path || '.');
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, tool: 'find', error: err.message }, origin);
  }
  const pattern = String(body.pattern || body.glob || '*');
  const type = ['file', 'dir', 'dirs', 'files', 'any'].includes(String(body.type || 'any')) ? String(body.type || 'any') : 'any';
  const limit = intOption(body.limit, 500, 1, 5000);
  const results = [];
  let truncated = false;

  try {
    const walked = await walkPaths(abs, {
      maxDepth: body.maxDepth,
      maxVisited: body.maxVisited,
      includeHidden: body.includeHidden === true,
      includeIgnored: body.includeIgnored === true
    }, async ({ abs: full, rel, dirent }) => {
      const isDir = dirent ? dirent.isDirectory() : false;
      const typeOk = type === 'any' ||
        ((type === 'file' || type === 'files') && !isDir) ||
        ((type === 'dir' || type === 'dirs') && isDir);
      if (!typeOk) return false;
      if (!matchesGlob(rel, pattern) && !matchesGlob(path.basename(rel), pattern)) return false;
      results.push({ path: rel, type: isDir ? 'dir' : 'file', abs: full });
      if (results.length >= limit) {
        truncated = true;
        return true;
      }
      return false;
    });
    if (walked.stopped) truncated = true;

    const output = results.length
      ? results.map((item) => `${item.type === 'dir' ? 'd' : 'f'}  ${item.path}${item.type === 'dir' ? '/' : ''}`).join('\n') +
        (truncated ? `\n… [limited to ${limit} results]` : '')
      : `No ${type === 'any' ? 'files or folders' : type} matched "${pattern}" in ${relToWorkspace(abs)}.`;
    bump('find');
    logActivity({ tool: 'find', ok: true, summary: `${pattern} in ${relToWorkspace(abs)}`, matches: results.length });
    return sendJson(res, 200, {
      ok: true,
      tool: 'find',
      summary: `Found ${results.length} path${results.length === 1 ? '' : 's'}`,
      output,
      path: relToWorkspace(abs),
      entries: results.map(({ path: p, type: t }) => ({ path: p, type: t })),
      visited: walked.visited,
      truncated
    }, origin);
  } catch (err) {
    logActivity({ tool: 'find', ok: false, summary: pattern, error: err.message });
    return sendJson(res, err.status || 500, { ok: false, tool: 'find', error: err.message }, origin);
  }
}

async function toolCopy(body, res, origin) {
  try {
    const from = resolveInside(body.from);
    const to = resolveInside(body.to);
    if (samePath(from, to)) throw new HttpError(400, 'Source and destination are the same path.');
    const fromStat = await fsp.stat(from);
    if (fromStat.isDirectory() && isInside(to, from)) throw new HttpError(400, 'Cannot copy a folder inside itself.');
    assertSafeDestructiveTarget(to, 'copy');
    const overwrite = body.overwrite === true;
    let exists = false;
    let destStat = null;
    try {
      destStat = await fsp.lstat(to);
      exists = true;
    } catch { /* missing */ }
    if (exists) {
      if (fromStat.isDirectory() !== destStat.isDirectory()) {
        throw new HttpError(409, 'Source and destination must both be files or both be folders.');
      }
      if (destStat.isDirectory() && (isInside(from, to) || isInside(to, from))) {
        throw new HttpError(400, 'Cannot copy a folder into itself or over one of its own parent folders.');
      }
      if (!overwrite) throw new HttpError(409, `Destination already exists: ${relToWorkspace(to)}. Pass "overwrite": true to replace it.`);
      assertSafeDestructiveTarget(to, 'overwrite');
      await fsp.rm(to, { recursive: true, force: true });
    }
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: true });
    bump('copy');
    const relFrom = relToWorkspace(from);
    const relTo = relToWorkspace(to);
    logActivity({ tool: 'copy', ok: true, summary: `${relFrom} → ${relTo}` });
    return sendJson(res, 200, {
      ok: true,
      tool: 'copy',
      summary: `Copied ${relFrom} → ${relTo}`,
      output: `Copied ${relFrom} to ${relTo}${overwrite ? ' (replaced existing destination)' : ''}.`,
      from: relFrom,
      to: relTo,
      size: fromStat.isDirectory() ? undefined : fromStat.size
    }, origin);
  } catch (err) {
    return sendJson(res, err.status || (err.code === 'ENOENT' ? 404 : 500), { ok: false, tool: 'copy', error: err.message }, origin);
  }
}

async function toolHash(body, res, origin) {
  const algorithm = String(body.algorithm || 'sha256').toLowerCase();
  if (!['sha256', 'sha1', 'sha512', 'md5'].includes(algorithm)) {
    return sendJson(res, 400, { ok: false, tool: 'hash', error: 'algorithm must be sha256, sha1, sha512, or md5' }, origin);
  }
  const inputs = Array.isArray(body.paths) ? body.paths : [body.path];
  if (!inputs.length || inputs.length > 50) {
    return sendJson(res, 400, { ok: false, tool: 'hash', error: 'Provide 1-50 paths.' }, origin);
  }
  try {
    const rows = [];
    for (const input of inputs) {
      const abs = resolveInside(input);
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) throw new HttpError(400, 'Not a file: ' + relToWorkspace(abs));
      const digest = await hashFile(abs, algorithm);
      rows.push({ path: relToWorkspace(abs), hash: digest, algorithm, size: stat.size });
    }
    const output = rows.map((r) => `${r.algorithm} ${r.hash}  ${r.path} (${formatBytes(r.size)})`).join('\n');
    bump('hash');
    logActivity({ tool: 'hash', ok: true, summary: rows.map((r) => r.path).join(', '), algorithm });
    return sendJson(res, 200, {
      ok: true,
      tool: 'hash',
      summary: `Hashed ${rows.length} file${rows.length === 1 ? '' : 's'} (${algorithm})`,
      output,
      results: rows
    }, origin);
  } catch (err) {
    return sendJson(res, err.status || (err.code === 'ENOENT' ? 404 : 500), { ok: false, tool: 'hash', error: err.message }, origin);
  }
}

async function toolFetch(body, res, origin) {
  const timeoutSec = intOption(body.timeout, 30, 5, 120);
  const maxBytes = intOption(body.maxBytes, 200 * 1024, 1024, 2 * 1024 * 1024);
  let url;
  try {
    url = validateHttpUrl(body.url);
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, tool: 'fetch', error: err.message }, origin);
  }
  try {
    const request = await fetchWithTimeout(url.href, timeoutSec);
    const response = request.response;
    try {
      const { buffer, truncated } = await readResponseBuffer(response, maxBytes);
      const contentType = response.headers.get('content-type') || '';
      const binary = buffer.includes(0) || /^(image|audio|video|application\/(?:pdf|zip|octet-stream|x-7z|gzip))/i.test(contentType);
      const bodyText = binary
        ? ''
        : buffer.toString('utf8');
      const output = binary
        ? `[binary response: ${contentType || 'unknown type'}, ${formatBytes(buffer.length)}${truncated ? ' (truncated)' : ''}. Use download to save it.]`
        : bodyText + (truncated ? `\n… [truncated at ${formatBytes(maxBytes)}]` : '');
      bump('fetch');
      logActivity({
        tool: 'fetch',
        ok: true,
        summary: `${url.href} → HTTP ${response.status}`,
        status: response.status,
        bytes: buffer.length
      });
      return sendJson(res, 200, {
        ok: true,
        tool: 'fetch',
        summary: `Fetched ${url.href} (HTTP ${response.status}, ${formatBytes(buffer.length)})`,
        output,
        url: url.href,
        httpStatus: response.status,
        httpOk: response.ok,
        contentType,
        bytes: buffer.length,
        binary,
        truncated
      }, origin);
    } finally {
      request.finish();
    }
  } catch (err) {
    const message = err.name === 'AbortError' ? `Request timed out after ${timeoutSec}s.` : err.message;
    logActivity({ tool: 'fetch', ok: false, summary: url.href, error: message });
    return sendJson(res, 502, { ok: false, tool: 'fetch', error: message }, origin);
  }
}

async function toolDownload(body, res, origin) {
  let abs;
  let url;
  try {
    abs = resolveInside(body.path);
    url = validateHttpUrl(body.url);
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, tool: 'download', error: err.message }, origin);
  }
  const timeoutSec = intOption(body.timeout, 120, 5, 600);
  const maxBytes = intOption(body.maxBytes, 50 * 1024 * 1024, 1024, 250 * 1024 * 1024);
  const overwrite = body.overwrite === true;
  const part = abs + '.pcb-part';
  let handle;
  let request = null;

  try {
    let exists = false;
    try {
      await fsp.lstat(abs);
      exists = true;
    } catch { /* missing */ }
    if (exists) {
      const destStat = await fsp.lstat(abs);
      if (destStat.isDirectory()) {
        throw new HttpError(409, `Destination is a folder: ${relToWorkspace(abs)}. Choose a file path instead.`);
      }
    }
    if (exists && !overwrite) throw new HttpError(409, `Destination already exists: ${relToWorkspace(abs)}. Pass "overwrite": true to replace it.`);
    if (exists) assertSafeDestructiveTarget(abs, 'overwrite');
    await fsp.mkdir(path.dirname(abs), { recursive: true });

    request = await fetchWithTimeout(url.href, timeoutSec);
    const response = request.response;
    if (!response.ok) {
      const { buffer } = await readResponseBuffer(response, 4096);
      throw new HttpError(502, `Download failed with HTTP ${response.status}: ${buffer.toString('utf8').slice(0, 300)}`);
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) {
      throw new HttpError(413, `File is ${formatBytes(declared)}, larger than the ${formatBytes(maxBytes)} limit.`);
    }
    const contentType = response.headers.get('content-type') || '';
    handle = await fsp.open(part, 'w');
    let written = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          const chunk = Buffer.from(value);
          if (written + chunk.length > maxBytes) {
            throw new HttpError(413, `Download exceeded the ${formatBytes(maxBytes)} limit.`);
          }
          await handle.write(chunk);
          written += chunk.length;
        }
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
      }
    }
    await handle.close();
    handle = null;
    if (exists) await fsp.rm(abs, { recursive: true, force: true });
    await fsp.rename(part, abs);
    bump('download');
    const rel = relToWorkspace(abs);
    logActivity({ tool: 'download', ok: true, summary: `${rel} (${formatBytes(written)})`, bytes: written });
    return sendJson(res, 200, {
      ok: true,
      tool: 'download',
      summary: `Downloaded ${formatBytes(written)} to ${rel}`,
      output: `Downloaded ${formatBytes(written)} from ${url.href} to ${rel}.`,
      path: rel,
      url: url.href,
      bytes: written,
      contentType
    }, origin);
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    try { await fsp.rm(part, { force: true }); } catch { /* ignore */ }
    const message = err.name === 'AbortError' ? `Download timed out after ${timeoutSec}s.` : err.message;
    logActivity({ tool: 'download', ok: false, summary: String(body.path), error: message });
    return sendJson(res, err.status || 502, { ok: false, tool: 'download', error: message }, origin);
  } finally {
    if (request) request.finish();
  }
}

async function toolSystem(body, res, origin) {
  try {
    const cpus = os.cpus();
    const memory = { total: os.totalmem(), free: os.freemem() };
    let disk = null;
    try {
      const st = await fsp.statfs(config.workspace);
      disk = {
        total: Number(st.blocks) * Number(st.bsize),
        free: Number(st.bfree) * Number(st.bsize)
      };
    } catch {
      /* statfs is not available on every platform/filesystem */
    }
    const info = {
      platform: process.platform,
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      hostname: os.hostname(),
      cpu: { count: cpus.length, model: cpus[0] ? cpus[0].model : 'unknown' },
      memory,
      disk,
      uptimeSec: Math.floor(os.uptime()),
      node: process.version,
      workspace: config.workspace,
      fullPcAccess: config.fullPcAccess,
      shell: 'powershell',
      time: new Date().toISOString()
    };
    const output = [
      `OS: ${info.os} (${info.platform}, ${info.arch})`,
      `Host: ${info.hostname}`,
      `CPU: ${info.cpu.count} × ${info.cpu.model}`,
      `Memory: ${formatBytes(memory.free)} free of ${formatBytes(memory.total)}`,
      disk ? `Workspace disk: ${formatBytes(disk.free)} free of ${formatBytes(disk.total)}` : 'Workspace disk: unknown',
      `Node: ${info.node}`,
      `Uptime: ${Math.floor(info.uptimeSec / 3600)}h ${Math.floor((info.uptimeSec % 3600) / 60)}m`,
      `Workspace: ${info.workspace}`,
      `File access: ${info.fullPcAccess ? 'FULL PC' : 'workspace only'}`
    ].join('\n');
    bump('system');
    logActivity({ tool: 'system', ok: true, summary: `${info.os} · ${info.arch}` });
    return sendJson(res, 200, {
      ok: true,
      tool: 'system',
      summary: `${info.os} · ${info.arch} · ${info.cpu.count} CPUs`,
      output,
      system: info
    }, origin);
  } catch (err) {
    return sendJson(res, 500, { ok: false, tool: 'system', error: err.message }, origin);
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
      tools: TOOL_NAMES,
      toolCount: TOOL_NAMES.length,
      platforms: platformsPayload(),
      customPlatforms: [...config.customPlatforms],
      time: new Date().toISOString()
    }, origin);
  }

  if (tool === 'log') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'Invalid or missing token' }, origin);
    return sendJson(res, 200, {
      ok: true,
      entries: activity.slice(0, 100),
      paused,
      fullPcAccess: config.fullPcAccess,
      counters,
      platforms: platformsPayload(),
      customPlatforms: [...config.customPlatforms]
    }, origin);
  }

  if (tool === 'platforms') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'Invalid or missing token' }, origin);
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...platformsPayload() }, origin);
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'Use GET or POST for /api/platforms' }, origin);
    }

    const body = await readBody(req);
    const action = String(body.action || 'add').toLowerCase();
    if (action === 'add') {
      const value = String(body.origin || body.url || '').trim();
      if (!value) return sendJson(res, 400, { ok: false, error: 'Enter a site URL, for example https://chat.example.com' }, origin);
      const normalized = canonicalOrigin(value);
      if (!normalized) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Enter a valid http(s) website. For example: https://chat.example.com'
        }, origin);
      }
      if (BUILTIN_ORIGINS.has(normalized)) {
        return sendJson(res, 200, {
          ok: true,
          isBuiltin: true,
          added: false,
          message: `${normalized} is already supported out of the box.`,
          ...platformsPayload()
        }, origin);
      }
      if (config.customPlatforms.includes(normalized)) {
        return sendJson(res, 200, {
          ok: true,
          added: false,
          message: `${normalized} is already in your platform list.`,
          ...platformsPayload()
        }, origin);
      }
      if (config.customPlatforms.length >= MAX_CUSTOM_PLATFORMS) {
        return sendJson(res, 400, {
          ok: false,
          error: `You can add up to ${MAX_CUSTOM_PLATFORMS} custom platforms. Remove one first.`
        }, origin);
      }
      setCustomPlatforms([...config.customPlatforms, normalized]);
      bump('platforms');
      logActivity({ tool: 'platforms', ok: true, summary: `Added AI platform ${normalized}` });
      return sendJson(res, 200, {
        ok: true,
        added: true,
        origin: normalized,
        message: `${normalized} added.`,
        ...platformsPayload()
      }, origin);
    }

    if (action === 'remove') {
      const normalized = canonicalOrigin(body.origin || body.url || '');
      if (!normalized) return sendJson(res, 400, { ok: false, error: 'A valid site URL is required.' }, origin);
      if (BUILTIN_ORIGINS.has(normalized)) {
        return sendJson(res, 400, { ok: false, error: 'Built-in platforms cannot be removed.' }, origin);
      }
      const next = config.customPlatforms.filter((item) => item !== normalized);
      if (next.length === config.customPlatforms.length) {
        return sendJson(res, 404, { ok: false, error: `${normalized} is not in your platform list.` }, origin);
      }
      setCustomPlatforms(next);
      bump('platforms');
      logActivity({ tool: 'platforms', ok: true, summary: `Removed AI platform ${normalized}` });
      return sendJson(res, 200, {
        ok: true,
        removed: normalized,
        message: `${normalized} removed.`,
        ...platformsPayload()
      }, origin);
    }

    if (action === 'clear') {
      if (!config.customPlatforms.length) {
        return sendJson(res, 200, { ok: true, removed: [], message: 'No custom platforms to clear.', ...platformsPayload() }, origin);
      }
      const removed = [...config.customPlatforms];
      setCustomPlatforms([]);
      bump('platforms');
      logActivity({ tool: 'platforms', ok: true, summary: `Cleared ${removed.length} custom AI platform(s)` });
      return sendJson(res, 200, { ok: true, removed, message: 'Custom platforms cleared.', ...platformsPayload() }, origin);
    }

    return sendJson(res, 400, { ok: false, error: 'Unknown platforms action: ' + action }, origin);
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
    case 'edit': return toolEdit(body, res, origin);
    case 'grep': return toolGrep(body, res, origin);
    case 'find': return toolFind(body, res, origin);
    case 'copy': return toolCopy(body, res, origin);
    case 'hash': return toolHash(body, res, origin);
    case 'download': return toolDownload(body, res, origin);
    case 'fetch': return toolFetch(body, res, origin);
    case 'system': return toolSystem(body, res, origin);
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
  console.log(`  Platforms : ${BUILTIN_PLATFORMS.length} built-in${config.customPlatforms.length ? ` + ${config.customPlatforms.length} custom` : ''}`);
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
