# Visual Canvas Studio

专为 **Google Antigravity 2.0** 打造的极简、零干扰侧栏交互式可视化微调插件（MCP App）。

遵循**零干扰原则**：不接管常规图片、PDF、Markdown、HTML 的默认打开方式，100% 保留 Antigravity 原生预览、超大文件直开与原生圈选评论；仅专属接管 `.canvas.json` 分层设计文件。当你需要动手微调时，从右侧栏 **`+` → 插件 → 可视化画布编辑**（或对 AI 说「在侧栏打开这张图/这份 PDF 给我微调」）即可按需进入交互式画布，直接拆层、拖拽、摆正、换色、原位改字并写回源文件。

## 核心特性

- **零干扰原生共存 + 会话级自动关联**
  - 日常点击 `.png` / `.jpg` / `.pdf` / `.md` / `.html` 等通用格式完全交还 Antigravity 原生查看器（零 10 MiB 限制、保留原生圈选评论）。
  - 打开插件侧栏时自动识别**当前对话会话**刚生成或引用的图片、PDF、HTML、SVG 与 `.canvas.json`，顶部会话条一键切换，不再串台到旧会话文件。
  - 专属接管 `.canvas.json` / `.vcs.json` 分层设计文件，点击直开画布。
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

- **按需微调当前会话文件**：需要拆层/换色/改 PDF 时，从右侧栏 **`+` → 插件 → 可视化画布编辑** 或左侧边栏打开（自动加载本会话最新图/PDF），或直接对 AI 说「在侧栏打开这张图给我微调」。
- **分层设计文件**：点击工作区中的 `.canvas.json` 直接进入画布编辑。

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
