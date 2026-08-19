import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConversationCapabilityArchive } from './root-capability-packager.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FORENSICS_ROOT = path.resolve(MODULE_DIR, '..');
const BUILDER_TEMPLATE_ROOT = path.join(SESSION_FORENSICS_ROOT, 'conversation-capability-builder');
const ROOT_CAPABILITY_TEMPLATE_ROOT = path.join(SESSION_FORENSICS_ROOT, 'templates', 'root-capability');
const CORE_LIBRARIES = [
  'root-capability-packager.mjs',
  'session-forensics.mjs',
  'session-source-index.mjs',
  'session-semantic-index.mjs',
  'conversation-ai-distiller.mjs',
  'semantic-distillation-v2.mjs',
  'conversation-evidence-sources.mjs',
  'project-discovery.mjs',
  'project-evidence.mjs',
  'project-understanding.mjs',
  'project-knowledge-v4.mjs',
  'distillation-recommendation.mjs',
  'local-path-picker.mjs',
  'scope-policy.mjs',
  'package-work-capability.mjs',
];

function safeSegment(value, fallback) {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || fallback;
}

async function copyTree(source, target) {
  await fsp.mkdir(target, { recursive: true });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}

async function writeText(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
}

function launcherScripts() {
  return {
    windows: '@echo off\r\nsetlocal\r\nnode "%~dp0launcher.mjs"\r\n',
    shell: '#!/usr/bin/env sh\nset -eu\nnode "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/launcher.mjs"\n',
    installWindows: `@echo off\r\nsetlocal\r\nset "SOURCE=%~dp0"\r\nset "TARGET=%LOCALAPPDATA%\\ConversationCapabilityBuilder"\r\nif "%LOCALAPPDATA%"=="" set "TARGET=%USERPROFILE%\\AppData\\Local\\ConversationCapabilityBuilder"\r\necho 正在安装到：%TARGET%\r\nrobocopy "%SOURCE%" "%TARGET%" /E /NFL /NDL /NJH /NJS /XD state >nul\r\nif errorlevel 8 (\r\n  echo 安装失败。请确认目标目录可写，然后重试。\r\n  exit /b 1\r\n)\r\necho 安装完成，正在启动。\r\ncall "%TARGET%\\launch.cmd"\r\n`,
  };
}

export async function buildConversationCapabilityBuilder({
  outputRoot = path.join(SESSION_FORENSICS_ROOT, 'output', 'conversation-capability-builder'),
  name = 'conversation-capability-builder',
} = {}) {
  if (!fs.existsSync(BUILDER_TEMPLATE_ROOT)) throw new Error('对话转能力包应用模板不存在。');
  const output = path.resolve(outputRoot);
  const id = `${safeSegment(name, 'conversation-capability-builder')}-${Date.now()}`;
  const root = path.join(output, id);
  const relative = path.relative(output, root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('独立应用输出路径不在指定目录内。');

  await copyTree(BUILDER_TEMPLATE_ROOT, root);
  await fsp.mkdir(path.join(root, 'lib'), { recursive: true });
  for (const library of CORE_LIBRARIES) await fsp.copyFile(path.join(MODULE_DIR, library), path.join(root, 'lib', library));
  // The session reader now imports the versioned IR bridge; keep generated
  // standalone builders self-contained instead of relying on the source tree.
  await copyTree(path.join(MODULE_DIR, 'ir'), path.join(root, 'lib', 'ir'));
  await copyTree(path.join(MODULE_DIR, 'compilers'), path.join(root, 'lib', 'compilers'));
  await copyTree(path.join(MODULE_DIR, 'evaluation'), path.join(root, 'lib', 'evaluation'));
  await copyTree(path.join(MODULE_DIR, 'registry'), path.join(root, 'lib', 'registry'));
  await copyTree(path.join(MODULE_DIR, 'evidence'), path.join(root, 'lib', 'evidence'));
  await copyTree(path.join(MODULE_DIR, 'quality'), path.join(root, 'lib', 'quality'));
  await copyTree(path.join(MODULE_DIR, 'source-adapters'), path.join(root, 'lib', 'source-adapters'));
  await copyTree(ROOT_CAPABILITY_TEMPLATE_ROOT, path.join(root, 'templates', 'root-capability'));

  const scripts = launcherScripts();
  await writeText(path.join(root, 'launch.cmd'), scripts.windows);
  await writeText(path.join(root, 'launch.sh'), scripts.shell);
  await writeText(path.join(root, 'install-and-start.cmd'), scripts.installWindows);
  await writeText(path.join(root, 'package.json'), JSON.stringify({
    name: 'conversation-capability-builder',
    version: '1.0.0',
    private: true,
    type: 'module',
    description: '把完整或中途的 Codex 对话转换为会话专属 Skill、MCP 与独立 Agent 的本地安装应用。',
    scripts: { start: 'node launcher.mjs', server: 'node server.mjs' },
    engines: { node: '>=18' },
  }, null, 2) + '\n');
  const manifestPath = path.join(root, 'builder-manifest.json');
  await writeText(manifestPath, JSON.stringify({
    schemaVersion: '1.0.0',
    name: '对话转能力包',
    generatedAt: new Date().toISOString(),
    installation: { windows: 'install-and-start.cmd', direct: 'launch.cmd', macLinux: 'launch.sh' },
    capabilities: ['启动即自动搜索和加载本机 Codex 会话标题列表', '多选本机会话后直接蒸馏，也兼容导入 JSON/JSONL', '自动发现并主动读取关联项目', '合并会话、Git、文件版本与生成产物证据', '按 P0-P3 输出优先级、证据和建议交付物', '模型蒸馏并预览会话专属 UI', '导出 Skill、MCP、独立 Agent 与 ZIP'],
    includedLibraries: CORE_LIBRARIES,
    includedIR: ['lib/ir/trace-ir.mjs', 'lib/ir/capability-ir.mjs', 'lib/ir/work-capability-ir.mjs', 'lib/ir/legacy-bridge.mjs'],
    includedCompilerDependencies: [
      'lib/compilers',
      'lib/evaluation',
      'lib/registry',
      'lib/evidence',
      'lib/quality',
      'lib/source-adapters',
    ],
  }, null, 2) + '\n');
  const archive = await createConversationCapabilityArchive(root, `${root}.zip`);
  return {
    id,
    root,
    archive: archive.path,
    manifest: manifestPath,
    launch: { windows: path.join(root, 'launch.cmd'), installWindows: path.join(root, 'install-and-start.cmd'), shell: path.join(root, 'launch.sh') },
  };
}
