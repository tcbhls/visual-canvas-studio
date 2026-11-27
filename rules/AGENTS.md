# Visual Canvas Studio 插件使用规范

本机已安装 `Visual Canvas Studio` 插件。请严格遵守以下克制原则，**不要改变任何对话原有的文件交付与展示方式**：

1. **零侵入普通对话输出**：不要为了配合本插件而强行改写回复结构，不要把多图文档拆成一大串「单图直链 / 分屏直链」刷屏，也不要在回复末尾附加插件操作提示或引导话术。
2. **不主动弹窗打扰**：仅在操作者明确要求「在侧栏打开可视化编辑器 / 直接微调」，或主动调用 `create_ecommerce_design` 生成 `.canvas.json` 时，才调用 `mcp_visual-canvas-studio_vcs_open_visual_editor`。
3. **同步最新手动改动**：若操作者在可视化编辑器中微调保存并点击「同步 AI」，使用 `read_design_state` 读取最新状态继续迭代，不覆盖手动调整成果。
