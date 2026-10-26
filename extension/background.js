'use strict';

/**
 * PC Bridge — background service worker.
 * All server calls go through here so CORS / private-network rules on the
 * chat page do not apply. The action button also grants per-site access and
 * injects the bridge into custom AI platforms on demand.
 */

const LOCAL_SERVER = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;
const DEFAULT_SERVER = 'http://127.0.0.1:8787';
const SETTINGS_KEY = 'pcbridge.settings.v1';
const CONTENT_FILES = ['shared.js', 'adapters.js', 'ui.js', 'content.js'];
const BUILTIN_ORIGINS = new Set([
  'https://chat.deepseek.com',
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://claude.ai',
  'https://gemini.google.com',
  'https://grok.com'
]);
const SAFE_TOOLS = new Set([
  'ping', 'workspace', 'open',
  'exec', 'write', 'read', 'list', 'mkdir', 'move', 'remove', 'stat',
  'edit', 'grep', 'find', 'copy', 'hash', 'download', 'fetch', 'system'
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'PCB_CALL') {
    handleCall(msg)
      .then((reply) => sendResponse(reply))
      .catch((err) => sendResponse({ transportOk: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === 'PCB_REGISTER_SITE') {
    registerSite(msg.origin)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === 'PCB_UNREGISTER_SITE') {
    unregisterSite(msg.origin)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === 'PCB_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
});

async function handleCall(msg) {
  const server = String(msg.server || '').replace(/\/+$/, '');
  if (!LOCAL_SERVER.test(server)) {
    return { transportOk: false, error: 'Server must be http://127.0.0.1 or http://localhost' };
  }

  const tool = String(msg.tool || '').replace(/[^a-z0-9_]/gi, '');
  if (!tool) return { transportOk: false, error: 'Missing tool name' };
  if (!SAFE_TOOLS.has(tool)) {
    return { transportOk: false, error: 'The extension is not allowed to call ' + tool + ' directly.' };
  }

  const method = msg.method === 'GET' ? 'GET' : 'POST';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), method === 'GET' ? 12000 : 16 * 60 * 1000);

  try {
    const res = await fetch(server + '/api/' + tool, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Token': String(msg.token || '')
      },
      body: method === 'GET' ? undefined : JSON.stringify(msg.params || {}),
      signal: controller.signal,
      cache: 'no-store'
    });

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { ok: false, error: text.slice(0, 500) || 'HTTP ' + res.status };
    }
    return { transportOk: true, status: res.status, body };
  } catch (err) {
    return {
      transportOk: false,
      error:
        err && err.name === 'AbortError'
          ? 'Request timed out (the command may still be running on the PC).'
          : `Cannot reach ${server} — is START-BRIDGE.bat running?`
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- custom-site injection ---------------- */

function canonicalOrigin(raw) {
  let value = String(raw || '').trim();
  if (!value) return null;
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

function originPattern(origin) {
  return origin + '/*';
}

function siteId(origin) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < origin.length; i++) {
    hash ^= origin.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return 'pcb-site-' + (hash >>> 0).toString(16);
}

async function getSettings() {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    return (got && got[SETTINGS_KEY]) || {};
  } catch {
    return {};
  }
}

function normalizeServer(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  return LOCAL_SERVER.test(value) ? value : DEFAULT_SERVER;
}

async function ensureRegistered(origin) {
  const id = siteId(origin);
  const matches = [originPattern(origin)];
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing && existing.length) return { registered: true, id };
  await chrome.scripting.registerContentScripts([
    {
      id,
      matches,
      js: CONTENT_FILES,
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true
    }
  ]);
  return { registered: true, id };
}

async function unregisterSite(origin) {
  const id = siteId(origin);
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch {
    /* already gone */
  }
  return { ok: true, id };
}

async function registerSite(origin) {
  const clean = canonicalOrigin(origin);
  if (!clean) return { ok: false, error: 'Invalid site origin.' };
  try {
    const result = await ensureRegistered(clean);
    return { ok: true, ...result, origin: clean };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function injectContent(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_FILES
  });
}

async function sendToggle(tabId) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'PCB_TOGGLE' });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
  }
  return false;
}

function flashBadge(tabId, text) {
  if (!tabId) return;
  chrome.action.setBadgeBackgroundColor({ color: '#0ea5e9' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 3500);
}

async function openDashboard() {
  const settings = await getSettings();
  const server = normalizeServer(settings.server);
  await chrome.tabs.create({ url: server + '/' });
}

async function rememberPlatform(settings, origin) {
  if (!settings.token) return { ok: false, error: 'No token saved yet.' };
  const server = normalizeServer(settings.server);
  try {
    const res = await fetch(server + '/api/platforms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Token': String(settings.token)
      },
      body: JSON.stringify({ action: 'add', origin }),
      cache: 'no-store'
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleActionClick(tab) {
  const rawUrl = tab && (tab.url || tab.pendingUrl);
  if (!tab || !tab.id || !rawUrl) return openDashboard();

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return openDashboard();
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return openDashboard();

  const origin = parsed.origin;
  const builtin = BUILTIN_ORIGINS.has(origin);

  // Built-in sites already have a declarative content script and need no
  // runtime permission prompt. Custom sites need an explicit, per-origin grant.
  if (!builtin) {
    // Request must be the first awaited action so the browser keeps the user
    // gesture from the toolbar click. If the permission is already granted this
    // resolves immediately without a prompt.
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
    } catch (err) {
      console.warn('[PC Bridge] permission request failed:', err);
    }
    if (!granted) {
      flashBadge(tab.id, '!');
      return;
    }
  }

  const settings = await getSettings();
  if (origin === normalizeServer(settings.server)) {
    await chrome.tabs.create({ url: normalizeServer(settings.server) + '/' });
    return;
  }

  if (!settings.token) {
    flashBadge(tab.id, 'KEY');
    chrome.runtime.openOptionsPage();
    return;
  }

  // Make the toolbar flow self-service: a custom site also appears in the
  // dashboard and extension options list. Failure is non-fatal because the
  // panel can still reconnect later.
  if (!builtin) {
    try {
      await rememberPlatform(settings, origin);
    } catch {
      /* non-fatal */
    }
  }

  try {
    if (!builtin) await ensureRegistered(origin);
    try {
      await injectContent(tab.id);
    } catch (err) {
      // Built-in pages normally already have the content script; if injection
      // is blocked, the toggle attempt below can still reach the existing one.
      console.warn('[PC Bridge] inject skipped:', err.message || err);
    }
    const shown = await sendToggle(tab.id);
    flashBadge(tab.id, shown ? 'ON' : '?');
  } catch (err) {
    console.warn('[PC Bridge] could not start on this page:', err);
    flashBadge(tab.id, '!');
  }
}

chrome.action.onClicked.addListener((tab) => {
  handleActionClick(tab).catch((err) => {
    console.warn('[PC Bridge] action failed:', err);
    openDashboard().catch(() => {});
  });
});
