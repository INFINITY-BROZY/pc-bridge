'use strict';

/**
 * PC Bridge — background service worker.
 * All server calls go through here so CORS / private-network rules on the
 * chat page do not apply. Only localhost is allowed.
 */

const LOCAL_SERVER = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'PCB_CALL') return;
  handleCall(msg)
    .then((reply) => sendResponse(reply))
    .catch((err) => sendResponse({ transportOk: false, error: err.message || String(err) }));
  return true;
});

async function handleCall(msg) {
  const server = String(msg.server || '').replace(/\/+$/, '');
  if (!LOCAL_SERVER.test(server)) {
    return { transportOk: false, error: 'Server must be http://127.0.0.1 or http://localhost' };
  }

  const tool = String(msg.tool || '').replace(/[^a-z0-9_]/gi, '');
  if (!tool) return { transportOk: false, error: 'Missing tool name' };

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

// Toolbar icon toggles the panel on the active tab; otherwise opens the dashboard.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab && tab.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'PCB_TOGGLE' });
      return;
    } catch {
      /* not a bridged page */
    }
  }
  chrome.tabs.create({ url: 'http://127.0.0.1:8787/' });
});
