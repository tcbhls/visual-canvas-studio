/**
 * Engine A: 基于 Fabric.js v7 的分层画布编辑器引擎
 * 支持 .canvas.json 分层设计文档与 .png/.jpg/.webp 本地图片直接排版编辑
 */
import {
  Canvas,
  Circle,
  FabricImage,
  FabricObject,
  FabricText,
  Gradient,
  Group,
  Line,
  Rect,
  Shadow,
  Textbox,
} from 'fabric';
import {
  analyzeRgbaElements,
  createRasterSession,
  cutRgbaToDataUrl,
  extractAndInpaintRgba,
  recolorImageDataUrl,
  recolorRasterBackgroundRgba,
  rgbToHex,
  sessionToDataUrl,
} from './image-segmenter.js';

const SNAP_THRESHOLD = 7;

// 配置 Figma 风格的干净蓝白选框与圆形控制柄
FabricObject.ownDefaults.transparentCorners = false;
FabricObject.ownDefaults.cornerColor = '#ffffff';
FabricObject.ownDefaults.cornerStrokeColor = '#3b82f6';
FabricObject.ownDefaults.borderColor = '#3b82f6';
FabricObject.ownDefaults.cornerSize = 9;
FabricObject.ownDefaults.cornerStyle = 'circle';
FabricObject.ownDefaults.borderScaleFactor = 1.6;
FabricObject.ownDefaults.padding = 4;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizeAngle(deg) {
  let a = ((deg % 360) + 540) % 360 - 180;
  return Math.round(a * 10) / 10;
}

function makeShadow(s) {
  if (!s) return null;
  return new Shadow({
    color: s.color || 'rgba(0,0,0,0.28)',
    blur: s.blur ?? 18,
    offsetX: s.offsetX ?? 0,
    offsetY: s.offsetY ?? 8,
  });
}

function makeLinearGradient(width, height, bgGrad) {
  const rad = ((bgGrad.angle ?? 135) - 90) * (Math.PI / 180);
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.hypot(width, height) / 2;
  const dx = Math.cos(rad) * r;
  const dy = Math.sin(rad) * r;
  return new Gradient({
    type: 'linear',
    gradientUnits: 'pixels',
    coords: { x1: cx - dx, y1: cy - dy, x2: cx + dx, y2: cy + dy },
    colorStops: (bgGrad.stops || []).map((s) => ({
      offset: s.offset,
      color: s.color,
    })),
  });
}

export class FabricCanvasEngine {
  constructor(canvasEl, frameEl, callbacks) {
    this.canvasEl = canvasEl;
    this.frameEl = frameEl;
    this.cb = callbacks || {};
    this.canvas = null;
    this.docWidth = 800;
    this.docHeight = 800;
    this.docName = '未命名主图';
    this.background = '#ffffff';
    this.backgroundGradient = null;
    this.assetMap = {};
    this.zoom = 1;
    this.snapLines = { v: null, h: null };
    this.history = [];
    this.historyIdx = -1;
    this.isRestoring = false;
    this.idSeq = 1;
    // PDF 专属状态
    this.pdfMode = false;
    this.pdfTextPickEnabled = true;
    this.pdfTextItems = [];
    this.pdfRedactions = [];
    this.pdfHoveredText = null;
    this.pdfSelectedText = null; // 单击原文字的无损选中状态（不改字体、不替换、不标脏）
    this.pdfBgDataUrl = '';
    this.pdfRenderScale = 2;
    // 平面图自动识别与拆层专属状态
    this.rasterMode = false;
    this.rasterSession = null;
    this.rasterAnalysis = null;
    this.rasterElements = [];
    this.rasterLiftedIds = new Set();
    this.rasterHoveredEl = null;
    this.rasterPickEnabled = true;
    this.rasterBoxMode = false;
    this.rasterBoxDrag = null; // { x0, y0, x1, y1 }
    this.rasterSegMode = 'smart';
    this.rasterBaseObj = null;
    this.rasterScaleToDoc = 1;
  }

  init() {
    if (this.canvas) return;
    this.canvas = new Canvas(this.canvasEl, {
      width: this.docWidth,
      height: this.docHeight,
      preserveObjectStacking: true,
      selection: true,
      controlsAboveOverlay: true,
    });

    // 绘制居中/元素对齐磁性吸附参考线 + PDF 可点击原位改字高亮框
    this.canvas.on('after:render', () => {
      const ctx = this.canvas.getContext();
      if (!ctx) return;
      const vpt = this.canvas.viewportTransform || [1, 0, 0, 1, 0, 0];

      // PDF 模式下悬停到原 PDF 文字行时绘制浅蓝虚线框；单击无损选中时绘制蓝色实线框（完全不改动原字像素）
      if (this.pdfMode && this.pdfTextPickEnabled) {
        if (this.pdfHoveredText && this.pdfHoveredText !== this.pdfSelectedText) {
          const t = this.pdfHoveredText;
          ctx.save();
          ctx.transform(vpt[0], vpt[1], vpt[2], vpt[3], vpt[4], vpt[5]);
          ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
          ctx.strokeStyle = '#60a5fa';
          ctx.lineWidth = 1.1 / Math.max(this.zoom, 0.25);
          ctx.setLineDash([4 / Math.max(this.zoom, 0.25), 3 / Math.max(this.zoom, 0.25)]);
          ctx.fillRect(t.x - 2, t.y - 2, t.w + 4, t.h + 4);
          ctx.strokeRect(t.x - 2, t.y - 2, t.w + 4, t.h + 4);
          ctx.restore();
        }
        if (this.pdfSelectedText) {
          const t = this.pdfSelectedText;
          ctx.save();
          ctx.transform(vpt[0], vpt[1], vpt[2], vpt[3], vpt[4], vpt[5]);
          ctx.fillStyle = 'rgba(37, 99, 235, 0.09)';
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 1.5 / Math.max(this.zoom, 0.25);
          ctx.setLineDash([]);
          ctx.fillRect(t.x - 2, t.y - 2, t.w + 4, t.h + 4);
          ctx.strokeRect(t.x - 2, t.y - 2, t.w + 4, t.h + 4);
          ctx.restore();
        }
      }

      // 平面图智能拆层：悬停自动高亮识别到的图内独立元素 + 框选抠元素拉框预览
      if (this.rasterMode) {
        if (this.rasterPickEnabled && !this.rasterBoxMode && this.rasterHoveredEl) {
          const el = this.rasterHoveredEl;
          const s = this.rasterScaleToDoc || 1;
          const rx = el.x * s;
          const ry = el.y * s;
          const rw = el.w * s;
          const rh = el.h * s;
          ctx.save();
          ctx.transform(vpt[0], vpt[1], vpt[2], vpt[3], vpt[4], vpt[5]);
          ctx.fillStyle = 'rgba(59, 130, 246, 0.14)';
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2 / Math.max(this.zoom, 0.25);
          ctx.setLineDash([6 / Math.max(this.zoom, 0.25), 4 / Math.max(this.zoom, 0.25)]);
          ctx.fillRect(rx, ry, rw, rh);
          ctx.strokeRect(rx, ry, rw, rh);
          ctx.restore();
        }
        if (this.rasterBoxMode && this.rasterBoxDrag) {
          const b = this.rasterBoxDrag;
          const x = Math.min(b.x0, b.x1);
          const y = Math.min(b.y0, b.y1);
          const w = Math.abs(b.x1 - b.x0);
          const h = Math.abs(b.y1 - b.y0);
          ctx.save();
          ctx.transform(vpt[0], vpt[1], vpt[2], vpt[3], vpt[4], vpt[5]);
          ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
          ctx.strokeStyle = '#10b981';
          ctx.lineWidth = 2 / Math.max(this.zoom, 0.25);
          ctx.setLineDash([5 / Math.max(this.zoom, 0.25), 3 / Math.max(this.zoom, 0.25)]);
          ctx.fillRect(x, y, w, h);
          ctx.strokeRect(x, y, w, h);
          ctx.restore();
        }
      }

      const { v, h } = this.snapLines;
      if (v === null && h === null) return;
      ctx.save();
      ctx.strokeStyle = '#ec4899';
      ctx.lineWidth = 1.25 / Math.max(this.zoom, 0.2);
      ctx.setLineDash([5 / Math.max(this.zoom, 0.2), 4 / Math.max(this.zoom, 0.2)]);
      ctx.transform(vpt[0], vpt[1], vpt[2], vpt[3], vpt[4], vpt[5]);
      if (v !== null) {
        ctx.beginPath();
        ctx.moveTo(v, 0);
        ctx.lineTo(v, this.docHeight);
        ctx.stroke();
      }
      if (h !== null) {
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(this.docWidth, h);
        ctx.stroke();
      }
      ctx.restore();
    });

    // 拖拽磁性吸附（自动吸附画布水平/垂直中心线及附近其他元素中心）
    this.canvas.on('object:moving', (e) => {
      const target = e.target;
      if (!target) return;
      const bypass = Boolean(e.e?.altKey);
      let snapV = null;
      let snapH = null;

      if (!bypass) {
        const cx = this.docWidth / 2;
        const cy = this.docHeight / 2;
        const vCandidates = [cx, 0, this.docWidth];
        const hCandidates = [cy, 0, this.docHeight];

        for (const obj of this.canvas.getObjects()) {
          if (obj === target || !obj.visible) continue;
          vCandidates.push(obj.left);
          hCandidates.push(obj.top);
        }

        for (const vx of vCandidates) {
          if (Math.abs(target.left - vx) <= SNAP_THRESHOLD) {
            target.set('left', vx);
            snapV = vx;
            break;
          }
        }
        for (const hy of hCandidates) {
          if (Math.abs(target.top - hy) <= SNAP_THRESHOLD) {
            target.set('top', hy);
            snapH = hy;
            break;
          }
        }
      }

      this.snapLines = { v: snapV, h: snapH };
      const isCenter = snapV === this.docWidth / 2 || snapH === this.docHeight / 2;
      this.cb.onHud?.(
        `X: ${Math.round(target.left)}  Y: ${Math.round(target.top)}${isCenter ? ' · 已居中吸附' : ''}`,
        e.e?.clientX,
        e.e?.clientY,
        isCenter,
      );
      this.cb.onSelectionChange?.(this.getSelectedProps());
    });

    // 旋转角度实时显示与 0°/90° 吸附摆正
    this.canvas.on('object:rotating', (e) => {
      const target = e.target;
      if (!target) return;
      let angle = normalizeAngle(target.angle || 0);
      let snapped = false;
      if (e.e?.shiftKey) {
        angle = Math.round(angle / 15) * 15;
        snapped = true;
      } else {
        for (const keyDeg of [0, 90, -90, 180, -180, 45, -45]) {
          if (Math.abs(angle - keyDeg) <= 2.5) {
            angle = keyDeg === -180 ? 180 : keyDeg;
            snapped = true;
            break;
          }
        }
      }
      target.set('angle', angle);
      this.cb.onHud?.(
        `角度: ${angle}°${angle === 0 ? ' · 已摆正' : ''}`,
        e.e?.clientX,
        e.e?.clientY,
        snapped && angle === 0,
      );
      this.cb.onSelectionChange?.(this.getSelectedProps());
    });

    this.canvas.on('object:scaling', (e) => {
      const target = e.target;
      if (!target) return;
      const w = Math.round(target.getScaledWidth());
      const h = Math.round(target.getScaledHeight());
      this.cb.onHud?.(`尺寸: ${w} × ${h}`, e.e?.clientX, e.e?.clientY, false);
      this.cb.onSelectionChange?.(this.getSelectedProps());
    });

    const onEditDone = () => {
      this.snapLines = { v: null, h: null };
      this.cb.onHudHide?.();
      this.canvas.requestRenderAll();
      if (!this.isRestoring) {
        this.pushHistory();
        this.cb.onChange?.();
      }
      this.cb.onSelectionChange?.(this.getSelectedProps());
      this.cb.onLayersChange?.(this.getLayersList());
    };

    this.canvas.on('object:modified', onEditDone);
    this.canvas.on('mouse:up', () => {
      if (this.snapLines.v !== null || this.snapLines.h !== null) {
        this.snapLines = { v: null, h: null };
        this.canvas.requestRenderAll();
      }
      this.cb.onHudHide?.();
    });

    this.canvas.on('selection:created', () => {
      this.pdfSelectedText = null;
      this.cb.onSelectionChange?.(this.getSelectedProps());
      this.cb.onLayersChange?.(this.getLayersList());
    });
    this.canvas.on('selection:updated', () => {
      this.pdfSelectedText = null;
      this.cb.onSelectionChange?.(this.getSelectedProps());
      this.cb.onLayersChange?.(this.getLayersList());
    });
    this.canvas.on('selection:cleared', () => {
      this.cb.onSelectionChange?.(this.getSelectedProps());
      this.cb.onLayersChange?.(this.getLayersList());
    });

    // 退出文本编辑时：如果是刚从 PDF 原文字提出来的框且用户没做任何改动，自动还原回无损原文字
    this.canvas.on('text:editing:exited', (e) => {
      const target = e?.target;
      if (target && this.isUnmodifiedPromotedPdfText(target)) {
        this.revertPromotedPdfText(target, true);
      }
    });

    // 双击促销贴纸 (badge) 自动聚焦右侧文字输入框；
    // PDF 模式下：单击原文字仅无损选中查看（不改字体/字号/不替换），双击原文字才进入原位改字，双击空白处直接填字
    // 平面图模式下：悬停自动识别高亮图内元素，单击立即无痕抠离提层并可直接拖动/旋转/换色；框选模式拖框即可局部抠元素
    this.canvas.on('mouse:move', (opt) => {
      // 1. 平面图框选抠元素拉框
      if (this.rasterMode && this.rasterBoxMode && this.rasterBoxDrag) {
        const p = this.canvas.getScenePoint(opt.e);
        this.rasterBoxDrag.x1 = clamp(p.x, 0, this.docWidth);
        this.rasterBoxDrag.y1 = clamp(p.y, 0, this.docHeight);
        const bw = Math.round(Math.abs(this.rasterBoxDrag.x1 - this.rasterBoxDrag.x0));
        const bh = Math.round(Math.abs(this.rasterBoxDrag.y1 - this.rasterBoxDrag.y0));
        this.cb.onHud?.(`框选区域 ${bw} × ${bh} · 松开抠出`, opt.e?.clientX, opt.e?.clientY, false);
        this.canvas.requestRenderAll();
        return;
      }

      // 2. 平面图悬停自动高亮识别元素（若当前已选中某个图层，优先保持普通选择，不抢焦误触）
      if (this.rasterMode && this.rasterPickEnabled && !this.rasterBoxMode) {
        if ((opt.target && !opt.target.vcsMeta?.isRasterBase) || this.getActiveObject()) {
          if (this.rasterHoveredEl) {
            this.rasterHoveredEl = null;
            this.canvas.defaultCursor = 'default';
            this.cb.onHudHide?.();
            this.canvas.requestRenderAll();
          }
          return;
        }
        const p = this.canvas.getScenePoint(opt.e);
        const hit = this.findRasterElementAt(p.x, p.y);
        if (hit !== this.rasterHoveredEl) {
          this.rasterHoveredEl = hit;
          this.canvas.defaultCursor = hit ? 'grab' : 'default';
          this.canvas.requestRenderAll();
        }
        if (hit) {
          this.cb.onHud?.(`${hit.name} · 点击提层`, opt.e?.clientX, opt.e?.clientY, false);
        } else {
          this.cb.onHudHide?.();
        }
        return;
      }

      if (!this.pdfMode || !this.pdfTextPickEnabled) return;
      if (opt.target) {
        if (this.pdfHoveredText) {
          this.pdfHoveredText = null;
          this.canvas.defaultCursor = 'default';
          this.canvas.requestRenderAll();
        }
        return;
      }
      const p = this.canvas.getScenePoint(opt.e);
      const hit = this.findPdfTextAt(p.x, p.y);
      if (hit !== this.pdfHoveredText) {
        this.pdfHoveredText = hit;
        this.canvas.defaultCursor = hit ? 'pointer' : 'default';
        this.canvas.requestRenderAll();
      }
    });

    this.canvas.on('mouse:down', (opt) => {
      if (opt.e?.button !== 0) return;

      // 1. 平面图框选抠元素开始拉框
      if (this.rasterMode && this.rasterBoxMode) {
        const p = this.canvas.getScenePoint(opt.e);
        this.rasterBoxDrag = {
          x0: clamp(p.x, 0, this.docWidth),
          y0: clamp(p.y, 0, this.docHeight),
          x1: clamp(p.x, 0, this.docWidth),
          y1: clamp(p.y, 0, this.docHeight),
        };
        this.canvas.selection = false;
        this.canvas.discardActiveObject();
        this.canvas.requestRenderAll();
        return;
      }

      // 2. 平面图点击自动识别元素 -> 仅在当前未选中任何图层时才触发点击提层（避免点击空白处取消选中时误抠旁边的元素！）
      if (this.rasterMode && this.rasterPickEnabled && !this.getActiveObject() && (!opt.target || opt.target.vcsMeta?.isRasterBase)) {
        const p = this.canvas.getScenePoint(opt.e);
        const hit = this.findRasterElementAt(p.x, p.y);
        if (hit) {
          this.liftRasterElement(hit);
          return;
        }
      }

      if (!this.pdfMode || !this.pdfTextPickEnabled) return;
      if (opt.target) {
        if (this.pdfSelectedText) {
          this.pdfSelectedText = null;
          this.canvas.requestRenderAll();
        }
        return;
      }
      const p = this.canvas.getScenePoint(opt.e);
      const hit = this.findPdfTextAt(p.x, p.y);
      if (hit) {
        // 无损选中原文字：不擦除、不替换、不改字体大小，仅高亮框选并在右侧显示真实属性
        this.pdfSelectedText = hit;
        this.canvas.discardActiveObject();
        this.canvas.requestRenderAll();
        this.cb.onSelectionChange?.(this.getSelectedProps());
      } else if (this.pdfSelectedText) {
        this.pdfSelectedText = null;
        this.canvas.requestRenderAll();
        this.cb.onSelectionChange?.(null);
      }
    });

    this.canvas.on('mouse:up', async () => {
      if (this.rasterMode && this.rasterBoxMode && this.rasterBoxDrag) {
        const b = this.rasterBoxDrag;
        this.rasterBoxDrag = null;
        const x = Math.min(b.x0, b.x1);
        const y = Math.min(b.y0, b.y1);
        const w = Math.abs(b.x1 - b.x0);
        const h = Math.abs(b.y1 - b.y0);
        this.setRasterBoxMode(false);
        this.canvas.requestRenderAll();
        if (w >= 12 && h >= 12) {
          await this.liftRasterBox(x, y, w, h);
        }
      }
    });

    this.canvas.on('mouse:dblclick', (opt) => {
      const obj = opt.target;
      if (obj?.vcsMeta?.type === 'badge') {
        this.cb.onFocusTextProp?.();
        return;
      }
      if (this.pdfMode && !obj) {
        const p = this.canvas.getScenePoint(opt.e);
        const hit = this.findPdfTextAt(p.x, p.y);
        if (hit) {
          // 双击原文字：真正进入原位改字模式
          this.promotePdfTextToEditable(hit, { enterEditing: true });
        } else {
          // 双击空白处：立即在落点创建新文本框方便填表（如填姓名、学号）
          this.addPdfQuickTextAt(p.x, p.y);
        }
      }
    });
  }

  findPdfTextAt(x, y) {
    const redactedIds = new Set(this.pdfRedactions.map((r) => r.id));
    for (const item of this.pdfTextItems) {
      if (redactedIds.has(item.id)) continue;
      if (x >= item.x - 3 && x <= item.x + item.w + 3 && y >= item.y - 3 && y <= item.y + item.h + 3) {
        return item;
      }
    }
    return null;
  }

  isUnmodifiedPromotedPdfText(obj) {
    const snap = obj?.vcsMeta?.pdfOrigSnap;
    if (!snap) return false;
    return (
      (obj.text || '') === snap.text &&
      Math.abs((obj.left || 0) - snap.left) < 0.8 &&
      Math.abs((obj.top || 0) - snap.top) < 0.8 &&
      Math.abs((obj.angle || 0) - 0) < 0.2 &&
      Math.abs((obj.fontSize || 0) - snap.fontSize) < 0.1 &&
      (obj.fontFamily || '') === snap.fontFamily &&
      String(obj.fontWeight || '400') === String(snap.fontWeight) &&
      (obj.fill || '') === snap.fill &&
      Math.abs((obj.scaleX || 1) - 1) < 0.01 &&
      Math.abs((obj.scaleY || 1) - 1) < 0.01
    );
  }

  /**
   * 将 PDF 原生文字行转为可编辑 Fabric 文本框 + 底层红涂预览遮罩
   * 仅在用户双击、点「编辑原文字」或修改属性时触发，单击查看不会触发
   */
  async promotePdfTextToEditable(item, { enterEditing = false } = {}) {
    if (!item) return null;
    this.pdfHoveredText = null;
    this.pdfSelectedText = null;
    this.canvas.defaultCursor = 'default';

    // 记录红涂擦除区域（保存回 PDF 时由 MuPDF 真正擦除旧文字并保留下划线）
    const redactEntry = { id: item.id, x: item.x, y: item.y, w: item.w, h: item.h, mode: 'text' };
    if (!this.pdfRedactions.some((r) => r.id === item.id)) {
      this.pdfRedactions.push(redactEntry);
      this.addRedactionPreviewRect(redactEntry);
    }

    // 保留精确 0.5pt 浮点字号与足够单行宽度，避免意外折行或字号缩水
    const exactFontSize = Number(item.fontSize || 12);
    const boxW = Math.max(item.w + 48, 140);
    const initLeft = item.x + boxW / 2;
    const initTop = item.y + item.h / 2;
    const initFontFamily = item.fontFamily || '"Times New Roman", SimSun, "Songti SC", serif';
    const initFontWeight = String(item.fontWeight || '400');
    const initFill = item.color || '#111827';

    const obj = await this.createFabricObject({
      id: `edit_${item.id}`,
      type: 'text',
      name: item.text.slice(0, 14) || '原位文字',
      text: item.text,
      left: initLeft,
      top: initTop,
      width: boxW,
      fontSize: exactFontSize,
      fontWeight: initFontWeight,
      fontFamily: initFontFamily,
      fill: initFill,
      textAlign: 'left',
      lineHeight: 1.15,
    });
    if (obj) {
      obj.vcsMeta.pdfOrigId = item.id;
      obj.vcsMeta.pdfOrigSnap = {
        text: item.text,
        left: initLeft,
        top: initTop,
        fontSize: exactFontSize,
        fontFamily: initFontFamily,
        fontWeight: initFontWeight,
        fill: initFill,
      };
      this.canvas.add(obj);
      this.canvas.setActiveObject(obj);
      this.canvas.requestRenderAll();
      if (enterEditing && typeof obj.enterEditing === 'function') {
        obj.enterEditing();
      }
      if (!enterEditing) {
        this.pushHistory();
        this.cb.onChange?.();
      }
      this.cb.onSelectionChange?.(this.getSelectedProps());
      this.cb.onLayersChange?.(this.getLayersList());
    }
    return obj;
  }

  /**
   * 还原已提取的原位 PDF 文本框回未改动的原 PDF 像素
   */
  revertPromotedPdfText(targetObj = null, silent = false) {
    const obj = targetObj || this.getActiveObject();
    const origId = obj?.vcsMeta?.pdfOrigId;
    if (!obj || !origId) return false;

    this.canvas.remove(obj);
    const previewMask = this.canvas.getObjects().find(
      (o) => o.vcsMeta?.isRedactionPreview && o.vcsMeta?.redactId === origId,
    );
    if (previewMask) this.canvas.remove(previewMask);
    this.pdfRedactions = this.pdfRedactions.filter((r) => r.id !== origId);

    const origItem = this.pdfTextItems.find((t) => t.id === origId) || null;
    this.canvas.discardActiveObject();
    this.pdfSelectedText = silent ? null : origItem;
    this.canvas.requestRenderAll();
    if (!silent) {
      this.pushHistory();
      this.cb.onToast?.('已还原该行文字为 PDF 原貌');
    }
    this.cb.onSelectionChange?.(this.getSelectedProps());
    this.cb.onLayersChange?.(this.getLayersList());
    return true;
  }

  async editSelectedPdfText() {
    if (this.pdfSelectedText) {
      await this.promotePdfTextToEditable(this.pdfSelectedText, { enterEditing: true });
    }
  }

  addRedactionPreviewRect(r) {
    const mask = new Rect({
      left: r.x + r.w / 2,
      top: r.y + r.h / 2,
      width: r.w + 2,
      height: r.h + 1,
      fill: '#ffffff',
      opacity: 0.96,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
      hasControls: false,
      hasBorders: false,
    });
    mask.vcsMeta = { id: `redact_${r.id}`, isRedactionPreview: true, redactId: r.id };
    this.canvas.add(mask);
    this.canvas.sendObjectToBack(mask);
  }

  async addPdfQuickTextAt(x, y) {
    const obj = await this.addElement('text_fill', {
      left: x + 70,
      top: y,
      width: 220,
      text: '输入文字',
      fontSize: 18,
      fontWeight: '400',
      fontFamily: 'KaiTi, STKaiti, serif',
      fill: '#111827',
      textAlign: 'left',
    });
    if (obj && typeof obj.enterEditing === 'function') {
      obj.enterEditing();
      obj.selectAll();
    }
  }

  setPdfTextPickEnabled(enabled) {
    this.pdfTextPickEnabled = Boolean(enabled);
    if (!this.pdfTextPickEnabled) {
      this.pdfHoveredText = null;
      this.pdfSelectedText = null;
      if (this.canvas) {
        this.canvas.defaultCursor = 'default';
        this.canvas.requestRenderAll();
      }
      this.cb.onSelectionChange?.(this.getSelectedProps());
    }
  }

  async loadPdfPage(pageData, existingEdit = null) {
    this.init();
    this.isRestoring = true;
    this.pdfMode = true;
    this.docWidth = Number(pageData.width) || 595.32;
    this.docHeight = Number(pageData.height) || 841.92;
    this.docName = `PDF 第 ${pageData.pageIndex + 1} 页`;
    this.background = '#ffffff';
    this.backgroundGradient = null;
    this.pdfBgDataUrl = pageData.bgDataUrl;
    this.pdfRenderScale = Number(pageData.renderScale) || 2;
    this.pdfTextItems = Array.isArray(pageData.textItems) ? pageData.textItems : [];
    this.pdfRedactions = Array.isArray(existingEdit?.redactions) ? existingEdit.redactions.map((r) => ({ ...r })) : [];
    this.pdfHoveredText = null;
    this.pdfSelectedText = null;

    this.canvas.clear();
    this.applyCanvasDimensions();
    this.canvas.backgroundColor = '#ffffff';

    const bgImg = await FabricImage.fromURL(pageData.bgDataUrl, { crossOrigin: 'anonymous' });
    const inv = 1 / this.pdfRenderScale;
    bgImg.set({
      left: 0,
      top: 0,
      originX: 'left',
      originY: 'top',
      scaleX: inv,
      scaleY: inv,
      selectable: false,
      evented: false,
    });
    this.canvas.backgroundImage = bgImg;

    // 恢复当前页已有的红涂预览遮罩与用户图层
    for (const r of this.pdfRedactions) {
      this.addRedactionPreviewRect(r);
    }
    const layers = Array.isArray(existingEdit?.layers) ? existingEdit.layers : [];
    for (const layer of layers) {
      if (layer.dataUrl && layer.src) {
        this.assetMap[layer.src] = layer.dataUrl;
      }
      const obj = await this.createFabricObject(layer);
      if (obj) this.canvas.add(obj);
    }

    this.canvas.renderAll();
    this.isRestoring = false;
    this.history = [this.getPdfPageEdit()];
    this.historyIdx = 0;
    this.cb.onHistoryChange?.(false, false);
    this.cb.onSelectionChange?.(null);
    this.cb.onLayersChange?.(this.getLayersList());
  }

  getPdfPageEdit() {
    const userObjs = (this.canvas?.getObjects() || []).filter((o) => !o.vcsMeta?.isRedactionPreview);
    return {
      redactions: this.pdfRedactions.map((r) => ({ ...r })),
      layers: userObjs.map((o) => this.serializeObject(o)),
    };
  }

  async loadDocument(doc, assetMap = {}) {
    this.init();
    this.isRestoring = true;
    this.pdfMode = false;
    this.pdfTextItems = [];
    this.pdfRedactions = [];
    this.pdfHoveredText = null;
    this.pdfSelectedText = null;
    this.rasterMode = false;
    this.rasterSession = null;
    this.rasterAnalysis = null;
    this.rasterElements = [];
    this.rasterLiftedIds = new Set();
    this.rasterHoveredEl = null;
    this.rasterBoxMode = false;
    this.rasterBoxDrag = null;
    this.rasterBaseObj = null;
    this.assetMap = { ...assetMap };
    this.docWidth = Number(doc.width) || 800;
    this.docHeight = Number(doc.height) || 800;
    this.docName = doc.name || '未命名主图';
    this.background = doc.background || '#ffffff';
    this.backgroundGradient = doc.backgroundGradient || null;

    this.canvas.clear();
    this.canvas.backgroundImage = null;
    this.applyCanvasDimensions();
    this.applyBackground();

    const layers = Array.isArray(doc.layers) ? doc.layers : [];
    for (const layer of layers) {
      const obj = await this.createFabricObject(layer);
      if (obj) {
        this.canvas.add(obj);
      }
    }

    this.canvas.renderAll();
    this.isRestoring = false;
    this.history = [this.serialize()];
    this.historyIdx = 0;
    this.cb.onHistoryChange?.(false, false);
    this.cb.onSelectionChange?.(null);
    this.cb.onLayersChange?.(this.getLayersList());
  }

  /**
   * 直接将本地单张平面图 (.png/.jpg/.webp) 载入画布，并自动在离线 < 80ms 内识别图内独立元素：
   * - 背景默认锁定为底图，防止拖动时整张图跟着滑走
   * - 悬停图内任意图形/文字块自动蓝框高亮，点击瞬间抠离提层并无痕修补背景，支持自由拖拽、居中、旋转摆正与换色
   */
  async loadSingleImage(dataUrl, fileName, origSrc) {
    this.init();
    const imgEl = await new Promise((res, rej) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => res(el);
      el.onerror = rej;
      el.src = dataUrl;
    });

    const natW = imgEl.naturalWidth || imgEl.width || 800;
    const natH = imgEl.naturalHeight || imgEl.height || 800;
    const maxDim = Math.max(natW, natH);
    const scaleToDoc = maxDim > 1600 ? 1600 / maxDim : 1;
    const docW = Math.round(natW * scaleToDoc);
    const docH = Math.round(natH * scaleToDoc);

    const doc = {
      format: 'visual-canvas-studio',
      version: 1,
      name: fileName,
      width: docW,
      height: docH,
      background: '#ffffff',
      layers: [
        {
          id: 'raster_base',
          type: 'image',
          name: `背景底图 (${fileName})`,
          src: origSrc,
          left: docW / 2,
          top: docH / 2,
          width: docW,
          height: docH,
          angle: 0,
          opacity: 1,
          locked: true,
        },
      ],
    };
    await this.loadDocument(doc, { [origSrc]: dataUrl });

    // 激活平面图智能拆层引擎并自动执行一次离线识别
    this.rasterMode = true;
    this.rasterSession = createRasterSession(imgEl);
    this.rasterUntintedRgba = new Uint8ClampedArray(this.rasterSession.imageData.data);
    this.rasterUntintedKey = origSrc;
    this.rasterBgColor = '';
    this._recolorSeq = 0;
    this.rasterScaleToDoc = scaleToDoc;
    this.rasterPickEnabled = true;
    this.rasterBoxMode = false;
    this.rasterBoxDrag = null;
    this.rasterLiftedIds = new Set();
    this.rasterHoveredEl = null;

    const baseObj = this.canvas.getObjects().find((o) => o.vcsMeta?.id === 'raster_base');
    if (baseObj) {
      baseObj.vcsMeta.isRasterBase = true;
      baseObj.vcsMeta.locked = true;
      baseObj.set({ selectable: false, evented: false });
      this.rasterBaseObj = baseObj;
    }

    this.analyzeRaster(this.rasterSegMode);
    if (this.rasterAnalysis?.bgModel) {
      const origHex = rgbToHex(
        this.rasterAnalysis.bgModel.r,
        this.rasterAnalysis.bgModel.g,
        this.rasterAnalysis.bgModel.b,
      );
      this.background = origHex;
      if (this.rasterBaseObj?.vcsMeta) {
        this.rasterBaseObj.vcsMeta.bgColor = origHex;
      }
      this.applyBackground();
    }
    // 补录初始历史快照的 _rasterState，确保第一次操作后 Ctrl+Z 也能精确还原底图像素
    if (this.history.length > 0) {
      this.history[this.history.length - 1]._rasterState = {
        untintedKey: this.rasterUntintedKey,
        liftedIds: [],
        bgColor: '',
      };
    }
    this.cb.onLayersChange?.(this.getLayersList());
    return {
      elementCount: this.rasterElements.length,
      width: docW,
      height: docH,
    };
  }

  analyzeRaster(mode = 'smart') {
    if (!this.rasterMode || !this.rasterSession) return [];
    this.rasterSegMode = mode;
    const srcRgba = this.rasterUntintedRgba || this.rasterSession.imageData.data;
    this.rasterAnalysis = analyzeRgbaElements(
      srcRgba,
      this.rasterSession.w,
      this.rasterSession.h,
      { mode },
    );
    this.rasterElements = this.rasterAnalysis.elements || [];
    this.rasterLiftedIds = new Set();
    this.rasterHoveredEl = null;
    this.cb.onRasterStatus?.({
      total: this.rasterElements.length,
      remaining: this.rasterElements.length,
      pickEnabled: this.rasterPickEnabled,
      boxMode: this.rasterBoxMode,
      bgLocked: Boolean(this.rasterBaseObj?.vcsMeta?.locked),
      segMode: this.rasterSegMode,
    });
    return this.rasterElements;
  }

  findRasterElementAt(docX, docY) {
    if (!this.rasterMode || !this.rasterElements.length) return null;
    const s = this.rasterScaleToDoc || 1;
    const ix = docX / s;
    const iy = docY / s;
    // 优先命中面积更小（更靠上层）的元素，避免外框吞掉内部图标
    let best = null;
    let bestArea = Infinity;
    for (const el of this.rasterElements) {
      if (this.rasterLiftedIds.has(el.id)) continue;
      if (ix >= el.x && ix <= el.x + el.w && iy >= el.y && iy <= el.y + el.h) {
        const boxArea = el.w * el.h;
        if (boxArea < bestArea) {
          bestArea = boxArea;
          best = el;
        }
      }
    }
    return best;
  }

  syncRasterSessionDisplayPixels() {
    if (!this.rasterSession || !this.rasterUntintedRgba) return;
    if (this.rasterBgColor) {
      const allLifted =
        this.rasterElements.length > 0 &&
        this.rasterLiftedIds.size >= this.rasterElements.length;
      const tinted = recolorRasterBackgroundRgba(
        this.rasterUntintedRgba,
        this.rasterSession.w,
        this.rasterSession.h,
        this.rasterBgColor,
        { allLifted, bgModel: this.rasterAnalysis?.bgModel || null },
      );
      this.rasterSession.imageData.data.set(tinted);
    } else {
      this.rasterSession.imageData.data.set(this.rasterUntintedRgba);
    }
  }

  async refreshRasterBaseTexture() {
    if (!this.rasterSession || !this.rasterBaseObj) return;
    // 先将未染色原底图像素存成版本快照，供 Ctrl+Z 撤销时像素级精准回滚
    this.rasterBaseRev = (this.rasterBaseRev || 0) + 1;
    if (this.rasterBgColor && this.rasterUntintedRgba) {
      const untintedUrl = cutRgbaToDataUrl(
        this.rasterUntintedRgba,
        this.rasterSession.w,
        this.rasterSession.h,
      );
      const untintedKey = `raster_untinted_v${this.rasterBaseRev}.png`;
      this.assetMap[untintedKey] = untintedUrl;
      this.rasterUntintedKey = untintedKey;
    }
    this.syncRasterSessionDisplayPixels();
    const updatedUrl = sessionToDataUrl(this.rasterSession);
    const revKey = `raster_base_v${this.rasterBaseRev}.png`;
    this.assetMap[revKey] = updatedUrl;
    if (!this.rasterBgColor) {
      this.rasterUntintedKey = revKey;
    }
    this.rasterBaseObj.vcsMeta.src = revKey;
    const newImg = await FabricImage.fromURL(updatedUrl, { crossOrigin: 'anonymous' });
    this.rasterBaseObj.setElement(newImg.getElement());
    this.rasterBaseObj.dirty = true;
    this.canvas.requestRenderAll();
  }

  async restoreUntintedRgbaFromKey(key) {
    if (!this.rasterSession || !key) return;
    const dataUrl = this.assetMap[key];
    if (!dataUrl) return;
    const img = await new Promise((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = rej;
      el.src = dataUrl;
    });
    const c = document.createElement('canvas');
    c.width = this.rasterSession.w;
    c.height = this.rasterSession.h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const id = ctx.getImageData(0, 0, c.width, c.height);
    this.rasterUntintedRgba = new Uint8ClampedArray(id.data);
    this.syncRasterSessionDisplayPixels();
  }

  /**
   * 更换平面图背景底图颜色（无论底图是否已全拆均可精准无损换色，不破坏原像素，支持反复调色与撤销）
   */
  async recolorRasterBase(targetHex, recordHistory = true) {
    if (!this.rasterMode || !this.rasterSession || !this.rasterBaseObj || !this.rasterUntintedRgba) return;
    const seq = ++this._recolorSeq;
    this.rasterBgColor = targetHex;
    this.background = targetHex;
    this.backgroundGradient = null;
    if (this.rasterBaseObj.vcsMeta) {
      this.rasterBaseObj.vcsMeta.bgColor = targetHex;
    }
    this.syncRasterSessionDisplayPixels();
    const updatedUrl = sessionToDataUrl(this.rasterSession);
    const newImg = await FabricImage.fromURL(updatedUrl, { crossOrigin: 'anonymous' });
    if (seq !== this._recolorSeq) return;

    this.rasterBaseRev = (this.rasterBaseRev || 0) + 1;
    const revKey = `raster_base_v${this.rasterBaseRev}.png`;
    this.assetMap[revKey] = updatedUrl;
    this.rasterBaseObj.vcsMeta.src = revKey;
    this.rasterBaseObj.setElement(newImg.getElement());
    this.rasterBaseObj.dirty = true;
    this.applyBackground();
    this.canvas.requestRenderAll();
    if (recordHistory) {
      this.pushHistory();
      this.cb.onChange?.();
    }
  }

  /**
   * 将平面图中识别到的单个元素无痕抠离并提为独立可拖拽/旋转/换色的 Fabric 图层
   */
  async liftRasterElement(el, { selectAfter = true, refreshBase = true, recordHistory = true } = {}) {
    if (!this.rasterSession || !this.rasterAnalysis || !el) return null;
    if (this.rasterLiftedIds.has(el.id)) return null;

    const baseRgba = this.rasterUntintedRgba || this.rasterSession.imageData.data;
    const cut = extractAndInpaintRgba(
      baseRgba,
      this.rasterSession.w,
      this.rasterSession.h,
      this.rasterAnalysis,
      el,
    );
    if (!cut) return null;

    this.rasterLiftedIds.add(el.id);
    this.rasterHoveredEl = null;
    this.cb.onHudHide?.();

    const cutUrl = cutRgbaToDataUrl(cut.cutRgba, cut.w, cut.h);
    const s = this.rasterScaleToDoc || 1;
    const virtualSrc = `extracted://${el.id}.png`;
    this.assetMap[virtualSrc] = cutUrl;

    if (refreshBase) {
      await this.refreshRasterBaseTexture();
    }

    const obj = await this.createFabricObject({
      id: `lifted_${el.id}_${Date.now()}`,
      type: 'image',
      name: el.name,
      src: virtualSrc,
      left: Math.round(cut.left * s * 10) / 10,
      top: Math.round(cut.top * s * 10) / 10,
      width: Math.round(cut.w * s * 10) / 10,
      height: Math.round(cut.h * s * 10) / 10,
      angle: 0,
      opacity: 1,
    });

    if (obj) {
      obj.vcsMeta.isExtractedElement = true;
      obj.vcsMeta.origCutDataUrl = cutUrl;
      obj.vcsMeta.dominantColor = el.dominantColor || '#ffffff';
      if (!this._origCutMap) this._origCutMap = {};
      this._origCutMap[obj.vcsMeta.id] = cutUrl;
      this.canvas.add(obj);
      if (selectAfter) {
        this.canvas.setActiveObject(obj);
      }
      this.canvas.requestRenderAll();
      if (recordHistory) {
        this.pushHistory();
        this.cb.onChange?.();
        this.cb.onSelectionChange?.(this.getSelectedProps());
        this.cb.onLayersChange?.(this.getLayersList());
        this.cb.onToast?.(`已提取「${el.name}」为独立图层：可直接拖动居中、旋转摆正或换色`);
      }
    }

    this.cb.onRasterStatus?.({
      total: this.rasterElements.length,
      remaining: Math.max(0, this.rasterElements.length - this.rasterLiftedIds.size),
      pickEnabled: this.rasterPickEnabled,
      boxMode: this.rasterBoxMode,
      bgLocked: Boolean(this.rasterBaseObj?.vcsMeta?.locked),
      segMode: this.rasterSegMode,
    });
    return obj;
  }

  /**
   * 一键全图智能拆层：把平面图中全部剩余元素一次性抠成独立图层，并无缝修补完整底图
   */
  async decomposeAllRasterElements(mode = null) {
    if (!this.rasterMode || !this.rasterSession) return 0;
    if (mode && mode !== this.rasterSegMode) {
      this.analyzeRaster(mode);
    }
    const pending = this.rasterElements.filter((el) => !this.rasterLiftedIds.has(el.id));
    if (!pending.length) {
      this.cb.onToast?.('图中可识别元素已全部拆为独立图层');
      return 0;
    }

    let liftedCount = 0;
    let lastObj = null;
    for (const el of pending) {
      const obj = await this.liftRasterElement(el, {
        selectAfter: false,
        refreshBase: false,
        recordHistory: false,
      });
      if (obj) {
        liftedCount++;
        lastObj = obj;
      }
    }
    await this.refreshRasterBaseTexture();
    if (lastObj) this.canvas.setActiveObject(lastObj);
    this.canvas.requestRenderAll();
    this.pushHistory();
    this.cb.onChange?.();
    this.cb.onSelectionChange?.(this.getSelectedProps());
    this.cb.onLayersChange?.(this.getLayersList());
    this.cb.onToast?.(`一键拆层完成：共拆出 ${liftedCount} 个独立可编辑元素（背景已自动无痕修补）`);
    return liftedCount;
  }

  /**
   * 框选抠元素：对用户拖框圈出的任意局部区域（含复杂摄影/渐变电商主图）执行局部背景抠离 + 无痕修补
   */
  async liftRasterBox(docX, docY, docW, docH) {
    if (!this.rasterMode || !this.rasterSession) return null;
    const s = this.rasterScaleToDoc || 1;
    const target = {
      isBox: true,
      x: docX / s,
      y: docY / s,
      w: docW / s,
      h: docH / s,
    };
    const baseRgba = this.rasterUntintedRgba || this.rasterSession.imageData.data;
    const cut = extractAndInpaintRgba(
      baseRgba,
      this.rasterSession.w,
      this.rasterSession.h,
      this.rasterAnalysis,
      target,
    );
    if (!cut) {
      this.cb.onToast?.('框选区域内未检测到明显前景元素，请框得更紧贴目标边缘试试');
      return null;
    }

    const cutUrl = cutRgbaToDataUrl(cut.cutRgba, cut.w, cut.h);
    const virtualId = `box_${Date.now()}`;
    const virtualSrc = `extracted://${virtualId}.png`;
    this.assetMap[virtualSrc] = cutUrl;

    await this.refreshRasterBaseTexture();

    // 同步标记中心落在该选框内的自动识别项，避免原位留下陈旧悬停虚框
    for (const el of this.rasterElements || []) {
      const cx = el.x + el.w / 2;
      const cy = el.y + el.h / 2;
      if (cx >= target.x && cx <= target.x + target.w && cy >= target.y && cy <= target.y + target.h) {
        this.rasterLiftedIds.add(el.id);
      }
    }
    this.cb.onRasterStatus?.({
      total: this.rasterElements.length,
      remaining: Math.max(0, this.rasterElements.length - this.rasterLiftedIds.size),
      pickEnabled: this.rasterPickEnabled,
      boxMode: this.rasterBoxMode,
      bgLocked: Boolean(this.rasterBaseObj?.vcsMeta?.locked),
      segMode: this.rasterSegMode,
    });

    const obj = await this.createFabricObject({
      id: virtualId,
      type: 'image',
      name: `框选抠出元素`,
      src: virtualSrc,
      left: Math.round(cut.left * s * 10) / 10,
      top: Math.round(cut.top * s * 10) / 10,
      width: Math.round(cut.w * s * 10) / 10,
      height: Math.round(cut.h * s * 10) / 10,
      angle: 0,
      opacity: 1,
    });
    if (obj) {
      obj.vcsMeta.isExtractedElement = true;
      obj.vcsMeta.origCutDataUrl = cutUrl;
      obj.vcsMeta.dominantColor = '#ffffff';
      if (!this._origCutMap) this._origCutMap = {};
      this._origCutMap[obj.vcsMeta.id] = cutUrl;
      this.canvas.add(obj);
      this.canvas.setActiveObject(obj);
      this.canvas.requestRenderAll();
      this.pushHistory();
      this.cb.onChange?.();
      this.cb.onSelectionChange?.(this.getSelectedProps());
      this.cb.onLayersChange?.(this.getLayersList());
      this.cb.onToast?.('框选元素已抠离为独立图层（原位背景已自动修补）');
    }
    return obj;
  }

  setRasterPickEnabled(enabled) {
    this.rasterPickEnabled = Boolean(enabled);
    if (this.rasterPickEnabled && this.rasterBoxMode) {
      this.rasterBoxMode = false;
      this.rasterBoxDrag = null;
    }
    if (!this.rasterPickEnabled) {
      this.rasterHoveredEl = null;
      this.cb.onHudHide?.();
      if (this.canvas) {
        this.canvas.defaultCursor = 'default';
        this.canvas.requestRenderAll();
      }
    }
    this.cb.onRasterStatus?.({
      total: this.rasterElements.length,
      remaining: Math.max(0, this.rasterElements.length - this.rasterLiftedIds.size),
      pickEnabled: this.rasterPickEnabled,
      boxMode: this.rasterBoxMode,
      bgLocked: Boolean(this.rasterBaseObj?.vcsMeta?.locked),
      segMode: this.rasterSegMode,
    });
  }

  setRasterBoxMode(enabled) {
    this.rasterBoxMode = Boolean(enabled);
    // 开启手动框选抠图时自动关闭点选拆层，防止抠完点击空白取消选中时误抠旁边元素
    if (this.rasterBoxMode) {
      this.rasterPickEnabled = false;
    }
    this.rasterBoxDrag = null;
    this.rasterHoveredEl = null;
    this.cb.onHudHide?.();
    if (this.canvas) {
      this.canvas.selection = !this.rasterBoxMode;
      this.canvas.defaultCursor = this.rasterBoxMode ? 'crosshair' : 'default';
      this.canvas.requestRenderAll();
    }
    this.cb.onRasterStatus?.({
      total: this.rasterElements.length,
      remaining: Math.max(0, this.rasterElements.length - this.rasterLiftedIds.size),
      pickEnabled: this.rasterPickEnabled,
      boxMode: this.rasterBoxMode,
      bgLocked: Boolean(this.rasterBaseObj?.vcsMeta?.locked),
      segMode: this.rasterSegMode,
    });
  }

  toggleRasterBaseLock() {
    if (!this.rasterBaseObj) return;
    const locked = !this.rasterBaseObj.vcsMeta?.locked;
    this.rasterBaseObj.vcsMeta.locked = locked;
    this.rasterBaseObj.set({ selectable: !locked, evented: !locked });
    if (locked && this.getActiveObject() === this.rasterBaseObj) {
      this.canvas.discardActiveObject();
    }
    this.canvas.requestRenderAll();
    this.cb.onRasterStatus?.({
      total: this.rasterElements.length,
      remaining: Math.max(0, this.rasterElements.length - this.rasterLiftedIds.size),
      pickEnabled: this.rasterPickEnabled,
      boxMode: this.rasterBoxMode,
      bgLocked: locked,
      segMode: this.rasterSegMode,
    });
    this.cb.onLayersChange?.(this.getLayersList());
  }

  applyCanvasDimensions() {
    if (!this.canvas) return;
    this.canvas.setDimensions({
      width: Math.round(this.docWidth * this.zoom),
      height: Math.round(this.docHeight * this.zoom),
    });
    this.canvas.setZoom(this.zoom);
    if (this.frameEl) {
      this.frameEl.style.width = `${Math.round(this.docWidth * this.zoom)}px`;
      this.frameEl.style.height = `${Math.round(this.docHeight * this.zoom)}px`;
    }
  }

  applyBackground() {
    if (!this.canvas) return;
    if (this.backgroundGradient && Array.isArray(this.backgroundGradient.stops) && this.backgroundGradient.stops.length >= 2) {
      this.canvas.backgroundColor = makeLinearGradient(
        this.docWidth,
        this.docHeight,
        this.backgroundGradient,
      );
    } else {
      this.canvas.backgroundColor = this.background || '#ffffff';
    }
    this.canvas.requestRenderAll();
  }

  setZoom(nextZoom) {
    this.zoom = clamp(nextZoom, 0.15, 3);
    this.applyCanvasDimensions();
    this.canvas?.requestRenderAll();
    return this.zoom;
  }

  fitToViewport(vpWidth, vpHeight) {
    const pad = 44;
    const scaleX = (vpWidth - pad) / this.docWidth;
    const scaleY = (vpHeight - pad) / this.docHeight;
    return this.setZoom(Math.min(scaleX, scaleY, 1));
  }

  resizeCanvas(width, height) {
    this.docWidth = clamp(Number(width) || 800, 100, 4000);
    this.docHeight = clamp(Number(height) || 800, 100, 6000);
    this.applyCanvasDimensions();
    this.applyBackground();
    this.pushHistory();
    this.cb.onChange?.();
  }

  async setBackground(color, recordHistory = true) {
    this.background = color;
    this.backgroundGradient = null;
    if (this.rasterMode && this.rasterBaseObj && this.rasterUntintedRgba) {
      await this.recolorRasterBase(color, recordHistory);
      return;
    }
    this.applyBackground();
    if (recordHistory) {
      this.pushHistory();
      this.cb.onChange?.();
    }
  }

  async createFabricObject(layer) {
    const id = layer.id || `layer_${Date.now()}_${this.idSeq++}`;
    const name = layer.name || layer.text?.slice(0, 12) || layer.type;
    const common = {
      left: layer.left ?? this.docWidth / 2,
      top: layer.top ?? this.docHeight / 2,
      angle: layer.angle ?? 0,
      opacity: layer.opacity ?? 1,
      originX: 'center',
      originY: 'center',
      visible: layer.visible !== false,
      selectable: !layer.locked,
      evented: !layer.locked,
      shadow: makeShadow(layer.shadow),
    };

    let obj = null;

    if (layer.type === 'text') {
      obj = new Textbox(layer.text ?? '双击编辑标题', {
        ...common,
        width: layer.width ?? 420,
        fontSize: layer.fontSize ?? 44,
        fontWeight: layer.fontWeight ?? '700',
        fontFamily: layer.fontFamily || 'Microsoft YaHei, PingFang SC, sans-serif',
        fill: layer.fill || '#111827',
        textAlign: layer.textAlign || 'center',
        lineHeight: layer.lineHeight ?? 1.2,
        charSpacing: layer.charSpacing ?? 0,
        stroke: layer.stroke || '',
        strokeWidth: layer.strokeWidth ?? 0,
        backgroundColor: layer.bg || '',
      });
      obj.vcsMeta = { id, type: 'text', name, locked: !!layer.locked };
    } else if (layer.type === 'badge') {
      const w = layer.width ?? 180;
      const h = layer.height ?? 52;
      const rx = layer.rx ?? Math.round(h / 2);
      const rect = new Rect({
        width: w,
        height: h,
        rx,
        ry: layer.ry ?? rx,
        fill: layer.bg || '#ef4444',
        stroke: layer.stroke || '',
        strokeWidth: layer.strokeWidth ?? 0,
        originX: 'center',
        originY: 'center',
        left: 0,
        top: 0,
      });
      const label = new FabricText(layer.text || '限时特惠', {
        fontSize: layer.fontSize ?? 22,
        fontWeight: layer.fontWeight ?? '700',
        fontFamily: layer.fontFamily || 'Microsoft YaHei, PingFang SC, sans-serif',
        fill: layer.fill || '#ffffff',
        originX: 'center',
        originY: 'center',
        left: 0,
        top: 0,
      });
      obj = new Group([rect, label], { ...common });
      obj.vcsMeta = {
        id,
        type: 'badge',
        name,
        locked: !!layer.locked,
        bg: layer.bg || '#ef4444',
        fill: layer.fill || '#ffffff',
        rx,
        text: layer.text || '限时特惠',
        fontSize: layer.fontSize ?? 22,
        fontWeight: layer.fontWeight ?? '700',
        fontFamily: layer.fontFamily || 'Microsoft YaHei, PingFang SC, sans-serif',
      };
    } else if (layer.type === 'rect') {
      obj = new Rect({
        ...common,
        width: layer.width ?? 240,
        height: layer.height ?? 140,
        fill: layer.bg || layer.fill || '#e2e8f0',
        stroke: layer.stroke || '',
        strokeWidth: layer.strokeWidth ?? 0,
        rx: layer.rx ?? 12,
        ry: layer.ry ?? layer.rx ?? 12,
      });
      obj.vcsMeta = { id, type: 'rect', name, locked: !!layer.locked };
    } else if (layer.type === 'circle') {
      const radius = layer.radius ?? Math.round((layer.width ?? 140) / 2);
      obj = new Circle({
        ...common,
        radius,
        fill: layer.bg || layer.fill || '#fbbf24',
        stroke: layer.stroke || '',
        strokeWidth: layer.strokeWidth ?? 0,
      });
      obj.vcsMeta = { id, type: 'circle', name, locked: !!layer.locked };
    } else if (layer.type === 'line') {
      const len = layer.width ?? 320;
      obj = new Line([-len / 2, 0, len / 2, 0], {
        ...common,
        stroke: layer.stroke || layer.fill || '#334155',
        strokeWidth: layer.strokeWidth ?? 3,
      });
      obj.vcsMeta = { id, type: 'line', name, locked: !!layer.locked };
    } else if (layer.type === 'image') {
      const resolvedSrc = this.assetMap[layer.src] || layer.src;
      if (!resolvedSrc) return null;
      try {
        const img = await FabricImage.fromURL(resolvedSrc, { crossOrigin: 'anonymous' });
        const targetW = layer.width || img.width || 400;
        const targetH = layer.height || img.height || 400;
        const scaleX = targetW / (img.width || targetW);
        const scaleY = targetH / (img.height || targetH);
        img.set({
          ...common,
          scaleX,
          scaleY,
        });
        if (layer.rx && layer.rx > 0) {
          img.clipPath = new Rect({
            width: img.width,
            height: img.height,
            rx: layer.rx / scaleX,
            ry: layer.rx / scaleY,
            originX: 'center',
            originY: 'center',
          });
        }
        img.vcsMeta = {
          id,
          type: 'image',
          name,
          src: layer.src,
          rx: layer.rx ?? 0,
          locked: !!layer.locked,
        };
        obj = img;
      } catch (err) {
        console.warn('[canvas-engine] 图片加载失败:', layer.src, err);
        return null;
      }
    }

    return obj;
  }

  async addElement(kind, extra = {}) {
    const cx = this.docWidth / 2;
    const cy = this.docHeight / 2;
    const presets = {
      title: {
        type: 'text',
        name: '主标题',
        text: '新品限时首发',
        left: cx,
        top: Math.round(this.docHeight * 0.14),
        width: Math.round(this.docWidth * 0.78),
        fontSize: 54,
        fontWeight: '800',
        fill: '#111827',
        textAlign: 'center',
      },
      subtitle: {
        type: 'text',
        name: '卖点文案',
        text: '轻盈透气 · 显瘦版型 · 顺丰包邮',
        left: cx,
        top: Math.round(this.docHeight * 0.24),
        width: Math.round(this.docWidth * 0.72),
        fontSize: 24,
        fontWeight: '600',
        fill: '#475569',
        textAlign: 'center',
      },
      badge: {
        type: 'badge',
        name: '促销贴纸',
        text: '限时 8.5 折',
        left: Math.round(this.docWidth * 0.76),
        top: Math.round(this.docHeight * 0.26),
        width: 176,
        height: 54,
        rx: 27,
        angle: -8,
        bg: '#ef4444',
        fill: '#ffffff',
        fontSize: 22,
        fontWeight: '800',
      },
      rect: {
        type: 'rect',
        name: '圆角卡片',
        left: cx,
        top: cy,
        width: 320,
        height: 160,
        rx: 18,
        bg: '#f1f5f9',
      },
      mask: {
        type: 'rect',
        name: '白色遮盖框',
        left: cx,
        top: cy,
        width: 180,
        height: 32,
        rx: 0,
        bg: '#ffffff',
      },
      text_fill: {
        type: 'text',
        name: '填入文字',
        text: '输入文字',
        left: cx,
        top: cy,
        width: 220,
        fontSize: 20,
        fontWeight: '400',
        fontFamily: 'KaiTi, STKaiti, serif',
        fill: '#111827',
        textAlign: 'left',
      },
      circle: {
        type: 'circle',
        name: '圆形装饰',
        left: cx,
        top: cy,
        radius: 72,
        bg: '#fde68a',
      },
      line: {
        type: 'line',
        name: '分割线',
        left: cx,
        top: cy,
        width: 360,
        stroke: '#1e293b',
        strokeWidth: 3,
      },
      image: {
        type: 'image',
        name: extra.name || '本地图片',
        src: extra.src,
        left: cx,
        top: cy,
        width: extra.width || Math.round(this.docWidth * 0.55),
        height: extra.height || Math.round(this.docHeight * 0.55),
      },
    };

    if (kind === 'image' && extra.dataUrl && extra.src) {
      this.assetMap[extra.src] = extra.dataUrl;
    }

    const spec = { ...(presets[kind] || presets.rect), ...extra };
    const obj = await this.createFabricObject(spec);
    if (!obj) return null;
    this.canvas.add(obj);
    this.canvas.setActiveObject(obj);
    this.canvas.requestRenderAll();
    this.pushHistory();
    this.cb.onChange?.();
    this.cb.onSelectionChange?.(this.getSelectedProps());
    this.cb.onLayersChange?.(this.getLayersList());
    return obj;
  }

  getActiveObject() {
    return this.canvas?.getActiveObject() || null;
  }

  getSelectedProps() {
    const obj = this.getActiveObject();
    if (!obj) {
      // 若当前处于 PDF 原文字的无损选中状态，直接返回其真实属性（不产生任何画布修改）
      if (this.pdfMode && this.pdfSelectedText) {
        const t = this.pdfSelectedText;
        return {
          id: t.id,
          type: 'pdf-virtual-text',
          name: `${t.text.slice(0, 12)} (原文字·未改动)`,
          isPdfVirtual: true,
          isPromotedPdfText: false,
          locked: false,
          isText: true,
          isBadge: false,
          x: Math.round(t.x + t.w / 2),
          y: Math.round(t.y + t.h / 2),
          w: Math.round(t.w),
          h: Math.round(t.h),
          angle: 0,
          opacity: 100,
          text: t.text,
          fontSize: Number(t.fontSize || 12),
          fontWeight: String(t.fontWeight || '400'),
          fontFamily: t.fontFamily || '"Times New Roman", SimSun, "Songti SC", serif',
          textAlign: 'left',
          fill: t.color || '#111827',
          bg: '#ffffff',
          stroke: '#000000',
          strokeWidth: 0,
          radius: 0,
          hasShadow: false,
        };
      }
      return null;
    }
    const meta = obj.vcsMeta || {};
    const type = meta.type || obj.type;
    const isBadge = type === 'badge';
    const isText = type === 'text' || obj.type === 'textbox';

    let text = '';
    let fontSize = 24;
    let fontWeight = '700';
    let fontFamily = '"Microsoft YaHei", "PingFang SC", sans-serif';
    let textAlign = 'center';
    let fill = '#111827';
    let bg = '#ef4444';
    let stroke = obj.stroke || '#000000';
    let strokeWidth = obj.strokeWidth || 0;
    let radius = meta.rx || obj.rx || 0;

    if (isBadge) {
      const [rect, label] = obj.getObjects();
      text = label?.text ?? meta.text ?? '';
      fontSize = label?.fontSize ?? meta.fontSize ?? 22;
      fontWeight = String(label?.fontWeight ?? meta.fontWeight ?? '700');
      fontFamily = label?.fontFamily ?? meta.fontFamily ?? fontFamily;
      fill = label?.fill || meta.fill || '#ffffff';
      bg = rect?.fill || meta.bg || '#ef4444';
      stroke = rect?.stroke || '#000000';
      strokeWidth = rect?.strokeWidth || 0;
      radius = rect?.rx || meta.rx || 0;
    } else if (isText) {
      text = obj.text || '';
      fontSize = Math.round((obj.fontSize || 32) * (obj.scaleY || 1) * 2) / 2;
      fontWeight = String(obj.fontWeight || '700');
      fontFamily = obj.fontFamily || fontFamily;
      textAlign = obj.textAlign || 'center';
      fill = typeof obj.fill === 'string' ? obj.fill : '#111827';
      bg = obj.backgroundColor || '#ffffff';
    } else {
      fill = meta.isRasterBase
        ? (meta.bgColor || this.rasterBgColor || this.background || '#ffffff')
        : meta.isExtractedElement
          ? (meta.dominantColor || '#ffffff')
          : (typeof obj.fill === 'string' ? obj.fill : '#e2e8f0');
      bg = fill;
    }

    return {
      id: meta.id || '',
      type,
      name: meta.name || type,
      isPdfVirtual: false,
      isPromotedPdfText: Boolean(meta.pdfOrigId),
      isExtractedElement: Boolean(meta.isExtractedElement),
      isRasterBase: Boolean(meta.isRasterBase),
      locked: !!meta.locked,
      isText: isText || isBadge,
      isBadge,
      x: Math.round(obj.left ?? 0),
      y: Math.round(obj.top ?? 0),
      w: Math.round(obj.getScaledWidth()),
      h: Math.round(obj.getScaledHeight()),
      angle: normalizeAngle(obj.angle ?? 0),
      opacity: Math.round((obj.opacity ?? 1) * 100),
      text,
      fontSize,
      fontWeight,
      fontFamily,
      textAlign,
      fill,
      bg,
      stroke,
      strokeWidth,
      radius,
      hasShadow: Boolean(obj.shadow),
    };
  }

  async updateSelected(patch, recordHistory = true) {
    let obj = this.getActiveObject();
    if (!obj && this.pdfMode && this.pdfSelectedText) {
      // 用户在右侧真正改了某项属性，此时按需转换为可编辑文本框再应用改动
      obj = await this.promotePdfTextToEditable(this.pdfSelectedText, { enterEditing: false });
    }
    if (!obj) return;
    const meta = obj.vcsMeta || {};
    const isBadge = meta.type === 'badge';
    const isText = meta.type === 'text' || obj.type === 'textbox';

    if (patch.x !== undefined) obj.set('left', Number(patch.x));
    if (patch.y !== undefined) obj.set('top', Number(patch.y));
    if (patch.angle !== undefined) obj.set('angle', normalizeAngle(Number(patch.angle)));
    if (patch.opacity !== undefined) obj.set('opacity', clamp(Number(patch.opacity) / 100, 0, 1));

    if (patch.w !== undefined && Number(patch.w) >= 4) {
      const w = Number(patch.w);
      if (isText) {
        obj.set({ width: w, scaleX: 1 });
      } else if (obj.width) {
        obj.set('scaleX', w / obj.width);
      }
    }
    if (patch.h !== undefined && Number(patch.h) >= 4) {
      const h = Number(patch.h);
      if (!isText && obj.height) {
        obj.set('scaleY', h / obj.height);
      }
    }

    if (isBadge) {
      const [rect, label] = obj.getObjects();
      if (patch.text !== undefined && label) {
        label.set('text', patch.text);
        meta.text = patch.text;
        meta.name = patch.text.slice(0, 12) || '促销贴纸';
      }
      if (patch.fontSize !== undefined && label) {
        label.set('fontSize', Number(patch.fontSize));
        meta.fontSize = Number(patch.fontSize);
      }
      if (patch.fontWeight !== undefined && label) {
        label.set('fontWeight', patch.fontWeight);
        meta.fontWeight = patch.fontWeight;
      }
      if (patch.fontFamily !== undefined && label) {
        label.set('fontFamily', patch.fontFamily);
        meta.fontFamily = patch.fontFamily;
      }
      if (patch.fill !== undefined && label) {
        label.set('fill', patch.fill);
        meta.fill = patch.fill;
      }
      if (patch.bg !== undefined && rect) {
        rect.set('fill', patch.bg);
        meta.bg = patch.bg;
      }
      if (patch.stroke !== undefined && rect) rect.set('stroke', patch.stroke);
      if (patch.strokeWidth !== undefined && rect) rect.set('strokeWidth', Number(patch.strokeWidth));
      if (patch.radius !== undefined && rect) {
        const r = Number(patch.radius);
        rect.set({ rx: r, ry: r });
        meta.rx = r;
      }
      obj.dirty = true;
    } else if (isText) {
      if (patch.text !== undefined) {
        obj.set('text', patch.text);
        meta.name = patch.text.slice(0, 14) || '文字';
      }
      if (patch.fontSize !== undefined) obj.set('fontSize', Number(patch.fontSize));
      if (patch.fontWeight !== undefined) obj.set('fontWeight', patch.fontWeight);
      if (patch.fontFamily !== undefined) obj.set('fontFamily', patch.fontFamily);
      if (patch.textAlign !== undefined) obj.set('textAlign', patch.textAlign);
      if (patch.fill !== undefined) obj.set('fill', patch.fill);
      if (patch.stroke !== undefined) obj.set('stroke', patch.stroke);
      if (patch.strokeWidth !== undefined) obj.set('strokeWidth', Number(patch.strokeWidth));
    } else {
      // 平面图背景底图换色（填充色 / 背景色任选其一都直接生效，黑底可一键换纯白/任意色）
      if ((patch.fill !== undefined || patch.bg !== undefined) && meta.isRasterBase) {
        const nextBg = patch.fill ?? patch.bg;
        await this.recolorRasterBase(nextBg, false);
      } else if (patch.fill !== undefined && meta.isExtractedElement && meta.origCutDataUrl) {
        // 对平面图抠离出的图形元素执行无损抗锯齿换色（例如把橙色弧线一键换成青色/金色）
        const seq = ++this._recolorSeq;
        const recolored = await recolorImageDataUrl(meta.origCutDataUrl, patch.fill);
        if (seq === this._recolorSeq) {
          meta.dominantColor = patch.fill;
          if (meta.src) this.assetMap[meta.src] = recolored;
          const nextImg = await FabricImage.fromURL(recolored, { crossOrigin: 'anonymous' });
          if (seq === this._recolorSeq) {
            obj.setElement(nextImg.getElement());
            obj.dirty = true;
          }
        }
      } else if (patch.fill !== undefined && meta.type !== 'image') {
        obj.set('fill', patch.fill);
      }
      if (patch.bg !== undefined && meta.type !== 'image') obj.set('fill', patch.bg);
      if (patch.stroke !== undefined) obj.set('stroke', patch.stroke);
      if (patch.strokeWidth !== undefined) obj.set('strokeWidth', Number(patch.strokeWidth));
      if (patch.radius !== undefined) {
        const r = Number(patch.radius);
        meta.rx = r;
        if (meta.type === 'rect') {
          obj.set({ rx: r, ry: r });
        } else if (meta.type === 'image') {
          if (r > 0) {
            obj.clipPath = new Rect({
              width: obj.width,
              height: obj.height,
              rx: r / (obj.scaleX || 1),
              ry: r / (obj.scaleY || 1),
              originX: 'center',
              originY: 'center',
            });
          } else {
            obj.clipPath = null;
          }
        }
      }
    }

    if (patch.hasShadow !== undefined) {
      obj.set('shadow', patch.hasShadow ? makeShadow({}) : null);
    }

    obj.setCoords();
    this.canvas.requestRenderAll();
    if (recordHistory) {
      this.pushHistory();
      this.cb.onChange?.();
    }
    this.cb.onSelectionChange?.(this.getSelectedProps());
    this.cb.onLayersChange?.(this.getLayersList());
  }

  async alignSelected(mode) {
    let obj = this.getActiveObject();
    if (!obj && this.pdfMode && this.pdfSelectedText) {
      obj = await this.promotePdfTextToEditable(this.pdfSelectedText, { enterEditing: false });
    }
    if (!obj) return;
    const bw = obj.getBoundingRect().width / this.zoom;
    const bh = obj.getBoundingRect().height / this.zoom;
    if (mode === 'center-h') obj.set('left', this.docWidth / 2);
    if (mode === 'center-v') obj.set('top', this.docHeight / 2);
    if (mode === 'left') obj.set('left', bw / 2 + 24);
    if (mode === 'right') obj.set('left', this.docWidth - bw / 2 - 24);
    if (mode === 'top') obj.set('top', bh / 2 + 24);
    if (mode === 'bottom') obj.set('top', this.docHeight - bh / 2 - 24);
    obj.setCoords();
    this.canvas.requestRenderAll();
    this.pushHistory();
    this.cb.onChange?.();
    this.cb.onSelectionChange?.(this.getSelectedProps());
  }

  async rotateSelected(deltaOrReset) {
    let obj = this.getActiveObject();
    if (!obj && this.pdfMode && this.pdfSelectedText) {
      obj = await this.promotePdfTextToEditable(this.pdfSelectedText, { enterEditing: false });
    }
    if (!obj) return;
    const next = deltaOrReset === 'reset' ? 0 : normalizeAngle((obj.angle || 0) + Number(deltaOrReset));
    obj.set('angle', next);
    obj.setCoords();
    this.canvas.requestRenderAll();
    this.pushHistory();
    this.cb.onChange?.();
    this.cb.onSelectionChange?.(this.getSelectedProps());
  }

  async nudgeSelected(dx, dy) {
    let obj = this.getActiveObject();
    if (!obj && this.pdfMode && this.pdfSelectedText) {
      obj = await this.promotePdfTextToEditable(this.pdfSelectedText, { enterEditing: false });
    }
    if (!obj) return;
    obj.set({ left: (obj.left || 0) + dx, top: (obj.top || 0) + dy });
    obj.setCoords();
    this.canvas.requestRenderAll();
    this.pushHistory();
    this.cb.onChange?.();
    this.cb.onSelectionChange?.(this.getSelectedProps());
  }

  async layerAction(action, targetId = null) {
    const objs = this.canvas.getObjects();
    let obj = targetId
      ? objs.find((o) => o.vcsMeta?.id === targetId)
      : this.getActiveObject();

    // 若当前无损选中了 PDF 原文字且点“删除”，直接擦除该行原文字
    if (!obj && this.pdfMode && this.pdfSelectedText) {
      if (action === 'del') {
        const item = this.pdfSelectedText;
        const redactEntry = { id: item.id, x: item.x, y: item.y, w: item.w, h: item.h, mode: 'text' };
        this.pdfRedactions.push(redactEntry);
        this.addRedactionPreviewRect(redactEntry);
        this.pdfSelectedText = null;
        this.canvas.requestRenderAll();
        this.pushHistory();
        this.cb.onChange?.();
        this.cb.onSelectionChange?.(null);
        this.cb.onToast?.('已擦除该行 PDF 原文字（可 Ctrl+Z 撤销）');
        return;
      }
      if (action === 'dup') {
        obj = await this.promotePdfTextToEditable(this.pdfSelectedText, { enterEditing: false });
      }
    }
    if (!obj) return;

    if (action === 'up') this.canvas.bringObjectForward(obj);
    else if (action === 'down') this.canvas.sendObjectBackwards(obj);
    else if (action === 'front') this.canvas.bringObjectToFront(obj);
    else if (action === 'back') this.canvas.sendObjectToBack(obj);
    else if (action === 'del') {
      this.canvas.remove(obj);
      this.canvas.discardActiveObject();
    } else if (action === 'dup') {
      const layerData = this.serializeObject(obj);
      layerData.id = `${layerData.type}_${Date.now()}_${this.idSeq++}`;
      layerData.name = `${layerData.name} 副本`;
      layerData.left = (layerData.left ?? this.docWidth / 2) + 20;
      layerData.top = (layerData.top ?? this.docHeight / 2) + 20;
      const clone = await this.createFabricObject(layerData);
      if (clone) {
        this.canvas.add(clone);
        this.canvas.setActiveObject(clone);
      }
    } else if (action === 'toggle-vis') {
      obj.set('visible', !obj.visible);
    } else if (action === 'toggle-lock') {
      const locked = !obj.vcsMeta?.locked;
      obj.vcsMeta = { ...(obj.vcsMeta || {}), locked };
      obj.set({ selectable: !locked, evented: !locked });
      if (locked && this.getActiveObject() === obj) {
        this.canvas.discardActiveObject();
      }
    }

    this.canvas.requestRenderAll();
    this.pushHistory();
    this.cb.onChange?.();
    this.cb.onSelectionChange?.(this.getSelectedProps());
    this.cb.onLayersChange?.(this.getLayersList());
  }

  selectById(id) {
    const obj = this.canvas.getObjects().find((o) => o.vcsMeta?.id === id);
    if (!obj) return;
    if (obj.vcsMeta?.locked) {
      obj.vcsMeta.locked = false;
      obj.set({ selectable: true, evented: true });
    }
    this.canvas.setActiveObject(obj);
    this.canvas.requestRenderAll();
    this.cb.onSelectionChange?.(this.getSelectedProps());
    this.cb.onLayersChange?.(this.getLayersList());
  }

  getLayersList() {
    if (!this.canvas) return [];
    const active = this.getActiveObject();
    return [...this.canvas.getObjects()]
      .filter((obj) => !obj.vcsMeta?.isRedactionPreview)
      .reverse()
      .map((obj) => ({
        id: obj.vcsMeta?.id || '',
        type: obj.vcsMeta?.type || obj.type,
        name: obj.vcsMeta?.name || obj.text?.slice(0, 14) || obj.type,
        visible: obj.visible !== false,
        locked: !!obj.vcsMeta?.locked,
        active: obj === active,
      }));
  }

  serializeObject(obj) {
    const meta = obj.vcsMeta || {};
    const type = meta.type || (obj.type === 'textbox' ? 'text' : obj.type);
    const base = {
      id: meta.id || `layer_${this.idSeq++}`,
      type,
      name: meta.name || type,
      left: Math.round((obj.left ?? 0) * 10) / 10,
      top: Math.round((obj.top ?? 0) * 10) / 10,
      width: Math.round(obj.getScaledWidth() * 10) / 10,
      height: Math.round(obj.getScaledHeight() * 10) / 10,
      angle: normalizeAngle(obj.angle ?? 0),
      opacity: Math.round((obj.opacity ?? 1) * 100) / 100,
      visible: obj.visible !== false,
      locked: !!meta.locked,
    };

    if (obj.shadow) {
      base.shadow = {
        color: obj.shadow.color,
        blur: obj.shadow.blur,
        offsetX: obj.shadow.offsetX,
        offsetY: obj.shadow.offsetY,
      };
    }

    if (type === 'text') {
      const renderedLines = Array.isArray(obj._textLines) && obj._textLines.length
        ? obj._textLines.map((chars) => (Array.isArray(chars) ? chars.join('') : String(chars)))
        : String(obj.text || '').split(/\r?\n/);
      return {
        ...base,
        text: obj.text || '',
        renderedLines,
        fontSize: Math.round((obj.fontSize || 32) * (obj.scaleY || 1) * 2) / 2,
        fontWeight: obj.fontWeight || '700',
        fontFamily: obj.fontFamily || 'Microsoft YaHei, PingFang SC, sans-serif',
        fill: typeof obj.fill === 'string' ? obj.fill : '#111827',
        textAlign: obj.textAlign || 'center',
        lineHeight: obj.lineHeight ?? 1.2,
        charSpacing: obj.charSpacing ?? 0,
        ...(obj.stroke ? { stroke: obj.stroke, strokeWidth: obj.strokeWidth || 0 } : {}),
        ...(obj.backgroundColor ? { bg: obj.backgroundColor } : {}),
      };
    }

    if (type === 'badge') {
      const [rect, label] = obj.getObjects();
      return {
        ...base,
        text: label?.text ?? meta.text ?? '',
        fontSize: Math.round((label?.fontSize ?? 22) * (obj.scaleY || 1)),
        fontWeight: label?.fontWeight ?? '700',
        fontFamily: label?.fontFamily || 'Microsoft YaHei, PingFang SC, sans-serif',
        fill: label?.fill || '#ffffff',
        bg: rect?.fill || '#ef4444',
        rx: Math.round((rect?.rx ?? 0) * (obj.scaleX || 1)),
        ...(rect?.stroke ? { stroke: rect.stroke, strokeWidth: rect.strokeWidth || 0 } : {}),
      };
    }

    if (type === 'image') {
      return {
        ...base,
        src: meta.src || '',
        ...(this.pdfMode && this.assetMap[meta.src] ? { dataUrl: this.assetMap[meta.src] } : {}),
        rx: meta.rx || 0,
        ...(meta.isRasterBase ? { isRasterBase: true, bgColor: meta.bgColor || this.rasterBgColor || this.background } : {}),
        ...(meta.isExtractedElement ? { isExtractedElement: true, dominantColor: meta.dominantColor || '#ffffff' } : {}),
      };
    }

    if (type === 'circle') {
      return {
        ...base,
        radius: Math.round((obj.radius || 50) * (obj.scaleX || 1) * 10) / 10,
        bg: typeof obj.fill === 'string' ? obj.fill : '#fbbf24',
        ...(obj.stroke ? { stroke: obj.stroke, strokeWidth: obj.strokeWidth || 0 } : {}),
      };
    }

    if (type === 'line') {
      return {
        ...base,
        stroke: obj.stroke || '#1e293b',
        strokeWidth: obj.strokeWidth || 3,
      };
    }

    return {
      ...base,
      bg: typeof obj.fill === 'string' ? obj.fill : '#e2e8f0',
      rx: obj.rx ?? 0,
      ry: obj.ry ?? 0,
      ...(obj.stroke ? { stroke: obj.stroke, strokeWidth: obj.strokeWidth || 0 } : {}),
    };
  }

  serialize() {
    const layers = (this.canvas?.getObjects() || []).map((o) => this.serializeObject(o));
    return {
      format: 'visual-canvas-studio',
      version: 1,
      name: this.docName,
      width: this.docWidth,
      height: this.docHeight,
      background: this.background,
      ...(this.backgroundGradient ? { backgroundGradient: this.backgroundGradient } : {}),
      layers,
      updatedAt: new Date().toISOString(),
    };
  }

  pushHistory() {
    const snap = this.pdfMode ? this.getPdfPageEdit() : this.serialize();
    if (this.rasterMode) {
      snap._rasterState = {
        untintedKey: this.rasterUntintedKey || '',
        liftedIds: Array.from(this.rasterLiftedIds || []),
        bgColor: this.rasterBgColor || '',
      };
    }
    this.history = this.history.slice(0, this.historyIdx + 1);
    this.history.push(snap);
    if (this.history.length > 40) this.history.shift();
    this.historyIdx = this.history.length - 1;
    this.cb.onHistoryChange?.(this.historyIdx > 0, false);
  }

  async undo() {
    if (this.historyIdx <= 0) return;
    this.historyIdx--;
    await this.restoreSnapshot(this.history[this.historyIdx]);
  }

  async redo() {
    if (this.historyIdx >= this.history.length - 1) return;
    this.historyIdx++;
    await this.restoreSnapshot(this.history[this.historyIdx]);
  }

  async restoreSnapshot(snap) {
    this.isRestoring = true;
    const prevZoom = this.zoom;
    if (this.pdfMode) {
      const savedBg = this.canvas.backgroundImage;
      this.canvas.clear();
      this.canvas.backgroundImage = savedBg;
      this.canvas.backgroundColor = '#ffffff';
      this.zoom = prevZoom;
      this.applyCanvasDimensions();
      this.pdfRedactions = Array.isArray(snap.redactions) ? snap.redactions.map((r) => ({ ...r })) : [];
      for (const r of this.pdfRedactions) {
        this.addRedactionPreviewRect(r);
      }
      for (const layer of snap.layers || []) {
        const obj = await this.createFabricObject(layer);
        if (obj) {
          if (layer.id === 'raster_base' || layer.isRasterBase) {
            obj.vcsMeta.isRasterBase = true;
            obj.vcsMeta.bgColor = layer.bgColor || this.background;
            this.rasterBgColor = layer.bgColor || '';
            this.rasterBaseObj = obj;
          }
          if (layer.isExtractedElement) {
            obj.vcsMeta.isExtractedElement = true;
            obj.vcsMeta.dominantColor = layer.dominantColor || '#ffffff';
            obj.vcsMeta.origCutDataUrl = this._origCutMap?.[layer.id] || this.assetMap[layer.src];
          }
          this.canvas.add(obj);
        }
      }
    } else {
      this.docWidth = snap.width;
      this.docHeight = snap.height;
      this.background = snap.background;
      this.backgroundGradient = snap.backgroundGradient || null;
      this.canvas.clear();
      this.zoom = prevZoom;
      this.applyCanvasDimensions();
      this.applyBackground();
      for (const layer of snap.layers || []) {
        const obj = await this.createFabricObject(layer);
        if (obj) {
          if (layer.id === 'raster_base' || layer.isRasterBase) {
            obj.vcsMeta.isRasterBase = true;
            obj.vcsMeta.bgColor = layer.bgColor || this.background;
            this.rasterBgColor = layer.bgColor || '';
            this.rasterBaseObj = obj;
          }
          if (layer.isExtractedElement) {
            obj.vcsMeta.isExtractedElement = true;
            obj.vcsMeta.dominantColor = layer.dominantColor || '#ffffff';
            obj.vcsMeta.origCutDataUrl = this._origCutMap?.[layer.id] || this.assetMap[layer.src];
          }
          this.canvas.add(obj);
        }
      }
    }
    this.canvas.renderAll();
    if (this.rasterMode && snap._rasterState) {
      this.rasterLiftedIds = new Set(snap._rasterState.liftedIds || []);
      this.rasterBgColor = snap._rasterState.bgColor || '';
      if (snap._rasterState.untintedKey) {
        this.rasterUntintedKey = snap._rasterState.untintedKey;
        await this.restoreUntintedRgbaFromKey(snap._rasterState.untintedKey);
      }
      this.cb.onRasterStatus?.({
        total: this.rasterElements.length,
        remaining: Math.max(0, this.rasterElements.length - this.rasterLiftedIds.size),
        pickEnabled: this.rasterPickEnabled,
        boxMode: this.rasterBoxMode,
        bgLocked: Boolean(this.rasterBaseObj?.vcsMeta?.locked),
        segMode: this.rasterSegMode,
      });
    }
    this.isRestoring = false;
    this.cb.onHistoryChange?.(this.historyIdx > 0, this.historyIdx < this.history.length - 1);
    this.cb.onSelectionChange?.(null);
    this.cb.onLayersChange?.(this.getLayersList());
    this.cb.onChange?.();
  }

  exportDataUrl(format = 'png', scale = 2) {
    if (!this.canvas) return null;
    const prevZoom = this.zoom;
    const active = this.canvas.getActiveObject();
    this.snapLines = { v: null, h: null };
    this.canvas.discardActiveObject();
    this.canvas.setDimensions({ width: this.docWidth, height: this.docHeight });
    this.canvas.setZoom(1);
    this.canvas.renderAll();

    const dataUrl = this.canvas.toDataURL({
      format: format === 'jpeg' ? 'jpeg' : 'png',
      quality: format === 'jpeg' ? 0.94 : 1,
      multiplier: Number(scale) || 2,
    });

    this.zoom = prevZoom;
    this.applyCanvasDimensions();
    if (active) this.canvas.setActiveObject(active);
    this.canvas.requestRenderAll();
    return dataUrl;
  }
}
