/**
 * 平面图片自动元素识别、智能拆层、框选抠离、无痕背景修补与无损换色引擎
 * 纯前端零依赖离线 CV（运行在 < 120ms），不依赖云端 API：
 * 1. 自动背景色/渐变场估计（抗边缘噪点与 JPG 压缩伪影）
 * 2. 颜色感知连通域分割 + 同行文字智能成组（区分独立图标、弧线、徽章、卡片与文字行）
 * 3. 抗锯齿软 Alpha 抠图 + 边缘去杂色（Color Decontamination，移动/旋转无黑边白边）
 * 4. 边界波前扩散 + 多轮 Jacobi 平滑无痕背景修补（完美修复纯色与平滑渐变背景）
 * 5. 框选局部背景抠离（适用于复杂摄影/电商主图里直接抠出标题、角标、贴纸）
 */

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function rgbDist(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  const weighted = Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db);
  const maxC = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
  return weighted * 0.72 + maxC * 0.28;
}

export function rgbToHex(r, g, b) {
  return `#${clampByte(r).toString(16).padStart(2, '0')}${clampByte(g).toString(16).padStart(2, '0')}${clampByte(b).toString(16).padStart(2, '0')}`;
}

function describeColorName(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (max > 225 && sat < 0.16) return '白色';
  if (max < 55) return '深色';
  if (sat < 0.16) return max > 140 ? '浅灰' : '灰色';
  if (r >= g && r >= b) {
    if (g > 180 && b < 110) return '黄色';
    if (g > 85 && b < 110) return '橙色';
    if (b > 130) return '粉紫';
    return '红色';
  }
  if (g >= r && g >= b) {
    return b > 140 ? '青色' : '绿色';
  }
  return r > 130 ? '紫色' : '蓝色';
}

/**
 * 采样图像四周边框，构建主背景色与平滑四边双线性背景场
 */
export function estimateBackgroundModel(rgba, w, h, region = null) {
  const rx0 = region ? Math.max(0, Math.floor(region.x)) : 0;
  const ry0 = region ? Math.max(0, Math.floor(region.y)) : 0;
  const rx1 = region ? Math.min(w - 1, Math.floor(region.x + region.w - 1)) : w - 1;
  const ry1 = region ? Math.min(h - 1, Math.floor(region.y + region.h - 1)) : h - 1;
  const rw = Math.max(1, rx1 - rx0 + 1);
  const rh = Math.max(1, ry1 - ry0 + 1);
  const border = Math.max(2, Math.min(8, Math.floor(Math.min(rw, rh) * 0.04)));

  // 16 级量化直方图找最稳定背景主色
  const bins = new Map();
  const samples = [];
  const step = Math.max(1, Math.floor(Math.max(rw, rh) / 140));

  const pushSample = (x, y, side) => {
    const idx = (y * w + x) * 4;
    if (rgba[idx + 3] < 40) return;
    const r = rgba[idx];
    const g = rgba[idx + 1];
    const b = rgba[idx + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let bin = bins.get(key);
    if (!bin) {
      bin = { count: 0, sr: 0, sg: 0, sb: 0 };
      bins.set(key, bin);
    }
    bin.count++;
    bin.sr += r;
    bin.sg += g;
    bin.sb += b;
    samples.push({ x, y, r, g, b, side });
  };

  for (let x = rx0; x <= rx1; x += step) {
    for (let k = 0; k < border; k += Math.max(1, Math.floor(border / 2))) {
      pushSample(x, Math.min(ry1, ry0 + k), 0); // top
      pushSample(x, Math.max(ry0, ry1 - k), 1); // bottom
    }
  }
  for (let y = ry0; y <= ry1; y += step) {
    for (let k = 0; k < border; k += Math.max(1, Math.floor(border / 2))) {
      pushSample(Math.min(rx1, rx0 + k), y, 2); // left
      pushSample(Math.max(rx0, rx1 - k), y, 3); // right
    }
  }

  let bestBin = { count: 1, sr: 255, sg: 255, sb: 255 };
  for (const bin of bins.values()) {
    if (bin.count > bestBin.count) bestBin = bin;
  }
  const bgR = bestBin.sr / bestBin.count;
  const bgG = bestBin.sg / bestBin.count;
  const bgB = bestBin.sb / bestBin.count;

  // 统计与主背景色接近的边界噪点标准差，并计算四边均值以拟合平滑渐变背景
  const sideSum = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  let inlierCount = 0;
  let distSum = 0;

  for (const s of samples) {
    const d = rgbDist(s.r, s.g, s.b, bgR, bgG, bgB);
    if (d <= 48) {
      inlierCount++;
      distSum += d;
      const acc = sideSum[s.side];
      acc[0] += s.r;
      acc[1] += s.g;
      acc[2] += s.b;
      acc[3] += 1;
    }
  }

  const avgNoise = inlierCount > 0 ? distSum / inlierCount : 6;
  const sideColor = sideSum.map((acc) =>
    acc[3] > 2 ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]] : [bgR, bgG, bgB],
  );

  // 判断四边是否呈现渐变差异（例如径向/线性深色渐变背景）
  const edgeSpread = Math.max(
    rgbDist(...sideColor[0], ...sideColor[1]),
    rgbDist(...sideColor[2], ...sideColor[3]),
  );
  const useGradient = edgeSpread > 6 && edgeSpread < 52;

  const tLow = Math.max(13, Math.min(34, Math.round(avgNoise * 2.2 + 13)));
  const tHigh = Math.max(tLow + 18, Math.min(64, tLow + 24));

  return {
    r: bgR,
    g: bgG,
    b: bgB,
    tLow,
    tHigh,
    tMid: Math.round((tLow + tHigh) * 0.5),
    useGradient,
    at(x, y) {
      if (!useGradient) return [bgR, bgG, bgB];
      const tx = Math.max(0, Math.min(1, (x - rx0) / rw));
      const ty = Math.max(0, Math.min(1, (y - ry0) / rh));
      const top = sideColor[0];
      const bot = sideColor[1];
      const lft = sideColor[2];
      const rgt = sideColor[3];
      return [
        (top[0] * (1 - ty) + bot[0] * ty + lft[0] * (1 - tx) + rgt[0] * tx) * 0.5,
        (top[1] * (1 - ty) + bot[1] * ty + lft[1] * (1 - tx) + rgt[1] * tx) * 0.5,
        (top[2] * (1 - ty) + bot[2] * ty + lft[2] * (1 - tx) + rgt[2] * tx) * 0.5,
      ];
    },
  };
}

/**
 * 下采样 RGBA 用于超高速连通域分析（1024px -> 384px 仅需 ~20ms）
 */
function downsampleRgba(rgba, w, h, maxSide = 384) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  if (sw === w && sh === h) {
    return { data: rgba, w, h, scale: 1 };
  }
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let sy = 0; sy < sh; sy++) {
    const oy = Math.min(h - 1, Math.floor(sy / scale));
    for (let sx = 0; sx < sw; sx++) {
      const ox = Math.min(w - 1, Math.floor(sx / scale));
      const si = (oy * w + ox) * 4;
      const di = (sy * sw + sx) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return { data: out, w: sw, h: sh, scale };
}

/**
 * 在纯像素数组上自动识别所有独立前景元素（支持“智能成组”和“精细拆件”两种模式）
 * 返回：{ bgModel, scale, gridW, gridH, labels, elements: [{ id, name, x, y, w, h, area, dominantColor, labelIds }] }
 */
export function analyzeRgbaElements(rgba, fullW, fullH, options = {}) {
  const mode = options.mode || 'smart'; // 'smart' | 'fine'
  const colorSplitThreshold = mode === 'fine' ? 72 : 999;
  const ds = downsampleRgba(rgba, fullW, fullH, 384);
  const { data, w, h, scale } = ds;

  const bgModel = estimateBackgroundModel(data, w, h);
  const fg = new Uint8Array(w * h);
  const threshold = options.threshold || bgModel.tMid;

  // 若图本身带透明通道（PNG 透明图），直接以 alpha > 30 为前景
  let transparentCount = 0;
  for (let i = 3; i < data.length; i += 16) {
    if (data[i] < 200) transparentCount++;
  }
  const hasRealAlpha = transparentCount > (w * h) * 0.015;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pi = y * w + x;
      const off = pi * 4;
      const a = data[off + 3];
      if (a < 28) continue;
      if (hasRealAlpha) {
        fg[pi] = 1;
      } else {
        const [br, bg, bb] = bgModel.at(x, y);
        const d = rgbDist(data[off], data[off + 1], data[off + 2], br, bg, bb);
        if (d >= threshold) fg[pi] = 1;
      }
    }
  }

  // 8 邻域迭代 BFS 连通域标记
  const labels = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  const rawComps = [];
  let nextLabel = 1;

  for (let start = 0; start < w * h; start++) {
    if (!fg[start] || labels[start] !== 0) continue;
    const label = nextLabel++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;

    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let count = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;

    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % w;
      const cy = (cur - cx) / w;
      const coff = cur * 4;
      const cr = data[coff];
      const cg = data[coff + 1];
      const cb = data[coff + 2];

      count++;
      sr += cr;
      sg += cg;
      sb += cb;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (!fg[ni] || labels[ni] !== 0) continue;
          if (colorSplitThreshold < 500) {
            const noff = ni * 4;
            if (rgbDist(cr, cg, cb, data[noff], data[noff + 1], data[noff + 2]) > colorSplitThreshold) {
              continue;
            }
          }
          labels[ni] = label;
          queue[tail++] = ni;
        }
      }
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    // 过滤极小噪点与覆盖整张画布的误判背景块
    if (count < 8 || (bw > w * 0.96 && bh > h * 0.96 && count > w * h * 0.82)) {
      continue;
    }

    rawComps.push({
      labelIds: [label],
      minX,
      minY,
      maxX,
      maxY,
      bw,
      bh,
      count,
      r: sr / count,
      g: sg / count,
      b: sb / count,
    });
  }

  // 智能成组：将同一水平行内高度较小且间距紧凑的文字笔画/汉字合并为一个可整体拖动的文字区块
  let merged = rawComps;
  if (mode === 'smart' && rawComps.length > 1) {
    const isTextLike = (c) => c.bh <= h * 0.085 && c.bw <= w * 0.25 && c.count <= w * h * 0.015;
    const textComps = rawComps.filter(isTextLike);
    const graphicComps = rawComps.filter((c) => !isTextLike(c));

    // 按 y 再按 x 排序后聚类同行文字
    textComps.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
    const groups = [];
    for (const c of textComps) {
      let joined = false;
      for (const g of groups) {
        const yOverlap = Math.min(g.maxY, c.maxY) - Math.max(g.minY, c.minY);
        const minH = Math.min(g.bh, c.bh);
        const maxH = Math.max(g.bh, c.bh);
        const sameRow = yOverlap >= -minH * 0.25 && Math.abs((g.minY + g.maxY) / 2 - (c.minY + c.maxY) / 2) <= maxH * 0.75;
        const xGap = Math.max(0, c.minX - g.maxX, g.minX - c.maxX);
        if (sameRow && xGap <= Math.max(maxH * 2.2, 12)) {
          g.labelIds.push(...c.labelIds);
          g.minX = Math.min(g.minX, c.minX);
          g.minY = Math.min(g.minY, c.minY);
          g.maxX = Math.max(g.maxX, c.maxX);
          g.maxY = Math.max(g.maxY, c.maxY);
          g.bw = g.maxX - g.minX + 1;
          g.bh = g.maxY - g.minY + 1;
          const total = g.count + c.count;
          g.r = (g.r * g.count + c.r * c.count) / total;
          g.g = (g.g * g.count + c.g * c.count) / total;
          g.b = (g.b * g.count + c.b * c.count) / total;
          g.count = total;
          g.isTextGroup = true;
          joined = true;
          break;
        }
      }
      if (!joined) {
        groups.push({ ...c, labelIds: [...c.labelIds], isTextGroup: false });
      }
    }

    // 二次合并同一行中可能拆成两段的紧邻词组
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
          const a = groups[i];
          const b = groups[j];
          const maxH = Math.max(a.bh, b.bh);
          const sameRow = Math.abs((a.minY + a.maxY) / 2 - (b.minY + b.maxY) / 2) <= maxH * 0.7;
          const xGap = Math.max(0, b.minX - a.maxX, a.minX - b.maxX);
          if (sameRow && xGap <= Math.max(maxH * 2.4, 14)) {
            a.labelIds.push(...b.labelIds);
            a.minX = Math.min(a.minX, b.minX);
            a.minY = Math.min(a.minY, b.minY);
            a.maxX = Math.max(a.maxX, b.maxX);
            a.maxY = Math.max(a.maxY, b.maxY);
            a.bw = a.maxX - a.minX + 1;
            a.bh = a.maxY - a.minY + 1;
            a.count += b.count;
            a.isTextGroup = true;
            groups.splice(j, 1);
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }

    // 过滤落单的微小噪点
    const validGroups = groups.filter((g) => g.count >= 22 || g.bw >= 18);
    merged = [...graphicComps, ...validGroups];
  }

  // 面积从大到小排序（大图在下，小图在上，方便点选），再映射回原图全分辨率坐标
  merged.sort((a, b) => b.bw * b.bh - a.bw * a.bh);

  const pad = 3;
  const elements = merged.slice(0, 36).map((c, idx) => {
    const x = Math.max(0, Math.floor(c.minX / scale) - pad);
    const y = Math.max(0, Math.floor(c.minY / scale) - pad);
    const x2 = Math.min(fullW, Math.ceil((c.maxX + 1) / scale) + pad);
    const y2 = Math.min(fullH, Math.ceil((c.maxY + 1) / scale) + pad);
    const ew = Math.max(4, x2 - x);
    const eh = Math.max(4, y2 - y);
    const colorName = describeColorName(c.r, c.g, c.b);
    const kindName = c.isTextGroup
      ? '文字块'
      : ew / eh > 2.2 || eh / ew > 2.2
        ? '条形元素'
        : '图形元素';
    return {
      id: `img_el_${idx + 1}`,
      name: `${colorName}${kindName} ${idx + 1}`,
      x,
      y,
      w: ew,
      h: eh,
      area: Math.round(c.count / (scale * scale)),
      dominantColor: rgbToHex(c.r, c.g, c.b),
      meanRgb: [c.r, c.g, c.b],
      isTextGroup: Boolean(c.isTextGroup),
      labelIds: c.labelIds,
    };
  });

  return {
    bgModel,
    hasRealAlpha,
    scale,
    gridW: w,
    gridH: h,
    labels,
    elements,
  };
}

/**
 * 对全分辨率 RGBA 缓冲区执行：
 * 1. 抠出指定元素（支持分析出的 labelIds 或任意用户框选 region），带软抗锯齿与边缘去杂色
 * 2. 在原底图 RGBA 上对该元素的掩码区域执行边界扩散 + 多轮 Jacobi 无痕背景修补
 */
export function extractAndInpaintRgba(baseRgba, fullW, fullH, analysis, target) {
  const isBoxMode = Boolean(target.isBox);
  const bx = Math.max(0, Math.floor(target.x));
  const by = Math.max(0, Math.floor(target.y));
  const bw = Math.min(fullW - bx, Math.ceil(target.w));
  const bh = Math.min(fullH - by, Math.ceil(target.h));
  if (bw < 3 || bh < 3) return null;

  // 局部框选模式严格采样用户选框自身边缘（不往外扩 6px，避免吃到相邻行文字/分割线）
  let localBg = analysis?.bgModel;
  let boxUseFullPatch = false;
  if (isBoxMode) {
    localBg = estimateBackgroundModel(baseRgba, fullW, fullH, { x: bx, y: by, w: bw, h: bh });
    // 检测选框四边背景一致性：若四边颜色极度杂乱（如复杂实景照片），则整块完整抠出不误吞内部细节
    let perimTotal = 0;
    let perimMatch = 0;
    const step = Math.max(1, Math.floor(Math.max(bw, bh) / 80));
    const checkPerim = (px, py) => {
      const off = (py * fullW + px) * 4;
      if (baseRgba[off + 3] < 20) return;
      perimTotal++;
      const [br, bgc, bb] = localBg.at(px, py);
      if (rgbDist(baseRgba[off], baseRgba[off + 1], baseRgba[off + 2], br, bgc, bb) <= localBg.tHigh + 10) {
        perimMatch++;
      }
    };
    for (let x = bx; x < bx + bw; x += step) {
      checkPerim(x, by);
      checkPerim(x, by + bh - 1);
    }
    for (let y = by; y < by + bh; y += step) {
      checkPerim(bx, y);
      checkPerim(bx + bw - 1, y);
    }
    boxUseFullPatch = perimTotal > 0 && perimMatch / perimTotal < 0.55;
  }

  const labelSet = !isBoxMode && Array.isArray(target.labelIds) ? new Set(target.labelIds) : null;
  const { scale, gridW, gridH, labels, hasRealAlpha } = analysis || {};

  // 1. 生成全分辨率局部软 Alpha 掩码与修补洞掩码
  const cutRgba = new Uint8ClampedArray(bw * bh * 4);
  const holeMask = new Uint8Array(bw * bh);
  let fgPixelCount = 0;

  // 若是 labelSet 模式，判断原图该像素邻近 1 个分析格是否属于该元素，允许 2px 抗锯齿外扩
  const nearLabel = (fx, fy) => {
    if (!labelSet) return true;
    const gx = Math.min(gridW - 1, Math.max(0, Math.floor(fx * scale)));
    const gy = Math.min(gridH - 1, Math.max(0, Math.floor(fy * scale)));
    if (labelSet.has(labels[gy * gridW + gx])) return true;
    // 允许 1 格邻域以保留高分辨率抗锯齿软边
    for (let dy = -1; dy <= 1; dy++) {
      const ny = gy + dy;
      if (ny < 0 || ny >= gridH) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = gx + dx;
        if (nx < 0 || nx >= gridW) continue;
        if (labelSet.has(labels[ny * gridW + nx])) return true;
      }
    }
    return false;
  };

  // 根据前景主色与背景色的真实对比度自适应调整软抠图上限，消除白/橙图形外圈 1px 暗边
  const fgMean = Array.isArray(target.meanRgb) ? target.meanRgb : null;
  const fgContrast = fgMean ? rgbDist(fgMean[0], fgMean[1], fgMean[2], localBg.r, localBg.g, localBg.b) : 90;
  const adaptiveHigh = Math.max(localBg.tHigh, Math.min(185, Math.round(localBg.tLow + fgContrast * 0.62)));

  let trimMinX = bw;
  let trimMinY = bh;
  let trimMaxX = -1;
  let trimMaxY = -1;

  for (let ly = 0; ly < bh; ly++) {
    const fy = by + ly;
    for (let lx = 0; lx < bw; lx++) {
      const fx = bx + lx;
      if (!nearLabel(fx, fy)) continue;

      const srcOff = (fy * fullW + fx) * 4;
      const r = baseRgba[srcOff];
      const g = baseRgba[srcOff + 1];
      const b = baseRgba[srcOff + 2];
      const a0 = baseRgba[srcOff + 3];
      if (a0 < 12) continue;

      if (isBoxMode && boxUseFullPatch) {
        const dstOff = (ly * bw + lx) * 4;
        cutRgba[dstOff] = r;
        cutRgba[dstOff + 1] = g;
        cutRgba[dstOff + 2] = b;
        cutRgba[dstOff + 3] = a0;
        holeMask[ly * bw + lx] = 1;
        fgPixelCount++;
        if (lx < trimMinX) trimMinX = lx;
        if (lx > trimMaxX) trimMaxX = lx;
        if (ly < trimMinY) trimMinY = ly;
        if (ly > trimMaxY) trimMaxY = ly;
        continue;
      }

      let alphaNorm = 0;
      let br = localBg.r;
      let bg = localBg.g;
      let bb = localBg.b;

      if (hasRealAlpha && !isBoxMode) {
        alphaNorm = a0 / 255;
      } else {
        const bgRgb = localBg.at(isBoxMode ? fx : fx * scale, isBoxMode ? fy : fy * scale);
        br = bgRgb[0];
        bg = bgRgb[1];
        bb = bgRgb[2];
        const d = rgbDist(r, g, b, br, bg, bb);
        if (d <= localBg.tLow) {
          alphaNorm = 0;
        } else if (d >= adaptiveHigh) {
          alphaNorm = 1;
        } else {
          alphaNorm = (d - localBg.tLow) / Math.max(1, adaptiveHigh - localBg.tLow);
        }
      }

      if (alphaNorm <= 0.04) continue;

      // 边缘去杂色（Color Decontamination）：剥离半透明边缘混入的背景色，避免黑边/白边
      let outR = r;
      let outG = g;
      let outB = b;
      if (!hasRealAlpha && alphaNorm > 0.05 && alphaNorm < 0.98) {
        outR = clampByte((r - (1 - alphaNorm) * br) / alphaNorm);
        outG = clampByte((g - (1 - alphaNorm) * bg) / alphaNorm);
        outB = clampByte((b - (1 - alphaNorm) * bb) / alphaNorm);
      }

      const dstOff = (ly * bw + lx) * 4;
      cutRgba[dstOff] = outR;
      cutRgba[dstOff + 1] = outG;
      cutRgba[dstOff + 2] = outB;
      cutRgba[dstOff + 3] = clampByte(alphaNorm * a0);

      if (alphaNorm >= 0.08) {
        holeMask[ly * bw + lx] = 1;
        fgPixelCount++;
        if (lx < trimMinX) trimMinX = lx;
        if (lx > trimMaxX) trimMaxX = lx;
        if (ly < trimMinY) trimMinY = ly;
        if (ly > trimMaxY) trimMaxY = ly;
      }
    }
  }

  if (fgPixelCount < 10) return null;

  // 2. 修补底图孔洞：
  // - 框选模式下严格限制所有修改均在用户选框 [bx, bx+bw) × [by, by+bh) 内，绝不越界破坏选区外任何 1 像素！
  // - 自动识别模式允许 4px 膨胀消除 JPG 压缩蚊式噪点环
  const padInpaint = isBoxMode ? 4 : 10;
  const dilateR = isBoxMode ? 1 : 4;
  const ix0 = Math.max(0, bx - padInpaint);
  const iy0 = Math.max(0, by - padInpaint);
  const ix1 = Math.min(fullW - 1, bx + bw - 1 + padInpaint);
  const iy1 = Math.min(fullH - 1, by + bh - 1 + padInpaint);
  const iw = ix1 - ix0 + 1;
  const ih = iy1 - iy0 + 1;

  const boxMinGx = bx - ix0;
  const boxMaxGx = bx + bw - 1 - ix0;
  const boxMinGy = by - iy0;
  const boxMaxGy = by + bh - 1 - iy0;

  const mask = new Uint8Array(iw * ih);
  for (let ly = 0; ly < bh; ly++) {
    for (let lx = 0; lx < bw; lx++) {
      if (!holeMask[ly * bw + lx]) continue;
      const gx = bx + lx - ix0;
      const gy = by + ly - iy0;
      for (let dy = -dilateR; dy <= dilateR; dy++) {
        const ny = gy + dy;
        if (ny < 0 || ny >= ih) continue;
        if (isBoxMode && (ny < boxMinGy || ny > boxMaxGy)) continue;
        for (let dx = -dilateR; dx <= dilateR; dx++) {
          const nx = gx + dx;
          if (nx < 0 || nx >= iw) continue;
          if (isBoxMode && (nx < boxMinGx || nx > boxMaxGx)) continue;
          mask[ny * iw + nx] = 1;
        }
      }
    }
  }

  // 若是透明 PNG 底图，直接将原图对应区域清空为透明即可
  if (hasRealAlpha && !isBoxMode) {
    for (let y = 0; y < ih; y++) {
      for (let x = 0; x < iw; x++) {
        if (!mask[y * iw + x]) continue;
        const off = ((iy0 + y) * fullW + (ix0 + x)) * 4;
        baseRgba[off + 3] = 0;
      }
    }
  } else {
    // 拷贝局部 RGB 浮点缓冲，用 BFS 边界推进初始化孔洞 + 8 轮 Jacobi 扩散平滑修补
    const bufR = new Float32Array(iw * ih);
    const bufG = new Float32Array(iw * ih);
    const bufB = new Float32Array(iw * ih);
    const filled = new Uint8Array(iw * ih);
    const bfsQ = new Int32Array(iw * ih);
    let qHead = 0;
    let qTail = 0;

    for (let y = 0; y < ih; y++) {
      for (let x = 0; x < iw; x++) {
        const idx = y * iw + x;
        const off = ((iy0 + y) * fullW + (ix0 + x)) * 4;
        if (mask[idx]) {
          // 初始默认先填主背景色作保底
          bufR[idx] = localBg.r;
          bufG[idx] = localBg.g;
          bufB[idx] = localBg.b;
          filled[idx] = 0;
        } else {
          bufR[idx] = baseRgba[off];
          bufG[idx] = baseRgba[off + 1];
          bufB[idx] = baseRgba[off + 2];
          filled[idx] = 1;
        }
      }
    }

    // 收集紧邻有效背景像素的第一圈待修补像素
    for (let y = 0; y < ih; y++) {
      for (let x = 0; x < iw; x++) {
        const idx = y * iw + x;
        if (filled[idx]) continue;
        if (
          (x > 0 && filled[idx - 1]) ||
          (x + 1 < iw && filled[idx + 1]) ||
          (y > 0 && filled[idx - iw]) ||
          (y + 1 < ih && filled[idx + iw])
        ) {
          filled[idx] = 2; // 排队标记
          bfsQ[qTail++] = idx;
        }
      }
    }

    // 由外向内波前扩散填充，无缝延续周围渐变与色调
    while (qHead < qTail) {
      const idx = bfsQ[qHead++];
      const x = idx % iw;
      const y = (idx - x) / iw;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let cnt = 0;

      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x + 1 < iw ? idx + 1 : -1,
        y > 0 ? idx - iw : -1,
        y + 1 < ih ? idx + iw : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && filled[n] === 1) {
          sr += bufR[n];
          sg += bufG[n];
          sb += bufB[n];
          cnt++;
        } else if (n >= 0 && filled[n] === 0) {
          filled[n] = 2;
          bfsQ[qTail++] = n;
        }
      }
      if (cnt > 0) {
        bufR[idx] = sr / cnt;
        bufG[idx] = sg / cnt;
        bufB[idx] = sb / cnt;
      }
      filled[idx] = 1;
    }

    // 8 轮 Jacobi 扩散消除接缝条纹
    const tmpR = new Float32Array(bufR);
    const tmpG = new Float32Array(bufG);
    const tmpB = new Float32Array(bufB);
    for (let iter = 0; iter < 8; iter++) {
      for (let y = 1; y < ih - 1; y++) {
        for (let x = 1; x < iw - 1; x++) {
          const idx = y * iw + x;
          if (!mask[idx]) continue;
          tmpR[idx] = (bufR[idx - 1] + bufR[idx + 1] + bufR[idx - iw] + bufR[idx + iw]) * 0.25;
          tmpG[idx] = (bufG[idx - 1] + bufG[idx + 1] + bufG[idx - iw] + bufG[idx + iw]) * 0.25;
          tmpB[idx] = (bufB[idx - 1] + bufB[idx + 1] + bufB[idx - iw] + bufB[idx + iw]) * 0.25;
        }
      }
      for (let i = 0; i < iw * ih; i++) {
        if (mask[i]) {
          bufR[i] = tmpR[i];
          bufG[i] = tmpG[i];
          bufB[i] = tmpB[i];
        }
      }
    }

    // 写回原底图 RGBA
    for (let y = 0; y < ih; y++) {
      for (let x = 0; x < iw; x++) {
        const idx = y * iw + x;
        if (!mask[idx]) continue;
        const off = ((iy0 + y) * fullW + (ix0 + x)) * 4;
        baseRgba[off] = clampByte(bufR[idx]);
        baseRgba[off + 1] = clampByte(bufG[idx]);
        baseRgba[off + 2] = clampByte(bufB[idx]);
        baseRgba[off + 3] = 255;
      }
    }
  }

  // 框选模式下紧贴前景裁掉多余透明空白边（保留 2px 呼吸边），选框更精准跟手
  if (isBoxMode && !boxUseFullPatch && trimMaxX >= trimMinX && trimMaxY >= trimMinY) {
    const tx0 = Math.max(0, trimMinX - 2);
    const ty0 = Math.max(0, trimMinY - 2);
    const tx1 = Math.min(bw - 1, trimMaxX + 2);
    const ty1 = Math.min(bh - 1, trimMaxY + 2);
    const tw = tx1 - tx0 + 1;
    const th = ty1 - ty0 + 1;
    if (tw >= 4 && th >= 4 && (tw < bw || th < bh)) {
      const trimmed = new Uint8ClampedArray(tw * th * 4);
      for (let y = 0; y < th; y++) {
        const srcStart = ((ty0 + y) * bw + tx0) * 4;
        trimmed.set(cutRgba.subarray(srcStart, srcStart + tw * 4), y * tw * 4);
      }
      return {
        cutRgba: trimmed,
        x: bx + tx0,
        y: by + ty0,
        w: tw,
        h: th,
        left: bx + tx0 + tw / 2,
        top: by + ty0 + th / 2,
      };
    }
  }

  return {
    cutRgba,
    x: bx,
    y: by,
    w: bw,
    h: bh,
    left: bx + bw / 2,
    top: by + bh / 2,
  };
}

/**
 * 浏览器端便捷封装：对 HTMLImageElement / Canvas 生成可编辑像素上下文
 */
export function createRasterSession(imgEl) {
  const w = imgEl.naturalWidth || imgEl.width;
  const h = imgEl.naturalHeight || imgEl.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imgEl, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  return { canvas, ctx, imageData, w, h };
}

export function cutRgbaToDataUrl(cutRgba, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(cutRgba, w, h), 0, 0);
  return c.toDataURL('image/png');
}

export function sessionToDataUrl(session) {
  session.ctx.putImageData(session.imageData, 0, 0);
  return session.canvas.toDataURL('image/png');
}

/**
 * 对抠出的图形元素执行无损换色（保留抗锯齿透明边缘与明暗层次）
 */
export async function recolorImageDataUrl(dataUrl, targetHex) {
  const hex = String(targetHex || '').replace('#', '');
  if (hex.length !== 6) return dataUrl;
  const tr = parseInt(hex.slice(0, 2), 16);
  const tg = parseInt(hex.slice(2, 4), 16);
  const tb = parseInt(hex.slice(4, 6), 16);

  const img = await new Promise((res, rej) => {
    const el = new Image();
    el.onload = () => res(el);
    el.onerror = rej;
    el.src = dataUrl;
  });

  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;

  // 计算该元素内部亮度范围，使扁平纯色图标彻底变成目标色，带高光阴影的元素保留立体质感
  let minLum = 255;
  let maxLum = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 32) continue;
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
  }
  const lumSpan = maxLum - minLum;
  const isFlat = lumSpan < 60;

  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 4) continue;
    if (isFlat) {
      d[i] = tr;
      d[i + 1] = tg;
      d[i + 2] = tb;
    } else {
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] - minLum) / Math.max(1, lumSpan);
      const factor = 0.45 + lum * 0.7;
      d[i] = clampByte(tr * factor);
      d[i + 1] = clampByte(tg * factor);
      d[i + 2] = clampByte(tb * factor);
    }
  }

  ctx.putImageData(id, 0, 0);
  return c.toDataURL('image/png');
}

/**
 * 平面图背景底图换色：
 * - 若图内元素已全拆（或底图本身基本均匀），将整个背景精准替换为目标色（保留温和渐变层次，彻底消除深色变白发灰的问题）
 * - 若底图上仍保留未拆出的前景元素，仅替换背景区域并做抗锯齿去边合成，完整保护前景图形不串色
 */
export function recolorRasterBackgroundRgba(srcRgba, w, h, targetHex, { allLifted = false, bgModel = null } = {}) {
  const hex = String(targetHex || '').replace('#', '');
  const out = new Uint8ClampedArray(srcRgba);
  if (hex.length !== 6) return out;
  const tr = parseInt(hex.slice(0, 2), 16);
  const tg = parseInt(hex.slice(2, 4), 16);
  const tb = parseInt(hex.slice(4, 6), 16);

  const bg = bgModel || estimateBackgroundModel(srcRgba, w, h);

  // 检查是否整张底图几乎全为背景（例如全图拆层之后）
  let bgLikeCount = 0;
  let sampleTotal = 0;
  const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 4096)));
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const off = (y * w + x) * 4;
      if (srcRgba[off + 3] < 16) continue;
      sampleTotal++;
      const [br, bgc, bb] = bg.at(x, y);
      if (rgbDist(srcRgba[off], srcRgba[off + 1], srcRgba[off + 2], br, bgc, bb) <= bg.tHigh + 18) {
        bgLikeCount++;
      }
    }
  }
  const mostlyUniformBg = allLifted || (sampleTotal > 0 && bgLikeCount / sampleTotal >= 0.94);
  const softSpan = Math.max(16, (bg.tHigh + 18) - bg.tLow);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * 4;
      const a = srcRgba[off + 3];
      if (a < 4) continue;
      const r = srcRgba[off];
      const g = srcRgba[off + 1];
      const b = srcRgba[off + 2];

      if (mostlyUniformBg) {
        if (bg.useGradient) {
          const dr = r - bg.r;
          const dg = g - bg.g;
          const db = b - bg.b;
          out[off] = clampByte(tr + dr * 0.55);
          out[off + 1] = clampByte(tg + dg * 0.55);
          out[off + 2] = clampByte(tb + db * 0.55);
        } else {
          // 扁平底色直接精准换成目标纯色（如黑底 #0F1114 -> 纯白 #FFFFFF）
          out[off] = tr;
          out[off + 1] = tg;
          out[off + 2] = tb;
        }
        continue;
      }

      const [br, bgc, bb] = bg.at(x, y);
      const d = rgbDist(r, g, b, br, bgc, bb);
      if (d <= bg.tLow) {
        if (bg.useGradient) {
          out[off] = clampByte(tr + (br - bg.r) * 0.55);
          out[off + 1] = clampByte(tg + (bgc - bg.g) * 0.55);
          out[off + 2] = clampByte(tb + (bb - bg.b) * 0.55);
        } else {
          out[off] = tr;
          out[off + 1] = tg;
          out[off + 2] = tb;
        }
      } else if (d < bg.tLow + softSpan) {
        const fgAlpha = (d - bg.tLow) / softSpan;
        const inv = 1 - fgAlpha;
        // 反推前景纯色后再与新底色抗锯齿混合，避免黑底换白底留灰边
        const fgR = Math.max(0, Math.min(255, (r - inv * br) / Math.max(0.2, fgAlpha)));
        const fgG = Math.max(0, Math.min(255, (g - inv * bgc) / Math.max(0.2, fgAlpha)));
        const fgB = Math.max(0, Math.min(255, (b - inv * bb) / Math.max(0.2, fgAlpha)));
        out[off] = clampByte(fgAlpha * fgR + inv * tr);
        out[off + 1] = clampByte(fgAlpha * fgG + inv * tg);
        out[off + 2] = clampByte(fgAlpha * fgB + inv * tb);
      }
    }
  }

  return out;
}
