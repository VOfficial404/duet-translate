/* Content script: finds paragraphs, renders bilingual translations, hover / selection / input translation. */
(() => {
  if (window.__duetTranslate) return;
  window.__duetTranslate = true;

  const isTop = window === window.top;
  const host = location.hostname;
  let settings = DUET.DEFAULTS;

  /* ================= DOM classification ================= */

  // Never descend into these.
  const SKIP = new Set([
    'script', 'style', 'noscript', 'template', 'code', 'pre', 'textarea', 'input', 'select', 'option', 'button',
    'svg', 'math', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed', 'kbd', 'samp', 'var', 'img', 'picture',
    'head', 'title', 'meta', 'link', 'duet-ui',
  ]);
  // Text inside these is not part of a paragraph's text.
  const TEXT_SKIP = new Set([
    'script', 'style', 'noscript', 'template', 'textarea', 'select', 'option', 'button', 'svg', 'math', 'canvas',
    'video', 'audio', 'iframe', 'object', 'embed', 'img', 'picture', 'duet-ui',
  ]);
  const SKIPPED_REGION = 'pre, code, textarea, [contenteditable=""], [contenteditable="true"], .notranslate, [translate="no"], .duet-wrapper, duet-ui';

  const isOurs = (n) => n.nodeType === 1 && (n.localName === 'duet-ui' || n.classList.contains('duet-wrapper'));

  function skipEl(el) {
    if (SKIP.has(el.localName) || isOurs(el) || el.hidden) return true;
    if (el === document.documentElement || el === document.body) return false;
    return el.isContentEditable || el.getAttribute('translate') === 'no' || el.classList.contains('notranslate');
  }

  function inSkippedRegion(el) {
    const hit = el.closest(SKIPPED_REGION);
    return !!hit && hit !== document.documentElement && hit !== document.body;
  }

  // True when the element and its whole subtree lay out inline, i.e. it belongs inside a paragraph.
  function isInlineTree(el, memo) {
    if (memo.has(el)) return memo.get(el);
    let inline;
    if (isOurs(el) || el.localName === 'br') inline = true;
    else {
      const display = getComputedStyle(el).display;
      if (display === 'none') inline = true; // invisible: harmless, textOf skips it
      else if (!display.startsWith('inline')) inline = false;
      else if (SKIP.has(el.localName)) inline = true; // atomic inline content (img, code, button…)
      else inline = [...el.children].every((c) => isInlineTree(c, memo));
    }
    memo.set(el, inline);
    return inline;
  }

  // Candidates are either a whole element ({el}) or a run of loose inline nodes inside a block ({parent, nodes}).
  function collect(el, out, memo) {
    if (skipEl(el)) return;
    let hasBlock = false;
    for (const c of el.children) if (!isInlineTree(c, memo)) { hasBlock = true; break; }
    if (!hasBlock) {
      // A bare list of links (menus, tag lists) reads better translated item by item.
      const items = [...el.children].filter((c) => !isOurs(c) && c.localName !== 'br');
      const looseText = [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim().length > 1);
      if (items.length >= 2 && !looseText && items.every((c) => c.localName === 'a')) {
        for (const c of items) if (!skipEl(c)) out.push({ el: c });
      } else out.push({ el });
      return;
    }
    let run = [];
    const flush = () => { if (run.length) out.push({ parent: el, nodes: run }); run = []; };
    for (const c of el.childNodes) {
      if (c.nodeType === 3) run.push(c);
      else if (c.nodeType === 1 && !isOurs(c)) {
        if (isInlineTree(c, memo)) run.push(c);
        else { flush(); collect(c, out, memo); }
      }
    }
    flush();
  }

  function textOf(nodes, keepNewlines, skipCode) {
    let s = '';
    const walk = (n) => {
      if (n.nodeType === 3) { s += keepNewlines ? n.data : n.data.replace(/\s+/g, ' '); return; }
      if (n.nodeType !== 1 || isOurs(n) || n.classList.contains('duet-hidden')) return;
      const name = n.localName;
      if (name === 'br') { s += '\n'; return; }
      if (TEXT_SKIP.has(name) || (skipCode && (name === 'code' || name === 'kbd'))) return;
      if (n.checkVisibility && !n.checkVisibility() && getComputedStyle(n).display !== 'contents') return;
      for (const c of n.childNodes) walk(c);
    };
    for (const n of nodes) {
      if (n.nodeType === 1 && n.checkVisibility && !n.checkVisibility() && getComputedStyle(n).display !== 'contents') continue;
      if (n.nodeType === 1) for (const c of n.childNodes) walk(c);
      else walk(n);
    }
    return s;
  }

  function unitText(nodes, container) {
    const ws = getComputedStyle(container).whiteSpace;
    const keep = ws.startsWith('pre') || ws === 'break-spaces';
    const raw = nodes.length === 1 && nodes[0] === container ? textOf(nodes, keep) : textOfRun(nodes, keep);
    return raw.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function textOfRun(nodes, keep) {
    // A run's elements are paragraph content themselves, so wrap them in a pseudo-parent walk.
    let s = '';
    for (const n of nodes) {
      if (n.nodeType === 3) s += keep ? n.data : n.data.replace(/\s+/g, ' ');
      else if (n.nodeType === 1 && n.localName === 'br') s += '\n';
      else if (n.nodeType === 1 && !TEXT_SKIP.has(n.localName) && !n.classList.contains('duet-hidden')) s += textOf([n], keep);
    }
    return s;
  }

  /* ================= language heuristics ================= */

  function scriptStats(text) {
    const count = (re) => (text.match(re) || []).length;
    return {
      letters: count(/\p{L}/gu),
      han: count(/\p{Script=Han}/gu),
      kana: count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu),
      hangul: count(/\p{Script=Hangul}/gu),
      latin: count(/\p{Script=Latin}/gu),
      cyrillic: count(/\p{Script=Cyrillic}/gu),
    };
  }

  // 'yes' | 'no' | 'maybe' (same script as the target; needs real language detection)
  function scriptMatchesTarget(text, target) {
    const s = scriptStats(text);
    if (!s.letters) return 'yes';
    const share = (n) => n / s.letters;
    const lang = target.split('-')[0];
    if (lang === 'zh') return share(s.han) >= 0.5 && share(s.kana) < 0.05 ? 'yes' : 'no';
    if (lang === 'ja') return share(s.kana) >= 0.1 ? 'yes' : 'no';
    if (lang === 'ko') return share(s.hangul) >= 0.5 ? 'yes' : 'no';
    if (['ru', 'uk'].includes(lang)) return share(s.cyrillic) >= 0.5 ? 'maybe' : 'no';
    if (share(s.latin) >= 0.5) return ['ar', 'th'].includes(lang) ? 'no' : 'maybe';
    return 'no';
  }

  function detectLanguage(text) {
    return new Promise((resolve) => {
      try { chrome.i18n.detectLanguage(text, (r) => resolve(r)); } catch { resolve(null); }
    });
  }

  async function isInLanguage(text, target) {
    const m = scriptMatchesTarget(text, target);
    if (m !== 'maybe') return m === 'yes';
    const r = await detectLanguage(text);
    const top = r?.languages?.[0];
    return !!top && top.language.split('-')[0] === target.split('-')[0] && (r.isReliable || top.percentage >= 80);
  }

  const LETTER = /\p{L}/u;
  function worthTranslating(text, prose) {
    if (text.length < 2 || !LETTER.test(prose)) return false;
    if (/^(https?:\/\/|www\.)\S+$/i.test(text) || /^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(text)) return false;
    return scriptMatchesTarget(text, settings.targetLang) !== 'yes';
  }

  /* ================= units ================= */

  const units = new Set();
  const byKey = new WeakMap(); // element or first run node -> unit
  const byTarget = new WeakMap(); // observed element / wrapper -> unit
  const memo = new Map(); // `${lang}\n${text}` -> translation, for instant re-show

  let active = false;
  let gen = 0;
  let pending = 0;
  let io = null;
  let mo = null;

  function register(c) {
    const key = c.el || c.nodes[0];
    let u = byKey.get(key);
    if (u && units.has(u)) {
      if (u.hidden) return u; // original text is blanked in translation-only mode
      const nodes = c.el ? [c.el] : c.nodes;
      if (unitText(nodes, c.el || c.parent) === u.text) return u;
      destroy(u);
    }
    const nodes = c.el ? [c.el] : c.nodes;
    const container = c.el || c.parent;
    const text = unitText(nodes, container);
    if (!text) return null;
    const prose = c.el ? textOf([c.el], false, true) : text;
    if (!worthTranslating(text, prose)) return null;
    u = { key, el: c.el || null, parent: c.parent || null, nodes: c.nodes || null, text, status: null, wrapper: null, hidden: null };
    byKey.set(key, u);
    units.add(u);
    return u;
  }

  function ensureWrapper(u) {
    if (u.wrapper?.isConnected) return u.wrapper;
    const w = document.createElement('font');
    w.className = 'duet-wrapper notranslate';
    w.setAttribute('translate', 'no');
    if (u.el) u.el.appendChild(w);
    else {
      const last = u.nodes[u.nodes.length - 1];
      if (last.parentNode !== u.parent) return null;
      u.parent.insertBefore(w, last.nextSibling);
    }
    u.wrapper = w;
    byTarget.set(w, u);
    return w;
  }

  function destroy(u) {
    showOriginal(u);
    if (u.observed) io?.unobserve(u.observed);
    u.wrapper?.remove();
    u.dead = true;
    units.delete(u);
    if (byKey.get(u.key) === u) byKey.delete(u.key);
  }

  function isConnectedUnit(u) {
    if (u.el) return u.el.isConnected;
    return u.parent.isConnected && u.nodes.every((n) => n.parentNode === u.parent);
  }

  function observe(u) {
    const target = u.el || ensureWrapper(u);
    if (!target) return;
    u.observed = target;
    byTarget.set(target, u);
    io.observe(target);
  }

  function isBlockLayout(u) {
    if (u.el && /^h[1-6]$/.test(u.el.localName)) return true;
    return u.text.length >= 30 || u.text.includes('\n');
  }

  function renderLoading(u) {
    const w = ensureWrapper(u);
    if (!w) return;
    w.className = 'duet-wrapper notranslate';
    const spin = document.createElement('font');
    spin.className = 'duet-loading';
    w.replaceChildren(spin);
  }

  function renderTranslation(u, text) {
    const w = ensureWrapper(u);
    if (!w) return;
    w.className = 'duet-wrapper notranslate';
    w.lang = settings.targetLang;
    const inner = document.createElement('font');
    inner.className = 'duet-inner';
    text.split('\n').forEach((line, i) => {
      if (i) inner.append(document.createElement('br'));
      inner.append(line);
    });
    if (isBlockLayout(u)) {
      w.classList.add('duet-block');
      w.replaceChildren(inner);
    } else {
      w.replaceChildren(' ', inner);
    }
    if (settings.displayMode === 'translation') hideOriginal(u);
  }

  function renderError(u, message) {
    const w = ensureWrapper(u);
    if (!w) return;
    w.className = 'duet-wrapper notranslate';
    const btn = document.createElement('font');
    btn.className = 'duet-error';
    btn.title = `${message}\n点击重试`;
    btn.textContent = '翻译失败 ↻';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      u.status = null;
      enqueue(u);
    }, true);
    w.replaceChildren(' ', btn);
  }

  // Translation-only mode blanks the original text in place instead of moving nodes,
  // so frameworks that own the DOM (React, Vue…) keep valid references.
  function hideOriginal(u) {
    if (u.hidden || u.status !== 'done' || !u.translation) return;
    const nodes = u.el ? [...u.el.childNodes] : u.nodes.filter((n) => n.parentNode === u.parent);
    u.hidden = [];
    for (const n of nodes) {
      if (n === u.wrapper) continue;
      if (n.nodeType === 3 && n.data) { u.hidden.push([n, n.data]); n.data = ''; }
      else if (n.nodeType === 1 && !isOurs(n)) { n.classList.add('duet-hidden'); u.hidden.push([n]); }
    }
    mo?.takeRecords();
  }

  function showOriginal(u) {
    if (!u.hidden) return;
    for (const [n, data] of u.hidden) {
      if (data === undefined) n.classList.remove('duet-hidden');
      else if (n.data === '') n.data = data;
    }
    u.hidden = null;
    mo?.takeRecords();
  }

  function applyDisplayMode() {
    for (const u of units) settings.displayMode === 'translation' ? hideOriginal(u) : showOriginal(u);
  }

  /* ================= translation queue ================= */

  let queue = [];
  let flushTimer = 0;

  function enqueue(u) {
    if (u.status || u.dead) return;
    u.status = 'queued';
    renderLoading(u);
    queue.push(u);
    pending++;
    ui?.update();
    if (!flushTimer) flushTimer = setTimeout(flush, 40);
  }

  function settle() {
    pending = Math.max(0, pending - 1);
    ui?.update();
  }

  async function translateTexts(texts, to) {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'translate', texts, to });
    } catch (e) {
      throw new Error(/context invalidated/i.test(e.message) ? '扩展已更新，请刷新页面' : e.message);
    }
    if (!res?.ok) throw new Error(res?.error || '翻译失败');
    return res.data;
  }

  async function flush() {
    flushTimer = 0;
    const to = settings.targetLang;
    const items = [];
    for (const u of queue.splice(0)) u.dead ? settle() : items.push(u);
    const sameLang = await Promise.all(items.map((u) => isInLanguage(u.text, to)));

    const groups = new Map(); // identical texts are translated once
    items.forEach((u, i) => {
      if (sameLang[i]) {
        u.status = 'same';
        u.wrapper?.replaceChildren();
        settle();
        return;
      }
      const hit = memo.get(`${to}\n${u.text}`);
      if (hit) { finish(u, hit); return; }
      if (!groups.has(u.text)) groups.set(u.text, []);
      groups.get(u.text).push(u);
    });

    const cfg = settings.engines[settings.engine] || {};
    const maxCount = Math.max(1, Number(cfg.batchSize) || 10);
    const maxChars = Math.max(200, Number(cfg.batchChars) || 2000);
    let batch = [];
    let chars = 0;
    for (const text of groups.keys()) {
      if (batch.length && (batch.length >= maxCount || chars + text.length > maxChars)) {
        sendBatch(batch, groups, to);
        batch = [];
        chars = 0;
      }
      batch.push(text);
      chars += text.length;
    }
    if (batch.length) sendBatch(batch, groups, to);
  }

  async function sendBatch(texts, groups, to) {
    const myGen = gen;
    let results;
    let error = null;
    try {
      results = await translateTexts(texts, to);
    } catch (e) {
      error = e.message;
    }
    texts.forEach((text, i) => {
      for (const u of groups.get(text)) {
        if (u.dead) { settle(); continue; }
        const t = results?.[i];
        if (t && myGen === gen && to === settings.targetLang) {
          memo.set(`${to}\n${text}`, t);
          finish(u, t);
        } else {
          u.status = 'error';
          renderError(u, error || '翻译结果为空');
          settle();
          ui?.toast(error || '部分段落翻译失败');
        }
      }
    });
  }

  const normalize = (s) => s.replace(/\s+/g, '').toLowerCase();

  function finish(u, translation) {
    u.status = 'done';
    if (normalize(translation) === normalize(u.text)) u.wrapper?.replaceChildren();
    else {
      u.translation = translation;
      renderTranslation(u, translation);
    }
    settle();
  }

  /* ================= page translation ================= */

  function scan(root, memoMap = new WeakMap()) {
    const out = [];
    collect(root, out, memoMap);
    for (const c of out) {
      const u = register(c);
      if (u && !u.status && !u.observed) observe(u);
    }
  }

  function startPage() {
    if (active || !document.body) return;
    active = true;
    gen++;
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const u = byTarget.get(e.target);
        io.unobserve(e.target);
        if (u) { u.observed = null; enqueue(u); }
      }
    }, { rootMargin: '600px 0px 600px 0px' });
    scan(document.body);
    mo = new MutationObserver(onMutations);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    ui?.update();
  }

  function stopPage() {
    active = false;
    gen++;
    io?.disconnect();
    mo?.disconnect();
    io = mo = null;
    clearTimeout(rescanTimer);
    rescanTimer = 0;
    dirty.clear();
    queue = [];
    for (const u of [...units]) destroy(u);
    pending = 0;
    ui?.update();
  }

  const togglePage = () => (active ? stopPage() : startPage());

  const dirty = new Set();
  let rescanTimer = 0;

  function onMutations(records) {
    for (const r of records) {
      const t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (!t || t.closest('.duet-wrapper, duet-ui')) continue;
      if (r.type === 'childList') {
        const real = (list) => [...list].some((n) => !isOurs(n));
        if (!real(r.addedNodes) && !real(r.removedNodes)) continue;
      }
      dirty.add(t);
    }
    if (dirty.size && !rescanTimer) rescanTimer = setTimeout(rescan, 400);
  }

  function rescan() {
    rescanTimer = 0;
    if (!active) return;
    for (const u of [...units]) if (!isConnectedUnit(u)) destroy(u);
    const memoMap = new WeakMap();
    const roots = new Set();
    for (let el of dirty) {
      if (!el.isConnected || inSkippedRegion(el)) continue;
      // climb to the enclosing block so paragraph boundaries are recomputed as a whole
      while (el.parentElement && el !== document.body && isInlineTree(el, memoMap)) el = el.parentElement;
      roots.add(el);
    }
    dirty.clear();
    for (const r of roots) {
      let nested = false;
      for (const other of roots) if (other !== r && other.contains(r)) { nested = true; break; }
      if (!nested) scan(r, memoMap);
    }
  }

  /* ================= hover translation ================= */

  let hoverTarget = null;
  let hoverArmed = false;

  function hoverTranslate(target) {
    if (!target || target.nodeType !== 1 || target.localName === 'duet-ui') return;
    const w = target.closest('.duet-wrapper');
    if (w) { const u = byTarget.get(w); if (u) destroy(u); return; }
    if (inSkippedRegion(target)) return;
    const memoMap = new WeakMap();
    let el = target;
    while (el.parentElement && el !== document.body && isInlineTree(el, memoMap)) el = el.parentElement;
    const out = [];
    collect(el, out, memoMap);
    let picks = out.filter((c) => (c.el ? c.el.contains(target) : c.nodes.some((n) => n === target || n.contains(target))));
    if (!picks.length && out.length <= 3) picks = out;
    for (const c of picks) {
      const u = register(c);
      if (!u) continue;
      if (u.status === 'done' || u.status === 'error') { destroy(u); continue; }
      if (u.observed) { io?.unobserve(u.observed); u.observed = null; }
      enqueue(u);
    }
  }

  addEventListener('mousemove', (e) => { hoverTarget = e.target; }, { capture: true, passive: true });
  addEventListener('keydown', (e) => {
    hoverArmed = settings.hoverKey !== 'off' && e.key === settings.hoverKey && !e.repeat;
  }, true);
  addEventListener('keyup', (e) => {
    if (hoverArmed && e.key === settings.hoverKey) hoverTranslate(hoverTarget);
    hoverArmed = false;
  }, true);
  addEventListener('mousedown', () => { hoverArmed = false; }, true);
  addEventListener('wheel', () => { hoverArmed = false; }, { capture: true, passive: true });

  /* ================= input box: triple space ================= */

  let spaceTimes = [];
  addEventListener('input', (e) => {
    if (!settings.inputTranslate || !e.isTrusted) return;
    const t = e.composedPath?.()[0] || e.target;
    if (e.data !== ' ' && e.data !== '\u00a0') { spaceTimes = []; return; }
    const now = Date.now();
    spaceTimes = spaceTimes.filter((x) => now - x < 1000).concat(now);
    if (spaceTimes.length < 3) return;
    spaceTimes = [];
    translateInput(t);
  }, true);

  function editableRoot(t) {
    if (t.localName === 'textarea' || (t.localName === 'input' && /^(text|search|)$/.test(t.type))) return t;
    const el = t.nodeType === 1 ? t : t.parentElement;
    if (!el?.isContentEditable) return null;
    let root = el;
    while (root.parentElement?.isContentEditable) root = root.parentElement;
    return root;
  }

  async function translateInput(t) {
    const el = editableRoot(t);
    if (!el) return;
    const isField = el.localName === 'textarea' || el.localName === 'input';
    const text = (isField ? el.value : el.innerText).replace(/[\s\u00a0]+$/, '');
    if (!text.trim()) return;
    ui?.toast('正在翻译输入内容…', 'info');
    try {
      const [result] = await translateTexts([text], settings.inputTargetLang);
      if (!result) throw new Error('翻译结果为空');
      el.focus();
      if (isField) {
        const proto = el.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, result);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        document.execCommand('selectAll');
        document.execCommand('insertText', false, result);
      }
      ui?.toast('', 'hide');
    } catch (e) {
      ui?.toast(`输入框翻译失败：${e.message}`);
    }
  }

  /* ================= page style ================= */

  // Translation styles live in content.css, keyed by html[data-duet-style]; only user CSS needs a <style>.
  let customStyleEl = null;
  function applyLook() {
    const root = document.documentElement;
    root.setAttribute('data-duet-style', settings.style);
    root.style.setProperty('--duet-color', settings.color);
    if (!settings.customCss) { customStyleEl?.remove(); return; }
    customStyleEl ??= Object.assign(document.createElement('style'), { id: 'duet-translate-custom' });
    customStyleEl.textContent = settings.customCss;
    if (!customStyleEl.isConnected) (document.head || root).appendChild(customStyleEl);
  }

  /* ================= floating UI (shadow DOM) ================= */

  let ui = null;

  function createUI() {
    const hostEl = document.createElement('duet-ui');
    hostEl.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = hostEl.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${UI_CSS}</style>
      <div class="ball-wrap" part="ball">
        <div class="menu">
          <button data-act="display" title="切换 双语对照 / 仅译文"></button>
          <button data-act="options" title="设置">${ICON_GEAR}</button>
          <button data-act="hide" title="在本页隐藏悬浮球">${ICON_CLOSE}</button>
        </div>
        <button class="ball" title="翻译此页面 (Alt+A)">${ICON_LOGO}<span class="ring"></span></button>
      </div>
      <div class="toast" hidden></div>
      <button class="sel-icon" hidden title="翻译选中文本">${ICON_LOGO}</button>
      <div class="bubble" hidden><div class="bubble-body"></div><div class="bubble-foot"><span class="engine"></span><button data-act="copy">复制</button></div></div>`;
    const $ = (s) => root.querySelector(s);
    const wrap = $('.ball-wrap');
    const ball = $('.ball');
    const toastEl = $('.toast');
    const selIcon = $('.sel-icon');
    const bubble = $('.bubble');
    let hiddenForPage = false;
    let toastTimer = 0;

    // vertical drag
    let drag = null;
    ball.addEventListener('pointerdown', (e) => {
      drag = { y: e.clientY, top: wrap.getBoundingClientRect().top, moved: false };
      ball.setPointerCapture(e.pointerId);
    });
    ball.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) wrap.style.top = `${Math.min(innerHeight - 60, Math.max(8, drag.top + dy))}px`;
    });
    ball.addEventListener('pointerup', () => {
      if (!drag) return;
      const { moved } = drag;
      drag = null;
      if (moved) {
        const pct = Math.round((wrap.getBoundingClientRect().top / innerHeight) * 100);
        DUET.saveSettings({ ballTop: pct });
      } else togglePage();
    });

    root.addEventListener('click', (e) => {
      const act = e.target.closest?.('[data-act]')?.dataset.act;
      if (act === 'display') DUET.saveSettings({ displayMode: settings.displayMode === 'translation' ? 'bilingual' : 'translation' });
      if (act === 'options') chrome.runtime.sendMessage({ type: 'openOptions' });
      if (act === 'hide') { hiddenForPage = true; update(); }
      if (act === 'copy') navigator.clipboard.writeText($('.bubble-body').textContent).then(() => toast('已复制', 'info'));
    });

    function update() {
      wrap.hidden = hiddenForPage || !settings.floatBall;
      wrap.style.top = `${settings.ballTop}%`;
      wrap.classList.toggle('active', active);
      wrap.classList.toggle('busy', pending > 0);
      ball.title = active ? '显示原文 (Alt+A)' : '翻译此页面 (Alt+A)';
      $('[data-act="display"]').innerHTML = settings.displayMode === 'translation' ? '译' : '双';
      hostEl.style.setProperty('--accent', settings.color);
    }

    function toast(msg, kind = 'error') {
      clearTimeout(toastTimer);
      if (kind === 'hide' || !msg) { toastEl.hidden = true; return; }
      toastEl.textContent = msg;
      toastEl.className = `toast ${kind}`;
      toastEl.hidden = false;
      toastTimer = setTimeout(() => { toastEl.hidden = true; }, kind === 'error' ? 6000 : 2500);
    }

    // selection translation
    let selText = '';
    let selRect = null;
    function placeNear(el, rect) {
      el.hidden = false;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let x = Math.min(innerWidth - w - 8, Math.max(8, rect.right - w / 2));
      let y = rect.bottom + 8;
      if (y + h > innerHeight - 8) y = Math.max(8, rect.top - h - 8);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
    function showSelIcon(text, rect) {
      selText = text;
      selRect = rect;
      placeNear(selIcon, rect);
    }
    async function showBubble(text, rect) {
      selIcon.hidden = true;
      const body = $('.bubble-body');
      body.textContent = '翻译中…';
      body.classList.add('loading');
      $('.engine').textContent = DUET.ENGINES[settings.engine]?.name || '';
      placeNear(bubble, rect || { left: innerWidth / 2, right: innerWidth / 2, top: 80, bottom: 80 });
      const to = scriptMatchesTarget(text, settings.targetLang) === 'yes' ? settings.inputTargetLang : settings.targetLang;
      try {
        const [result] = await translateTexts([text], to);
        body.textContent = result || '（无结果）';
      } catch (e) {
        body.textContent = `翻译失败：${e.message}`;
      }
      body.classList.remove('loading');
      placeNear(bubble, rect || { left: innerWidth / 2, right: innerWidth / 2, top: 80, bottom: 80 });
    }
    selIcon.addEventListener('click', () => showBubble(selText, selRect));
    const hidePopups = () => { selIcon.hidden = true; bubble.hidden = true; };
    addEventListener('mousedown', (e) => { if (!e.composedPath().includes(hostEl)) hidePopups(); }, true);
    addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePopups(); }, true);
    addEventListener('scroll', () => { selIcon.hidden = true; }, { capture: true, passive: true });

    document.documentElement.appendChild(hostEl);
    // some SPAs replace <html> children; keep the UI attached
    setInterval(() => { if (!hostEl.isConnected) document.documentElement.appendChild(hostEl); }, 2000);
    update();
    return { update, toast, showSelIcon, showBubble, host: hostEl };
  }

  addEventListener('mouseup', (e) => {
    if (!settings.selectionTranslate || !ui || e.button !== 0) return;
    if (e.composedPath().includes(ui.host)) return;
    setTimeout(() => {
      const sel = getSelection();
      const text = sel?.toString().trim();
      if (!text || text.length > 3000 || sel.rangeCount === 0) return;
      const anchor = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
      if (!anchor || anchor.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
      // the whole selection's box: a bubble flipped above must clear every selected line
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      ui.showSelIcon(text, rect);
    }, 0);
  }, true);

  /* ================= messaging & settings ================= */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isTop && msg.type !== 'getState') return false;
    switch (msg.type) {
      case 'toggle': togglePage(); break;
      case 'start': startPage(); break;
      case 'stop': stopPage(); break;
      case 'toggleDisplay':
        DUET.saveSettings({ displayMode: settings.displayMode === 'translation' ? 'bilingual' : 'translation' });
        break;
      case 'translateSelection': {
        const sel = getSelection();
        const rect = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
        ui?.showBubble(msg.text, rect);
        break;
      }
    }
    sendResponse({ active, displayMode: settings.displayMode, host });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const prev = settings;
    settings = DUET.merge(DUET.DEFAULTS, changes.settings.newValue);
    applyLook();
    if (prev.displayMode !== settings.displayMode) applyDisplayMode();
    const engineChanged = prev.engine !== settings.engine || prev.targetLang !== settings.targetLang ||
      JSON.stringify(prev.engines[prev.engine]) !== JSON.stringify(settings.engines[settings.engine]) ||
      prev.systemPrompt !== settings.systemPrompt;
    if (engineChanged) {
      memo.clear();
      if (active) { stopPage(); startPage(); }
    }
    ui?.update();
  });

  async function shouldAutoTranslate() {
    if (DUET.hostMatches(host, settings.neverSites)) return false;
    if (DUET.hostMatches(host, settings.alwaysSites)) return true;
    if (!settings.autoTranslate) return false;
    const sample = (document.body?.innerText || '').slice(0, 3000);
    if (sample.length < 20) return false;
    return !(await isInLanguage(sample, settings.targetLang));
  }

  async function init() {
    settings = await DUET.loadSettings();
    applyLook();
    if (isTop && document.documentElement) ui = createUI();
    if (isTop && await shouldAutoTranslate()) startPage();
  }

  /* ================= UI assets ================= */

  const ICON_LOGO = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6.5h9M4 11h6"/><path d="M11 14.5h9M14 19h6" opacity=".55"/><path d="M17 3.5v5M14.5 6l2.5 2.5L19.5 6"/></svg>';
  const ICON_GEAR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const UI_CSS = `
    /* the host carries all:initial inline, which beats :host rules, so typography goes on the top-level boxes */
    :host { --accent: #4f6ef7; }
    .ball-wrap, .toast, .sel-icon, .bubble { font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2329; }
    [hidden] { display: none !important; }
    button { font: inherit; cursor: pointer; border: 0; padding: 0; background: none; color: inherit; }
    .ball-wrap { position: fixed; right: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; transform: translateY(-40px); }
    .ball { position: relative; width: 46px; height: 40px; border-radius: 20px 0 0 20px; background: #fff; color: var(--accent);
      box-shadow: 0 2px 10px rgba(0,0,0,.16); display: grid; place-items: center; padding-right: 4px; touch-action: none;
      transform: translateX(8px); transition: transform .18s, background .18s, color .18s; }
    .ball-wrap:hover .ball { transform: translateX(0); }
    .active .ball { background: var(--accent); color: #fff; }
    .ring { position: absolute; left: 7px; top: 4px; width: 32px; height: 32px; box-sizing: border-box; border-radius: 50%;
      border: 2px solid currentColor; border-right-color: transparent; opacity: 0; }
    .busy .ring { opacity: .7; animation: spin .9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .menu { display: flex; flex-direction: column; gap: 6px; margin-right: 6px; opacity: 0; pointer-events: none; transform: translateY(6px); transition: .15s; }
    .ball-wrap:hover .menu { opacity: 1; pointer-events: auto; transform: none; }
    .menu button { width: 30px; height: 30px; border-radius: 50%; background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.15);
      display: grid; place-items: center; color: #555; font-weight: 600; font-size: 13px; }
    .menu button:hover { color: var(--accent); }
    .toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); max-width: min(560px, 90vw); padding: 8px 14px;
      border-radius: 8px; background: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.18); border-left: 4px solid #e03131; white-space: pre-wrap; word-break: break-word; }
    .toast.info { border-left-color: var(--accent); }
    .sel-icon { position: fixed; width: 28px; height: 28px; border-radius: 8px; background: #fff; color: var(--accent);
      box-shadow: 0 2px 8px rgba(0,0,0,.2); display: grid; place-items: center; }
    .sel-icon svg { width: 18px; height: 18px; }
    .bubble { position: fixed; width: max-content; max-width: min(420px, 90vw); max-height: 50vh; overflow: auto; background: #fff;
      border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.2); padding: 12px 14px 8px; font-size: 14px; line-height: 1.6; }
    .bubble-body { white-space: pre-wrap; word-break: break-word; }
    .bubble-body.loading { color: #888; }
    .bubble-foot { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 8px; color: #999; font-size: 12px; }
    .bubble-foot button { color: var(--accent); font-size: 12px; }
    @media (prefers-color-scheme: dark) {
      .ball-wrap, .toast, .bubble { color: #e6e6e6; }
      .ball, .menu button, .toast, .sel-icon, .bubble { background: #2b2d31; }
      .menu button { color: #bbb; }
      .active .ball { background: var(--accent); }
    }`;

  init();
})();
