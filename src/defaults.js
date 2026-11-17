/* Shared by the background worker, content scripts and extension pages. */
// eslint-disable-next-line no-var
var DUET = (() => {
  // [code, 中文名, English name (used in LLM prompts)]
  const LANGUAGES = [
    ['zh-CN', '简体中文', 'Simplified Chinese'],
    ['zh-TW', '繁體中文', 'Traditional Chinese'],
    ['en', 'English', 'English'],
    ['ja', '日本語', 'Japanese'],
    ['ko', '한국어', 'Korean'],
    ['fr', 'Français', 'French'],
    ['de', 'Deutsch', 'German'],
    ['es', 'Español', 'Spanish'],
    ['pt', 'Português', 'Portuguese'],
    ['it', 'Italiano', 'Italian'],
    ['ru', 'Русский', 'Russian'],
    ['ar', 'العربية', 'Arabic'],
    ['vi', 'Tiếng Việt', 'Vietnamese'],
    ['th', 'ไทย', 'Thai'],
    ['id', 'Bahasa Indonesia', 'Indonesian'],
    ['tr', 'Türkçe', 'Turkish'],
    ['uk', 'Українська', 'Ukrainian'],
    ['pl', 'Polski', 'Polish'],
    ['nl', 'Nederlands', 'Dutch'],
  ];

  const ENGINES = {
    microsoft: { name: '微软翻译', desc: '免费，无需配置，国内可用', llm: false },
    google: { name: '谷歌翻译', desc: '免费，无需配置，需能访问 Google', llm: false },
    openai: { name: 'OpenAI 兼容接口', desc: 'OpenAI / DeepSeek / 硅基流动 / OpenRouter / Ollama 等', llm: true },
    claude: { name: 'Claude', desc: 'Anthropic Messages API', llm: true },
    gemini: { name: 'Gemini', desc: 'Google Generative Language API', llm: true },
  };

  const OPENAI_PRESETS = [
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { name: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
    { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' },
    { name: '通义千问 DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    { name: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  ];

  const STYLES = [
    ['none', '无样式'],
    ['underline', '下划线'],
    ['dashed', '虚线下划线'],
    ['wavy', '波浪线'],
    ['highlight', '背景高亮'],
    ['marker', '马克笔'],
    ['sideline', '左侧竖线'],
    ['dim', '弱化'],
    ['italic', '斜体'],
    ['blur', '模糊（悬停显示）'],
  ];

  const DEFAULT_SYSTEM_PROMPT = [
    'You are a professional, authentic machine translation engine.',
    'Translate the user-provided text into {{to}} the way a native {{to}} speaker would write it: fluent, natural and faithful to the original meaning and tone.',
    'Rules:',
    '- Output ONLY the translation. No explanations, notes, quotes or extra text.',
    '- Keep code, URLs, numbers, product names and proper nouns unchanged when that reads more naturally.',
    '- If a piece of text is already in {{to}}, output it unchanged.',
  ].join('\n');

  const LLM_DEFAULTS = { apiKey: '', temperature: '', concurrency: 4, batchSize: 10, batchChars: 2000 };

  const DEFAULTS = {
    targetLang: 'zh-CN',
    engine: 'microsoft',
    displayMode: 'bilingual', // 'bilingual' | 'translation'
    style: 'none',
    color: '#3f56e0',
    floatBall: true,
    ballTop: 62, // percent of viewport height
    hoverKey: 'Control', // 'Control' | 'Alt' | 'Shift' | 'off'
    selectionTranslate: true,
    inputTranslate: true,
    inputTargetLang: 'en',
    autoTranslate: false, // translate every page whose language differs from targetLang
    alwaysSites: [],
    neverSites: [],
    systemPrompt: '',
    customCss: '',
    engines: {
      microsoft: { concurrency: 6, batchSize: 40, batchChars: 4500 },
      google: { concurrency: 6, batchSize: 1, batchChars: 4500 },
      openai: { ...LLM_DEFAULTS, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
      claude: { ...LLM_DEFAULTS, baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5' },
      gemini: { ...LLM_DEFAULTS, baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash' },
    },
  };

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  function merge(base, over) {
    const out = { ...base };
    if (!isObj(over)) return out;
    for (const [k, v] of Object.entries(over)) out[k] = isObj(base[k]) ? merge(base[k], v) : v;
    return out;
  }

  async function loadSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return merge(DEFAULTS, settings);
  }

  async function saveSettings(patch) {
    const current = await loadSettings();
    const next = merge(current, patch);
    await chrome.storage.local.set({ settings: next });
    return next;
  }

  const langName = (code) => (LANGUAGES.find((l) => l[0] === code) || [code, code, code])[2];

  function hostMatches(host, list) {
    return list.some((entry) => {
      const e = entry.trim().toLowerCase();
      return e && (host === e || host.endsWith('.' + e));
    });
  }

  // Why the engine can't translate yet, or '' when it is ready. Mirrors the checks in background.js.
  function engineProblem(settings, id = settings.engine) {
    const cfg = settings.engines[id];
    if (!ENGINES[id]?.llm) return '';
    if (!cfg.baseUrl?.trim()) return '未填写接口地址';
    if (!cfg.model?.trim()) return '未填写模型';
    if (id !== 'openai' && !cfg.apiKey?.trim()) return '未填写 API Key';
    return '';
  }

  return {
    LANGUAGES, ENGINES, OPENAI_PRESETS, STYLES, DEFAULTS, DEFAULT_SYSTEM_PROMPT,
    merge, loadSettings, saveSettings, langName, hostMatches, engineProblem,
  };
})();
