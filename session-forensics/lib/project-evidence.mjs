import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redactText } from './session-forensics.mjs';

const execFileAsync = promisify(execFile);
const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__',
  '.cache', '.turbo', '.parcel-cache', '.pytest_cache', '.gradle',
]);
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.css', '.scss', '.less',
  '.html', '.htm', '.json', '.jsonl', '.md', '.mdx', '.txt', '.yaml', '.yml', '.toml', '.ini',
  '.env', '.xml', '.csv', '.tsv', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.cs',
  '.cpp', '.c', '.h', '.hpp', '.sh', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.proto',
]);
const MANIFEST_NAMES = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'cargo.toml', 'pom.xml',
  'composer.json', 'gemfile', 'global.json', 'dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
]);
const INSTRUCTION_NAMES = new Set(['agents.md', 'readme.md', 'readme.txt', 'contributing.md', 'claude.md', 'copilot-instructions.md']);

function text(value, maximum = 24000) {
  const result = String(value ?? '').replace(/\u0000/g, '').trim();
  return result.length <= maximum ? result : `${result.slice(0, maximum)}\n……内容已截断。`;
}

function relative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function isInside(root, candidate) {
  const value = path.relative(root, candidate);
  return value === '' || (!value.startsWith('..') && !path.isAbsolute(value));
}

function hash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function redact(value, enabled, maximum) {
  return enabled ? redactText(value, { redact: true, maxLength: maximum }) : text(value, maximum);
}

function fileKind(relativePath, content = '') {
  const lower = relativePath.toLowerCase();
  const base = path.basename(lower);
  if (MANIFEST_NAMES.has(base)) return '项目清单';
  if (INSTRUCTION_NAMES.has(base) || base.startsWith('agents.')) return '项目规则';
  if (/^(dist|build|out|output|generated|artifacts?|reports?|coverage)(\/|$)/i.test(relativePath)) return '生成产物';
  if (/\.generated\.|\.g\.|\.min\.|\.map$/i.test(base) || /@generated|自动生成|generated file/i.test(content.slice(0, 1200))) return '生成产物';
  if (/^(\.env|config|settings)/i.test(base) || /\.(config|conf|settings)\./i.test(base)) return '配置文件';
  return '源代码或文档';
}

function languageFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const labels = {
    '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.ts': 'TypeScript',
    '.tsx': 'TypeScript React', '.jsx': 'JavaScript React', '.py': 'Python', '.go': 'Go',
    '.rs': 'Rust', '.java': 'Java', '.cs': 'C#', '.html': 'HTML', '.css': 'CSS',
    '.json': 'JSON', '.md': 'Markdown', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
    '.ps1': 'PowerShell', '.sh': 'Shell', '.sql': 'SQL',
  };
  return labels[extension] || extension.replace('.', '').toUpperCase() || '无扩展名';
}

async function walk(root, { maxFiles = 1200, priorityPaths = [] } = {}) {
  const normalLimit = Math.max(1, Math.min(Number(maxFiles) || 1200, 5000));
  const priority = new Set(priorityPaths.map((item) => String(item || '').replace(/\\/g, '/').toLowerCase()).filter(Boolean));
  const result = [];
  const pending = [root];
  let discoveredFiles = 0;
  let truncated = false;
  while (pending.length && result.length < normalLimit) {
    const current = pending.pop();
    let entries = [];
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) pending.push(filePath);
      } else if (entry.isFile()) {
        discoveredFiles += 1;
        const rel = relative(root, filePath).toLowerCase();
        if (!priority.has(rel)) result.push(filePath);
        if (result.length >= normalLimit) {
          truncated = true;
          break;
        }
      }
    }
  }
  if (pending.length) truncated = true;

  // Directly referenced files remain visible even if their directory was not
  // reached before the ordinary scan limit.
  const selected = [];
  const prioritySelected = [];
  const seen = new Set();
  for (const raw of priorityPaths) {
    const candidate = path.resolve(root, String(raw || ''));
    if (!isInside(root, candidate)) continue;
    try {
      const info = await fs.stat(candidate);
      if (!info.isFile()) continue;
      const key = candidate.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        selected.push(candidate);
        prioritySelected.push(candidate);
      }
    } catch {
      // A file may have been removed after it was mentioned in a conversation.
    }
  }
  for (const filePath of result) {
    const key = filePath.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      selected.push(filePath);
    }
  }
  return {
    files: selected,
    discoveredFiles,
    truncated,
    priorityFiles: prioritySelected,
  };
}

async function git(root, args, maximum = 120000) {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], { windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024 });
    return text(result.stdout, maximum);
  } catch {
    return '';
  }
}

async function gitBuffer(root, args, maximumBytes = 16 * 1024 * 1024) {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], {
      windowsHide: true,
      timeout: 12000,
      maxBuffer: maximumBytes,
      encoding: 'buffer',
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
  } catch {
    return null;
  }
}

function looksLikeText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return false;
  let control = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  return sample.length === 0 || control / sample.length < 0.02;
}

function parseStatus(output) {
  return output.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).map((line) => ({
    status: line.slice(0, 2).trim() || '??',
    path: line.slice(3).trim(),
  }));
}

function conversationFileLinks(relatedFiles, root) {
  const map = new Map();
  for (const item of relatedFiles || []) {
    const raw = typeof item === 'string' ? item : item?.path;
    if (!raw) continue;
    const candidate = path.resolve(root, raw);
    if (!isInside(root, candidate)) continue;
    const key = relative(root, candidate);
    const current = map.get(key) || { path: key, stages: [], sessions: [], actions: [] };
    const stage = Number(item?.stage || item?.sourceStage);
    if (Number.isFinite(stage)) current.stages.push(stage);
    if (item?.sourceSessionId) current.sessions.push(text(item.sourceSessionId, 160));
    if (item?.action) current.actions.push(text(item.action, 80));
    map.set(key, current);
  }
  return [...map.values()].map((item) => ({
    ...item,
    stages: [...new Set(item.stages)].sort((a, b) => a - b),
    sessions: unique(item.sessions, 20),
    actions: unique(item.actions, 20),
  }));
}

function unique(values, maximum = 80) {
  return [...new Set((values || []).map((value) => text(value, 500)).filter(Boolean))].slice(0, maximum);
}

function evidencePriority(item) {
  let score = 0;
  if (item.observedInConversation) score += 1000;
  if (item.gitStatus) score += 700;
  if (item.kind === '项目规则') score += 500;
  if (item.kind === '项目清单') score += 450;
  if (item.kind === '生成产物') score += 320;
  if (/^(src\/)?(index|main|app|server|cli)\./i.test(item.path || '')) score += 180;
  return score;
}

function evidenceReasons(item) {
  const reasons = [];
  if (item.observedInConversation) reasons.push('会话直接关联');
  if (item.gitStatus) reasons.push('Git 已变更');
  if (item.kind === '项目规则') reasons.push('项目规则');
  if (item.kind === '项目清单') reasons.push('项目清单');
  if (item.kind === '生成产物') reasons.push('生成产物');
  if (/^(src\/)?(index|main|app|server|cli)\./i.test(item.path || '')) reasons.push('可能入口');
  return reasons;
}

function sortByEvidence(left, right) {
  return Number(right.evidencePriority || 0) - Number(left.evidencePriority || 0)
    || Number(right.observedInConversation) - Number(left.observedInConversation)
    || String(left.path || '').localeCompare(String(right.path || ''));
}

function relevanceTokens(values = []) {
  return [...new Set(values
    .flatMap((value) => String(value || '').toLocaleLowerCase('zh-CN').split(/[^\p{L}\p{N}_-]+/u))
    .map((value) => value.trim())
    .filter((value) => value.length >= 2)
    .slice(0, 240))];
}

function selectRelevantProjectFiles(root, filePaths, priorityPaths, keywords, maximum = 120) {
  const limit = Math.max(1, Math.min(Number(maximum) || 120, 1000));
  const direct = new Set(priorityPaths.map((item) => String(item || '').replace(/\\/g, '/').toLocaleLowerCase('zh-CN')));
  const tokens = relevanceTokens(keywords);
  const scored = filePaths.map((filePath) => {
    const rel = relative(root, filePath);
    const lower = rel.toLocaleLowerCase('zh-CN');
    const base = path.basename(lower);
    let score = 0;
    const reasons = [];
    if (direct.has(lower)) { score += 5000; reasons.push('会话或 Git 直接关联'); }
    if (MANIFEST_NAMES.has(base)) { score += 1400; reasons.push('项目清单'); }
    if (INSTRUCTION_NAMES.has(base) || base.startsWith('agents.')) { score += 1300; reasons.push('项目规则'); }
    if (/^(src|app|lib|server|scripts?|tests?|test|config|docs)(\/|$)/i.test(lower)) { score += 280; reasons.push('核心目录'); }
    if (/^(dist|build|out|coverage|node_modules|vendor|tmp|temp|cache|logs?)(\/|$)/i.test(lower)) score -= 260;
    if (/^(src\/)?(index|main|app|server|cli)\./i.test(lower)) { score += 260; reasons.push('可能入口'); }
    if (/\.(test|spec)\./i.test(base) || /(^|\/)(test|tests)(\/|$)/i.test(lower)) { score += 180; reasons.push('验证文件'); }
    for (const token of tokens) if (lower.includes(token)) score += 45;
    if (score === 0) score = Math.max(1, 30 - lower.split('/').length);
    return { filePath, rel, score, reasons };
  });
  scored.sort((left, right) => right.score - left.score || left.rel.localeCompare(right.rel));
  const selected = scored.slice(0, limit);
  const selectedKeys = new Set(selected.map((item) => item.rel.toLocaleLowerCase('zh-CN')));
  return {
    files: selected.map((item) => item.filePath),
    selected,
    excluded: scored.filter((item) => !selectedKeys.has(item.rel.toLocaleLowerCase('zh-CN'))).slice(0, 240),
    limit,
    tokens,
  };
}

async function diffFor(root, relativePath, redactEnabled) {
  // `git diff HEAD` includes staged and unstaged changes. Reading only the
  // working tree loses evidence after a user has already run `git add`.
  const againstHead = await git(root, ['diff', 'HEAD', '--unified=3', '--', relativePath], 36000);
  if (againstHead) return redact(againstHead, redactEnabled, 30000);
  const [workingTree, staged] = await Promise.all([
    git(root, ['diff', '--unified=3', '--', relativePath], 18000),
    git(root, ['diff', '--cached', '--unified=3', '--', relativePath], 18000),
  ]);
  const combined = [workingTree, staged].filter(Boolean).join('\n\n');
  return combined ? redact(combined, redactEnabled, 30000) : null;
}

async function baselineFor(root, relativePath, redactEnabled, revision = 'HEAD', maxBytes = 16 * 1024 * 1024) {
  const tree = await git(root, ['ls-tree', revision, '--', relativePath], 4000);
  const match = tree.match(/^\d+\s+blob\s+([0-9a-f]{40,64})\s+(.+)$/imu);
  if (!match) return null;
  const gitObjectId = match[1];
  const sizeText = await git(root, ['cat-file', '-s', gitObjectId], 1000);
  const bytes = Number(sizeText) || null;
  const content = bytes === null || bytes <= maxBytes
    ? await gitBuffer(root, ['show', `${revision}:${relativePath}`], Math.max(maxBytes + 1024, Number(bytes || 0) + 1024))
    : null;
  return {
    available: true,
    revision,
    gitObjectId,
    bytes,
    sha256: content ? hash(content) : null,
    excerpt: content && looksLikeText(content) ? redact(content.toString('utf8'), redactEnabled, 12000) : null,
    contentStatus: content ? (looksLikeText(content) ? '完整内容已读取' : '完整二进制指纹已读取') : '仅 Git 对象元数据',
  };
}

function projectSummary(evidence) {
  return {
    root: evidence.project.root,
    name: evidence.project.name,
    isGit: evidence.git.available,
    branch: evidence.git.branch,
    scannedFiles: evidence.scan.filesScanned,
    textFiles: evidence.scan.textFiles,
    modifiedFiles: evidence.modifiedFiles.length,
    generatedFiles: evidence.generatedFiles.length,
    linkedFiles: evidence.conversationLinks.length,
    originalFiles: evidence.originalFiles.length,
    priorityFiles: evidence.files.filter((item) => Number(item.evidencePriority || 0) > 0).length,
    directConversationFiles: evidence.files.filter((item) => item.observedInConversation).length,
    scanTruncated: Boolean(evidence.scan.truncated),
    architecture: evidence.architecture,
  };
}

export async function analyseProjectEvidence({
  projectPath,
  relatedFiles = [],
  redact: redactEnabled = true,
  maxFiles = 1200,
  relevanceOnly = false,
  relevanceMaxFiles = 120,
  relevanceKeywords = [],
  maxFileBytes = 512 * 1024,
  maxHashBytes = 16 * 1024 * 1024,
} = {}) {
  if (!String(projectPath || '').trim()) return null;
  const requested = path.resolve(String(projectPath).trim());
  let root;
  try { root = await fs.realpath(requested); } catch { throw new Error(`项目文件夹不存在：${projectPath}`); }
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error('项目路径必须是文件夹。');
  const linked = conversationFileLinks(relatedFiles, root);
  const linkedMap = new Map(linked.map((item) => [item.path.toLowerCase(), item]));
  const statusOutput = await git(root, ['status', '--porcelain=v1']);
  const diffStat = await git(root, ['diff', 'HEAD', '--stat']);
  const branch = await git(root, ['branch', '--show-current'], 1000);
  const isGit = Boolean(await git(root, ['rev-parse', '--is-inside-work-tree'], 1000));
  const headRevision = isGit ? await git(root, ['rev-parse', 'HEAD'], 1000) : '';
  const status = parseStatus(statusOutput);
  const statusMap = new Map(status.map((item) => [item.path.toLowerCase(), item.status]));
  const priorityPaths = unique([
    ...linked.map((item) => item.path),
    ...status.map((item) => item.path),
  ], 480);
  const walkResult = await walk(root, { maxFiles, priorityPaths });
  const relevance = relevanceOnly
    ? selectRelevantProjectFiles(root, walkResult.files, priorityPaths, relevanceKeywords, relevanceMaxFiles)
    : { files: walkResult.files, selected: [], excluded: [], limit: null, tokens: relevanceTokens(relevanceKeywords) };
  const filePaths = relevance.files;
  const languageCounts = new Map();
  const manifests = [];
  const instructions = [];
  const files = [];
  let textFiles = 0;
  for (const filePath of filePaths) {
    const rel = relative(root, filePath);
    let info;
    try { info = await fs.stat(filePath); } catch { continue; }
    const extension = path.extname(filePath).toLowerCase();
    const isText = TEXT_EXTENSIONS.has(extension) || MANIFEST_NAMES.has(path.basename(rel).toLowerCase()) || INSTRUCTION_NAMES.has(path.basename(rel).toLowerCase());
    let content = '';
    let textRead = false;
    if (isText && info.size <= maxFileBytes) {
      try { content = await fs.readFile(filePath, 'utf8'); textRead = true; textFiles += 1; } catch { content = ''; }
    }
    let contentSha256 = textRead ? hash(Buffer.from(content, 'utf8')) : null;
    let hashStatus = textRead ? '完整内容 SHA-256' : '未计算';
    if (!contentSha256 && info.size <= maxHashBytes) {
      try {
        const raw = await fs.readFile(filePath);
        contentSha256 = hash(raw);
        hashStatus = '完整文件 SHA-256';
      } catch {
        contentSha256 = null;
      }
    }
    const kind = fileKind(rel, content);
    const language = languageFor(filePath);
    languageCounts.set(language, (languageCounts.get(language) || 0) + 1);
    const link = linkedMap.get(rel.toLowerCase());
    const gitStatus = statusMap.get(rel.toLowerCase()) || '';
    const changeState = gitStatus.startsWith('??') ? '新增' : gitStatus ? '修改' : link ? '会话中出现' : '未改动';
    const item = {
      path: rel,
      kind,
      language,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      contentSha256,
      hashStatus,
      contentStatus: textRead ? '全文已读取并生成展示摘录' : contentSha256 ? '完整文件指纹已计算，正文未读取' : '仅记录元数据',
      changeState,
      gitStatus: gitStatus || null,
      observedInConversation: Boolean(link),
      projectRole: kind === '项目清单' ? '依赖、脚本或构建入口' : kind === '项目规则' ? '项目约束与执行说明' : kind === '生成产物' ? '可交付或自动生成结果' : kind === '配置文件' ? '运行参数与环境配置' : '源码、测试或文档实现',
      conversation: link || null,
      currentExcerpt: textRead && content ? redact(content, redactEnabled, 12000) : null,
    };
    item.evidencePriority = evidencePriority(item);
    item.evidenceReasons = evidenceReasons(item);
    files.push(item);
    const lowerName = path.basename(rel).toLowerCase();
    if (kind === '项目清单') manifests.push({ path: rel, language, excerpt: content ? redact(content, redactEnabled, 6000) : null });
    if (kind === '项目规则') instructions.push({ path: rel, excerpt: content ? redact(content, redactEnabled, 6000) : null });
  }
  const changedPaths = [...new Set([
    ...status.map((item) => item.path),
    ...linked.map((item) => item.path),
  ])].sort((left, right) => {
    const leftLinked = linkedMap.has(String(left).toLowerCase()) ? 1 : 0;
    const rightLinked = linkedMap.has(String(right).toLowerCase()) ? 1 : 0;
    return rightLinked - leftLinked || String(left).localeCompare(String(right));
  }).slice(0, 240);
  const changed = [];
  for (const rel of changedPaths) {
    const item = files.find((file) => file.path.toLowerCase() === rel.toLowerCase()) || { path: rel, kind: '会话关联文件', changeState: statusMap.get(rel.toLowerCase()) ? '修改' : '会话中出现' };
    const baseline = isGit ? await baselineFor(root, rel, redactEnabled, headRevision || 'HEAD', maxHashBytes) : null;
    const diff = isGit ? await diffFor(root, rel, redactEnabled) : null;
    changed.push({
      ...item,
      original: baseline,
      diffExcerpt: diff || null,
      diffSha256: diff ? hash(diff) : null,
      changeState: item.changeState === '未改动' ? '会话中出现' : item.changeState,
    });
  }
  const generated = files.filter((item) => item.kind === '生成产物').slice(0, 240).map((item) => ({
    path: item.path,
    bytes: item.bytes,
    modifiedAt: item.modifiedAt,
    contentSha256: item.contentSha256,
    hashStatus: item.hashStatus,
    contentStatus: item.contentStatus,
    language: item.language,
    kind: item.kind,
    projectRole: item.projectRole,
    changeState: item.changeState,
    gitStatus: item.gitStatus,
    currentExcerpt: item.currentExcerpt,
  }));
  for (const item of generated) {
    const source = files.find((candidate) => candidate.path === item.path);
    if (source) {
      item.observedInConversation = source.observedInConversation;
      item.evidencePriority = source.evidencePriority;
      item.evidenceReasons = source.evidenceReasons;
    }
  }
  generated.sort((left, right) => sortByEvidence(
    files.find((item) => item.path === left.path) || left,
    files.find((item) => item.path === right.path) || right,
  ));
  changed.sort(sortByEvidence);
  const original = changed.filter((item) => item.original).map((item) => ({
    path: item.path,
    sha256: item.original.sha256,
    gitObjectId: item.original.gitObjectId,
    revision: item.original.revision,
    bytes: item.original.bytes,
    contentStatus: item.original.contentStatus,
    excerpt: item.original.excerpt,
    evidencePriority: item.evidencePriority,
    evidenceReasons: item.evidenceReasons,
  }));
  const projectName = path.basename(root) || root;
  const evidence = {
    schemaVersion: '1.0.0',
    type: 'project-and-conversation-evidence',
    generatedAt: new Date().toISOString(),
    project: { name: projectName, root, isGit },
    scan: {
      filesScanned: filePaths.length,
      discoveredFiles: walkResult.discoveredFiles,
      priorityFiles: walkResult.priorityFiles.length,
      truncated: walkResult.truncated,
      relevanceOnly: Boolean(relevanceOnly),
      relevanceMaxFiles: relevance.limit,
      relevanceKeywords: relevance.tokens,
      relevantFilesSelected: relevance.selected.map((item) => ({ path: item.rel, score: item.score, reasons: item.reasons })),
      relevantFilesExcluded: relevance.excluded.map((item) => ({ path: item.rel, score: item.score })),
      selectionPolicy: '会话直接关联和 Git 变更文件始终优先纳入；其余文件按目录扫描上限补充。',
      textFiles,
      maxFiles,
      maxFileBytes,
      maxHashBytes,
      ignoredDirectories: [...IGNORED_DIRECTORIES],
    },
    architecture: {
      languages: [...languageCounts.entries()].sort((left, right) => right[1] - left[1]).map(([name, count]) => ({ name, count })),
      manifests,
      instructions,
      likelyEntryFiles: files.filter((item) => /^(src\/)?(index|main|app|server|cli)\./i.test(item.path) || /(^|\/)(vite|webpack|next|tsconfig|eslint|jest|vitest)/i.test(item.path)).slice(0, 40).map((item) => item.path),
    },
    git: {
      available: isGit,
      branch: text(branch, 160) || null,
      headRevision: text(headRevision, 160) || null,
      status,
      diffStat: diffStat || null,
      changedFiles: changed.map((item) => ({ path: item.path, status: item.gitStatus || item.changeState, originalAvailable: Boolean(item.original), hasDiff: Boolean(item.diffExcerpt) })),
    },
    files: files.sort(sortByEvidence),
    originalFiles: original,
    modifiedFiles: changed,
    generatedFiles: generated,
    conversationLinks: linked,
    summary: null,
  };
  evidence.summary = projectSummary(evidence);
  return evidence;
}

export function projectEvidenceMarkdown(evidence) {
  if (!evidence) return '# 项目证据\n\n本次没有从会话工作目录、文件路径或项目标记中发现可验证的本地项目。\n';
  const lines = [
    `# 项目与会话联合证据：${evidence.project.name}`,
    '',
    `- 项目选择方式：${evidence.discovery?.mode || evidence.project.selectionMode || '未记录'}`,
    `- 自动发现置信度：${evidence.discovery?.confidence || evidence.project.selectionConfidence || '未记录'}`,
    `- 选择依据：${evidence.discovery?.reason || '未记录'}`,
    `- 项目根目录：\`${evidence.project.root}\``,
    `- 扫描文件：${evidence.scan.filesScanned} 个（可读文本 ${evidence.scan.textFiles} 个）`,
    `- Git：${evidence.git.available ? `已识别，当前分支 ${evidence.git.branch || '未命名'}` : '未识别'}`,
    `- 会话关联文件：${evidence.conversationLinks.length} 个`,
    `- 修改或新增文件：${evidence.modifiedFiles.length} 个`,
    `- 生成产物：${evidence.generatedFiles.length} 个`,
    '',
    '## 项目结构',
    '',
    `语言：${(evidence.architecture.languages || []).map((item) => `${item.name}（${item.count}）`).join('、') || '未识别'}`,
    `入口候选：${(evidence.architecture.likelyEntryFiles || []).join('、') || '未识别'}`,
    '',
    '## 会话中出现或被修改的文件',
    '',
    '| 文件 | 状态 | 项目角色 | 原始版本 | 当前差异 |',
    '| --- | --- | --- | --- | --- |',
    ...(evidence.modifiedFiles || []).map((item) => `| ${item.path} | ${item.changeState || '—'} | ${item.projectRole || '—'} | ${item.original ? '已读取' : '无 Git 原始版本'} | ${item.diffExcerpt ? '已读取' : '无差异'} |`),
    '',
    '## 生成文件',
    '',
    ...(evidence.generatedFiles || []).map((item) => `- **${item.path}**：${item.language}，${item.bytes} 字节，状态为 ${item.changeState}。`),
  ];
  lines.push(
    '',
    '## 取证选择规则',
    '',
    `优先文件：${evidence.scan.priorityFiles || 0} 个；直接关联会话或 Git 变更的文件会优先纳入。`,
    evidence.scan.truncated
      ? '普通目录扫描达到文件上限，但优先文件不会因为上限被遗漏。'
      : '普通目录扫描未达到文件上限。',
    '',
    '每个变更文件尽量同时保留当前内容、Git HEAD 原始版本和差异摘要；无法读取的部分会明确标注。',
  );
  return `${lines.join('\n')}\n`;
}
