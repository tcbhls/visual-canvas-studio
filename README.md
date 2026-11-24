# Visual Canvas Studio

专为 **Google Antigravity 2.0** 打造的极简原生文件预览与交互式可视化微调插件（MCP App）。

点击对话气泡或工作区文件树中的任意图片、PDF、Markdown 图文文档、HTML 海报、SVG 或分层画布时，默认呈现干净无打扰的**纯净预览**；需要微调时，点击右上角 **`⋮` →「可视化画布编辑」** 即可原地切入交互式画布，用鼠标直接拆层、拖拽、摆正、换色、改字并写回源文件。

## 核心特性

- **15 种文件格式原生接管（`MCP_APP_ENTRYPOINT_TYPE_FILE`）**
  - 图片：`.png` / `.jpg` / `.jpeg` / `.webp` / `.gif` / `.bmp` / `.ico` / `.avif`
  - 矢量与网页：`.svg` / `.html` / `.htm`
  - 文档：`.pdf` / `.md` / `.markdown`
  - 分层设计工程：`.canvas.json`
- **纯净预览优先 + 按需原地编辑**
  - 默认以极简无打扰方式浏览文件（大图缩放、PDF 翻页阅读、GFM Markdown 含提示框与本地内嵌图渲染、HTML 成品渲染）。
  - 点击预览页右上角 **`⋮` →「可视化画布编辑」** 即可原地切入完整编辑模式，随时点左上角 **`← 返回预览`** 切回。
- **平面图离线智能拆层 & 换色（零云端依赖）**
  - 自动识别 AI 生成平面图 / Logo / 海报中的独立元素（`< 50ms` 离线运行），支持**一键全图拆层**与**点选提层**，附带抗锯齿去杂色抠图与无痕背景修补。
  - **严格零越界框选抠图**：仅处理框内区域，选区外 1 像素不改动；支持 `Ctrl+Z` / `Ctrl+Y` 像素级精确回滚。
  - **前景与背景底图独立换色**：无论是抠出的独立元素还是底层背景图，均支持无损换色（黑底可直接精准换纯白或任意色）。
- **多页 PDF 原位改字与矢量中文写回**
  - 基于 MuPDF (WASM) 2× 高清渲染与逐字排版解析：单击原文字无损查看真实字号/字体，双击才进入原位改字，未改动自动还原原貌。
  - 支持双击空白处快速填表、白色遮盖框、插入本地图片/签名，保存时自动执行真实文本擦除与中文字体子集嵌入矢量写回。
- **HTML / SVG 鼠标直编 & Markdown 内嵌图联动**
  - Shadow DOM 隔离渲染 HTML/SVG，支持鼠标拖拽居中吸附、8 点缩放、旋转摆正 `0°`、双击改字并保留原始相对路径写回源码。
  - 打开含多张本地图片的 `.md` 文档时，可直接从 `⋮` 菜单或悬停图片按钮切入微调其中任意一张原图，保存后返回预览立即刷新。
- **极简单色 UI & 会话级文件隔离**
  - 单行顶栏 + 画布悬浮毛玻璃胶囊 + Figma 风格属性栏，自动同步 Antigravity 浅色/深色主题。
  - 严格隔离各对话会话的上下文文件，支持一键在系统文件管理器中定位打开文件所在位置。

## 安装与使用

### 1. 克隆到 Antigravity 插件目录

```bash
# macOS / Linux
git clone https://github.com/tcbhls/visual-canvas-studio.git ~/.gemini/config/plugins/visual-canvas-studio

# Windows (PowerShell)
git clone https://github.com/tcbhls/visual-canvas-studio.git "$env:USERPROFILE\.gemini\config\plugins\visual-canvas-studio"
```

### 2. 安装依赖并构建单文件 MCP App UI

```bash
cd ~/.gemini/config/plugins/visual-canvas-studio
npm install
npm run build:ui
```

> 若 Windows 上 `npm install` 跳过了 `esbuild` 二进制安装，运行一次 `node node_modules/esbuild/install.js` 后再执行 `npm run build:ui`。

### 3. 启用

Antigravity 会自动发现 `~/.gemini/config/plugins/visual-canvas-studio/`。在 **Customizations → Installed** 中确认 **Visual Canvas Studio** 已启用（若之前已运行旧版本，点 MCP 菜单中的 **Restart** 热重载即可）。

- **日常浏览与微调**：直接点击对话或文件树中的图片、PDF、Markdown、HTML、SVG 或 `.canvas.json` → 纯净预览 → 点右上角 **`⋮` → 可视化画布编辑**。
- **独立侧栏入口**：也可随时从右侧栏 **`+` → 插件 → 可视化画布编辑** 或左侧边栏打开。

## 常用快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl + S` / `Cmd + S` | 保存回源文件（本地落盘自动留 `.vcs.bak` 备份） |
| `Ctrl + Z` / `Ctrl + Y` | 撤销 / 重做（含底图像素级回滚） |
| `Ctrl + D` / `Delete` | 复制 / 删除选中元素 |
| `方向键` / `Shift + 方向键` | 1px / 10px 精调元素位置 |
| `Ctrl + 滚轮` | 缩放画布或预览图 |
| `←` / `→` | PDF 纯净预览模式下翻页 |

## 项目结构

```text
visual-canvas-studio/
├── plugin.json                  # Antigravity 插件清单
├── mcp_config.json              # MCP Server 配置 (visual-canvas-studio_vcs)
├── hooks.json                   # 生命周期钩子配置
├── assets/logo.svg              # 插件图标
├── server/
│   ├── index.mjs                # MCP App Server（15 个工具 + file/aux_pane/global 入口）
│   ├── conv-context.mjs         # 会话级视觉文件隔离与上下文扫描
│   └── pdf-engine.mjs           # MuPDF 渲染/文字提取 + pdf-lib 中文矢量写回
├── ui/
│   ├── index.html               # 极简单色预览与编辑双视图模板
│   ├── styles.css               # 原生浅/暗主题设计系统与悬浮胶囊样式
│   ├── app.js                   # MCP App 宿主桥接、纯净预览与主控逻辑
│   ├── canvas-engine.js         # Fabric.js v7 分层画布 / 平面拆层 / PDF 编排引擎
│   ├── image-segmenter.js       # 离线平面图元素识别、去杂色抠图、修补与换色引擎
│   ├── dom-engine.js            # HTML / SVG Shadow DOM 鼠标直编引擎
│   └── markdown-renderer.js     # 零依赖 GFM Markdown 渲染器
├── scripts/build-ui.mjs         # esbuild 单文件 MCP App 打包脚本
├── hooks/auto-open-visual.mjs   # Stop 钩子
├── rules/AGENTS.md              # 插件行为规范
└── skills/visual-canvas-studio/ # 配套 Agent Skill
```

## License

[MIT](./LICENSE)
