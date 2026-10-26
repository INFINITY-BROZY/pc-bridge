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
  fullPcAccess: false,
  revealed: false,
  running: false,
  lastPing: 0,
  entries: [],
  clearedAt: 0,
  workspace: WORKSPACE,
  platforms: { builtin: [], custom: [], maxCustom: 50 },
  platformKey: '',
  toolCount: 0,
  platformBusy: false
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
  accessCard: $('#accessCard'),
  accessTag: $('#accessTag'),
  accessDesc: $('#accessDesc'),
  accessState: $('#accessState'),
  accessStateText: $('#accessStateText'),
  accessToggleBtn: $('#accessToggleBtn'),
  accessConfirm: $('#accessConfirm'),
  accessConfirmInput: $('#accessConfirmInput'),
  accessConfirmBtn: $('#accessConfirmBtn'),
  accessCancelBtn: $('#accessCancelBtn'),
  accessError: $('#accessError'),
  accessMsg: $('#accessMsg'),
  accessBanner: $('#accessBanner'),
  accessBannerBtn: $('#accessBannerBtn'),
  platformCount: $('#platformCount'),
  platformList: $('#platformList'),
  platformInput: $('#platformInput'),
  platformAddBtn: $('#platformAddBtn'),
  platformMsg: $('#platformMsg'),
  platformClearBtn: $('#platformClearBtn'),
  toolCount: $('#toolCount'),
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

function updateStatus() {
  if (state.paused) {
    setStatus('Paused', 'paused');
    els.pauseBtn.textContent = 'Resume AI access';
  } else if (state.fullPcAccess) {
    setStatus('Full PC access', 'danger');
    els.pauseBtn.textContent = 'Pause AI access';
  } else {
    setStatus('Online', 'online');
    els.pauseBtn.textContent = 'Pause AI access';
  }
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
    state.fullPcAccess = Boolean(data.fullPcAccess);
    if (data.platforms) applyPlatforms(data);
    const execs = (data.counters && data.counters.exec) || 0;
    els.cmdCount.textContent = String(execs);
    renderActivity();
    renderAccess();
    updateStatus();
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
    state.fullPcAccess = Boolean(data.fullPcAccess);
    applyPlatforms(data);
    els.uptime.textContent = fmtUptime(data.uptimeSec);
    els.nodeVer.textContent = String(data.node || '—').replace(/^v/, 'v');
    els.platform.textContent = data.platform === 'win32' ? 'Windows' : (data.platform || '—');
    state.workspace = data.workspace || state.workspace;
    els.wsPath.textContent = state.workspace;
    els.shellTag.textContent = data.shell === 'powershell' ? 'PowerShell' : 'Shell';
    renderAccess();
    updateStatus();
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
    updateStatus();
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

/* ---------------- full PC access ---------------- */

function renderAccess() {
  const full = Boolean(state.fullPcAccess);
  els.accessCard.classList.toggle('on', full);
  els.accessTag.textContent = full ? 'full PC' : 'workspace';
  els.accessTag.className = full ? 'tag danger' : 'tag';
  els.accessDesc.textContent = full
    ? 'AI file tools can read, write, move, and remove files anywhere on this PC.'
    : 'AI file tools are locked to the project location.';
  els.accessState.dataset.state = full ? 'danger' : 'safe';
  els.accessStateText.textContent = full ? 'Full PC access is ON' : 'Workspace only';
  els.accessToggleBtn.textContent = full ? 'Return to workspace only' : 'Enable full PC access';
  els.accessToggleBtn.classList.toggle('danger', !full);
  els.accessToggleBtn.classList.toggle('ghost', full);
  els.accessBanner.classList.toggle('hidden', !full);
}

function showAccessConfirm(show) {
  els.accessConfirm.classList.toggle('hidden', !show);
  els.accessToggleBtn.classList.toggle('hidden', show);
  els.accessError.classList.add('hidden');
  if (show) {
    els.accessConfirmInput.value = '';
    els.accessConfirmInput.focus();
  }
}

async function setFullAccess(enabled, confirmation) {
  els.accessToggleBtn.disabled = true;
  els.accessConfirmBtn.disabled = true;
  try {
    const data = await api('access', {
      fullPcAccess: Boolean(enabled),
      confirmation: confirmation || ''
    });
    state.fullPcAccess = Boolean(data.fullPcAccess);
    renderAccess();
    updateStatus();
    showAccessConfirm(false);
    els.accessMsg.textContent = state.fullPcAccess
      ? 'Full PC access is ON. Click "Re-send protocol" in the bridge panel so the chat learns it can use absolute paths.'
      : 'File access is back to workspace only. Re-send the protocol to update the chat.';
    els.accessMsg.className = 'ws-msg good';
    els.accessMsg.classList.remove('hidden');
    refreshLog();
    ping();
  } catch (err) {
    if (enabled) {
      els.accessError.textContent = err.message;
      els.accessError.classList.remove('hidden');
    } else {
      els.accessMsg.textContent = err.message;
      els.accessMsg.className = 'ws-msg';
      els.accessMsg.classList.remove('hidden');
    }
  } finally {
    els.accessToggleBtn.disabled = false;
    els.accessConfirmBtn.disabled = false;
  }
}

function toggleAccess() {
  if (state.fullPcAccess) setFullAccess(false);
  else showAccessConfirm(true);
}

function confirmAccess() {
  const phrase = els.accessConfirmInput.value.trim();
  if (phrase.toUpperCase() !== 'FULL PC ACCESS') {
    els.accessError.textContent = 'Type FULL PC ACCESS exactly to continue.';
    els.accessError.classList.remove('hidden');
    els.accessConfirmInput.focus();
    return;
  }
  setFullAccess(true, phrase);
}

/* ---------------- AI platforms ---------------- */

function platformName(origin) {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return origin;
  }
}

function platformMessage(text, good) {
  if (!text) {
    els.platformMsg.textContent = '';
    els.platformMsg.className = 'ws-msg hidden';
    return;
  }
  els.platformMsg.textContent = text;
  els.platformMsg.className = 'ws-msg' + (good ? ' good' : '');
}

function applyPlatforms(data) {
  if (!data) return;
  const payload = data.platforms && Array.isArray(data.platforms.builtin)
    ? data.platforms
    : Array.isArray(data.builtin) ? data : null;
  if (!payload) return;
  state.platforms = {
    builtin: payload.builtin,
    custom: Array.isArray(payload.custom) ? payload.custom : [],
    maxCustom: Number(payload.maxCustom) || 50
  };
  const count = Number(data.toolCount);
  if (Number.isFinite(count) && count > 0) state.toolCount = count;
  renderPlatforms();
}

function platformOpenButton(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn tiny ghost';
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

function renderPlatforms() {
  const builtin = state.platforms.builtin || [];
  const custom = state.platforms.custom || [];
  const total = builtin.length + custom.length;
  els.platformCount.textContent = total === 1 ? '1 site' : `${total} sites`;
  els.toolCount.textContent = String(state.toolCount || 17);
  els.platformClearBtn.classList.toggle('hidden', custom.length === 0);

  const key = JSON.stringify([builtin.map((p) => p.origin), custom]);
  if (key === state.platformKey) return;
  state.platformKey = key;

  els.platformList.textContent = '';
  if (!total) {
    const empty = document.createElement('div');
    empty.className = 'empty small';
    empty.textContent = 'No sites configured. Add one below.';
    els.platformList.append(empty);
    return;
  }

  const rows = [
    ...builtin.map((item) => ({
      name: item.name || platformName(item.origin),
      origin: item.origin,
      custom: false
    })),
    ...custom.map((origin) => ({
      name: platformName(origin),
      origin,
      custom: true
    }))
  ];

  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'platform' + (row.custom ? ' custom-row' : '');

    const main = document.createElement('div');
    main.className = 'platform-main';
    const name = document.createElement('span');
    name.className = 'platform-name';
    name.textContent = row.name;
    const origin = document.createElement('span');
    origin.className = 'platform-origin';
    origin.textContent = row.origin;
    origin.title = row.origin;
    main.append(name, origin);

    const kind = document.createElement('span');
    kind.className = 'tag' + (row.custom ? ' custom' : '');
    kind.textContent = row.custom ? 'custom' : 'built-in';

    const actions = document.createElement('div');
    actions.className = 'platform-actions';
    actions.append(platformOpenButton('Open', () => {
      window.open(row.origin + '/', '_blank', 'noopener,noreferrer');
    }));
    if (row.custom) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn tiny danger';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => removePlatform(row.origin));
      actions.append(remove);
    }

    el.append(main, kind, actions);
    els.platformList.append(el);
  }
}

async function addPlatform() {
  if (state.platformBusy) return;
  const value = els.platformInput.value.trim();
  if (!value) {
    platformMessage('Enter a site address, for example https://chat.example.com', false);
    els.platformInput.focus();
    return;
  }
  state.platformBusy = true;
  els.platformAddBtn.disabled = true;
  els.platformAddBtn.textContent = 'Adding…';
  platformMessage('');
  try {
    const data = await api('platforms', { action: 'add', origin: value });
    applyPlatforms(data);
    els.platformInput.value = '';
    platformMessage(data.message || `${value} added.`, true);
    refreshLog();
  } catch (err) {
    platformMessage(err.message, false);
  } finally {
    state.platformBusy = false;
    els.platformAddBtn.disabled = false;
    els.platformAddBtn.textContent = 'Add site';
  }
}

async function removePlatform(origin) {
  if (state.platformBusy) return;
  if (!window.confirm(`Remove ${origin} from the platform list?\n\nBuilt-in sites are unaffected. Revoke browser access separately in the extension options page.`)) return;
  state.platformBusy = true;
  try {
    const data = await api('platforms', { action: 'remove', origin });
    applyPlatforms(data);
    platformMessage(data.message || `${origin} removed.`, true);
  } catch (err) {
    platformMessage(err.message, false);
  } finally {
    state.platformBusy = false;
  }
}

async function clearPlatforms() {
  if (state.platformBusy) return;
  const count = state.platforms.custom.length;
  if (!count) return;
  if (!window.confirm(`Remove all ${count} custom site${count === 1 ? '' : 's'}? Built-in sites stay available.`)) return;
  state.platformBusy = true;
  try {
    const data = await api('platforms', { action: 'clear' });
    applyPlatforms(data);
    platformMessage(data.message || 'Custom sites cleared.', true);
  } catch (err) {
    platformMessage(err.message, false);
  } finally {
    state.platformBusy = false;
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
els.accessToggleBtn.addEventListener('click', toggleAccess);
els.accessBannerBtn.addEventListener('click', () => setFullAccess(false));
els.accessConfirmBtn.addEventListener('click', confirmAccess);
els.accessCancelBtn.addEventListener('click', () => showAccessConfirm(false));
els.accessConfirmInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    confirmAccess();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    showAccessConfirm(false);
  }
});
els.clearBtn.addEventListener('click', () => {
  state.clearedAt = Date.now();
  state.entries = [];
  renderActivity();
});

els.platformAddBtn.addEventListener('click', addPlatform);
els.platformInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addPlatform();
  }
});
els.platformClearBtn.addEventListener('click', clearPlatforms);

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
renderAccess();
ping();
refreshLog();

console.log('%cPC Bridge v' + VERSION, 'color:#22d3ee;font-weight:bold', '· dashboard ready');
