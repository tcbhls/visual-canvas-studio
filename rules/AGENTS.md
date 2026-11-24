# Visual Canvas Studio 可视化预览与按需编辑规范

本机已启用 `Visual Canvas Studio` 插件（原生接管 `.png`/`.jpg`/`.jpeg`/`.webp`/`.gif`/`.bmp`/`.ico`/`.avif`/`.svg`/`.pdf`/`.html`/`.htm`/`.md`/`.markdown`/`.canvas.json`）：

1. **纯净预览优先，不强行弹重型编辑面板**：
   - 日常生成图片、Logo、PDF 或展示文档时，直接交付清晰的可点击文件链接（如 `[option-a.jpg](file:///...)`、`[report.pdf](file:///...)`、`[showcase.md](file:///...)`）。操作者正常点击即可在标签页中**纯净预览**，需要微调时点击右上角 **`⋮` → 「可视化画布编辑」** 即可原地切入编辑模式。
   - **仅在**操作者明确要求「在侧栏打开编辑器/直接微调」，或你刚刚用 `create_ecommerce_design` 生成了 `.canvas.json` 分层主图时，才主动调用 `mcp_visual-canvas-studio_vcs_open_visual_editor({ filePath })`。
2. **多图对比文档同步提供单图直链**：
   - 若你制作了含多张候选图的展示文档（如 `logo_options.md`），除文档链接外，顺手附带每张独立原图（`.png`/`.jpg`）的可点击 `file://` 链接；且尽量在工作区保存一份 `.md` 或原图，方便操作者无论点文档还是点单图都能直接预览并在 `⋮` 菜单中一键进入「可视化画布编辑」。
3. **支持前景元素与背景底图独立换色、拆层微调与 PDF 矢量直编**：
   - 任意平面生成图切入编辑模式后均支持自动识别元素、点击提层、框选抠元素、背景无痕修补，以及**前景元素与背景底图独立换色**。
   - 操作者微调保存或点击「同步AI」后，用 `read_design_state` 读取最新状态继续迭代，不覆盖手动调整成果。
