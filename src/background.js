/* Background: translation engines, cache, concurrency, menus and shortcuts. */
// Chrome loads this file alone as a service worker; Firefox loads defaults.js first as an event page.
if (typeof DUET === 'undefined') importScripts('defaults.js');

let settingsPromise = null;
const getSettings = () => (settingsPromise ??= DUET.loadSettings());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) settingsPromise = null;
});

/* ---------------- cache (IndexedDB) ---------------- */

let dbPromise = null;
function db() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('duet-cache', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('t');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function cacheGetMany(keys) {
  try {
    const store = (await db()).transaction('t').objectStore('t');
    return await Promise.all(keys.map((k) => new Promise((resolve) => {
      const r = store.get(k);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    })));
  } catch {
    return keys.map(() => undefined);
  }
}

async function cachePutMany(entries) {
  if (!entries.length) return;
  try {
    const tx = (await db()).transaction('t', 'readwrite');
    for (const [k, v] of entries) tx.objectStore('t').put(v, k);
  } catch { /* cache is best-effort */ }
}

async function cacheClear() {
  const tx = (await db()).transaction('t', 'readwrite');
  tx.objectStore('t').clear();
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

/* ---------------- networking ---------------- */

class Limiter {
  constructor() { this.active = 0; this.waiting = []; }
  async run(max, fn) {
    while (this.active >= Math.max(1, max)) await new Promise((r) => this.waiting.push(r));
    this.active++;
    try { return await fn(); } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
const limiters = {};
const limiterFor = (engine) => (limiters[engine] ??= new Limiter());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, init, { timeout = 60000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      if (attempt < retries) { await sleep(800 * 2 ** attempt); continue; }
      throw new Error(e.name === 'TimeoutError' ? '请求超时' : `网络错误：${e.message}`);
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(after > 0 ? Math.min(after, 20) * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`HTTP ${res.status}${body ? `：${body}` : ''}`);
  }
}

/* ---------------- machine translation engines ---------------- */

const MS_LANG = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' };

// Edge's built-in translator endpoint: no token needed (the old /translate/auth flow was retired in 2026-08).
async function translateMicrosoft(texts, to) {
  const url = `https://edge.microsoft.com/translate/translatetext?from=&to=${MS_LANG[to] || to}&isEnterpriseClient=false`;
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(texts),
  });
  const data = await res.json();
  return data.map((d) => d.translations?.[0]?.text ?? null);
}

async function translateGoogleOne(text, to) {
  const res = await request('https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=' + to, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: text }),
  });
  const data = await res.json();
  return (data[0] || []).map((seg) => seg[0] || '').join('');
}

/* ---------------- LLM engines ---------------- */

function systemPrompt(settings, to) {
  return (settings.systemPrompt.trim() || DUET.DEFAULT_SYSTEM_PROMPT).replaceAll('{{to}}', DUET.langName(to));
}

function userPrompt(texts, to) {
  if (texts.length === 1) return texts[0];
  return [
    `Translate every paragraph below into ${DUET.langName(to)}.`,
    'Each paragraph starts with a marker like [[1]]. Keep every marker exactly as is, keep the same order,',
    'output exactly one translated paragraph after each marker and nothing else.',
    '',
    ...texts.map((t, i) => `[[${i + 1}]] ${t}`),
  ].join('\n');
}

function parseBatch(output, count) {
  const results = new Array(count).fill(null);
  const parts = output.split(/\[\[(\d+)\]\]/);
  for (let i = 1; i < parts.length; i += 2) {
    const idx = Number(parts[i]) - 1;
    const text = parts[i + 1].trim();
    if (idx >= 0 && idx < count && text && results[idx] === null) results[idx] = text;
  }
  return results;
}

const stripThinking = (s) => s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
const trimSlash = (s) => s.trim().replace(/\/+$/, '');

async function chatOpenAI(cfg, system, user) {
  const body = { model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (cfg.temperature !== '' && cfg.temperature != null) body.temperature = Number(cfg.temperature);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await request(`${trimSlash(cfg.baseUrl)}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function chatClaude(cfg, system, user) {
  const body = { model: cfg.model, max_tokens: 8192, system, messages: [{ role: 'user', content: user }] };
  if (cfg.temperature !== '' && cfg.temperature != null) body.temperature = Number(cfg.temperature);
  const res = await request(`${trimSlash(cfg.baseUrl)}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function chatGemini(cfg, system, user) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
  };
  if (cfg.temperature !== '' && cfg.temperature != null) body.generationConfig = { temperature: Number(cfg.temperature) };
  const res = await request(`${trimSlash(cfg.baseUrl)}/v1beta/models/${cfg.model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
}

const CHAT = { openai: chatOpenAI, claude: chatClaude, gemini: chatGemini };

async function translateLLM(engine, cfg, settings, texts, to) {
  if (engine !== 'openai' && !cfg.apiKey) throw new Error(`未配置 ${DUET.ENGINES[engine].name} 的 API Key`);
  if (!cfg.model) throw new Error('未配置模型名称');
  const chat = (list) => limiterFor(engine).run(cfg.concurrency, async () =>
    stripThinking(await CHAT[engine](cfg, systemPrompt(settings, to), userPrompt(list, to))));

  if (texts.length === 1) return [await chat(texts)];
  const results = parseBatch(await chat(texts), texts.length);
  // Models occasionally merge or drop markers; translate whatever is missing one by one.
  await Promise.all(results.map(async (r, i) => {
    if (r === null) results[i] = await chat([texts[i]]);
  }));
  return results;
}

/* ---------------- dispatcher ---------------- */

async function translate(texts, to, engineOverride, noCache) {
  if (noCache) settingsPromise = null; // the options page "test" button saves settings right before calling
  const settings = await getSettings();
  const engine = engineOverride || settings.engine;
  const cfg = settings.engines[engine];
  if (!cfg) throw new Error(`未知翻译服务：${engine}`);

  const keyPrefix = `${engine}|${DUET.ENGINES[engine].llm ? cfg.model + '|' + settings.systemPrompt : ''}|${to}|`;
  const cached = noCache ? texts.map(() => undefined) : await cacheGetMany(texts.map((t) => keyPrefix + t));
  const results = cached.map((c) => c ?? null);
  const missing = texts.map((t, i) => i).filter((i) => results[i] === null);
  if (!missing.length) return results;

  const pending = missing.map((i) => texts[i]);
  let fresh;
  if (engine === 'microsoft') fresh = await limiterFor(engine).run(cfg.concurrency, () => translateMicrosoft(pending, to));
  else if (engine === 'google') fresh = await Promise.all(pending.map((t) => limiterFor(engine).run(cfg.concurrency, () => translateGoogleOne(t, to))));
  else fresh = await translateLLM(engine, cfg, settings, pending, to);

  const toCache = [];
  missing.forEach((idx, j) => {
    const value = fresh[j] ?? null;
    results[idx] = value;
    if (value) toCache.push([keyPrefix + texts[idx], value]);
  });
  cachePutMany(toCache);
  return results;
}

/* ---------------- messaging, menus, shortcuts ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => {
    p.then((data) => sendResponse({ ok: true, data }), (e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  };
  switch (msg?.type) {
    case 'translate': return reply(translate(msg.texts, msg.to, msg.engine, msg.noCache));
    case 'clearCache': return reply(cacheClear());
    case 'openOptions': return reply(chrome.runtime.openOptionsPage());
  }
  return false;
});

function sendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'duet-page', title: '翻译此页面 / 显示原文', contexts: ['page', 'frame', 'link', 'image'] });
    chrome.contextMenus.create({ id: 'duet-selection', title: '翻译“%s”', contexts: ['selection'] });
  });
}
chrome.runtime.onInstalled.addListener(setupMenus);
chrome.runtime.onStartup?.addListener(setupMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'duet-page') sendToTab(tab.id, { type: 'toggle' });
  if (info.menuItemId === 'duet-selection') sendToTab(tab.id, { type: 'translateSelection', text: info.selectionText });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab ??= (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id) return;
  if (command === 'toggle-page') sendToTab(tab.id, { type: 'toggle' });
  if (command === 'toggle-display') sendToTab(tab.id, { type: 'toggleDisplay' });
});
