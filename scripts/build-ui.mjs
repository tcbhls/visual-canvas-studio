/**
 * 将 ui/index.html + ui/app.js + ui/styles.css 打包成单个自包含 HTML 文件 dist/app.html
 * 满足 Antigravity MCP App 的 CSP（default-src 'none'，允许内联 script/style）与 <10 MiB 要求
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const uiDir = resolve(rootDir, 'ui');
const distDir = resolve(rootDir, 'dist');

mkdirSync(distDir, { recursive: true });

// 用 esbuild 打包前端逻辑（含 @modelcontextprotocol/ext-apps 与 fabric.js）为单份 IIFE 代码
const result = await build({
  entryPoints: [resolve(uiDir, 'app.js')],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  minify: true,
  write: false,
  platform: 'browser',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

const jsCode = result.outputFiles[0].text;
const cssCode = readFileSync(resolve(uiDir, 'styles.css'), 'utf-8');
const htmlTemplate = readFileSync(resolve(uiDir, 'index.html'), 'utf-8');

// 防止内联脚本中出现 </script> 提前闭合标签
const safeJs = jsCode.replace(/<\/script>/gi, '<\\/script>');
const safeCss = cssCode.replace(/<\/style>/gi, '<\\/style>');

const finalHtml = htmlTemplate
  .replace('/*__INLINE_CSS__*/', () => safeCss)
  .replace('/*__INLINE_JS__*/', () => safeJs);

const outPath = resolve(distDir, 'app.html');
writeFileSync(outPath, finalHtml, 'utf-8');

const sizeKb = (Buffer.byteLength(finalHtml, 'utf-8') / 1024).toFixed(1);
console.log(`[build-ui] 已生成单文件 MCP App: ${outPath} (${sizeKb} KB)`);
