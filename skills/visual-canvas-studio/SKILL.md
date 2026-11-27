---
name: visual-canvas-studio
description: 零干扰按需侧栏可视化编辑插件：保留 Antigravity 原生图片/PDF/Markdown 预览与圈选评论，需要微调时从侧栏或对话按需打开平面图离线智能拆层、前景/底图独立换色、零越界框选抠图、多页 PDF 原位改字与中文矢量写回、HTML/SVG 鼠标直编及 .canvas.json 分层画布。
---

# Visual Canvas Studio（按需侧栏微调 / 智能拆层 / PDF 直编）

本插件遵循**零干扰原则**：仅专属接管 `.canvas.json` / `.vcs.json` 分层画布，不拦截常规图片、PDF、Markdown、HTML 的原生预览与原生圈选评论；操作者需要微调时，通过右侧栏 `+ → 可视化画布编辑`、左侧边栏或直接让 AI 调用 `open_visual_editor` 按需打开当前会话文件。

## 工具说明

1. **`open_visual_editor({ filePath, workspaceDir })`**：
   - 仅在用户明确要求「在侧栏打开编辑器/微调」，或刚创建了 `.canvas.json` 分层设计时主动调用。
2. **`create_ecommerce_design({ filePath, width, height, background, layers })`**：
   - 生成全元素独立分层的 `.canvas.json` 电商主图/海报，供操作者拖拽、居中吸附、摆正 `0°`、改字并导出 1×/2×/3× 高清图。
3. **`read_design_state({ filePath })`**：
   - 操作者手动微调保存或点击「同步」后，读取最新元素坐标、角度、文案或导出图路径，无损衔接后续迭代。
4. **`list_visual_files({ directory })`**：
   - 列出指定目录内的视觉与文档文件。
