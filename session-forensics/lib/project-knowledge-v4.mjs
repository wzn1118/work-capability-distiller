import crypto from 'node:crypto';
import path from 'node:path';

function decodeUnicodeEscapes(value) {
  return String(value ?? '').replace(/\\u([0-9a-f]{4})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function clean(value, maximum = 8000) {
  const result = decodeUnicodeEscapes(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return result.length <= maximum ? result : `${result.slice(0, maximum)}…`;
}

function unique(values, maximum = 10000) {
  return [...new Set((values || []).map((item) => clean(item, 20000)).filter(Boolean))].slice(0, maximum);
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

function normalizePath(value) {
  return decodeUnicodeEscapes(value).replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function semanticText(value) {
  return clean(value, 12000)
    .replace(/^P\d+\s*[|｜:：.、-]?\s*/iu, '')
    .replace(/(?:请|需要|希望|现在|进行|必须|可以|一个|这个|那个|相关|对应|完整|全面|全量|进一步|继续|当前|用户|内容)/gu, ' ')
    .replace(/[^\p{L}\p{N}._/\\-]+/gu, ' ')
    .toLocaleLowerCase('zh-CN');
}

function semanticTokens(value) {
  const normalized = semanticText(value);
  const tokens = new Set(normalized.split(/\s+/).filter((item) => item.length >= 2));
  const chinese = normalized.replace(/[^\p{Script=Han}]/gu, '');
  for (let index = 0; index < Math.min(chinese.length - 1, 2400); index += 1) tokens.add(chinese.slice(index, index + 2));
  return tokens;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function setFor(values) {
  return new Set(unique(values || []).map((item) => String(item).toLocaleLowerCase('zh-CN')));
}

function stageSimilarity(left, right) {
  const request = jaccard(semanticTokens(left.request), semanticTokens(right.request));
  const title = jaccard(semanticTokens(left.title), semanticTokens(right.title));
  const files = jaccard(setFor((left.fileChanges || []).map((item) => normalizePath(item.path))), setFor((right.fileChanges || []).map((item) => normalizePath(item.path))));
  const tools = jaccard(setFor((left.toolCalls || []).map((item) => item.name)), setFor((right.toolCalls || []).map((item) => item.name)));
  const typeBonus = left.classification?.type && left.classification.type === right.classification?.type ? 0.06 : 0;
  const score = Math.min(1, request * 0.58 + title * 0.22 + files * 0.12 + tools * 0.08 + typeBonus);
  return { score, request, title, files, tools };
}

function shouldMergeStage(candidate, canonical) {
  const similarity = stageSimilarity(candidate, canonical);
  return {
    merge: similarity.score >= 0.48
      || similarity.request >= 0.62
      || (similarity.request >= 0.34 && similarity.files >= 0.5)
      || (similarity.title >= 0.72 && similarity.request >= 0.28),
    similarity,
  };
}

function stageSubject(stage) {
  const title = clean(stage.title, 180).replace(/^P\d+\s*[|｜:：.、-]?\s*/iu, '');
  if (title && !/^(?:需求|阶段|任务)\s*\d*$/u.test(title)) return title;
  return clean(stage.request, 180).split(/[。！？!？\n]/u)[0] || '未命名能力阶段';
}

function sourceSessionMeta(sourceSet, sessionId) {
  const item = (sourceSet?.sessions || []).find((session) => session.sessionId === sessionId);
  return item ? {
    sessionId: item.sessionId,
    title: item.title,
    authorityRank: item.authorityRank ?? null,
    lastUserRequestAt: item.lastUserRequestAt || null,
  } : { sessionId, title: sessionId || '未标识会话', authorityRank: null, lastUserRequestAt: null };
}

function buildSemanticStages(extraction, sourceSet) {
  const groups = [];
  for (const stage of extraction?.stages || []) {
    let best = null;
    for (const group of groups) {
      const decision = shouldMergeStage(stage, group.canonicalStage);
      if (decision.merge && (!best || decision.similarity.score > best.similarity.score)) best = { group, ...decision };
    }
    const occurrence = {
      stageIndex: stage.index,
      originalStageIndexes: stage.originalStageIndexes || [stage.index],
      title: stage.title,
      request: stage.request,
      type: stage.classification?.type || 'requirement',
      priority: stage.classification?.priority || 0,
      timestamp: stage.timestamp || null,
      sourceAuthorityRank: stage.sourceAuthorityRank ?? null,
      sessions: (stage.sourceSessions || []).map((sessionId) => sourceSessionMeta(sourceSet, sessionId)),
      eventRange: stage.eventRange || null,
      tools: unique((stage.toolCalls || []).map((item) => item.name), 200),
      files: unique((stage.fileChanges || []).map((item) => normalizePath(item.path)), 500),
      outcome: stage.outcome || null,
    };
    if (best) {
      best.group.occurrences.push({ ...occurrence, match: best.similarity });
      best.group.sourceStageIndexes.push(stage.index);
      if ((Number(stage.sourceAuthorityRank) || 9999) < (Number(best.group.canonicalStage.sourceAuthorityRank) || 9999)) best.group.canonicalStage = stage;
    } else {
      groups.push({ canonicalStage: stage, occurrences: [occurrence], sourceStageIndexes: [stage.index] });
    }
  }
  return groups.map((group, index) => {
    const canonical = group.canonicalStage;
    const sessions = new Map();
    for (const occurrence of group.occurrences) for (const session of occurrence.sessions) sessions.set(session.sessionId, session);
    const files = unique(group.occurrences.flatMap((item) => item.files), 800);
    const tools = unique(group.occurrences.flatMap((item) => item.tools), 300);
    return {
      id: `semantic-stage-${String(index + 1).padStart(3, '0')}`,
      phase: `P${index + 1}`,
      title: `P${index + 1}｜${stageSubject(canonical)}`,
      purpose: clean(canonical.request, 1600),
      type: canonical.classification?.type || 'requirement',
      priority: Math.max(...group.occurrences.map((item) => Number(item.priority) || 0), 0),
      authority: {
        rule: '优先采用来源权威级别更高、时间更晚且包含明确纠正的表述。',
        canonicalSourceRank: canonical.sourceAuthorityRank ?? null,
      },
      sourceStageIndexes: unique(group.sourceStageIndexes, 500).map(Number),
      sessions: [...sessions.values()].sort((left, right) => (Number(left.authorityRank) || 9999) - (Number(right.authorityRank) || 9999)),
      files,
      tools,
      occurrences: group.occurrences,
      evidenceIds: [],
      outcome: {
        toolCalls: group.occurrences.reduce((sum, item) => sum + Number(item.outcome?.toolCallCount || 0), 0),
        succeeded: group.occurrences.reduce((sum, item) => sum + Number(item.outcome?.succeeded || 0), 0),
        failed: group.occurrences.reduce((sum, item) => sum + Number(item.outcome?.failed || 0), 0),
        changedFiles: files.length,
      },
    };
  });
}

function evidenceEntry(id, type, title, content, source = {}, extra = {}) {
  return { id, type, kind: type, title: clean(title, 260), content: clean(content, 24000), source, ...extra };
}

function buildEvidenceLedger(extraction, sourceSet, projectEvidence, semanticStages) {
  const ledger = [];
  for (const session of sourceSet?.sessions || []) {
    ledger.push(evidenceEntry(`session-${ledger.length + 1}`, '来源会话', session.title, session.latestUserRequest || '', {
      sessionId: session.sessionId, sourcePath: session.sourcePath, sha256: session.sha256, authorityRank: session.authorityRank,
    }, { metrics: { records: session.recordCount, events: session.normalisedEventCount, messages: session.messages, toolCalls: session.toolCalls, fileChanges: session.fileChanges } }));
  }
  const semanticByStage = new Map(semanticStages.flatMap((group) => group.sourceStageIndexes.map((index) => [Number(index), group])));
  for (const stage of extraction?.stages || []) {
    const group = semanticByStage.get(Number(stage.index));
    const source = { semanticStageId: group?.id || null, sourceStage: stage.index, sessions: stage.sourceSessions || [], eventRange: stage.eventRange || null };
    const requestId = `request-${String(ledger.length + 1).padStart(6, '0')}`;
    ledger.push(evidenceEntry(requestId, '用户要求', stage.title, stage.request, source, { timestamp: stage.timestamp || null, authorityRank: stage.sourceAuthorityRank ?? null }));
    if (group) group.evidenceIds.push(requestId);
    for (const message of stage.messages || []) {
      const id = `message-${String(ledger.length + 1).padStart(6, '0')}`;
      ledger.push(evidenceEntry(id, message.actor === 'user' ? '用户消息' : '助手消息', `${stage.title} · ${message.actor}`, message.text, { ...source, eventIndex: message.eventIndex, sessionId: message.sourceSessionId || null }, { timestamp: message.timestamp || null }));
      if (group) group.evidenceIds.push(id);
    }
    for (const tool of stage.toolCalls || []) {
      const id = `tool-${String(ledger.length + 1).padStart(6, '0')}`;
      ledger.push(evidenceEntry(id, '工具调用', tool.name, `${tool.arguments || ''}\n${tool.result?.excerpt || ''}`, { ...source, eventIndex: tool.eventIndex, sessionId: tool.sourceSessionId || null }, { tool: tool.name, callId: tool.callId || null, success: tool.result?.success ?? null }));
      if (group) group.evidenceIds.push(id);
    }
    for (const command of stage.commands || []) {
      const id = `command-${String(ledger.length + 1).padStart(6, '0')}`;
      ledger.push(evidenceEntry(id, '本地命令', command.tool || '命令', command.command, { ...source, eventIndex: command.eventIndex, sessionId: command.sourceSessionId || null }, { verification: /\b(test|check|lint|build|verify|pytest|vitest|jest)\b/iu.test(command.command || '') }));
      if (group) group.evidenceIds.push(id);
    }
    for (const file of stage.fileChanges || []) {
      const id = `file-operation-${String(ledger.length + 1).padStart(6, '0')}`;
      ledger.push(evidenceEntry(id, '会话文件操作', normalizePath(file.path), file.action || '会话关联', { ...source, eventIndex: file.eventIndex, sessionId: file.sourceSessionId || null }, { path: normalizePath(file.path), action: file.action || null, tool: file.tool || null }));
      if (group) group.evidenceIds.push(id);
    }
  }
  const modifiedByPath = new Map((projectEvidence?.modifiedFiles || []).map((item) => [normalizePath(item.path).toLocaleLowerCase('zh-CN'), item]));
  for (const file of projectEvidence?.files || []) {
    const filePath = normalizePath(file.path);
    const modified = modifiedByPath.get(filePath.toLocaleLowerCase('zh-CN')) || file;
    const common = { projectRoot: projectEvidence.project?.root || null, path: filePath };
    if (file.currentExcerpt) ledger.push(evidenceEntry(`current-${String(ledger.length + 1).padStart(6, '0')}`, '当前文件内容', filePath, file.currentExcerpt, common, { sha256: file.contentSha256 || hash(file.currentExcerpt), completeness: file.contentStatus || '展示摘录', bytes: file.bytes ?? null, modifiedAt: file.modifiedAt || null }));
    else ledger.push(evidenceEntry(`metadata-${String(ledger.length + 1).padStart(6, '0')}`, '文件元数据', filePath, file.kind || file.language || '已发现文件', common, { sha256: file.contentSha256 || null, completeness: file.contentStatus || '仅元数据', bytes: file.bytes ?? null, modifiedAt: file.modifiedAt || null }));
    if (modified.original?.available) ledger.push(evidenceEntry(`baseline-${String(ledger.length + 1).padStart(6, '0')}`, 'Git 原始版本', filePath, modified.original.excerpt || `${modified.original.contentStatus || '仅 Git 对象元数据'}；Git 对象 ${modified.original.gitObjectId || '未知'}`, common, { sha256: modified.original.sha256 || null, gitObjectId: modified.original.gitObjectId || null, bytes: modified.original.bytes ?? null, completeness: modified.original.contentStatus || null, revision: modified.original.revision || 'HEAD' }));
    if (modified.diffExcerpt) ledger.push(evidenceEntry(`diff-${String(ledger.length + 1).padStart(6, '0')}`, 'Git 差异', filePath, modified.diffExcerpt, common, { sha256: modified.diffSha256 || hash(modified.diffExcerpt), completeness: '差异摘录' }));
  }
  semanticStages.forEach((stage) => { stage.evidenceIds = unique(stage.evidenceIds, 5000); });
  return ledger;
}

function topLevelModule(filePath) {
  const normalized = normalizePath(filePath);
  const parts = normalized.split('/');
  return parts.length > 1 ? parts[0] : '项目根目录';
}

function buildProjectModel(projectEvidence, understanding, semanticStages, sourceSet) {
  if (!projectEvidence) return null;
  const modules = new Map();
  for (const file of projectEvidence.files || []) {
    const name = topLevelModule(file.path);
    const module = modules.get(name) || { id: `module-${modules.size + 1}`, name, fileCount: 0, modifiedFiles: 0, generatedFiles: 0, languages: new Set(), roles: new Set(), examples: [] };
    module.fileCount += 1;
    if (file.gitStatus || file.diffExcerpt) module.modifiedFiles += 1;
    if (file.kind === '生成产物') module.generatedFiles += 1;
    if (file.language) module.languages.add(file.language);
    if (file.projectRole) module.roles.add(file.projectRole);
    if (module.examples.length < 12) module.examples.push(normalizePath(file.path));
    modules.set(name, module);
  }
  const commands = unique((semanticStages || []).flatMap((stage) => stage.occurrences.flatMap((occurrence) => occurrence.tools)), 300);
  return {
    schemaVersion: '4.0.0',
    project: projectEvidence.project,
    purpose: understanding?.purpose || `理解并维护项目 ${projectEvidence.project?.name || ''}`,
    currentState: understanding?.projectCognition?.currentState || null,
    sourceSessions: sourceSet?.sessions || [],
    entryPoints: projectEvidence.architecture?.likelyEntryFiles || [],
    manifests: projectEvidence.architecture?.manifests || [],
    rules: projectEvidence.architecture?.rules || [],
    modules: [...modules.values()].map((item) => ({ ...item, languages: [...item.languages], roles: [...item.roles] })),
    capabilities: semanticStages.map((stage) => ({ id: stage.id, phase: stage.phase, name: stage.title.replace(/^P\d+｜/u, ''), purpose: stage.purpose, tools: stage.tools, files: stage.files, evidenceIds: stage.evidenceIds })),
    observedToolFamilies: commands,
    git: projectEvidence.git || null,
    evidenceBoundary: '项目模型只陈述当前文件扫描、Git 证据和所选会话能够直接支持的内容。',
  };
}

function evidenceIdsForPath(ledger, filePath) {
  const normalized = normalizePath(filePath).toLocaleLowerCase('zh-CN');
  return ledger.filter((item) => normalizePath(item.source?.path || item.path).toLocaleLowerCase('zh-CN') === normalized).map((item) => item.id);
}

function buildFileVersions(projectEvidence, understanding, ledger) {
  if (!projectEvidence) return [];
  const evolutionByPath = new Map((understanding?.fileEvolution || []).map((item) => [normalizePath(item.path).toLocaleLowerCase('zh-CN'), item]));
  const modifiedByPath = new Map((projectEvidence.modifiedFiles || []).map((item) => [normalizePath(item.path).toLocaleLowerCase('zh-CN'), item]));
  const versions = [];
  for (const file of projectEvidence.files || []) {
    const filePath = normalizePath(file.path);
    const modified = modifiedByPath.get(filePath.toLocaleLowerCase('zh-CN')) || file;
    const evolution = evolutionByPath.get(filePath.toLocaleLowerCase('zh-CN'));
    let parentVersionId = null;
    if (modified.original?.available) {
      const versionId = `version-${hash(`${filePath}\nHEAD\n${modified.original.sha256 || modified.original.excerpt}`).slice(0, 16)}`;
      versions.push({ versionId, path: filePath, order: 1, kind: 'Git 原始版本', revision: modified.original.revision || 'HEAD', parentVersionId: null, contentAvailable: Boolean(modified.original.excerpt), fingerprintAvailable: Boolean(modified.original.sha256 || modified.original.gitObjectId), sha256: modified.original.sha256 || null, gitObjectId: modified.original.gitObjectId || null, bytes: modified.original.bytes ?? null, contentStatus: modified.original.contentStatus || null, excerpt: modified.original.excerpt ? clean(modified.original.excerpt, 16000) : null, evidenceIds: evidenceIdsForPath(ledger, filePath).filter((id) => id.startsWith('baseline-')) });
      parentVersionId = versionId;
    }
    let order = parentVersionId ? 2 : 1;
    for (const operation of evolution?.conversationEvidence || []) {
      const versionId = `version-${hash(`${filePath}\nconversation\n${operation.sessionId}\n${operation.stage}\n${operation.eventIndex}`).slice(0, 16)}`;
      versions.push({ versionId, path: filePath, order: order++, kind: '会话记录的文件操作', revision: `会话 ${operation.sessionTitle || operation.sessionId || ''} / P${operation.stage || '?'}`, parentVersionId, contentAvailable: false, sha256: null, excerpt: null, action: operation.action || null, evidenceIds: unique([operation.id, ...(evolution?.evidenceIds || [])], 200) });
      parentVersionId = versionId;
    }
    const currentText = file.currentExcerpt || '';
    const currentSha = file.contentSha256 || (currentText ? hash(currentText) : null);
    const versionId = `version-${hash(`${filePath}\ncurrent\n${currentSha || currentText}\n${file.gitStatus || ''}`).slice(0, 16)}`;
    versions.push({ versionId, path: filePath, order, kind: '当前工作区版本', revision: 'WORKTREE', parentVersionId, contentAvailable: Boolean(currentText), fingerprintAvailable: Boolean(currentSha), sha256: currentSha, bytes: file.bytes ?? null, modifiedAt: file.modifiedAt || null, contentStatus: file.contentStatus || (currentText ? '展示摘录可用' : '仅元数据'), excerpt: currentText ? clean(currentText, 16000) : null, changeState: file.changeState || file.status || null, gitStatus: file.gitStatus || null, evidenceIds: evidenceIdsForPath(ledger, filePath).filter((id) => id.startsWith('current-') || id.startsWith('metadata-') || id.startsWith('diff-')) });
  }
  return versions;
}

function buildArtifactLineage(projectEvidence, understanding, extraction, ledger) {
  if (!projectEvidence) return [];
  const evolutionByPath = new Map((understanding?.fileEvolution || []).map((item) => [normalizePath(item.path).toLocaleLowerCase('zh-CN'), item]));
  const projectPaths = (projectEvidence.files || []).map((item) => normalizePath(item.path)).filter(Boolean);
  const commands = (extraction?.stages || []).flatMap((stage) => (stage.commands || []).map((command) => ({ ...command, stage: stage.index, stageTitle: stage.title, sessions: stage.sourceSessions || [] })));
  return (projectEvidence.generatedFiles || []).map((file, index) => {
    const filePath = normalizePath(file.path);
    const base = path.posix.basename(filePath).toLocaleLowerCase('zh-CN');
    const evolution = evolutionByPath.get(filePath.toLocaleLowerCase('zh-CN'));
    const matchingCommands = commands.filter((item) => {
      const command = String(item.command || '').replace(/\\/g, '/').toLocaleLowerCase('zh-CN');
      return command.includes(filePath.toLocaleLowerCase('zh-CN')) || command.includes(base) || (/\b(build|generate|render|export|report|write)\b/iu.test(command) && (evolution?.conversationEvidence || []).some((evidence) => evidence.stage === item.stage));
    }).slice(0, 40);
    const explicitLineage = evolution?.lineage || [];
    const commandInputs = matchingCommands.flatMap((item) => {
      const command = String(item.command || '').replace(/\\/g, '/').toLocaleLowerCase('zh-CN');
      return projectPaths.filter((candidate) => {
        const normalized = candidate.toLocaleLowerCase('zh-CN');
        return normalized !== filePath.toLocaleLowerCase('zh-CN')
          && (command.includes(normalized) || command.includes(path.posix.basename(normalized)));
      });
    });
    const inputs = unique([
      ...explicitLineage.flatMap((item) => [item.sourcePath, item.input, item.from]).filter(Boolean),
      ...(evolution?.dependencies?.imports || []),
      ...(evolution?.conversationEvidence || []).flatMap((item) => item.path ? [item.path] : []),
      ...commandInputs,
    ].map(normalizePath).filter((item) => item && item.toLocaleLowerCase('zh-CN') !== filePath.toLocaleLowerCase('zh-CN')), 120);
    const confidence = matchingCommands.some((item) => String(item.command || '').replace(/\\/g, '/').toLocaleLowerCase('zh-CN').includes(filePath.toLocaleLowerCase('zh-CN'))) ? '确定'
      : matchingCommands.length || explicitLineage.length ? '强关联' : '待确认';
    const explicitCommands = matchingCommands.filter((item) => String(item.command || '').replace(/\\/g, '/').toLocaleLowerCase('zh-CN').includes(filePath.toLocaleLowerCase('zh-CN')) || String(item.command || '').toLocaleLowerCase('zh-CN').includes(base));
    const verificationCommands = matchingCommands.filter((item) => /\b(test|check|lint|verify|validate|pytest|vitest|jest|node\s+--check)\b/iu.test(item.command || ''));
    const reproductionStatus = explicitCommands.length ? (inputs.length ? '具备候选复现配方' : '已定位生成命令，输入仍待确认') : matchingCommands.length ? '只有候选命令' : '缺少生成命令';
    return {
      id: `artifact-${String(index + 1).padStart(4, '0')}`,
      path: filePath,
      kind: file.kind || '生成产物',
      role: file.projectRole || null,
      inputs,
      commands: matchingCommands.map((item) => ({ stage: item.stage, stageTitle: item.stageTitle, command: clean(item.command, 6000), sessions: item.sessions })),
      conversationEvidence: evolution?.conversationEvidence || [],
      confidence,
      conclusion: confidence === '待确认' ? '确认这是生成产物，但现有证据不足以唯一定位生成命令。' : '生成产物与会话阶段、命令或依赖证据存在可追溯关联。',
      currentSnapshot: { bytes: file.bytes ?? null, modifiedAt: file.modifiedAt || null, sha256: file.contentSha256 || null, contentStatus: file.contentStatus || null },
      reproducibility: {
        status: reproductionStatus,
        readyToReplay: explicitCommands.length > 0 && inputs.length > 0,
        generationCommandCount: explicitCommands.length,
        verificationCommandCount: verificationCommands.length,
        executedDuringDistillation: false,
        boundary: '蒸馏阶段只提取并核对复现证据，不会擅自重跑可能覆盖产物的生成命令。',
      },
      evidenceIds: unique([...(evolution?.evidenceIds || []), ...evidenceIdsForPath(ledger, filePath)], 500),
    };
  });
}

function buildCrossSessionTimeline(extraction, sourceSet, semanticStages) {
  const stageMap = new Map(semanticStages.flatMap((stage) => stage.sourceStageIndexes.map((index) => [Number(index), stage])));
  const sessions = new Map((sourceSet?.sessions || []).map((item) => [item.sessionId, item]));
  const events = [];
  const add = (event) => events.push({ id: `timeline-${String(events.length + 1).padStart(6, '0')}`, ...event });
  for (const stage of extraction?.stages || []) {
    const semantic = stageMap.get(Number(stage.index));
    const defaultSession = (stage.sourceSessions || [])[0] || null;
    add({
      type: '需求阶段', timestamp: stage.timestamp || null, sessionId: defaultSession,
      sessionTitle: sessions.get(defaultSession)?.title || (stage.sourceTitles || [])[0] || defaultSession,
      authorityRank: stage.sourceAuthorityRank ?? sessions.get(defaultSession)?.authorityRank ?? null,
      sourceStage: stage.index, semanticStageId: semantic?.id || null, title: stage.title,
      content: clean(stage.request, 4000), eventIndex: stage.eventRange?.start ?? null,
    });
    for (const file of stage.fileChanges || []) {
      const sessionId = file.sourceSessionId || defaultSession;
      add({ type: '文件操作', timestamp: file.timestamp || stage.timestamp || null, sessionId, sessionTitle: file.sourceTitle || sessions.get(sessionId)?.title || sessionId, authorityRank: sessions.get(sessionId)?.authorityRank ?? stage.sourceAuthorityRank ?? null, sourceStage: stage.index, semanticStageId: semantic?.id || null, title: normalizePath(file.path), content: clean(file.action || '会话关联', 400), path: normalizePath(file.path), eventIndex: file.eventIndex ?? null });
    }
    for (const command of stage.commands || []) {
      const sessionId = command.sourceSessionId || defaultSession;
      add({ type: '命令', timestamp: command.timestamp || stage.timestamp || null, sessionId, sessionTitle: command.sourceTitle || sessions.get(sessionId)?.title || sessionId, authorityRank: sessions.get(sessionId)?.authorityRank ?? stage.sourceAuthorityRank ?? null, sourceStage: stage.index, semanticStageId: semantic?.id || null, title: command.tool || '本地命令', content: clean(command.command, 6000), eventIndex: command.eventIndex ?? null });
    }
  }
  return events.sort((left, right) => {
    const leftTime = Date.parse(left.timestamp || '') || 0;
    const rightTime = Date.parse(right.timestamp || '') || 0;
    return leftTime - rightTime || Number(left.eventIndex ?? Number.MAX_SAFE_INTEGER) - Number(right.eventIndex ?? Number.MAX_SAFE_INTEGER) || Number(right.authorityRank || 9999) - Number(left.authorityRank || 9999);
  }).map((item, index) => ({ ...item, order: index + 1 }));
}

function buildFileChangeMatrix(projectEvidence, understanding, semanticStages, ledger) {
  if (!projectEvidence) return [];
  const semanticMap = new Map(semanticStages.flatMap((stage) => stage.sourceStageIndexes.map((index) => [Number(index), stage])));
  return (understanding?.fileEvolution || []).filter((file) => file.observedInConversation || file.diff?.available || file.gitStatus || file.kind === '生成产物').map((file, index) => {
    const operations = (file.conversationEvidence || []).map((operation) => ({
      ...operation,
      semanticStageId: semanticMap.get(Number(operation.stage))?.id || null,
      semanticStageTitle: semanticMap.get(Number(operation.stage))?.title || operation.stageTitle || null,
    })).sort((left, right) => Number(left.authorityRank || 9999) - Number(right.authorityRank || 9999) || Number(left.eventIndex || 0) - Number(right.eventIndex || 0));
    const currentSource = (projectEvidence.files || []).find((item) => normalizePath(item.path) === normalizePath(file.path));
    const modifiedSource = (projectEvidence.modifiedFiles || []).find((item) => normalizePath(item.path) === normalizePath(file.path));
    const hasConversation = operations.length > 0;
    const hasDiff = Boolean(file.diff?.available);
    const assessment = hasConversation && hasDiff ? '会话文件操作与 Git 差异相互印证'
      : hasConversation ? '会话记录了文件操作，但当前没有可读取的 Git 差异；可能已提交、回退或不在 Git 中'
        : hasDiff ? 'Git 存在实际差异，但所选会话没有记录对应文件操作'
          : '文件被会话或 Git 状态关联，尚无可核对差异';
    return {
      id: `change-${String(index + 1).padStart(5, '0')}`,
      path: normalizePath(file.path),
      kind: file.kind,
      projectRole: file.projectRole,
      sessions: unique(operations.map((item) => item.sessionId), 100),
      semanticStages: unique(operations.map((item) => item.semanticStageId), 100),
      operations,
      baseline: { available: Boolean(file.original?.available), revision: modifiedSource?.original?.revision || null, sha256: modifiedSource?.original?.sha256 || file.original?.sha256 || null, gitObjectId: modifiedSource?.original?.gitObjectId || null, contentStatus: modifiedSource?.original?.contentStatus || null },
      current: { available: Boolean(currentSource), sha256: currentSource?.contentSha256 || null, bytes: currentSource?.bytes ?? null, modifiedAt: currentSource?.modifiedAt || null, contentStatus: currentSource?.contentStatus || null },
      diff: { available: hasDiff, sha256: modifiedSource?.diffSha256 || null },
      assessment,
      evidenceIds: unique([...(file.evidenceIds || []), ...evidenceIdsForPath(ledger, file.path)], 500),
    };
  });
}

function buildDependencyImpact(projectEvidence, understanding, fileChangeMatrix) {
  if (!projectEvidence || !understanding) return { nodes: [], edges: [], changedFiles: [], unresolvedReferences: [], statistics: { nodes: 0, edges: 0, changedFiles: 0 } };
  const files = understanding.fileEvolution || [];
  const known = new Set(files.map((item) => normalizePath(item.path)));
  const edges = [];
  for (const file of files) for (const dependency of file.dependencies?.imports || []) {
    const target = normalizePath(dependency);
    if (known.has(target)) edges.push({ from: normalizePath(file.path), to: target, relation: '导入或引用', evidenceIds: unique(file.evidenceIds || [], 120) });
  }
  const reverse = new Map();
  for (const edge of edges) reverse.set(edge.to, [...(reverse.get(edge.to) || []), edge.from]);
  const changedFiles = fileChangeMatrix.map((change) => {
    const impacted = new Set();
    const queue = [...(reverse.get(change.path) || [])].map((path) => ({ path, depth: 1 }));
    while (queue.length && impacted.size < 500) {
      const current = queue.shift();
      if (impacted.has(current.path) || current.path === change.path) continue;
      impacted.add(current.path);
      if (current.depth < 8) for (const dependent of reverse.get(current.path) || []) queue.push({ path: dependent, depth: current.depth + 1 });
    }
    return { path: change.path, directDependents: unique(reverse.get(change.path) || [], 200), transitiveDependents: [...impacted], impactLevel: impacted.size >= 10 ? '高' : impacted.size ? '中' : '局部', evidenceIds: change.evidenceIds };
  });
  return {
    schemaVersion: '1.0.0',
    nodes: files.map((file) => ({ id: normalizePath(file.path), kind: file.kind, role: file.projectRole, changed: fileChangeMatrix.some((item) => item.path === normalizePath(file.path)) })),
    edges,
    changedFiles,
    unresolvedReferences: [],
    statistics: { nodes: files.length, edges: edges.length, changedFiles: changedFiles.length, highImpactChanges: changedFiles.filter((item) => item.impactLevel === '高').length },
    boundary: '依赖影响基于本次实际读取到的相对导入和引用；动态加载、运行时注入与未读文件不会被伪装成已解析。',
  };
}

function buildProjectSnapshot(projectEvidence, sourceSet, semanticStages) {
  const files = (projectEvidence?.files || []).map((file) => ({ path: normalizePath(file.path), bytes: file.bytes ?? null, modifiedAt: file.modifiedAt || null, sha256: file.contentSha256 || null, hashStatus: file.hashStatus || null, contentStatus: file.contentStatus || null })).sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
  const sourceSessions = (sourceSet?.sessions || []).map((session) => ({ sessionId: session.sessionId, title: session.title, sha256: session.sha256 || null, records: session.recordCount || null }));
  const fingerprintMaterial = [...files.map((file) => `${file.path}\t${file.bytes ?? ''}\t${file.modifiedAt || ''}\t${file.sha256 || ''}`), ...sourceSessions.map((session) => `${session.sessionId}\t${session.sha256 || ''}`)].join('\n');
  return {
    schemaVersion: '1.0.0',
    capturedAt: new Date().toISOString(),
    project: projectEvidence?.project || null,
    git: projectEvidence?.git ? { available: Boolean(projectEvidence.git.available), branch: projectEvidence.git.branch || null, headRevision: projectEvidence.git.headRevision || null, status: projectEvidence.git.status || [] } : null,
    sourceSessions,
    semanticStageIds: semanticStages.map((stage) => stage.id),
    files,
    fingerprint: hash(fingerprintMaterial),
    coverage: { files: files.length, fullContentFingerprints: files.filter((file) => Boolean(file.sha256)).length, textRead: files.filter((file) => String(file.contentStatus || '').startsWith('全文')).length, metadataOnly: files.filter((file) => file.contentStatus === '仅记录元数据').length },
    use: '后续重扫时按路径、内容指纹、修改时间、Git 提交和来源会话哈希计算增量变化。',
  };
}

export function compareProjectSnapshots(previous, current) {
  const previousFiles = new Map((previous?.files || []).map((file) => [normalizePath(file.path), file]));
  const currentFiles = new Map((current?.files || []).map((file) => [normalizePath(file.path), file]));
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  for (const [filePath, file] of currentFiles) {
    const before = previousFiles.get(filePath);
    if (!before) added.push(filePath);
    else if ((before.sha256 && file.sha256 && before.sha256 !== file.sha256) || before.bytes !== file.bytes || before.modifiedAt !== file.modifiedAt) changed.push({ path: filePath, before: { sha256: before.sha256 || null, bytes: before.bytes ?? null, modifiedAt: before.modifiedAt || null }, after: { sha256: file.sha256 || null, bytes: file.bytes ?? null, modifiedAt: file.modifiedAt || null } });
    else unchanged.push(filePath);
  }
  for (const filePath of previousFiles.keys()) if (!currentFiles.has(filePath)) removed.push(filePath);
  return { previousFingerprint: previous?.fingerprint || null, currentFingerprint: current?.fingerprint || null, changed: previous?.fingerprint !== current?.fingerprint, added, removed, modified: changed, unchangedCount: unchanged.length };
}

function buildDecisions(extraction, semanticStages, understanding) {
  const semanticBySource = new Map(semanticStages.flatMap((stage) => stage.sourceStageIndexes.map((index) => [Number(index), stage])));
  const decisions = [];
  for (const correction of extraction?.corrections || []) {
    const current = semanticBySource.get(Number(correction.stage));
    const candidates = semanticStages.filter((stage) => stage.id !== current?.id && Math.min(...stage.sourceStageIndexes) < Number(correction.stage));
    const overlaps = candidates.map((stage) => ({ stage, similarity: stageSimilarity({ title: correction.title, request: correction.request, fileChanges: (current?.files || []).map((path) => ({ path })), toolCalls: (current?.tools || []).map((name) => ({ name })) }, { title: stage.title, request: stage.purpose, fileChanges: stage.files.map((path) => ({ path })), toolCalls: stage.tools.map((name) => ({ name })) }) })).filter((item) => item.similarity.score >= 0.28 || item.similarity.files >= 0.5).sort((left, right) => right.similarity.score - left.similarity.score);
    decisions.push({
      id: `decision-${String(decisions.length + 1).padStart(3, '0')}`,
      type: overlaps.length ? '后续纠正覆盖早期方案' : '后续约束或升级',
      severity: '高',
      decision: clean(correction.request, 1600),
      sourceStage: correction.stage,
      semanticStageId: current?.id || null,
      supersedes: overlaps.slice(0, 12).map((item) => ({ semanticStageId: item.stage.id, title: item.stage.title, similarity: item.similarity.score })),
      handling: overlaps.length ? '执行、生成和验收均采用该后续纠正；被覆盖阶段只保留为历史证据。' : '把该要求作为独立的新约束应用，不虚构它覆盖了无关阶段。',
      status: '已解析，执行时强制应用',
      evidenceIds: current?.evidenceIds || [],
    });
  }
  for (const conflict of understanding?.conflictRegister || []) {
    if (conflict.type === '需求覆盖') continue;
    decisions.push({ id: `decision-${String(decisions.length + 1).padStart(3, '0')}`, type: conflict.type || '证据缺口', severity: conflict.severity || '中', decision: conflict.conclusion, sourceStage: null, semanticStageId: null, supersedes: [], handling: conflict.handling, status: conflict.status || '待核对', evidenceIds: Array.isArray(conflict.evidence) ? conflict.evidence : [] });
  }
  return decisions;
}

function buildCoverage(sourceSet, extraction, projectEvidence, ledger, semanticStages, fileVersions, artifactLineage) {
  const scan = projectEvidence?.scan || {};
  const selected = Number(scan.filesScanned || projectEvidence?.files?.length || 0);
  const discovered = Math.max(selected, Number(scan.discoveredFiles || scan.candidateFiles || selected));
  return {
    schemaVersion: '4.0.0',
    sessions: { selected: Number(sourceSet?.sessionCount || 0), parsed: (sourceSet?.sessions || []).length, records: Number(sourceSet?.recordCount || 0), events: Number(sourceSet?.normalisedEventCount || 0), completeSelection: true },
    semantics: { extractedStages: Number(extraction?.stages?.length || 0), consolidatedStages: semanticStages.length, correctionCount: Number(extraction?.corrections?.length || 0), sourceTraceRetained: semanticStages.every((item) => item.occurrences.length > 0 && item.evidenceIds.length > 0) },
    project: projectEvidence ? { available: true, root: projectEvidence.project?.root || null, discoveredFiles: discovered, scannedFiles: selected, textFilesRead: (projectEvidence.files || []).filter((item) => Boolean(item.currentExcerpt)).length, metadataOnlyFiles: (projectEvidence.files || []).filter((item) => !item.currentExcerpt).length, scanTruncated: Boolean(scan.truncated), scanCoveragePercent: discovered ? Number(((selected / discovered) * 100).toFixed(2)) : 100, gitAvailable: Boolean(projectEvidence.git?.available), modifiedFiles: Number(projectEvidence.modifiedFiles?.length || 0), generatedFiles: Number(projectEvidence.generatedFiles?.length || 0) } : { available: false },
    knowledge: { evidenceEntries: ledger.length, fileVersionRecords: fileVersions.length, artifactLineages: artifactLineage.length, evidenceBackedArtifacts: artifactLineage.filter((item) => item.confidence !== '待确认').length },
    limitations: unique([
      ...(scan.truncated ? ['项目扫描达到文件上限；会话直接关联文件和高优先级项目文件仍会优先纳入。'] : []),
      ...((projectEvidence?.files || []).some((item) => !item.currentExcerpt) ? ['部分文件仅记录元数据，没有把二进制或超大文件内容当作已读取文本。'] : []),
      ...(artifactLineage.some((item) => item.confidence === '待确认') ? ['部分生成产物没有唯一生成命令，已标记为待确认。'] : []),
    ], 80),
  };
}

function buildActiveReadLog(projectDiscovery, projectEvidence, understanding, ledger) {
  const entries = [];
  const add = (status, action, target, reason, evidenceIds = []) => entries.push({ id: `read-${String(entries.length + 1).padStart(5, '0')}`, status, action, target: target || null, reason, evidenceIds: unique(evidenceIds, 200) });
  if (projectDiscovery) add(projectDiscovery.selectedPath ? '已完成' : '未找到', '发现关联项目', projectDiscovery.selectedPath, projectDiscovery.reason || '根据会话路径、工作目录和项目标记定位。');
  const modifiedByPath = new Map((projectEvidence?.modifiedFiles || []).map((item) => [normalizePath(item.path).toLocaleLowerCase('zh-CN'), item]));
  for (const file of projectEvidence?.files || []) {
    const modified = modifiedByPath.get(normalizePath(file.path).toLocaleLowerCase('zh-CN')) || file;
    const ids = evidenceIdsForPath(ledger, file.path);
    const fullyRead = String(file.contentStatus || '').startsWith('全文');
    const fingerprinted = Boolean(file.contentSha256);
    add(fullyRead ? '已完成' : fingerprinted ? '已取完整指纹' : '仅元数据', fullyRead ? '读取当前文件' : fingerprinted ? '计算当前文件完整指纹' : '记录文件元数据', normalizePath(file.path), fullyRead ? '项目扫描已读取可解析文本并生成展示摘录。' : fingerprinted ? '已计算完整文件 SHA-256，但二进制或较大正文没有作为文本载入。' : '超大文件或不可解析文件不声明为已读正文。', ids);
    if (modified.original?.available) add(modified.original.excerpt ? '已完成' : '仅 Git 元数据', '读取 Git 原始版本', normalizePath(file.path), modified.original.excerpt ? '已读取 HEAD 基线并保留内容指纹和展示摘录。' : '已读取 Git 对象号和大小，但没有把正文载入内存。', ids.filter((id) => id.startsWith('baseline-')));
    if (modified.diffExcerpt) add('已完成', '读取 Git 差异', normalizePath(file.path), '确认当前工作区相对基线的实际变更。', ids.filter((id) => id.startsWith('diff-')));
  }
  for (const plan of understanding?.activeReadPlan || []) add('计划', plan.action, plan.path, plan.reason, plan.evidenceIds || []);
  return entries;
}

function buildGraph(sourceSet, semanticStages, projectEvidence, fileVersions, artifactLineage, decisions) {
  const nodes = [];
  const edges = [];
  const addNode = (node) => nodes.push(node);
  const addEdge = (from, to, relation, evidenceIds = []) => edges.push({ id: `edge-${String(edges.length + 1).padStart(6, '0')}`, from, to, relation, evidenceIds: unique(evidenceIds, 200) });
  for (const session of sourceSet?.sessions || []) addNode({ id: `session:${session.sessionId}`, type: '会话', label: session.title, data: { authorityRank: session.authorityRank, path: session.sourcePath } });
  for (const stage of semanticStages) {
    addNode({ id: stage.id, type: '语义阶段', label: stage.title, data: { purpose: stage.purpose, priority: stage.priority } });
    for (const session of stage.sessions) addEdge(`session:${session.sessionId}`, stage.id, '提供需求与执行证据', stage.evidenceIds);
    for (const filePath of stage.files) addEdge(stage.id, `file:${filePath}`, '要求或执行涉及', stage.evidenceIds);
  }
  for (const file of projectEvidence?.files || []) addNode({ id: `file:${normalizePath(file.path)}`, type: '文件', label: normalizePath(file.path), data: { kind: file.kind, role: file.projectRole, gitStatus: file.gitStatus } });
  for (const version of fileVersions) {
    addNode({ id: version.versionId, type: '文件版本', label: `${version.path} · ${version.kind}`, data: { revision: version.revision, contentAvailable: version.contentAvailable } });
    addEdge(`file:${version.path}`, version.versionId, '拥有版本', version.evidenceIds);
    if (version.parentVersionId) addEdge(version.parentVersionId, version.versionId, '演化为', version.evidenceIds);
  }
  for (const artifact of artifactLineage) {
    addNode({ id: artifact.id, type: '生成产物', label: artifact.path, data: { confidence: artifact.confidence } });
    addEdge(`file:${artifact.path}`, artifact.id, '识别为产物', artifact.evidenceIds);
    for (const input of artifact.inputs) addEdge(`file:${normalizePath(input)}`, artifact.id, '输入或依赖', artifact.evidenceIds);
  }
  for (const decision of decisions) {
    addNode({ id: decision.id, type: '决策', label: clean(decision.decision, 160), data: { severity: decision.severity, status: decision.status } });
    if (decision.semanticStageId) addEdge(decision.semanticStageId, decision.id, '形成后续决策', decision.evidenceIds);
    for (const superseded of decision.supersedes) addEdge(decision.id, superseded.semanticStageId, '覆盖早期方案', decision.evidenceIds);
  }
  return { schemaVersion: '4.0.0', nodes, edges, statistics: { nodes: nodes.length, edges: edges.length, sessions: nodes.filter((item) => item.type === '会话').length, semanticStages: semanticStages.length, files: nodes.filter((item) => item.type === '文件').length, versions: fileVersions.length, artifacts: artifactLineage.length, decisions: decisions.length } };
}

export function buildProjectKnowledgeV4({ extraction, sourceSet, projectDiscovery = null, projectEvidence = null, projectUnderstanding = null } = {}) {
  const semanticStages = buildSemanticStages(extraction, sourceSet);
  const evidenceLedger = buildEvidenceLedger(extraction, sourceSet, projectEvidence, semanticStages);
  const projectModel = buildProjectModel(projectEvidence, projectUnderstanding, semanticStages, sourceSet);
  const fileVersions = buildFileVersions(projectEvidence, projectUnderstanding, evidenceLedger);
  const artifactLineage = buildArtifactLineage(projectEvidence, projectUnderstanding, extraction, evidenceLedger);
  const decisionConflicts = buildDecisions(extraction, semanticStages, projectUnderstanding);
  const coverage = buildCoverage(sourceSet, extraction, projectEvidence, evidenceLedger, semanticStages, fileVersions, artifactLineage);
  const activeReadLog = buildActiveReadLog(projectDiscovery, projectEvidence, projectUnderstanding, evidenceLedger);
  const crossSessionTimeline = buildCrossSessionTimeline(extraction, sourceSet, semanticStages);
  const fileChangeMatrix = buildFileChangeMatrix(projectEvidence, projectUnderstanding, semanticStages, evidenceLedger);
  const dependencyImpact = buildDependencyImpact(projectEvidence, projectUnderstanding, fileChangeMatrix);
  const projectSnapshot = buildProjectSnapshot(projectEvidence, sourceSet, semanticStages);
  const artifactReproducibility = artifactLineage.map((artifact) => ({ id: artifact.id, path: artifact.path, confidence: artifact.confidence, inputs: artifact.inputs, commands: artifact.commands, currentSnapshot: artifact.currentSnapshot, reproducibility: artifact.reproducibility, evidenceIds: artifact.evidenceIds }));
  const openEvidenceQuestions = unique([
    ...decisionConflicts.filter((item) => item.status !== '已解析，执行时强制应用').map((item) => `${item.type}：${item.decision}`),
    ...artifactLineage.filter((item) => !item.reproducibility?.readyToReplay).map((item) => `产物 ${item.path}：${item.reproducibility?.status || '复现证据不足'}`),
    ...(coverage.limitations || []),
  ], 500).map((question, index) => ({ id: `open-${String(index + 1).padStart(4, '0')}`, question, status: '待补证', boundary: '没有足够证据时保留问题，不生成推测性答案。' }));
  const projectGraph = buildGraph(sourceSet, semanticStages, projectEvidence, fileVersions, artifactLineage, decisionConflicts);
  return {
    schemaVersion: '4.1.0',
    generatedAt: new Date().toISOString(),
    name: '多会话项目级蒸馏知识包 V4.1',
    summary: {
      sessions: Number(sourceSet?.sessionCount || 0),
      semanticStages: semanticStages.length,
      evidenceEntries: evidenceLedger.length,
      projectFiles: Number(projectEvidence?.files?.length || 0),
      fileVersions: fileVersions.length,
      artifactLineages: artifactLineage.length,
      decisions: decisionConflicts.length,
      readActions: activeReadLog.length,
      timelineEvents: crossSessionTimeline.length,
      changedFiles: fileChangeMatrix.length,
      dependencyEdges: dependencyImpact.statistics.edges,
      reproducibleArtifacts: artifactReproducibility.filter((item) => item.reproducibility?.readyToReplay).length,
      openEvidenceQuestions: openEvidenceQuestions.length,
    },
    semanticStages,
    evidenceLedger,
    projectModel,
    projectGraph,
    fileVersions,
    artifactLineage,
    decisionConflicts,
    coverage,
    activeReadLog,
    crossSessionTimeline,
    fileChangeMatrix,
    dependencyImpact,
    artifactReproducibility,
    projectSnapshot,
    openEvidenceQuestions,
  };
}

export function knowledgeV4Markdown(knowledge) {
  if (!knowledge) return '# 多会话项目级蒸馏知识包\n\n本次没有形成可展示的项目知识层。\n';
  const lines = [
    '# 多会话项目级蒸馏知识包 V4.1', '',
    `生成时间：${knowledge.generatedAt}`, '',
    '## 直白说明', '',
    `本知识包联合读取 ${knowledge.summary.sessions} 条会话，把 ${knowledge.summary.semanticStages} 个语义目标与 ${knowledge.summary.projectFiles} 个项目文件关联起来，形成 ${knowledge.summary.evidenceEntries} 条证据、${knowledge.summary.fileVersions} 条文件版本记录、${knowledge.summary.artifactLineages} 条产物血缘和 ${knowledge.summary.decisions} 条后续决策或证据缺口。`, '',
    '## 从多会话提炼的语义阶段', '',
    '| 阶段 | 具体目标 | 来源会话 | 涉及文件 | 工具 | 证据 |', '| --- | --- | ---: | ---: | ---: | ---: |',
    ...knowledge.semanticStages.map((stage) => `| ${stage.title} | ${clean(stage.purpose, 220).replace(/\|/g, '\\|')} | ${stage.sessions.length} | ${stage.files.length} | ${stage.tools.length} | ${stage.evidenceIds.length} |`), '',
    '## 项目模型', '',
    knowledge.projectModel ? `项目：${knowledge.projectModel.project?.name || '未命名'}；目的：${knowledge.projectModel.purpose || '未确认'}；模块：${knowledge.projectModel.modules.length}；入口候选：${knowledge.projectModel.entryPoints.length}。` : '没有定位到可读取的关联项目。', '',
    '## 文件版本链', '',
    `共 ${knowledge.fileVersions.length} 条版本记录。每条记录区分 Git 原始版本、会话中记录的操作和当前工作区版本；缺少正文时明确标记为“内容不可用”。`, '',
    '## 生成产物血缘', '',
    '| 产物 | 可信度 | 输入或依赖 | 匹配命令 | 结论 |', '| --- | --- | ---: | ---: | --- |',
    ...knowledge.artifactLineage.slice(0, 300).map((item) => `| ${item.path.replace(/\|/g, '\\|')} | ${item.confidence} | ${item.inputs.length} | ${item.commands.length} | ${item.conclusion} |`), '',
    '## 后续纠正、冲突和证据缺口', '',
    ...knowledge.decisionConflicts.map((item) => `- **${item.type} / ${item.status}**：${item.decision} 处理：${item.handling}`), '',
    '## 覆盖率与读取边界', '',
    `- 会话：已解析 ${knowledge.coverage.sessions.parsed}/${knowledge.coverage.sessions.selected} 条。`,
    `- 项目：${knowledge.coverage.project.available ? `扫描 ${knowledge.coverage.project.scannedFiles}/${knowledge.coverage.project.discoveredFiles} 个文件，文本读取 ${knowledge.coverage.project.textFilesRead} 个，仅元数据 ${knowledge.coverage.project.metadataOnlyFiles} 个` : '没有关联项目'}。`,
    `- 主动读取记录：${knowledge.activeReadLog.filter((item) => item.status === '已完成').length} 项已完成，${knowledge.activeReadLog.filter((item) => item.status === '仅元数据').length} 项仅记录元数据，${knowledge.activeReadLog.filter((item) => item.status === '计划').length} 项仍是计划。`, '',
    ...knowledge.coverage.limitations.map((item) => `- ${item}`), '',
    '## 跨会话文件变更矩阵', '',
    '| 文件 | 来源会话 | 语义阶段 | Git 基线 | 当前指纹 | 差异 | 结论 |', '| --- | ---: | ---: | --- | --- | --- | --- |',
    ...(knowledge.fileChangeMatrix || []).map((item) => `| ${item.path.replace(/\|/g, '\\|')} | ${item.sessions.length} | ${item.semanticStages.length} | ${item.baseline.available ? '有' : '无'} | ${item.current.sha256 ? '有' : '无'} | ${item.diff.available ? '有' : '无'} | ${item.assessment} |`), '',
    '## 依赖与变更影响', '',
    `解析到 ${knowledge.dependencyImpact?.statistics?.edges || 0} 条文件依赖；其中 ${(knowledge.dependencyImpact?.changedFiles || []).filter((item) => item.impactLevel === '高').length} 个变更文件具有高影响范围。`, '',
    '## 产物复现状态', '',
    '| 产物 | 状态 | 可重放 | 生成命令 | 验证命令 |', '| --- | --- | --- | ---: | ---: |',
    ...(knowledge.artifactReproducibility || []).map((item) => `| ${item.path.replace(/\|/g, '\\|')} | ${item.reproducibility.status} | ${item.reproducibility.readyToReplay ? '是' : '否'} | ${item.reproducibility.generationCommandCount} | ${item.reproducibility.verificationCommandCount} |`), '',
    '## 项目快照与增量重扫', '',
    `本次快照指纹：\`${knowledge.projectSnapshot?.fingerprint || '未生成'}\`。当前记录 ${(knowledge.projectSnapshot?.files || []).length} 个文件，其中 ${knowledge.projectSnapshot?.coverage?.fullContentFingerprints || 0} 个具有完整内容指纹；后续可按路径、指纹、修改时间、Git 提交和会话哈希计算新增、删除与修改。`, '',
    '## 待补证问题', '',
    ...((knowledge.openEvidenceQuestions || []).map((item) => `- **${item.status}**：${item.question}`)), '',
    '## 文件说明', '',
    '- `semantic-stages.json`：跨会话语义归并结果和每个来源轨迹。',
    '- `evidence-ledger.ndjson`：逐条证据账本。',
    '- `project-model.json`：项目目的、模块、入口、规则和能力。',
    '- `project-graph.json`：会话、阶段、文件、版本、产物和决策关系图。',
    '- `file-versions.ndjson`：文件版本演化链。',
    '- `artifact-lineage.json`：生成产物、输入、命令和可信度。',
    '- `decision-conflicts.json`：后续纠正、覆盖关系和证据缺口。',
    '- `coverage.json`：会话与项目读取覆盖率。',
    '- `active-read-log.ndjson`：已完成读取、仅元数据和后续计划。', '',
    '- `cross-session-timeline.ndjson`：跨会话需求、文件操作和命令时间线。',
    '- `file-change-matrix.json`：会话操作、Git 基线、当前指纹与差异的逐文件对照。',
    '- `dependency-impact.json`：已解析依赖和变更影响范围。',
    '- `artifact-reproducibility.json`：产物生成命令、输入、验证与可重放状态。',
    '- `project-snapshot.json`：用于后续增量重扫的项目与会话快照。',
    '- `open-evidence-questions.json`：未被证据支持的问题，明确保留为待补证。', '',
  ];
  return `${lines.join('\n')}\n`;
}

export function ndjson(items) {
  return `${(items || []).map((item) => JSON.stringify(item)).join('\n')}${items?.length ? '\n' : ''}`;
}
