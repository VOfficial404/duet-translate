const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let settings;

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ??= {}), obj)[last] = value;
}

/* ---------- navigation ---------- */

function showSection() {
  const id = (location.hash || '#general').slice(1);
  for (const s of $$('main section')) s.hidden = s.id !== id;
  for (const a of $$('nav a')) a.classList.toggle('on', a.hash === `#${id}`);
}
addEventListener('hashchange', showSection);

/* ---------- engine panels ---------- */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function enginePanel(id, engine) {
  const k = (f) => `engines.${id}.${f}`;
  const limits = `
    <div class="field grid3">
      <label><span>最大并发请求</span><input type="number" min="1" max="50" data-key="${k('concurrency')}"></label>
      <label><span>每批最多段落</span><input type="number" min="1" max="100" data-key="${k('batchSize')}"></label>
      <label><span>每批最多字符</span><input type="number" min="200" max="20000" step="100" data-key="${k('batchChars')}"></label>
    </div>`;
  if (!engine.llm) {
    return `<div class="card" data-panel="${id}"><h3>${esc(engine.name)}</h3>
      <div class="field muted">${esc(engine.desc)}。</div>${limits}</div>`;
  }
  const presets = id === 'openai'
    ? `<div class="field"><span>服务商预设</span><select id="openaiPreset"><option value="">选择后自动填入接口地址和模型…</option>${
      DUET.OPENAI_PRESETS.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}</select>
      <span class="hint">本地 Ollama 若返回 403，请设置环境变量 <code>OLLAMA_ORIGINS=*</code> 后重启 Ollama。</span></div>`
    : '';
  const keyHint = id === 'openai' ? '本地模型可留空' : '';
  return `<div class="card" data-panel="${id}"><h3>${esc(engine.name)}</h3>${presets}
    <div class="field"><span>API Key</span><div class="key-wrap">
      <input type="password" autocomplete="off" spellcheck="false" data-key="${k('apiKey')}" placeholder="${keyHint}">
      <button class="btn" data-reveal>显示</button></div>
      <span class="hint">只保存在本机浏览器中，请求直接发往下面的接口地址。</span></div>
    <div class="field"><span>接口地址</span><input type="url" spellcheck="false" data-key="${k('baseUrl')}"></div>
    <div class="field"><span>模型</span><input type="text" spellcheck="false" data-key="${k('model')}"></div>
    <div class="field"><span>Temperature</span><input type="text" data-key="${k('temperature')}" placeholder="留空使用模型默认值">
      <span class="hint">翻译建议 0–0.3。部分推理模型（如 o 系列、GPT-5）只接受默认值，请留空。</span></div>
    ${limits}</div>`;
}

function renderEngines() {
  $('#engineCards').innerHTML = Object.entries(DUET.ENGINES).map(([id, e]) =>
    `<label class="engine-card"><input type="radio" name="engine" value="${id}" data-key="engine"><b>${esc(e.name)}</b><small>${esc(e.desc)}</small></label>`).join('');
  $('#enginePanels').innerHTML = Object.entries(DUET.ENGINES).map(([id, e]) => enginePanel(id, e)).join('');

  $('#openaiPreset').addEventListener('change', (e) => {
    const p = DUET.OPENAI_PRESETS[e.target.value];
    if (!p) return;
    settings.engines.openai.baseUrl = p.baseUrl;
    settings.engines.openai.model = p.model;
    fillFields();
    persist();
    e.target.value = '';
  });
  for (const b of $$('[data-reveal]')) {
    b.addEventListener('click', () => {
      const input = b.previousElementSibling;
      input.type = input.type === 'password' ? 'text' : 'password';
      b.textContent = input.type === 'password' ? '显示' : '隐藏';
    });
  }
}

function updateEngineVisibility() {
  for (const p of $$('[data-panel]')) p.hidden = p.dataset.panel !== settings.engine;
  $('#promptCard').hidden = !DUET.ENGINES[settings.engine].llm;
}

/* ---------- generic field binding ---------- */

function fillFields() {
  for (const el of $$('[data-key]')) {
    const v = getPath(settings, el.dataset.key);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = el.value === v;
    else if (el.hasAttribute('data-list')) el.value = (v || []).join('\n');
    else el.value = v ?? '';
  }
  updateEngineVisibility();
  applyPreview();
}

function readField(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return Number(el.value) || getPath(DUET.DEFAULTS, el.dataset.key);
  if (el.hasAttribute('data-list')) return el.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return el.value;
}

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ settings });
    $('#saved').classList.add('show');
    setTimeout(() => $('#saved').classList.remove('show'), 1200);
  }, 300);
}

document.addEventListener('input', (e) => {
  const el = e.target.closest?.('[data-key]');
  if (!el || (el.type === 'radio' && !el.checked)) return;
  if (el.type === 'number' && el.value === '') return;
  setPath(settings, el.dataset.key, readField(el));
  if (el.dataset.key === 'engine') updateEngineVisibility();
  applyPreview();
  persist();
});

function applyPreview() {
  document.documentElement.setAttribute('data-duet-style', settings.style);
  document.documentElement.style.setProperty('--duet-color', settings.color);
  document.documentElement.style.setProperty('--accent', settings.color);
}

/* ---------- actions ---------- */

$('#testBtn').addEventListener('click', async () => {
  const out = $('#testResult');
  out.className = 'muted';
  out.textContent = '测试中…';
  clearTimeout(saveTimer);
  await chrome.storage.local.set({ settings });
  const started = performance.now();
  const res = await chrome.runtime.sendMessage({
    type: 'translate', texts: ['Hello! This is a quick test of the translation service.'], to: settings.targetLang, noCache: true,
  });
  const ms = Math.round(performance.now() - started);
  if (res?.ok) { out.className = ''; out.textContent = `✓ ${res.data[0]}（${ms} ms）`; }
  else { out.className = 'error'; out.textContent = `✗ ${res?.error || '未知错误'}`; }
});

$('#shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  const firefox = navigator.userAgent.includes('Firefox');
  chrome.tabs.create({ url: firefox ? 'about:addons' : 'chrome://extensions/shortcuts' });
});

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'duet-translate-settings.json' });
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    settings = DUET.merge(DUET.DEFAULTS, JSON.parse(await file.text()));
    await chrome.storage.local.set({ settings });
    fillFields();
    alert('设置已导入');
  } catch (err) {
    alert(`导入失败：${err.message}`);
  }
  e.target.value = '';
});

$('#clearCacheBtn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'clearCache' });
  alert(res?.ok ? '翻译缓存已清除' : `清除失败：${res?.error}`);
});

$('#resetBtn').addEventListener('click', async () => {
  if (!confirm('恢复默认设置？已填写的 API Key 也会被清除。')) return;
  settings = structuredClone(DUET.DEFAULTS);
  await chrome.storage.local.set({ settings });
  fillFields();
});

/* ---------- init ---------- */

(async () => {
  settings = await DUET.loadSettings();
  for (const sel of $$('[data-langs]')) sel.replaceChildren(...DUET.LANGUAGES.map(([c, n]) => new Option(n, c)));
  $('#styleSelect').replaceChildren(...DUET.STYLES.map(([v, n]) => new Option(n, v)));
  $('#systemPrompt').placeholder = DUET.DEFAULT_SYSTEM_PROMPT;
  renderEngines();
  fillFields();
  showSection();
})();
