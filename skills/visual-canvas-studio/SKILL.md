---
name: visual-canvas-studio
description: 在 Antigravity 中提供 15 种视觉与文档格式的纯净预览与按需可视化编辑（支持平面图离线自动拆层、前景/底图独立换色、零越界框选抠图、多页 PDF 原位改字与中文矢量写回、Markdown 图文内嵌图微调、HTML/SVG 鼠标直编及 .canvas.json 分层主图）。
---

# Visual Canvas Studio（纯净预览 / 智能拆层 / PDF 直编）

本插件原生接管 `.png`/`.jpg`/`.jpeg`/`.webp`/`.gif`/`.bmp`/`.ico`/`.avif`/`.svg`/`.pdf`/`.html`/`.htm`/`.md`/`.markdown`/`.canvas.json`，默认以纯净预览方式打开；操作者点击右上角 `⋮` →「可视化画布编辑」即可原地进入微调。

## 工具说明

1. **`open_visual_editor({ filePath, workspaceDir })`**：
   - 仅在用户明确要求「在侧栏打开编辑器/微调」，或刚创建了 `.canvas.json` 分层设计时主动调用。
2. **`create_ecommerce_design({ filePath, width, height, background, layers })`**：
   - 生成全元素独立分层的 `.canvas.json` 电商主图/海报，供操作者拖拽、居中吸附、摆正 `0°`、改字并导出 1×/2×/3× 高清图。
3. **`read_design_state({ filePath })`**：
   - 操作者手动微调保存或点击「同步」后，读取最新元素坐标、角度、文案或导出图路径，无损衔接后续迭代。
4. **`list_visual_files({ directory })`**：
   - 列出指定目录内的视觉与文档文件。
