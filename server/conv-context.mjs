/**
 * 会话级文件上下文解析器
 * 从 Antigravity MCP 请求的 extra._meta 提取当前会话 ID 与 brain/artifacts 目录，
 * 优先聚合「当前对话框」内刚生成或引用的图片、Logo、PDF、HTML、SVG、分层画布文件，
 * 彻底隔离不同对话框之间的状态，避免在 A 对话框打开侧栏却加载 B 对话框旧文件。
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, normalize, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const VISUAL_EXTS = new Set([
  '.pdf',
  '.html',
  '.htm',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.ico',
  '.avif',
]);

const DEFAULT_BRAIN_ROOT = join(homedir(), '.gemini', 'antigravity', 'brain');
const PATH_REGEX = /(?:file:\/\/\/)?([A-Za-z]:[\\/][^"'`\r\n<>|*?\])]+?\.(?:canvas\.json|vcs\.json|pdf|html|htm|svg|png|jpe?g|webp|gif|bmp|ico|avif))/gi;

export function isVisualPath(p) {
  if (!p) return false;
  const l = p.toLowerCase();
  return l.endsWith('.canvas.json') || l.endsWith('.vcs.json') || VISUAL_EXTS.has(extname(l));
}

function uriToLocalPath(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    try {
      s = fileURLToPath(s);
    } catch {
      s = decodeURIComponent(s.replace(/^file:\/\/\/?/i, ''));
    }
  }
  return normalize(s);
}

export function extractConvContext(extra) {
  const meta = extra?._meta || {};
  const convId =
    meta['antigravity.google/conversation_id'] ||
    meta['antigravity.google/root_conversation_id'] ||
    '';
  let artifactsDir = meta['antigravity.google/artifacts_dir'] || '';
  if (!artifactsDir && convId) {
    const candidate = join(DEFAULT_BRAIN_ROOT, convId);
    if (existsSync(candidate)) artifactsDir = candidate;
  }
  const workspaceDirs = [];
  const rawWs = meta['antigravity.google/workspace_uris'] || meta['antigravity.google/workspace_dir'] || [];
  const wsList = Array.isArray(rawWs) ? rawWs : [rawWs];
  for (const item of wsList) {
    const p = uriToLocalPath(item);
    if (p && existsSync(p)) workspaceDirs.push(p);
  }
  return {
    conversationId: String(convId || ''),
    artifactsDir: artifactsDir ? normalize(artifactsDir) : '',
    workspaceDirs,
  };
}

/**
 * 扫描最近活跃的多个 Antigravity 会话，聚合所有出现过的工作区根目录与聚合父目录，
 * 解决跨工作区打开大文件或相对路径图片时定位不到磁盘原文件的问题。
 */
export function collectRecentWorkspaces(maxConvs = 20) {
  const workspaces = [];
  const artifactDirs = [];
  const parentWorkspaces = [];
  const seenWs = new Set();
  const seenParents = new Set();
  const homeLower = normalize(homedir()).toLowerCase();

  const addWs = (raw) => {
    const p = uriToLocalPath(raw);
    if (!p || !existsSync(p)) return;
    const low = p.toLowerCase();
    if (!seenWs.has(low)) {
      seenWs.add(low);
      workspaces.push(p);
    }
    const parent = dirname(p);
    if (parent && parent !== p) {
      const pLow = parent.toLowerCase();
      const rootLow = parse(parent).root.toLowerCase();
      // 仅纳入类似 D:\antigravity work 这类项目聚合目录，避开盘符根目录与用户主目录
      if (pLow !== rootLow && pLow !== homeLower && !pLow.endsWith(':\\users') && !seenParents.has(pLow)) {
        seenParents.add(pLow);
        parentWorkspaces.push(parent);
      }
    }
  };

  if (!existsSync(DEFAULT_BRAIN_ROOT)) {
    return { workspaces, parentWorkspaces, artifactDirs };
  }

  const convs = [];
  try {
    for (const ent of readdirSync(DEFAULT_BRAIN_ROOT, { withFileTypes: true })) {
      if (!ent.isDirectory() || !/^[0-9a-f-]{16,}$/i.test(ent.name)) continue;
      const dir = join(DEFAULT_BRAIN_ROOT, ent.name);
      const tx = join(dir, '.system_generated', 'logs', 'transcript.jsonl');
      let mtime = 0;
      try {
        mtime = existsSync(tx) ? statSync(tx).mtimeMs : statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      convs.push({ dir, tx, mtime });
    }
  } catch {
    return { workspaces, parentWorkspaces, artifactDirs };
  }

  convs.sort((a, b) => b.mtime - a.mtime);
  for (const c of convs.slice(0, maxConvs)) {
    artifactDirs.push(c.dir);
    if (!existsSync(c.tx)) continue;
    try {
      const fd = openSync(c.tx, 'r');
      let head = '';
      try {
        const buf = Buffer.alloc(16384);
        const bytesRead = readSync(fd, buf, 0, buf.length, 0);
        head = buf.slice(0, bytesRead).toString('utf-8');
      } finally {
        closeSync(fd);
      }
      const blockMatch = /Active Workspaces:\s*(?:\\n|[\r\n])+([\s\S]{1,1200}?)(?:Command Working Directory:|App Data Directory:|\\n\\n|\r?\n\r?\n)/i.exec(head);
      if (blockMatch) {
        const cleanBlock = blockMatch[1].replace(/\\r\\n|\\n/g, '\n').replace(/\\\\/g, '\\');
        const lineRe = /^\s*-\s*([A-Za-z]:[^\r\n"]+|\/[^\r\n"]+)/gm;
        let m;
        while ((m = lineRe.exec(cleanBlock)) !== null) {
          addWs(m[1].trim());
        }
      }
    } catch {
      // 忽略单个日志读取失败
    }
  }

  return { workspaces, parentWorkspaces, artifactDirs };
}

/**
 * 当全局边栏打开（无 conversation_id）时，兜底查找最近刚有活动的会话目录
 */
export function findMostRecentConversation() {
  if (!existsSync(DEFAULT_BRAIN_ROOT)) return { conversationId: '', artifactsDir: '' };
  let best = null;
  try {
    for (const ent of readdirSync(DEFAULT_BRAIN_ROOT, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (!/^[0-9a-f-]{16,}$/i.test(ent.name)) continue;
      const dir = join(DEFAULT_BRAIN_ROOT, ent.name);
      const tx = join(dir, '.system_generated', 'logs', 'transcript.jsonl');
      let mtime = 0;
      try {
        mtime = existsSync(tx) ? statSync(tx).mtimeMs : statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtime > best.mtime) {
        best = { conversationId: ent.name, artifactsDir: dir, mtime };
      }
    }
  } catch {
    // 忽略目录权限问题
  }
  return best ? { conversationId: best.conversationId, artifactsDir: best.artifactsDir } : { conversationId: '', artifactsDir: '' };
}

function readTailText(filePath, maxBytes = 1500 * 1024) {
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size === 0) return '';
    if (st.size <= maxBytes) {
      return readFileSync(filePath, 'utf-8');
    }
    const fd = openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
      return buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function cleanMatchedPath(raw) {
  let p = String(raw || '').trim().replace(/\\\\/g, '\\').replace(/\\n.*$/, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    // 保持原文
  }
  return normalize(p);
}

function isIgnoredInternalPath(lower) {
  return (
    lower.includes('\\.system_generated\\') ||
    lower.includes('\\.resolved\\') ||
    lower.includes('\\.user_uploaded\\') ||
    lower.includes('\\browser_evidence\\') ||
    lower.includes('\\browser_sandbox\\') ||
    lower.includes('\\tempmediastorage\\') ||
    lower.includes('\\node_modules\\') ||
    lower.includes('\\visual-canvas-studio\\dist\\') ||
    lower.includes('\\visual-canvas-studio\\assets\\') ||
    lower.includes('\\antigravity\\builtin\\') ||
    lower.includes('\\antigravity\\mcp\\') ||
    lower.includes('\\scratch\\') ||
    lower.endsWith('.vcs.bak')
  );
}

function extractPathsFromText(text) {
  const out = [];
  if (!text || typeof text !== 'string') return out;
  PATH_REGEX.lastIndex = 0;
  let m;
  while ((m = PATH_REGEX.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * 扫描当前会话的所有视觉产物与提及文件（按本会话最新相关性排序）
 * 同时推断本会话的工作区根目录
 */
export function scanConversationContext(artifactsDir, detectFileMode) {
  const found = new Map(); // lowerPath -> entry
  let detectedWorkspace = '';

  const upsert = (rawPath, source, priorityRank, orderTs = 0) => {
    try {
      const norm = cleanMatchedPath(rawPath);
      if (!isVisualPath(norm)) return;
      const lower = norm.toLowerCase();
      if (isIgnoredInternalPath(lower)) return;
      if (!existsSync(norm)) return;
      const st = statSync(norm);
      if (!st.isFile() || st.size === 0) return;

      const ts = orderTs || st.mtimeMs;
      const score = priorityRank * 1e14 + ts;
      const prev = found.get(lower);
      if (!prev || score > prev.score) {
        found.set(lower, {
          name: basename(norm),
          path: norm,
          mode: detectFileMode(norm),
          size: st.size,
          mtimeMs: st.mtimeMs,
          source,
          score,
        });
      }
    } catch {
      // 忽略非法路径
    }
  };

  if (!artifactsDir || !existsSync(artifactsDir)) {
    return { files: [], workspaceDir: '' };
  }

  // 1. 优先扫描本会话 artifactsDir 中最新的 Markdown 制品里展示的成品图/视觉文件（如 logo_options.md）
  try {
    const mdFiles = readdirSync(artifactsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => {
        const p = join(artifactsDir, e.name);
        return { p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);

    for (const mf of mdFiles) {
      const mdText = readFileSync(mf.p, 'utf-8');
      const hits = extractPathsFromText(mdText);
      // 越靠后嵌入或越新的制品图排越前
      hits.forEach((p, idx) => {
        upsert(p, '本会话成品', 6, mf.mtime + idx);
      });
    }
  } catch {
    // 忽略读取异常
  }

  // 2. 扫描本会话 artifactsDir 根目录生成的视觉文件（如生成的 Logo、海报、渲染图）
  try {
    for (const ent of readdirSync(artifactsDir, { withFileTypes: true })) {
      if (ent.isFile()) {
        upsert(join(artifactsDir, ent.name), '本会话产物', 4);
      }
    }
  } catch {
    // 忽略目录异常
  }

  // 3. 按 JSON 行解析本会话 transcript.jsonl 最近 160 条步骤（忽略 SYSTEM 规则行，精准提取交付产物与用户提到的文件）
  const transcriptPath = join(artifactsDir, '.system_generated', 'logs', 'transcript.jsonl');
  if (existsSync(transcriptPath)) {
    const tail = readTailText(transcriptPath);
    const lines = tail.split('\n').filter((l) => l.trim()).slice(-160);
    const now = Date.now();

    lines.forEach((rawLine, idx) => {
      let step = null;
      try {
        step = JSON.parse(rawLine);
      } catch {
        return;
      }
      if (!step || step.source === 'SYSTEM') return;

      const isLatestTurn = idx >= Math.max(0, lines.length - 12);
      const stepTime = now - (lines.length - idx) * 1000;

      // 从模型回复、用户输入和工具调用参数中提取真实视觉文件路径
      const chunks = [];
      if (typeof step.content === 'string') chunks.push(step.content);
      if (Array.isArray(step.tool_calls)) {
        for (const tc of step.tool_calls) {
          if (tc?.arguments) chunks.push(typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments));
        }
      }

      const rank =
        isLatestTurn && (step.type === 'PLANNER_RESPONSE' || step.type === 'USER_INPUT')
          ? 7
          : isLatestTurn
            ? 5
            : 2;

      for (const chunk of chunks) {
        for (const p of extractPathsFromText(chunk)) {
          upsert(p, '本会话文件', rank, stepTime);
        }
      }
    });

    // 从 transcript 头部提取本会话绑定的工作区根目录
    try {
      const head = readFileSync(transcriptPath, 'utf-8').slice(0, 16000);
      const wsMatch = /Active Workspaces:\s*[\r\n]+-\s*([A-Za-z]:[^\r\n"]+)/i.exec(head);
      if (wsMatch && existsSync(wsMatch[1].trim())) {
        detectedWorkspace = normalize(wsMatch[1].trim());
      }
    } catch {
      // 忽略
    }
  }

  const files = Array.from(found.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map(({ score: _s, ...rest }) => rest);

  // 若未从 transcript 头部解析到工作区，优先取本会话非 brain 目录文件的所在目录
  if (!detectedWorkspace) {
    const nonBrain = files.find((f) => !f.path.toLowerCase().includes('\\.gemini\\antigravity\\brain\\'));
    if (nonBrain) {
      detectedWorkspace = dirname(nonBrain.path);
    } else if (files.length) {
      detectedWorkspace = artifactsDir;
    }
  }

  return { files, workspaceDir: detectedWorkspace };
}
