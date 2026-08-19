import path from 'node:path';

function clean(value, maximum = 2400) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

function unique(values, maximum = 160) {
  return [...new Set((values || []).map((item) => clean(item, 800)).filter(Boolean))].slice(0, maximum);
}

function evidenceId(kind, index) {
  return `${kind}-${String(index + 1).padStart(4, '0')}`;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function actionLabel(value) {
  const labels = {
    added: '新增', add: '新增', created: '新增', create: '新增',
    modified: '修改', modify: '修改', update: '更新', updated: '更新',
    deleted: '删除', delete: '删除', removed: '删除', remove: '删除',
    renamed: '重命名', rename: '重命名', moved: '移动', move: '移动',
  };
  const raw = String(value || '').toLocaleLowerCase('zh-CN');
  return labels[raw] || clean(value || '会话关联', 80);
}

function stageSource(stage, sourceTitles, sourceSessionId = null, sourceTitle = null) {
  const sessionId = sourceSessionId || (stage.sourceSessions || []).find(Boolean) || null;
  return {
    stage: Number(stage.index) || null,
    stageTitle: clean(stage.title || `P${stage.index || '？'}｜未命名阶段`, 220),
    sessionId,
    sessionTitle: clean(sourceTitle || sourceTitles.get(sessionId) || (stage.sourceTitles || []).find(Boolean) || '未命名会话', 220),
    authorityRank: Number.isFinite(Number(stage.sourceAuthorityRank)) ? Number(stage.sourceAuthorityRank) : null,
  };
}

function contentReferences(content, knownPaths) {
  const text = String(content || '').replace(/\\/g, '/');
  const hits = [];
  for (const filePath of knownPaths) {
    const base = path.posix.basename(filePath);
    if ((filePath.length > 3 && text.includes(filePath)) || (base.length > 4 && text.includes(base))) hits.push(filePath);
  }
  return unique(hits, 40);
}

function hasVerificationCommand(command) {
  return /\b(test|vitest|jest|pytest|mocha|lint|check|build|typecheck|verify|node\s+--check)\b/i.test(String(command || ''));
}

function resolveProjectReference(currentPath, target, knownPaths) {
  if (!target || /^(?:[a-z]+:|#|data:)/iu.test(target)) return null;
  const currentDir = path.posix.dirname(currentPath || '.');
  const normalized = path.posix.normalize(path.posix.join(currentDir, target)).replace(/^\.\//, '');
  const candidates = [
    normalized,
    ...['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.py', '.css', '.scss', '.html'].map((extension) => `${normalized}${extension}`),
    ...['index.js', 'index.mjs', 'index.ts', 'index.tsx', '__init__.py'].map((name) => path.posix.join(normalized, name)),
  ];
  return candidates.find((candidate) => knownPaths.has(candidate)) || null;
}

function relativeImports(file, knownPaths = new Set()) {
  const text = String(file.currentExcerpt || '');
  const imports = [];
  const expressions = [
    /(?:from\s+|import\s*\(|require\s*\()['"]([^'"]+)['"]/g,
    /(?:src|href)\s*=\s*['"]([^'"]+)['"]/g,
    /@(?:use|import)\s+['"]([^'"]+)['"]/g,
  ];
  for (const expression of expressions) {
    for (const match of text.matchAll(expression)) {
      if (!match[1].startsWith('.')) continue;
      const resolved = resolveProjectReference(file.path, match[1], knownPaths);
      if (resolved) imports.push(resolved);
    }
  }
  return unique(imports, 40);
}

function confidenceFor(file, links, commands, projectEvidence) {
  let score = 0;
  if (file.observedInConversation || links.length) score += 4;
  if (file.gitStatus || file.diffExcerpt || file.original) score += 3;
  if (file.kind === '项目规则' || file.kind === '项目清单') score += 2;
  if (file.kind === '生成产物') score += 2;
  if (commands.some((item) => hasVerificationCommand(item.command))) score += 1;
  if (projectEvidence?.git?.available) score += 1;
  if (score >= 7) return { level: '确定', score, description: '会话、项目当前状态与 Git 证据可相互印证。' };
  if (score >= 4) return { level: '强关联', score, description: '至少两类可追溯证据指向该文件。' };
  if (score >= 2) return { level: '关联', score, description: '存在单类直接证据，建议结合当前文件继续核对。' };
  return { level: '待确认', score, description: '尚无足够证据确定它与本次目标的关系。' };
}

function priorityFor(file, evolution) {
  if (file.confidence.level === '待确认' && file.observedInConversation) return '高';
  if (file.kind === '项目规则' || file.kind === '项目清单') return '高';
  if (file.diffExcerpt || file.gitStatus) return '高';
  if (file.kind === '生成产物') return '中';
  if (evolution.length) return '中';
  return '低';
}

function buildConflictRegister(extraction, fileEvolution) {
  const entries = [];
  const corrections = extraction?.corrections || [];
  for (const correction of corrections) {
    entries.push({
      id: `conflict-correction-p${correction.stage}`,
      type: '需求覆盖',
      severity: '高',
      conclusion: `P${correction.stage} 的后续要求优先于与其冲突的早期做法。`,
      evidence: [{ stage: correction.stage, title: clean(correction.title, 220), authorityRank: correction.authorityRank ?? null }],
      handling: '执行前读取该阶段原话；计划、实现和验收以该纠正为准。',
      status: '已识别，执行时强制应用',
    });
  }
  for (const file of fileEvolution) {
    if (!file.original.available || !file.current.available) continue;
    if (!file.diff.available && file.changeState !== '未改动') {
      entries.push({
        id: `conflict-baseline-${file.id}`,
        type: '版本证据缺口',
        severity: '中',
        conclusion: `${file.path} 有 Git 原始版本和当前文件，但没有可读取的差异摘要。`,
        evidence: file.evidenceIds,
        handling: '在真实工作区执行 git diff -- <路径>，确认变更范围后再修改。',
        status: '待核对',
      });
    }
    if (file.kind === '生成产物' && !file.lineage.length) {
      entries.push({
        id: `conflict-lineage-${file.id}`,
        type: '产物来源待确认',
        severity: '中',
        conclusion: `${file.path} 被识别为生成产物，但现有证据未能定位唯一生成源。`,
        evidence: file.evidenceIds,
        handling: '读取生成脚本、构建配置和相关命令输出，确认输入、命令与输出的对应关系。',
        status: '待核对',
      });
    }
  }
  return entries.slice(0, 80);
}

function buildActiveReadPlan(projectEvidence, fileEvolution, conflicts) {
  const plan = [];
  const seen = new Set();
  const add = (item) => {
    const key = `${item.action}:${item.path || ''}:${item.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    plan.push({ id: `plan-${String(plan.length + 1).padStart(3, '0')}`, ...item });
  };
  for (const file of fileEvolution) {
    const priority = priorityFor(file, file.conversationEvidence);
    if ((file.kind === '项目规则' || file.kind === '项目清单') && !file.current.available) {
      add({ priority: '高', action: '读取项目规则或清单', path: file.path, reason: '它定义依赖、脚本、入口或本地执行约定。', evidenceIds: file.evidenceIds });
    }
    if ((file.observedInConversation || file.diff.available) && (!file.current.available || (projectEvidence?.git?.available && file.changeState !== '新增' && (!file.original.available || !file.diff.available)))) {
      add({ priority, action: '核对当前文件与原始版本', path: file.path, reason: '该文件在会话或 Git 变更中出现，修改前必须确认当前状态与已有差异。', evidenceIds: file.evidenceIds });
    }
    if (file.kind === '生成产物' && !file.lineage.length) {
      add({ priority: '高', action: '追溯生成产物来源', path: file.path, reason: '生成产物缺少唯一来源，需要关联构建脚本、命令和输入文件。', evidenceIds: file.evidenceIds });
    }
  }
  for (const conflict of conflicts.filter((item) => item.status === '待核对')) {
    add({ priority: conflict.severity === '高' ? '高' : '中', action: '处理证据缺口', path: null, reason: conflict.conclusion, evidenceIds: Array.isArray(conflict.evidence) ? conflict.evidence : [] });
  }
  if (projectEvidence?.git?.available && (projectEvidence.git.status || []).length) {
    add({ priority: '高', action: '运行版本状态检查', path: null, reason: '项目存在未提交或暂存变化，执行前需确认它们是否属于本次目标。', evidenceIds: [] });
  }
  return plan.slice(0, 120);
}

/**
 * Build a deterministic, auditable understanding layer. It intentionally does
 * not guess from a model: every connection carries identifiers back to a
 * source conversation stage, observed file, Git baseline/diff, or command.
 */
export function buildProjectUnderstanding({ projectEvidence = null, extraction = null, sourceSet = null } = {}) {
  if (!projectEvidence) return null;
  const sourceTitles = new Map((sourceSet?.sessions || []).map((item) => [item.sessionId, item.title]));
  const stages = extraction?.stages || [];
  const allFiles = [...(projectEvidence.files || []), ...(projectEvidence.modifiedFiles || [])];
  const filesByPath = new Map();
  for (const file of allFiles) {
    const key = normalizePath(file.path);
    if (!key) continue;
    filesByPath.set(key, { ...(filesByPath.get(key) || {}), ...file, path: key });
  }
  const knownPaths = [...filesByPath.keys()];
  const knownPathSet = new Set(knownPaths);
  const importsByPath = new Map([...filesByPath.values()].map((file) => [file.path, relativeImports(file, knownPathSet)]));
  const ledger = [];
  const linksByPath = new Map();
  const commandsByPath = new Map();
  const stageById = new Map();

  for (const stage of stages) {
    const source = stageSource(stage, sourceTitles);
    stageById.set(source.stage, source);
    for (const change of stage.fileChanges || []) {
      const filePath = normalizePath(change.path);
      if (!filePath) continue;
      const changeSource = stageSource(stage, sourceTitles, change.sourceSessionId, change.sourceTitle);
      const item = {
        id: evidenceId('file', ledger.length), kind: '会话文件变更', path: filePath,
        action: actionLabel(change.action), eventIndex: change.eventIndex ?? null, tool: change.tool || null,
        source: changeSource, description: `${changeSource.stageTitle} 中记录 ${actionLabel(change.action)}：${filePath}`,
      };
      ledger.push(item);
      const entries = linksByPath.get(filePath) || [];
      entries.push(item);
      linksByPath.set(filePath, entries);
    }
    for (const command of stage.commands || []) {
      const commandSource = stageSource(stage, sourceTitles, command.sourceSessionId, command.sourceTitle);
      const item = {
        id: evidenceId('command', ledger.length), kind: '会话命令', command: clean(command.command, 4000),
        eventIndex: command.eventIndex ?? null, tool: command.tool || null, category: command.category || null,
        source: commandSource, verification: hasVerificationCommand(command.command),
        description: `${commandSource.stageTitle} 执行命令：${clean(command.command, 360)}`,
      };
      ledger.push(item);
      for (const filePath of contentReferences(command.command, knownPaths)) {
        const entries = commandsByPath.get(filePath) || [];
        entries.push(item);
        commandsByPath.set(filePath, entries);
      }
    }
  }

  // The project scanner retains direct file-to-session links even when a
  // conversation stage boundary does not include a late file-change event.
  // Keep those links in the graph rather than silently losing a source.
  for (const directLink of projectEvidence.conversationLinks || []) {
    const filePath = normalizePath(directLink.path);
    if (!filePath || !filesByPath.has(filePath)) continue;
    const sessions = unique(directLink.sessions || [], 40);
    const actions = unique(directLink.actions || [], 20);
    for (const sessionId of sessions) {
      const existing = (linksByPath.get(filePath) || []).some((item) => item.source.sessionId === sessionId);
      if (existing) continue;
      const matchingStage = stages.find((stage) => (stage.sourceSessions || []).includes(sessionId)) || null;
      const source = matchingStage
        ? stageSource(matchingStage, sourceTitles, sessionId, sourceTitles.get(sessionId))
        : { stage: null, stageTitle: '项目文件直接关联', sessionId, sessionTitle: clean(sourceTitles.get(sessionId) || '未命名会话', 220), authorityRank: null };
      const item = {
        id: `project-link-${filePath}-${sessionId}`,
        kind: '项目文件关联',
        path: filePath,
        action: actionLabel(actions[0] || '会话关联'),
        eventIndex: null,
        tool: null,
        source,
        description: `${source.sessionTitle} 与项目文件 ${filePath} 存在直接关联。`,
      };
      ledger.push(item);
      const entries = linksByPath.get(filePath) || [];
      entries.push(item);
      linksByPath.set(filePath, entries);
    }
  }

  const fileEvolution = [...filesByPath.values()].map((raw, index) => {
    const filePath = normalizePath(raw.path);
    const conversationEvidence = linksByPath.get(filePath) || [];
    const commands = commandsByPath.get(filePath) || [];
    const directLinks = (projectEvidence.conversationLinks || []).find((item) => normalizePath(item.path) === filePath) || null;
    const current = { available: Boolean(raw.currentExcerpt), excerpt: raw.currentExcerpt ? clean(raw.currentExcerpt, 12000) : null };
    const original = { available: Boolean(raw.original || raw.originalAvailable), excerpt: raw.original?.excerpt ? clean(raw.original.excerpt, 12000) : null, sha256: raw.original?.sha256 || null };
    const diff = { available: Boolean(raw.diffExcerpt || raw.hasDiff), excerpt: raw.diffExcerpt ? clean(raw.diffExcerpt, 16000) : null };
    const imports = importsByPath.get(filePath) || [];
    const importedBy = [...importsByPath.entries()].filter(([, dependencies]) => dependencies.includes(filePath)).map(([candidatePath]) => candidatePath).slice(0, 40);
    const lineage = [];
    if (raw.kind === '生成产物') {
      for (const evidence of conversationEvidence) lineage.push({ relation: '会话记录生成或变更', evidenceId: evidence.id, stage: evidence.source.stage, description: evidence.description });
      for (const command of commands) lineage.push({ relation: command.verification ? '验证命令' : '相关命令', evidenceId: command.id, stage: command.source.stage, description: command.description });
    }
    const confidence = confidenceFor(raw, conversationEvidence, commands, projectEvidence);
    const evidenceIds = unique([
      ...conversationEvidence.map((item) => item.id),
      ...commands.map((item) => item.id),
      ...(directLinks ? [`project-link-${filePath}`] : []),
      raw.original ? `git-original-${filePath}` : '',
      raw.diffExcerpt ? `git-diff-${filePath}` : '',
      raw.currentExcerpt ? `current-${filePath}` : '',
    ], 120);
    return {
      id: `file-${String(index + 1).padStart(3, '0')}`,
      path: filePath,
      kind: raw.kind || raw.projectRole || '源码、测试或文档实现',
      language: raw.language || null,
      projectRole: raw.projectRole || null,
      changeState: raw.changeState || raw.gitStatus || '未改动',
      observedInConversation: Boolean(raw.observedInConversation || conversationEvidence.length || directLinks),
      gitStatus: raw.gitStatus || null,
      current,
      original,
      diff,
      conversationEvidence: conversationEvidence.map((item) => ({ id: item.id, stage: item.source.stage, stageTitle: item.source.stageTitle, sessionId: item.source.sessionId, sessionTitle: item.source.sessionTitle, authorityRank: item.source.authorityRank, action: item.action, eventIndex: item.eventIndex, tool: item.tool })),
      commands: commands.map((item) => ({ id: item.id, stage: item.source.stage, stageTitle: item.source.stageTitle, command: item.command, verification: item.verification, eventIndex: item.eventIndex })),
      lineage,
      dependencies: { imports, importedBy },
      confidence,
      evidenceIds,
      claims: [
        { type: confidence.level, text: confidence.description, evidenceIds },
        ...(raw.kind === '生成产物' ? [{ type: lineage.length ? '强关联' : '待确认', text: lineage.length ? '会话变更或命令证据可追溯到该生成产物。' : '该生成产物的唯一来源尚未被确定。', evidenceIds: lineage.map((item) => item.evidenceId) }] : []),
      ],
    };
  }).sort((left, right) => Number(right.confidence.score) - Number(left.confidence.score) || left.path.localeCompare(right.path, 'zh-CN'));

  const nodes = [
    ...stages.map((stage) => ({ id: `stage-p${stage.index}`, type: '会话阶段', label: clean(stage.title, 220), stage: stage.index, sourceSessions: stage.sourceSessions || [] })),
    ...fileEvolution.map((file) => ({ id: file.id, type: '项目文件', label: file.path, path: file.path, kind: file.kind, confidence: file.confidence.level })),
    ...ledger.filter((item) => item.kind === '会话命令').map((item) => ({ id: item.id, type: item.verification ? '验证命令' : '命令', label: clean(item.command, 260), stage: item.source.stage })),
  ];
  const edges = [];
  for (const file of fileEvolution) {
    for (const evidence of file.conversationEvidence) edges.push({ from: `stage-p${evidence.stage}`, to: file.id, relation: `会话${evidence.action}`, evidenceId: evidence.id });
    for (const command of file.commands) edges.push({ from: command.id, to: file.id, relation: command.verification ? '验证关联' : '命令关联', evidenceId: command.id });
    for (const dependency of file.dependencies.imports) {
      const target = fileEvolution.find((candidate) => candidate.path === dependency);
      if (target) edges.push({ from: file.id, to: target.id, relation: '相对导入', evidenceId: `current-${file.path}` });
    }
  }

  const conflicts = buildConflictRegister(extraction || {}, fileEvolution);
  const activeReadPlan = buildActiveReadPlan(projectEvidence, fileEvolution, conflicts);
  const purpose = clean((extraction?.requirementEvolution || []).slice(-1)[0]?.request || (extraction?.stages || [])[0]?.request || '未从会话中提取明确项目目标。', 1200);
  return {
    schemaVersion: '1.0.0',
    type: 'evidence-driven-project-understanding',
    generatedAt: new Date().toISOString(),
    project: projectEvidence.project,
    purpose,
    scope: {
      sourceSessions: Number(sourceSet?.sessionCount || 1),
      stages: stages.length,
      files: fileEvolution.length,
      linkedFiles: fileEvolution.filter((item) => item.observedInConversation).length,
      modifiedFiles: fileEvolution.filter((item) => item.diff.available || item.changeState !== '未改动').length,
      generatedFiles: fileEvolution.filter((item) => item.kind === '生成产物').length,
    },
    projectCognition: {
      architecture: projectEvidence.architecture || {},
      git: projectEvidence.git ? { available: Boolean(projectEvidence.git.available), branch: projectEvidence.git.branch || null, diffStat: projectEvidence.git.diffStat || null } : null,
      rules: (projectEvidence.architecture?.instructions || []).map((item) => ({ path: item.path, excerpt: clean(item.excerpt, 3600) })),
      entryPoints: projectEvidence.architecture?.likelyEntryFiles || [],
      currentState: clean(projectEvidence.summary?.summary || `已扫描 ${projectEvidence.scan?.filesScanned || 0} 个项目文件。`, 1600),
    },
    evidenceGraph: {
      nodes,
      edges,
      statistics: { nodes: nodes.length, edges: edges.length, conversationEvidence: ledger.filter((item) => item.kind === '会话文件变更').length, commands: ledger.filter((item) => item.kind === '会话命令').length },
    },
    fileEvolution,
    conflictRegister: conflicts,
    activeReadPlan,
    evidenceLedger: ledger,
  };
}

export function projectUnderstandingMarkdown(understanding) {
  if (!understanding) return '# 项目深度理解\n\n本次没有指定项目文件夹，无法生成项目级证据图。\n';
  const text = (value) => String(value || '—').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const files = understanding.fileEvolution || [];
  const fileRows = files.map((file) => `| \`${text(file.path)}\` | ${text(file.kind)} | ${text(file.changeState)} | ${text(file.confidence.level)} | P${file.conversationEvidence.map((item) => item.stage).filter(Boolean).join('、P') || '—'} | ${file.original.available ? '有' : '无'} | ${file.diff.available ? '有' : '无'} |`).join('\n') || '| — | — | — | — | — | — | — |';
  const lineageRows = files.filter((file) => file.kind === '生成产物').map((file) => `- **\`${file.path}\`**：${file.lineage.length ? file.lineage.map((item) => `${item.relation}（${item.evidenceId}）`).join('；') : '未定位唯一来源，需执行主动读取计划。'}`).join('\n') || '- 未识别生成产物。';
  const conflictRows = (understanding.conflictRegister || []).map((item) => `| ${text(item.severity)} | ${text(item.type)} | ${text(item.conclusion)} | ${text(item.handling)} | ${text(item.status)} |`).join('\n') || '| — | 当前未识别结构化冲突 | — | — | — |';
  const planRows = (understanding.activeReadPlan || []).map((item) => `| ${text(item.priority)} | ${text(item.action)} | ${item.path ? `\`${text(item.path)}\`` : '—'} | ${text(item.reason)} | ${(item.evidenceIds || []).join('、') || '—'} |`).join('\n') || '| — | 当前没有额外读取步骤 | — | — | — |';
  return `# 项目深度理解：${understanding.project?.name || '未命名项目'}\n\n## 当前目标\n\n${understanding.purpose || '未提取。'}\n\n## 取证范围\n\n- 联合会话：${understanding.scope?.sourceSessions || 0} 条\n- 语义阶段：${understanding.scope?.stages || 0} 个\n- 文件节点：${understanding.scope?.files || 0} 个\n- 证据图：${understanding.evidenceGraph?.statistics?.nodes || 0} 个节点、${understanding.evidenceGraph?.statistics?.edges || 0} 条关系\n\n## 项目判断\n\n${understanding.projectCognition?.currentState || '未提取。'}\n\n入口候选：${(understanding.projectCognition?.entryPoints || []).map((item) => `\`${item}\``).join('、') || '未识别'}。\n\n## 文件演化与证据\n\n| 文件 | 角色 | 当前状态 | 证据级别 | 会话阶段 | Git 原始 | Git 差异 |\n| --- | --- | --- | --- | --- | --- |\n${fileRows}\n\n## 生成产物链路\n\n${lineageRows}\n\n## 冲突与待确认项\n\n| 严重度 | 类型 | 结论 | 处理方式 | 状态 |\n| --- | --- | --- | --- | --- |\n${conflictRows}\n\n## 主动读取与验证计划\n\n这是一份下次执行任务时按优先级推进的计划，不把尚未执行的操作描述成已完成。\n\n| 优先级 | 操作 | 文件 | 原因 | 证据编号 |\n| --- | --- | --- | --- | --- |\n${planRows}\n\n## 关系图说明\n\n每条关系均回指到会话阶段、文件变更、命令或 Git/当前文件证据。会话阶段节点以 \`stage-pN\` 标识，文件节点以 \`file-NNN\` 标识，命令与文件变更证据以 \`command-NNNN\`、\`file-NNNN\` 标识。\n`;
}
