'use strict';

/**
 * PC Bridge — floating panel UI.
 * Lives in a shadow root so the host page cannot restyle it.
 */
(() => {
  const PCB = window.PCB;
  if (!PCB) return;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .pcb-root {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      font-size: 13px;
      line-height: 1.45;
      color: #e2e8f0;
      -webkit-font-smoothing: antialiased;
    }
    button, input { font: inherit; }
    button { cursor: pointer; }

    .pcb-fab {
      position: fixed;
      right: 20px;
      bottom: 20px;
      width: 56px;
      height: 56px;
      border-radius: 18px;
      border: 1px solid rgba(56, 189, 248, 0.35);
      background: linear-gradient(150deg, #0b1626, #0a1120 60%);
      box-shadow: 0 14px 40px -12px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(34, 211, 238, 0.06) inset;
      display: grid;
      place-items: center;
      pointer-events: auto;
      transition: transform .15s ease, border-color .15s ease;
    }
    .pcb-fab:hover { transform: translateY(-2px); border-color: rgba(56, 189, 248, 0.7); }
    .pcb-fab svg { width: 27px; height: 27px; }
    .pcb-fab .dot {
      position: absolute;
      right: 8px;
      top: 8px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #64748b;
      box-shadow: 0 0 0 2px #0a1120;
      transition: background .2s;
    }
    .pcb-fab[data-state="ok"] .dot { background: #34d399; box-shadow: 0 0 9px rgba(52,211,153,.8), 0 0 0 2px #0a1120; }
    .pcb-fab[data-state="busy"] .dot { background: #38bdf8; box-shadow: 0 0 9px rgba(56,189,248,.9), 0 0 0 2px #0a1120; animation: pcbpulse 1.1s infinite; }
    .pcb-fab[data-state="warn"] .dot { background: #fbbf24; box-shadow: 0 0 9px rgba(251,191,36,.8), 0 0 0 2px #0a1120; }
    .pcb-fab[data-state="err"] .dot { background: #f87171; box-shadow: 0 0 9px rgba(248,113,113,.8), 0 0 0 2px #0a1120; }
    @keyframes pcbpulse { 50% { opacity: .35; } }

    .pcb-panel {
      position: fixed;
      right: 20px;
      bottom: 90px;
      width: 392px;
      max-width: calc(100vw - 24px);
      max-height: min(760px, calc(100vh - 118px));
      display: flex;
      flex-direction: column;
      border-radius: 18px;
      border: 1px solid rgba(148, 163, 184, 0.18);
      background:
        radial-gradient(500px 240px at 100% -10%, rgba(34,211,238,.10), transparent 60%),
        radial-gradient(400px 200px at 0% 110%, rgba(129,140,248,.08), transparent 60%),
        #0a101b;
      box-shadow: 0 30px 80px -20px rgba(0,0,0,.95), 0 0 0 1px rgba(255,255,255,.03) inset;
      pointer-events: auto;
      overflow: hidden;
      opacity: 0;
      transform: translateY(10px) scale(.985);
      visibility: hidden;
      transition: opacity .18s ease, transform .18s ease, visibility .18s;
    }
    .pcb-panel.open { opacity: 1; transform: none; visibility: visible; }

    .pcb-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 15px 16px 13px;
      border-bottom: 1px solid rgba(148,163,184,.10);
      flex: 0 0 auto;
    }
    .pcb-brand { display: flex; align-items: center; gap: 10px; }
    .pcb-brand svg { width: 30px; height: 30px; flex: 0 0 auto; }
    .pcb-brand h1 {
      margin: 0;
      font-size: 13.5px;
      font-weight: 700;
      letter-spacing: .16em;
      background: linear-gradient(90deg, #e0f2fe, #22d3ee 60%, #818cf8);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      white-space: nowrap;
    }
    .pcb-brand .sub { display: block; color: #7f93ad; font-size: 10px; letter-spacing: .05em; margin-top: 1px; }
    .pcb-head-right { display: flex; align-items: center; gap: 8px; }
    .pcb-state {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 9.5px;
      letter-spacing: .1em;
      text-transform: uppercase;
      color: #94a3b8;
      border: 1px solid rgba(148,163,184,.16);
      border-radius: 999px;
      padding: 4px 9px;
      white-space: nowrap;
    }
    .pcb-state::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: #64748b; }
    .pcb-state[data-mode="ok"]::before { background: #34d399; box-shadow: 0 0 7px rgba(52,211,153,.8); }
    .pcb-state[data-mode="busy"]::before { background: #38bdf8; box-shadow: 0 0 7px rgba(56,189,248,.9); }
    .pcb-state[data-mode="warn"]::before { background: #fbbf24; }
    .pcb-state[data-mode="err"]::before { background: #f87171; }

    .pcb-icon {
      width: 26px;
      height: 26px;
      display: grid;
      place-items: center;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: #879bb4;
      font-size: 18px;
      line-height: 1;
    }
    .pcb-icon:hover { background: rgba(148,163,184,.1); color: #e2e8f0; }

    .pcb-scroll {
      overflow-y: auto;
      overflow-x: hidden;
      padding: 14px 16px 16px;
      display: flex;
      flex-direction: column;
      gap: 13px;
      scrollbar-width: thin;
      scrollbar-color: rgba(148,163,184,.25) transparent;
    }
    .pcb-scroll::-webkit-scrollbar { width: 8px; }
    .pcb-scroll::-webkit-scrollbar-thumb { background: rgba(148,163,184,.2); border-radius: 99px; border: 2px solid transparent; background-clip: padding-box; }

    .pcb-sec {
      border: 1px solid rgba(148,163,184,.11);
      border-radius: 12px;
      background: rgba(2,6,23,.28);
      padding: 10px 11px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .pcb-kicker {
      font-size: 9px;
      letter-spacing: .13em;
      text-transform: uppercase;
      color: #6f849d;
      font-weight: 600;
    }
    .pcb-field { display: flex; flex-direction: column; gap: 4px; }
    .pcb-field span.lbl { font-size: 10px; color: #8ba0b9; letter-spacing: .02em; }
    .pcb-field input {
      width: 100%;
      border: 1px solid rgba(148,163,184,.16);
      border-radius: 8px;
      background: #060c15;
      color: #dbeafe;
      padding: 7px 9px;
      outline: none;
      font-family: ui-monospace, Consolas, monospace;
      font-size: 11px;
      transition: border-color .15s, box-shadow .15s;
    }
    .pcb-field input:focus { border-color: rgba(56,189,248,.55); box-shadow: 0 0 0 3px rgba(56,189,248,.08); }
    .pcb-token-wrap { position: relative; display: flex; }
    .pcb-token-wrap input { padding-right: 52px; }
    .pcb-eye {
      position: absolute;
      right: 3px;
      top: 3px;
      bottom: 3px;
      border: 0;
      border-radius: 6px;
      background: rgba(148,163,184,.1);
      color: #9fb3c8;
      font-size: 9.5px;
      padding: 0 7px;
      text-transform: uppercase;
      letter-spacing: .05em;
    }
    .pcb-eye:hover { background: rgba(148,163,184,.2); }

    .pcb-row { display: flex; align-items: center; gap: 8px; }
    .pcb-msg { font-size: 10.5px; color: #7f93ad; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pcb-msg.good { color: #6ee7b7; }
    .pcb-msg.bad { color: #fca5a5; }

    .pcb-btn {
      border: 1px solid rgba(148,163,184,.18);
      background: rgba(148,163,184,.08);
      color: #e2e8f0;
      border-radius: 8px;
      padding: 7px 11px;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      transition: background .15s, border-color .15s;
    }
    .pcb-btn:hover { background: rgba(148,163,184,.16); border-color: rgba(148,163,184,.3); }
    .pcb-btn:disabled { opacity: .5; cursor: wait; }
    .pcb-btn.primary {
      background: linear-gradient(135deg, #0ea5e9, #6366f1);
      border-color: transparent;
      color: #fff;
      box-shadow: 0 8px 20px -12px rgba(56,189,248,.9);
    }
    .pcb-btn.primary:hover { filter: brightness(1.1); }
    .pcb-btn.tiny { padding: 4px 8px; font-size: 10px; border-radius: 7px; }
    .pcb-btn.link { border-color: transparent; background: transparent; color: #7dd3fc; padding: 4px 2px; }
    .pcb-btn.link:hover { color: #bae6fd; background: transparent; }

    .pcb-power { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 2px 2px; }
    .pcb-power .big { font-size: 15px; font-weight: 600; letter-spacing: .01em; }
    .pcb-power .small { font-size: 10.5px; color: #7f93ad; margin-top: 1px; }
    .pcb-switch {
      width: 46px;
      height: 26px;
      border-radius: 999px;
      border: 1px solid rgba(148,163,184,.25);
      background: rgba(100,116,139,.25);
      position: relative;
      transition: background .2s, border-color .2s;
      flex: 0 0 auto;
    }
    .pcb-switch span {
      position: absolute;
      top: 3px;
      left: 3px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #cbd5e1;
      transition: transform .18s ease, background .18s;
      box-shadow: 0 1px 3px rgba(0,0,0,.5);
    }
    .pcb-switch[aria-pressed="true"] { background: linear-gradient(135deg, #0891b2, #4f46e5); border-color: transparent; }
    .pcb-switch[aria-pressed="true"] span { transform: translateX(20px); background: #fff; }

    .pcb-toggles { display: flex; flex-direction: column; gap: 7px; }
    .pcb-check { display: flex; align-items: center; gap: 8px; color: #b6c6d8; font-size: 11.5px; cursor: pointer; user-select: none; }
    .pcb-check input {
      appearance: none;
      width: 15px;
      height: 15px;
      border-radius: 4px;
      border: 1px solid rgba(148,163,184,.3);
      background: #060c15;
      display: grid;
      place-items: center;
      margin: 0;
      flex: 0 0 auto;
      cursor: pointer;
    }
    .pcb-check input::after { content: "✓"; font-size: 10px; color: #fff; opacity: 0; }
    .pcb-check input:checked { background: linear-gradient(135deg, #0891b2, #4f46e5); border-color: transparent; }
    .pcb-check input:checked::after { opacity: 1; }

    .pcb-stats {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-family: ui-monospace, Consolas, monospace;
      font-size: 9.5px;
      color: #6f849d;
      padding: 0 2px;
      letter-spacing: .02em;
    }

    .pcb-notice {
      border: 1px solid rgba(56,189,248,.25);
      background: rgba(8,47,73,.35);
      border-radius: 10px;
      padding: 9px 10px;
      font-size: 11px;
      color: #bae6fd;
      display: flex;
      flex-direction: column;
      gap: 7px;
      white-space: pre-wrap;
    }
    .pcb-notice.warn { border-color: rgba(251,191,36,.3); background: rgba(69,43,10,.35); color: #fde68a; }
    .pcb-notice.err { border-color: rgba(248,113,113,.32); background: rgba(69,10,10,.35); color: #fecaca; }
    .pcb-notice.ok { border-color: rgba(52,211,153,.28); background: rgba(6,50,38,.32); color: #a7f3d0; }
    .pcb-notice .notice-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .pcb-notice.hidden { display: none; }

    .pcb-log-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 9px;
      letter-spacing: .13em;
      text-transform: uppercase;
      color: #6f849d;
      font-weight: 600;
      padding: 0 2px;
    }
    .pcb-log { display: flex; flex-direction: column; gap: 6px; }
    .pcb-empty { color: #5d718a; font-size: 10.5px; padding: 8px 2px; }

    .pcb-entry {
      border: 1px solid rgba(148,163,184,.1);
      border-radius: 9px;
      background: rgba(2,6,23,.3);
      padding: 7px 9px;
      font-size: 11px;
    }
    .pcb-entry.bad { border-color: rgba(248,113,113,.22); }
    .pcb-entry-top { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .pcb-badge {
      flex: 0 0 auto;
      font: 600 8px ui-monospace, Consolas, monospace;
      letter-spacing: .08em;
      text-transform: uppercase;
      padding: 2px 5px;
      border-radius: 4px;
      color: #a5f3fc;
      background: rgba(34,211,238,.09);
      border: 1px solid rgba(34,211,238,.18);
    }
    .pcb-entry.bad .pcb-badge { color: #fecaca; background: rgba(248,113,113,.08); border-color: rgba(248,113,113,.22); }
    .pcb-ename { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Consolas, monospace; font-size: 10px; color: #cbd5e1; }
    .pcb-etime { flex: 0 0 auto; font-size: 9px; color: #5d718a; font-family: ui-monospace, Consolas, monospace; }
    .pcb-entry pre {
      margin: 5px 0 0;
      padding: 6px 7px;
      max-height: 100px;
      overflow: auto;
      border-radius: 6px;
      background: rgba(0,0,0,.3);
      color: #8fa3b8;
      font: 9.5px/1.5 ui-monospace, Consolas, monospace;
      white-space: pre-wrap;
      word-break: break-word;
      display: none;
    }
    .pcb-entry.open pre { display: block; }
    .pcb-entry.has-detail { cursor: pointer; }

    .pcb-adv {
      border: 1px solid rgba(148,163,184,.1);
      border-radius: 10px;
      background: rgba(2,6,23,.24);
      padding: 8px 10px;
    }
    .pcb-adv summary {
      cursor: pointer;
      color: #8ba0b9;
      font-size: 10px;
      letter-spacing: .06em;
      text-transform: uppercase;
      font-weight: 600;
      list-style: none;
    }
    .pcb-adv summary::-webkit-details-marker { display: none; }
    .pcb-adv summary::before { content: "+ "; color: #38bdf8; }
    .pcb-adv[open] summary::before { content: "− "; }
    .pcb-adv p { margin: 7px 0 9px; color: #64748b; font-size: 10px; line-height: 1.45; }
    .pcb-adv .pcb-field { margin-bottom: 7px; }
    .pcb-actions { display: flex; gap: 4px; flex-wrap: wrap; padding-top: 2px; }
    .pcb-fine { margin: 0; color: #536781; font-size: 9.5px; line-height: 1.5; padding: 0 2px; }
    .pcb-fine b { color: #7d92aa; font-weight: 600; }
    .pcb-tip { margin: 0; color: #536781; font-size: 9.5px; line-height: 1.45; }
    .pcb-access {
      margin: 0;
      padding: 7px 9px;
      border: 1px solid rgba(248,113,113,.28);
      border-radius: 8px;
      background: rgba(248,113,113,.08);
      color: #fecaca;
      font-size: 9.5px;
      line-height: 1.45;
    }

    @media (max-width: 480px) {
      .pcb-panel { right: 12px; bottom: 84px; width: calc(100vw - 24px); }
      .pcb-fab { right: 14px; bottom: 14px; }
    }
  `;

  const LOGO = `
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <rect x="1" y="1" width="38" height="38" rx="11" fill="#0b1220" stroke="#1e3a5f"/>
      <path d="M7 27h26" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/>
      <path d="M9 26c2-8 8-13 11-13s9 5 11 13" fill="none" stroke="#22d3ee" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M14 26v-7M17 26v-10M23 26v-10M26 26v-7" stroke="#818cf8" stroke-width="1.7" stroke-linecap="round"/>
    </svg>`;

  const HTML = `
    <div class="pcb-root">
      <div class="pcb-panel" id="panel" role="dialog" aria-label="PC Bridge">
        <div class="pcb-head">
          <div class="pcb-brand">
            ${LOGO}
            <div>
              <h1>PC BRIDGE</h1>
              <span class="sub">DeepSeek ↔ your PC · v${PCB.VERSION}</span>
            </div>
          </div>
          <div class="pcb-head-right">
            <span class="pcb-state" id="state" data-mode="off">off</span>
            <button class="pcb-icon" data-act="close" title="Close">×</button>
          </div>
        </div>

        <div class="pcb-scroll">
          <div class="pcb-sec">
            <div class="pcb-kicker">Connection</div>
            <label class="pcb-field">
              <span class="lbl">Server</span>
              <input id="server" spellcheck="false" autocomplete="off" placeholder="http://127.0.0.1:8787">
            </label>
            <label class="pcb-field">
              <span class="lbl">Token</span>
              <span class="pcb-token-wrap">
                <input id="token" type="password" spellcheck="false" autocomplete="off" placeholder="paste from the dashboard">
                <button class="pcb-eye" data-act="eye" type="button">show</button>
              </span>
            </label>
            <div class="pcb-row">
              <button class="pcb-btn primary" data-act="connect">Connect</button>
              <span class="pcb-msg" id="connMsg">not connected</span>
            </div>
          </div>

          <div class="pcb-sec">
            <div class="pcb-kicker">Project location</div>
            <label class="pcb-field">
              <span class="lbl">Workspace folder</span>
              <input id="workspace" spellcheck="false" autocomplete="off" placeholder="C:\Users\You\Projects">
            </label>
            <div class="pcb-row">
              <button class="pcb-btn primary" data-act="saveWorkspace">Save location</button>
              <span class="pcb-msg" id="wsMsg">where projects are created</span>
            </div>
            <p class="pcb-tip">The folder is created if needed. If a chat is already open, the bridge can tell the AI about the new path.</p>
            <p class="pcb-access hidden" id="accessMode">Full PC file access is ON — file tools can read and write any path. Change it in the dashboard.</p>
          </div>

          <div class="pcb-sec" style="gap:9px">
            <div class="pcb-power">
              <div>
                <div class="big" id="powerLabel">Bridge off</div>
                <div class="small" id="powerSub">turn on to let the AI use this PC</div>
              </div>
              <button class="pcb-switch" id="power" data-act="power" aria-pressed="false" aria-label="Toggle bridge"><span></span></button>
            </div>

            <div class="pcb-toggles">
              <label class="pcb-check"><input type="checkbox" id="autoRun" data-toggle="autoRun"> Auto-run commands</label>
              <label class="pcb-check"><input type="checkbox" id="autoSend" data-toggle="autoSend"> Auto-send results</label>
              <label class="pcb-check"><input type="checkbox" id="autoPrime" data-toggle="autoPrime"> Auto-start in new chats</label>
            </div>
          </div>

          <div class="pcb-stats">
            <span id="steps">0 / 40 steps</span>
            <span id="lastTool">idle</span>
          </div>

          <div class="pcb-notice hidden" id="notice"></div>

          <div class="pcb-log-head">
            <span>Activity</span>
            <button class="pcb-btn link" data-act="clear">clear</button>
          </div>
          <div class="pcb-log" id="log"><div class="pcb-empty">No steps yet.</div></div>

          <details class="pcb-adv">
            <summary>Advanced · selectors</summary>
            <p>Only touch these if the bridge stops finding the chat box after a site update.</p>
            <label class="pcb-field"><span class="lbl">Answer message</span><input id="selAssistant" spellcheck="false" placeholder=".ds-markdown"></label>
            <label class="pcb-field"><span class="lbl">Chat box</span><input id="selComposer" spellcheck="false" placeholder="textarea"></label>
            <label class="pcb-field"><span class="lbl">Send button</span><input id="selSend" spellcheck="false" placeholder="auto-detect"></label>
            <div class="pcb-row" style="margin-top:2px">
              <button class="pcb-btn tiny primary" data-act="saveSelectors">Save</button>
              <button class="pcb-btn tiny" data-act="testSelectors">Test finders</button>
            </div>
          </details>

          <div class="pcb-actions">
            <button class="pcb-btn tiny" data-act="reprime">Re-send protocol</button>
            <button class="pcb-btn tiny" data-act="reset">Reset session</button>
            <button class="pcb-btn tiny" data-act="dash">Dashboard ↗</button>
          </div>
          <p class="pcb-fine">Commands run as your Windows user. File edits stay in the workspace by default, but <b>shell commands are not a sandbox</b>. Only bridge a chat you trust.</p>
        </div>
      </div>

      <button class="pcb-fab" id="fab" data-act="toggle" data-state="off" title="PC Bridge" aria-label="Open PC Bridge">
        ${LOGO}
        <span class="dot"></span>
      </button>
    </div>
  `;

  function createUI() {
    const host = document.createElement('div');
    host.id = 'pc-bridge-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    // Constructable stylesheets survive even strict page CSPs.
    let styled = false;
    try {
      if ('adoptedStyleSheets' in Document.prototype && typeof CSSStyleSheet === 'function') {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        shadow.adoptedStyleSheets = [sheet];
        styled = true;
      }
    } catch {
      styled = false;
    }
    shadow.innerHTML = `${styled ? '' : `<style>${CSS}</style>`}${HTML}`;

    const $ = (sel) => shadow.querySelector(sel);
    const el = {
      panel: $('#panel'),
      fab: $('#fab'),
      state: $('#state'),
      server: $('#server'),
      token: $('#token'),
      workspace: $('#workspace'),
      wsMsg: $('#wsMsg'),
      accessMode: $('#accessMode'),
      eye: shadow.querySelector('[data-act="eye"]'),
      connMsg: $('#connMsg'),
      power: $('#power'),
      powerLabel: $('#powerLabel'),
      powerSub: $('#powerSub'),
      autoRun: $('#autoRun'),
      autoSend: $('#autoSend'),
      autoPrime: $('#autoPrime'),
      selAssistant: $('#selAssistant'),
      selComposer: $('#selComposer'),
      selSend: $('#selSend'),
      steps: $('#steps'),
      lastTool: $('#lastTool'),
      notice: $('#notice'),
      log: $('#log')
    };

    let logEntries = [];
    let logSeq = 0;
    let openSet = new Set();
    let noticeButtons = [];

    function togglePanel(force) {
      const open = typeof force === 'boolean' ? force : !el.panel.classList.contains('open');
      el.panel.classList.toggle('open', open);
      el.fab.style.opacity = open ? '0' : '1';
      el.fab.style.pointerEvents = open ? 'none' : 'auto';
      return open;
    }

    function setStatus(text, mode) {
      el.state.textContent = text;
      el.state.dataset.mode = mode || 'off';
      const map = { ok: 'ok', busy: 'busy', warn: 'warn', err: 'err', off: 'off' };
      el.fab.dataset.state = map[mode] || 'off';
    }

    function setConnected(msg, kind) {
      el.connMsg.textContent = msg;
      el.connMsg.className = 'pcb-msg' + (kind ? ' ' + kind : '');
    }

    function setWorkspace(path, msg, kind, force) {
      const focused = (shadow.activeElement || document.activeElement) === el.workspace;
      if (path && (force || !focused)) el.workspace.value = path;
      if (msg != null) {
        el.wsMsg.textContent = msg;
        el.wsMsg.className = 'pcb-msg' + (kind ? ' ' + kind : '');
      }
    }

    function setWorkspaceMessage(msg, kind) {
      setWorkspace('', msg, kind);
    }

    function setAccessMode(full) {
      if (!el.accessMode) return;
      el.accessMode.classList.toggle('hidden', !full);
    }

    function readWorkspace() {
      return el.workspace.value.trim();
    }

    function setSettings(s) {
      el.server.value = s.server || '';
      el.token.value = s.token || '';
      el.autoRun.checked = s.autoRun !== false;
      el.autoSend.checked = s.autoSend !== false;
      el.autoPrime.checked = s.autoPrime !== false;
      const sel = s.selectors || {};
      el.selAssistant.value = sel.assistant || '';
      el.selComposer.value = sel.composer || '';
      el.selSend.value = sel.send || '';
    }

    function readSelectors() {
      return {
        assistant: el.selAssistant.value.trim(),
        composer: el.selComposer.value.trim(),
        send: el.selSend.value.trim()
      };
    }

    function readForm() {
      return { server: el.server.value.trim(), token: el.token.value.trim() };
    }

    function readToggles() {
      return { autoRun: el.autoRun.checked, autoSend: el.autoSend.checked, autoPrime: el.autoPrime.checked };
    }

    function setEnabled(on, busy) {
      el.power.setAttribute('aria-pressed', on ? 'true' : 'false');
      el.powerLabel.textContent = on ? 'Bridge on' : 'Bridge off';
      el.powerSub.textContent = on
        ? busy
          ? 'working…'
          : 'watching the newest AI answer'
        : 'turn on to let the AI use this PC';
      if (!on) setStatus('off', 'off');
    }

    function setStats(steps, max, last) {
      el.steps.textContent = `${steps} / ${max} steps`;
      if (last) el.lastTool.textContent = last;
    }

    function setLastTool(text) {
      el.lastTool.textContent = text;
    }

    function clearNotice() {
      el.notice.className = 'pcb-notice hidden';
      el.notice.textContent = '';
      noticeButtons = [];
    }

    function notice(text, kind, actions) {
      el.notice.className = 'pcb-notice' + (kind ? ' ' + kind : '');
      el.notice.textContent = '';
      const msg = document.createElement('div');
      msg.textContent = text;
      el.notice.appendChild(msg);
      noticeButtons = actions || [];
      if (noticeButtons.length) {
        const row = document.createElement('div');
        row.className = 'notice-actions';
        for (const a of noticeButtons) {
          const b = document.createElement('button');
          b.className = 'pcb-btn tiny' + (a.primary ? ' primary' : '');
          b.textContent = a.label;
          b.addEventListener('click', () => {
            try {
              a.onClick();
            } catch {
              /* ignore */
            }
          });
          row.appendChild(b);
        }
        el.notice.appendChild(row);
      }
    }

    function renderLog() {
      el.log.textContent = '';
      if (!logEntries.length) {
        const empty = document.createElement('div');
        empty.className = 'pcb-empty';
        empty.textContent = 'No steps yet.';
        el.log.appendChild(empty);
        return;
      }
      for (const entry of logEntries) {
        const row = document.createElement('div');
        row.className = 'pcb-entry' + (entry.bad ? ' bad' : '') + (openSet.has(entry.id) ? ' open' : '') + (entry.detail ? ' has-detail' : '');
        const top = document.createElement('div');
        top.className = 'pcb-entry-top';

        const badge = document.createElement('span');
        badge.className = 'pcb-badge';
        badge.textContent = entry.tool || 'info';

        const name = document.createElement('span');
        name.className = 'pcb-ename';
        let label = entry.summary || '';
        if (entry.status) label += ' · ' + entry.status;
        name.textContent = label;
        name.title = label;

        const time = document.createElement('span');
        time.className = 'pcb-etime';
        time.textContent = entry.time || '';

        top.append(badge, name, time);
        row.appendChild(top);

        if (entry.detail) {
          const pre = document.createElement('pre');
          pre.textContent = entry.detail;
          row.appendChild(pre);
          row.addEventListener('click', () => {
            if (openSet.has(entry.id)) openSet.delete(entry.id);
            else openSet.add(entry.id);
            renderLog();
          });
        }

        el.log.appendChild(row);
      }
      el.log.scrollTop = el.log.scrollHeight;
    }

    function addLog(entry) {
      const id = ++logSeq;
      logEntries.push({
        id,
        tool: entry.tool || 'info',
        summary: entry.summary || '',
        status: entry.status || '',
        detail: entry.detail || '',
        bad: Boolean(entry.bad),
        time: entry.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      });
      if (logEntries.length > 60) logEntries = logEntries.slice(-60);
      renderLog();
      return id;
    }

    function updateLog(id, patch) {
      const entry = logEntries.find((e) => e.id === id);
      if (!entry) return;
      Object.assign(entry, patch);
      renderLog();
    }

    function clearLog() {
      logEntries = [];
      openSet.clear();
      renderLog();
    }

    function setTokenVisible(visible) {
      el.token.type = visible ? 'text' : 'password';
      el.eye.textContent = visible ? 'hide' : 'show';
    }

    // delegation
    shadow.addEventListener('click', (e) => {
      const target = e.target.closest('[data-act]');
      if (!target) return;
      const act = target.dataset.act;
      if (act === 'toggle') return togglePanel();
      if (act === 'close') return togglePanel(false);
      if (act === 'eye') return setTokenVisible(el.token.type === 'password');
      if (PCB.actions && typeof PCB.actions[act] === 'function') {
        PCB.actions[act](target);
      }
    });

    el.server.addEventListener('change', () => PCB.actions && PCB.actions.saveForm && PCB.actions.saveForm());
    el.server.addEventListener('blur', () => PCB.actions && PCB.actions.saveForm && PCB.actions.saveForm());
    el.token.addEventListener('change', () => PCB.actions && PCB.actions.saveForm && PCB.actions.saveForm());
    el.token.addEventListener('blur', () => PCB.actions && PCB.actions.saveForm && PCB.actions.saveForm());
    el.workspace.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (PCB.actions && PCB.actions.saveWorkspace) PCB.actions.saveWorkspace();
      }
    });
    for (const box of [el.autoRun, el.autoSend, el.autoPrime]) {
      box.addEventListener('change', () => PCB.actions && PCB.actions.saveToggles && PCB.actions.saveToggles());
    }

    return {
      el,
      shadow,
      host,
      togglePanel,
      isOpen: () => el.panel.classList.contains('open'),
      setStatus,
      setConnected,
      setWorkspace,
      setWorkspaceMessage,
      setAccessMode,
      readWorkspace,
      setSettings,
      readForm,
      readToggles,
      readSelectors,
      setEnabled,
      setStats,
      setLastTool,
      notice,
      clearNotice,
      addLog,
      updateLog,
      clearLog,
      setTokenVisible
    };
  }

  PCB.createUI = createUI;
})();
