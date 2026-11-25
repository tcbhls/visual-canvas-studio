/**
 * Visual Canvas Studio — Antigravity MCP App 前端主控入口
 * 负责连接 @modelcontextprotocol/ext-apps 宿主协议、自动同步暗/亮主题、
 * 调度 FabricCanvasEngine (.canvas.json / 图片) 与 DomVisualEngine (.html / .svg)、
 * 处理文件浏览、保存回磁盘、2x PNG/JPG 导出及“同步给 AI”回传。
 */
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FabricCanvasEngine } from './canvas-engine.js';
import { DomVisualEngine } from './dom-engine.js';
import { renderMarkdownToHtml } from './markdown-renderer.js';

const ANY_RESULT_SCHEMA = z.object({}).passthrough();

function base64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function guessImageMime(name = '') {
  const l = name.toLowerCase();
  if (l.endsWith('.jpg') || l.endsWith('.jpeg')) return 'image/jpeg';
  if (l.endsWith('.webp')) return 'image/webp';
  if (l.endsWith('.gif')) return 'image/gif';
  if (l.endsWith('.bmp')) return 'image/bmp';
  if (l.endsWith('.ico')) return 'image/x-icon';
  if (l.endsWith('.avif')) return 'image/avif';
  if (l.endsWith('.svg')) return 'image/svg+xml';
  return 'image/png';
}

function inlineHtmlAssets(markup, assetMap = {}) {
  let out = String(markup || '');
  for (const [rawRef, dataUrl] of Object.entries(assetMap || {})) {
    if (!rawRef || !dataUrl) continue;
    out = out.split(rawRef).join(dataUrl);
  }
  return out;
}

const $ = (id) => document.getElementById(id);

const els = {
  appShell: $('app'),
  previewShell: $('preview-shell'),
  previewTitle: $('preview-title'),
  previewMeta: $('preview-meta'),
  previewMoreWrap: $('preview-more-wrap'),
  btnPreviewMore: $('btn-preview-more'),
  previewMenu: $('preview-menu'),
  menuEnterEdit: $('menu-enter-edit'),
  menuEditSub: $('menu-edit-sub'),
  menuMdImages: $('menu-md-images'),
  menuViewSource: $('menu-view-source'),
  menuCopyContent: $('menu-copy-content'),
  menuCopyPath: $('menu-copy-path'),
  menuExportImg: $('menu-export-img'),
  menuRevealFile: $('menu-reveal-file'),
  previewBody: $('preview-body'),
  previewImageView: $('preview-image-view'),
  previewImgCanvas: $('preview-img-canvas'),
  previewImgEl: $('preview-img-el'),
  btnPimgOut: $('btn-pimg-out'),
  btnPimgFit: $('btn-pimg-fit'),
  btnPimgIn: $('btn-pimg-in'),
  lblPimgDim: $('lbl-pimg-dim'),
  previewPdfView: $('preview-pdf-view'),
  previewPdfScroll: $('preview-pdf-scroll'),
  previewPdfImg: $('preview-pdf-img'),
  btnPpdfPrev: $('btn-ppdf-prev'),
  inpPpdfPage: $('inp-ppdf-page'),
  lblPpdfTotal: $('lbl-ppdf-total'),
  btnPpdfNext: $('btn-ppdf-next'),
  btnPpdfOut: $('btn-ppdf-out'),
  btnPpdfFit: $('btn-ppdf-fit'),
  btnPpdfIn: $('btn-ppdf-in'),
  previewMdView: $('preview-md-view'),
  previewMdArticle: $('preview-md-article'),
  previewHtmlView: $('preview-html-view'),
  previewHtmlHost: $('preview-html-host'),
  sourceShell: $('source-shell'),
  btnSourceBack: $('btn-source-back'),
  sourceFileName: $('source-file-name'),
  sourceDirtyDot: $('source-dirty-dot'),
  btnSourceSave: $('btn-source-save'),
  sourceTextarea: $('source-textarea'),
  btnBackPreview: $('btn-back-preview'),
  mdImgStrip: $('md-img-strip'),
  mdImgChips: $('md-img-chips'),
  fileName: $('file-name'),
  dirtyDot: $('dirty-dot'),
  modePill: $('mode-pill'),
  btnFilesTab: $('btn-files-tab'),
  btnRevealFile: $('btn-reveal-file'),
  btnPropsRevealFile: $('btn-props-reveal-file'),
  btnPropsRevealExport: $('btn-props-reveal-export'),
  btnRevealDir: $('btn-reveal-dir'),
  btnUndo: $('btn-undo'),
  btnRedo: $('btn-redo'),
  btnZoomOut: $('btn-zoom-out'),
  btnZoomFit: $('btn-zoom-fit'),
  btnZoomIn: $('btn-zoom-in'),
  btnSave: $('btn-save'),
  btnExport: $('btn-export'),
  btnSyncAi: $('btn-sync-ai'),
  btnToggleInspector: $('btn-toggle-inspector'),
  convBar: $('conv-bar'),
  convChips: $('conv-chips'),
  btnConvRefresh: $('btn-conv-refresh'),
  imgBar: $('img-bar'),
  btnImgSplitAll: $('btn-img-split-all'),
  lblImgElCount: $('lbl-img-el-count'),
  btnImgPick: $('btn-img-pick'),
  btnImgBox: $('btn-img-box'),
  selImgSegMode: $('sel-img-seg-mode'),
  btnImgBgLock: $('btn-img-bg-lock'),
  btnImgSaveCanvas: $('btn-img-save-canvas'),
  pdfBar: $('pdf-bar'),
  btnPdfPrev: $('btn-pdf-prev'),
  btnPdfNext: $('btn-pdf-next'),
  inpPdfPage: $('inp-pdf-page'),
  lblPdfTotal: $('lbl-pdf-total'),
  btnPdfPickText: $('btn-pdf-pick-text'),
  btnPdfAddText: $('btn-pdf-add-text'),
  btnPdfAddMask: $('btn-pdf-add-mask'),
  btnPdfAddImg: $('btn-pdf-add-img'),
  btnPdfSaveAs: $('btn-pdf-save-as'),
  btnPdfEditLine: $('btn-pdf-edit-line'),
  btnPdfRevertLine: $('btn-pdf-revert-line'),
  inpWelcomePath: $('inp-welcome-path'),
  btnWelcomeOpen: $('btn-welcome-open'),
  quickBar: $('quick-bar'),
  quickAngle: $('quick-angle'),
  domBreadcrumb: $('dom-breadcrumb'),
  toolRail: $('tool-rail'),
  stageViewport: $('stage-viewport'),
  welcomeView: $('welcome-view'),
  welcomeFileList: $('welcome-file-list'),
  fabricStageWrap: $('fabric-stage-wrap'),
  fabricArtboardFrame: $('fabric-artboard-frame'),
  fabricCanvas: $('fabric-canvas'),
  domStageWrap: $('dom-stage-wrap'),
  domArtboardFrame: $('dom-artboard-frame'),
  domHost: $('dom-host'),
  domOverlay: $('dom-overlay'),
  domHoverBox: $('dom-hover-box'),
  domHoverTag: $('dom-hover-tag'),
  domSelectBox: $('dom-select-box'),
  domGuideV: $('dom-guide-v'),
  domGuideH: $('dom-guide-h'),
  liveHud: $('live-hud'),
  inspectorPanel: $('inspector-panel'),
  propsCanvasSection: $('props-canvas-section'),
  propsElementSection: $('props-element-section'),
  selNameLabel: $('sel-name-label'),
  btnSelLock: $('btn-sel-lock'),
  inpCanvasW: $('inp-canvas-w'),
  inpCanvasH: $('inp-canvas-h'),
  inpCanvasBg: $('inp-canvas-bg'),
  canvasBgRow: $('canvas-bg-row'),
  inpExportFormat: $('inp-export-format'),
  inpExportScale: $('inp-export-scale'),
  inpX: $('inp-x'),
  inpY: $('inp-y'),
  inpW: $('inp-w'),
  inpH: $('inp-h'),
  inpAngleRange: $('inp-angle-range'),
  inpAngleNum: $('inp-angle-num'),
  inpOpacity: $('inp-opacity'),
  lblOpacity: $('lbl-opacity'),
  propsTextGroup: $('props-text-group'),
  inpText: $('inp-text'),
  inpFontFamily: $('inp-font-family'),
  inpFontSize: $('inp-font-size'),
  inpFontWeight: $('inp-font-weight'),
  inpFill: $('inp-fill'),
  lblFill: $('lbl-fill'),
  wrapBg: $('wrap-bg'),
  inpBg: $('inp-bg'),
  inpStroke: $('inp-stroke'),
  inpStrokeW: $('inp-stroke-w'),
  inpRadius: $('inp-radius'),
  inpShadow: $('inp-shadow'),
  layerCount: $('layer-count'),
  layerList: $('layer-list'),
  btnDirUp: $('btn-dir-up'),
  inpDirPath: $('inp-dir-path'),
  btnDirGo: $('btn-dir-go'),
  btnNewDesign: $('btn-new-design'),
  btnRefreshFiles: $('btn-refresh-files'),
  insertImageBanner: $('insert-image-banner'),
  btnCancelInsert: $('btn-cancel-insert'),
  filesList: $('files-list'),
  toast: $('toast'),
  toastMsg: $('toast-msg'),
  toastAction: $('toast-action'),
};

const state = {
  connected: false,
  hostCaps: {},
  hostCanWrite: false,
  hostFile: null, // Antigravity 原生 file 接管入口传来的 { name, resourceUri }
  loadedHostUri: '',
  matchedDiskPath: '',
  openedViaHostFile: false,
  viewMode: 'edit', // 'preview' | 'edit' | 'source'
  sourceDirty: false,
  mdParentContext: null, // 从 Markdown 预览进入微调其中某张内嵌图片时，记录父文档上下文以便一键返回
  preview: {
    mode: 'none',
    fileName: '',
    dataUrl: '',
    text: '',
    assetMap: {},
    images: [],
    pdfData: null,
    pdfZoom: 1,
    imgZoom: 1,
    imgNatW: 0,
    imgNatH: 0,
    canvasDoc: null,
    editorInitialized: false,
  },
  mode: 'none', // 'none' | 'canvas' | 'image' | 'pdf' | 'html' | 'svg' | 'markdown'
  filePath: '',
  fileName: '',
  workspaceDir: '',
  parentDir: '',
  dirty: false,
  lastExportPath: '',
  insertImageMode: false,
  convFiles: [],
  browseData: { dir: '', parentDir: '', folders: [], files: [], recentFiles: [], convFiles: [] },
  pdf: {
    pageCount: 0,
    pageIndex: 0,
    pickText: true,
    pageEdits: {},
  },
};

let toastTimer = null;
let toastActionHandler = null;
function showToast(msg, duration = 2400, action = null) {
  els.toastMsg.textContent = msg;
  if (action && action.label && action.onClick) {
    els.toastAction.textContent = action.label;
    els.toastAction.classList.remove('hidden');
    toastActionHandler = action.onClick;
  } else {
    els.toastAction.classList.add('hidden');
    toastActionHandler = null;
  }
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), duration);
}

els.toastAction.addEventListener('click', () => {
  if (toastActionHandler) toastActionHandler();
  els.toast.classList.add('hidden');
});

async function revealInExplorer(targetPath, openDirectory = false) {
  if (!targetPath) {
    showToast('当前没有可定位的路径');
    return;
  }
  try {
    await callServer('app_reveal_path', { targetPath, openDirectory });
    showToast('已在文件管理器中打开所在位置', 1800);
  } catch (err) {
    showToast(`打开位置失败: ${err.message}`, 3200);
  }
}

function getRevealTargetPath() {
  if (state.hostFile) return state.matchedDiskPath || '';
  return state.filePath || '';
}

function updateRevealButtons() {
  const hasRevealPath = Boolean(getRevealTargetPath());
  els.btnRevealFile.disabled = !hasRevealPath;
  els.btnPropsRevealFile.disabled = !hasRevealPath;
  els.btnPropsRevealExport.classList.toggle('hidden', !state.lastExportPath);
}

function showHud(text, clientX, clientY, snapped = false) {
  els.liveHud.textContent = text;
  els.liveHud.classList.toggle('snapped', Boolean(snapped));
  if (typeof clientX === 'number' && typeof clientY === 'number') {
    els.liveHud.style.left = `${Math.min(clientX + 16, window.innerWidth - 180)}px`;
    els.liveHud.style.top = `${Math.max(clientY - 34, 48)}px`;
  }
  els.liveHud.classList.remove('hidden');
}

function hideHud() {
  els.liveHud.classList.add('hidden');
}

function setDirty(flag) {
  state.dirty = flag;
  els.dirtyDot.classList.toggle('hidden', !flag);
}

function getActiveEngine() {
  if (state.mode === 'canvas' || state.mode === 'image' || state.mode === 'pdf') return fabricEngine;
  if (state.mode === 'html' || state.mode === 'svg') return domEngine;
  return null;
}

function updateZoomLabel(z) {
  els.btnZoomFit.textContent = `${Math.round(z * 100)}%`;
}

// ---------- 初始化双引擎 ----------
const sharedCallbacks = {
  onHud: showHud,
  onHudHide: hideHud,
  onToast: (msg) => showToast(msg, 2600),
  onRasterStatus: (st) => updateImgBarUi(st),
  onChange: () => setDirty(true),
  onHistoryChange: (canUndo, canRedo) => {
    els.btnUndo.disabled = !canUndo;
    els.btnRedo.disabled = !canRedo;
  },
  onSelectionChange: (props) => renderPropsPanel(props),
  onLayersChange: (layers) => renderLayersPanel(layers),
  onBreadcrumbChange: (chain) => renderBreadcrumb(chain),
  onFocusTextProp: () => {
    switchTab('props');
    openInspector();
    setTimeout(() => els.inpText.focus(), 40);
  },
};

const fabricEngine = new FabricCanvasEngine(
  els.fabricCanvas,
  els.fabricArtboardFrame,
  sharedCallbacks,
);

const domEngine = new DomVisualEngine(
  {
    frameEl: els.domArtboardFrame,
    hostEl: els.domHost,
    overlayEl: els.domOverlay,
    hoverBox: els.domHoverBox,
    hoverTag: els.domHoverTag,
    selectBox: els.domSelectBox,
    guideV: els.domGuideV,
    guideH: els.domGuideH,
  },
  sharedCallbacks,
);

// ---------- 连接 Antigravity MCP App 宿主 ----------
const app = new App({ name: 'Visual Canvas Studio', version: '1.0.0' }, {});

function applyThemeFromContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.setAttribute('data-theme', ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx['com.google.antigravity/resources'] && typeof ctx['com.google.antigravity/resources'].write === 'boolean') {
    state.hostCanWrite = ctx['com.google.antigravity/resources'].write;
  }
}

app.onhostcontextchanged = (ctx) => {
  applyThemeFromContext(ctx);
};

app.ontoolinput = async ({ arguments: args }) => {
  if (args?.file?.resourceUri) {
    els.fileName.textContent = `加载中: ${args.file.name || '文件'}`;
    if (state.loadedHostUri !== args.file.resourceUri) {
      await openHostFile(args.file);
    }
    return;
  }
  if (args?.filePath) {
    els.fileName.textContent = `加载中: ${args.filePath.split(/[/\\]/).pop()}`;
  }
};

app.ontoolresult = async (result) => {
  const sc = result?.structuredContent;
  if (!sc) return;
  if (Array.isArray(sc.convFiles)) {
    state.convFiles = sc.convFiles;
    renderConvBar();
  }
  if (sc.workspaceDir) {
    state.workspaceDir = sc.workspaceDir;
    els.inpDirPath.value = sc.workspaceDir;
  }
  if (sc.action === 'open_host_file') {
    if (sc.matchedDiskPath) {
      state.matchedDiskPath = sc.matchedDiskPath;
      if (state.mode !== 'pdf' && !state.filePath) {
        state.filePath = sc.matchedDiskPath;
      }
      updateRevealButtons();
      updatePreviewMenuUi();
      // 若之前 Markdown / HTML 在缺少路径时先渲染了一遍，路径到达后补解析相对图片
      if (
        state.viewMode === 'preview' &&
        (state.mode === 'markdown' || state.mode === 'html') &&
        state.preview.text
      ) {
        resolveAndRenderPreviewAssets();
      }
    }
    if (sc.hostFile?.resourceUri && state.loadedHostUri !== sc.hostFile.resourceUri) {
      await openHostFile(sc.hostFile);
    }
    return;
  }
  if (sc.filePath) {
    await openFileFromServer(sc.filePath);
    if (sc.workspaceDir) {
      refreshBrowse(sc.workspaceDir);
    }
  } else {
    await refreshBrowse(sc.workspaceDir || '');
  }
};

async function callServer(name, args = {}) {
  if (!state.connected) {
    throw new Error('MCP 宿主尚未连接');
  }
  const res = await app.callServerTool({ name, arguments: args });
  if (res?.isError) {
    const errText = res.content?.map((c) => c.text).join('\n') || '工具调用失败';
    throw new Error(errText);
  }
  return res?.structuredContent ?? res;
}

// ---------- 纯净预览模式 & 右上角三点菜单（可视化画布编辑入口） ----------
let previewHtmlShadow = null;

function closePreviewMenu() {
  els.previewMenu.classList.add('hidden');
  els.btnPreviewMore.classList.remove('open');
}

function togglePreviewMenu() {
  const isHidden = els.previewMenu.classList.contains('hidden');
  if (isHidden) {
    updatePreviewMenuUi();
    els.previewMenu.classList.remove('hidden');
    els.btnPreviewMore.classList.add('open');
  } else {
    closePreviewMenu();
  }
}

function setViewMode(nextMode) {
  state.viewMode = nextMode;
  closePreviewMenu();
  els.appShell.classList.toggle('is-preview', nextMode === 'preview');
  els.appShell.classList.toggle('is-source', nextMode === 'source');
  els.previewShell.classList.toggle('hidden', nextMode !== 'preview');
  els.sourceShell.classList.toggle('hidden', nextMode !== 'source');

  const canReturnPreview = Boolean(state.mdParentContext || state.openedViaHostFile || state.preview.mode !== 'none');
  els.btnBackPreview.classList.toggle('hidden', nextMode !== 'edit' || !canReturnPreview);
  els.btnBackPreview.textContent = state.mdParentContext ? '← 返回文档预览' : '← 返回预览';
  renderMdImgStrip();
}

function renderMdImgStrip() {
  const ctx = state.mdParentContext;
  if (state.viewMode !== 'edit' || !ctx || !Array.isArray(ctx.images) || !ctx.images.length) {
    els.mdImgStrip.classList.add('hidden');
    return;
  }
  els.mdImgStrip.classList.remove('hidden');
  els.mdImgChips.innerHTML = '';
  const curLower = (state.filePath || '').toLowerCase();
  ctx.images.forEach((img, idx) => {
    const btn = document.createElement('button');
    const active = img.diskPath && img.diskPath.toLowerCase() === curLower;
    btn.className = `conv-chip${active ? ' active' : ''}`;
    btn.title = `${img.alt || img.fileName}\n${img.diskPath || ''}`;
    btn.textContent = img.alt && img.alt !== img.fileName ? `${idx + 1}. ${img.alt}` : img.fileName;
    btn.addEventListener('click', () => {
      if (img.diskPath && img.diskPath.toLowerCase() !== curLower) {
        openFileFromServer(img.diskPath, { keepMdParent: true });
      }
    });
    els.mdImgChips.appendChild(btn);
  });
}

function updatePreviewMenuUi() {
  const m = state.preview.mode || state.mode;
  const imgs = state.preview.images || [];
  const subMap = {
    image: '拆层 · 摆正 · 换色',
    pdf: '原位改字 · 填表 · 遮盖',
    html: '拖拽排版 · 原位改字',
    svg: '矢量拖拽 · 旋转 · 改字',
    canvas: '分层画布 · 高清导出',
    markdown: imgs.length > 0 ? `微调文档内嵌图（${imgs.length} 张）` : '编辑 Markdown 源码',
  };
  els.menuEditSub.textContent = subMap[m] || '进入交互式微调';

  // 若为包含图片的 Markdown 文档，在三点菜单中直接提供每张图的快捷编辑子项
  if (m === 'markdown' && imgs.length > 0) {
    els.menuMdImages.classList.remove('hidden');
    els.menuMdImages.innerHTML = '';
    imgs.slice(0, 8).forEach((img, idx) => {
      const btn = document.createElement('button');
      btn.className = 'preview-menu-subitem';
      btn.title = `直接微调：${img.alt || img.fileName}`;
      const thumb = img.dataUrl ? `<img class="preview-menu-subthumb" src="${img.dataUrl}" alt="" />` : '';
      const label = img.alt || img.fileName;
      btn.innerHTML = `${thumb}<span class="preview-menu-sublabel">${label}</span>`;
      btn.addEventListener('click', () => enterVisualEditFromPreview(idx));
      els.menuMdImages.appendChild(btn);
    });
  } else {
    els.menuMdImages.classList.add('hidden');
    els.menuMdImages.innerHTML = '';
  }

  els.menuViewSource.classList.toggle('hidden', !['markdown', 'html', 'svg', 'canvas'].includes(m));
  els.menuExportImg.classList.toggle('hidden', !['image', 'svg', 'pdf', 'canvas'].includes(m));
  const revPath = getRevealTargetPath();
  els.menuCopyPath.disabled = !revPath;
  els.menuRevealFile.disabled = !revPath;
}

function applyPreviewImageZoom(nextZoom) {
  const z = Math.max(0.1, Math.min(4, Number(nextZoom) || 1));
  state.preview.imgZoom = z;
  const natW = state.preview.imgNatW || els.previewImgEl.naturalWidth || 800;
  els.previewImgEl.style.width = `${Math.round(natW * z)}px`;
  els.previewImgEl.style.maxWidth = 'none';
  els.previewImgEl.classList.toggle('zoomed', z > 1.01);
  els.btnPimgFit.textContent = `${Math.round(z * 100)}%`;
}

function fitPreviewImage() {
  const natW = state.preview.imgNatW || els.previewImgEl.naturalWidth || 0;
  const natH = state.preview.imgNatH || els.previewImgEl.naturalHeight || 0;
  if (!natW || !natH) return;
  const rect = els.previewImageView.getBoundingClientRect();
  const availW = Math.max(200, rect.width - 56);
  const availH = Math.max(200, rect.height - 96);
  const fit = Math.min(availW / natW, availH / natH, 1);
  applyPreviewImageZoom(fit);
}

function getPdfPageImageUrl(pdfData) {
  return pdfData?.bgDataUrl || pdfData?.imageDataUrl || '';
}

function applyPreviewPdfZoom(nextZoom) {
  const z = Math.max(0.35, Math.min(3, Number(nextZoom) || 1));
  state.preview.pdfZoom = z;
  const baseW = state.preview.pdfData?.width || 595;
  els.previewPdfImg.style.width = `${Math.round(baseW * z)}px`;
  els.btnPpdfFit.textContent = `${Math.round(z * 100)}%`;
}

function fitPreviewPdf() {
  const baseW = state.preview.pdfData?.width || 595;
  const rect = els.previewPdfView.getBoundingClientRect();
  if (!rect.width) {
    requestAnimationFrame(() => {
      const r2 = els.previewPdfView.getBoundingClientRect();
      const w2 = Math.max(260, (r2.width || window.innerWidth || 720) - 56);
      applyPreviewPdfZoom(Math.min(w2 / baseW, 1.5));
    });
    return;
  }
  const availW = Math.max(260, rect.width - 56);
  const fit = Math.min(availW / baseW, 1.5);
  applyPreviewPdfZoom(fit);
}

function updatePreviewPdfBar() {
  const { pageCount, pageIndex } = state.pdf;
  els.inpPpdfPage.max = String(Math.max(1, pageCount));
  els.inpPpdfPage.value = String(pageIndex + 1);
  els.lblPpdfTotal.textContent = String(Math.max(1, pageCount));
  els.btnPpdfPrev.disabled = pageIndex <= 0;
  els.btnPpdfNext.disabled = pageIndex >= pageCount - 1;
  els.previewMeta.textContent = `第 ${pageIndex + 1} / ${Math.max(1, pageCount)} 页`;
}

async function previewGoToPdfPage(targetIdx) {
  if (!state.filePath) return;
  const nextIdx = Math.max(0, Math.min(Number(targetIdx) || 0, Math.max(0, state.pdf.pageCount - 1)));
  if (nextIdx === state.pdf.pageIndex && getPdfPageImageUrl(state.preview.pdfData)) {
    updatePreviewPdfBar();
    return;
  }
  try {
    const pageData = await callServer('app_pdf_page', {
      filePath: state.filePath,
      pageIndex: nextIdx,
      scale: 2,
    });
    const pageImgUrl = getPdfPageImageUrl(pageData);
    if (!pageImgUrl) throw new Error('未返回 PDF 页面预览图像数据');
    state.pdf.pageIndex = pageData.pageIndex;
    state.pdf.pageCount = pageData.pageCount;
    state.preview.pdfData = pageData;
    state.preview.dataUrl = pageImgUrl;
    els.previewPdfImg.onload = () => applyPreviewPdfZoom(state.preview.pdfZoom || 1);
    els.previewPdfImg.src = pageImgUrl;
    updatePreviewPdfBar();
    els.previewPdfView.scrollTop = 0;
  } catch (err) {
    showToast(`翻页失败: ${err.message}`, 3000);
  }
}

function renderPreviewHtmlShadow(markup, assetMap = {}) {
  if (!previewHtmlShadow) {
    previewHtmlShadow = els.previewHtmlHost.attachShadow({ mode: 'open' });
  }
  const inlined = inlineHtmlAssets(markup, assetMap);
  previewHtmlShadow.innerHTML = `<style>:host{display:block;min-height:100%;background:#fff;color:#0f172a;}</style>${inlined}`;
}

function renderMarkdownPreviewContent() {
  const html = renderMarkdownToHtml(
    state.preview.text || '',
    state.preview.assetMap || {},
    state.preview.images || [],
  );
  els.previewMdArticle.innerHTML = html;
  const count = (state.preview.images || []).length;
  els.previewMeta.textContent = count > 0 ? `Markdown · 含 ${count} 张可微调图片` : 'Markdown 文档';
  updatePreviewMenuUi();
}

async function resolveAndRenderPreviewAssets() {
  const m = state.preview.mode;
  if (!['markdown', 'html', 'svg', 'canvas'].includes(m) || !state.preview.text) return;
  try {
    const res = await callServer('app_resolve_assets', {
      mode: m,
      content: state.preview.text,
      fileName: state.preview.fileName,
      basePath: state.matchedDiskPath || state.filePath || '',
    });
    if (res?.resolvedDiskPath && !state.matchedDiskPath) {
      state.matchedDiskPath = res.resolvedDiskPath;
      if (!state.filePath) state.filePath = res.resolvedDiskPath;
      updateRevealButtons();
    }
    state.preview.assetMap = res?.assetMap || {};
    if (m === 'markdown') {
      state.preview.images = res?.images || [];
      renderMarkdownPreviewContent();
    } else if (m === 'html') {
      renderPreviewHtmlShadow(state.preview.text, state.preview.assetMap);
    }
    updatePreviewMenuUi();
  } catch (err) {
    console.warn('[resolveAndRenderPreviewAssets]', err);
  }
}

function showPreviewSurface(mode) {
  els.previewImageView.classList.toggle('hidden', !['image', 'svg', 'canvas'].includes(mode));
  els.previewPdfView.classList.toggle('hidden', mode !== 'pdf');
  els.previewMdView.classList.toggle('hidden', mode !== 'markdown');
  els.previewHtmlView.classList.toggle('hidden', mode !== 'html');
}

function showImageInPreview(dataUrl, dimText = '') {
  showPreviewSurface(state.preview.mode);
  els.previewImgEl.onload = () => {
    state.preview.imgNatW = els.previewImgEl.naturalWidth || 0;
    state.preview.imgNatH = els.previewImgEl.naturalHeight || 0;
    const dim = dimText || (state.preview.imgNatW ? `${state.preview.imgNatW} × ${state.preview.imgNatH}` : '');
    els.lblPimgDim.textContent = dim;
    els.previewMeta.textContent = dim;
    fitPreviewImage();
  };
  els.previewImgEl.src = dataUrl;
}

/**
 * 从纯净预览页点击「⋮ → 可视化画布编辑」原地切入完整编辑模式
 */
async function enterVisualEditFromPreview(targetMdImgIdx = -1) {
  closePreviewMenu();
  const p = state.preview;
  const m = p.mode || state.mode;

  // Markdown 文档：若有内嵌图片，直接进入对应图片的拆层可视化画布（并保留返回文档预览上下文）；纯文本文档则进入源码编辑
  if (m === 'markdown') {
    const imgs = p.images || [];
    if (!imgs.length) {
      openSourceMode();
      return;
    }
    const chosen = imgs[targetMdImgIdx >= 0 && targetMdImgIdx < imgs.length ? targetMdImgIdx : 0];
    if (!chosen?.diskPath) {
      showToast('未能定位该图片的本地路径，无法直接编辑', 3000);
      return;
    }
    state.mdParentContext = {
      hostFile: state.hostFile,
      loadedHostUri: state.loadedHostUri,
      fileName: state.fileName,
      matchedDiskPath: state.matchedDiskPath,
      filePath: state.filePath,
      openedViaHostFile: state.openedViaHostFile,
      content: p.text,
      assetMap: { ...(p.assetMap || {}) },
      images: [...imgs],
      scrollTop: els.previewMdView.scrollTop || 0,
    };
    await openFileFromServer(chosen.diskPath, { keepMdParent: true });
    return;
  }

  // 直接文件（图片 / PDF / HTML / SVG / 画布）：切入编辑视图并按需懒加载对应引擎
  setViewMode('edit');
  els.welcomeView.classList.add('hidden');
  els.fileName.textContent = state.fileName;
  els.fileName.title = getRevealTargetPath() || state.hostFile?.resourceUri || state.fileName;
  const modeLabelMap = {
    canvas: '分层画布',
    image: '智能拆层',
    pdf: 'PDF直编',
    html: 'HTML直编',
    svg: 'SVG直编',
  };
  els.modePill.textContent = modeLabelMap[m] || m;
  els.modePill.classList.remove('hidden');
  els.btnSave.disabled = false;
  els.btnExport.disabled = false;
  els.pdfBar.classList.toggle('hidden', m !== 'pdf');
  els.imgBar.classList.toggle('hidden', m !== 'image');

  try {
    if (m === 'image') {
      els.domStageWrap.classList.add('hidden');
      els.fabricStageWrap.classList.remove('hidden');
      els.toolRail.classList.remove('hidden');
      els.domBreadcrumb.classList.add('hidden');
      if (!p.editorInitialized) {
        const info = await fabricEngine.loadSingleImage(p.dataUrl, p.fileName, p.fileName);
        p.editorInitialized = true;
        const cnt = info?.elementCount || 0;
        showToast(
          cnt > 0
            ? `已自动识别图内 ${cnt} 个元素：点击即可提层拖动、旋转或换色（底图也支持直接换色）`
            : `已进入可视化编辑：点「✂ 框选抠元素」可圈出任意局部独立调整`,
          3400,
        );
      }
      fitCurrentStage();
    } else if (m === 'pdf') {
      els.domStageWrap.classList.add('hidden');
      els.fabricStageWrap.classList.remove('hidden');
      els.toolRail.classList.remove('hidden');
      els.domBreadcrumb.classList.add('hidden');
      updatePdfBarUi();
      if (!p.editorInitialized || fabricEngine.pdfPageIndex !== state.pdf.pageIndex) {
        const pageData = p.pdfData || await callServer('app_pdf_page', {
          filePath: state.filePath,
          pageIndex: state.pdf.pageIndex,
          scale: 2,
        });
        p.pdfData = pageData;
        await fabricEngine.loadPdfPage(pageData, state.pdf.pageEdits[state.pdf.pageIndex] || null);
        fabricEngine.setPdfTextPickEnabled(state.pdf.pickText);
        p.editorInitialized = true;
      }
      fitCurrentStage();
    } else if (m === 'html' || m === 'svg') {
      els.fabricStageWrap.classList.add('hidden');
      els.domStageWrap.classList.remove('hidden');
      els.toolRail.classList.add('hidden');
      if (!p.editorInitialized) {
        domEngine.loadMarkup(m, p.text, p.assetMap || {});
        p.editorInitialized = true;
      }
      fitCurrentStage();
    } else if (m === 'canvas') {
      els.domStageWrap.classList.add('hidden');
      els.fabricStageWrap.classList.remove('hidden');
      els.toolRail.classList.remove('hidden');
      els.domBreadcrumb.classList.add('hidden');
      if (!p.editorInitialized && p.canvasDoc) {
        await fabricEngine.loadDocument(p.canvasDoc, p.assetMap || {});
        p.editorInitialized = true;
      }
      fitCurrentStage();
    }
    syncCanvasInputs();
    updateRevealButtons();
    renderConvBar();
  } catch (err) {
    showToast(`进入编辑模式失败: ${err.message}`, 3600);
  }
}

async function returnToPreviewMode() {
  // 1. 若是从 Markdown 文档内嵌图进入微调的，返回原 Markdown 预览并刷新已保存的图片
  if (state.mdParentContext) {
    const parent = state.mdParentContext;
    state.mdParentContext = null;
    state.hostFile = parent.hostFile;
    state.loadedHostUri = parent.loadedHostUri;
    state.fileName = parent.fileName;
    state.matchedDiskPath = parent.matchedDiskPath;
    state.filePath = parent.filePath;
    state.openedViaHostFile = parent.openedViaHostFile;
    state.mode = 'markdown';
    state.preview = {
      ...state.preview,
      mode: 'markdown',
      fileName: parent.fileName,
      text: parent.content,
      assetMap: parent.assetMap,
      images: parent.images,
      editorInitialized: false,
    };
    els.previewTitle.textContent = parent.fileName;
    showPreviewSurface('markdown');
    renderMarkdownPreviewContent();
    setViewMode('preview');
    // 重新从磁盘刷新文档内嵌图，让刚保存的图片微调结果立即可见
    await resolveAndRenderPreviewAssets();
    els.previewMdView.scrollTop = parent.scrollTop || 0;
    return;
  }

  // 2. 普通文件返回纯净预览：用当前画布/源码最新结果更新预览内容
  const m = state.mode;
  if (m === 'image' || m === 'canvas') {
    const fresh = fabricEngine.exportDataUrl('png', 1);
    if (fresh) {
      state.preview.mode = m;
      state.preview.fileName = state.fileName;
      state.preview.dataUrl = fresh;
      els.previewTitle.textContent = state.fileName;
      showImageInPreview(fresh);
    }
  } else if (m === 'pdf') {
    state.preview.mode = 'pdf';
    state.preview.fileName = state.fileName;
    els.previewTitle.textContent = state.fileName;
    showPreviewSurface('pdf');
    // 若当前页有未保存覆盖层，也直接以当前画布画面作为预览图展示
    const rendered = fabricEngine.exportDataUrl('png', 2);
    const pdfFallbackUrl = getPdfPageImageUrl(state.preview.pdfData);
    if (rendered) {
      els.previewPdfImg.src = rendered;
      state.preview.dataUrl = rendered;
    } else if (pdfFallbackUrl) {
      els.previewPdfImg.src = pdfFallbackUrl;
      state.preview.dataUrl = pdfFallbackUrl;
    }
    updatePreviewPdfBar();
    fitPreviewPdf();
  } else if (m === 'html' || m === 'svg') {
    const latestMarkup = domEngine.serialize();
    state.preview.mode = m;
    state.preview.fileName = state.fileName;
    state.preview.text = latestMarkup;
    els.previewTitle.textContent = state.fileName;
    if (m === 'html') {
      showPreviewSurface('html');
      renderPreviewHtmlShadow(latestMarkup, state.preview.assetMap || {});
    } else {
      const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(latestMarkup)}`;
      showImageInPreview(svgUrl, 'SVG 矢量图');
    }
  }
  setViewMode('preview');
}

function openSourceMode() {
  closePreviewMenu();
  const text = state.preview.text || '';
  els.sourceFileName.textContent = `${state.fileName} (源码)`;
  els.sourceTextarea.value = text;
  state.sourceDirty = false;
  els.sourceDirtyDot.classList.add('hidden');
  setViewMode('source');
  els.sourceTextarea.focus();
}

async function saveSourceFile() {
  const nextText = els.sourceTextarea.value;
  try {
    if (state.hostFile) {
      await app.request(
        {
          method: 'com.google.antigravity/resources/write',
          params: { uri: state.hostFile.resourceUri, text: nextText },
        },
        ANY_RESULT_SCHEMA,
      );
    } else if (state.filePath) {
      await callServer('app_save_file', { filePath: state.filePath, content: nextText });
    } else {
      throw new Error('没有可写回的目标文件路径');
    }
    state.preview.text = nextText;
    state.preview.editorInitialized = false;
    state.sourceDirty = false;
    els.sourceDirtyDot.classList.add('hidden');
    showToast(`已保存源码：${state.fileName}`, 2400);
  } catch (err) {
    showToast(`保存源码失败: ${err.message}`, 3400);
  }
}

// ---------- 核心文件加载 / 保存 / 导出 ----------
/**
 * Antigravity 原生 file entrypoint 接管流程：
 * 正常点击对话/文件树中的任意文件时，默认进入纯净无打扰预览模式；
 * 点击右上角「⋮ → 可视化画布编辑」即可原地切换为完整交互式微调编辑器。
 */
async function openHostFile(hostFile) {
  if (!hostFile?.resourceUri) return;
  state.loadedHostUri = hostFile.resourceUri;
  state.hostFile = hostFile;
  state.openedViaHostFile = true;
  state.mdParentContext = null;
  const fileName = hostFile.name || hostFile.resourceUri.split('/').pop() || '未命名文件';
  const lower = fileName.toLowerCase();

  try {
    els.previewTitle.textContent = fileName;
    els.previewMeta.textContent = '载入中...';
    setViewMode('preview');

    const res = await app.request(
      { method: 'resources/read', params: { uri: hostFile.resourceUri } },
      ReadResourceResultSchema,
    );
    const entry = res?.contents?.[0];
    if (!entry || (!entry.blob && !entry.text)) {
      throw new Error('宿主返回空文件内容（可能超过 10 MiB 限制）');
    }

    let mode = 'image';
    if (lower.endsWith('.pdf')) mode = 'pdf';
    else if (lower.endsWith('.svg')) mode = 'svg';
    else if (lower.endsWith('.canvas.json') || lower.endsWith('.vcs.json')) mode = 'canvas';
    else if (lower.endsWith('.html') || lower.endsWith('.htm')) mode = 'html';
    else if (lower.endsWith('.md') || lower.endsWith('.markdown')) mode = 'markdown';

    state.mode = mode;
    state.fileName = fileName;
    state.filePath = state.matchedDiskPath || '';
    state.lastExportPath = '';
    state.insertImageMode = false;
    els.insertImageBanner.classList.add('hidden');
    els.fileName.textContent = fileName;
    els.fileName.title = state.matchedDiskPath || hostFile.resourceUri;

    state.preview = {
      mode,
      fileName,
      dataUrl: '',
      text: '',
      assetMap: {},
      images: [],
      pdfData: null,
      pdfZoom: 1,
      imgZoom: 1,
      imgNatW: 0,
      imgNatH: 0,
      canvasDoc: null,
      editorInitialized: false,
    };

    if (mode === 'image') {
      const mime = entry.mimeType && entry.mimeType.startsWith('image/')
        ? entry.mimeType
        : guessImageMime(fileName);
      const dataUrl = `data:${mime};base64,${entry.blob}`;
      state.preview.dataUrl = dataUrl;
      showImageInPreview(dataUrl);
    } else if (mode === 'svg') {
      const markup = entry.text || base64ToUtf8(entry.blob);
      state.preview.text = markup;
      const svgUrl = entry.blob
        ? `data:image/svg+xml;base64,${entry.blob}`
        : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
      state.preview.dataUrl = svgUrl;
      showImageInPreview(svgUrl, 'SVG 矢量图');
    } else if (mode === 'pdf') {
      const pdfData = await callServer('app_pdf_open_blob', {
        name: fileName,
        blobBase64: entry.blob,
      });
      const pdfImgUrl = getPdfPageImageUrl(pdfData);
      if (!pdfImgUrl) {
        throw new Error('PDF 渲染结果缺少页面图像数据');
      }
      state.filePath = pdfData.filePath;
      state.pdf = {
        pageCount: pdfData.pageCount || 1,
        pageIndex: pdfData.pageIndex || 0,
        pickText: true,
        pageEdits: {},
      };
      state.preview.pdfData = pdfData;
      state.preview.dataUrl = pdfImgUrl;
      showPreviewSurface('pdf');
      els.previewPdfImg.onload = () => fitPreviewPdf();
      els.previewPdfImg.onerror = () => showToast('PDF 页面预览图加载失败', 3200);
      els.previewPdfImg.src = pdfImgUrl;
      updatePreviewPdfBar();
    } else if (mode === 'markdown') {
      const mdText = entry.text || base64ToUtf8(entry.blob);
      state.preview.text = mdText;
      // 提取首行一级标题作为预览页标题（如「Logo Options」体验）
      const h1 = /^#\s+(.+)$/m.exec(mdText);
      els.previewTitle.textContent = h1 ? h1[1].trim() : fileName;
      showPreviewSurface('markdown');
      renderMarkdownPreviewContent();
      await resolveAndRenderPreviewAssets();
    } else if (mode === 'html') {
      const htmlText = entry.text || base64ToUtf8(entry.blob);
      state.preview.text = htmlText;
      els.previewMeta.textContent = 'HTML 预览';
      showPreviewSurface('html');
      renderPreviewHtmlShadow(htmlText, {});
      await resolveAndRenderPreviewAssets();
    } else if (mode === 'canvas') {
      const rawJson = entry.text || base64ToUtf8(entry.blob);
      const doc = JSON.parse(rawJson);
      state.preview.text = rawJson;
      state.preview.canvasDoc = doc;
      els.previewTitle.textContent = doc.name || fileName;
      await resolveAndRenderPreviewAssets();
      await fabricEngine.loadDocument(doc, state.preview.assetMap || {});
      state.preview.editorInitialized = true;
      const rendered = fabricEngine.exportDataUrl('png', 1);
      state.preview.dataUrl = rendered;
      showImageInPreview(rendered, `${doc.width || 800} × ${doc.height || 800} · 分层画布`);
    }

    updateRevealButtons();
    updatePreviewMenuUi();
    setDirty(false);
  } catch (err) {
    state.loadedHostUri = '';
    els.previewMeta.textContent = '加载失败';
    showToast(`读取文件失败: ${err.message}`, 4000);
  }
}

async function openFileFromServer(filePath, { keepMdParent = false } = {}) {
  try {
    state.hostFile = null;
    state.loadedHostUri = '';
    state.matchedDiskPath = '';
    if (!keepMdParent) {
      state.mdParentContext = null;
      state.openedViaHostFile = false;
    }
    showToast('正在加载文件...', 1200);
    const data = await callServer('app_load_file', { filePath });
    if (!data?.ok) throw new Error('文件加载返回空数据');

    state.filePath = data.filePath;
    state.fileName = data.fileName;
    state.workspaceDir = data.dir;
    state.mode = data.mode;
    state.lastExportPath = data.document?.lastExportPath || '';
    state.insertImageMode = false;
    els.insertImageBanner.classList.add('hidden');
    els.inpDirPath.value = data.dir;

    // Markdown 文件从侧栏文件列表打开时，也默认以纯净文档预览展示（可在 ⋮ 或悬停图片上点编辑）
    if (data.mode === 'markdown') {
      state.preview = {
        mode: 'markdown',
        fileName: data.fileName,
        dataUrl: '',
        text: data.content || '',
        assetMap: data.assetMap || {},
        images: data.images || [],
        pdfData: null,
        pdfZoom: 1,
        imgZoom: 1,
        imgNatW: 0,
        imgNatH: 0,
        canvasDoc: null,
        editorInitialized: false,
      };
      const h1 = /^#\s+(.+)$/m.exec(data.content || '');
      els.previewTitle.textContent = h1 ? h1[1].trim() : data.fileName;
      showPreviewSurface('markdown');
      renderMarkdownPreviewContent();
      setViewMode('preview');
      updateRevealButtons();
      updatePreviewMenuUi();
      setDirty(false);
      return;
    }

    state.preview = {
      mode: data.mode,
      fileName: data.fileName,
      dataUrl: data.dataUrl || '',
      text: data.content || '',
      assetMap: data.assetMap || {},
      images: [],
      pdfData: data.mode === 'pdf' ? data : null,
      pdfZoom: 1,
      imgZoom: 1,
      imgNatW: 0,
      imgNatH: 0,
      canvasDoc: data.document || null,
      editorInitialized: true,
    };
    setViewMode('edit');

    els.fileName.textContent = data.fileName;
    els.fileName.title = data.filePath;
    const modeLabelMap = {
      canvas: '分层画布',
      image: '智能拆层',
      pdf: 'PDF直编',
      html: 'HTML直编',
      svg: 'SVG直编',
    };
    els.modePill.textContent = modeLabelMap[data.mode] || data.mode;
    els.modePill.classList.remove('hidden');
    els.welcomeView.classList.add('hidden');
    els.btnSave.disabled = false;
    els.btnExport.disabled = false;
    els.pdfBar.classList.toggle('hidden', data.mode !== 'pdf');
    els.imgBar.classList.toggle('hidden', data.mode !== 'image');

    let rasterElCount = 0;
    if (data.mode === 'canvas') {
      els.domStageWrap.classList.add('hidden');
      els.fabricStageWrap.classList.remove('hidden');
      els.toolRail.classList.remove('hidden');
      els.domBreadcrumb.classList.add('hidden');
      await fabricEngine.loadDocument(data.document, data.assetMap || {});
      fitCurrentStage();
    } else if (data.mode === 'image') {
      els.domStageWrap.classList.add('hidden');
      els.fabricStageWrap.classList.remove('hidden');
      els.toolRail.classList.remove('hidden');
      els.domBreadcrumb.classList.add('hidden');
      const info = await fabricEngine.loadSingleImage(data.dataUrl, data.fileName, `./${data.fileName}`);
      rasterElCount = info?.elementCount || 0;
      fitCurrentStage();
    } else if (data.mode === 'pdf') {
      els.domStageWrap.classList.add('hidden');
      els.fabricStageWrap.classList.remove('hidden');
      els.toolRail.classList.remove('hidden');
      els.domBreadcrumb.classList.add('hidden');
      state.pdf = {
        pageCount: data.pageCount || 1,
        pageIndex: data.pageIndex || 0,
        pickText: true,
        pageEdits: {},
      };
      updatePdfBarUi();
      await fabricEngine.loadPdfPage(data, null);
      fabricEngine.setPdfTextPickEnabled(true);
      fitCurrentStage();
    } else if (data.mode === 'html' || data.mode === 'svg') {
      els.fabricStageWrap.classList.add('hidden');
      els.domStageWrap.classList.remove('hidden');
      els.toolRail.classList.add('hidden');
      domEngine.loadMarkup(data.mode, data.content, data.assetMap || {});
      fitCurrentStage();
    }

    syncCanvasInputs();
    updateRevealButtons();
    renderConvBar();
    renderFilesPanel();
    setDirty(false);
    showToast(
      data.mode === 'pdf'
        ? `已打开 PDF (${data.pageCount}页)：单击查看原文字不改动格式，双击改字，双击空白填表`
        : data.mode === 'image'
          ? (rasterElCount > 0
              ? `已自动识别图内 ${rasterElCount} 个元素：悬停高亮、点一下直接提层拖动/旋转/换色（底图也可直接换色）`
              : `已打开 ${data.fileName}：可使用「✂ 框选抠元素」圈选图内任意区域独立微调`)
          : `已打开 ${data.fileName}`,
      data.mode === 'pdf' || data.mode === 'image' ? 3600 : 2000,
    );
  } catch (err) {
    showToast(`加载失败: ${err.message}`, 3600);
  }
}

function fitCurrentStage() {
  const engine = getActiveEngine();
  if (!engine) return;
  const rect = els.stageViewport.getBoundingClientRect();
  const z = engine.fitToViewport(Math.max(rect.width - 24, 300), Math.max(rect.height - 96, 260));
  updateZoomLabel(z);
}

function syncCanvasInputs() {
  const engine = getActiveEngine();
  if (!engine) return;
  els.inpCanvasW.value = Math.round(engine.docWidth);
  els.inpCanvasH.value = Math.round(engine.docHeight);
  if (state.mode === 'canvas' || state.mode === 'image') {
    els.canvasBgRow.classList.remove('hidden');
    els.inpCanvasBg.value = fabricEngine.background?.startsWith('#') ? fabricEngine.background : '#ffffff';
  } else {
    els.canvasBgRow.classList.add('hidden');
  }
}

function updateImgBarUi(st) {
  if (!st) return;
  els.lblImgElCount.textContent = st.remaining > 0
    ? `${st.total} 项 · 余 ${st.remaining}`
    : `已拆 ${st.total} 项`;
  els.btnImgPick.textContent = st.pickEnabled ? '点选拆层' : '点选已关';
  els.btnImgPick.classList.toggle('pill-btn-active', Boolean(st.pickEnabled) && !st.boxMode);
  els.btnImgBox.textContent = st.boxMode ? '拖框中' : '框选抠图';
  els.btnImgBox.classList.toggle('pill-btn-active', Boolean(st.boxMode));
  els.btnImgBgLock.textContent = st.bgLocked ? '锁定底图' : '底图可编';
  els.btnImgBgLock.classList.toggle('pill-btn-active', !st.bgLocked);
  els.selImgSegMode.value = st.segMode || 'smart';
}

function updatePdfBarUi() {
  const { pageCount, pageIndex, pickText } = state.pdf;
  els.inpPdfPage.max = String(Math.max(1, pageCount));
  els.inpPdfPage.value = String(pageIndex + 1);
  els.lblPdfTotal.textContent = String(Math.max(1, pageCount));
  els.btnPdfPrev.disabled = pageIndex <= 0;
  els.btnPdfNext.disabled = pageIndex >= pageCount - 1;
  els.btnPdfPickText.textContent = pickText ? '原位改字' : '改字已关';
  els.btnPdfPickText.classList.toggle('pill-btn-active', pickText);
}

function snapshotCurrentPdfPageEdit() {
  if (state.mode !== 'pdf') return;
  const edit = fabricEngine.getPdfPageEdit();
  if ((edit.redactions?.length || 0) > 0 || (edit.layers?.length || 0) > 0) {
    state.pdf.pageEdits[state.pdf.pageIndex] = edit;
  } else {
    delete state.pdf.pageEdits[state.pdf.pageIndex];
  }
}

async function goToPdfPage(targetIdx) {
  if (state.mode !== 'pdf' || !state.filePath) return;
  const nextIdx = Math.max(0, Math.min(Number(targetIdx) || 0, state.pdf.pageCount - 1));
  if (nextIdx === state.pdf.pageIndex) {
    updatePdfBarUi();
    return;
  }
  snapshotCurrentPdfPageEdit();
  try {
    showToast(`正在加载第 ${nextIdx + 1} 页...`, 1200);
    const pageData = await callServer('app_pdf_page', {
      filePath: state.filePath,
      pageIndex: nextIdx,
      scale: 2,
    });
    state.pdf.pageIndex = pageData.pageIndex;
    state.pdf.pageCount = pageData.pageCount;
    state.preview.pdfData = pageData;
    updatePdfBarUi();
    await fabricEngine.loadPdfPage(pageData, state.pdf.pageEdits[nextIdx] || null);
    fabricEngine.setPdfTextPickEnabled(state.pdf.pickText);
    syncCanvasInputs();
    fitCurrentStage();
  } catch (err) {
    showToast(`翻页失败: ${err.message}`, 3200);
  }
}

async function savePdfDocument(saveAsNew = false, silent = false) {
  if (state.mode !== 'pdf' || !state.filePath) return null;
  snapshotCurrentPdfPageEdit();
  const editedKeys = Object.keys(state.pdf.pageEdits);
  if (!editedKeys.length) {
    if (!silent) showToast('当前 PDF 尚无修改内容');
    return null;
  }

  const outputPath = saveAsNew
    ? state.filePath.replace(/\.pdf$/i, '') + '_edited.pdf'
    : state.filePath;

  try {
    if (!silent) showToast('正在矢量写回 PDF...', 2000);
    const useHostWrite = Boolean(state.hostFile && !saveAsNew);
    const res = await callServer('app_save_pdf', {
      filePath: state.filePath,
      outputPath: useHostWrite ? state.filePath : outputPath,
      pageEdits: state.pdf.pageEdits,
      returnBlob: useHostWrite,
    });

    if (useHostWrite && res.blobBase64) {
      await app.request(
        {
          method: 'com.google.antigravity/resources/write',
          params: { uri: state.hostFile.resourceUri, blob: res.blobBase64 },
        },
        ANY_RESULT_SCHEMA,
      );
      state.pdf.pageEdits = {};
      setDirty(false);
      const freshPage = await callServer('app_pdf_page', {
        filePath: state.filePath,
        pageIndex: state.pdf.pageIndex,
        scale: 2,
      });
      state.preview.pdfData = freshPage;
      await fabricEngine.loadPdfPage(freshPage, null);
      fabricEngine.setPdfTextPickEnabled(state.pdf.pickText);
      if (!silent) {
        showToast(`已矢量写回原 PDF: ${state.fileName} (${Math.round((res.bytes || 0) / 1024)} KB)`, 4200);
      }
      return res;
    }

    state.lastExportPath = res.outputPath;
    updateRevealButtons();

    if (!saveAsNew) {
      // 覆盖原 PDF 后清空暂存增量并重渲染当前页，确认真机矢量写回效果
      state.pdf.pageEdits = {};
      setDirty(false);
      const freshPage = await callServer('app_pdf_page', {
        filePath: res.outputPath,
        pageIndex: state.pdf.pageIndex,
        scale: 2,
      });
      await fabricEngine.loadPdfPage(freshPage, null);
      fabricEngine.setPdfTextPickEnabled(state.pdf.pickText);
    }

    if (!silent) {
      showToast(
        `已矢量保存 PDF: ${res.outputPath.split(/[/\\]/).pop()} (${Math.round((res.bytes || 0) / 1024)} KB)`,
        6000,
        {
          label: '打开所在位置',
          onClick: () => revealInExplorer(res.outputPath, false),
        },
      );
    }
    refreshBrowse(state.workspaceDir);
    return res;
  } catch (err) {
    showToast(`保存 PDF 失败: ${err.message}`, 4000);
    return null;
  }
}

async function saveCurrentFile(silent = false) {
  const engine = getActiveEngine();
  if (!engine || (!state.filePath && !state.hostFile)) return null;

  if (state.mode === 'pdf') {
    return savePdfDocument(false, silent);
  }

  try {
    // Antigravity 原生 file 视图接管模式：直接通过宿主官方 API 写回当前打开的本地文件
    if (state.hostFile) {
      if (state.mode === 'image') {
        const lower = state.fileName.toLowerCase();
        const fmt = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'jpeg' : 'png';
        const dataUrl = fabricEngine.exportDataUrl(fmt, 1);
        const b64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
        await app.request(
          {
            method: 'com.google.antigravity/resources/write',
            params: { uri: state.hostFile.resourceUri, blob: b64 },
          },
          ANY_RESULT_SCHEMA,
        );
      } else {
        const text = state.mode === 'canvas'
          ? JSON.stringify(fabricEngine.serialize(), null, 2)
          : domEngine.serialize();
        await app.request(
          {
            method: 'com.google.antigravity/resources/write',
            params: { uri: state.hostFile.resourceUri, text },
          },
          ANY_RESULT_SCHEMA,
        );
      }
      setDirty(false);
      if (!silent) {
        const revPath = getRevealTargetPath();
        showToast(
          `已直接保存回 ${state.fileName}`,
          3600,
          revPath ? { label: '打开所在位置', onClick: () => revealInExplorer(revPath, false) } : null,
        );
      }
      return { ok: true };
    }

    let targetPath = state.filePath;
    let content = '';

    if (state.mode === 'image') {
      // 平面图模式按保存时，直接按原格式写回该图片文件（服务端自动留 .vcs.bak 备份），做到所改即所得
      const lower = state.filePath.toLowerCase();
      const fmt = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'jpeg' : 'png';
      const dataUrl = fabricEngine.exportDataUrl(fmt, 1);
      const res = await callServer('app_export_image', {
        outputPath: state.filePath,
        dataUrl,
      });
      state.lastExportPath = res.outputPath;
      updateRevealButtons();
      setDirty(false);
      if (!silent) {
        showToast(`已保存修改回 ${state.fileName}（原图已备份 .vcs.bak）`, 4200, {
          label: '打开所在位置',
          onClick: () => revealInExplorer(res.outputPath, false),
        });
      }
      return res;
    }

    if (state.mode === 'canvas') {
      content = JSON.stringify(fabricEngine.serialize(), null, 2);
    } else if (state.mode === 'html' || state.mode === 'svg') {
      content = domEngine.serialize();
    }

    const res = await callServer('app_save_file', { filePath: targetPath, content });
    setDirty(false);
    if (!silent) showToast(`已保存至 ${state.fileName}`);
    return res;
  } catch (err) {
    showToast(`保存失败: ${err.message}`, 3600);
    return null;
  }
}

async function exportCurrentImage() {
  const engine = getActiveEngine();
  if (!engine) return;
  try {
    // 导出前先自动保存设计源文件，避免关闭侧栏丢改动
    if (state.dirty && state.filePath) {
      await saveCurrentFile(true);
    }

    const format = els.inpExportFormat.value || 'png';
    const scale = Number(els.inpExportScale.value) || 2;
    const ext = format === 'jpeg' ? 'jpg' : 'png';

    showToast('正在渲染高清成图...', 1500);
    const dataUrl = await engine.exportDataUrl(format, scale);
    if (!dataUrl) throw new Error('无法生成图片数据');

    const diskBasePath = getRevealTargetPath();
    if (!diskBasePath && state.hostFile) {
      // 若宿主未暴露本地绝对路径，直接触发浏览器下载导出图
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `${state.fileName.replace(/\.[^.]+$/, '')}_edited.${ext}`;
      a.click();
      showToast(`已导出下载 ${a.download}`, 3200);
      return;
    }

    const base = diskBasePath
      ? diskBasePath.replace(/\.(canvas\.json|vcs\.json|pdf|html|htm|svg|png|jpe?g|webp)$/i, '')
      : `${state.workspaceDir || '.'}/design_export`;
    const pageSuffix = state.mode === 'pdf' ? `_p${state.pdf.pageIndex + 1}` : '';
    const outputPath = `${base}${pageSuffix}_edited.${ext}`;

    const res = await callServer('app_export_image', {
      outputPath,
      dataUrl,
      sourceCanvasPath: state.mode === 'canvas' ? state.filePath : undefined,
    });
    state.lastExportPath = res.outputPath;
    updateRevealButtons();
    showToast(
      `已导出高清图: ${res.outputPath.split(/[/\\]/).pop()} (${Math.round((res.bytes || 0) / 1024)} KB)`,
      6000,
      {
        label: '打开所在位置',
        onClick: () => revealInExplorer(res.outputPath, false),
      },
    );
    refreshBrowse(state.workspaceDir);
  } catch (err) {
    showToast(`导出失败: ${err.message}`, 3800);
  }
}

async function syncAdjustmentsToAi() {
  if (!state.connected) return;
  try {
    if (state.dirty && state.filePath) {
      await saveCurrentFile(true);
    }

    let summaryLines = [`我刚刚在侧栏可视化画布中手动微调并保存了文件：\`${state.filePath}\``];
    if (state.lastExportPath) {
      summaryLines.push(`最新导出的成品图片：\`${state.lastExportPath}\``);
    }
    if (state.mode === 'canvas') {
      const doc = fabricEngine.serialize();
      summaryLines.push(`画布尺寸：${doc.width}×${doc.height}，当前图层状态：`);
      for (const l of doc.layers) {
        const extra = l.text ? ` 内容="${l.text}"` : '';
        summaryLines.push(`- ${l.name} (${l.type}): 中心(${l.left}, ${l.top}), 尺寸 ${l.width}×${l.height}, 角度 ${l.angle}°${extra}`);
      }
    } else if (state.mode === 'pdf') {
      summaryLines.push(`当前浏览 PDF 第 ${state.pdf.pageIndex + 1}/${state.pdf.pageCount} 页，微调内容已矢量写回 PDF 文件。`);
    } else {
      summaryLines.push(`已将鼠标拖拽、居中对齐与旋转摆正后的结果回写到源 ${state.mode.toUpperCase()} 文件。`);
    }

    const text = summaryLines.join('\n');
    if (state.hostCaps?.message) {
      await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text }],
      });
      showToast('已把最新微调结果同步回对话！', 2600);
    } else if (state.hostCaps?.updateModelContext) {
      await app.updateModelContext({
        content: [{ type: 'text', text }],
      });
      showToast('已附加微调结果到下一条消息上下文！', 2600);
    }
  } catch (err) {
    showToast(`同步失败: ${err.message}`, 3200);
  }
}

async function createBlankDesign(presetSize = '800x800') {
  const [w, h] = presetSize.split('x').map(Number);
  const dir = state.workspaceDir || state.browseData.dir;
  if (!dir) {
    showToast('请先在“文件”标签中输入工作区目录路径', 2800);
    switchTab('files');
    return;
  }
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(4, 14);
  const sep = dir.includes('\\') ? '\\' : '/';
  const cleanDir = dir.replace(/[/\\]+$/, '');
  const filePath = `${cleanDir}${sep}ecommerce_${w}x${h}_${ts}.canvas.json`;

  const doc = {
    format: 'visual-canvas-studio',
    version: 1,
    name: `电商主图_${w}x${h}`,
    width: w,
    height: h,
    background: '#f8fafc',
    backgroundGradient: {
      angle: 135,
      stops: [
        { offset: 0, color: '#fff7ed' },
        { offset: 1, color: '#ffedd5' },
      ],
    },
    layers: [
      {
        id: 'card_bg',
        type: 'rect',
        name: '底图卡片',
        left: w / 2,
        top: Math.round(h * 0.56),
        width: Math.round(w * 0.84),
        height: Math.round(h * 0.66),
        rx: 28,
        bg: '#ffffff',
        shadow: { color: 'rgba(15,23,42,0.12)', blur: 28, offsetX: 0, offsetY: 12 },
      },
      {
        id: 'main_title',
        type: 'text',
        name: '主标题',
        text: '2026 新品爆款首发',
        left: w / 2,
        top: Math.round(h * 0.11),
        width: Math.round(w * 0.84),
        fontSize: Math.round(w * 0.068),
        fontWeight: '800',
        fill: '#0f172a',
        textAlign: 'center',
      },
      {
        id: 'sub_title',
        type: 'text',
        name: '副标题卖点',
        text: '轻奢质感 · 高定剪裁 · 限时顺丰包邮',
        left: w / 2,
        top: Math.round(h * 0.185),
        width: Math.round(w * 0.78),
        fontSize: Math.round(w * 0.028),
        fontWeight: '600',
        fill: '#64748b',
        textAlign: 'center',
      },
      {
        id: 'promo_badge',
        type: 'badge',
        name: '促销贴纸',
        text: '限时 8.5 折',
        left: Math.round(w * 0.78),
        top: Math.round(h * 0.27),
        width: 176,
        height: 52,
        rx: 26,
        angle: -8,
        bg: '#ef4444',
        fill: '#ffffff',
        fontSize: 22,
        fontWeight: '800',
      },
    ],
  };

  await callServer('app_save_file', {
    filePath,
    content: JSON.stringify(doc, null, 2),
  });
  await openFileFromServer(filePath);
  refreshBrowse(dir);
}

// ---------- 文件浏览 ----------
async function refreshBrowse(directory = '') {
  try {
    const data = await callServer('app_browse_files', { directory: directory || undefined });
    state.browseData = data;
    if (Array.isArray(data.convFiles)) {
      state.convFiles = data.convFiles;
    }
    state.workspaceDir = data.dir;
    state.parentDir = data.parentDir || '';
    els.inpDirPath.value = data.dir;
    renderConvBar();
    renderFilesPanel();
    renderWelcomeFiles();
    if (data.openFilePath) {
      await openFileFromServer(data.openFilePath);
    }
  } catch (err) {
    console.warn('[browse] failed:', err);
  }
}

function renderConvBar() {
  const list = state.convFiles || [];
  // 原生单文件标签或 Markdown 文档内嵌图编辑时，隐藏多余的会话切换条，保持画布界面极简清爽
  if (!list.length || state.openedViaHostFile || state.mdParentContext) {
    els.convBar.classList.add('hidden');
    return;
  }
  els.convBar.classList.remove('hidden');
  els.convChips.innerHTML = '';
  const curLower = (state.filePath || '').toLowerCase();

  for (const f of list.slice(0, 12)) {
    const btn = document.createElement('button');
    const isActive = f.path.toLowerCase() === curLower;
    btn.className = `conv-chip${isActive ? ' active' : ''}`;
    btn.title = `${f.name}\n${f.path}`;
    btn.innerHTML = `<span class="conv-chip-name">${f.name}</span>`;
    btn.addEventListener('click', () => {
      if (state.insertImageMode && f.mode === 'image') {
        insertLocalImageToCanvas(f.path, f.name);
      } else {
        openFileFromServer(f.path);
      }
    });
    els.convChips.appendChild(btn);
  }
}

function modeBadgeText(mode) {
  return { canvas: '画布', pdf: 'PDF', html: 'HTML', svg: 'SVG', image: '图片', markdown: 'MD' }[mode] || mode;
}

const SVG_REVEAL_MINI = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9.5 2.5h4v4M13.5 2.5l-6 6M12 9v3.2A1.3 1.3 0 0 1 10.7 13.5H3.8A1.3 1.3 0 0 1 2.5 12.2V5.3A1.3 1.3 0 0 1 3.8 4H7"/></svg>';
const SVG_EYE_ON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="1.8"/></svg>';
const SVG_EYE_OFF = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 2.5l11 11M6.4 4.1A6.6 6.6 0 0 1 8 3.8c3.9 0 6.2 4.2 6.2 4.2a11 11 0 0 1-2.1 2.6M4.2 5.4A11 11 0 0 0 1.8 8s2.3 4.2 6.2 4.2c.9 0 1.7-.2 2.4-.5"/></svg>';

function renderFilesPanel() {
  const { folders = [], files = [], recentFiles = [] } = state.browseData;
  const convFiles = state.convFiles || [];
  els.filesList.innerHTML = '';

  const addSection = (title) => {
    const div = document.createElement('div');
    div.className = 'section-title';
    div.textContent = title;
    els.filesList.appendChild(div);
  };

  // 优先置顶显示「当前对话框」内产出/提及的文件（如刚生成的 Logo、PDF、海报）
  const visibleConv = state.insertImageMode
    ? convFiles.filter((f) => f.mode === 'image')
    : convFiles;
  if (visibleConv.length) {
    addSection(`本会话 (${visibleConv.length})`);
    for (const f of visibleConv) {
      const item = document.createElement('div');
      const isActive = f.path.toLowerCase() === (state.filePath || '').toLowerCase();
      item.className = `file-item${isActive ? ' active' : ''}`;
      item.title = f.path;
      item.innerHTML = `<span class="item-badge">${modeBadgeText(f.mode)}</span><span class="item-title">${f.name}</span><button class="item-icon-btn" data-reveal="1" title="打开文件所在位置">${SVG_REVEAL_MINI}</button>`;
      item.addEventListener('click', async (e) => {
        if (e.target.closest('[data-reveal]')) {
          e.stopPropagation();
          await revealInExplorer(f.path, false);
          return;
        }
        if (state.insertImageMode) {
          await insertLocalImageToCanvas(f.path, f.name);
        } else {
          await openFileFromServer(f.path);
        }
      });
      els.filesList.appendChild(item);
    }
  }

  if (folders.length && !state.insertImageMode) {
    addSection('文件夹');
    for (const f of folders) {
      const item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML = `<span class="item-badge">目录</span><span class="item-title">${f.name}</span>`;
      item.addEventListener('click', () => refreshBrowse(f.path));
      els.filesList.appendChild(item);
    }
  }

  const visibleFiles = state.insertImageMode
    ? files.filter((f) => f.mode === 'image')
    : files;

  addSection(state.insertImageMode ? '选择图片' : `当前目录 (${visibleFiles.length})`);
  if (!visibleFiles.length) {
    const empty = document.createElement('div');
    empty.className = 'hint-text';
    empty.textContent = state.insertImageMode ? '当前目录暂无图片' : '当前目录暂无视觉文件';
    els.filesList.appendChild(empty);
  } else {
    for (const f of visibleFiles) {
      const item = document.createElement('div');
      item.className = `file-item${f.path === state.filePath ? ' active' : ''}`;
      item.title = f.path;
      item.innerHTML = `<span class="item-badge">${modeBadgeText(f.mode)}</span><span class="item-title">${f.name}</span><button class="item-icon-btn" data-reveal="1" title="打开文件所在位置">${SVG_REVEAL_MINI}</button>`;
      item.addEventListener('click', async (e) => {
        if (e.target.closest('[data-reveal]')) {
          e.stopPropagation();
          await revealInExplorer(f.path, false);
          return;
        }
        if (state.insertImageMode) {
          await insertLocalImageToCanvas(f.path, f.name);
        } else {
          await openFileFromServer(f.path);
        }
      });
      els.filesList.appendChild(item);
    }
  }

  if (recentFiles.length && !state.insertImageMode) {
    addSection('最近');
    for (const rf of recentFiles.slice(0, 6)) {
      const name = rf.split(/[/\\]/).pop();
      const item = document.createElement('div');
      item.className = `file-item${rf === state.filePath ? ' active' : ''}`;
      item.title = rf;
      item.innerHTML = `<span class="item-badge">最近</span><span class="item-title">${name}</span><button class="item-icon-btn" data-reveal="1" title="打开文件所在位置">${SVG_REVEAL_MINI}</button>`;
      item.addEventListener('click', (e) => {
        if (e.target.closest('[data-reveal]')) {
          e.stopPropagation();
          revealInExplorer(rf, false);
          return;
        }
        openFileFromServer(rf);
      });
      els.filesList.appendChild(item);
    }
  }
}

function renderWelcomeFiles() {
  const convFiles = state.convFiles || [];
  const files = convFiles.length ? convFiles : (state.browseData.files || []);
  els.welcomeFileList.innerHTML = '';
  if (!files.length) return;
  const header = document.createElement('div');
  header.className = 'section-title';
  header.textContent = convFiles.length
    ? `本会话文件（点击直接微调）`
    : `快速打开工作区文件（${state.browseData.dir}）`;
  els.welcomeFileList.appendChild(header);

  for (const f of files.slice(0, 8)) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `<span class="item-badge">${modeBadgeText(f.mode)}</span><span class="item-title">${f.name}</span>`;
    item.addEventListener('click', () => openFileFromServer(f.path));
    els.welcomeFileList.appendChild(item);
  }
}

async function insertLocalImageToCanvas(imgPath, imgName) {
  try {
    const res = await callServer('app_read_image_data', { filePath: imgPath });
    const img = await new Promise((resolveImg, rejectImg) => {
      const el = new Image();
      el.onload = () => resolveImg(el);
      el.onerror = rejectImg;
      el.src = res.dataUrl;
    });
    const maxSide = Math.min(fabricEngine.docWidth, fabricEngine.docHeight) * 0.65;
    const ratio = Math.min(maxSide / img.width, maxSide / img.height, 1);
    const relSrc = imgPath.startsWith(state.workspaceDir)
      ? `.${imgPath.slice(state.workspaceDir.length).replace(/\\/g, '/')}`
      : imgPath;

    await fabricEngine.addElement('image', {
      name: imgName,
      src: relSrc,
      dataUrl: res.dataUrl,
      width: Math.round(img.width * ratio),
      height: Math.round(img.height * ratio),
    });
    state.insertImageMode = false;
    els.insertImageBanner.classList.add('hidden');
    switchTab('props');
    showToast(`已插入图片: ${imgName}`);
  } catch (err) {
    showToast(`插图失败: ${err.message}`, 3200);
  }
}

// ---------- 渲染属性 / 图层 / 面包屑 ----------
function renderPropsPanel(props) {
  if (!props) {
    els.quickBar.classList.add('hidden');
    els.propsElementSection.classList.add('hidden');
    els.propsCanvasSection.classList.remove('hidden');
    syncCanvasInputs();
    return;
  }

  els.quickBar.classList.remove('hidden');
  els.propsCanvasSection.classList.add('hidden');
  els.propsElementSection.classList.remove('hidden');

  els.selNameLabel.textContent = props.name || '选中元素';
  els.btnSelLock.textContent = props.locked ? '已锁' : '解锁';
  els.btnPdfEditLine.classList.toggle('hidden', !props.isPdfVirtual);
  els.btnPdfRevertLine.classList.toggle('hidden', !props.isPromotedPdfText);
  els.quickAngle.textContent = `${props.angle}°`;
  els.quickAngle.classList.toggle('is-level', Math.abs(props.angle) < 0.05);

  // 避免打断用户正在输入的焦点框
  const setVal = (input, val) => {
    if (document.activeElement !== input) input.value = val;
  };

  setVal(els.inpX, props.x);
  setVal(els.inpY, props.y);
  setVal(els.inpW, props.w);
  setVal(els.inpH, props.h);
  setVal(els.inpAngleRange, props.angle);
  setVal(els.inpAngleNum, props.angle);
  setVal(els.inpOpacity, props.opacity);
  els.lblOpacity.textContent = `${props.opacity}%`;

  els.propsTextGroup.classList.toggle('hidden', !props.isText);
  if (props.isText) {
    setVal(els.inpText, props.text || '');
    setVal(els.inpFontSize, props.fontSize || 12);
    setVal(els.inpFontWeight, String(props.fontWeight || '400'));
    // 精准匹配中文字体族，避免英文衬线 Times New Roman 覆盖宋体匹配
    const ff = String(props.fontFamily || '').toLowerCase();
    const opts = Array.from(els.inpFontFamily.options);
    let matchedOpt = opts.find((o) => o.value.toLowerCase() === ff);
    if (!matchedOpt) {
      if (ff.includes('simsun') || ff.includes('songti')) matchedOpt = opts.find((o) => o.value.toLowerCase().includes('simsun'));
      else if (ff.includes('simhei') || ff.includes('heiti')) matchedOpt = opts.find((o) => o.value.toLowerCase().includes('simhei'));
      else if (ff.includes('kaiti')) matchedOpt = opts.find((o) => o.value.toLowerCase().includes('kaiti'));
      else if (ff.includes('fangsong')) matchedOpt = opts.find((o) => o.value.toLowerCase().includes('fangsong'));
      else if (ff.includes('yahei') || ff.includes('pingfang')) matchedOpt = opts.find((o) => o.value.toLowerCase().includes('yahei'));
      else if (ff.includes('impact')) matchedOpt = opts.find((o) => o.value.toLowerCase().includes('impact'));
      else if (ff.includes('georgia')) matchedOpt = opts.find((o) => o.value.toLowerCase().includes('georgia'));
    }
    if (matchedOpt) els.inpFontFamily.value = matchedOpt.value;
  }

  els.lblFill.textContent = props.isText
    ? '字色'
    : props.isRasterBase
      ? '底图'
      : props.isExtractedElement
        ? '换色'
        : '填充';
  if (props.fill?.startsWith('#')) els.inpFill.value = props.fill.slice(0, 7);
  if (props.bg?.startsWith('#')) els.inpBg.value = props.bg.slice(0, 7);
  if (props.stroke?.startsWith('#')) els.inpStroke.value = props.stroke.slice(0, 7);
  setVal(els.inpStrokeW, props.strokeWidth ?? 0);
  setVal(els.inpRadius, props.radius ?? 0);
  els.inpShadow.checked = Boolean(props.hasShadow);
  els.wrapBg.classList.toggle('hidden', state.mode === 'svg' || (state.mode === 'canvas' && props.type === 'text'));
}

function renderLayersPanel(layers = []) {
  els.layerCount.textContent = String(layers.length);
  els.layerList.innerHTML = '';
  for (const l of layers) {
    const row = document.createElement('div');
    row.className = `layer-item${l.active ? ' active' : ''}`;
    row.innerHTML = `
      <span class="item-badge">${l.type}</span>
      <span class="item-title" title="${l.name}">${l.name}</span>
      <div class="item-actions">
        <button class="item-icon-btn" data-act="toggle-vis" title="显示/隐藏">${l.visible ? SVG_EYE_ON : SVG_EYE_OFF}</button>
        <button class="item-icon-btn" data-act="del" title="删除">×</button>
      </div>
    `;
    row.addEventListener('click', (e) => {
      const actBtn = e.target.closest('[data-act]');
      const act = actBtn?.dataset?.act;
      const engine = getActiveEngine();
      if (!engine) return;
      if (act) {
        e.stopPropagation();
        engine.layerAction(act, state.mode === 'html' || state.mode === 'svg' ? Number(l.id) : l.id);
      } else {
        engine.selectById(l.id);
      }
    });
    els.layerList.appendChild(row);
  }
}

function renderBreadcrumb(chain = []) {
  if (!chain.length || (state.mode !== 'html' && state.mode !== 'svg')) {
    els.domBreadcrumb.classList.add('hidden');
    return;
  }
  els.domBreadcrumb.classList.remove('hidden');
  els.domBreadcrumb.innerHTML = '';
  chain.slice(-4).forEach((node, idx, arr) => {
    const btn = document.createElement('button');
    btn.className = `crumb-btn${idx === arr.length - 1 ? ' active' : ''}`;
    btn.textContent = node.label;
    btn.title = '点击选中该层级容器';
    btn.addEventListener('click', () => domEngine.selectElement(node.el));
    els.domBreadcrumb.appendChild(btn);
  });
}

// ---------- UI 交互绑定 ----------
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tabName),
  );
  document.querySelectorAll('.tab-pane').forEach((p) =>
    p.classList.toggle('active', p.id === `tab-${tabName}`),
  );
}

function openInspector() {
  els.inspectorPanel.classList.remove('collapsed');
  els.btnToggleInspector.classList.add('active');
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

els.btnToggleInspector.addEventListener('click', () => {
  const collapsed = els.inspectorPanel.classList.toggle('collapsed');
  els.btnToggleInspector.classList.toggle('active', !collapsed);
  setTimeout(fitCurrentStage, 40);
});

els.btnFilesTab.addEventListener('click', () => {
  openInspector();
  switchTab('files');
  refreshBrowse(state.workspaceDir);
});

document.querySelector('.file-meta')?.addEventListener('click', () => {
  openInspector();
  switchTab('files');
  refreshBrowse(state.workspaceDir);
});

els.btnUndo.addEventListener('click', () => getActiveEngine()?.undo());
els.btnRedo.addEventListener('click', () => getActiveEngine()?.redo());

els.btnZoomOut.addEventListener('click', () => {
  const eng = getActiveEngine();
  if (eng) updateZoomLabel(eng.setZoom(eng.zoom - 0.1));
});
els.btnZoomIn.addEventListener('click', () => {
  const eng = getActiveEngine();
  if (eng) updateZoomLabel(eng.setZoom(eng.zoom + 0.1));
});
els.btnZoomFit.addEventListener('click', fitCurrentStage);

els.btnSave.addEventListener('click', () => saveCurrentFile(false));
els.btnExport.addEventListener('click', () => exportCurrentImage());
els.btnSyncAi.addEventListener('click', () => syncAdjustmentsToAi());
els.btnRevealFile.addEventListener('click', () => revealInExplorer(getRevealTargetPath(), false));
els.btnPropsRevealFile.addEventListener('click', () => revealInExplorer(getRevealTargetPath(), false));
els.btnPropsRevealExport.addEventListener('click', () => revealInExplorer(state.lastExportPath, false));
els.btnRevealDir.addEventListener('click', () => revealInExplorer(els.inpDirPath.value.trim() || state.workspaceDir, true));

// PDF 翻页与快捷工具绑定
els.btnPdfPrev.addEventListener('click', () => goToPdfPage(state.pdf.pageIndex - 1));
els.btnPdfNext.addEventListener('click', () => goToPdfPage(state.pdf.pageIndex + 1));
els.inpPdfPage.addEventListener('change', () => goToPdfPage(Number(els.inpPdfPage.value) - 1));
els.btnPdfPickText.addEventListener('click', () => {
  state.pdf.pickText = !state.pdf.pickText;
  fabricEngine.setPdfTextPickEnabled(state.pdf.pickText);
  updatePdfBarUi();
});
els.btnPdfAddText.addEventListener('click', async () => {
  const obj = await fabricEngine.addElement('text_fill', {
    text: '输入文字',
    left: fabricEngine.docWidth / 2,
    top: fabricEngine.docHeight / 2,
  });
  if (obj && typeof obj.enterEditing === 'function') {
    obj.enterEditing();
    obj.selectAll();
  }
});
els.btnPdfAddMask.addEventListener('click', () => fabricEngine.addElement('mask'));
els.btnPdfAddImg.addEventListener('click', () => {
  state.insertImageMode = true;
  els.insertImageBanner.classList.remove('hidden');
  openInspector();
  switchTab('files');
  refreshBrowse(state.workspaceDir);
});
els.btnPdfSaveAs.addEventListener('click', () => savePdfDocument(true, false));
els.btnPdfEditLine.addEventListener('click', () => fabricEngine.editSelectedPdfText());
els.btnPdfRevertLine.addEventListener('click', () => fabricEngine.revertPromotedPdfText());
els.btnConvRefresh.addEventListener('click', async () => {
  await refreshBrowse(state.workspaceDir);
  showToast(`已刷新本会话文件 (${state.convFiles.length} 个)`, 1600);
});

// 平面图自动识别与拆层按钮绑定
els.btnImgSplitAll.addEventListener('click', () => {
  fabricEngine.decomposeAllRasterElements(els.selImgSegMode.value);
});
els.btnImgPick.addEventListener('click', () => {
  if (fabricEngine.rasterBoxMode) fabricEngine.setRasterBoxMode(false);
  fabricEngine.setRasterPickEnabled(!fabricEngine.rasterPickEnabled);
});
els.btnImgBox.addEventListener('click', () => {
  const next = !fabricEngine.rasterBoxMode;
  fabricEngine.setRasterBoxMode(next);
  if (next) showToast('请在图上拖拽方框圈出要单独调整的区域（如标题/图标/徽章）', 3000);
});
els.selImgSegMode.addEventListener('change', () => {
  const elsFound = fabricEngine.analyzeRaster(els.selImgSegMode.value);
  showToast(`已切换为「${els.selImgSegMode.value === 'fine' ? '精细分色' : '智能识别'}」模式，识别到 ${elsFound.length} 个元素`, 2400);
});
els.btnImgBgLock.addEventListener('click', () => {
  fabricEngine.toggleRasterBaseLock();
});
els.btnImgSaveCanvas.addEventListener('click', async () => {
  const targetDisk = state.filePath || getRevealTargetPath();
  if (!targetDisk) {
    showToast('当前文件未关联本地磁盘路径，暂无法另存工程', 2600);
    return;
  }
  const canvasPath = targetDisk.replace(/\.[^.]+$/, '') + '.canvas.json';
  const doc = fabricEngine.serialize();
  // 把已拆层的图内数据内联为 dataURL，确保重新打开 .canvas.json 完整还原拆出的元素与修补后底图
  doc.layers = (doc.layers || []).map((l) => {
    if (l.type === 'image' && l.src && fabricEngine.assetMap[l.src]) {
      return { ...l, src: fabricEngine.assetMap[l.src] };
    }
    return l;
  });
  await callServer('app_save_file', { filePath: canvasPath, content: JSON.stringify(doc, null, 2) });
  showToast(`已另存分层画布工程: ${canvasPath.split(/[/\\]/).pop()}`, 4000, {
    label: '打开所在位置',
    onClick: () => revealInExplorer(canvasPath, false),
  });
  refreshBrowse(state.workspaceDir);
});

// 欢迎页直接粘贴文件路径/目录打开
const openWelcomePath = () => {
  const raw = els.inpWelcomePath.value.trim();
  if (!raw) return;
  refreshBrowse(raw);
};
els.btnWelcomeOpen.addEventListener('click', openWelcomePath);
els.inpWelcomePath.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') openWelcomePath();
});

// 快捷对齐 / 旋转摆正 / 图层动作（事件委托覆盖 quick-bar 与 inspector）
document.addEventListener('click', (e) => {
  const alignBtn = e.target.closest('[data-align]');
  if (alignBtn) {
    getActiveEngine()?.alignSelected(alignBtn.dataset.align);
    return;
  }
  const rotBtn = e.target.closest('[data-rot]');
  if (rotBtn) {
    getActiveEngine()?.rotateSelected(rotBtn.dataset.rot);
    return;
  }
  const layerBtn = e.target.closest('[data-layer]');
  if (layerBtn) {
    getActiveEngine()?.layerAction(layerBtn.dataset.layer);
    return;
  }
  const textAlignBtn = e.target.closest('[data-text-align]');
  if (textAlignBtn) {
    getActiveEngine()?.updateSelected({ textAlign: textAlignBtn.dataset.textAlign });
    return;
  }
  const sizeBtn = e.target.closest('[data-size]');
  if (sizeBtn) {
    const [w, h] = sizeBtn.dataset.size.split('x').map(Number);
    getActiveEngine()?.resizeCanvas(w, h);
    syncCanvasInputs();
    fitCurrentStage();
    return;
  }
  const newPresetBtn = e.target.closest('[data-new-preset]');
  if (newPresetBtn) {
    createBlankDesign(newPresetBtn.dataset.newPreset);
    return;
  }
  const addBtn = e.target.closest('[data-add]');
  if (addBtn) {
    const kind = addBtn.dataset.add;
    if (kind === 'image') {
      state.insertImageMode = true;
      els.insertImageBanner.classList.remove('hidden');
      openInspector();
      switchTab('files');
      refreshBrowse(state.workspaceDir);
    } else if (state.mode === 'canvas' || state.mode === 'image' || state.mode === 'pdf') {
      fabricEngine.addElement(kind);
    }
  }
});

// 画布尺寸与背景输入
const onCanvasResize = () => {
  getActiveEngine()?.resizeCanvas(els.inpCanvasW.value, els.inpCanvasH.value);
  fitCurrentStage();
};
els.inpCanvasW.addEventListener('change', onCanvasResize);
els.inpCanvasH.addEventListener('change', onCanvasResize);
els.inpCanvasBg.addEventListener('input', () => {
  if (state.mode === 'canvas' || state.mode === 'image') {
    fabricEngine.setBackground(els.inpCanvasBg.value, false);
  }
});
els.inpCanvasBg.addEventListener('change', () => {
  if (state.mode === 'canvas' || state.mode === 'image') {
    fabricEngine.setBackground(els.inpCanvasBg.value, true);
  }
});

// 元素属性输入绑定
const bindProp = (el, eventName, buildPatch, recordHistory = true) => {
  el.addEventListener(eventName, () => {
    const eng = getActiveEngine();
    if (!eng) return;
    eng.updateSelected(buildPatch(el), recordHistory);
  });
};

bindProp(els.inpX, 'change', (el) => ({ x: el.value }));
bindProp(els.inpY, 'change', (el) => ({ y: el.value }));
bindProp(els.inpW, 'change', (el) => ({ w: el.value }));
bindProp(els.inpH, 'change', (el) => ({ h: el.value }));
bindProp(els.inpAngleRange, 'input', (el) => ({ angle: el.value }), false);
bindProp(els.inpAngleRange, 'change', (el) => ({ angle: el.value }), true);
bindProp(els.inpAngleNum, 'change', (el) => ({ angle: el.value }), true);
bindProp(els.inpOpacity, 'input', (el) => ({ opacity: el.value }), false);
bindProp(els.inpOpacity, 'change', (el) => ({ opacity: el.value }), true);
bindProp(els.inpText, 'input', (el) => ({ text: el.value }), false);
bindProp(els.inpText, 'change', (el) => ({ text: el.value }), true);
bindProp(els.inpFontFamily, 'change', (el) => ({ fontFamily: el.value }));
bindProp(els.inpFontSize, 'change', (el) => ({ fontSize: el.value }));
bindProp(els.inpFontWeight, 'change', (el) => ({ fontWeight: el.value }));
bindProp(els.inpFill, 'input', (el) => ({ fill: el.value }), false);
bindProp(els.inpFill, 'change', (el) => ({ fill: el.value }), true);
bindProp(els.inpBg, 'input', (el) => ({ bg: el.value }), false);
bindProp(els.inpBg, 'change', (el) => ({ bg: el.value }), true);
bindProp(els.inpStroke, 'input', (el) => ({ stroke: el.value }), false);
bindProp(els.inpStroke, 'change', (el) => ({ stroke: el.value }), true);
bindProp(els.inpStrokeW, 'change', (el) => ({ strokeWidth: el.value }));
bindProp(els.inpRadius, 'change', (el) => ({ radius: el.value }));
bindProp(els.inpShadow, 'change', (el) => ({ hasShadow: el.checked }));

els.btnSelLock.addEventListener('click', () => {
  getActiveEngine()?.layerAction('toggle-lock');
});

// 文件浏览按钮
els.btnDirUp.addEventListener('click', () => {
  if (state.parentDir) refreshBrowse(state.parentDir);
});
els.btnDirGo.addEventListener('click', () => refreshBrowse(els.inpDirPath.value.trim()));
els.inpDirPath.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') refreshBrowse(els.inpDirPath.value.trim());
});
els.btnRefreshFiles.addEventListener('click', () => refreshBrowse(state.workspaceDir));
els.btnNewDesign.addEventListener('click', () => createBlankDesign('800x800'));
els.btnCancelInsert.addEventListener('click', () => {
  state.insertImageMode = false;
  els.insertImageBanner.classList.add('hidden');
  renderFilesPanel();
});

// Ctrl + 滚轮缩放
els.stageViewport.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  const eng = getActiveEngine();
  if (!eng) return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? 0.08 : -0.08;
  updateZoomLabel(eng.setZoom(eng.zoom + delta));
}, { passive: false });

// ---------- 纯净预览模式与三点菜单事件绑定 ----------
els.btnBackPreview.addEventListener('click', () => returnToPreviewMode());
els.btnPreviewMore.addEventListener('click', (e) => {
  e.stopPropagation();
  togglePreviewMenu();
});
document.addEventListener('click', (e) => {
  if (!els.previewMoreWrap.contains(e.target)) {
    closePreviewMenu();
  }
});

els.menuEnterEdit.addEventListener('click', () => enterVisualEditFromPreview(-1));
els.menuViewSource.addEventListener('click', () => openSourceMode());
els.menuCopyPath.addEventListener('click', async () => {
  closePreviewMenu();
  const p = getRevealTargetPath();
  if (!p) return;
  try {
    await navigator.clipboard.writeText(p);
    showToast('已复制文件路径', 1800);
  } catch {
    showToast(p, 3000);
  }
});
els.menuCopyContent.addEventListener('click', async () => {
  closePreviewMenu();
  try {
    if (state.preview.text) {
      await navigator.clipboard.writeText(state.preview.text);
      showToast('已复制文件内容', 1800);
    } else if (state.preview.mode === 'pdf' && Array.isArray(state.preview.pdfData?.textItems) && state.preview.pdfData.textItems.length) {
      const pageText = state.preview.pdfData.textItems.map((it) => it.text).filter(Boolean).join('\n');
      await navigator.clipboard.writeText(pageText);
      showToast('已复制当前页文字内容', 1800);
    } else if (state.preview.dataUrl && window.ClipboardItem) {
      const resp = await fetch(state.preview.dataUrl);
      const blob = await resp.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      showToast('已复制图片到剪贴板', 1800);
    } else {
      showToast('当前文件类型不支持直接复制到剪贴板', 2200);
    }
  } catch (err) {
    showToast(`复制失败: ${err.message}`, 2600);
  }
});
els.menuExportImg.addEventListener('click', async () => {
  closePreviewMenu();
  const dataUrl =
    state.preview.mode === 'pdf'
      ? (getPdfPageImageUrl(state.preview.pdfData) || els.previewPdfImg.src)
      : state.preview.dataUrl;
  if (!dataUrl) {
    showToast('暂无可导出图片', 2000);
    return;
  }
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${(state.fileName || 'preview').replace(/\.[^.]+$/, '')}.png`;
  a.click();
  showToast(`已导出 ${a.download}`, 2200);
});
els.menuRevealFile.addEventListener('click', () => {
  closePreviewMenu();
  revealInExplorer(getRevealTargetPath(), false);
});

// 纯净图片预览缩放
els.btnPimgOut.addEventListener('click', () => applyPreviewImageZoom(state.preview.imgZoom - 0.15));
els.btnPimgIn.addEventListener('click', () => applyPreviewImageZoom(state.preview.imgZoom + 0.15));
els.btnPimgFit.addEventListener('click', () => fitPreviewImage());
els.previewImgEl.addEventListener('dblclick', () => {
  if (Math.abs(state.preview.imgZoom - 1) < 0.05) fitPreviewImage();
  else applyPreviewImageZoom(1);
});
els.previewImageView.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  applyPreviewImageZoom(state.preview.imgZoom + (e.deltaY < 0 ? 0.12 : -0.12));
}, { passive: false });

// 纯净 PDF 阅读器翻页与缩放
els.btnPpdfPrev.addEventListener('click', () => previewGoToPdfPage(state.pdf.pageIndex - 1));
els.btnPpdfNext.addEventListener('click', () => previewGoToPdfPage(state.pdf.pageIndex + 1));
els.inpPpdfPage.addEventListener('change', () => previewGoToPdfPage(Number(els.inpPpdfPage.value) - 1));
els.btnPpdfOut.addEventListener('click', () => applyPreviewPdfZoom(state.preview.pdfZoom - 0.15));
els.btnPpdfIn.addEventListener('click', () => applyPreviewPdfZoom(state.preview.pdfZoom + 0.15));
els.btnPpdfFit.addEventListener('click', () => fitPreviewPdf());
els.previewPdfView.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  applyPreviewPdfZoom(state.preview.pdfZoom + (e.deltaY < 0 ? 0.12 : -0.12));
}, { passive: false });

// Markdown 预览内嵌图悬停微调按钮、图片直链与轮播切换
els.previewMdArticle.addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-md-edit-img]');
  if (editBtn) {
    e.preventDefault();
    const idx = Number(editBtn.dataset.mdEditImg);
    enterVisualEditFromPreview(idx);
    return;
  }
  const carBtn = e.target.closest('[data-car-dir]');
  if (carBtn) {
    const car = carBtn.closest('.md-carousel');
    if (!car) return;
    const total = Number(car.dataset.total) || 1;
    const cur = Number(car.dataset.cur) || 0;
    const next = (cur + Number(carBtn.dataset.carDir) + total) % total;
    car.dataset.cur = String(next);
    car.querySelectorAll('.md-carousel-slide').forEach((s, idx) => {
      s.classList.toggle('active', idx === next);
    });
    const counter = car.querySelector('.md-car-counter');
    if (counter) counter.textContent = `${next + 1} / ${total}`;
    return;
  }
  const link = e.target.closest('[data-md-href]');
  if (link) {
    const href = link.dataset.mdHref || '';
    if (/^https?:\/\//i.test(href) && state.hostCaps?.openLinks) {
      e.preventDefault();
      app.openLink({ url: href }).catch(() => {});
    }
  }
});

// 源码编辑模式返回与保存
els.sourceTextarea.addEventListener('input', () => {
  state.sourceDirty = true;
  els.sourceDirtyDot.classList.remove('hidden');
});
els.btnSourceSave.addEventListener('click', () => saveSourceFile());
els.btnSourceBack.addEventListener('click', async () => {
  setViewMode('preview');
  const m = state.preview.mode;
  if (m === 'markdown') {
    showPreviewSurface('markdown');
    renderMarkdownPreviewContent();
    await resolveAndRenderPreviewAssets();
  } else if (m === 'html') {
    showPreviewSurface('html');
    renderPreviewHtmlShadow(state.preview.text, state.preview.assetMap || {});
    await resolveAndRenderPreviewAssets();
  } else if (m === 'svg') {
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.preview.text)}`;
    state.preview.dataUrl = svgUrl;
    showImageInPreview(svgUrl, 'SVG 矢量图');
  } else if (m === 'canvas') {
    try {
      const doc = JSON.parse(state.preview.text);
      state.preview.canvasDoc = doc;
      await fabricEngine.loadDocument(doc, state.preview.assetMap || {});
      state.preview.editorInitialized = true;
      const rendered = fabricEngine.exportDataUrl('png', 1);
      state.preview.dataUrl = rendered;
      showImageInPreview(rendered, `${doc.width || 800} × ${doc.height || 800} · 分层画布`);
    } catch (err) {
      showToast(`JSON 格式有误: ${err.message}`, 3200);
    }
  }
});

// 窄侧栏默认收起属性抽屉留足画布视野；窗口变化自动重算适应比例
if (window.innerWidth < 680) {
  els.inspectorPanel.classList.add('collapsed');
  els.btnToggleInspector.classList.remove('active');
}
window.addEventListener('resize', () => {
  if (state.viewMode === 'preview') {
    if (['image', 'svg', 'canvas'].includes(state.preview.mode)) fitPreviewImage();
    else if (state.preview.mode === 'pdf') fitPreviewPdf();
    return;
  }
  if (state.viewMode === 'edit' && getActiveEngine()) fitCurrentStage();
});

// 键盘快捷键（微调方向键、撤销重做、保存、复制、删除、预览翻页）
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closePreviewMenu();
  }

  if (state.viewMode === 'source') {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveSourceFile();
    }
    return;
  }

  if (state.viewMode === 'preview') {
    if (state.preview.mode === 'pdf') {
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT') {
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
          e.preventDefault();
          previewGoToPdfPage(state.pdf.pageIndex - 1);
        } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
          e.preventDefault();
          previewGoToPdfPage(state.pdf.pageIndex + 1);
        }
      }
    }
    return;
  }

  const tag = document.activeElement?.tagName;
  const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;
  const activeFabric = fabricEngine.getActiveObject();
  const isFabricEditingText = activeFabric?.isEditing;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveCurrentFile(false);
    return;
  }
  if (isTyping || isFabricEditingText) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    getActiveEngine()?.undo();
  } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault();
    getActiveEngine()?.redo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    getActiveEngine()?.layerAction('dup');
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    getActiveEngine()?.layerAction('del');
  } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    e.preventDefault();
    getActiveEngine()?.nudgeSelected(dx, dy);
  }
});

// ---------- 启动连接 ----------
async function boot() {
  try {
    await app.connect();
    state.connected = true;
    state.hostCaps = app.getHostCapabilities() || {};
    applyThemeFromContext(app.getHostContext());

    // 只有在当前容器支持向对话发消息或附加模型上下文时，才显示“同步AI”按钮（如侧栏 aux_pane）
    if (state.hostCaps?.message || state.hostCaps?.updateModelContext) {
      els.btnSyncAi.classList.remove('hidden');
    }
  } catch (err) {
    console.warn('[Visual Canvas Studio] 独立预览模式或连接宿主失败:', err);
  }
}

boot();
