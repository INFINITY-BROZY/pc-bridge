'use strict';

const $ = (sel) => document.querySelector(sel);
const meta = (name) => {
  const el = document.querySelector(`meta[name="${name}"]`);
  return el ? el.getAttribute('content') : '';
};

const TOKEN = meta('bridge-token');
const WORKSPACE = meta('bridge-workspace');
const VERSION = meta('bridge-version');
const PORT = meta('bridge-port');

const state = {
  paused: false,
  revealed: false,
  running: false,
  lastPing: 0,
  entries: [],
  clearedAt: 0,
  workspace: WORKSPACE
};

const els = {
  statusPill: $('#statusPill'),
  statusText: $('#statusText'),
  pauseBtn: $('#pauseBtn'),
  uptime: $('#uptime'),
  nodeVer: $('#nodeVer'),
  cmdCount: $('#cmdCount'),
  platform: $('#platform'),
  cmdInput: $('#cmdInput'),
  runBtn: $('#runBtn'),
  cmdOut: $('#cmdOut'),
  activity: $('#activity'),
  clearBtn: $('#clearBtn'),
  tokenValue: $('#tokenValue'),
  revealBtn: $('#revealBtn'),
  copyBtn: $('#copyBtn'),
  wsPath: $('#wsPath'),
  wsEdit: $('#wsEdit'),
  wsInput: $('#wsInput'),
  wsSaveBtn: $('#wsSaveBtn'),
  wsCancelBtn: $('#wsCancelBtn'),
  wsChangeBtn: $('#wsChangeBtn'),
  wsError: $('#wsError'),
  wsSaved: $('#wsSaved'),
  wsActions: $('#wsActions'),
  openBtn: $('#openBtn'),
  refreshBtn: $('#refreshBtn'),
  clock: $('#clock'),
  shellTag: $('#shellTag')
};

/* ---------------- api ---------------- */

async function api(tool, params, method = 'POST') {
  const opts = {
    method,
    headers: {
      'X-Bridge-Token': TOKEN,
      'Content-Type': 'application/json'
    },
    cache: 'no-store'
  };
  if (method === 'POST') opts.body = JSON.stringify(params || {});
  const res = await fetch('/api/' + tool, opts);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Bad response from server (HTTP ' + res.status + ')');
  }
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

/* ---------------- ui helpers ---------------- */

function setStatus(text, mode) {
  els.statusText.textContent = text;
  els.statusPill.dataset.state = mode || 'online';
}

function timeAgo(iso) {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  if (diff < 5000) return 'now';
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  return Math.floor(diff / 3600000) + 'h ago';
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ---------------- activity ---------------- */

function renderActivity() {
  const list = els.activity;
  if (!state.entries.length) {
    list.innerHTML = '<div class="empty">No activity yet. Connect the extension and give DeepSeek a project.</div>';
    return;
  }
  list.innerHTML = '';
  for (const e of state.entries) {
    const el = document.createElement('div');
    const badExit = e.exitCode !== undefined && e.exitCode !== null && e.exitCode !== 0;
    el.className = 'entry' + (e.ok === false || badExit ? ' bad' : '');

    const top = document.createElement('div');
    top.className = 'entry-top';

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = e.tool || '—';

    const what = document.createElement('span');
    what.className = 'what';
    let text = e.summary || '';
    if (e.exitCode !== undefined && e.exitCode !== null && e.exitCode !== 0) text += ' · exit ' + e.exitCode;
    if (e.durationMs) text += ' · ' + fmtDuration(e.durationMs);
    if (e.error) text += ' · ' + e.error;
    what.textContent = text;
    what.title = text;

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = timeAgo(e.ts);

    top.append(badge, what, when);
    el.append(top);

    if (e.detail) {
      const pre = document.createElement('pre');
      pre.textContent = truncate(e.detail, 280);
      el.append(pre);
    }
    list.append(el);
  }
}

async function refreshLog() {
  try {
    const data = await api('log', null, 'GET');
    const entries = (data.entries || []).filter((e) => e.ts && new Date(e.ts).getTime() >= state.clearedAt);
    state.entries = entries;
    state.paused = Boolean(data.paused);
    const execs = (data.counters && data.counters.exec) || 0;
    els.cmdCount.textContent = String(execs);
    renderActivity();
    if (data.paused) {
      setStatus('Paused', 'paused');
      els.pauseBtn.textContent = 'Resume AI access';
    } else {
      setStatus('Online', 'online');
      els.pauseBtn.textContent = 'Pause AI access';
    }
  } catch (err) {
    setStatus('Offline', 'paused');
  }
}

/* ---------------- ping ---------------- */

function fmtUptime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

async function ping() {
  try {
    const data = await api('ping', null, 'GET');
    state.lastPing = Date.now();
    state.paused = Boolean(data.paused);
    els.uptime.textContent = fmtUptime(data.uptimeSec);
    els.nodeVer.textContent = String(data.node || '—').replace(/^v/, 'v');
    els.platform.textContent = data.platform === 'win32' ? 'Windows' : (data.platform || '—');
    state.workspace = data.workspace || state.workspace;
    els.wsPath.textContent = state.workspace;
    els.shellTag.textContent = data.shell === 'powershell' ? 'PowerShell' : 'Shell';
    if (data.paused) {
      setStatus('Paused', 'paused');
      els.pauseBtn.textContent = 'Resume AI access';
    } else {
      setStatus('Online', 'online');
      els.pauseBtn.textContent = 'Pause AI access';
    }
    if (data.counts) els.cmdCount.textContent = String(data.counts.exec || 0);
  } catch (err) {
    setStatus('Offline', 'paused');
    els.uptime.textContent = '—';
  }
}

/* ---------------- actions ---------------- */

async function runCommand() {
  const command = els.cmdInput.value.trim();
  if (!command || state.running) return;
  state.running = true;
  els.runBtn.disabled = true;
  els.runBtn.textContent = 'Running…';
  els.cmdOut.classList.remove('hidden', 'good', 'bad');
  els.cmdOut.textContent = '$ ' + command + '\n\n…';
  try {
    const res = await api('exec', { command, timeout: 180 });
    let text = res.output || '(no output)';
    if (res.exitCode !== 0) text = `[exit ${res.exitCode}]\n` + text;
    els.cmdOut.textContent = text;
    els.cmdOut.classList.add(res.exitCode === 0 ? 'good' : 'bad');
  } catch (err) {
    els.cmdOut.textContent = 'ERROR: ' + err.message;
    els.cmdOut.classList.add('bad');
  } finally {
    state.running = false;
    els.runBtn.disabled = false;
    els.runBtn.textContent = 'Run';
    refreshLog();
    ping();
  }
}

async function togglePause() {
  els.pauseBtn.disabled = true;
  try {
    const data = await api('control', { paused: !state.paused });
    state.paused = Boolean(data.paused);
    setStatus(state.paused ? 'Paused' : 'Online', state.paused ? 'paused' : 'online');
    els.pauseBtn.textContent = state.paused ? 'Resume AI access' : 'Pause AI access';
  } catch (err) {
    setStatus('Error', 'paused');
  } finally {
    els.pauseBtn.disabled = false;
    refreshLog();
  }
}

function toggleToken() {
  state.revealed = !state.revealed;
  if (state.revealed) {
    els.tokenValue.textContent = TOKEN;
    els.tokenValue.dataset.revealed = 'true';
    els.revealBtn.textContent = 'Hide';
  } else {
    els.tokenValue.textContent = '••••••••••••••••••••••••';
    els.tokenValue.dataset.revealed = 'false';
    els.revealBtn.textContent = 'Reveal';
  }
}

async function copyToken() {
  const original = els.copyBtn.textContent;
  try {
    await navigator.clipboard.writeText(TOKEN);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = TOKEN;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  els.copyBtn.textContent = 'Copied ✓';
  els.copyBtn.disabled = true;
  setTimeout(() => {
    els.copyBtn.textContent = original;
    els.copyBtn.disabled = false;
  }, 1400);
}

async function openWorkspace() {
  els.openBtn.disabled = true;
  try {
    await api('open', { path: '.' });
  } catch (err) {
    els.openBtn.textContent = 'Failed';
    setTimeout(() => (els.openBtn.textContent = 'Open folder'), 1200);
  } finally {
    els.openBtn.disabled = false;
  }
}

/* ---------------- workspace ---------------- */

function setWsError(message) {
  if (!message) {
    els.wsError.classList.add('hidden');
    els.wsError.textContent = '';
    return;
  }
  els.wsError.textContent = message;
  els.wsError.classList.remove('hidden');
}

function showWorkspaceEditor(show) {
  els.wsEdit.classList.toggle('hidden', !show);
  els.wsActions.classList.toggle('hidden', show);
  els.wsSaved.classList.add('hidden');
  if (show) {
    setWsError('');
    els.wsInput.value = state.workspace;
    els.wsInput.focus();
    els.wsInput.select();
  }
}

async function saveWorkspace() {
  const value = els.wsInput.value.trim();
  if (!value) {
    setWsError('Enter a folder path.');
    els.wsInput.focus();
    return;
  }

  els.wsSaveBtn.disabled = true;
  els.wsSaveBtn.textContent = 'Saving…';
  setWsError('');

  try {
    const data = await api('workspace', { path: value });
    state.workspace = data.workspace || value;
    els.wsPath.textContent = state.workspace;
    showWorkspaceEditor(false);
    els.wsSaved.textContent = 'Project location saved. New projects will be created there.';
    els.wsSaved.className = 'ws-msg good';
    setTimeout(() => els.wsSaved.classList.add('hidden'), 6000);
    refreshLog();
    ping();
  } catch (err) {
    setWsError(err.message);
  } finally {
    els.wsSaveBtn.disabled = false;
    els.wsSaveBtn.textContent = 'Save location';
  }
}

/* ---------------- boot ---------------- */

els.runBtn.addEventListener('click', runCommand);
els.cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runCommand();
  }
});
els.pauseBtn.addEventListener('click', togglePause);
els.revealBtn.addEventListener('click', toggleToken);
els.copyBtn.addEventListener('click', copyToken);
els.openBtn.addEventListener('click', openWorkspace);
els.wsChangeBtn.addEventListener('click', () => showWorkspaceEditor(true));
els.wsCancelBtn.addEventListener('click', () => showWorkspaceEditor(false));
els.wsSaveBtn.addEventListener('click', saveWorkspace);
els.wsInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveWorkspace();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    showWorkspaceEditor(false);
  }
});
els.refreshBtn.addEventListener('click', () => { ping(); refreshLog(); });
els.clearBtn.addEventListener('click', () => {
  state.clearedAt = Date.now();
  state.entries = [];
  renderActivity();
});

setInterval(() => {
  els.clock.textContent = new Date().toLocaleTimeString();
}, 1000);

setInterval(() => {
  if (document.hidden) return;
  ping();
  refreshLog();
}, 4000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    ping();
    refreshLog();
  }
});

els.tokenValue.textContent = '••••••••••••••••••••••••';
els.wsPath.textContent = WORKSPACE;
ping();
refreshLog();

console.log('%cPC Bridge v' + VERSION, 'color:#22d3ee;font-weight:bold', '· dashboard ready');
