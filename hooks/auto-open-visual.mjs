#!/usr/bin/env node
/**
 * Stop Hook: 遵循“正常预览、按需从右上角 ⋮ 进入可视化画布编辑”的轻量无打扰策略。
 * 仅在当前轮次主动调用 create_ecommerce_design 创建了新的 .canvas.json 却尚未打开时提示一次；
 * 普通生图/PDF/文档一律不强行弹窗打扰操作者。
 */
import { existsSync, readFileSync } from 'node:fs';

let rawInput = '';
try {
  rawInput = readFileSync(0, 'utf-8');
} catch {
  process.stdout.write('{}');
  process.exit(0);
}

let payload = {};
try {
  payload = JSON.parse(rawInput || '{}');
} catch {
  process.stdout.write('{}');
  process.exit(0);
}

if (payload.continuationActive || payload.terminationReason !== 'NO_TOOL_CALL') {
  process.stdout.write('{}');
  process.exit(0);
}

const transcriptPath = payload.transcriptPath;
if (!transcriptPath || !existsSync(transcriptPath)) {
  process.stdout.write('{}');
  process.exit(0);
}

try {
  const lines = readFileSync(transcriptPath, 'utf-8').trim().split('\n').slice(-40);
  const steps = [];
  for (const line of lines) {
    try {
      steps.push(JSON.parse(line));
    } catch {
      // 跳过
    }
  }
  let lastUserIdx = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]?.type === 'USER_INPUT') {
      lastUserIdx = i;
      break;
    }
  }
  const turnSteps = lastUserIdx >= 0 ? steps.slice(lastUserIdx + 1) : steps.slice(-10);

  let createdCanvasPath = '';
  let alreadyOpened = false;
  for (const s of turnSteps) {
    if (!Array.isArray(s?.tool_calls)) continue;
    for (const tc of s.tool_calls) {
      const name = String(tc?.name || '');
      if (name.includes('open_visual_editor')) alreadyOpened = true;
      if (name.includes('create_ecommerce_design')) {
        try {
          const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
          if (args?.filePath) createdCanvasPath = String(args.filePath);
        } catch {
          // 忽略
        }
      }
    }
  }

  if (createdCanvasPath && !alreadyOpened && existsSync(createdCanvasPath)) {
    process.stdout.write(
      JSON.stringify({
        decision: 'continue',
        reason: `已创建分层画布 ${createdCanvasPath}，请调用 mcp_visual-canvas-studio_vcs_open_visual_editor({ filePath: "${createdCanvasPath.replace(/\\/g, '\\\\')}" }) 在侧栏打开供操作者微调。`,
      }),
    );
    process.exit(0);
  }
} catch {
  // 忽略
}

process.stdout.write('{}');
