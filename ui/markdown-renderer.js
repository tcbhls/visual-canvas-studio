/**
 * 轻量零依赖 GFM Markdown 渲染器（复刻 Antigravity 原生文档预览质感）
 * 支持标题、段落、加粗/斜体/删除线/行内代码、表格、任务列表、代码块、
 * GitHub [!TIP]/[!NOTE]/[!IMPORTANT]/[!WARNING]/[!CAUTION] 提示框、
 * carousel 轮播块，以及本地内嵌图片的 dataUrl 替换与悬停快捷微调入口。
 */

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeSrc(raw = '') {
  return String(raw || '')
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/\s+["'][^"']*["']\s*$/, '');
}

const ALERT_META = {
  TIP: { label: 'TIP', cls: 'md-alert-tip', icon: '💡' },
  NOTE: { label: 'NOTE', cls: 'md-alert-note', icon: 'ℹ️' },
  IMPORTANT: { label: 'IMPORTANT', cls: 'md-alert-important', icon: '⚡' },
  WARNING: { label: 'WARNING', cls: 'md-alert-warning', icon: '⚠️' },
  CAUTION: { label: 'CAUTION', cls: 'md-alert-caution', icon: '🛑' },
};

export function renderMarkdownToHtml(markdown = '', assetMap = {}, images = []) {
  const imageIndexBySrc = new Map();
  images.forEach((img, idx) => {
    if (img?.rawSrc) imageIndexBySrc.set(img.rawSrc, idx);
    if (img?.diskPath) imageIndexBySrc.set(img.diskPath, idx);
  });

  const renderImgTag = (alt, rawSrc) => {
    const clean = normalizeSrc(rawSrc);
    const resolved = assetMap[clean] || assetMap[rawSrc] || (clean.startsWith('data:') || /^https?:\/\//i.test(clean) ? clean : '');
    const imgIdx = imageIndexBySrc.has(clean) ? imageIndexBySrc.get(clean) : -1;
    const safeAlt = escapeHtml(alt || '');
    if (!resolved) {
      return `<div class="md-img-missing">图片暂未找到：<code>${escapeHtml(clean)}</code></div>`;
    }
    const editBtn = imgIdx >= 0
      ? `<button class="md-img-edit-pill" data-md-edit-img="${imgIdx}" title="在可视化画布中微调此图">可视化编辑</button>`
      : '';
    return `<figure class="md-img-wrap" data-md-img-idx="${imgIdx}">
      <img src="${resolved}" alt="${safeAlt}" loading="lazy" />
      ${editBtn}
    </figure>`;
  };

  const renderInline = (text) => {
    // 先提取行内代码，避免内部符号被误解析
    const codeSlots = [];
    let s = String(text || '').replace(/`([^`]+)`/g, (_, code) => {
      const idx = codeSlots.length;
      codeSlots.push(`<code>${escapeHtml(code)}</code>`);
      return `\u0000CODE${idx}\u0000`;
    });

    // 提取 Markdown 图片 ![alt](src)
    const imgSlots = [];
    s = s.replace(/!\[([^\]]*)\]\(([^)\r\n]+)\)/g, (_, alt, src) => {
      const idx = imgSlots.length;
      imgSlots.push(renderImgTag(alt, src));
      return `\u0000IMG${idx}\u0000`;
    });

    // 提取原生 HTML <img> 标签
    s = s.replace(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi, (full, s1, s2) => {
      const altM = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(full);
      const idx = imgSlots.length;
      imgSlots.push(renderImgTag(altM ? (altM[1] || altM[2] || '') : '', s1 || s2));
      return `\u0000IMG${idx}\u0000`;
    });

    // 提取链接 [label](href)
    const linkSlots = [];
    s = s.replace(/\[([^\]]+)\]\(([^)\r\n]+)\)/g, (_, label, href) => {
      const cleanHref = normalizeSrc(href);
      const imgIdx = imageIndexBySrc.has(cleanHref) ? imageIndexBySrc.get(cleanHref) : -1;
      const idx = linkSlots.length;
      if (imgIdx >= 0) {
        linkSlots.push(
          `<a href="javascript:void(0)" class="md-link md-img-link" data-md-edit-img="${imgIdx}" title="点击在可视化画布中打开微调">${escapeHtml(label)}</a>`,
        );
      } else {
        linkSlots.push(
          `<a href="${escapeHtml(cleanHref)}" class="md-link" data-md-href="${escapeHtml(cleanHref)}">${escapeHtml(label)}</a>`,
        );
      }
      return `\u0000LINK${idx}\u0000`;
    });

    s = escapeHtml(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

    s = s.replace(/\u0000LINK(\d+)\u0000/g, (_, i) => linkSlots[Number(i)] || '');
    s = s.replace(/\u0000IMG(\d+)\u0000/g, (_, i) => imgSlots[Number(i)] || '');
    s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeSlots[Number(i)] || '');
    return s;
  };

  const renderBlocks = (srcText) => {
    const lines = String(srcText || '').replace(/\r\n/g, '\n').split('\n');
    const html = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      // 1. 围栏代码块（含 4 反引号 carousel 轮播块）
      const fenceMatch = /^(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(trimmed);
      if (fenceMatch) {
        const fence = fenceMatch[1];
        const lang = (fenceMatch[2] || '').toLowerCase();
        const closeRe = new RegExp(`^${fence[0]}{${fence.length},}\\s*$`);
        i++;
        const buf = [];
        while (i < lines.length && !closeRe.test(lines[i].trim())) {
          buf.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++;
        const body = buf.join('\n');

        if (lang === 'carousel') {
          const slides = body.split(/<!--\s*slide\s*-->/i).map((part) => part.trim()).filter(Boolean);
          if (slides.length) {
            const slideHtml = slides
              .map((part, idx) => `<div class="md-carousel-slide${idx === 0 ? ' active' : ''}" data-slide="${idx}">${renderBlocks(part)}</div>`)
              .join('');
            html.push(`<div class="md-carousel" data-cur="0" data-total="${slides.length}">
              <div class="md-carousel-track">${slideHtml}</div>
              ${slides.length > 1 ? `<div class="md-carousel-nav">
                <button class="md-car-btn" data-car-dir="-1">◀ 上一张</button>
                <span class="md-car-counter">1 / ${slides.length}</span>
                <button class="md-car-btn" data-car-dir="1">下一张 ▶</button>
              </div>` : ''}
            </div>`);
            continue;
          }
        }

        html.push(`<pre class="md-code"><code class="lang-${escapeHtml(lang)}">${escapeHtml(body)}</code></pre>`);
        continue;
      }

      // 2. 分割线
      if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        html.push('<hr class="md-hr" />');
        i++;
        continue;
      }

      // 3. 标题
      const hMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
      if (hMatch) {
        const lvl = hMatch[1].length;
        html.push(`<h${lvl} class="md-h md-h${lvl}">${renderInline(hMatch[2])}</h${lvl}>`);
        i++;
        continue;
      }

      // 4. 引用块 / GitHub Alert（> [!TIP] 等）
      if (/^>\s?/.test(trimmed)) {
        const qLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          qLines.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        const alertM = /^\[!(TIP|NOTE|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(qLines[0] || '');
        if (alertM) {
          const meta = ALERT_META[alertM[1].toUpperCase()] || ALERT_META.NOTE;
          const bodyHtml = renderBlocks(qLines.slice(1).join('\n'));
          html.push(`<div class="md-alert ${meta.cls}">
            <div class="md-alert-title">${meta.label}</div>
            <div class="md-alert-body">${bodyHtml}</div>
          </div>`);
        } else {
          html.push(`<blockquote class="md-quote">${renderBlocks(qLines.join('\n'))}</blockquote>`);
        }
        continue;
      }

      // 5. GFM 表格
      if (
        trimmed.includes('|') &&
        i + 1 < lines.length &&
        /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])
      ) {
        const splitRow = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        const headers = splitRow(lines[i]);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        const ths = headers.map((h) => `<th>${renderInline(h)}</th>`).join('');
        const trs = rows
          .map((row) => `<tr>${headers.map((_, cIdx) => `<td>${renderInline(row[cIdx] || '')}</td>`).join('')}</tr>`)
          .join('');
        html.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`);
        continue;
      }

      // 6. 无序/任务列表
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          const rawItem = lines[i].replace(/^\s*[-*+]\s+/, '');
          const taskM = /^\[([ xX])\]\s+(.*)$/.exec(rawItem);
          if (taskM) {
            const checked = taskM[1].toLowerCase() === 'x';
            items.push(`<li class="md-task-item"><input type="checkbox" disabled ${checked ? 'checked' : ''} /> <span>${renderInline(taskM[2])}</span></li>`);
          } else {
            items.push(`<li>${renderInline(rawItem)}</li>`);
          }
          i++;
        }
        html.push(`<ul class="md-list">${items.join('')}</ul>`);
        continue;
      }

      // 7. 有序列表
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          const rawItem = lines[i].replace(/^\s*\d+\.\s+/, '');
          items.push(`<li>${renderInline(rawItem)}</li>`);
          i++;
        }
        html.push(`<ol class="md-list md-olist">${items.join('')}</ol>`);
        continue;
      }

      // 8. 独立图片行
      const soloImg = /^!\[([^\]]*)\]\(([^)\r\n]+)\)$/.exec(trimmed);
      if (soloImg) {
        html.push(renderImgTag(soloImg[1], soloImg[2]));
        i++;
        continue;
      }

      // 9. 普通段落（合并连续文本行）
      const pLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,6}\s|>\s?|```|~~~|(?:-{3,}|\*{3,}|_{3,})$|\s*[-*+]\s+|\s*\d+\.\s+)/.test(lines[i])
      ) {
        pLines.push(lines[i].trim());
        i++;
      }
      html.push(`<p class="md-p">${pLines.map((l) => renderInline(l)).join('<br/>')}</p>`);
    }

    return html.join('\n');
  };

  return renderBlocks(markdown);
}
