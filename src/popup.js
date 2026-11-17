const $ = (id) => document.getElementById(id);

// Sample translation of the preview sentence, per target language.
const SAMPLE = {
  'zh-CN': '并排阅读两种语言，会让你以一种好的方式慢下来。',
  'zh-TW': '並排閱讀兩種語言，會讓你以一種好的方式慢下來。',
  ja: '二つの言語を並べて読むと、いい意味でゆっくりになる。',
  ko: '두 언어를 나란히 읽으면 좋은 의미로 속도가 느려진다.',
  fr: 'Lire deux langues côte à côte vous ralentit, dans le bon sens.',
  de: 'Zwei Sprachen nebeneinander zu lesen, bremst einen auf gute Weise.',
  es: 'Leer dos idiomas uno al lado del otro te frena de buena manera.',
  ru: 'Чтение двух языков бок о бок замедляет вас — в хорошем смысле.',
};
const HOVER_KEY = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };

let settings;
let tab;
let state = null;

const send = (msg) => chrome.tabs.sendMessage(tab.id, msg).catch(() => null);
const save = async (patch) => { settings = await DUET.saveSettings(patch); render(); };

function siteRule() {
  if (DUET.hostMatches(state.host, settings.alwaysSites)) return 'always';
  if (DUET.hostMatches(state.host, settings.neverSites)) return 'never';
  return 'default';
}

function render() {
  $('targetLang').value = settings.targetLang;
  $('engine').value = settings.engine;
  document.querySelector(`[name=displayMode][value=${settings.displayMode}]`).checked = true;
  document.querySelector(`[name=style][value=${settings.style}]`).checked = true;

  const preview = $('preview');
  preview.dataset.duetStyle = settings.style;
  preview.dataset.display = settings.displayMode;
  preview.style.setProperty('--duet-color', settings.color);
  document.documentElement.style.setProperty('--accent', settings.color);
  $('previewText').textContent = SAMPLE[settings.targetLang] || SAMPLE['zh-CN'];

  const problem = DUET.engineProblem(settings);
  $('engineNotice').hidden = !problem;
  $('engineProblem').textContent = `${DUET.ENGINES[settings.engine].name} ${problem}`;

  const hover = HOVER_KEY[settings.hoverKey];
  $('hoverHint').innerHTML = hover ? `<kbd>${hover}</kbd> 翻译鼠标下的段落` : '';
  renderPage();
}

function renderPage() {
  const toggle = $('toggle');
  if (!state) {
    toggle.disabled = true;
    $('status').textContent = '这个页面不能翻译，浏览器内部页面和扩展商店会限制扩展运行';
    $('siteRow').hidden = true;
    return;
  }
  $('site').textContent = state.host;
  toggle.disabled = false;
  toggle.textContent = state.active ? '显示原文' : '翻译此页';
  toggle.classList.toggle('on', state.active);
  document.querySelector(`[name=siteRule][value=${siteRule()}]`).checked = true;

  const status = $('status');
  status.replaceChildren();
  const text = document.createElement('span');
  if (state.pending) text.textContent = `正在翻译 ${state.pending} 段，已完成 ${state.done} 段`;
  else if (state.active || state.done) text.textContent = `已翻译 ${state.done} 段`;
  else text.textContent = '只翻译你看到的部分，向下滚动时会继续翻译';
  status.append(text);
  if (state.failed) {
    const err = document.createElement('span');
    err.className = 'err';
    err.title = state.error || '';
    err.textContent = `${state.failed} 段失败`;
    const retry = document.createElement('button');
    retry.textContent = '重试';
    retry.addEventListener('click', async () => { state = (await send({ type: 'retryFailed' })) || state; renderPage(); });
    const right = document.createElement('span');
    right.append(err, ' ', retry);
    status.append(right);
  }
}

async function main() {
  settings = await DUET.loadSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  $('targetLang').replaceChildren(...DUET.LANGUAGES.map(([code, name]) => new Option(name, code)));
  $('engine').replaceChildren(...Object.entries(DUET.ENGINES).map(([id, e]) =>
    new Option(DUET.engineProblem(settings, id) ? `${e.name}（未配置）` : e.name, id)));
  $('styles').innerHTML = DUET.STYLES.map(([value, name]) =>
    `<label title="${name}"><input type="radio" name="style" value="${value}"><span class="chip" data-duet-style="${value}"><font class="duet-block"><font class="duet-inner">${name}</font></font></span></label>`).join('');

  $('targetLang').addEventListener('change', (e) => save({ targetLang: e.target.value }));
  $('engine').addEventListener('change', (e) => save({ engine: e.target.value }));
  document.addEventListener('change', (e) => {
    const { name, value } = e.target;
    if (name === 'displayMode' || name === 'style') save({ [name]: value });
    if (name === 'siteRule') setSiteRule(value);
  });
  const openOptions = (hash) => { chrome.tabs.create({ url: chrome.runtime.getURL(`src/options.html${hash}`) }); window.close(); };
  $('options').addEventListener('click', () => openOptions(''));
  $('fixEngine').addEventListener('click', (e) => { e.preventDefault(); openOptions('#engine'); });
  $('toggle').addEventListener('click', async () => { state = (await send({ type: 'toggle' })) || state; renderPage(); });

  state = await send({ type: 'getState' });
  render();
  // live progress while the popup is open
  if (state) setInterval(async () => { state = (await send({ type: 'getState' })) || state; renderPage(); }, 600);
}

async function setSiteRule(rule) {
  const others = (list) => list.filter((h) => !DUET.hostMatches(state.host, [h]));
  const alwaysSites = others(settings.alwaysSites);
  const neverSites = others(settings.neverSites);
  if (rule === 'always') alwaysSites.push(state.host);
  if (rule === 'never') neverSites.push(state.host);
  await save({ alwaysSites, neverSites });
  if (rule === 'always' && !state.active) state = (await send({ type: 'start' })) || state;
  if (rule === 'never' && state.active) state = (await send({ type: 'stop' })) || state;
  renderPage();
}

main();
