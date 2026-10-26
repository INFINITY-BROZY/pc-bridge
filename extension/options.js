'use strict';

(() => {
  const SETTINGS_KEY = 'pcbridge.settings.v1';
  const DEFAULT_SERVER = 'http://127.0.0.1:8787';
  const LOCAL_SERVER = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

  const FALLBACK_BUILTIN = [
    { name: 'DeepSeek', origin: 'https://chat.deepseek.com' },
    { name: 'ChatGPT', origin: 'https://chatgpt.com' },
    { name: 'ChatGPT (legacy)', origin: 'https://chat.openai.com' },
    { name: 'Claude', origin: 'https://claude.ai' },
    { name: 'Gemini', origin: 'https://gemini.google.com' },
    { name: 'Grok', origin: 'https://grok.com' }
  ];

  const $ = (sel) => document.querySelector(sel);
  const state = {
    settings: {},
    server: DEFAULT_SERVER,
    token: '',
    builtin: FALLBACK_BUILTIN.slice(),
    custom: [],
    busy: false
  };

  const els = {
    server: $('#server'),
    token: $('#token'),
    save: $('#save'),
    dashboard: $('#dashboard'),
    connectionStatus: $('#connectionStatus'),
    connectionText: $('#connectionText'),
    connectionMsg: $('#connectionMsg'),
    siteInput: $('#siteInput'),
    addSite: $('#addSite'),
    refreshSites: $('#refreshSites'),
    siteMsg: $('#siteMsg'),
    siteList: $('#siteList')
  };

  function normalizeServer(raw) {
    const value = String(raw || '').trim().replace(/\/+$/, '') || DEFAULT_SERVER;
    if (!LOCAL_SERVER.test(value)) {
      throw new Error('Server must be http://127.0.0.1 or http://localhost');
    }
    return value;
  }

  function normalizeOrigin(raw) {
    let value = String(raw || '').trim();
    if (!value) throw new Error('Enter a site address first.');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error('Only http(s) sites are supported.');
      value = 'https://' + value;
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('Enter a valid website, for example https://chat.example.com');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only http(s) sites are supported.');
    }
    if (!parsed.hostname || parsed.username || parsed.password) {
      throw new Error('Enter a website without a username or password.');
    }
    return parsed.origin;
  }

  function originPattern(origin) {
    return origin + '/*';
  }

  function setStatus(kind, text) {
    const map = { good: 'good', bad: 'bad', warn: 'warn' };
    els.connectionStatus.className = 'status' + (map[kind] ? ' ' + map[kind] : '');
    els.connectionText.textContent = text;
  }

  function setMessage(el, text, good) {
    if (!text) {
      el.textContent = '';
      el.className = 'msg hidden';
      return;
    }
    el.textContent = text;
    el.className = 'msg' + (good ? ' good' : '');
  }

  function applySettings(settings) {
    state.settings = { ...settings };
    state.server = normalizeServer(settings.server);
    state.token = String(settings.token || '');
    els.server.value = state.server;
    els.token.value = state.token;
  }

  async function persistSettings() {
    const server = normalizeServer(els.server.value);
    const token = els.token.value.trim();
    state.server = server;
    state.token = token;
    let current = state.settings;
    try {
      const got = await chrome.storage.local.get(SETTINGS_KEY);
      if (got && got[SETTINGS_KEY]) current = got[SETTINGS_KEY];
    } catch {
      /* use the in-memory copy */
    }
    state.settings = { ...current, server, token };
    await chrome.storage.local.set({ [SETTINGS_KEY]: state.settings });
    return state.settings;
  }

  async function api(tool, params, method = 'POST') {
    if (!state.token) throw new Error('Paste the access token first.');
    const res = await fetch(state.server + '/api/' + tool, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Token': state.token
      },
      body: method === 'POST' ? JSON.stringify(params || {}) : undefined,
      cache: 'no-store'
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('The server returned an unreadable response (HTTP ' + res.status + ').');
    }
    if (res.status === 401) throw new Error('Token rejected. Copy it again from the dashboard.');
    if (!res.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  function applyPlatforms(data) {
    const platforms = data && data.platforms;
    if (platforms) {
      if (Array.isArray(platforms.builtin)) state.builtin = platforms.builtin;
      if (Array.isArray(platforms.custom)) state.custom = platforms.custom;
    } else if (data) {
      if (Array.isArray(data.builtin)) state.builtin = data.builtin;
      if (Array.isArray(data.custom)) state.custom = data.custom;
    }
  }

  async function testConnection(quiet) {
    els.save.disabled = true;
    if (!quiet) setStatus('', 'Connecting…');
    try {
      await persistSettings();
      const data = await api('ping', null, 'GET');
      applyPlatforms(data);
      const osName = data.platform === 'win32' ? 'Windows' : (data.platform || 'PC');
      setStatus('good', `Connected · PC Bridge v${data.version || '?'} · ${osName}`);
      setMessage(els.connectionMsg, '', true);
      els.dashboard.disabled = false;
      await renderSites();
      return data;
    } catch (err) {
      setStatus('bad', state.token ? 'Cannot connect' : 'Add your token');
      if (!quiet) setMessage(els.connectionMsg, err.message, false);
      if (!state.builtin.length) state.builtin = FALLBACK_BUILTIN.slice();
      await renderSites();
      return null;
    } finally {
      els.save.disabled = false;
    }
  }

  async function permissionGranted(origin) {
    try {
      return await chrome.permissions.contains({ origins: [originPattern(origin)] });
    } catch {
      return false;
    }
  }

  function siteButton(label, className, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tiny ' + className;
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
  }

  function setSiteMessage(text, good) {
    setMessage(els.siteMsg, text, good);
  }

  async function renderSites() {
    const rows = [
      ...state.builtin.map((item) => ({ ...item, custom: false })),
      ...state.custom.map((origin) => {
        let name = origin;
        try { name = new URL(origin).hostname; } catch { /* keep origin */ }
        return { name, origin, custom: true };
      })
    ];

    const permissions = await Promise.all(rows.map((row) => permissionGranted(row.origin)));
    els.siteList.textContent = '';

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No sites loaded yet.';
      els.siteList.append(empty);
      return;
    }

    rows.forEach((row, index) => {
      const granted = row.custom ? permissions[index] : true;
      const rowEl = document.createElement('div');
      rowEl.className = 'site';

      const main = document.createElement('div');
      main.className = 'site-main';
      const name = document.createElement('span');
      name.className = 'site-name';
      name.textContent = row.name || row.origin;
      const origin = document.createElement('span');
      origin.className = 'site-origin';
      origin.textContent = row.origin;
      main.append(name, origin);

      const kind = document.createElement('span');
      kind.className = 'badge ' + (row.custom ? 'custom' : '');
      kind.textContent = row.custom ? 'custom' : 'built-in';

      const access = document.createElement('span');
      access.className = 'badge ' + (granted ? 'good' : '');
      access.textContent = row.custom ? (granted ? 'allowed' : 'needs access') : 'ready';

      const actions = document.createElement('div');
      actions.className = 'site-actions';
      actions.append(
        siteButton('Open', 'ghost', () => chrome.tabs.create({ url: row.origin + '/' }))
      );
      if (row.custom) {
        actions.append(
          granted
            ? siteButton('Revoke', 'ghost', () => revokeAccess(row.origin))
            : siteButton('Grant access', 'primary', () => grantAccess(row.origin)),
          siteButton('Remove', 'danger', () => removeSite(row.origin))
        );
      }

      rowEl.append(main, kind, access, actions);
      els.siteList.append(rowEl);
    });
  }

  async function grantAccess(origin) {
    setSiteMessage('', true);
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
    } catch (err) {
      setSiteMessage(err.message || 'Chrome could not grant access.', false);
      return;
    }
    if (!granted) {
      setSiteMessage('Access was not granted. You can try again at any time.', false);
      return;
    }
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'PCB_REGISTER_SITE', origin });
      if (!reply || reply.ok !== true) throw new Error((reply && reply.error) || 'Could not register the site.');
      setSiteMessage(`${origin} is allowed. Open it and click the PC Bridge toolbar icon to show the panel.`, true);
    } catch (err) {
      setSiteMessage(err.message, false);
    }
    await renderSites();
  }

  async function revokeAccess(origin) {
    try {
      const removed = await chrome.permissions.remove({ origins: [originPattern(origin)] });
      await chrome.runtime.sendMessage({ type: 'PCB_UNREGISTER_SITE', origin });
      setSiteMessage(
        removed
          ? `Browser access revoked for ${origin}. Existing tabs stop working after a reload.`
          : 'Chrome keeps required built-in access. Remove the site from the dashboard instead.',
        removed
      );
    } catch (err) {
      setSiteMessage(err.message, false);
    }
    await renderSites();
  }

  async function removeSite(origin) {
    if (!window.confirm('Remove ' + origin + ' from PC Bridge and revoke browser access?')) return;
    try {
      const data = await api('platforms', { action: 'remove', origin });
      applyPlatforms(data);
      try { await chrome.permissions.remove({ origins: [originPattern(origin)] }); } catch { /* required permission */ }
      await chrome.runtime.sendMessage({ type: 'PCB_UNREGISTER_SITE', origin });
      setSiteMessage(`${origin} removed.`, true);
    } catch (err) {
      setSiteMessage(err.message, false);
    }
    await renderSites();
  }

  async function addSite() {
    let origin;
    try {
      origin = normalizeOrigin(els.siteInput.value);
    } catch (err) {
      setSiteMessage(err.message, false);
      return;
    }
    if (!state.token) {
      setSiteMessage('Save your server token first.', false);
      return;
    }
    if (state.busy) return;
    state.busy = true;
    els.addSite.disabled = true;
    setSiteMessage('', true);

    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
    } catch (err) {
      setSiteMessage(err.message || 'Chrome could not grant access.', false);
      state.busy = false;
      els.addSite.disabled = false;
      return;
    }
    if (!granted) {
      setSiteMessage('Access was not granted, so the site was not added.', false);
      state.busy = false;
      els.addSite.disabled = false;
      return;
    }

    let serverAdded = false;
    try {
      await persistSettings();
      const data = await api('platforms', { action: 'add', origin });
      serverAdded = true;
      applyPlatforms(data);
      const reply = await chrome.runtime.sendMessage({ type: 'PCB_REGISTER_SITE', origin });
      if (!reply || reply.ok !== true) throw new Error((reply && reply.error) || 'Site permission was granted but registration failed.');
      els.siteInput.value = '';
      setSiteMessage(`${origin} added and allowed. Open it and click the PC Bridge toolbar icon.`, true);
    } catch (err) {
      if (serverAdded) {
        setSiteMessage(
          `${origin} is in the server list, but the extension could not register it: ${err.message} Click "Grant access" to retry.`,
          false
        );
      } else {
        try {
          await chrome.permissions.remove({ origins: [originPattern(origin)] });
        } catch {
          /* ignore rollback failure */
        }
        setSiteMessage(`${err.message} Browser access was rolled back; fix the server and try again.`, false);
      }
    } finally {
      state.busy = false;
      els.addSite.disabled = false;
      await renderSites();
    }
  }

  async function refreshSites() {
    if (!state.token) {
      state.builtin = FALLBACK_BUILTIN.slice();
      await renderSites();
      setSiteMessage('Save your token to load custom sites from the server.', false);
      return;
    }
    els.refreshSites.disabled = true;
    try {
      await persistSettings();
      const data = await api('ping', null, 'GET');
      applyPlatforms(data);
      setMessage(els.siteMsg, '', true);
      await renderSites();
    } catch (err) {
      setSiteMessage(err.message, false);
      await renderSites();
    } finally {
      els.refreshSites.disabled = false;
    }
  }

  els.save.addEventListener('click', () => testConnection(false));
  els.dashboard.addEventListener('click', async () => {
    try {
      await persistSettings();
      await chrome.tabs.create({ url: state.server + '/' });
    } catch (err) {
      setMessage(els.connectionMsg, err.message, false);
    }
  });
  els.addSite.addEventListener('click', addSite);
  els.refreshSites.addEventListener('click', refreshSites);
  els.siteInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addSite();
    }
  });
  els.token.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      testConnection(false);
    }
  });

  if (chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(() => renderSites());
  if (chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(() => renderSites());

  (async () => {
    try {
      const got = await chrome.storage.local.get(SETTINGS_KEY);
      applySettings((got && got[SETTINGS_KEY]) || {});
    } catch {
      applySettings({});
    }
    els.dashboard.disabled = !state.token;
    if (state.token) {
      await testConnection(true);
    } else {
      setStatus('', 'Add your token to connect');
      await renderSites();
    }
    const footer = document.querySelector('footer');
    if (footer) footer.textContent = `PC Bridge v${chrome.runtime.getManifest().version} · local only · no analytics`;
  })();
})();
