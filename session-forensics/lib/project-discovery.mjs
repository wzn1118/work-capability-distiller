import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROJECT_MARKERS = [
  '.git', 'AGENTS.md', 'package.json', 'pnpm-workspace.yaml', 'yarn.lock', 'package-lock.json',
  'pyproject.toml', 'requirements.txt', 'Pipfile', 'go.mod', 'Cargo.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'global.json',
  'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'vite.config.js', 'vite.config.ts', 'next.config.js', 'next.config.mjs', 'tsconfig.json',
];

function clean(value, maximum = 2000) {
  const result = String(value ?? '').replace(/\u0000/g, '').trim();
  return result.length <= maximum ? result : result.slice(0, maximum);
}

function unique(values, maximum = 240) {
  return [...new Set((values || []).map((value) => clean(value)).filter(Boolean))].slice(0, maximum);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function confidence(score) {
  if (score >= 420) return '高';
  if (score >= 230) return '中';
  return '低';
}

function normalisePathText(value) {
  return clean(value, 6000)
    .replace(/^['"`]+|['"`,;]+$/g, '')
    .replace(/\\\\/g, '\\');
}

function absolutePathsInText(value) {
  const text = clean(value, 32000);
  const found = [];
  for (const match of text.matchAll(/[A-Za-z]:[\\/][^\r\n"'<>|?*{}\[\]]+/g)) found.push(match[0].trim());
  for (const match of text.matchAll(/(?:^|[\s"'=:])(\/(?:[^\s\r\n"'<>|{}\[\]]+\/?)+)/g)) found.push(match[1].trim());
  return unique(found, 80);
}

async function statPath(candidate) {
  try { return await fs.stat(candidate); } catch { return null; }
}

async function existingDirectory(rawPath, base = '') {
  const value = normalisePathText(rawPath);
  if (!value) return null;
  let candidate = path.isAbsolute(value) ? path.resolve(value) : base ? path.resolve(base, value) : null;
  if (!candidate) return null;
  let info = await statPath(candidate);
  if (info?.isFile()) return path.dirname(candidate);
  if (info?.isDirectory()) return candidate;
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
    info = await statPath(candidate);
    if (info?.isDirectory()) return candidate;
  }
  return null;
}

async function markersAt(directory) {
  const markers = [];
  await Promise.all(PROJECT_MARKERS.map(async (marker) => {
    if (await statPath(path.join(directory, marker))) markers.push(marker);
  }));
  return markers.sort((left, right) => left.localeCompare(right));
}

async function gitRoot(directory) {
  try {
    const result = await execFileAsync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 128 * 1024,
    });
    const root = clean(result.stdout, 4000);
    return root ? await fs.realpath(root) : null;
  } catch {
    return null;
  }
}

async function nearestProjectRoot(directory) {
  const resolved = await fs.realpath(directory);
  const repositoryRoot = await gitRoot(resolved);
  if (repositoryRoot) {
    return { root: repositoryRoot, git: true, markers: await markersAt(repositoryRoot) };
  }
  let current = resolved;
  let fallback = null;
  for (let depth = 0; depth < 10; depth += 1) {
    const markers = await markersAt(current);
    if (markers.length) return { root: current, git: false, markers };
    if (!fallback) fallback = current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { root: fallback, git: false, markers: [] };
}

function addSignal(signals, rawPath, type, weight, detail, base = '') {
  const value = normalisePathText(rawPath);
  if (!value) return;
  const key = [type, value.toLowerCase(), clean(base).toLowerCase()].join('\u001f');
  if (signals.has(key)) return;
  signals.set(key, { path: value, type, weight, detail: clean(detail, 500), base: clean(base, 4000) || null });
}

function collectSignals({ sources = [], parsed = null, relatedFiles = [] } = {}) {
  const signals = new Map();
  const cwdValues = [];
  for (const source of sources || []) {
    const meta = source.parsed?.sessionMeta || {};
    const metaCwd = meta.cwd || meta.working_directory || meta.workingDirectory || meta.workspace || meta.workspaceRoot;
    if (metaCwd) {
      cwdValues.push(metaCwd);
      addSignal(signals, metaCwd, '会话工作目录', 170, `会话“${source.title || source.sessionId || '未命名'}”记录的工作目录`);
    }
    for (const turn of source.parsed?.turnContexts || []) {
      if (!turn.cwd) continue;
      cwdValues.push(turn.cwd);
      addSignal(signals, turn.cwd, '需求阶段工作目录', 145, `会话“${source.title || source.sessionId || '未命名'}”的需求阶段工作目录`);
    }
  }
  for (const turn of parsed?.turnContexts || []) {
    if (!turn.cwd) continue;
    cwdValues.push(turn.cwd);
    addSignal(signals, turn.cwd, '需求阶段工作目录', 145, `需求阶段 ${turn.turnId || turn.recordIndex || '未编号'} 的工作目录`);
  }
  const workingDirectories = unique(cwdValues, 40);
  for (const item of relatedFiles || []) {
    const filePath = typeof item === 'string' ? item : item?.path;
    if (!filePath) continue;
    if (path.isAbsolute(filePath)) {
      addSignal(signals, filePath, '会话文件证据', 155, `会话记录了文件${item?.action ? `操作“${item.action}”` : '变更'}`);
    } else {
      for (const cwd of workingDirectories) addSignal(signals, filePath, '相对文件证据', 110, `会话中的相对文件路径，基于工作目录解析`, cwd);
    }
  }
  for (const tool of parsed?.toolCalls || []) {
    for (const candidate of absolutePathsInText(tool.argumentsExcerpt)) {
      addSignal(signals, candidate, '工具参数路径', 65, `工具 ${tool.name || '未命名'} 的参数中出现`);
    }
  }
  for (const message of parsed?.messages || []) {
    for (const candidate of absolutePathsInText(message.text)) {
      addSignal(signals, candidate, '对话绝对路径', 35, `${message.actor === 'user' ? '用户' : '助手'}消息中出现`);
    }
  }
  return [...signals.values()];
}

function publicSignal(signal) {
  return { type: signal.type, path: signal.path, weight: signal.weight, detail: signal.detail, base: signal.base };
}

function projectId(root) {
  const name = path.basename(root).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const suffix = crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 10);
  return `${name}-${suffix}`;
}

function sessionIdentity(source, index = 0) {
  return {
    sessionId: clean(source?.sessionId || source?.parsed?.sessionId || `source-${index + 1}`, 160),
    title: clean(source?.title || source?.parsed?.sessionMeta?.title || `未命名会话 ${index + 1}`, 240),
    sourcePath: clean(source?.sourcePath || source?.path || '', 6000) || null,
  };
}

function filesForSession(relatedFiles, sessionId, sourceCount) {
  const expected = String(sessionId || '').trim().toLowerCase();
  const exact = (relatedFiles || []).filter((item) => typeof item === 'object'
    && String(item?.sourceSessionId || item?.sessionId || '').trim().toLowerCase() === expected);
  if (exact.length) return exact;
  return sourceCount === 1 ? relatedFiles : [];
}

async function rankCandidates(signals, relatedFiles, rootCache) {
  const candidates = new Map();
  for (const signal of signals) {
    const directory = await existingDirectory(signal.path, signal.base || '');
    if (!directory) continue;
    const directoryKey = directory.toLowerCase();
    let project = rootCache.get(directoryKey);
    if (!project) {
      project = await nearestProjectRoot(directory);
      rootCache.set(directoryKey, project);
    }
    if (!project.root || path.parse(project.root).root === project.root) continue;
    const key = project.root.toLowerCase();
    const current = candidates.get(key) || {
      root: project.root,
      score: 0,
      git: project.git,
      markers: project.markers,
      linkedFiles: 0,
      signals: [],
    };
    current.score += Number(signal.weight) || 0;
    current.signals.push(publicSignal(signal));
    candidates.set(key, current);
  }

  const absoluteLinkedFiles = (relatedFiles || []).map((item) => typeof item === 'string' ? item : item?.path).filter((item) => item && path.isAbsolute(item));
  for (const candidate of candidates.values()) {
    candidate.linkedFiles = absoluteLinkedFiles.filter((filePath) => isInside(candidate.root, path.resolve(filePath))).length;
    candidate.score += candidate.linkedFiles * 90;
    if (candidate.git) candidate.score += 140;
    candidate.score += Math.min(candidate.markers.length, 6) * 28;
    candidate.confidence = confidence(candidate.score);
    candidate.signals = candidate.signals.slice(0, 40);
  }

  return [...candidates.values()]
    .filter((candidate) => candidate.git || candidate.markers.length || candidate.linkedFiles > 0)
    .sort((left, right) => right.score - left.score || right.linkedFiles - left.linkedFiles || left.root.localeCompare(right.root));
}

function assignmentFromRanking(source, index, ranked) {
  const identity = sessionIdentity(source, index);
  const selected = ranked[0] || null;
  const runnerUp = ranked[1] || null;
  if (!selected) return { ...identity, projectId: null, projectRoot: null, projectName: null, score: 0, confidence: '无', ambiguous: false, reason: '这条会话没有提供可验证的项目目录、项目标记或关联文件。', alternatives: [] };
  const gap = selected.score - Number(runnerUp?.score || 0);
  return {
    ...identity,
    projectId: projectId(selected.root),
    projectRoot: selected.root,
    projectName: path.basename(selected.root),
    score: selected.score,
    confidence: selected.confidence,
    ambiguous: Boolean(runnerUp && gap < 90),
    reason: `根据这条会话自己的工作目录、文件和工具路径，项目“${path.basename(selected.root)}”得分 ${selected.score}${runnerUp ? `，领先下一候选 ${gap} 分` : ''}。`,
    alternatives: ranked.slice(1, 4).map((candidate) => ({ projectId: projectId(candidate.root), root: candidate.root, name: path.basename(candidate.root), score: candidate.score, confidence: candidate.confidence })),
  };
}

export async function discoverRelatedProjects({ projectPath, sources = [], parsed = null, relatedFiles = [] } = {}) {
  const requested = clean(projectPath, 6000);
  const manual = requested && !['auto', 'automatic', '自动'].includes(requested.toLowerCase());
  if (manual) {
    const directory = await existingDirectory(requested);
    if (!directory || path.resolve(directory) !== path.resolve(requested)) throw new Error(`项目文件夹不存在：${projectPath}`);
    const selectedPath = await fs.realpath(directory);
    const project = await nearestProjectRoot(selectedPath);
    const root = project.root || selectedPath;
    const assignments = (sources || []).map((source, index) => ({
      ...sessionIdentity(source, index), projectId: projectId(root), projectRoot: root, projectName: path.basename(root),
      score: 10000, confidence: '高', ambiguous: false, reason: '用户明确指定了项目，所选会话统一归入该项目。', alternatives: [],
    }));
    const candidate = { root, score: 10000, confidence: '高', git: project.git, markers: project.markers, linkedFiles: 0, signals: [{ type: '人工指定', path: requested, weight: 10000, detail: '用户通过文件夹选择器指定的项目目录', base: null }] };
    return {
      schemaVersion: '2.0.0', mode: '人工指定', selectedPath, selectedProjectRoot: root, confidence: '高',
      reason: '用户明确指定了项目目录；全部所选会话归入该项目，仍保留逐会话归属记录。', candidates: [candidate], signalsConsidered: 1,
      crossProject: false, recommendedMode: '作为一个项目联合蒸馏', sessionAssignments: assignments, unassignedSessions: [],
      projects: [{ projectId: projectId(root), name: path.basename(root), root, score: 10000, confidence: '高', git: project.git, markers: project.markers, linkedFiles: 0, sessionCount: assignments.length, sessions: assignments }],
    };
  }

  const rootCache = new Map();
  const aggregateSignals = collectSignals({ sources, parsed, relatedFiles });
  const ranked = await rankCandidates(aggregateSignals, relatedFiles, rootCache);
  const assignments = [];
  for (const [index, source] of (sources || []).entries()) {
    const identity = sessionIdentity(source, index);
    const sessionFiles = filesForSession(relatedFiles, identity.sessionId, sources.length);
    const sessionSignals = collectSignals({ sources: [source], parsed: source?.parsed || null, relatedFiles: sessionFiles });
    const sessionRanked = await rankCandidates(sessionSignals, sessionFiles, rootCache);
    assignments.push(assignmentFromRanking(source, index, sessionRanked));
  }

  if (!assignments.length && ranked[0]) assignments.push(assignmentFromRanking({ sessionId: parsed?.sessionId, title: parsed?.sessionMeta?.title }, 0, ranked));
  const grouped = new Map();
  for (const assignment of assignments.filter((item) => item.projectRoot)) {
    const aggregate = ranked.find((candidate) => candidate.root.toLowerCase() === assignment.projectRoot.toLowerCase());
    const current = grouped.get(assignment.projectId) || {
      projectId: assignment.projectId, name: assignment.projectName, root: assignment.projectRoot,
      score: 0, confidence: assignment.confidence, git: Boolean(aggregate?.git), markers: aggregate?.markers || [], linkedFiles: 0, sessions: [],
    };
    current.score += assignment.score;
    current.linkedFiles += Number(aggregate?.linkedFiles || 0);
    current.sessions.push(assignment);
    if (assignment.confidence === '高') current.confidence = '高';
    grouped.set(assignment.projectId, current);
  }
  const projects = [...grouped.values()]
    .map((project) => ({ ...project, linkedFiles: Math.min(project.linkedFiles, Number(ranked.find((candidate) => candidate.root.toLowerCase() === project.root.toLowerCase())?.linkedFiles || project.linkedFiles)), sessionCount: project.sessions.length }))
    .sort((left, right) => right.sessionCount - left.sessionCount || right.score - left.score || left.root.localeCompare(right.root));
  const selected = ranked[0] || (projects[0] ? { ...projects[0] } : null);
  const unassignedSessions = assignments.filter((item) => !item.projectRoot);
  const crossProject = projects.length > 1;
  return {
    schemaVersion: '2.0.0',
    mode: selected ? (crossProject ? '自动发现多个项目' : '自动发现') : '未发现',
    selectedPath: selected?.root || null,
    selectedProjectRoot: selected?.root || null,
    confidence: selected?.confidence || '无',
    reason: selected
      ? crossProject
        ? `已逐条分析 ${assignments.length} 条会话，识别出 ${projects.length} 个不同项目；将按项目隔离证据，避免把不同项目的文件和流程混在一起。`
        : `已逐条分析 ${assignments.length} 条会话，它们共同指向项目“${path.basename(selected.root)}”。`
      : '会话中没有可验证的本地工作目录、项目标记或关联文件。',
    candidates: ranked.slice(0, 20), signalsConsidered: aggregateSignals.length, crossProject,
    recommendedMode: crossProject ? '按项目分组蒸馏，并生成一个可导航的项目组合能力包' : '作为一个项目联合蒸馏',
    projects, sessionAssignments: assignments, unassignedSessions,
  };
}

export async function discoverRelatedProject(options = {}) {
  return discoverRelatedProjects(options);
}

export function projectDiscoveryMarkdown(discovery) {
  if (!discovery) return '# 项目自动发现\n\n没有生成项目发现记录。\n';
  const lines = [
    '# 项目自动发现',
    '',
    `- 选择方式：${discovery.mode}`,
    `- 主项目目录：${discovery.selectedPath ? `\`${discovery.selectedPath}\`` : '未发现'}`,
    `- 最终目录（兼容字段）：${discovery.selectedPath ? `\`${discovery.selectedPath}\`` : '未发现'}`,
    `- 置信度：${discovery.confidence}`,
    `- 选择依据：${discovery.reason}`,
    `- 识别项目数：${(discovery.projects || []).length}`,
    `- 建议蒸馏方式：${discovery.recommendedMode || '按现有证据蒸馏'}`,
    '',
    '## 会话与项目归属',
    '',
    '| 会话 | 归属项目 | 置信度 | 是否存在相近候选 | 判断依据 |',
    '| --- | --- | --- | --- | --- |',
    ...(discovery.sessionAssignments || []).map((item) => `| ${item.title || item.sessionId} | ${item.projectName || '未归属'} | ${item.confidence || '无'} | ${item.ambiguous ? '是' : '否'} | ${item.reason || '无'} |`),
    '',
    '## 候选项目',
    '',
    '| 排名 | 项目根目录 | 得分 | 置信度 | Git | 项目标记 | 关联文件 |',
    '| --- | --- | ---: | --- | --- | --- | ---: |',
    ...(discovery.candidates || []).map((candidate, index) => `| ${index + 1} | ${candidate.root} | ${candidate.score} | ${candidate.confidence} | ${candidate.git ? '是' : '否'} | ${(candidate.markers || []).join('、') || '无'} | ${candidate.linkedFiles || 0} |`),
  ];
  if (!(discovery.sessionAssignments || []).length) lines.splice(13, 0, '| — | 没有会话归属记录 | 无 | 否 | 无 |');
  if (!(discovery.candidates || []).length) lines.push('| — | 没有可验证候选 | 0 | 无 | 否 | 无 | 0 |');
  return `${lines.join('\n')}\n`;
}

export function projectPortfolioMarkdown(portfolio) {
  if (!portfolio) return '# 项目组合与会话归属\n\n没有生成项目组合记录。\n';
  const projects = portfolio.projects || [];
  const assignments = portfolio.sessionAssignments || [];
  const lines = [
    '# 项目组合与会话归属',
    '',
    `- 识别模式：${portfolio.mode || '未识别'}`,
    `- 推荐蒸馏方式：${portfolio.recommendedMode || '按证据处理'}`,
    `- 是否跨项目：${portfolio.crossProject ? '是' : '否'}`,
    `- 识别项目数：${projects.length}`,
    '',
    '## 项目清单',
    '',
    '| 项目 | 根目录 | 会话数 | 文件证据数 | 证据置信度 |',
    '| --- | --- | ---: | ---: | --- |',
    ...(projects.length ? projects.map((project) => `| ${project.name || project.projectId || '未命名项目'} | ${project.root || '未发现'} | ${project.sessionCount || (project.sessions || []).length || 0} | ${project.relatedFiles?.length || project.linkedFiles || 0} | ${project.confidence || '未知'} |`) : ['| 暂无 | 未发现可验证项目 | 0 | 0 | 未知 |']),
    '',
    '## 会话归属',
    '',
    '| 会话标题 | 会话编号 | 所属项目 | 置信度 | 判断依据 |',
    '| --- | --- | --- | --- | --- |',
    ...(assignments.length ? assignments.map((item) => `| ${item.title || '未命名会话'} | ${item.sessionId || '未知'} | ${item.projectName || '未归属'} | ${item.confidence || '未知'} | ${item.reason || '暂无说明'} |`) : ['| 暂无 | 暂无 | 未归属 | 未知 | 没有可用会话归属记录 |']),
    '',
    '## 使用说明',
    '',
    portfolio.crossProject
      ? '系统会按项目分组保留文件、Git、工具调用和生成产物证据；不同项目不会混入同一条执行流程。'
      : '当前会话均指向同一项目，系统会在同一个项目范围内合并相关证据。',
  ];
  return `${lines.join('\n')}\n`;
}
