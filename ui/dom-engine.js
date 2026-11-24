/**
 * Engine B: HTML / SVG 鼠标直编视觉操纵引擎
 * 将 AI 输出的任意 .html 海报/详情页 或 .svg 矢量图挂载到隔离舞台，
 * 直接用鼠标点选、拖拽移动（带画布居中磁性吸附线）、8点缩放、顶部手柄旋转/摆正 0°、双击改字，
 * 保存时干净回写源 .html / .svg 文件，并支持 2x 高清 PNG/JPG 导出。
 */

const SNAP_PX = 7;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizeAngle(deg) {
  let a = ((deg % 360) + 540) % 360 - 180;
  return Math.round(a * 10) / 10;
}

function rgbToHex(colorStr) {
  if (!colorStr) return '#000000';
  if (colorStr.startsWith('#')) {
    if (colorStr.length === 4) {
      return `#${colorStr[1]}${colorStr[1]}${colorStr[2]}${colorStr[2]}${colorStr[3]}${colorStr[3]}`;
    }
    return colorStr.slice(0, 7);
  }
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(colorStr);
  if (!m) return '#111827';
  const hex = (n) => Number(n).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

/**
 * 从元素当前计算矩阵解析已存在的旋转角（度），便于把原本就歪的元素直接“摆正 0°”
 */
function parseComputedAngle(el) {
  try {
    const tf = getComputedStyle(el).transform;
    if (!tf || tf === 'none') return 0;
    const m = /^matrix\(([^)]+)\)/.exec(tf);
    if (!m) return 0;
    const [a, b] = m[1].split(',').map((s) => parseFloat(s.trim()));
    return normalizeAngle(Math.atan2(b, a) * (180 / Math.PI));
  } catch {
    return 0;
  }
}

/**
 * 将 HTML 文档中的 body/html 选择器改写为 .vcs-html-root，确保在 Shadow DOM 中样式 100% 还原
 */
function scopeHtmlCss(cssText) {
  return cssText.replace(/(^|[},;]\s*)(html|body)(?=[\s,{:.#>+~[])/gi, '$1.vcs-html-root');
}

export class DomVisualEngine {
  constructor(els, callbacks) {
    this.frameEl = els.frameEl;
    this.hostEl = els.hostEl;
    this.overlayEl = els.overlayEl;
    this.hoverBox = els.hoverBox;
    this.hoverTag = els.hoverTag;
    this.selectBox = els.selectBox;
    this.guideV = els.guideV;
    this.guideH = els.guideH;
    this.cb = callbacks || {};

    this.mode = 'html'; // 'html' | 'svg'
    this.docWidth = 800;
    this.docHeight = 800;
    this.zoom = 1;
    this.assetMap = {};
    this.origDocMeta = null; // 保留原 HTML 的 doctype / head / 原始 <style>
    this.shadowRoot = null;
    this.rootContainer = null; // .vcs-html-root 或 <svg>
    this.selectedEl = null;
    this.hoveredEl = null;
    this.dragState = null;
    this.history = [];
    this.historyIdx = -1;
    this.isRestoring = false;

    this.bindOverlayEvents();
  }

  bindOverlayEvents() {
    // 拖拽 8 个缩放点或旋转手柄
    this.selectBox.addEventListener('pointerdown', (e) => {
      const handle = e.target?.dataset?.handle;
      if (!handle || !this.selectedEl) return;
      e.preventDefault();
      e.stopPropagation();
      this.startGizmoAction(handle, e);
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.dragState) return;
      this.onGizmoMove(e);
    });

    window.addEventListener('pointerup', () => {
      if (!this.dragState) return;
      this.finishGizmoAction();
    });
  }

  loadMarkup(mode, rawMarkup, assetMap = {}) {
    this.mode = mode;
    this.assetMap = { ...assetMap };
    this.selectedEl = null;
    this.hoveredEl = null;
    this.hideGuides();
    this.hoverBox.classList.add('hidden');
    this.selectBox.classList.add('hidden');

    if (!this.shadowRoot) {
      this.shadowRoot = this.hostEl.attachShadow({ mode: 'open' });
    }
    this.shadowRoot.innerHTML = '';

    if (mode === 'html') {
      this.mountHtml(rawMarkup);
    } else {
      this.mountSvg(rawMarkup);
    }

    this.bindRootPointerEvents();
    this.applyZoomTransform();
    this.history = [this.serialize()];
    this.historyIdx = 0;
    this.cb.onHistoryChange?.(false, false);
    this.cb.onSelectionChange?.(null);
    this.cb.onLayersChange?.(this.getLayersList());
  }

  mountHtml(rawHtml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');
    const doctypeMatch = /^(\s*<!doctype[^>]*>)/i.exec(rawHtml);

    // 保留 head 中原始节点以便保存回磁盘时无损还原
    const styleEls = Array.from(doc.querySelectorAll('style'));
    const rawStyles = styleEls.map((s) => s.textContent || '');
    const headNonStyleNodes = Array.from(doc.head.children)
      .filter((el) => el.tagName !== 'STYLE')
      .map((el) => el.outerHTML);

    this.origDocMeta = {
      doctype: doctypeMatch ? doctypeMatch[1] : '<!doctype html>',
      htmlAttrs: Array.from(doc.documentElement.attributes).map((a) => [a.name, a.value]),
      bodyAttrs: Array.from(doc.body.attributes).map((a) => [a.name, a.value]),
      headNonStyleHtml: headNonStyleNodes.join('\n  '),
      rawStyles,
    };

    // 推断画布尺寸（优先读 meta canvas-size，其次读首层海报卡片/style 宽高，默认 800x800）
    let width = 800;
    let height = 800;
    const metaSize = doc.querySelector('meta[name="canvas-size"]')?.getAttribute('content');
    if (metaSize && /^\d+\s*[x×]\s*\d+$/i.test(metaSize)) {
      const [w, h] = metaSize.split(/[x×]/i).map(Number);
      width = w;
      height = h;
    } else {
      const combinedCss = rawStyles.join('\n');
      const wMatch = /(?:\.poster|\.canvas|\.artboard|body)\s*\{[^}]*?width\s*:\s*(\d+)px/i.exec(combinedCss);
      const hMatch = /(?:\.poster|\.canvas|\.artboard|body)\s*\{[^}]*?height\s*:\s*(\d+)px/i.exec(combinedCss);
      if (wMatch) width = clamp(Number(wMatch[1]), 200, 3000);
      if (hMatch) height = clamp(Number(hMatch[1]), 200, 5000);
    }

    this.docWidth = width;
    this.docHeight = height;

    // 构造隔离在 Shadow DOM 内部的挂载容器
    const wrapper = document.createElement('div');
    wrapper.className = 'vcs-html-root';
    wrapper.style.position = 'relative';
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;
    wrapper.style.overflow = 'hidden';
    wrapper.style.boxSizing = 'border-box';
    // 继承原 body 内联样式
    const bodyStyle = doc.body.getAttribute('style');
    if (bodyStyle) {
      wrapper.setAttribute('style', `${wrapper.getAttribute('style')};${bodyStyle}`);
    }

    // 把作用域化后的 CSS 放入 Shadow DOM（同时支持 foreignObject 导出）
    const styleTag = document.createElement('style');
    styleTag.setAttribute('data-vcs-internal-style', '1');
    styleTag.textContent = rawStyles.map((css) => this.inlineCssUrls(scopeHtmlCss(css))).join('\n');
    wrapper.appendChild(styleTag);

    // 搬运 body 子节点（排除已经提取的 <style>）
    for (const node of Array.from(doc.body.childNodes)) {
      if (node.nodeType === 1 && node.tagName === 'STYLE') continue;
      wrapper.appendChild(document.importNode(node, true));
    }

    // 替换本地图片 src 为内联 dataURL，并记住原路径
    this.applyAssetMapToElement(wrapper);

    // 为无 id 的可视化子元素分配稳定编辑索引
    this.shadowRoot.appendChild(wrapper);
    this.rootContainer = wrapper;

    // 若内容实际高度远超默认 800（例如电商长详情页），自动适配高度
    requestAnimationFrame(() => {
      if (!metaSize && wrapper.scrollHeight > this.docHeight + 40 && wrapper.scrollHeight <= 4000) {
        this.docHeight = wrapper.scrollHeight;
        wrapper.style.height = `${this.docHeight}px`;
        this.applyZoomTransform();
      }
    });
  }

  mountSvg(rawSvg) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawSvg, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) {
      throw new Error('SVG 文件解析失败：未找到 <svg> 根节点');
    }

    let width = parseFloat(svg.getAttribute('width')) || 800;
    let height = parseFloat(svg.getAttribute('height')) || 800;
    const vb = svg.getAttribute('viewBox');
    if (vb) {
      const parts = vb.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        width = parts[2];
        height = parts[3];
      }
    }
    this.docWidth = clamp(Math.round(width), 100, 4000);
    this.docHeight = clamp(Math.round(height), 100, 5000);

    const imported = document.importNode(svg, true);
    imported.setAttribute('width', String(this.docWidth));
    imported.setAttribute('height', String(this.docHeight));
    if (!imported.getAttribute('viewBox')) {
      imported.setAttribute('viewBox', `0 0 ${this.docWidth} ${this.docHeight}`);
    }
    imported.style.display = 'block';
    this.applyAssetMapToElement(imported);

    this.shadowRoot.appendChild(imported);
    this.rootContainer = imported;
  }

  inlineCssUrls(css) {
    return css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (full, q, raw) => {
      const mapped = this.assetMap[raw];
      return mapped ? `url("${mapped}")` : full;
    });
  }

  applyAssetMapToElement(root) {
    // <img>
    for (const img of root.querySelectorAll('img')) {
      const orig = img.getAttribute('src');
      if (orig && this.assetMap[orig]) {
        img.setAttribute('data-vcs-orig-src', orig);
        img.setAttribute('src', this.assetMap[orig]);
      }
    }
    // SVG <image>
    for (const img of root.querySelectorAll('image')) {
      const orig = img.getAttribute('href') || img.getAttribute('xlink:href');
      if (orig && this.assetMap[orig]) {
        img.setAttribute('data-vcs-orig-href', orig);
        img.setAttribute('href', this.assetMap[orig]);
      }
    }
    // 内联 style background-image url(...)
    for (const el of root.querySelectorAll('[style]')) {
      const st = el.getAttribute('style') || '';
      if (st.includes('url(')) {
        const replaced = this.inlineCssUrls(st);
        if (replaced !== st) {
          el.setAttribute('data-vcs-orig-bg-style', st);
          el.setAttribute('style', replaced);
        }
      }
    }
  }

  bindRootPointerEvents() {
    if (!this.rootContainer) return;

    const pickTarget = (rawTarget) => {
      if (!rawTarget || rawTarget === this.rootContainer || rawTarget === this.shadowRoot) return null;
      if (rawTarget.tagName === 'STYLE' || rawTarget.tagName === 'DEFS' || rawTarget.tagName === 'SCRIPT') return null;
      return rawTarget;
    };

    this.rootContainer.addEventListener('pointermove', (e) => {
      if (this.dragState) return;
      const target = pickTarget(e.target);
      if (target && target !== this.selectedEl) {
        this.hoveredEl = target;
        this.renderHoverBox(target);
      } else {
        this.hoveredEl = null;
        this.hoverBox.classList.add('hidden');
      }
    });

    this.rootContainer.addEventListener('pointerleave', () => {
      this.hoveredEl = null;
      this.hoverBox.classList.add('hidden');
    });

    this.rootContainer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const target = pickTarget(e.target);
      if (!target) {
        this.clearSelection();
        return;
      }
      // 如果当前正在双击编辑文本，允许正常光标选字
      if (target.isContentEditable) return;

      e.preventDefault();
      e.stopPropagation();
      this.selectElement(target);
      this.startGizmoAction('move', e);
    });

    // 双击 HTML 文字元素直接进入原位编辑模式
    this.rootContainer.addEventListener('dblclick', (e) => {
      const target = pickTarget(e.target);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      this.selectElement(target);

      if (this.mode === 'html' && target.children.length === 0 && target.tagName !== 'IMG') {
        target.contentEditable = 'true';
        target.focus();
        const onBlur = () => {
          target.contentEditable = 'false';
          target.removeEventListener('blur', onBlur);
          this.pushHistory();
          this.cb.onChange?.();
          this.updateSelectBox();
          this.cb.onSelectionChange?.(this.getSelectedProps());
        };
        target.addEventListener('blur', onBlur);
      } else {
        this.cb.onFocusTextProp?.();
      }
    });
  }

  getArtboardRect() {
    return this.frameEl.getBoundingClientRect();
  }

  getElementArtboardBox(el) {
    const ab = this.getArtboardRect();
    const r = el.getBoundingClientRect();
    return {
      left: (r.left - ab.left) / this.zoom,
      top: (r.top - ab.top) / this.zoom,
      width: r.width / this.zoom,
      height: r.height / this.zoom,
    };
  }

  renderHoverBox(el) {
    const box = this.getElementArtboardBox(el);
    this.hoverBox.style.left = `${box.left}px`;
    this.hoverBox.style.top = `${box.top}px`;
    this.hoverBox.style.width = `${box.width}px`;
    this.hoverBox.style.height = `${box.height}px`;
    const cls = typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/)[0]}`
      : '';
    this.hoverTag.textContent = `${el.tagName.toLowerCase()}${cls}`;
    this.hoverBox.classList.remove('hidden');
  }

  ensureTransformState(el) {
    if (!el.hasAttribute('data-vcs-tx')) {
      const initialAngle = parseComputedAngle(el);
      if (this.mode === 'html') {
        const rawInline = el.style.transform || '';
        el.setAttribute('data-vcs-base-tf', rawInline);
        el.setAttribute('data-vcs-init-rot', String(initialAngle));
      } else {
        const rawAttr = el.getAttribute('transform') || '';
        el.setAttribute('data-vcs-base-tf', rawAttr);
        el.setAttribute('data-vcs-init-rot', String(initialAngle));
      }
      el.setAttribute('data-vcs-tx', '0');
      el.setAttribute('data-vcs-ty', '0');
      el.setAttribute('data-vcs-rot', String(initialAngle));
      el.setAttribute('data-vcs-sx', '1');
      el.setAttribute('data-vcs-sy', '1');
    }
    return {
      tx: parseFloat(el.getAttribute('data-vcs-tx') || '0'),
      ty: parseFloat(el.getAttribute('data-vcs-ty') || '0'),
      rot: parseFloat(el.getAttribute('data-vcs-rot') || '0'),
      initRot: parseFloat(el.getAttribute('data-vcs-init-rot') || '0'),
      sx: parseFloat(el.getAttribute('data-vcs-sx') || '1'),
      sy: parseFloat(el.getAttribute('data-vcs-sy') || '1'),
      baseTf: el.getAttribute('data-vcs-base-tf') || '',
    };
  }

  applyTransformState(el, state) {
    el.setAttribute('data-vcs-tx', String(Math.round(state.tx * 10) / 10));
    el.setAttribute('data-vcs-ty', String(Math.round(state.ty * 10) / 10));
    el.setAttribute('data-vcs-rot', String(normalizeAngle(state.rot)));
    el.setAttribute('data-vcs-sx', String(Math.round(state.sx * 1000) / 1000));
    el.setAttribute('data-vcs-sy', String(Math.round(state.sy * 1000) / 1000));

    // 相对初始角度的增量旋转，保证点击“摆正 0°”时能抵消原本 CSS 里自带的倾斜角
    const deltaRot = normalizeAngle(state.rot - state.initRot);

    if (this.mode === 'html') {
      const parts = [];
      if (state.tx !== 0 || state.ty !== 0) parts.push(`translate(${state.tx}px, ${state.ty}px)`);
      if (deltaRot !== 0) parts.push(`rotate(${deltaRot}deg)`);
      if (state.sx !== 1 || state.sy !== 1) parts.push(`scale(${state.sx}, ${state.sy})`);
      if (state.baseTf) parts.push(state.baseTf);
      el.style.transformOrigin = 'center center';
      el.style.transform = parts.join(' ').trim();
    } else {
      // SVG 以元素自身 bbox 中心旋转与缩放
      let cx = 0;
      let cy = 0;
      try {
        const bb = el.getBBox();
        cx = bb.x + bb.width / 2;
        cy = bb.y + bb.height / 2;
      } catch {
        // 某些节点无 bbox
      }
      const parts = [];
      if (state.tx !== 0 || state.ty !== 0) parts.push(`translate(${state.tx} ${state.ty})`);
      if (deltaRot !== 0) parts.push(`rotate(${deltaRot} ${cx} ${cy})`);
      if (state.sx !== 1 || state.sy !== 1) {
        parts.push(`translate(${cx} ${cy}) scale(${state.sx} ${state.sy}) translate(${-cx} ${-cy})`);
      }
      if (state.baseTf) parts.push(state.baseTf);
      const tfStr = parts.join(' ').trim();
      if (tfStr) el.setAttribute('transform', tfStr);
      else el.removeAttribute('transform');
    }
  }

  selectElement(el) {
    this.selectedEl = el;
    this.hoverBox.classList.add('hidden');
    this.ensureTransformState(el);
    this.updateSelectBox();
    this.cb.onSelectionChange?.(this.getSelectedProps());
    this.cb.onBreadcrumbChange?.(this.getBreadcrumb(el));
    this.cb.onLayersChange?.(this.getLayersList());
  }

  clearSelection() {
    this.selectedEl = null;
    this.selectBox.classList.add('hidden');
    this.cb.onSelectionChange?.(null);
    this.cb.onBreadcrumbChange?.([]);
    this.cb.onLayersChange?.(this.getLayersList());
  }

  getBreadcrumb(el) {
    const chain = [];
    let cur = el;
    while (cur && cur !== this.rootContainer && cur !== this.shadowRoot) {
      const cls = typeof cur.className === 'string' && cur.className.trim()
        ? `.${cur.className.trim().split(/\s+/)[0]}`
        : '';
      chain.unshift({
        label: `${cur.tagName.toLowerCase()}${cur.id ? `#${cur.id}` : cls}`,
        el: cur,
      });
      cur = cur.parentElement;
    }
    return chain;
  }

  updateSelectBox() {
    if (!this.selectedEl) {
      this.selectBox.classList.add('hidden');
      return;
    }
    const box = this.getElementArtboardBox(this.selectedEl);
    this.selectBox.style.left = `${box.left}px`;
    this.selectBox.style.top = `${box.top}px`;
    this.selectBox.style.width = `${Math.max(box.width, 8)}px`;
    this.selectBox.style.height = `${Math.max(box.height, 8)}px`;
    this.selectBox.classList.remove('hidden');
  }

  startGizmoAction(action, e) {
    if (!this.selectedEl) return;
    const state = this.ensureTransformState(this.selectedEl);
    const box = this.getElementArtboardBox(this.selectedEl);
    const ab = this.getArtboardRect();
    const centerClientX = ab.left + (box.left + box.width / 2) * this.zoom;
    const centerClientY = ab.top + (box.top + box.height / 2) * this.zoom;
    const startPointerAngle = Math.atan2(e.clientY - centerClientY, e.clientX - centerClientX) * (180 / Math.PI);

    this.dragState = {
      action,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startState: { ...state },
      startBox: { ...box },
      centerClientX,
      centerClientY,
      startPointerAngle,
      moved: false,
    };
  }

  onGizmoMove(e) {
    const ds = this.dragState;
    const el = this.selectedEl;
    if (!ds || !el) return;

    const dx = (e.clientX - ds.startClientX) / this.zoom;
    const dy = (e.clientY - ds.startClientY) / this.zoom;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) ds.moved = true;

    const next = { ...ds.startState };

    if (ds.action === 'move') {
      next.tx = ds.startState.tx + dx;
      next.ty = ds.startState.ty + dy;

      // 磁性居中吸附：以画布水平中心与垂直中心为基准
      let snappedV = false;
      let snappedH = false;
      if (!e.altKey) {
        const origCenterX = ds.startBox.left + ds.startBox.width / 2;
        const origCenterY = ds.startBox.top + ds.startBox.height / 2;
        const curCenterX = origCenterX + dx;
        const curCenterY = origCenterY + dy;

        if (Math.abs(curCenterX - this.docWidth / 2) <= SNAP_PX) {
          next.tx = ds.startState.tx + (this.docWidth / 2 - origCenterX);
          this.guideV.style.left = `${this.docWidth / 2}px`;
          this.guideV.classList.remove('hidden');
          snappedV = true;
        } else {
          this.guideV.classList.add('hidden');
        }

        if (Math.abs(curCenterY - this.docHeight / 2) <= SNAP_PX) {
          next.ty = ds.startState.ty + (this.docHeight / 2 - origCenterY);
          this.guideH.style.top = `${this.docHeight / 2}px`;
          this.guideH.classList.remove('hidden');
          snappedH = true;
        } else {
          this.guideH.classList.add('hidden');
        }
      } else {
        this.hideGuides();
      }

      this.applyTransformState(el, next);
      this.updateSelectBox();
      const box = this.getElementArtboardBox(el);
      this.cb.onHud?.(
        `X: ${Math.round(box.left + box.width / 2)}  Y: ${Math.round(box.top + box.height / 2)}${snappedV || snappedH ? ' · 已居中吸附' : ''}`,
        e.clientX,
        e.clientY,
        snappedV || snappedH,
      );
    } else if (ds.action === 'rot') {
      const curPointerAngle = Math.atan2(e.clientY - ds.centerClientY, e.clientX - ds.centerClientX) * (180 / Math.PI);
      let angle = normalizeAngle(ds.startState.rot + (curPointerAngle - ds.startPointerAngle));
      let snapped = false;
      if (e.shiftKey) {
        angle = Math.round(angle / 15) * 15;
        snapped = true;
      } else {
        for (const k of [0, 90, -90, 180, -180, 45, -45]) {
          if (Math.abs(angle - k) <= 2.5) {
            angle = k === -180 ? 180 : k;
            snapped = true;
            break;
          }
        }
      }
      next.rot = angle;
      this.applyTransformState(el, next);
      this.updateSelectBox();
      this.cb.onHud?.(
        `角度: ${angle}°${angle === 0 ? ' · 已摆正' : ''}`,
        e.clientX,
        e.clientY,
        snapped && angle === 0,
      );
    } else {
      // 8 点缩放
      const baseW = Math.max(ds.startBox.width, 12);
      const baseH = Math.max(ds.startBox.height, 12);
      const signX = ds.action.includes('e') ? 1 : ds.action.includes('w') ? -1 : 0;
      const signY = ds.action.includes('s') ? 1 : ds.action.includes('n') ? -1 : 0;

      if (signX !== 0) {
        const ratioX = clamp((baseW + dx * signX) / baseW, 0.1, 8);
        next.sx = ds.startState.sx * ratioX;
      }
      if (signY !== 0) {
        const ratioY = clamp((baseH + dy * signY) / baseH, 0.1, 8);
        next.sy = ds.startState.sy * ratioY;
      }
      // 四角等比缩放（除非按住 Alt 自由拉伸）
      if (signX !== 0 && signY !== 0 && !e.altKey) {
        const avg = (next.sx / ds.startState.sx + next.sy / ds.startState.sy) / 2;
        next.sx = ds.startState.sx * avg;
        next.sy = ds.startState.sy * avg;
      }
      this.applyTransformState(el, next);
      this.updateSelectBox();
      const box = this.getElementArtboardBox(el);
      this.cb.onHud?.(`尺寸: ${Math.round(box.width)} × ${Math.round(box.height)}`, e.clientX, e.clientY, false);
    }

    this.cb.onSelectionChange?.(this.getSelectedProps());
  }

  finishGizmoAction() {
    const moved = this.dragState?.moved;
    this.dragState = null;
    this.hideGuides();
    this.cb.onHudHide?.();
    if (moved) {
      this.pushHistory();
      this.cb.onChange?.();
    }
    this.updateSelectBox();
    this.cb.onSelectionChange?.(this.getSelectedProps());
  }

  hideGuides() {
    this.guideV.classList.add('hidden');
    this.guideH.classList.add('hidden');
  }

  setZoom(nextZoom) {
    this.zoom = clamp(nextZoom, 0.15, 3);
    this.applyZoomTransform();
    return this.zoom;
  }

  applyZoomTransform() {
    this.frameEl.style.width = `${this.docWidth}px`;
    this.frameEl.style.height = `${this.docHeight}px`;
    this.frameEl.style.transform = `scale(${this.zoom})`;
    // 调整外层占位尺寸防止滚动裁切
    const wrap = this.frameEl.parentElement;
    if (wrap) {
      wrap.style.width = `${Math.round(this.docWidth * this.zoom)}px`;
      wrap.style.height = `${Math.round(this.docHeight * this.zoom)}px`;
    }
    this.updateSelectBox();
  }

  fitToViewport(vpWidth, vpHeight) {
    const pad = 48;
    const scaleX = (vpWidth - pad) / this.docWidth;
    const scaleY = (vpHeight - pad) / this.docHeight;
    return this.setZoom(Math.min(scaleX, scaleY, 1));
  }

  resizeCanvas(width, height) {
    this.docWidth = clamp(Number(width) || 800, 100, 4000);
    this.docHeight = clamp(Number(height) || 800, 100, 6000);
    if (this.rootContainer) {
      if (this.mode === 'html') {
        this.rootContainer.style.width = `${this.docWidth}px`;
        this.rootContainer.style.height = `${this.docHeight}px`;
      } else {
        this.rootContainer.setAttribute('width', String(this.docWidth));
        this.rootContainer.setAttribute('height', String(this.docHeight));
      }
    }
    this.applyZoomTransform();
    this.pushHistory();
    this.cb.onChange?.();
  }

  getSelectedProps() {
    const el = this.selectedEl;
    if (!el) return null;
    const st = this.ensureTransformState(el);
    const box = this.getElementArtboardBox(el);
    const cs = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const isText = (this.mode === 'svg' && (tag === 'text' || tag === 'tspan')) ||
      (this.mode === 'html' && el.children.length === 0 && tag !== 'img' && tag !== 'hr');

    return {
      id: el.id || tag,
      type: this.mode,
      name: `${tag}${el.id ? `#${el.id}` : ''}`,
      locked: false,
      isText,
      isBadge: false,
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
      w: Math.round(box.width),
      h: Math.round(box.height),
      angle: normalizeAngle(st.rot),
      opacity: Math.round((parseFloat(cs.opacity) || 1) * 100),
      text: isText ? el.textContent || '' : '',
      fontSize: Math.round(parseFloat(cs.fontSize) || 24),
      fontWeight: String(cs.fontWeight || '700'),
      fontFamily: cs.fontFamily || 'Microsoft YaHei, PingFang SC, sans-serif',
      textAlign: cs.textAlign || 'center',
      fill: rgbToHex(this.mode === 'svg' ? (el.getAttribute('fill') || cs.fill) : cs.color),
      bg: rgbToHex(cs.backgroundColor),
      stroke: rgbToHex(this.mode === 'svg' ? (el.getAttribute('stroke') || cs.stroke) : cs.borderColor),
      strokeWidth: Math.round(parseFloat(this.mode === 'svg' ? cs.strokeWidth : cs.borderWidth) || 0),
      radius: Math.round(parseFloat(cs.borderRadius) || 0),
      hasShadow: cs.boxShadow && cs.boxShadow !== 'none',
    };
  }

  updateSelected(patch, recordHistory = true) {
    const el = this.selectedEl;
    if (!el) return;
    const st = this.ensureTransformState(el);
    const box = this.getElementArtboardBox(el);

    if (patch.x !== undefined) {
      const curCx = box.left + box.width / 2;
      st.tx += Number(patch.x) - curCx;
    }
    if (patch.y !== undefined) {
      const curCy = box.top + box.height / 2;
      st.ty += Number(patch.y) - curCy;
    }
    if (patch.angle !== undefined) {
      st.rot = normalizeAngle(Number(patch.angle));
    }
    if (patch.w !== undefined && box.width > 0) {
      st.sx *= clamp(Number(patch.w) / box.width, 0.1, 8);
    }
    if (patch.h !== undefined && box.height > 0) {
      st.sy *= clamp(Number(patch.h) / box.height, 0.1, 8);
    }

    this.applyTransformState(el, st);

    if (patch.opacity !== undefined) el.style.opacity = String(clamp(Number(patch.opacity) / 100, 0, 1));
    if (patch.text !== undefined) el.textContent = patch.text;

    if (this.mode === 'html') {
      if (patch.fontSize !== undefined) el.style.fontSize = `${Number(patch.fontSize)}px`;
      if (patch.fontWeight !== undefined) el.style.fontWeight = String(patch.fontWeight);
      if (patch.fontFamily !== undefined) el.style.fontFamily = patch.fontFamily;
      if (patch.textAlign !== undefined) el.style.textAlign = patch.textAlign;
      if (patch.fill !== undefined) el.style.color = patch.fill;
      if (patch.bg !== undefined) el.style.backgroundColor = patch.bg;
      if (patch.radius !== undefined) el.style.borderRadius = `${Number(patch.radius)}px`;
      if (patch.stroke !== undefined || patch.strokeWidth !== undefined) {
        const w = patch.strokeWidth !== undefined ? Number(patch.strokeWidth) : (parseFloat(getComputedStyle(el).borderWidth) || 0);
        const c = patch.stroke || rgbToHex(getComputedStyle(el).borderColor);
        el.style.border = w > 0 ? `${w}px solid ${c}` : 'none';
      }
      if (patch.hasShadow !== undefined) {
        el.style.boxShadow = patch.hasShadow ? '0 10px 28px rgba(0,0,0,0.22)' : 'none';
      }
    } else {
      if (patch.fontSize !== undefined) el.setAttribute('font-size', String(Number(patch.fontSize)));
      if (patch.fontWeight !== undefined) el.setAttribute('font-weight', String(patch.fontWeight));
      if (patch.fontFamily !== undefined) el.setAttribute('font-family', patch.fontFamily);
      if (patch.fill !== undefined) el.setAttribute('fill', patch.fill);
      if (patch.stroke !== undefined) el.setAttribute('stroke', patch.stroke);
      if (patch.strokeWidth !== undefined) el.setAttribute('stroke-width', String(Number(patch.strokeWidth)));
    }

    this.updateSelectBox();
    if (recordHistory) {
      this.pushHistory();
      this.cb.onChange?.();
    }
    this.cb.onSelectionChange?.(this.getSelectedProps());
  }

  alignSelected(mode) {
    const el = this.selectedEl;
    if (!el) return;
    const st = this.ensureTransformState(el);
    const box = this.getElementArtboardBox(el);
    const curCx = box.left + box.width / 2;
    const curCy = box.top + box.height / 2;

    if (mode === 'center-h') st.tx += this.docWidth / 2 - curCx;
    if (mode === 'center-v') st.ty += this.docHeight / 2 - curCy;
    if (mode === 'left') st.tx += 24 - box.left;
    if (mode === 'right') st.tx += (this.docWidth - 24) - (box.left + box.width);
    if (mode === 'top') st.ty += 24 - box.top;
    if (mode === 'bottom') st.ty += (this.docHeight - 24) - (box.top + box.height);

    this.applyTransformState(el, st);
    this.updateSelectBox();
    this.pushHistory();
    this.cb.onChange?.();
    this.cb.onSelectionChange?.(this.getSelectedProps());
  }

  rotateSelected(deltaOrReset) {
    const el = this.selectedEl;
    if (!el) return;
    const st = this.ensureTransformState(el);
    st.rot = deltaOrReset === 'reset' ? 0 : normalizeAngle(st.rot + Number(deltaOrReset));
    this.applyTransformState(el, st);
    this.updateSelectBox();
    this.pushHistory();
    this.cb.onChange?.();
    this.cb.onSelectionChange?.(this.getSelectedProps());
  }

  nudgeSelected(dx, dy) {
    const el = this.selectedEl;
    if (!el) return;
    const st = this.ensureTransformState(el);
    st.tx += dx;
    st.ty += dy;
    this.applyTransformState(el, st);
    this.updateSelectBox();
    this.pushHistory();
    this.cb.onChange?.();
    this.cb.onSelectionChange?.(this.getSelectedProps());
  }

  layerAction(action, idx = null) {
    const el = idx !== null ? this.getEditableNodes()[idx] : this.selectedEl;
    if (!el || !el.parentElement) return;
    const parent = el.parentElement;

    if (action === 'del') {
      el.remove();
      this.clearSelection();
    } else if (action === 'dup') {
      const clone = el.cloneNode(true);
      if (clone.id) clone.id = `${clone.id}_copy`;
      parent.appendChild(clone);
      this.selectElement(clone);
      this.nudgeSelected(18, 18);
      return;
    } else if (action === 'up') {
      if (this.mode === 'html') {
        const z = parseInt(getComputedStyle(el).zIndex, 10) || 1;
        el.style.position = getComputedStyle(el).position === 'static' ? 'relative' : el.style.position;
        el.style.zIndex = String(z + 1);
      } else if (el.nextElementSibling) {
        parent.insertBefore(el.nextElementSibling, el);
      }
    } else if (action === 'down') {
      if (this.mode === 'html') {
        const z = parseInt(getComputedStyle(el).zIndex, 10) || 1;
        el.style.position = getComputedStyle(el).position === 'static' ? 'relative' : el.style.position;
        el.style.zIndex = String(Math.max(0, z - 1));
      } else if (el.previousElementSibling) {
        parent.insertBefore(el, el.previousElementSibling);
      }
    } else if (action === 'front') {
      if (this.mode === 'html') {
        el.style.position = getComputedStyle(el).position === 'static' ? 'relative' : el.style.position;
        el.style.zIndex = '999';
      } else {
        parent.appendChild(el);
      }
    } else if (action === 'back') {
      if (this.mode === 'html') {
        el.style.position = getComputedStyle(el).position === 'static' ? 'relative' : el.style.position;
        el.style.zIndex = '0';
      } else {
        parent.insertBefore(el, parent.firstElementChild);
      }
    } else if (action === 'toggle-vis') {
      el.style.visibility = el.style.visibility === 'hidden' ? '' : 'hidden';
    }

    this.pushHistory();
    this.cb.onChange?.();
    this.updateSelectBox();
    this.cb.onLayersChange?.(this.getLayersList());
  }

  getEditableNodes() {
    if (!this.rootContainer) return [];
    const selector = this.mode === 'html'
      ? 'h1,h2,h3,h4,p,img,svg,button,span,div,section,article'
      : 'g,text,image,rect,circle,ellipse,path,polygon';
    return Array.from(this.rootContainer.querySelectorAll(selector)).filter((el) => {
      if (el.tagName === 'STYLE' || el.hasAttribute('data-vcs-internal-style')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    }).slice(0, 80);
  }

  getLayersList() {
    return this.getEditableNodes().map((el, idx) => {
      const tag = el.tagName.toLowerCase();
      const snippet = el.children.length === 0 && el.textContent?.trim()
        ? el.textContent.trim().slice(0, 14)
        : (el.id ? `#${el.id}` : (typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : tag));
      return {
        id: String(idx),
        type: tag,
        name: snippet,
        visible: el.style.visibility !== 'hidden',
        locked: false,
        active: el === this.selectedEl,
      };
    });
  }

  selectById(id) {
    const node = this.getEditableNodes()[Number(id)];
    if (node) this.selectElement(node);
  }

  /**
   * 清理编辑器临时标记，恢复原始本地相对图片路径，生成干净可回写的 HTML / SVG 源码
   */
  serialize() {
    if (!this.rootContainer) return '';
    const clone = this.rootContainer.cloneNode(true);

    // 移除仅用于 Shadow DOM 渲染的内部样式标签
    for (const st of clone.querySelectorAll('[data-vcs-internal-style]')) {
      st.remove();
    }

    // 还原本地相对路径并清除临时属性
    const all = [clone, ...clone.querySelectorAll('*')];
    for (const el of all) {
      if (el.hasAttribute('data-vcs-orig-src')) {
        el.setAttribute('src', el.getAttribute('data-vcs-orig-src'));
      }
      if (el.hasAttribute('data-vcs-orig-href')) {
        el.setAttribute('href', el.getAttribute('data-vcs-orig-href'));
      }
      if (el.hasAttribute('contenteditable')) {
        el.removeAttribute('contenteditable');
      }
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('data-vcs-')) {
          el.removeAttribute(attr.name);
        }
      }
    }

    if (this.mode === 'svg') {
      return new XMLSerializer().serializeToString(clone);
    }

    const meta = this.origDocMeta || {
      doctype: '<!doctype html>',
      htmlAttrs: [['lang', 'zh-CN']],
      bodyAttrs: [],
      headNonStyleHtml: '<meta charset="UTF-8" />',
      rawStyles: [],
    };

    const attrStr = (list) => list.map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ');
    const htmlAttrText = attrStr(meta.htmlAttrs);
    const bodyAttrText = attrStr(meta.bodyAttrs);
    const stylesHtml = (meta.rawStyles || []).map((css) => `  <style>${css}</style>`).join('\n');

    return `${meta.doctype}
<html${htmlAttrText ? ' ' + htmlAttrText : ''}>
<head>
  ${meta.headNonStyleHtml}
${stylesHtml}
</head>
<body${bodyAttrText ? ' ' + bodyAttrText : ''}>
${clone.innerHTML}
</body>
</html>`;
  }

  pushHistory() {
    if (this.isRestoring) return;
    const snap = this.serialize();
    this.history = this.history.slice(0, this.historyIdx + 1);
    this.history.push(snap);
    if (this.history.length > 35) this.history.shift();
    this.historyIdx = this.history.length - 1;
    this.cb.onHistoryChange?.(this.historyIdx > 0, false);
  }

  undo() {
    if (this.historyIdx <= 0) return;
    this.historyIdx--;
    this.restoreMarkup(this.history[this.historyIdx]);
  }

  redo() {
    if (this.historyIdx >= this.history.length - 1) return;
    this.historyIdx++;
    this.restoreMarkup(this.history[this.historyIdx]);
  }

  restoreMarkup(markup) {
    this.isRestoring = true;
    const prevZoom = this.zoom;
    const savedHistory = this.history;
    const savedIdx = this.historyIdx;
    this.loadMarkup(this.mode, markup, this.assetMap);
    this.history = savedHistory;
    this.historyIdx = savedIdx;
    this.setZoom(prevZoom);
    this.isRestoring = false;
    this.cb.onHistoryChange?.(this.historyIdx > 0, this.historyIdx < this.history.length - 1);
    this.cb.onChange?.();
  }

  /**
   * 将当前 HTML/SVG 舞台无损栅格化为 1x/2x/3x PNG 或 JPG
   */
  async exportDataUrl(format = 'png', scale = 2) {
    if (!this.rootContainer) return null;
    const mult = Number(scale) || 2;
    const w = this.docWidth;
    const h = this.docHeight;

    let svgString = '';
    if (this.mode === 'svg') {
      const clone = this.rootContainer.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(w));
      clone.setAttribute('height', String(h));
      svgString = new XMLSerializer().serializeToString(clone);
    } else {
      const clone = this.rootContainer.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      const xhtml = new XMLSerializer().serializeToString(clone);
      svgString = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
        <foreignObject width="100%" height="100%">${xhtml}</foreignObject>
      </svg>`;
    }

    const svgBlobUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
    const img = await new Promise((resolveImg, rejectImg) => {
      const i = new Image();
      i.onload = () => resolveImg(i);
      i.onerror = (err) => rejectImg(err);
      i.src = svgBlobUrl;
    });

    const outCanvas = document.createElement('canvas');
    outCanvas.width = Math.round(w * mult);
    outCanvas.height = Math.round(h * mult);
    const ctx = outCanvas.getContext('2d');
    if (format === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outCanvas.width, outCanvas.height);
    }
    ctx.scale(mult, mult);
    ctx.drawImage(img, 0, 0, w, h);

    return outCanvas.toDataURL(format === 'jpeg' ? 'image/jpeg' : 'image/png', 0.94);
  }
}
