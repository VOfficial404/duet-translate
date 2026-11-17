const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const COLORS = ['#3f56e0', '#0e7c86', '#2f8a3e', '#c26a00', '#c2382f', '#8a44c8'];

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
  for (const s of $$('main .page')) s.hidden = s.id !== id;
  for (const a of $$('nav a')) a.classList.toggle('on', a.hash === `#${id}`);
}
addEventListener('hashchange', showSection);

/* ---------- translation services ---------- */

function svcStatus(id) {
  if (!DUET.ENGINES[id].llm) return ['免费，无需配置', ''];
  const problem = DUET.engineProblem(settings, id);
  return problem ? [problem, 'warn'] : ['已配置', ''];
}

function renderServiceList() {
  $('#svcList').innerHTML = Object.entries(DUET.ENGINES).map(([id, e]) => {
    const [text, cls] = svcStatus(id);
    return `<label><input type="radio" name="engine" value="${id}" data-key="engine"><span class="svc"><b>${esc(e.name)}</b><small class="${cls}">${esc(text)}</small></span></label>`;
  }).join('');
}

function renderServicePanel() {
  const id = settings.engine;
  const e = DUET.ENGINES[id];
  const k = (f) => `engines.${id}.${f}`;
  const limits = `
    <label>同时发出的请求数<input type="number" min="1" max="50" data-key="${k('concurrency')}"></label>
    <label>每次请求最多段落数<input type="number" min="1" max="100" data-key="${k('batchSize')}"></label>
    <label>每次请求最多字数<input type="number" min="200" max="20000" step="100" data-key="${k('batchChars')}"></label>`;
  const test = `
    <div class="test"><button class="btn" id="testBtn">测试</button><span class="test-result" id="testResult">用这个服务翻译一句英文，确认能用</span></div>`;

  if (!e.llm) {
    $('#svcPanel').innerHTML = `<h3>${esc(e.name)}</h3><p class="desc">${esc(e.desc)}。选中后就能直接使用。</p>${test}
      <details><summary>请求设置</summary><div class="grid3">${limits}</div></details>`;
  } else {
    const presets = id === 'openai'
      ? `<div class="field"><span>服务商</span><div class="presets">${DUET.OPENAI_PRESETS.map((p, i) =>
        `<button data-preset="${i}" class="${settings.engines.openai.baseUrl === p.baseUrl ? 'on' : ''}">${esc(p.name)}</button>`).join('')}</div>
        <span class="hint">点一下自动填入接口地址和推荐模型。本地 Ollama 如果返回 403，需要设置环境变量 <code>OLLAMA_ORIGINS=*</code> 后重启。</span></div>`
      : '';
    $('#svcPanel').innerHTML = `<h3>${esc(e.name)}</h3>
      ${presets}
      <label class="field"><span>API Key</span>
        <span class="key"><input type="password" autocomplete="off" spellcheck="false" data-key="${k('apiKey')}" placeholder="${id === 'openai' ? '本地模型可以不填' : ''}">
        <button class="btn" type="button" id="reveal">显示</button></span>
        <span class="hint">只保存在这台电脑的浏览器里，翻译时直接发给下面的接口地址</span></label>
      <label class="field"><span>接口地址</span><input type="url" spellcheck="false" data-key="${k('baseUrl')}"></label>
      <label class="field"><span>模型</span><input type="text" spellcheck="false" data-key="${k('model')}"></label>
      ${test}
      <details><summary>请求设置</summary><div class="grid3">
        <label>Temperature<input type="text" data-key="${k('temperature')}" placeholder="留空用模型默认值"></label>
        ${limits}</div>
        <p class="hint" style="color: var(--muted); font-size: 13px; padding-bottom: 12px">翻译建议 Temperature 设为 0 到 0.3。推理模型（o 系列、GPT-5、DeepSeek-R1）只能留空。</p>
      </details>
      <details><summary>提示词</summary>
        <label class="field" style="padding-top: 0"><textarea data-key="systemPrompt" rows="8" placeholder="${esc(DUET.DEFAULT_SYSTEM_PROMPT)}" aria-label="提示词"></textarea>
        <span class="hint">留空使用默认提示词，<code>{{to}}</code> 会替换成目标语言。一次翻译多段时，编号规则会自动加上。</span></label>
      </details>`;
  }

  for (const b of $$('[data-preset]')) {
    b.addEventListener('click', () => {
      const p = DUET.OPENAI_PRESETS[b.dataset.preset];
      settings.engines.openai.baseUrl = p.baseUrl;
      settings.engines.openai.model = p.model;
      persist();
      renderServicePanel();
      renderServiceList();
      fillFields();
    });
  }
  $('#reveal')?.addEventListener('click', (ev) => {
    const input = ev.currentTarget.previousElementSibling;
    input.type = input.type === 'password' ? 'text' : 'password';
    ev.currentTarget.textContent = input.type === 'password' ? '显示' : '隐藏';
  });
  $('#testBtn').addEventListener('click', runTest);
}

async function runTest() {
  const out = $('#testResult');
  const btn = $('#testBtn');
  out.className = 'test-result';
  out.textContent = '正在请求…';
  btn.disabled = true;
  clearTimeout(saveTimer);
  await chrome.storage.local.set({ settings });
  const started = performance.now();
  const res = await chrome.runtime.sendMessage({
    type: 'translate', texts: ['Hello! This is a quick test of the translation service.'], to: settings.targetLang, noCache: true,
  });
  const ms = Math.round(performance.now() - started);
  btn.disabled = false;
  if (res?.ok) { out.className = 'test-result ok'; out.textContent = `${res.data[0]}（${ms} 毫秒）`; }
  else { out.className = 'test-result err'; out.textContent = res?.error || '没有返回结果'; }
}

/* ---------- appearance ---------- */

function renderAppearance() {
  $('#styleChips').innerHTML = DUET.STYLES.map(([value, name]) =>
    `<label title="${name}"><input type="radio" name="style" value="${value}" data-key="style"><span class="chip" data-duet-style="${value}"><font class="duet-block"><font class="duet-inner">${name}</font></font></span></label>`).join('');
  $('#swatches').innerHTML = COLORS.map((c) =>
    `<label title="${c}"><input type="radio" name="color" value="${c}" data-key="color"><span class="sw" style="background:${c}"></span></label>`).join('')
    + '<input type="color" data-key="color" title="自定义颜色" aria-label="自定义颜色">';
}

function applyPreview() {
  const preview = $('#preview');
  preview.dataset.duetStyle = settings.style;
  preview.dataset.display = settings.displayMode;
  document.documentElement.style.setProperty('--duet-color', settings.color);
  document.documentElement.style.setProperty('--accent', settings.color);
}

/* ---------- generic field binding ---------- */

function fillFields() {
  for (const el of $$('[data-key]')) {
    // re-filling the field being typed in would move its caret
    if (el === document.activeElement && el.type !== 'radio' && el.type !== 'checkbox') continue;
    const v = getPath(settings, el.dataset.key);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = el.value === v;
    else if (el.hasAttribute('data-list')) el.value = (v || []).join('\n');
    else el.value = v ?? '';
  }
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
    for (const f of $$('.saved-flag')) {
      f.textContent = '已自动保存';
      f.classList.add('show');
      setTimeout(() => f.classList.remove('show'), 1500);
    }
  }, 300);
}

document.addEventListener('input', (e) => {
  const el = e.target.closest?.('[data-key]');
  if (!el || (el.type === 'radio' && !el.checked)) return;
  if (el.type === 'number' && el.value === '') return;
  const key = el.dataset.key;
  setPath(settings, key, readField(el));
  if (key === 'engine') renderServicePanel();
  if (key === 'engine' || key.startsWith('engines.')) renderServiceList();
  if (key === 'color' || key === 'engine' || key.startsWith('engines.')) fillFields();
  applyPreview();
  persist();
});

/* ---------- actions ---------- */

$('#shortcuts').addEventListener('click', () => {
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
    refreshAll();
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
  if (!confirm('恢复默认设置？填写过的 API Key 也会被清除。')) return;
  settings = structuredClone(DUET.DEFAULTS);
  await chrome.storage.local.set({ settings });
  refreshAll();
});

/* ---------- init ---------- */

function refreshAll() {
  renderServiceList();
  renderServicePanel();
  fillFields();
}

(async () => {
  settings = await DUET.loadSettings();
  for (const sel of $$('[data-langs]')) sel.replaceChildren(...DUET.LANGUAGES.map(([c, n]) => new Option(n, c)));
  renderAppearance();
  refreshAll();
  showSection();
})();
