/**
 * PDF 渲染、文字提取、真正红涂擦除与中文字体矢量回写引擎
 * - 渲染与文字/图片位置提取：基于 Artifex MuPDF (WASM, 内置 CJK 字体回退)
 * - 文本擦除（红涂 Redact）：仅擦除被替换/删除的原文字，保留下划线与背景图无损
 * - 矢量写回：基于 pdf-lib + @pdf-lib/fontkit，自动子集嵌入本机 TTF 中文字体，未编辑页面 100% 保持原样矢量无损
 */
import * as mupdf from 'mupdf';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';

// Windows 系统单面 TTF 中文字体映射表（避免 .ttc 集合触发 fontkit 子集化限制）
const WIN_FONTS_DIR = 'C:\\Windows\\Fonts';
const FONT_CANDIDATES = {
  simhei: ['simhei.ttf', 'STXIHEI.TTF', 'Dengb.ttf', 'Deng.ttf'],
  kaiti: ['simkai.ttf', 'STKAITI.TTF', 'simfang.ttf', 'simhei.ttf'],
  fangsong: ['simfang.ttf', 'STFANGSO.TTF', 'STSONG.TTF', 'simkai.ttf'],
  songti: ['STSONG.TTF', 'STZHONGS.TTF', 'simfang.ttf', 'simhei.ttf'],
  yahei: ['Deng.ttf', 'STXIHEI.TTF', 'simhei.ttf'],
  yahei_bold: ['Dengb.ttf', 'simhei.ttf', 'Deng.ttf'],
  lishu: ['SIMLI.TTF', 'simkai.ttf', 'simhei.ttf'],
};

const fontBufferCache = new Map();

function pickFontKey(fontFamily = '', fontWeight = '400') {
  const f = String(fontFamily || '').toLowerCase();
  const isBold = Number(fontWeight) >= 650 || f.includes('bold') || fontWeight === 'bold';
  if (f.includes('kai') || f.includes('楷')) return 'kaiti';
  if (f.includes('fang') || f.includes('仿宋')) return 'fangsong';
  if (f.includes('song') || f.includes('sun') || f.includes('宋') || f.includes('georgia') || f.includes('times')) return 'songti';
  if (f.includes('simhei') || f.includes('heiti') || f.includes('黑体') || f.includes('impact')) return 'simhei';
  if (f.includes('li') && (f.includes('simli') || f.includes('隶'))) return 'lishu';
  return isBold ? 'yahei_bold' : 'yahei';
}

function loadFontBytes(fontKey) {
  if (fontBufferCache.has(fontKey)) return fontBufferCache.get(fontKey);
  const list = [
    ...(FONT_CANDIDATES[fontKey] || []),
    'simhei.ttf',
    'Deng.ttf',
    'STSONG.TTF',
    'simkai.ttf',
    'arial.ttf',
  ];
  for (const fname of list) {
    const p = join(WIN_FONTS_DIR, fname);
    if (existsSync(p)) {
      const buf = readFileSync(p);
      fontBufferCache.set(fontKey, buf);
      return buf;
    }
  }
  return null;
}

/**
 * 将 PDF 内嵌字体名映射为编辑器下拉框对应的 CSS 字体族，实现原位改字风格一致
 */
function mapPdfFontToCss(pdfFontName = '') {
  const n = String(pdfFontName || '').toLowerCase();
  if (n.includes('kai') || n.includes('stkaiti')) return 'KaiTi, STKaiti, serif';
  if (n.includes('fang') || n.includes('stfang')) return 'FangSong, STFangsong, serif';
  if (n.includes('song') || n.includes('simsun') || n.includes('ming')) {
    return '"Times New Roman", SimSun, "Songti SC", serif';
  }
  if (n.includes('simhei') || n.includes('heiti')) return 'SimHei, "Heiti SC", sans-serif';
  if (n.includes('times') || n.includes('georgia') || n.includes('serif')) {
    return 'Georgia, "Times New Roman", serif';
  }
  return '"Microsoft YaHei", "PingFang SC", sans-serif';
}

function parseHexToRgb(colorStr, fallback = [0, 0, 0]) {
  if (!colorStr || typeof colorStr !== 'string') return rgb(fallback[0], fallback[1], fallback[2]);
  const s = colorStr.trim();
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length >= 6) {
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return rgb(r, g, b);
      }
    }
  }
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (m) {
    return rgb(Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255);
  }
  return rgb(fallback[0], fallback[1], fallback[2]);
}

function intColorToHex(c) {
  if (typeof c === 'string' && c.startsWith('#')) return c;
  if (typeof c === 'number' && Number.isFinite(c)) {
    return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  return '#111827';
}

function rgbArrayToHex(colorArr) {
  if (Array.isArray(colorArr) && colorArr.length >= 3) {
    const toByte = (v) => Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255)));
    return `#${toByte(colorArr[0]).toString(16).padStart(2, '0')}${toByte(colorArr[1]).toString(16).padStart(2, '0')}${toByte(colorArr[2]).toString(16).padStart(2, '0')}`;
  }
  return intColorToHex(colorArr);
}

/**
 * 渲染 PDF 指定页为 2x 高清 PNG，并提取页面所有可原位编辑的文字行与图片区域
 * 使用 st.walk() 逐字符统计主中文字体、0.5pt 精确字号与多数粗细，避免中英混排行被首个英文词误判字体与粗细
 */
export function renderPdfPage(filePath, pageIndex = 0, scale = 2) {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`PDF 文件不存在: ${absPath}`);
  }
  const pdfBytes = readFileSync(absPath);
  const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
  const pageCount = doc.countPages();
  if (pageCount <= 0) {
    throw new Error('PDF 不包含任何页面');
  }
  const safeIndex = Math.max(0, Math.min(Number(pageIndex) || 0, pageCount - 1));
  const page = doc.loadPage(safeIndex);
  const bounds = page.getBounds(); // [x0, y0, x1, y1]
  const width = Math.round((bounds[2] - bounds[0]) * 100) / 100;
  const height = Math.round((bounds[3] - bounds[1]) * 100) / 100;

  // 渲染清晰底图（2x Retina）
  const safeScale = Math.max(1, Math.min(Number(scale) || 2, 3));
  const pixmap = page.toPixmap(
    mupdf.Matrix.scale(safeScale, safeScale),
    mupdf.ColorSpace.DeviceRGB,
    false,
    true,
  );
  const pngBytes = pixmap.asPNG();
  const bgDataUrl = `data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}`;

  // 用 st.walk() 精确提取每行文字的真实浮点字号（如 10.5pt）、主中文字体、多数加粗与 RGB 颜色
  const stext = page.toStructuredText('preserve-whitespace');
  const textItems = [];
  const imageItems = [];
  let tSeq = 1;
  let iSeq = 1;
  let curLine = null;

  stext.walk({
    beginLine(bbox) {
      curLine = { bbox, chars: [] };
    },
    onChar(c, _origin, font, size, _quad, color) {
      if (!curLine) return;
      curLine.chars.push({
        c,
        fontName: font?.getName?.() || '',
        bold: Boolean(font?.isBold?.()),
        size: Number(size) || 0,
        color,
      });
    },
    endLine() {
      if (!curLine || !curLine.chars.length) {
        curLine = null;
        return;
      }
      const rawText = curLine.chars.map((x) => x.c).join('');
      const trimmed = rawText.trim();
      const bb = curLine.bbox || [0, 0, 0, 0];
      const w = bb[2] - bb[0];
      const h = bb[3] - bb[1];
      if (trimmed && w >= 2 && h >= 2) {
        const nonSpace = curLine.chars.filter((x) => x.c.trim());
        const cjkChars = nonSpace.filter((x) => /[\u4e00-\u9fff]/.test(x.c));
        const fontPool = cjkChars.length ? cjkChars : nonSpace;

        const fontCounts = {};
        const sizeCounts = {};
        const colorCounts = {};
        let boldCount = 0;

        for (const ch of fontPool) {
          fontCounts[ch.fontName] = (fontCounts[ch.fontName] || 0) + 1;
          if (ch.bold) boldCount++;
          const halfPt = Math.round((ch.size || h * 0.85) * 2) / 2;
          sizeCounts[halfPt] = (sizeCounts[halfPt] || 0) + 1;
          const hex = rgbArrayToHex(ch.color);
          colorCounts[hex] = (colorCounts[hex] || 0) + 1;
        }

        const domFont = Object.entries(fontCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
        const domSize = Number(Object.entries(sizeCounts).sort((a, b) => b[1] - a[1])[0]?.[0]) || Math.round(h * 1.7) / 2;
        const domColor = Object.entries(colorCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '#111827';
        // 只有超过半数有效字符本身是粗体时才标为 700，防止单个加粗英文关键词污染整行
        const isBold = fontPool.length > 0 && boldCount > fontPool.length * 0.55;

        textItems.push({
          id: `pt_${safeIndex}_${tSeq++}`,
          text: rawText.trimEnd(),
          x: Math.round((bb[0] - bounds[0]) * 10) / 10,
          y: Math.round((bb[1] - bounds[1]) * 10) / 10,
          w: Math.round(w * 10) / 10,
          h: Math.round(h * 10) / 10,
          fontName: domFont,
          fontFamily: mapPdfFontToCss(domFont),
          fontSize: Math.max(6, domSize),
          fontWeight: isBold ? '700' : '400',
          color: domColor,
        });
      }
      curLine = null;
    },
    onImageBlock(bbox) {
      if (!bbox) return;
      const w = bbox[2] - bbox[0];
      const h = bbox[3] - bbox[1];
      if (w > 10 && h > 10) {
        imageItems.push({
          id: `pi_${safeIndex}_${iSeq++}`,
          x: Math.round((bbox[0] - bounds[0]) * 10) / 10,
          y: Math.round((bbox[1] - bounds[1]) * 10) / 10,
          w: Math.round(w * 10) / 10,
          h: Math.round(h * 10) / 10,
        });
      }
    },
  });

  return {
    pageIndex: safeIndex,
    pageCount,
    width,
    height,
    renderScale: safeScale,
    bgDataUrl,
    textItems,
    imageItems,
  };
}

/**
 * 将本地图片路径或 dataURL 加载为字节与格式供 pdf-lib 嵌入
 */
function resolveImageBytes(layer, baseDir) {
  if (layer.dataUrl && typeof layer.dataUrl === 'string') {
    const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(layer.dataUrl);
    if (m) {
      return {
        kind: m[1].toLowerCase().startsWith('jp') ? 'jpg' : 'png',
        bytes: Buffer.from(m[2], 'base64'),
      };
    }
  }
  if (layer.src && typeof layer.src === 'string') {
    const abs = isAbsolute(layer.src) ? normalize(layer.src) : resolve(baseDir, layer.src);
    if (existsSync(abs)) {
      const lower = abs.toLowerCase();
      return {
        kind: lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'jpg' : 'png',
        bytes: readFileSync(abs),
      };
    }
  }
  return null;
}

/**
 * 计算绕中心点旋转后的 PDF 局部点坐标
 * canvas 顺时针角度 angleDeg -> PDF 逆时针角度 rad = -angleDeg * PI / 180
 */
function rotateAroundPdfCenter(cx, cyPdf, localX, localY, angleDeg) {
  const rad = (-(Number(angleDeg) || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: cx + localX * cos - localY * sin,
    y: cyPdf + localX * sin + localY * cos,
  };
}

/**
 * 将用户在各页上做的红涂擦除与新增/修改图层无损矢量写回真实 PDF 文件
 */
export async function savePdfEdits({ filePath, outputPath, pageEdits = {} }) {
  const absIn = resolve(filePath);
  if (!existsSync(absIn)) {
    throw new Error(`源 PDF 不存在: ${absIn}`);
  }
  const absOut = outputPath ? resolve(outputPath) : absIn;
  const baseDir = dirname(absIn);

  let workingBytes = readFileSync(absIn);
  const editedPageIndices = Object.keys(pageEdits)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);

  // 第一阶段：使用 MuPDF 执行真正红涂擦除（仅移除旧文字，保留下划线与底图无损）
  const hasAnyRedactions = editedPageIndices.some(
    (idx) => Array.isArray(pageEdits[idx]?.redactions) && pageEdits[idx].redactions.length > 0,
  );

  if (hasAnyRedactions) {
    const mupdfDoc = mupdf.Document.openDocument(workingBytes, 'application/pdf').asPDF();
    for (const idx of editedPageIndices) {
      const redactions = pageEdits[idx]?.redactions || [];
      if (!redactions.length || idx >= mupdfDoc.countPages()) continue;
      const mPage = mupdfDoc.loadPage(idx);
      const bounds = mPage.getBounds();
      for (const r of redactions) {
        const x0 = bounds[0] + Number(r.x) - 1;
        const y0 = bounds[1] + Number(r.y) - 1;
        const x1 = bounds[0] + Number(r.x) + Number(r.w) + 1;
        const y1 = bounds[1] + Number(r.y) + Number(r.h) + 1;
        const annot = mPage.createAnnotation('Redact');
        annot.setRect([x0, y0, x1, y1]);
      }
      // black_boxes=false, image_method=0(保留图片), line_art=0(保留下划线/表格线), text_method=0(清除文字)
      mPage.applyRedactions(false, 0, 0, 0);
    }
    workingBytes = Buffer.from(mupdfDoc.saveToBuffer('compress').asUint8Array());
  }

  // 第二阶段：使用 pdf-lib + fontkit 写入矢量中文文字、遮盖矩形、形状与图片
  const pdfDoc = await PDFDocument.load(workingBytes);
  pdfDoc.registerFontkit(fontkit);
  const embeddedFonts = new Map();

  async function getEmbeddedFont(fontFamily, fontWeight) {
    const key = pickFontKey(fontFamily, fontWeight);
    if (embeddedFonts.has(key)) return embeddedFonts.get(key);
    const bytes = loadFontBytes(key);
    if (!bytes) {
      throw new Error(`未找到可用的中文字体 TTF 文件（${WIN_FONTS_DIR}）`);
    }
    const f = await pdfDoc.embedFont(bytes, { subset: true });
    embeddedFonts.set(key, f);
    return f;
  }

  for (const idx of editedPageIndices) {
    const layers = pageEdits[idx]?.layers || [];
    if (!layers.length || idx >= pdfDoc.getPageCount()) continue;

    const page = pdfDoc.getPage(idx);
    const { width: pageW, height: pageH } = page.getSize();

    for (const layer of layers) {
      if (layer.visible === false) continue;
      const cx = Number(layer.left ?? pageW / 2);
      const cy = Number(layer.top ?? pageH / 2);
      const cyPdf = pageH - cy;
      const w = Number(layer.width ?? 100);
      const h = Number(layer.height ?? 40);
      const angle = Number(layer.angle ?? 0);
      const opacity = layer.opacity !== undefined ? Number(layer.opacity) : 1;

      if (layer.type === 'rect') {
        const bl = rotateAroundPdfCenter(cx, cyPdf, -w / 2, -h / 2, angle);
        page.drawRectangle({
          x: bl.x,
          y: bl.y,
          width: w,
          height: h,
          color: parseHexToRgb(layer.bg || layer.fill || '#ffffff', [1, 1, 1]),
          opacity,
          rotate: degrees(-angle),
          ...(layer.stroke && Number(layer.strokeWidth) > 0
            ? {
                borderColor: parseHexToRgb(layer.stroke),
                borderWidth: Number(layer.strokeWidth),
                borderOpacity: opacity,
              }
            : {}),
        });
      } else if (layer.type === 'circle') {
        const rx = w / 2;
        const ry = h / 2;
        page.drawEllipse({
          x: cx,
          y: cyPdf,
          xScale: rx,
          yScale: ry,
          color: parseHexToRgb(layer.bg || layer.fill || '#fbbf24'),
          opacity,
          ...(layer.stroke && Number(layer.strokeWidth) > 0
            ? {
                borderColor: parseHexToRgb(layer.stroke),
                borderWidth: Number(layer.strokeWidth),
                borderOpacity: opacity,
              }
            : {}),
        });
      } else if (layer.type === 'line') {
        const p1 = rotateAroundPdfCenter(cx, cyPdf, -w / 2, 0, angle);
        const p2 = rotateAroundPdfCenter(cx, cyPdf, w / 2, 0, angle);
        page.drawLine({
          start: p1,
          end: p2,
          thickness: Math.max(0.5, Number(layer.strokeWidth ?? 2)),
          color: parseHexToRgb(layer.stroke || layer.fill || '#111827'),
          opacity,
        });
      } else if (layer.type === 'text') {
        const fontSize = Math.max(6, Number(layer.fontSize ?? 16));
        const font = await getEmbeddedFont(layer.fontFamily, layer.fontWeight);
        const color = parseHexToRgb(layer.fill || '#111827');
        const lineHeight = Number(layer.lineHeight ?? 1.2);
        const lineStep = fontSize * lineHeight;
        // 优先使用前端 Fabric 折行后的精确行数组，确保与画布所见 100% 一致
        const lines = Array.isArray(layer.renderedLines) && layer.renderedLines.length
          ? layer.renderedLines
          : String(layer.text || '').split(/\r?\n/);

        // 若文字本身带背景填充色，先画底衬矩形
        if (layer.bg) {
          const bl = rotateAroundPdfCenter(cx, cyPdf, -w / 2, -h / 2, angle);
          page.drawRectangle({
            x: bl.x,
            y: bl.y,
            width: w,
            height: h,
            color: parseHexToRgb(layer.bg, [1, 1, 1]),
            opacity,
            rotate: degrees(-angle),
          });
        }

        const totalH = Math.max(h, lines.length * lineStep);
        const align = layer.textAlign || 'left';

        for (let i = 0; i < lines.length; i++) {
          const lineText = String(lines[i] ?? '');
          if (!lineText) continue;
          let lineW = 0;
          try {
            lineW = font.widthOfTextAtSize(lineText, fontSize);
          } catch {
            lineW = lineText.length * fontSize * 0.7;
          }
          let localX = -w / 2;
          if (align === 'center') localX = -lineW / 2;
          else if (align === 'right') localX = w / 2 - lineW;

          // 基线位置：距该行顶部约 0.84 倍字号，确保中文字垂直对齐贴合下划线
          const localY = (totalH / 2) - (i * lineStep) - (fontSize * 0.84);
          const pt = rotateAroundPdfCenter(cx, cyPdf, localX, localY, angle);
          const drawOpts = {
            x: pt.x,
            y: pt.y,
            size: fontSize,
            font,
            color,
            opacity,
            rotate: degrees(-angle),
          };
          page.drawText(lineText, drawOpts);
          // 对没有独立 Bold 字重的楷体/宋体/仿宋，按 Word 合成粗体方式微偏移补描，保证加粗视觉一致
          const isBold = Number(layer.fontWeight) >= 650 || layer.fontWeight === 'bold';
          if (isBold) {
            const shift = Math.max(0.28, fontSize * 0.022);
            page.drawText(lineText, { ...drawOpts, x: pt.x + shift, y: pt.y });
            page.drawText(lineText, { ...drawOpts, x: pt.x, y: pt.y + shift * 0.6 });
          }
        }
      } else if (layer.type === 'badge') {
        // 绘制徽章背景 + 居中中文矢量文字
        const bl = rotateAroundPdfCenter(cx, cyPdf, -w / 2, -h / 2, angle);
        page.drawRectangle({
          x: bl.x,
          y: bl.y,
          width: w,
          height: h,
          color: parseHexToRgb(layer.bg || '#ef4444'),
          opacity,
          rotate: degrees(-angle),
        });
        const label = String(layer.text || '');
        if (label) {
          const fontSize = Math.max(8, Number(layer.fontSize ?? 16));
          const font = await getEmbeddedFont(layer.fontFamily, layer.fontWeight || '700');
          let tw = label.length * fontSize * 0.7;
          try {
            tw = font.widthOfTextAtSize(label, fontSize);
          } catch {
            // 忽略测宽异常
          }
          const pt = rotateAroundPdfCenter(cx, cyPdf, -tw / 2, -fontSize * 0.34, angle);
          page.drawText(label, {
            x: pt.x,
            y: pt.y,
            size: fontSize,
            font,
            color: parseHexToRgb(layer.fill || '#ffffff', [1, 1, 1]),
            opacity,
            rotate: degrees(-angle),
          });
        }
      } else if (layer.type === 'image') {
        const imgInfo = resolveImageBytes(layer, baseDir);
        if (!imgInfo) continue;
        const embedded = imgInfo.kind === 'jpg'
          ? await pdfDoc.embedJpg(imgInfo.bytes)
          : await pdfDoc.embedPng(imgInfo.bytes);
        const bl = rotateAroundPdfCenter(cx, cyPdf, -w / 2, -h / 2, angle);
        page.drawImage(embedded, {
          x: bl.x,
          y: bl.y,
          width: w,
          height: h,
          opacity,
          rotate: degrees(-angle),
        });
      }
    }
  }

  // 覆盖写回原 PDF 前先留 .vcs.bak 备份，确保随时可回滚
  const outDir = dirname(absOut);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  if (absOut.toLowerCase() === absIn.toLowerCase()) {
    const bakPath = `${absIn}.vcs.bak`;
    if (!existsSync(bakPath)) {
      copyFileSync(absIn, bakPath);
    }
  }

  const finalBytes = await pdfDoc.save({ useObjectStreams: true });
  writeFileSync(absOut, finalBytes);

  return {
    ok: true,
    outputPath: absOut,
    bytes: finalBytes.length,
    editedPages: editedPageIndices,
    savedAt: new Date().toISOString(),
  };
}
