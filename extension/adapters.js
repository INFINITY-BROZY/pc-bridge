'use strict';

/**
 * PC Bridge — site adapters.
 * Finds the composer, the send button and the newest assistant message.
 * Selectors are best-effort; the generic fallback handles UI changes.
 */
(() => {
  const PCB = window.PCB;
  if (!PCB) return;

  const PROFILES = [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      test: (h) => /(^|\.)deepseek\.com$/.test(h),
      assistant: ['.ds-markdown', '[class*="ds-markdown"]'],
      assistantExclude: [
        '.ds-think-content',
        '[class*="ds-think-content"]',
        '[class*="think-content"]',
        '[class*="reasoning"]',
        '[class*="user-message"]'
      ],
      composer: ['textarea', 'div[contenteditable="true"]', '[contenteditable="true"]'],
      send: [
        'div[role="button"][class*="send"]',
        'button[aria-label*="Send" i]',
        'button[aria-label*="发送"]',
        '[data-testid="send-button"]'
      ],
      stop: ['button[aria-label*="Stop" i]', 'button[aria-label*="停止"]', '[data-testid="stop-button"]']
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      test: (h) => /(^|\.)chatgpt\.com$/.test(h) || /(^|\.)chat\.openai\.com$/.test(h),
      assistant: ['[data-message-author-role="assistant"]'],
      assistantExclude: ['[data-message-author-role="user"]'],
      composer: ['#prompt-textarea', 'textarea', 'div[contenteditable="true"]'],
      send: ['[data-testid="send-button"]', 'button[aria-label*="Send" i]'],
      stop: ['[data-testid="stop-button"]', 'button[aria-label*="Stop" i]']
    },
    {
      id: 'claude',
      name: 'Claude',
      test: (h) => /(^|\.)claude\.ai$/.test(h),
      assistant: ['.font-claude-message', '[data-testid="assistant-message"]'],
      assistantExclude: ['[data-testid="user-message"]', '[data-is-user-message="true"]'],
      composer: ['div[contenteditable="true"]', 'textarea'],
      send: ['button[aria-label*="Send" i]', 'button[aria-label*="Enviar"]', 'button[type="submit"]'],
      stop: ['button[aria-label*="Stop" i]', 'button[aria-label*="Detener"]']
    },
    {
      id: 'gemini',
      name: 'Gemini',
      test: (h) => /(^|\.)gemini\.google\.com$/.test(h),
      assistant: ['model-response', 'message-content'],
      assistantExclude: ['user-query', '[class*="user-query"]'],
      composer: ['div[contenteditable="true"]', 'textarea'],
      send: ['button[aria-label*="Send" i]', 'button[aria-label*="Enviar"]', 'button.send-button'],
      stop: ['button[aria-label*="Stop" i]', 'button[aria-label*="Detener"]']
    },
    {
      id: 'grok',
      name: 'Grok',
      test: (h) => /(^|\.)grok\.com$/.test(h),
      assistant: ['[data-testid="message-bubble"]', '.message-bubble', '.prose'],
      assistantExclude: ['[data-testid="user-message"]', '[class*="user"]'],
      composer: ['textarea', 'div[contenteditable="true"]'],
      send: ['button[type="submit"]', 'button[aria-label*="Send" i]'],
      stop: ['button[aria-label*="Stop" i]']
    },
    {
      id: 'generic',
      name: 'Chat',
      test: () => true,
      assistant: [
        '.ds-markdown',
        '[data-message-author-role="assistant"]',
        '[data-testid="assistant-message"]',
        '[data-role="assistant"]',
        '[data-message-role="assistant"]',
        '[data-author="assistant"]',
        'model-response',
        'message-content',
        '[class*="assistant-message"]',
        '[class*="bot-message"]',
        '.markdown',
        '.prose',
        '[class*="assistant"]',
        'article'
      ],
      assistantExclude: ['[data-message-author-role="user"]', '[data-testid="user-message"]', 'user-query', '[data-role="user"]'],
      composer: ['textarea', 'div[contenteditable="true"]', '[contenteditable="true"]'],
      send: ['[data-testid="send-button"]', 'button[aria-label*="Send" i]', 'button[type="submit"]', 'div[role="button"][class*="send"]'],
      stop: [
        '[data-testid="stop-button"]',
        'button[aria-label*="Stop" i]',
        'button[aria-label*="Cancel" i]',
        'button[data-testid*="stop" i]'
      ]
    }
  ];

  const compose = (list) => list.join(',');
  let assistantCache = null;

  function invalidate() {
    assistantCache = null;
  }

  function profile() {
    const host = location.hostname;
    return PROFILES.find((p) => p.test(host)) || PROFILES[PROFILES.length - 1];
  }

  function overrides() {
    try {
      return (PCB.state && PCB.state.settings && PCB.state.settings.selectors) || {};
    } catch {
      return {};
    }
  }

  function splitSelectors(value) {
    return String(value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function querySelectors(list) {
    const nodes = [];
    for (const sel of list) {
      try {
        nodes.push(...document.querySelectorAll(sel));
      } catch {
        /* invalid selector, skip */
      }
    }
    return [...new Set(nodes)];
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const width = el.offsetWidth || rects[0].width;
    const height = el.offsetHeight || rects[0].height;
    if (width < 2 || height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    return true;
  }

  function isOnScreen(el) {
    if (!isVisible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > -20 && r.top < window.innerHeight + 20 && r.right > 0;
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled === true) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/(^|\s)(disabled|is-disabled)(\s|$)/i.test(cls)) return true;
    const cs = getComputedStyle(el);
    if (cs.pointerEvents === 'none') return true;
    if (Number(cs.opacity) > 0 && Number(cs.opacity) < 0.3) return true;
    return false;
  }

  function codeLanguage(pre) {
    const code = pre.querySelector('code');
    const cls = (code && code.className) || '';
    const m = /(?:language|lang)[-_:]([\w.:/-]+)/i.exec(String(cls));
    if (m) return m[1];
    for (const attr of ['data-lang', 'data-language', 'data-code-language']) {
      const v = pre.getAttribute(attr) || (code && code.getAttribute(attr));
      if (v) return String(v).trim();
    }

    // Sites often render the fence language in a small header next to the <pre>.
    const scope = pre.parentElement;
    if (scope) {
      for (const el of scope.querySelectorAll('*')) {
        if (el === pre || el.contains(pre) || pre.contains(el)) continue;
        if (!(pre.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
        const t = String(el.textContent || '').trim();
        if (!t || t.length > 40 || !/^[\w.:/-]+$/.test(t)) continue;
        if (/^(copy|download|edit|run|code|plaintext|text)$/i.test(t)) continue;
        return t;
      }
    }
    return '';
  }

  function textOf(el) {
    if (!el) return '';
    let text = String(el.innerText || el.textContent || '').replace(/\u00a0/g, ' ');

    // Markdown renderers (DeepSeek included) drop the ``` fences from code
    // blocks. Rebuild them so the bridge protocol can still be parsed.
    const pres = el.querySelectorAll ? [...el.querySelectorAll('pre')] : [];
    for (const pre of pres) {
      const code = String((pre.innerText || pre.textContent || '')).replace(/\u00a0/g, ' ').trim();
      if (!code) continue;
      const lang = codeLanguage(pre);
      const fenced = '```' + lang + '\n' + code + '\n```';
      if (text.includes(code)) text = text.replace(code, fenced);
      else text += '\n' + fenced;
    }

    return text.trim();
  }

  function insideExcluded(el, list) {
    for (const sel of list || []) {
      try {
        const hit = el.closest(sel);
        if (hit && hit !== el) return true;
        if (hit === el) return true;
      } catch {
        /* bad selector, ignore */
      }
    }
    return false;
  }

  function findComposer() {
    const p = profile();
    const sel = overrides();
    let nodes = [];
    if (sel.composer) nodes = querySelectors(splitSelectors(sel.composer));
    if (!nodes.length) {
      try {
        nodes = [...document.querySelectorAll(compose(p.composer))];
      } catch {
        nodes = [...document.querySelectorAll('textarea, [contenteditable="true"]')];
      }
    }

    nodes = nodes.filter((el) => {
      if (!isOnScreen(el) || isDisabled(el)) return false;
      if (el.tagName === 'INPUT' && /search/i.test(el.type || '')) return false;
      const ph = ((el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('aria-label'))) || '').toLowerCase();
      if (/search|search…/.test(ph)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 18) return false;
      return true;
    });

    nodes.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.bottom - ra.bottom;
    });
    return nodes[0] || null;
  }

  function findSendButton(composer) {
    if (!composer) return null;
    const p = profile();
    const cr = composer.getBoundingClientRect();
    const targetX = cr.right;
    const targetY = cr.bottom - 10;
    let best = null;
    let bestDist = Infinity;
    const override = overrides();
    const sendSelectors = override.send ? splitSelectors(override.send) : p.send;

    for (const sel of sendSelectors) {
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(sel)];
      } catch {
        continue;
      }
      for (const el of nodes) {
        if (!isOnScreen(el) || isDisabled(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 14 || r.height < 14) continue;
        const d = Math.hypot(r.right - targetX, r.top + r.height / 2 - targetY);
        if (d < 260 && d < bestDist) {
          bestDist = d;
          best = el;
        }
      }
    }
    if (best) return best;

    // Generic fallback: nearest clickable thing to the composer's bottom-right.
    let scope = composer.parentElement;
    for (let depth = 0; depth < 7 && scope; depth++, scope = scope.parentElement) {
      let candidates = [];
      try {
        candidates = [...scope.querySelectorAll('button, [role="button"]')];
      } catch {
        candidates = [];
      }
      for (const el of candidates) {
        if (!isOnScreen(el) || isDisabled(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 14 || r.height < 14) continue;
        const label = (
          (el.getAttribute('aria-label') || '') +
          ' ' +
          (el.getAttribute('title') || '') +
          ' ' +
          (el.getAttribute('data-testid') || '') +
          ' ' +
          (el.innerText || '')
        ).toLowerCase();
        if (
          /attach|upload|file|image|photo|mic|voice|audio|record|model|search|sidebar|menu|setting|tool|think|deep|stop|new chat|share|copy|regenerate|retry|edit|delete|download|close|more/.test(
            label
          )
        ) {
          continue;
        }
        const d = Math.hypot(r.right - targetX, r.top + r.height / 2 - targetY);
        if (d < 220 && d < bestDist) {
          bestDist = d;
          best = el;
        }
      }
      if (best) break;
    }
    return best;
  }

  function isGenerating() {
    const p = profile();
    for (const sel of p.stop) {
      try {
        const node = document.querySelector(sel);
        if (node && isOnScreen(node) && !isDisabled(node)) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  function collectAssistant(selectors, exclude) {
    for (const selector of selectors) {
      let found = [];
      try {
        found = [...document.querySelectorAll(selector)];
      } catch {
        continue;
      }
      // The newest answer is at the end. Scan backwards so a busy chat does not
      // pay for text extraction on every older message.
      for (let i = found.length - 1; i >= 0; i--) {
        const el = found[i];
        if (!isVisible(el)) continue;
        if (insideExcluded(el, exclude)) continue;
        const text = textOf(el);
        if (!text) continue;
        return [{ el, text }];
      }
    }
    return [];
  }

  function getLastAssistant() {
    const now = Date.now();
    if (assistantCache && assistantCache.at > now - 250 && assistantCache.node && assistantCache.node.isConnected) {
      return assistantCache.result;
    }

    const p = profile();
    const sel = overrides();
    const assistantSelectors = sel.assistant ? splitSelectors(sel.assistant) : p.assistant;
    let nodes = collectAssistant(assistantSelectors, p.assistantExclude);

    // If a site-specific selector misses (after a redesign), try the generic list.
    if (!nodes.length && p.id !== 'generic') {
      const generic = PROFILES[PROFILES.length - 1];
      nodes = collectAssistant(generic.assistant, [...p.assistantExclude, ...generic.assistantExclude]);
    }

    if (!nodes.length) {
      assistantCache = null;
      return null;
    }
    const { el, text } = nodes[0];
    const result = {
      node: el,
      text,
      generating: isGenerating(),
      profile: p.name
    };
    assistantCache = { at: now, node: el, result };
    return result;
  }

  function isComposerEmpty(composer) {
    if (!composer) return true;
    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      return !String(composer.value || '').trim();
    }
    return !textOf(composer);
  }

  function setComposerText(composer, text) {
    composer.focus();

    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      const proto = composer.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(composer, text);
      let ev;
      try {
        ev = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text });
      } catch {
        ev = new Event('input', { bubbles: true });
      }
      composer.dispatchEvent(ev);
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    sel.removeAllRanges();
    sel.addRange(range);
    let inserted = false;
    try {
      document.execCommand('delete', false, null);
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }

    if (!inserted || !textOf(composer)) {
      composer.textContent = text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function pressEnter(composer) {
    const opts = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    try {
      composer.dispatchEvent(new KeyboardEvent('keydown', opts));
      composer.dispatchEvent(new KeyboardEvent('keypress', opts));
      composer.dispatchEvent(new KeyboardEvent('keyup', opts));
    } catch {
      /* ignore */
    }
  }

  async function waitForEmpty(composer, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isComposerEmpty(composer)) return true;
      await PCB.sleep(80);
    }
    return isComposerEmpty(composer);
  }

  async function sendMessage(text) {
    for (let attempt = 0; attempt < 7; attempt++) {
      const composer = findComposer();
      if (!composer) {
        await PCB.sleep(450);
        continue;
      }
      if (!isComposerEmpty(composer)) {
        return { ok: false, reason: 'draft' };
      }

      setComposerText(composer, text);
      await PCB.sleep(160);

      const btn = findSendButton(composer);
      if (btn) {
        try {
          btn.click();
        } catch {
          /* fall through to Enter */
        }
      } else {
        pressEnter(composer);
      }

      if (await waitForEmpty(composer, 700)) return { ok: true };

      pressEnter(composer);
      if (await waitForEmpty(composer, 600)) return { ok: true };

      // Last resort: click a freshly located button.
      const btn2 = findSendButton(composer);
      if (btn2 && btn2 !== btn) {
        try {
          btn2.click();
        } catch {
          /* ignore */
        }
        if (await waitForEmpty(composer, 600)) return { ok: true };
      }
    }
    return { ok: false, reason: 'failed' };
  }

  function hasPrimeInPage() {
    try {
      return (document.body.innerText || '').includes(PCB.PRIME_MARKER);
    } catch {
      return false;
    }
  }

  function composerHasDraft() {
    const c = findComposer();
    return Boolean(c && !isComposerEmpty(c));
  }

  PCB.adapter = {
    profile,
    findComposer,
    findSendButton,
    getLastAssistant,
    isGenerating,
    isComposerEmpty,
    setComposerText,
    pressEnter,
    sendMessage,
    hasPrimeInPage,
    composerHasDraft,
    isVisible,
    invalidate
  };
})();
