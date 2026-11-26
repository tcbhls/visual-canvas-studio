#!/usr/bin/env node
/**
 * Visual Canvas Studio — Antigravity 原生侧栏可视化设计编辑插件 (MCP App Server)
 * 支持：
 * 1. 分层画布设计文件 (.canvas.json) — 基于 Fabric.js 7（拖拽、旋转、摆正、缩放、对齐吸附、文字编辑、图层管理）
 * 2. 任意 HTML 详情页 / 海报 (.html / .htm) — Shadow DOM 隔离渲染 + 鼠标直接拖拽/旋转/缩放/改字/居中并回写源码
 * 3. SVG 矢量海报 (.svg) — 元素级拖拽/旋转/改字/换色并回写源码
 * 4. 本地图片 (.png / .jpg / .jpeg / .webp) — 直接载入画布二次排版、贴标签、摆正角度并导出成品图
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { renderPdfPage, savePdfEdits } from './pdf-engine.mjs';
import {
  collectRecentWorkspaces,
  extractConvContext,
  findMostRecentConversation,
  scanConversationContext,
} from './conv-context.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const APP_URI = 'ui://visual-canvas-studio/app.html';

// 解析命令行参数 --data_dir=...
function getArg(prefix, fallback) {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const DATA_DIR = getArg(
  '--data_dir=',
  join(PLUGIN_ROOT, '.data'),
);
const STATE_PATH = join(DATA_DIR, 'state.json');

// 支持可视化的文件扩展名
const VISUAL_EXTENSIONS = new Set([
  '.pdf',
  '.html',
  '.htm',
  '.svg',
  '.md',
  '.markdown',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.ico',
  '.avif',
]);

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function loadState() {
  try {
    if (existsSync(STATE_PATH)) {
      const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
      return {
        lastFile: '',
        lastWorkspace: '',
        recentFiles: [],
        byConv: {},
        ...parsed,
        byConv: parsed?.byConv && typeof parsed.byConv === 'object' ? parsed.byConv : {},
      };
    }
  } catch {
    // 忽略损坏状态
  }
  return {
    lastFile: '',
    lastWorkspace: '',
    recentFiles: [],
    byConv: {},
  };
}

function saveState(patch, convId = '') {
  try {
    ensureDir(DATA_DIR);
    const prev = loadState();
    const next = { ...prev, byConv: { ...(prev.byConv || {}) } };
    const normalizedFile = patch.lastFile ? normalize(patch.lastFile) : '';
    const nextWs = patch.lastWorkspace ? normalize(patch.lastWorkspace) : (normalizedFile ? dirname(normalizedFile) : '');

    if (convId) {
      const prevConv = next.byConv[convId] || { lastFile: '', lastFileAt: 0, lastWorkspace: '', recentFiles: [] };
      const convRecents = normalizedFile
        ? [normalizedFile, ...(prevConv.recentFiles || []).filter((f) => normalize(f) !== normalizedFile)].slice(0, 15)
        : (prevConv.recentFiles || []);
      next.byConv[convId] = {
        ...prevConv,
        ...(normalizedFile ? { lastFile: normalizedFile, lastFileAt: patch.lastFileAt || Date.now() } : {}),
        ...(nextWs ? { lastWorkspace: nextWs } : {}),
        recentFiles: convRecents,
      };
      // 保留最近 40 个会话记录防止状态文件膨胀
      const keys = Object.keys(next.byConv);
      if (keys.length > 40) {
        for (const oldKey of keys.slice(0, keys.length - 40)) {
          delete next.byConv[oldKey];
        }
      }
    }

    if (normalizedFile) {
      next.lastFile = normalizedFile;
      next.recentFiles = [
        normalizedFile,
        ...(prev.recentFiles || []).filter((f) => normalize(f) !== normalizedFile),
      ].slice(0, 15);
    }
    if (nextWs) {
      next.lastWorkspace = nextWs;
    }

    writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), 'utf-8');
    return next;
  } catch {
    return loadState();
  }
}

function detectFileMode(filePath) {
  const lower = String(filePath || '').toLowerCase();
  if (lower.endsWith('.canvas.json') || lower.endsWith('.vcs.json')) return 'canvas';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.svg')) return 'svg';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  const ext = extname(lower);
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.avif'].includes(ext)) return 'image';
  return 'unknown';
}

function isVisualFileName(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.canvas.json') || lower.endsWith('.vcs.json')) return true;
  return VISUAL_EXTENSIONS.has(extname(lower));
}

function getDefaultWorkspace() {
  const st = loadState();
  if (st.lastWorkspace && existsSync(st.lastWorkspace)) return st.lastWorkspace;
  if (process.env.VCS_DEFAULT_WORKSPACE && existsSync(process.env.VCS_DEFAULT_WORKSPACE)) {
    return process.env.VCS_DEFAULT_WORKSPACE;
  }
  const cwd = process.cwd();
  if (cwd && existsSync(cwd) && cwd.toLowerCase() !== PLUGIN_ROOT.toLowerCase()) {
    return cwd;
  }
  return homedir();
}

function listDirectoryVisuals(dirPath, maxDepth = 1) {
  const targetDir = dirPath && existsSync(dirPath) ? resolve(dirPath) : getDefaultWorkspace();
  const files = [];
  const folders = [];

  function scan(currentDir, depth) {
    let entries = [];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0) {
          folders.push({ name: entry.name, path: fullPath });
        }
        if (depth < maxDepth) {
          scan(fullPath, depth + 1);
        }
      } else if (entry.isFile() && isVisualFileName(entry.name)) {
        try {
          const st = statSync(fullPath);
          files.push({
            name: entry.name,
            path: fullPath,
            mode: detectFileMode(fullPath),
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch {
          // 跳过无权限文件
        }
      }
    }
  }

  scan(targetDir, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  folders.sort((a, b) => a.name.localeCompare(b.name));

  const parentDir = dirname(targetDir);
  return {
    dir: targetDir,
    parentDir: parentDir !== targetDir ? parentDir : '',
    folders: folders.slice(0, 80),
    files: files.slice(0, 120),
  };
}

/**
 * 读取任意体积本地图片并安全转为前端 DataURL：
 * - 普通图片（<= maxRawBytes）：零开销原字节直传
 * - 超大图（如 16MB+ 4K 无损 PNG，超过 Antigravity 10 MiB resources/read 限制）：
 *   基于内置 MuPDF 原生 C/WASM 管线按需解码、采样检测真透明通道并输出安全体积图，
 *   每次调用严格 destroy() 释放 WASM 线性内存，确保多张 4K 巨图并发/连续读取零 OOM。
 */
function readImageAsDataUrl(absPath, opts = {}) {
  if (!absPath || !existsSync(absPath)) return null;
  const st = statSync(absPath);
  if (!st.isFile() || st.size === 0) return null;

  const {
    maxRawBytes = 7.5 * 1024 * 1024,
    maxOutputBytes = 5.5 * 1024 * 1024,
    maxDim = 4096,
    jpegQuality = 92,
  } = typeof opts === 'number' ? { maxRawBytes: opts } : opts;

  const ext = extname(absPath).toLowerCase();
  const mime = IMAGE_MIME[ext] || 'application/octet-stream';

  if (ext === '.svg') {
    if (st.size > 20 * 1024 * 1024) return null;
    const buf = readFileSync(absPath);
    return {
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      originalBytes: st.size,
      naturalWidth: 0,
      naturalHeight: 0,
      transcoded: false,
      mime,
    };
  }

  if (st.size <= maxRawBytes) {
    const buf = readFileSync(absPath);
    return {
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      originalBytes: st.size,
      naturalWidth: 0,
      naturalHeight: 0,
      transcoded: false,
      mime,
    };
  }

  // 大图原生 MuPDF WASM 管线转码（突破 10 MiB 限制，支持 4K/8K 几十 MB 原图且严格回收 WASM 内存）
  const rawBuf = readFileSync(absPath);
  let img = null;
  let doc = null;
  let page = null;
  try {
    img = new mupdf.Image(rawBuf);
    const origW = img.getWidth();
    const origH = img.getHeight();
    img.destroy?.();
    img = null;

    doc = mupdf.Document.openDocument(rawBuf, mime);
    page = doc.loadPage(0);
    const bounds = page.getBounds();
    const ptW = Math.max(1, bounds[2] - bounds[0]);
    const ptH = Math.max(1, bounds[3] - bounds[1]);

    // 仅对可能带透明通道的格式做 256px 轻量抽样检测，避免分配 64MB 全尺寸 RGBA Pixmap
    let realTransparent = false;
    if (ext !== '.jpg' && ext !== '.jpeg') {
      const probeScale = Math.min(1, 256 / Math.max(ptW, ptH, 1));
      const probePm = page.toPixmap(
        mupdf.Matrix.scale(probeScale, probeScale),
        mupdf.ColorSpace.DeviceRGB,
        true,
        true,
      );
      try {
        const px = probePm.getPixels();
        const comp = probePm.getNumberOfComponents();
        for (let i = comp - 1; i < px.length; i += comp) {
          if (px[i] < 252) {
            realTransparent = true;
            break;
          }
        }
      } finally {
        probePm.destroy?.();
      }
    }

    const fitScale = Math.min(1, maxDim / Math.max(origW, origH, 1));
    const renderAt = (pixelScale, withAlpha) => {
      const targetW = Math.max(1, Math.round(origW * pixelScale));
      const targetH = Math.max(1, Math.round(origH * pixelScale));
      return page.toPixmap(
        mupdf.Matrix.scale(targetW / ptW, targetH / ptH),
        mupdf.ColorSpace.DeviceRGB,
        withAlpha,
        true,
      );
    };

    if (!realTransparent) {
      let pm = renderAt(fitScale, false);
      let outBuf;
      try {
        outBuf = Buffer.from(pm.asJPEG(jpegQuality, false));
        if (outBuf.length > maxOutputBytes) {
          outBuf = Buffer.from(pm.asJPEG(Math.min(86, jpegQuality - 6), false));
        }
      } finally {
        pm.destroy?.();
        pm = null;
      }
      if (outBuf.length > maxOutputBytes) {
        pm = renderAt(fitScale * 0.72, false);
        try {
          outBuf = Buffer.from(pm.asJPEG(84, false));
        } finally {
          pm.destroy?.();
          pm = null;
        }
      }
      return {
        dataUrl: `data:image/jpeg;base64,${outBuf.toString('base64')}`,
        originalBytes: st.size,
        naturalWidth: origW,
        naturalHeight: origH,
        transcoded: true,
        mime: 'image/jpeg',
      };
    }

    // 真透明通道大图：保留透明并以安全体积输出 PNG
    let pm = renderAt(fitScale, true);
    let outPng;
    try {
      outPng = Buffer.from(pm.asPNG());
    } finally {
      pm.destroy?.();
      pm = null;
    }
    if (outPng.length > maxOutputBytes) {
      const downScale = Math.min(fitScale * 0.72, 2200 / Math.max(origW, origH, 1));
      pm = renderAt(downScale, true);
      try {
        outPng = Buffer.from(pm.asPNG());
      } finally {
        pm.destroy?.();
        pm = null;
      }
    }
    return {
      dataUrl: `data:image/png;base64,${outPng.toString('base64')}`,
      originalBytes: st.size,
      naturalWidth: origW,
      naturalHeight: origH,
      transcoded: true,
      mime: 'image/png',
    };
  } catch {
    // 非 MuPDF 支持编码（如超大 WebP/AVIF）：放宽上限直接透传
    if (st.size <= 25 * 1024 * 1024) {
      return {
        dataUrl: `data:${mime};base64,${rawBuf.toString('base64')}`,
        originalBytes: st.size,
        naturalWidth: 0,
        naturalHeight: 0,
        transcoded: false,
        mime,
      };
    }
    return null;
  } finally {
    try { img?.destroy?.(); } catch {}
    try { page?.destroy?.(); } catch {}
    try { doc?.destroy?.(); } catch {}
  }
}

function fileToDataUrl(absPath, opts = 7.5 * 1024 * 1024) {
  const res = readImageAsDataUrl(absPath, opts);
  return res ? res.dataUrl : null;
}

function resolveAssetPath(baseDir, rawSrc) {
  if (!rawSrc || typeof rawSrc !== 'string') return null;
  const trimmed = rawSrc.trim().replace(/^['"]|['"]$/g, '');
  if (
    !trimmed ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('#')
  ) {
    return null;
  }
  let candidate = trimmed;
  if (candidate.startsWith('file:///')) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      candidate = decodeURIComponent(candidate.replace(/^file:\/\/\//, ''));
    }
  } else {
    try {
      candidate = decodeURIComponent(candidate.split('?')[0].split('#')[0]);
    } catch {
      candidate = candidate.split('?')[0].split('#')[0];
    }
  }
  const abs = isAbsolute(candidate) ? normalize(candidate) : resolve(baseDir, candidate);
  return existsSync(abs) ? abs : null;
}

/**
 * 扫描 HTML / SVG 中引用的本地图片路径，生成 assetMap 供侧栏 iframe 安全内联渲染
 */
function collectLocalAssetsFromMarkup(markup, baseDir) {
  const assetMap = {};
  const refs = new Set();

  // 匹配 src="..." / href="..." / xlink:href="..."
  const attrRe = /(?:src|href|xlink:href)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let m;
  while ((m = attrRe.exec(markup)) !== null) {
    const val = m[1] || m[2];
    if (val) refs.add(val);
  }
  // 匹配 CSS url(...)
  const urlRe = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;
  while ((m = urlRe.exec(markup)) !== null) {
    const val = m[2];
    if (val) refs.add(val);
  }

  for (const ref of refs) {
    const abs = resolveAssetPath(baseDir, ref);
    if (abs) {
      const dataUrl = fileToDataUrl(abs);
      if (dataUrl) {
        assetMap[ref] = dataUrl;
      }
    }
  }
  return assetMap;
}

/**
 * 为 .canvas.json 中引用的本地图片构建 assetMap
 */
function collectLocalAssetsFromCanvas(doc, baseDir) {
  const assetMap = {};
  const candidates = [];
  if (doc?.backgroundImage) candidates.push(doc.backgroundImage);
  if (Array.isArray(doc?.layers)) {
    for (const layer of doc.layers) {
      if (layer?.src) candidates.push(layer.src);
    }
  }
  for (const ref of candidates) {
    if (assetMap[ref]) continue;
    const abs = resolveAssetPath(baseDir, ref);
    if (abs) {
      const dataUrl = fileToDataUrl(abs);
      if (dataUrl) assetMap[ref] = dataUrl;
    }
  }
  return assetMap;
}

const SKIP_SEARCH_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.system_generated',
  '.next',
  '.nuxt',
  'target',
  'appdata',
]);

/**
 * 按文件名在候选目录中快速定位真实磁盘路径（供 Antigravity file 视图匹配资源所在目录、打开位置与超大文件本地回退）
 * 当提供 expectedBytes 时，若命中文件名且字节数精确相等立即锁定唯一文件；否则返回最近修改的同名文件。
 */
function findFileByNameInDirs(fileName, searchDirs = [], maxDepth = 4, expectedBytes = 0) {
  if (!fileName) return '';
  const targetLower = basename(fileName).toLowerCase();
  const seenDirs = new Set();
  const candidates = [];
  let visitedDirs = 0;
  const MAX_VISITED_DIRS = 1800;

  function walk(dir, depth) {
    if (!dir || visitedDirs >= MAX_VISITED_DIRS || !existsSync(dir)) return '';
    const norm = normalize(dir);
    const dirKey = norm.toLowerCase();
    if (seenDirs.has(dirKey)) return '';
    seenDirs.add(dirKey);
    visitedDirs++;

    let entries = [];
    try {
      entries = readdirSync(norm, { withFileTypes: true });
    } catch {
      return '';
    }
    const subDirs = [];
    for (const ent of entries) {
      const low = ent.name.toLowerCase();
      if (SKIP_SEARCH_DIRS.has(low)) continue;
      const full = join(norm, ent.name);
      if (ent.isFile() && low === targetLower) {
        try {
          const st = statSync(full);
          if (expectedBytes > 0 && st.size === expectedBytes) {
            return full;
          }
          candidates.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          candidates.push({ path: full, size: 0, mtimeMs: 0 });
        }
      } else if (ent.isDirectory() && depth < maxDepth && !ent.name.startsWith('.')) {
        subDirs.push(full);
      }
    }
    for (const sub of subDirs) {
      const exact = walk(sub, depth + 1);
      if (exact) return exact;
    }
    return '';
  }

  for (const d of searchDirs) {
    const exact = walk(d, 0);
    if (exact) return exact;
    if (!expectedBytes && candidates.length) break;
  }

  if (!candidates.length) return '';
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].path;
}

/**
 * 跨会话、跨工作区综合定位 Antigravity file 视图对应的本地真实磁盘路径
 */
function findDiskPathForHostFile(fileName, { expectedBytes = 0, extra = null, matchedHint = '', resourceUri = '' } = {}) {
  let targetName = fileName ? basename(fileName) : '';
  if (!targetName && resourceUri) {
    try {
      const seg = resourceUri.split('/').pop() || '';
      targetName = basename(decodeURIComponent(seg));
    } catch {
      // 忽略
    }
  }
  if (!targetName) return '';
  const targetLower = targetName.toLowerCase();

  // 1. 优先校验调用方已持有的磁盘路径提示
  if (matchedHint && existsSync(matchedHint)) {
    try {
      const absHint = resolve(matchedHint);
      const st = statSync(absHint);
      if (st.isFile() && basename(absHint).toLowerCase() === targetLower) {
        if (!expectedBytes || st.size === expectedBytes) return absHint;
      }
    } catch {
      // 继续兜底查找
    }
  }

  const ctx = extractConvContext(extra);
  const effectiveCtx = ctx.conversationId ? ctx : findMostRecentConversation();
  const convScan = scanConversationContext(effectiveCtx.artifactsDir, detectFileMode);
  const convFiles = convScan.files || [];

  // 2. 当前会话扫描结果直达匹配
  const convHits = convFiles.filter((f) => f.name.toLowerCase() === targetLower && existsSync(f.path));
  if (convHits.length) {
    if (expectedBytes > 0) {
      const exact = convHits.find((f) => f.size === expectedBytes);
      if (exact) return exact.path;
    } else {
      return convHits[0].path;
    }
  }

  // 3. 本地状态历史记录直达匹配
  const st = loadState();
  const recentCandidates = [
    ...(st.recentFiles || []),
    ...Object.values(st.byConv || {}).flatMap((c) => c?.recentFiles || []),
  ];
  for (const rf of recentCandidates) {
    if (!rf || basename(rf).toLowerCase() !== targetLower || !existsSync(rf)) continue;
    try {
      const fst = statSync(rf);
      if (!expectedBytes || fst.size === expectedBytes) return resolve(rf);
    } catch {
      // 忽略
    }
  }

  // 4. 汇总所有活跃工作区、近期会话工作区与项目聚合父目录进行有限深度快速搜索
  const recentWs = collectRecentWorkspaces(20);
  const uriDirs = [];
  const uuidMatch = /^antigravity-file:\/\/([0-9a-f-]{16,})\//i.exec(resourceUri || '');
  if (uuidMatch) {
    const brainCandidate = join(homedir(), '.gemini', 'antigravity', 'brain', uuidMatch[1]);
    if (existsSync(brainCandidate)) uriDirs.push(brainCandidate);
  }

  const primaryDirs = [
    ...uriDirs,
    ...(ctx.workspaceDirs || []),
    effectiveCtx.artifactsDir,
    convScan.workspaceDir,
    getDefaultWorkspace(),
    ...recentWs.workspaces,
    ...recentWs.artifactDirs,
  ].filter(Boolean);

  const hitPrimary = findFileByNameInDirs(targetName, primaryDirs, 4, expectedBytes);
  if (hitPrimary) return hitPrimary;

  // 5. 同级项目聚合目录兜底（例如 D:\antigravity work 下新建的其他项目文件夹）
  if (recentWs.parentWorkspaces.length) {
    const hitParent = findFileByNameInDirs(targetName, recentWs.parentWorkspaces, 5, expectedBytes);
    if (hitParent) return hitParent;
  }

  return convHits[0]?.path || '';
}

/**
 * 扫描 Markdown 中的本地内嵌图片（![alt](path) 与 <img src="path">）及图片链接，
 * 转为 dataUrl 供 iframe 安全渲染，并保留真实本地路径以便一键进入可视化微调。
 */
function collectLocalAssetsFromMarkdown(markdown, baseDirs = []) {
  const assetMap = {};
  const images = [];
  const diskCache = new Map(); // absLower -> { embeddedUrl, thumbUrl }
  const seenDisk = new Map(); // absLower -> index in images
  const dirs = baseDirs.filter((d) => d && existsSync(d));

  const resolveAcross = (rawSrc) => {
    for (const d of dirs) {
      const abs = resolveAssetPath(d, rawSrc);
      if (abs) return abs;
    }
    // 兜底尝试按绝对路径直接解析
    return resolveAssetPath(process.cwd(), rawSrc);
  };

  const getEmbeddedDataUrl = (abs) => {
    const key = abs.toLowerCase();
    const cached = diskCache.get(key) || {};
    if (cached.embeddedUrl) return cached.embeddedUrl;
    // Markdown 排版区最大宽 780px，内嵌大图统一转 1280px 高清预览（单图 ~200KB），多张 4K 图同时展示也不超 MCP 传输上限
    const url =
      fileToDataUrl(abs, {
        maxRawBytes: 1.2 * 1024 * 1024,
        maxOutputBytes: 300 * 1024,
        maxDim: 1280,
        jpegQuality: 84,
      }) || '';
    cached.embeddedUrl = url;
    diskCache.set(key, cached);
    return url;
  };

  const getThumbDataUrl = (abs) => {
    const key = abs.toLowerCase();
    const cached = diskCache.get(key) || {};
    if (cached.thumbUrl) return cached.thumbUrl;
    const url =
      fileToDataUrl(abs, {
        maxRawBytes: 64 * 1024,
        maxOutputBytes: 24 * 1024,
        maxDim: 120,
        jpegQuality: 74,
      }) || '';
    cached.thumbUrl = url;
    diskCache.set(key, cached);
    return url;
  };

  const addCandidate = (alt, rawSrc, kind = 'embedded') => {
    if (!rawSrc) return;
    const cleanedSrc = rawSrc.trim().replace(/^<|>$/g, '').replace(/\s+["'][^"']*["']\s*$/, '');
    if (!cleanedSrc) return;
    const abs = resolveAcross(cleanedSrc);
    if (!abs) return;
    const mode = detectFileMode(abs);
    if (mode !== 'image' && mode !== 'svg') return;

    const key = abs.toLowerCase();
    if (kind === 'embedded') {
      const dataUrl = getEmbeddedDataUrl(abs);
      if (dataUrl) {
        assetMap[cleanedSrc] = dataUrl;
        if (rawSrc !== cleanedSrc) assetMap[rawSrc] = dataUrl;
      }
    }

    if (!seenDisk.has(key)) {
      seenDisk.set(key, images.length);
      images.push({
        alt: (alt || '').trim() || basename(abs),
        rawSrc: cleanedSrc,
        diskPath: abs,
        fileName: basename(abs),
        // 菜单里仅需极小缩略图（若已在 assetMap 里则前端直接复用，不重复塞整张大图 base64 导致 JSON 体积翻倍）
        dataUrl: kind === 'embedded' ? '' : getThumbDataUrl(abs),
        kind,
      });
    } else if (kind === 'embedded') {
      const existing = images[seenDisk.get(key)];
      existing.kind = 'embedded';
      existing.rawSrc = cleanedSrc;
      existing.dataUrl = '';
    }
  };

  // 1. 标准 Markdown 图片：![alt](path)
  const mdImgRe = /!\[([^\]]*)\]\(([^)\r\n]+)\)/g;
  let m;
  while ((m = mdImgRe.exec(markdown)) !== null) {
    addCandidate(m[1], m[2], 'embedded');
  }

  // 2. HTML <img src="..." alt="...">
  const htmlImgRe = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  while ((m = htmlImgRe.exec(markdown)) !== null) {
    const src = m[1] || m[2];
    const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[0]);
    const alt = altMatch ? (altMatch[1] || altMatch[2] || '') : '';
    addCandidate(alt, src, 'embedded');
  }

  // 3. Markdown 图片直链：[方案 A](file:///.../option-a.jpg)
  const mdLinkRe = /(?<!!)\[([^\]]+)\]\(([^)\r\n]+\.(?:png|jpe?g|webp|gif|bmp|svg)(?:\?[^)\r\n]*)?)\)/gi;
  while ((m = mdLinkRe.exec(markdown)) !== null) {
    addCandidate(m[1], m[2], 'linked');
  }

  return { assetMap, images };
}

/**
 * 读取任意支持文件并组装为前端可直接编辑的数据包
 */
function loadVisualFile(filePath, convId = '') {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`文件不存在: ${absPath}`);
  }
  const mode = detectFileMode(absPath);
  const baseDir = dirname(absPath);
  const fileName = basename(absPath);

  saveState({ lastFile: absPath, lastFileAt: Date.now(), lastWorkspace: baseDir }, convId);

  if (mode === 'canvas') {
    const raw = readFileSync(absPath, 'utf-8');
    const doc = JSON.parse(raw);
    const assetMap = collectLocalAssetsFromCanvas(doc, baseDir);
    return {
      ok: true,
      mode: 'canvas',
      filePath: absPath,
      fileName,
      dir: baseDir,
      document: doc,
      assetMap,
    };
  }

  if (mode === 'html' || mode === 'svg') {
    const content = readFileSync(absPath, 'utf-8');
    const assetMap = collectLocalAssetsFromMarkup(content, baseDir);
    return {
      ok: true,
      mode,
      filePath: absPath,
      fileName,
      dir: baseDir,
      content,
      assetMap,
    };
  }

  if (mode === 'markdown') {
    const content = readFileSync(absPath, 'utf-8');
    const { assetMap, images } = collectLocalAssetsFromMarkdown(content, [baseDir]);
    return {
      ok: true,
      mode: 'markdown',
      filePath: absPath,
      fileName,
      dir: baseDir,
      content,
      assetMap,
      images,
    };
  }

  if (mode === 'pdf') {
    const pageData = renderPdfPage(absPath, 0, 2);
    return {
      ok: true,
      mode: 'pdf',
      filePath: absPath,
      fileName,
      dir: baseDir,
      ...pageData,
    };
  }

  if (mode === 'image') {
    const imgInfo = readImageAsDataUrl(absPath, {
      maxRawBytes: 6.5 * 1024 * 1024,
      maxOutputBytes: 4.5 * 1024 * 1024,
      maxDim: 4096,
      jpegQuality: 92,
    });
    if (!imgInfo?.dataUrl) {
      throw new Error(`图片文件无法读取或编码不受支持: ${absPath}`);
    }
    return {
      ok: true,
      mode: 'image',
      filePath: absPath,
      fileName,
      dir: baseDir,
      dataUrl: imgInfo.dataUrl,
      originalBytes: imgInfo.originalBytes,
      naturalWidth: imgInfo.naturalWidth,
      naturalHeight: imgInfo.naturalHeight,
      transcoded: imgInfo.transcoded,
    };
  }

  throw new Error(`暂不支持该文件格式: ${fileName}（支持 .pdf / .canvas.json / .html / .svg / .png / .jpg / .webp）`);
}

function backupOnce(absPath) {
  if (!existsSync(absPath)) return;
  const bakPath = `${absPath}.vcs.bak`;
  if (!existsSync(bakPath)) {
    try {
      copyFileSync(absPath, bakPath);
    } catch {
      // 备份失败不阻断保存
    }
  }
}

function readAppHtml() {
  const overridePath = process.env.VCS_APP_HTML;
  const htmlPath = overridePath && existsSync(overridePath)
    ? overridePath
    : join(PLUGIN_ROOT, 'dist', 'app.html');
  if (!existsSync(htmlPath)) {
    return `<!doctype html><html><body style="font-family:sans-serif;padding:24px;">
      <h3>Visual Canvas Studio 尚未构建前端产物</h3>
      <p>请在插件根目录运行 <code>npm run build:ui</code> 生成 <code>dist/app.html</code>。</p>
    </body></html>`;
  }
  return readFileSync(htmlPath, 'utf-8');
}

// ---------- 构建 MCP Server ----------
const server = new McpServer({
  name: 'visual-canvas-studio',
  version: '1.0.0',
});

// 注册单文件 UI 资源
registerAppResource(
  server,
  'Visual Canvas Studio UI',
  APP_URI,
  {
    description: 'Antigravity 侧栏可视化画布与 HTML/SVG 鼠标直编器',
    mimeType: RESOURCE_MIME_TYPE,
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
  async () => ({
    contents: [
      {
        uri: APP_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: readAppHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  }),
);

// 1. 打开侧栏可视化编辑器（AI 与侧栏 "+" / 左侧边栏入口共用）
const PANE_META = {
  ui: {
    resourceUri: APP_URI,
  },
  'com.google.antigravity/ui': {
    entrypoints: [
      { type: 'aux_pane', title: '可视化画布编辑' },
      { type: 'global', title: '可视化画布编辑' },
    ],
  },
};

registerAppTool(
  server,
  'open_visual_editor',
  {
    title: '可视化画布编辑',
    description:
      '在 Antigravity 侧栏打开交互式可视化编辑器，支持用鼠标直接微调多页 PDF（原位点选改字、双击空白填字、白框遮盖、插图/盖章、旋转摆正并矢量写回 PDF）、.canvas.json 分层设计、.html 电商海报/详情页、.svg 矢量图以及 .png/.jpg/.webp 图片。',
    inputSchema: z.object({
      filePath: z
        .string()
        .optional()
        .describe('要打开的文件绝对路径（支持 .pdf / .canvas.json / .html / .svg / .png / .jpg / .webp；省略时恢复上次文件）'),
      workspaceDir: z
        .string()
        .optional()
        .describe('工作区根目录路径（可选，用于在侧栏快速浏览当前项目中的视觉与 PDF 文件）'),
    }),
    _meta: PANE_META,
  },
  async ({ filePath, workspaceDir } = {}, extra) => {
    const st = loadState();
    const ctx = extractConvContext(extra);
    const isScopedConv = Boolean(ctx.conversationId);
    const effectiveCtx = isScopedConv ? ctx : findMostRecentConversation();
    const convScan = scanConversationContext(effectiveCtx.artifactsDir, detectFileMode);
    const convFiles = convScan.files || [];
    const convState = ctx.conversationId ? st.byConv?.[ctx.conversationId] : null;

    let activeFile = '';
    if (filePath && existsSync(resolve(filePath))) {
      activeFile = resolve(filePath);
    } else if (isScopedConv) {
      // 严格优先当前对话框自身的文件：若本会话有更新的产出图/PDF，优先打开它；否则用本会话内上次选过的文件；绝不串台打开别的会话文件
      const newestConvFile = convFiles[0];
      const hasValidConvLast = convState?.lastFile && existsSync(convState.lastFile);
      if (newestConvFile && (!hasValidConvLast || newestConvFile.mtimeMs > (convState.lastFileAt || 0))) {
        activeFile = newestConvFile.path;
      } else if (hasValidConvLast) {
        activeFile = convState.lastFile;
      } else if (newestConvFile) {
        activeFile = newestConvFile.path;
      }
    } else if (convFiles[0]) {
      // 全局侧边栏入口无会话 ID 时，默认打开最近活跃会话的最新视觉文件
      activeFile = convFiles[0].path;
    }

    const activeWorkspace = workspaceDir && existsSync(resolve(workspaceDir))
      ? resolve(workspaceDir)
      : convScan.workspaceDir && existsSync(convScan.workspaceDir)
        ? convScan.workspaceDir
        : activeFile
          ? dirname(activeFile)
          : convState?.lastWorkspace && existsSync(convState.lastWorkspace)
            ? convState.lastWorkspace
            : getDefaultWorkspace();

    const updatedState = saveState(
      {
        ...(activeFile ? { lastFile: activeFile, lastFileAt: Date.now() } : {}),
        lastWorkspace: activeWorkspace,
      },
      ctx.conversationId,
    );

    const listing = listDirectoryVisuals(activeWorkspace, 1);
    const mode = activeFile ? detectFileMode(activeFile) : 'picker';
    const convRecents = (ctx.conversationId ? updatedState.byConv?.[ctx.conversationId]?.recentFiles : updatedState.recentFiles) || [];

    return {
      content: [
        {
          type: 'text',
          text: activeFile
            ? `已在侧栏可视化画布中打开当前会话文件：${activeFile}（模式：${mode}，本会话共识别到 ${convFiles.length} 个视觉文件）。`
            : `已在侧栏打开可视化画布编辑器（当前目录：${activeWorkspace}，本会话暂无已生成图片/PDF，可从下方列表选择或直接新建）。`,
        },
      ],
      structuredContent: {
        action: 'open',
        conversationId: ctx.conversationId,
        filePath: activeFile,
        workspaceDir: activeWorkspace,
        mode,
        convFiles,
        recentFiles: convRecents.filter((f) => existsSync(f)),
        files: listing.files,
      },
    };
  },
);

registerAppTool(
  server,
  'edit_visual_file',
  {
    title: '可视化画布直编',
    description:
      'Antigravity 原生文件接管入口：默认以纯净无打扰模式预览图片、PDF、Markdown、HTML、SVG 与 .canvas.json，点击右上角三个点中的「可视化画布编辑」即可原地切换为完整拆层微调与 PDF 原位改字模式。',
    inputSchema: z.object({
      file: z
        .object({
          name: z.string(),
          resourceUri: z.string(),
        })
        .optional(),
    }),
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          {
            type: 'file',
            title: '可视化画布编辑',
            extensions: [
              '.png',
              '.jpg',
              '.jpeg',
              '.webp',
              '.gif',
              '.bmp',
              '.ico',
              '.avif',
              '.svg',
              '.pdf',
              '.html',
              '.htm',
              '.md',
              '.markdown',
              '.canvas.json',
            ],
          },
        ],
      },
    },
  },
  async ({ file } = {}, extra) => {
    const ctx = extractConvContext(extra);
    const effectiveCtx = ctx.conversationId ? ctx : findMostRecentConversation();
    const convScan = scanConversationContext(effectiveCtx.artifactsDir, detectFileMode);
    const convFiles = convScan.files || [];
    // 依次从本会话视觉列表、本会话 artifacts 目录、工作区目录中匹配真实本地路径，便于解析相对图片与打开所在位置
    let matchedDisk = '';
    if (file?.name || file?.resourceUri) {
      matchedDisk = findDiskPathForHostFile(file?.name || '', {
        extra,
        resourceUri: file?.resourceUri || '',
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: file?.name
            ? `正在打开文件预览：${file.name}（点击右上角 ⋮ → 可视化画布编辑 即可进入微调）`
            : '可视化文件预览与编辑器已就绪',
        },
      ],
      structuredContent: {
        action: 'open_host_file',
        hostFile: file || null,
        matchedDiskPath: matchedDisk,
        workspaceDir: convScan.workspaceDir || '',
        artifactsDir: effectiveCtx.artifactsDir || '',
        convFiles,
      },
    };
  },
);

// 2. 创建分层电商主图 / 详情页设计文件并立即在侧栏打开
const LayerSchema = z.object({
  id: z.string().optional(),
  type: z.enum(['image', 'text', 'badge', 'rect', 'circle', 'line']),
  name: z.string().optional(),
  left: z.number().optional(),
  top: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  radius: z.number().optional(),
  angle: z.number().optional().describe('旋转角度，0 为水平摆正，负值逆时针倾斜，正值顺时针倾斜'),
  opacity: z.number().optional(),
  // 文本与标签属性
  text: z.string().optional(),
  fontSize: z.number().optional(),
  fontWeight: z.union([z.string(), z.number()]).optional(),
  fontFamily: z.string().optional(),
  fill: z.string().optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  lineHeight: z.number().optional(),
  charSpacing: z.number().optional(),
  // 形状与徽章背景
  bg: z.string().optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),
  rx: z.number().optional(),
  ry: z.number().optional(),
  // 图片属性
  src: z.string().optional().describe('本地相对路径或绝对路径（例如 ./tryon_pose1.jpg）'),
  // 阴影
  shadow: z
    .object({
      color: z.string().optional(),
      blur: z.number().optional(),
      offsetX: z.number().optional(),
      offsetY: z.number().optional(),
    })
    .optional(),
  locked: z.boolean().optional(),
  visible: z.boolean().optional(),
});

registerAppTool(
  server,
  'create_ecommerce_design',
  {
    title: '创建分层电商主图/海报',
    description:
      '生成一份结构化、全元素可鼠标拖拽/旋转/摆正/改字的 .canvas.json 分层设计文件（如电商主图 800x800、3:4 主图 900x1200、详情页 750x1200），并自动在 Antigravity 侧栏打开供用户直接微调。',
    inputSchema: z.object({
      filePath: z.string().describe('输出的 .canvas.json 文件路径'),
      name: z.string().optional().describe('设计名称（如：春季连衣裙主图）'),
      width: z.number().optional().default(800).describe('画布宽度（像素），默认 800'),
      height: z.number().optional().default(800).describe('画布高度（像素），默认 800'),
      background: z.string().optional().default('#FFFFFF').describe('画布背景色'),
      backgroundGradient: z
        .object({
          angle: z.number().optional(),
          stops: z.array(
            z.object({
              offset: z.number(),
              color: z.string(),
            }),
          ),
        })
        .optional()
        .describe('可选背景线性渐变'),
      layers: z.array(LayerSchema).describe('按从底到顶顺序排列的图层列表'),
    }),
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
    },
  },
  async ({ filePath, name, width = 800, height = 800, background = '#FFFFFF', backgroundGradient, layers }, extra) => {
    const convId = extractConvContext(extra).conversationId;
    const absPath = resolve(
      filePath.toLowerCase().endsWith('.canvas.json') ? filePath : `${filePath}.canvas.json`,
    );
    ensureDir(dirname(absPath));

    const normalizedLayers = layers.map((layer, idx) => ({
      id: layer.id || `${layer.type}_${idx + 1}`,
      name: layer.name || `${layer.type}_${idx + 1}`,
      angle: 0,
      opacity: 1,
      visible: true,
      locked: false,
      ...layer,
    }));

    const doc = {
      format: 'visual-canvas-studio',
      version: 1,
      name: name || basename(absPath, '.canvas.json'),
      width,
      height,
      background,
      ...(backgroundGradient ? { backgroundGradient } : {}),
      layers: normalizedLayers,
      updatedAt: new Date().toISOString(),
    };

    writeFileSync(absPath, JSON.stringify(doc, null, 2), 'utf-8');
    saveState({ lastFile: absPath, lastFileAt: Date.now(), lastWorkspace: dirname(absPath) }, convId);

    return {
      content: [
        {
          type: 'text',
          text: `已创建分层设计文件：${absPath}（${width}×${height}，共 ${normalizedLayers.length} 个独立可编辑图层），并已在侧栏可视化画布中打开。`,
        },
      ],
      structuredContent: {
        action: 'open',
        filePath: absPath,
        workspaceDir: dirname(absPath),
        mode: 'canvas',
        recentFiles: loadState().recentFiles || [],
      },
    };
  },
);

// 3. 列出工作区内的视觉文件
server.registerTool(
  'list_visual_files',
  {
    title: '列出工作区视觉文件',
    description: '列出指定目录下的 .canvas.json / .html / .svg / .png / .jpg / .webp 文件。',
    inputSchema: z.object({
      directory: z.string().optional().describe('目录绝对路径，省略则使用当前工作区'),
    }),
  },
  async ({ directory } = {}) => {
    const res = listDirectoryVisuals(directory, 2);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(res, null, 2),
        },
      ],
      structuredContent: res,
    };
  },
);

// 4. 读取设计当前状态（供 AI 在用户手动微调后获知最新坐标/角度/文案）
server.registerTool(
  'read_design_state',
  {
    title: '读取微调后的设计状态',
    description: '读取 .canvas.json / .html / .svg 的最新元素位置、角度、文案及最近导出图路径，便于 AI 衔接继续修改。',
    inputSchema: z.object({
      filePath: z.string().describe('设计文件绝对路径'),
    }),
  },
  async ({ filePath }) => {
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `文件不存在：${absPath}` }],
      };
    }
    const mode = detectFileMode(absPath);
    if (mode === 'canvas') {
      const doc = JSON.parse(readFileSync(absPath, 'utf-8'));
      const summary = {
        filePath: absPath,
        name: doc.name,
        width: doc.width,
        height: doc.height,
        background: doc.background,
        lastExportPath: doc.lastExportPath || null,
        updatedAt: doc.updatedAt || null,
        layers: (doc.layers || []).map((l) => ({
          id: l.id,
          type: l.type,
          name: l.name,
          text: l.text,
          src: l.src,
          left: Math.round((l.left ?? 0) * 10) / 10,
          top: Math.round((l.top ?? 0) * 10) / 10,
          width: l.width ? Math.round(l.width * 10) / 10 : undefined,
          height: l.height ? Math.round(l.height * 10) / 10 : undefined,
          angle: Math.round((l.angle ?? 0) * 10) / 10,
          fontSize: l.fontSize,
          fill: l.fill,
          opacity: l.opacity,
          visible: l.visible,
        })),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        structuredContent: summary,
      };
    }

    if (mode === 'pdf') {
      const p0 = renderPdfPage(absPath, 0, 1);
      const summary = {
        filePath: absPath,
        mode: 'pdf',
        pageCount: p0.pageCount,
        page1Size: { width: p0.width, height: p0.height },
        page1Texts: p0.textItems.map((t) => ({
          text: t.text,
          x: t.x,
          y: t.y,
          fontSize: t.fontSize,
        })),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        structuredContent: summary,
      };
    }

    const raw = readFileSync(absPath, 'utf-8');
    return {
      content: [
        {
          type: 'text',
          text: `文件：${absPath}（模式：${mode}，长度：${raw.length} 字符）\n${raw.slice(0, 8000)}`,
        },
      ],
    };
  },
);

// ---------- 以下为 App 专用后台工具（visibility: ["app"]，仅侧栏 UI 可调用） ----------
const APP_ONLY_META = {
  ui: {
    visibility: ['app'],
  },
};

registerAppTool(
  server,
  'app_browse_files',
  {
    title: '浏览本地视觉文件',
    description: 'App 内部使用：列出目录中的视觉文件与子目录（若传入文件路径则直接返回文件标识）',
    inputSchema: z.object({
      directory: z.string().optional(),
    }),
    _meta: APP_ONLY_META,
  },
  async ({ directory } = {}, extra) => {
    const ctx = extractConvContext(extra);
    const effectiveCtx = ctx.conversationId ? ctx : findMostRecentConversation();
    const convScan = scanConversationContext(effectiveCtx.artifactsDir, detectFileMode);
    const convFiles = convScan.files || [];
    const st = loadState();
    const convRecents = (ctx.conversationId ? st.byConv?.[ctx.conversationId]?.recentFiles : st.recentFiles) || [];

    const cleaned = directory ? directory.trim().replace(/^["']|["']$/g, '') : '';
    if (cleaned && existsSync(resolve(cleaned)) && statSync(resolve(cleaned)).isFile()) {
      const absFile = resolve(cleaned);
      const res = listDirectoryVisuals(dirname(absFile), 1);
      return {
        content: [{ type: 'text', text: `定位到文件 ${absFile}` }],
        structuredContent: {
          ...res,
          openFilePath: absFile,
          convFiles,
          recentFiles: convRecents.filter((f) => existsSync(f)),
        },
      };
    }
    const targetDir = cleaned || convScan.workspaceDir || undefined;
    const res = listDirectoryVisuals(targetDir, 1);
    const payload = {
      ...res,
      convFiles,
      recentFiles: convRecents.filter((f) => existsSync(f)),
    };
    return {
      content: [{ type: 'text', text: `列举目录 ${res.dir}` }],
      structuredContent: payload,
    };
  },
);

registerAppTool(
  server,
  'app_load_file',
  {
    title: '加载可视化编辑文件',
    description: 'App 内部使用：读取 .canvas.json / .html / .svg / 图片并内联本地素材',
    inputSchema: z.object({
      filePath: z.string(),
    }),
    _meta: APP_ONLY_META,
  },
  async ({ filePath }, extra) => {
    try {
      const convId = extractConvContext(extra).conversationId;
      const payload = loadVisualFile(filePath, convId);
      return {
        content: [{ type: 'text', text: `已加载 ${payload.fileName}` }],
        structuredContent: payload,
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(err?.message || err) }],
      };
    }
  },
);

registerAppTool(
  server,
  'app_save_file',
  {
    title: '保存编辑结果回磁盘',
    description: 'App 内部使用：将修改后的 .canvas.json / .html / .svg 写回磁盘',
    inputSchema: z.object({
      filePath: z.string(),
      content: z.string(),
    }),
    _meta: APP_ONLY_META,
  },
  async ({ filePath, content }, extra) => {
    try {
      const convId = extractConvContext(extra).conversationId;
      const absPath = resolve(filePath);
      ensureDir(dirname(absPath));
      backupOnce(absPath);
      writeFileSync(absPath, content, 'utf-8');
      saveState({ lastFile: absPath, lastFileAt: Date.now(), lastWorkspace: dirname(absPath) }, convId);
      const payload = {
        ok: true,
        filePath: absPath,
        savedAt: new Date().toISOString(),
        bytes: Buffer.byteLength(content, 'utf-8'),
      };
      return {
        content: [{ type: 'text', text: `已保存到 ${absPath}` }],
        structuredContent: payload,
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(err?.message || err) }],
      };
    }
  },
);

registerAppTool(
  server,
  'app_export_image',
  {
    title: '导出成品图片到工作区',
    description: 'App 内部使用：将画布渲染的 PNG/JPG/WebP dataURL 写入本地磁盘',
    inputSchema: z.object({
      outputPath: z.string(),
      dataUrl: z.string(),
      sourceCanvasPath: z.string().optional(),
    }),
    _meta: APP_ONLY_META,
  },
  async ({ outputPath, dataUrl, sourceCanvasPath }) => {
    try {
      const absOut = resolve(outputPath);
      ensureDir(dirname(absOut));
      const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
      if (!match) {
        throw new Error('无效的 dataUrl 图片数据');
      }
      const buf = Buffer.from(match[2], 'base64');
      backupOnce(absOut);
      writeFileSync(absOut, buf);

      // 若来自 .canvas.json，顺便记录 lastExportPath
      if (sourceCanvasPath && existsSync(sourceCanvasPath) && sourceCanvasPath.toLowerCase().endsWith('.canvas.json')) {
        try {
          const doc = JSON.parse(readFileSync(sourceCanvasPath, 'utf-8'));
          doc.lastExportPath = absOut;
          doc.updatedAt = new Date().toISOString();
          writeFileSync(sourceCanvasPath, JSON.stringify(doc, null, 2), 'utf-8');
        } catch {
          // 忽略附加元数据更新失败
        }
      }

      const payload = {
        ok: true,
        outputPath: absOut,
        bytes: buf.length,
      };
      return {
        content: [{ type: 'text', text: `已导出图片至 ${absOut}` }],
        structuredContent: payload,
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(err?.message || err) }],
      };
    }
  },
);

registerAppTool(
  server,
  'app_read_image_data',
  {
    title: '读取本地图片 DataURL',
    description: 'App 内部使用：将工作区本地图片转为 DataURL 以便插入到画布中',
    inputSchema: z.object({
      filePath: z.string(),
    }),
    _meta: APP_ONLY_META,
  },
  async ({ filePath }) => {
    try {
      const abs = resolve(filePath);
      const imgInfo = readImageAsDataUrl(abs, {
        maxRawBytes: 7.5 * 1024 * 1024,
        maxOutputBytes: 5.5 * 1024 * 1024,
        maxDim: 4096,
        jpegQuality: 92,
      });
      if (!imgInfo?.dataUrl) throw new Error(`无法读取图片：${abs}`);
      return {
        content: [{ type: 'text', text: `已读取图片 ${basename(abs)}` }],
        structuredContent: {
          ok: true,
          filePath: abs,
          fileName: basename(abs),
          dataUrl: imgInfo.dataUrl,
          originalBytes: imgInfo.originalBytes,
          naturalWidth: imgInfo.naturalWidth,
          naturalHeight: imgInfo.naturalHeight,
          transcoded: imgInfo.transcoded,
        },
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(err?.message || err) }],
      };
    }
  },
);

registerAppTool(
  server,
  'app_load_host_fallback',
  {
    title: '超大文件本地直读回退',
    description:
      'App 内部使用：当 Antigravity 宿主 resources/read 因超过 10 MiB 上限或编码限制失败时，直接按文件名与字节数定位本地磁盘文件并以安全体积载入预览与编辑',
    inputSchema: z.object({
      fileName: z.string(),
      resourceUri: z.string().optional(),
      expectedBytes: z.number().optional(),
      matchedDiskPath: z.string().optional(),
    }),
    _meta: APP_ONLY_META,
  },
  async ({ fileName, resourceUri = '', expectedBytes = 0, matchedDiskPath = '' }, extra) => {
    try {
      const convId = extractConvContext(extra).conversationId;
      const diskPath = findDiskPathForHostFile(fileName, {
        expectedBytes: Number(expectedBytes) || 0,
        extra,
        matchedHint: matchedDiskPath,
        resourceUri,
      });
      if (!diskPath || !existsSync(diskPath)) {
        throw new Error(`文件超过宿主 10 MiB 限制，且未能在工作区自动定位本地路径：${fileName}`);
      }
      const payload = loadVisualFile(diskPath, convId);
      return {
        content: [{ type: 'text', text: `已通过本地直读打开大文件：${payload.fileName}` }],
        structuredContent: {
          ...payload,
          loadedViaDiskFallback: true,
        },
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(err?.message || err) }],
      };
    }
  },
);

registerAppTool(
  server,
  'app_resolve_assets',
  {
    title: '解析文档内嵌本地图片',
    description: 'App 内部使用：解析 Markdown / HTML / SVG / .canvas.json 中引用的本地图片路径为安全内联 DataURL 及真实磁盘路径',
    inputSchema: z.object({
      mode: z.enum(['markdown', 'html', 'svg', 'canvas']),
      content: z.string(),
      fileName: z.string().optional(),
      basePath: z.string().optional(),
    }),
    _meta: APP_ONLY_META,
  },
  async ({ mode, content, fileName = '', basePath = '' }, extra) => {
    try {
      const ctx = extractConvContext(extra);
      const effectiveCtx = ctx.conversationId ? ctx : findMostRecentConversation();
      const convScan = scanConversationContext(effectiveCtx.artifactsDir, detectFileMode);

      let resolvedDiskPath = basePath && existsSync(basePath) ? resolve(basePath) : '';
      if (!resolvedDiskPath && fileName) {
        resolvedDiskPath = findDiskPathForHostFile(fileName, { extra });
      }

      const baseDirs = [
        resolvedDiskPath ? dirname(resolvedDiskPath) : '',
        effectiveCtx.artifactsDir,
        convScan.workspaceDir,
        getDefaultWorkspace(),
      ].filter((d) => d && existsSync(d));

      if (mode === 'markdown') {
        const { assetMap, images } = collectLocalAssetsFromMarkdown(content, baseDirs);
        return {
          content: [{ type: 'text', text: `已解析 Markdown 内嵌图片 ${images.length} 张` }],
          structuredContent: { ok: true, assetMap, images, resolvedDiskPath },
        };
      }

      const primaryDir = baseDirs[0] || process.cwd();
      if (mode === 'canvas') {
        const doc = JSON.parse(content);
        const assetMap = collectLocalAssetsFromCanvas(doc, primaryDir);
        return {
          content: [{ type: 'text', text: `已解析画布本地素材 ${Object.keys(assetMap).length} 项` }],
          structuredContent: { ok: true, assetMap, images: [], resolvedDiskPath },
        };
      }

      const assetMap = collectLocalAssetsFromMarkup(content, primaryDir);
      return {
        content: [{ type: 'text', text: `已解析标记内嵌素材 ${Object.keys(assetMap).length} 项` }],
        structuredContent: { ok: true, assetMap, images: [], resolvedDiskPath },
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(err?.message || err) }],
      };
    }
  },
);

registerAppTool(
  server,
  'app_reveal_path',
  {
    title: '在系统文件管理器中打开所在位置',
    description: 'App 内部使用：打开文件或目录所在位置，并自动高亮选中该文件',
    inputSchema: z.object({
      targetPath: z.string(),
      openDirectory: z.boolean().optional(),
    }),
    _meta: APP_ONLY_META,
  },
  async ({ targetPath, openDirectory = false }) => {
    try {
      const abs = resolve(targetPath);
      if (!existsSync(abs)) {
        throw new Error(`路径不存在：${abs}`);
      }
      const st = statSync(abs);
      const isDir = st.isDirectory();

      if (process.platform === 'win32') {
        const winPath = abs.replace(/\//g, '\\');
        if (isDir || openDirectory) {
          const dirToOpen = isDir ? winPath : dirname(winPath);
          const child = spawn('explorer.exe', [dirToOpen], {
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
        } else {
          // Windows explorer /select, 在参数中独立传 '/select,' 与绝对路径，完美兼容含空格与中文的路径
          const child = spawn('explorer.exe', ['/select,', winPath], {
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
        }
      } else if (process.platform === 'darwin') {
        const args = isDir || openDirectory ? [isDir ? abs : dirname(abs)] : ['-R', abs];
        const child = spawn('open', args, { detached: true, stdio: 'ignore' });
        child.unref();
      } else {
        const dirToOpen = isDir ? abs : dirname(abs);
        const child = spawn('xdg-open', [dirToOpen], { detached: true, stdio: 'ignore' });
        child.unref();
      }

      return {
        content: [{ type: 'text', text: `已打开所在位置：${abs}` }],
        structuredContent: {
          ok: true,
          revealedPath: abs,
        },
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(err?.message || err) }],
      };
    }
  },
);

registerAppTool(
  server,
  'app_pdf_page',
  {
    title: '渲染 PDF 指定页并提取原文字',
    description: 'App 内部使用：加载多页 PDF 的指定页底图与可原位编辑文字坐标',
    inputSchema: z.object({
      filePath: z.string(),
      pageIndex: z.number().int().min(0),
      scale: z.number().optional(),
    }),
    _meta: APP_ONLY_META,
  },
  async ({ filePath, pageIndex, scale = 2 }) => {
    try {
      const pageData = renderPdfPage(filePath, pageIndex, scale);
      return {
        content: [{ type: 'text', text: `已渲染 PDF 第 ${pageData.pageIndex + 1}/${pageData.pageCount} 页` }],
        structuredContent: {
          ok: true,
          ...pageData,
        },
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(err?.message || err) }],
      };
    }
  },
);

registerAppTool(
  server,
  'app_pdf_open_blob',
  {
    title: '从宿主文件流加载 PDF',
    description: 'App 内部使用：将 Antigravity 原生文件视图传来的 PDF Base64 写入临时会话文件并渲染第 1 页',
    inputSchema: z.object({
      name: z.string(),
      blobBase64: z.string(),
    }),
    _meta: APP_ONLY_META,
  },
  async ({ name, blobBase64 }) => {
    try {
      const safeName = basename(name || 'document.pdf').replace(/[<>:"/\\|?*]/g, '_');
      const sessDir = join(DATA_DIR, 'pdf_sessions', `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      ensureDir(sessDir);
      const tempPath = join(sessDir, safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`);
      writeFileSync(tempPath, Buffer.from(blobBase64, 'base64'));
      const pageData = renderPdfPage(tempPath, 0, 2);
      return {
        content: [{ type: 'text', text: `已载入 PDF ${safeName}（共 ${pageData.pageCount} 页）` }],
        structuredContent: {
          ok: true,
          mode: 'pdf',
          filePath: tempPath,
          fileName: safeName,
          dir: sessDir,
          ...pageData,
        },
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(err?.message || err) }],
      };
    }
  },
);

registerAppTool(
  server,
  'app_save_pdf',
  {
    title: '将多页微改矢量写回 PDF',
    description: 'App 内部使用：对编辑过的 PDF 页面执行红涂擦除并嵌入中文字体与图像写回真实 PDF',
    inputSchema: z.object({
      filePath: z.string(),
      outputPath: z.string().optional(),
      pageEdits: z.record(z.string(), z.any()),
      returnBlob: z.boolean().optional(),
    }),
    _meta: APP_ONLY_META,
  },
  async ({ filePath, outputPath, pageEdits, returnBlob = false }, extra) => {
    try {
      const convId = extractConvContext(extra).conversationId;
      const res = await savePdfEdits({ filePath, outputPath, pageEdits });
      if (!returnBlob) {
        saveState({ lastFile: res.outputPath, lastFileAt: Date.now(), lastWorkspace: dirname(res.outputPath) }, convId);
      }
      const payload = returnBlob
        ? { ...res, blobBase64: readFileSync(res.outputPath).toString('base64') }
        : res;
      return {
        content: [{ type: 'text', text: `已保存 PDF 至 ${res.outputPath}` }],
        structuredContent: payload,
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(err?.message || err) }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
