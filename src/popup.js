const $ = (id) => document.getElementById(id);

const fill = (select, options) => {
  select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
};

const HOVER_LABEL = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };

async function main() {
  let settings = await DUET.loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  fill($('targetLang'), DUET.LANGUAGES.map(([code, name]) => [code, name]));
  fill($('engine'), Object.entries(DUET.ENGINES).map(([id, e]) => [id, e.name]));
  fill($('style'), DUET.STYLES);

  const render = () => {
    $('targetLang').value = settings.targetLang;
    $('engine').value = settings.engine;
    $('style').value = settings.style;
    for (const b of $('displayMode').children) b.classList.toggle('on', b.dataset.v === settings.displayMode);
    const hover = HOVER_LABEL[settings.hoverKey];
    $('hoverHint').textContent = hover ? `悬停按 ${hover} 翻译段落` : '';
  };
  render();

  const save = async (patch) => { settings = await DUET.saveSettings(patch); render(); };
  for (const key of ['targetLang', 'engine', 'style']) $(key).addEventListener('change', (e) => save({ [key]: e.target.value }));
  $('displayMode').addEventListener('click', (e) => { if (e.target.dataset.v) save({ displayMode: e.target.dataset.v }); });
  $('options').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); window.close(); });

  let state = null;
  try {
    state = await chrome.tabs.sendMessage(tab.id, { type: 'getState' });
  } catch { /* no content script on this page */ }
  if (!state) {
    $('pageControls').hidden = true;
    $('unsupported').hidden = false;
    return;
  }

  const host = state.host;
  const renderPage = () => {
    $('toggle').textContent = state.active ? '显示原文' : '翻译此页面';
    $('toggle').classList.toggle('on', state.active);
    $('site').textContent = host;
    $('always').checked = DUET.hostMatches(host, settings.alwaysSites);
    $('never').checked = DUET.hostMatches(host, settings.neverSites);
  };
  renderPage();

  $('toggle').addEventListener('click', async () => {
    state = await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
    renderPage();
  });

  const setList = (name, on) => {
    const list = settings[name].filter((h) => !DUET.hostMatches(host, [h]));
    return on ? [...list, host] : list;
  };
  $('always').addEventListener('change', async (e) => {
    const patch = { alwaysSites: setList('alwaysSites', e.target.checked) };
    if (e.target.checked) patch.neverSites = setList('neverSites', false);
    await save(patch);
    if (e.target.checked && !state.active) state = await chrome.tabs.sendMessage(tab.id, { type: 'start' });
    renderPage();
  });
  $('never').addEventListener('change', async (e) => {
    const patch = { neverSites: setList('neverSites', e.target.checked) };
    if (e.target.checked) patch.alwaysSites = setList('alwaysSites', false);
    await save(patch);
    if (e.target.checked && state.active) state = await chrome.tabs.sendMessage(tab.id, { type: 'stop' });
    renderPage();
  });
}

main();
