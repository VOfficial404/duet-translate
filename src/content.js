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
    btn.textContent = '翻译失败，点击重试';
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

  function stats() {
    let done = 0;
    let failed = 0;
    for (const u of units) {
      if (u.status === 'done' && u.translation) done++;
      else if (u.status === 'error') failed++;
    }
    return { done, failed, pending };
  }

  function retryFailed() {
    lastError = '';
    for (const u of units) {
      if (u.status === 'error') { u.status = null; enqueue(u); }
    }
  }

  // One notice per failure burst instead of one per paragraph.
  let lastError = '';
  function reportError(message) {
    lastError = message;
    ui?.toast(message, 'error', { label: '全部重试', run: retryFailed });
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
    let failed = false;
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
          failed = true;
        }
      }
    });
    if (failed && myGen === gen) reportError(error || '部分段落没有返回译文');
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
    lastError = '';
    ui?.toast('');
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
      <div class="dock">
        <div class="panel"><div class="panel-inner" role="menu">
          <p class="status"></p>
          <button class="row" data-act="display" role="menuitem"><span class="ico"></span><span class="label"></span></button>
          <button class="row" data-act="options" role="menuitem"><span class="ico">${ICON_GEAR}</span><span class="label">打开设置</span></button>
          <button class="row" data-act="hide" role="menuitem"><span class="ico">${ICON_HIDE}</span><span class="label">在此页隐藏按钮</span></button>
        </div></div>
        <button class="ball">${ICON_DUET}<span class="dot"></span></button>
      </div>
      <div class="toast" role="status" hidden>
        <span class="toast-text"></span>
        <button class="toast-action" data-act="toast-action"></button>
        <button class="toast-close" data-act="toast-close" aria-label="关闭">${ICON_CLOSE}</button>
      </div>
      <button class="sel-icon" hidden aria-label="翻译选中文字" title="翻译选中文字">${ICON_DUET}</button>
      <div class="bubble" hidden>
        <div class="bubble-body"></div>
        <div class="bubble-foot"><span class="engine"></span><button class="copy" data-act="copy">${ICON_COPY}<span>复制</span></button></div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const dock = $('.dock');
    const ball = $('.ball');
    const toastEl = $('.toast');
    const selIcon = $('.sel-icon');
    const bubble = $('.bubble');
    let hiddenForPage = false;
    let toastTimer = 0;
    let toastAction = null;

    // vertical drag; a press without movement toggles the page
    let drag = null;
    ball.addEventListener('pointerdown', (e) => {
      const r = dock.getBoundingClientRect();
      drag = { y: e.clientY, center: r.top + r.height / 2, moved: false };
      ball.setPointerCapture(e.pointerId);
    });
    ball.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) dock.style.top = `${Math.min(innerHeight - 28, Math.max(28, drag.center + dy))}px`;
    });
    ball.addEventListener('pointerup', () => {
      if (!drag) return;
      const { moved } = drag;
      drag = null;
      if (!moved) { togglePage(); return; }
      const r = dock.getBoundingClientRect();
      DUET.saveSettings({ ballTop: Math.round(((r.top + r.height / 2) / innerHeight) * 100) });
    });

    root.addEventListener('click', (e) => {
      const act = e.target.closest?.('[data-act]')?.dataset.act;
      if (act === 'display') DUET.saveSettings({ displayMode: settings.displayMode === 'translation' ? 'bilingual' : 'translation' });
      if (act === 'options') chrome.runtime.sendMessage({ type: 'openOptions' });
      if (act === 'hide') { hiddenForPage = true; update(); }
      if (act === 'copy') navigator.clipboard.writeText($('.bubble-body').textContent).then(() => toast('已复制译文', 'info'));
      if (act === 'toast-close') toast('');
      if (act === 'toast-action') { const run = toastAction; toast(''); run?.(); }
    });

    let frame = 0;
    const update = () => { frame ||= requestAnimationFrame(render); };
    function render() {
      frame = 0;
      const s = stats();
      const only = settings.displayMode === 'translation';
      dock.hidden = hiddenForPage || !settings.floatBall;
      dock.style.top = `${settings.ballTop}%`;
      dock.classList.toggle('active', active);
      dock.classList.toggle('busy', s.pending > 0);
      dock.classList.toggle('failed', s.failed > 0);
      const label = active ? '显示原文（Alt+A）' : '翻译此页（Alt+A）';
      ball.title = label;
      ball.setAttribute('aria-label', label);
      let status = '点击按钮翻译此页';
      if (s.pending) status = `正在翻译 ${s.pending} 段`;
      else if (active || s.done) status = `已翻译 ${s.done} 段`;
      if (s.failed) status += `，${s.failed} 段失败`;
      $('.status').textContent = status;
      $('[data-act="display"] .ico').innerHTML = only ? ICON_DUET : ICON_ONLY;
      $('[data-act="display"] .label').textContent = only ? '改为双语对照' : '改为只显示译文';
      hostEl.style.setProperty('--accent', settings.color);
    }

    function toast(msg, kind = 'error', action) {
      clearTimeout(toastTimer);
      if (!msg) { toastEl.hidden = true; return; }
      toastEl.className = `toast ${kind}`;
      $('.toast-text').textContent = msg;
      toastAction = action?.run || null;
      $('.toast-action').hidden = !action;
      $('.toast-action').textContent = action?.label || '';
      toastEl.hidden = false;
      toastTimer = setTimeout(() => { toastEl.hidden = true; }, kind === 'error' ? 10000 : 2500);
    }

    // selection translation
    let selText = '';
    let selRect = null;
    function placeNear(el, rect) {
      el.hidden = false;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const x = Math.min(innerWidth - w - 8, Math.max(8, rect.right - w / 2));
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
      const anchor = rect || { left: innerWidth / 2, right: innerWidth / 2, top: 80, bottom: 80 };
      body.innerHTML = '<span class="skel"></span><span class="skel short"></span>';
      $('.copy').hidden = true;
      $('.engine').textContent = DUET.ENGINES[settings.engine]?.name || '';
      placeNear(bubble, anchor);
      const to = scriptMatchesTarget(text, settings.targetLang) === 'yes' ? settings.inputTargetLang : settings.targetLang;
      try {
        const [result] = await translateTexts([text], to);
        body.textContent = result || '没有返回译文';
        $('.copy').hidden = !result;
      } catch (e) {
        body.textContent = `翻译失败：${e.message}`;
      }
      placeNear(bubble, anchor);
    }
    selIcon.addEventListener('click', () => showBubble(selText, selRect));
    const hidePopups = () => { selIcon.hidden = true; bubble.hidden = true; };
    addEventListener('mousedown', (e) => { if (!e.composedPath().includes(hostEl)) hidePopups(); }, true);
    addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePopups(); }, true);
    addEventListener('scroll', () => { selIcon.hidden = true; }, { capture: true, passive: true });

    document.documentElement.appendChild(hostEl);
    // some SPAs replace <html> children; keep the UI attached
    setInterval(() => { if (!hostEl.isConnected) document.documentElement.appendChild(hostEl); }, 2000);
    render();
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
      case 'retryFailed': retryFailed(); break;
    }
    sendResponse({ active, displayMode: settings.displayMode, host, ...stats(), error: lastError });
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

  // The logo's mark: an original line and a lighter translated line beneath it.
  const ICON_DUET = '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h10M4 10h7"/><path d="M8 14.5h8" opacity=".5"/></svg>';
  const ICON_ONLY = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h12M4 12.5h8"/></svg>';
  const ICON_GEAR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_HIDE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10.7 5.1A10 10 0 0 1 22 12a13 13 0 0 1-1.7 2.7M6.6 6.6A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_COPY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/></svg>';

  const UI_CSS = `
    /* the host carries all:initial inline, which beats :host rules, so tokens live on the top-level boxes */
    :host { --accent: #3f56e0; }
    .dock, .toast, .sel-icon, .bubble {
      --surface: #fff; --line: rgba(29, 31, 35, .1); --muted: #6b6f76; --hover: rgba(29, 31, 35, .05);
      --shadow: 0 4px 16px rgba(20, 22, 26, .12);
      font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
      color: #1d1f23;
    }
    @media (prefers-color-scheme: dark) {
      .dock, .toast, .sel-icon, .bubble {
        --surface: #232427; --line: rgba(255, 255, 255, .1); --muted: #9a9ea6; --hover: rgba(255, 255, 255, .06);
        --shadow: 0 4px 16px rgba(0, 0, 0, .4);
        color: #e8e9eb;
      }
    }
    [hidden] { display: none !important; }
    button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    svg { display: block; }

    .dock { position: fixed; right: 12px; transform: translateY(-50%); }
    .ball {
      position: relative; width: 40px; height: 40px; border-radius: 20px; display: grid; place-items: center;
      background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); color: var(--accent);
      touch-action: none; transition: background-color .15s, color .15s;
    }
    .ball:hover { background: color-mix(in srgb, var(--accent) 8%, var(--surface)); }
    .active .ball { background: var(--accent); border-color: transparent; color: #fff; }
    .ball::after {
      content: ''; position: absolute; inset: -4px; border-radius: 50%;
      border: 2px solid transparent; border-top-color: var(--accent); opacity: 0;
    }
    .busy .ball::after { opacity: 1; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .busy .ball::after { animation: none; border-color: var(--accent); opacity: .4; } }
    .dot {
      position: absolute; top: 0; right: 0; width: 10px; height: 10px; border-radius: 5px;
      background: #d4453b; border: 2px solid var(--surface); box-sizing: border-box; display: none;
    }
    .failed .dot { display: block; }

    .panel {
      position: absolute; right: 100%; top: 50%; padding-right: 8px;
      transform: translate(4px, -50%); opacity: 0; pointer-events: none; transition: opacity .15s, transform .15s;
    }
    .dock:hover .panel, .dock:focus-within .panel { opacity: 1; pointer-events: auto; transform: translate(0, -50%); }
    .panel-inner {
      width: 192px; padding: 4px; background: var(--surface); border: 1px solid var(--line);
      border-radius: 12px; box-shadow: var(--shadow);
    }
    .status { margin: 0; padding: 6px 8px 4px; font-size: 12px; color: var(--muted); }
    .row { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px; border-radius: 8px; text-align: left; }
    .row:hover { background: var(--hover); }
    .ico { width: 16px; display: grid; place-items: center; color: var(--muted); }

    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); max-width: min(520px, 92vw);
      display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 16px;
      background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow);
    }
    .toast-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .toast.error .toast-text::before {
      content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 8px; border-radius: 4px; background: #d4453b;
    }
    .toast-action { flex: none; padding: 4px 8px; border-radius: 8px; color: var(--accent); font-weight: 500; }
    .toast-action:hover, .toast-close:hover { background: var(--hover); }
    .toast-close { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--muted); }

    .sel-icon {
      position: fixed; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px;
      background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); color: var(--accent);
    }
    .sel-icon:hover { background: color-mix(in srgb, var(--accent) 8%, var(--surface)); }
    .bubble {
      position: fixed; width: max-content; min-width: 200px; max-width: min(380px, 90vw); max-height: 50vh; overflow: auto;
      padding: 12px 16px 8px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
      box-shadow: var(--shadow); font-size: 14px; line-height: 1.65;
    }
    .bubble-body { white-space: pre-wrap; overflow-wrap: anywhere; }
    .skel { display: block; height: 10px; margin: 8px 0; border-radius: 5px; background: var(--hover); }
    .skel.short { width: 60%; }
    .bubble-foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 8px; font-size: 12px; color: var(--muted); }
    .copy { display: flex; align-items: center; gap: 4px; padding: 2px 8px; margin-right: -8px; border-radius: 8px; }
    .copy:hover { background: var(--hover); color: var(--accent); }
  `;

  init();
})();
