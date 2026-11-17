# Duet Translate · 双语对照网页翻译

开源、免费、可以接入**你自己的 AI API** 的双语对照网页翻译浏览器扩展。

交互上参考了沉浸式翻译的体验：译文插在原文段落下方、滚动到哪翻译到哪、悬停一键翻译单段、划词翻译、输入框三连空格翻译。代码完全从零编写，不包含任何第三方扩展的代码，零依赖、无需构建，克隆下来就能加载。

> 本项目与 Immersive Translate（沉浸式翻译）没有任何关联。

## 功能

- **双语对照**：自动识别网页中的段落，把译文插在原文下方，保留原网页的字体和排版；短文本（导航、按钮旁标签）以内联方式显示。
- **按需翻译**：只翻译可视区域附近的段落，向下滚动时继续翻译；动态加载的内容（无限滚动、单页应用）会被自动发现并翻译。
- **批量请求 + 并发控制 + 缓存**：多个段落合并成一次请求，相同文本只翻译一次；结果缓存在本地 IndexedDB，再次打开同一页面几乎瞬间显示。
- **仅译文模式**：一键隐藏原文，只看译文（`Alt+S` 切换）。
- **悬停翻译**：鼠标停在任意段落上，按一下 `Ctrl`（可改为 `Alt` / `Shift`）即可翻译这一段，再按一次撤销。
- **划词翻译**：选中文字后点击出现的小按钮，弹出翻译气泡；右键菜单也可以翻译选中内容。
- **输入框翻译**：在任意输入框里写完中文，快速连按三次空格，内容会被替换成英文（目标语言可改）。
- **10 种译文样式**：无样式、下划线、虚线、波浪线、背景高亮、马克笔、左侧竖线、弱化、斜体、模糊（悬停显示），主题色可自定义，也支持自定义 CSS。
- **网站规则**：总是翻译 / 从不翻译某些网站；可开启“非目标语言页面自动翻译”。
- **悬浮球**：页面右侧的翻译按钮，可上下拖动，悬停展开快捷菜单。
- 自动跳过代码块、输入框、已是目标语言的段落。

## 支持的翻译服务

| 服务 | 说明 |
| --- | --- |
| 微软翻译 | 免费，无需配置，国内可直接使用（默认） |
| 谷歌翻译 | 免费，无需配置，需要能访问 Google |
| OpenAI 兼容接口 | OpenAI、DeepSeek、硅基流动、OpenRouter、通义千问、智谱 GLM、Kimi、Groq、本地 Ollama / LM Studio 等任何 `/v1/chat/completions` 接口，内置预设一键填写 |
| Claude | Anthropic Messages API |
| Gemini | Google Generative Language API |

AI 翻译可以自定义模型、Temperature、System Prompt、并发数和每批段落数 / 字符数。API Key 只保存在本机浏览器（`chrome.storage.local`），请求由扩展直接发往你填写的接口地址，不经过任何第三方服务器。

## 安装

### Chrome / Edge / 其他 Chromium 浏览器

1. 下载本仓库：`git clone https://github.com/VOfficial404/duet-translate.git`，或在 GitHub 页面点 **Code → Download ZIP** 并解压。
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），打开右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择仓库根目录（包含 `manifest.json` 的文件夹）。

### Firefox（121+）

1. 打开 `about:debugging#/runtime/this-firefox`，点击 **临时载入附加组件**，选择仓库中的 `manifest.json`。
2. 在 `about:addons` → Duet Translate → 权限 中允许“访问所有网站的数据”。

临时载入的扩展在 Firefox 重启后会被移除；长期使用需要自行签名打包。

## 使用

| 操作 | 方式 |
| --- | --- |
| 翻译整页 / 显示原文 | 点击右侧悬浮球、工具栏图标里的按钮，或按 `Alt+A` |
| 切换 双语 / 仅译文 | `Alt+S`，或悬浮球菜单 |
| 翻译单个段落 | 鼠标停在段落上，按一下 `Ctrl` |
| 翻译选中文字 | 选中后点击出现的按钮，或右键菜单 |
| 输入框翻译 | 输入内容后快速连按三次空格 |

快捷键可在 `chrome://extensions/shortcuts` 修改。

### 接入 AI

打开扩展设置 → **翻译服务**，选择 “OpenAI 兼容接口”，在 **服务商预设** 中选择服务商（会自动填入接口地址和推荐模型），填入 API Key，点 **测试当前服务** 确认可用。

- **DeepSeek**：预设 DeepSeek，模型 `deepseek-chat`。
- **本地 Ollama**：预设 Ollama，API Key 留空。如果测试时返回 403，设置环境变量 `OLLAMA_ORIGINS=*` 后重启 Ollama。
- **推理模型**（o 系列、GPT-5、DeepSeek-R1 等）：Temperature 请留空；输出中的 `<think>` 思考内容会被自动去掉，但速度会明显慢于普通模型，网页翻译更推荐非推理的小模型。

## 项目结构

```
manifest.json        扩展清单（MV3，同时兼容 Chrome 与 Firefox）
src/defaults.js      默认设置、语言列表、服务预设（各处共享）
src/background.js    翻译服务适配、批量解析、并发限制、重试、缓存、右键菜单、快捷键
src/content.js       段落识别、懒加载翻译、译文渲染、悬停/划词/输入框翻译、悬浮球
src/content.css      译文与样式
src/popup.*          工具栏弹窗
src/options.*        设置页
scripts/gen-icons.ts 生成图标（bun scripts/gen-icons.ts）
```

## 尚未实现

PDF / EPUB 文档翻译、视频字幕翻译、移动端。欢迎 PR。

## 许可证

[GPL-3.0](LICENSE)
