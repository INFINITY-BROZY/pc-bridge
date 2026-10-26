'use strict';

/**
 * PC Bridge — content controller.
 * Watches the newest AI answer for ```bridge blocks, executes them through
 * the local server, and sends the result back into the chat.
 */
(() => {
  if (window.__pcBridgeLoaded) return;
  window.__pcBridgeLoaded = true;

  const PCB = window.PCB;
  if (!PCB || !PCB.adapter) return;

  const HAS_EXT = typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
  const ui = PCB.createUI();

  const state = {
    settings: { ...PCB.DEFAULTS },
    info: null,
    online: false,
    enabled: false,
    busy: false,
    priming: false,
    halted: false,
    serverPaused: false,
    serverPauseNoticed: false,
    steps: 0,
    resultSeq: 0,
    processed: new Set(),
    processedOrder: [],
    stable: { text: '', count: 0 },
    pending: null,
    pendingSend: null,
    parseReported: '',
    errors: 0,
    taskDone: false,
    lastUrl: location.href,
    lastSentAt: 0
  };

  PCB.state = state;

  /* ---------------- settings ---------------- */

  function normalizeServer(raw) {
    let value = String(raw || '').trim().replace(/\/+$/, '');
    if (!value) value = PCB.DEFAULTS.server;
    if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(value)) return null;
    return value;
  }

  async function loadSettings() {
    try {
      if (HAS_EXT && chrome.storage && chrome.storage.local) {
        const got = await chrome.storage.local.get(PCB.SETTINGS_KEY);
        const saved = got && got[PCB.SETTINGS_KEY];
        state.settings = { ...PCB.DEFAULTS, ...(saved || {}) };
      } else {
        const raw = localStorage.getItem(PCB.SETTINGS_KEY);
        state.settings = { ...PCB.DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
      }
    } catch {
      state.settings = { ...PCB.DEFAULTS };
    }
    state.settings.selectors = { ...PCB.DEFAULTS.selectors, ...(state.settings.selectors || {}) };
    state.settings.server = normalizeServer(state.settings.server) || PCB.DEFAULTS.server;
    state.settings.maxSteps = Math.max(5, Number(state.settings.maxSteps) || PCB.DEFAULTS.maxSteps);
  }

  async function saveSettings() {
    try {
      if (HAS_EXT && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ [PCB.SETTINGS_KEY]: state.settings });
      } else {
        localStorage.setItem(PCB.SETTINGS_KEY, JSON.stringify(state.settings));
      }
    } catch {
      /* non-fatal */
    }
  }

  function applyExternalSettings(saved) {
    const next = { ...PCB.DEFAULTS, ...(saved || {}) };
    next.selectors = { ...PCB.DEFAULTS.selectors, ...(next.selectors || {}) };
    next.server = normalizeServer(next.server) || PCB.DEFAULTS.server;
    next.maxSteps = Math.max(5, Number(next.maxSteps) || PCB.DEFAULTS.maxSteps);
    const connectionChanged = next.server !== state.settings.server || next.token !== state.settings.token;
    state.settings = next;
    ui.setSettings(next);
    setStats();
    if (connectionChanged) {
      state.online = false;
      state.halted = false;
      if (next.token) {
        ping(true)
          .then(() => {
            ui.setStatus(state.enabled ? 'ready' : 'connected', 'ok');
            if (state.enabled) {
              invalidateAssistant();
              scheduleTick(200);
            }
          })
          .catch((err) => {
            ui.setConnected(PCB.truncate(err.message, 52), 'bad');
            ui.setStatus('offline', 'err');
          });
      }
    }
  }

  /* ---------------- server ---------------- */

  async function call(tool, params, method) {
    if (!state.settings.token) throw new Error('No token set — paste it from the dashboard.');

    if (HAS_EXT) {
      let reply;
      try {
        reply = await chrome.runtime.sendMessage({
          type: 'PCB_CALL',
          server: state.settings.server,
          token: state.settings.token,
          tool,
          params: params || {},
          method: method || 'POST'
        });
      } catch (err) {
        throw new Error('Extension background unavailable — reload the page.');
      }
      if (!reply) throw new Error('Extension background did not respond.');
      if (!reply.transportOk) throw new Error(reply.error || 'Cannot reach the PC Bridge server. Is START-BRIDGE.bat running?');
      if (reply.status === 401) throw new Error('Token rejected. Copy it again from the dashboard.');
      return reply.body || { ok: false, tool, error: 'Empty response from server' };
    }

    const res = await fetch(state.settings.server + '/api/' + tool, {
      method: method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Token': state.settings.token
      },
      body: method === 'GET' ? undefined : JSON.stringify(params || {})
    });
    const body = await res.json().catch(() => ({ ok: false, tool, error: 'Bad response from server' }));
    if (res.status === 401) throw new Error('Token rejected. Copy it again from the dashboard.');
    return body;
  }

  async function ping(quiet) {
    let info;
    try {
      info = await call('ping', null, 'GET');
    } catch (err) {
      if (/token|401/i.test(err.message || '')) throw err;
      await PCB.sleep(250);
      info = await call('ping', null, 'GET');
    }
    if (!info || info.ok !== true) throw new Error((info && info.error) || 'Ping failed');
    state.info = info;
    state.online = true;
    state.serverPaused = Boolean(info.paused);
    ui.setWorkspace(info.workspace || '');
    ui.setAccessMode(Boolean(info.fullPcAccess));

    if (state.serverPaused && !state.serverPauseNoticed) {
      state.serverPauseNoticed = true;
      ui.notice('The server is paused in the dashboard. Resume it there to continue.', 'warn');
    } else if (!state.serverPaused) {
      state.serverPauseNoticed = false;
    }

    if (!quiet) {
      ui.setConnected(`connected · ${info.platform === 'win32' ? 'Windows' : info.platform || 'ok'}`, 'good');
    }
    return info;
  }

  /* ---------------- log helpers ---------------- */

  function addLog(tool, summary, status, detail, bad) {
    return ui.addLog({ tool, summary, status, detail, bad });
  }

  function setStats() {
    ui.setStats(state.steps, state.settings.maxSteps, state.pending ? 'approval' : undefined);
  }

  /* ---------------- actions ---------------- */

  async function connect(userInitiated) {
    const form = ui.readForm();
    const server = normalizeServer(form.server);
    if (!server) {
      ui.setConnected('server must be 127.0.0.1 or localhost', 'bad');
      ui.setStatus('check server', 'err');
      return false;
    }
    if (!form.token) {
      ui.setConnected('token is empty', 'bad');
      ui.setStatus('need token', 'err');
      return false;
    }

    state.settings.server = server;
    state.settings.token = form.token;
    await saveSettings();
    ui.setConnected('connecting…');

    try {
      await ping(false);
      ui.setStatus(state.enabled ? 'ready' : 'connected', 'ok');
      if (userInitiated) addLog('bridge', 'Connected to ' + server, 'ok');
      if (state.enabled) {
        invalidateAssistant();
        scheduleTick(200);
      }
      return true;
    } catch (err) {
      state.online = false;
      const msg = /token/i.test(err.message) ? 'token rejected' : err.message;
      ui.setConnected(PCB.truncate(msg, 52), 'bad');
      ui.setStatus('offline', 'err');
      return false;
    }
  }

  async function saveForm() {
    const form = ui.readForm();
    const server = normalizeServer(form.server);
    if (server) state.settings.server = server;
    state.settings.token = form.token;
    await saveSettings();
  }

  async function saveToggles() {
    const toggles = ui.readToggles();
    state.settings.autoRun = toggles.autoRun;
    state.settings.autoSend = toggles.autoSend;
    state.settings.autoPrime = toggles.autoPrime;
    await saveSettings();
  }

  async function saveWorkspace() {
    const value = ui.readWorkspace();
    if (!value) {
      ui.setWorkspaceMessage('Enter a folder path.', 'bad');
      return false;
    }
    if (!state.settings.token) {
      ui.setWorkspaceMessage('Paste your token and connect first.', 'bad');
      return false;
    }

    ui.setWorkspaceMessage('saving…');
    try {
      const res = await call('workspace', { path: value });
      if (!res || res.ok !== true) throw new Error((res && res.error) || 'Could not change the folder');
      const ws = res.workspace || value;
      state.info = { ...(state.info || {}), workspace: ws };
      ui.setWorkspace(ws, 'saved', 'good', true);
      addLog('workspace', 'Project location → ' + ws, 'ok');
      ui.notice('Project location saved. New projects go to:\n' + ws, 'ok', [
        { label: 'Update this chat', primary: true, onClick: () => announceWorkspace(ws) }
      ]);
      return true;
    } catch (err) {
      ui.setWorkspaceMessage(err.message, 'bad');
      addLog('workspace', 'Could not change project location', 'failed', err.message, true);
      return false;
    }
  }

  async function announceWorkspace(workspace) {
    if (!state.enabled) {
      ui.notice('Turn the bridge on first, or start a new chat and send the protocol.', 'warn');
      return;
    }
    if (state.busy || state.priming || state.pending || state.pendingSend) {
      ui.notice('Wait for the current bridge step to finish, then update the chat.', 'warn');
      return;
    }
    if (PCB.adapter.composerHasDraft()) {
      ui.notice('Your chat box has text in it. Clear it, then update the chat.', 'warn');
      return;
    }

    const text =
      '[PC BRIDGE] Project location changed.\n\n' +
      'New workspace: ' + workspace + '\n\n' +
      'Use this folder as the workspace from now on. Create new projects inside it with relative paths.';
    const sent = await PCB.adapter.sendMessage(text);
    if (sent.ok) {
      state.lastSentAt = Date.now();
      addLog('workspace', 'Told the chat about the new location', 'sent');
      ui.notice('The chat now knows the new project location.', 'ok');
    } else {
      ui.notice('Could not send the update. Copy it and paste it into the chat.', 'warn', [
        { label: 'Copy update', onClick: () => copyText(text) }
      ]);
    }
  }

  async function togglePower() {
    if (state.enabled) {
      state.enabled = false;
      state.settings.enabled = false;
      state.pending = null;
      state.pendingSend = null;
      await saveSettings();
      ui.setEnabled(false);
      ui.setStatus('off', 'off');
      ui.clearNotice();
      addLog('bridge', 'Bridge turned off');
      return;
    }

    const ok = await connect(true);
    if (!ok) {
      ui.togglePanel(true);
      return;
    }

    state.enabled = true;
    state.settings.enabled = true;
    state.halted = false;
    state.taskDone = false;
    state.steps = 0;
    state.resultSeq = 0;
    state.processed.clear();
    state.processedOrder = [];
    state.stable = { text: '', count: 0 };
    state.pending = null;
    state.errors = 0;
    await saveSettings();
    ui.setEnabled(true);
    ui.setStatus('ready', 'ok');
    setStats();
    ui.clearNotice();

    setTimeout(() => ensurePrime(true), 500);
    invalidateAssistant();
    scheduleTick(700);
  }

  async function ensurePrime(userInitiated) {
    if (!state.enabled || state.priming) return;
    if (PCB.adapter.hasPrimeInPage()) {
      if (userInitiated) {
        ui.notice('This chat already has the bridge protocol. You are good to go.', 'ok');
      }
      return;
    }

    if (!userInitiated && !state.settings.autoPrime) return;
    if (!userInitiated) {
      const last = PCB.adapter.getLastAssistant();
      if (last) {
        ui.notice('This chat has no bridge protocol. Click "Re-send protocol" if you want to use it here.', 'warn');
        return;
      }
    }

    if (!state.online && !(await connect(false))) return;

    if (PCB.adapter.composerHasDraft()) {
      ui.notice('Your chat box has text in it. Clear it, then click "Re-send protocol".', 'warn', [
        { label: 'Retry', primary: true, onClick: () => ensurePrime(true) }
      ]);
      return;
    }

    state.priming = true;
    ui.setStatus('starting', 'busy');
    try {
      const text = PCB.buildPrime(state.info || {});
      const sent = await PCB.adapter.sendMessage(text);
      if (sent.ok) {
        addLog('bridge', 'Protocol sent — waiting for BRIDGE READY', 'ok');
        ui.setStatus('waiting', 'ok');
      } else {
        ui.setStatus('attention', 'warn');
        ui.notice(
          sent.reason === 'draft'
            ? 'The chat box has text in it, so the protocol was not sent. Clear it and retry.'
            : 'Could not send the protocol automatically. Click retry, or paste it manually.',
          'warn',
          [
            { label: 'Retry', primary: true, onClick: () => ensurePrime(true) },
            { label: 'Copy protocol', onClick: () => copyText(PCB.buildPrime(state.info || {})) }
          ]
        );
      }
    } catch (err) {
      ui.setStatus('error', 'err');
      ui.notice(err.message, 'err');
    } finally {
      state.priming = false;
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  async function sendResult(message) {
    if (PCB.adapter.composerHasDraft()) {
      ui.notice('The chat box has text in it (probably your draft), so the bridge did not overwrite it. Clear it, then retry.', 'warn', [
        { label: 'Retry send', primary: true, onClick: () => retrySend(message) },
        { label: 'Copy result', onClick: () => copyText(message) }
      ]);
      return false;
    }

    const sent = await PCB.adapter.sendMessage(message);
    if (sent.ok) {
      state.lastSentAt = Date.now();
      state.pendingSend = null;
      addLog('bridge', 'Result sent to the AI', 'sent');
      return true;
    }

    ui.notice(
      sent.reason === 'draft'
        ? 'The chat box filled up before the result could be sent. Clear it and retry.'
        : 'Could not send the result automatically. Copy it and paste it into the chat.',
      'warn',
      [
        { label: 'Retry send', primary: true, onClick: () => retrySend(message) },
        { label: 'Copy result', onClick: () => copyText(message) }
      ]
    );
    return false;
  }

  async function retrySend(message) {
    ui.clearNotice();
    const ok = await sendResult(message);
    if (ok) ui.setStatus('ready', 'ok');
  }

  function halt(reason, extraLabel) {
    state.halted = true;
    state.pending = null;
    ui.setStatus('paused', 'warn');
    ui.notice(reason, 'warn', [
      {
        label: extraLabel || 'Continue +10 steps',
        primary: true,
        onClick: async () => {
          state.halted = false;
          state.settings.maxSteps += 10;
          await saveSettings();
          setStats();
          ui.clearNotice();
          ui.setStatus('ready', 'ok');
        }
      }
    ]);
    ui.togglePanel(true);
  }

  async function saveSelectors() {
    state.settings.selectors = ui.readSelectors();
    await saveSettings();
    addLog('bridge', 'Selectors saved', 'ok');
    testSelectors(true);
    ui.notice('Selectors saved.', 'ok');
  }

  function testSelectors(quiet) {
    const composer = PCB.adapter.findComposer();
    const answer = PCB.adapter.getLastAssistant();
    const send = composer ? PCB.adapter.findSendButton(composer) : null;
    const detail = [
      'chat box: ' + (composer ? composer.tagName.toLowerCase() + (composer.id ? '#' + composer.id : '') : 'NOT FOUND'),
      'answer: ' + (answer ? `found (${answer.text.length} chars, ${answer.profile})` : 'NOT FOUND'),
      'send button: ' + (send ? send.getAttribute('aria-label') || send.tagName.toLowerCase() : 'not found (presses Enter instead)')
    ].join('\n');
    const good = Boolean(composer && answer);
    addLog('test', 'Finder check', good ? 'ok' : 'check', detail, !good);
    if (!quiet) {
      ui.togglePanel(true);
      ui.notice('Finder check complete — see Activity below.', good ? 'ok' : 'warn');
    }
  }

  function resetSession() {
    state.steps = 0;
    state.resultSeq = 0;
    state.processed.clear();
    state.processedOrder = [];
    state.stable = { text: '', count: 0 };
    state.pending = null;
    state.pendingSend = null;
    state.parseReported = '';
    state.errors = 0;
    state.halted = false;
    state.taskDone = false;
    ui.clearNotice();
    setStats();
    addLog('bridge', 'Session reset');
    if (state.enabled) ui.setStatus('ready', 'ok');
  }

  /* ---------------- approvals ---------------- */

  function renderApproval(ops, hash) {
    const first = ops[0];
    const label =
      ops.length === 1
        ? `${first.tool}: ${PCB.opSummary(first)}`
        : `${ops.length} steps, starting with ${first.tool}: ${PCB.opSummary(first)}`;
    ui.setStatus('approve?', 'warn');
    ui.togglePanel(true);
    ui.notice('The AI wants to run — ' + label, 'info', [
      {
        label: 'Approve & run',
        primary: true,
        onClick: async () => {
          state.pending = null;
          state.processed.add(hash);
          ui.clearNotice();
          await runOps(ops);
        }
      },
      {
        label: 'Skip this step',
        onClick: async () => {
          state.pending = null;
          state.processed.add(hash);
          ui.clearNotice();
          const msg = PCB.formatSkipped(++state.resultSeq);
          if (state.settings.autoSend) await sendResult(msg);
          else ui.notice('Skipped. Auto-send is off.', 'info');
        }
      }
    ]);
  }

  /* ---------------- execution ---------------- */

  function isAuthError(message) {
    return /token|unauthorized|401/i.test(message || '');
  }

  function isOfflineError(message) {
    return /Failed to fetch|NetworkError|ECONNREFUSED|background|Cannot reach|not running|fetch failed/i.test(message || '');
  }

  function markProcessed(hash) {
    state.processed.add(hash);
    state.processedOrder.push(hash);
    if (state.processedOrder.length > 120) {
      const old = state.processedOrder.shift();
      state.processed.delete(old);
    }
  }

  async function runOps(ops) {
    if (state.busy) return;
    state.busy = true;
    ui.setStatus('running', 'busy');
    const results = [];
    let doneOp = null;
    let sawAuthError = false;
    let completed = false;

    try {
      for (const op of ops.slice(0, 8)) {
        if (state.halted) break;
        if (op.tool === 'done') {
          doneOp = op;
          break;
        }

        state.steps++;
        setStats();
        if (state.steps > state.settings.maxSteps) {
          halt(`Step limit reached (${state.settings.maxSteps}). The bridge stopped so it cannot loop forever.`);
          break;
        }

        const summary = PCB.opSummary(op);
        const logId = addLog(op.tool, summary, 'running');
        const started = Date.now();

        let res;
        try {
          res = await call(op.tool, op.params, 'POST');
        } catch (err) {
          state.errors++;
          const fail = {
            ok: false,
            tool: op.tool,
            error: err.message,
            output: 'ERROR: ' + err.message
          };
          results.push({ ...fail, __index: ++state.resultSeq, durationMs: Date.now() - started });
          ui.updateLog(logId, { status: 'failed', bad: true, detail: err.message });
          addLog('error', err.message, 'failed', '', true);

          if (isAuthError(err.message)) {
            sawAuthError = true;
            state.halted = true;
            ui.setStatus('token error', 'err');
            ui.notice('The token was rejected. Copy it again from the dashboard, then reconnect.', 'err', [
              { label: 'Open dashboard', primary: true, onClick: () => window.open(state.settings.server, '_blank', 'noopener') }
            ]);
            break;
          }
          if (isOfflineError(err.message)) {
            state.online = false;
            ui.setConnected('server offline', 'bad');
            ui.setStatus('offline', 'err');
            ui.notice('Lost the PC Bridge server. Start START-BRIDGE.bat, then click Reconnect.', 'err', [
              { label: 'Reconnect', primary: true, onClick: () => connect(true) }
            ]);
            break;
          }
          if (state.errors >= 5) {
            halt('Five steps failed in a row. Check the activity log, then continue when ready.');
            break;
          }
          continue;
        }

        state.errors = 0;
        const ok = res.ok !== false;
        const badExit = res.exitCode !== undefined && res.exitCode !== null && res.exitCode !== 0;
        ui.updateLog(logId, {
          status: ok ? (badExit ? `exit ${res.exitCode}` : 'ok') : 'failed',
          bad: !ok || badExit,
          detail: PCB.stripAnsi(String(res.output || res.error || '')).slice(0, 1500)
        });
        if (res.durationMs !== undefined) {
          ui.setStats(state.steps, state.settings.maxSteps, op.tool);
        }
        results.push({ ...res, __index: ++state.resultSeq, durationMs: res.durationMs !== undefined ? res.durationMs : Date.now() - started });
      }

      if (doneOp) {
        finishTask(doneOp);
        completed = true;
        return;
      }
      if (!results.length) return;

      const message = results
        .map((res) => PCB.formatResult(res, res.__index))
        .join('\n\n')
        .concat('\n\n' + PCB.CONTINUE_HINT);

      if (state.settings.autoSend) {
        await sendResult(message);
      } else {
        state.pendingSend = message;
        ui.notice('Result ready. Auto-send is off.', 'info', [
          { label: 'Send now', primary: true, onClick: () => retrySend(message) },
          { label: 'Copy', onClick: () => copyText(message) }
        ]);
      }
    } finally {
      state.busy = false;
      if (!sawAuthError && !completed) {
        if (state.halted) ui.setStatus('paused', 'warn');
        else if (state.enabled) ui.setStatus('waiting', 'ok');
      }
      setStats();
    }
  }

  function finishTask(op) {
    const summary = (op.params && op.params.summary) || 'Task finished.';
    const run = op.params && op.params.run;
    state.pending = null;
    state.pendingSend = null;
    state.taskDone = true;
    addLog('done', summary, 'complete', run ? 'Run: ' + run : '');
    ui.setStatus('done', 'ok');
    ui.togglePanel(true);
    ui.notice('Task finished: ' + summary + (run ? `\n\nRun it with: ${run}` : ''), 'ok', [
      { label: 'Open workspace', onClick: () => { call('open', { path: '.' }).catch(() => {}); } }
    ]);
  }

  /* ---------------- the watch loop ---------------- */

  async function tick() {
    if (!state.enabled || state.busy || state.priming || state.halted || state.serverPaused) return false;
    if (state.pending || state.pendingSend) return false;
    if (!state.online) return false;

    let last;
    try {
      last = PCB.adapter.getLastAssistant();
    } catch {
      return false;
    }
    if (!last || !last.text) return false;

    const text = last.text;
    if (text !== state.stable.text) {
      state.stable = { text, count: 1 };
      if (state.taskDone && !/"tool"\s*:\s*"done"/i.test(text)) {
        state.taskDone = false;
        if (!state.busy && !state.priming && !state.halted) ui.setStatus('waiting', 'ok');
      }
      return true;
    }
    state.stable.count++;
    if (state.stable.count < 2) return true;
    if (last.generating) return true;

    const hasBridge =
      /```(?:bridge|json)\b/i.test(text) ||
      /```file\s*:/i.test(text) ||
      /```\s*\n\s*\{[^`]*"tool"\s*:/i.test(text) ||
      /(^|\n)\s*\{\s*"tool"\s*:/i.test(text);
    if (!hasBridge) return false;

    const h = PCB.hash(text);
    if (state.processed.has(h)) return false;
    if (PCB.hasOpenBridgeFence(text)) return false;

    const ops = PCB.buildOps(text);
    if (!ops.length) {
      if (state.parseReported !== h) {
        state.parseReported = h;
        ui.notice('Found a bridge block but could not read its JSON. Nudge the AI to resend it as valid JSON.', 'warn', [
          { label: 'Copy raw', onClick: () => copyText(text) }
        ]);
      }
      return false;
    }

    state.parseReported = '';
    markProcessed(h);

    if (!state.settings.autoRun && ops.some((op) => op.tool !== 'done')) {
      state.pending = { ops, hash: h };
      renderApproval(ops, h);
      return false;
    }

    await runOps(ops);
    return false;
  }

  /* ---------------- adaptive watcher ---------------- */

  let tickTimer = null;
  let tickRunning = false;

  function invalidateAssistant() {
    try {
      if (PCB.adapter.invalidate) PCB.adapter.invalidate();
    } catch {
      /* ignore */
    }
  }

  function scheduleTick(delay) {
    if (!state.enabled) return;
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(async () => {
      tickTimer = null;
      if (tickRunning) return;
      tickRunning = true;
      try {
        const again = await tick();
        if (again) scheduleTick(260);
      } catch (err) {
        console.warn('[PC Bridge] watch error:', err);
      } finally {
        tickRunning = false;
      }
    }, Math.max(80, Number(delay) || 220));
  }

  function startWatcher() {
    const root = document.documentElement || document.body;
    if (root && typeof MutationObserver === 'function') {
      const observer = new MutationObserver(() => {
        invalidateAssistant();
        scheduleTick(220);
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    }

    // Safety net for sites that update through canvas, shadow roots, or unusual
    // renderers that do not emit observable mutations.
    setInterval(() => {
      if (document.hidden || !state.enabled) return;
      invalidateAssistant();
      scheduleTick(120);
    }, 1800);

    setInterval(watchUrl, 700);
    setInterval(pingLoop, 12000);

    window.addEventListener('popstate', watchUrl);
    window.addEventListener('hashchange', watchUrl);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        invalidateAssistant();
        scheduleTick(120);
        if (state.enabled && !state.online && state.settings.token) ping(true).catch(() => {});
      }
    });
  }

  /* ---------------- conversation changes ---------------- */

  function conversationChanged() {
    state.processed.clear();
    state.processedOrder = [];
    state.stable = { text: '', count: 0 };
    state.steps = 0;
    state.resultSeq = 0;
    state.pending = null;
    state.pendingSend = null;
    state.parseReported = '';
    state.errors = 0;
    state.taskDone = false;
    ui.clearNotice();
    setStats();
    if (state.enabled) {
      ui.setStatus('waiting', 'ok');
      setTimeout(() => ensurePrime(false), 2200);
      invalidateAssistant();
      scheduleTick(250);
    }
  }

  function watchUrl() {
    if (location.href === state.lastUrl) return;
    state.lastUrl = location.href;
    conversationChanged();
  }

  async function pingLoop() {
    if (!state.settings.token) return;
    if (!state.enabled && !ui.isOpen()) return;
    try {
      await ping(true);
      invalidateAssistant();
      scheduleTick(200);
      if (state.enabled && !state.halted && !state.serverPaused && !state.taskDone) {
        if (!state.busy && !state.priming && !state.pending && !state.pendingSend) ui.setStatus('waiting', 'ok');
      } else if (!state.enabled) {
        ui.setStatus('connected', 'ok');
      }
    } catch (err) {
      state.online = false;
      ui.setConnected(PCB.truncate(err.message, 50), 'bad');
      if (state.enabled) ui.setStatus('offline', 'err');
    }
  }

  /* ---------------- boot ---------------- */

  if (HAS_EXT) {
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'PCB_TOGGLE') ui.togglePanel();
      });
    } catch {
      /* ignore */
    }
  }

  PCB.actions = {
    connect: () => connect(true),
    power: togglePower,
    saveForm,
    saveToggles,
    saveWorkspace,
    reprime: () => ensurePrime(true),
    reset: resetSession,
    saveSelectors,
    testSelectors,
    dash: () => window.open(state.settings.server, '_blank', 'noopener'),
    clear: () => ui.clearLog()
  };

  (async () => {
    await loadSettings();
    ui.setSettings(state.settings);
    if (HAS_EXT && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[PCB.SETTINGS_KEY]) return;
        applyExternalSettings(changes[PCB.SETTINGS_KEY].newValue);
      });
    }
    ui.setEnabled(false);
    setStats();
    ui.setConnected(
      state.settings.token ? 'saved — click Connect' : 'start START-BRIDGE.bat, then paste the token',
      state.settings.token ? '' : 'bad'
    );

    if (state.settings.token) {
      const ok = await connect(false);
      if (ok) {
        ui.setStatus('connected', 'ok');
        if (state.settings.enabled) {
          state.enabled = true;
          ui.setEnabled(true);
          ui.setStatus('waiting', 'ok');
          if (state.settings.autoPrime && !PCB.adapter.getLastAssistant()) {
            setTimeout(() => ensurePrime(false), 1800);
          }
        }
      }
    } else {
      const seen = sessionStorage.getItem('pcbridge.intro');
      if (!seen) {
        sessionStorage.setItem('pcbridge.intro', '1');
        ui.togglePanel(true);
      }
    }

    startWatcher();
    if (state.enabled) {
      invalidateAssistant();
      scheduleTick(400);
    }

    console.log('%cPC Bridge %c' + PCB.VERSION + ' loaded on ' + location.hostname, 'color:#22d3ee;font-weight:bold', 'color:#94a3b8');
  })();
})();
