import crypto from 'node:crypto';

const MAX_ITEMS = 64;
const LEVEL_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

function text(value, maximum = 1600) {
  const normalized = String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum)}...`;
}

function unique(values, maximum = 120) {
  return [...new Set((values || []).map((value) => text(value, 800)).filter(Boolean))].slice(0, maximum);
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, Math.round(Number(value) || 0)));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function compactTitle(value, fallback) {
  const title = text(value, 180).replace(/^P\d+\s*[|:：]\s*/i, '').trim();
  return title || fallback;
}

function evidenceId(type, value) {
  const prefix = String(type || 'evidence').replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 24);
  const digest = crypto.createHash('sha256').update(`${type}\n${value}`).digest('hex').slice(0, 16);
  return `${prefix}-${digest}`;
}

function scoreLevel(score, forceP0 = false) {
  if (forceP0 || score >= 86) return 'P0';
  if (score >= 68) return 'P1';
  if (score >= 46) return 'P2';
  return 'P3';
}

function confidenceLevel(score) {
  if (score >= 90) return '确定';
  if (score >= 76) return '强关联';
  if (score >= 58) return '关联';
  return '待确认';
}

function stageProjectEvidence(stage, projectKnowledge) {
  const sourceIndexes = new Set((stage.originalStageIndexes || [stage.index]).map(Number));
  const semantic = (projectKnowledge?.semanticStages || []).find((entry) => (entry.sourceStageIndexes || []).some((index) => sourceIndexes.has(Number(index))));
  const stageFiles = unique([...(stage.fileChanges || []).map((entry) => entry.path || entry), ...(semantic?.files || [])], 60);
  const fileMatrix = (projectKnowledge?.fileChangeMatrix || []).filter((entry) => stageFiles.includes(entry.path));
  const lineages = (projectKnowledge?.artifactLineage || []).filter((entry) => stageFiles.includes(entry.path));
  const versions = (projectKnowledge?.fileVersions || []).filter((entry) => stageFiles.includes(entry.path));
  return { semantic, stageFiles, fileMatrix, lineages, versions };
}

function item(type, seed, title, detail, extra = {}) {
  return { id: evidenceId(type, seed), type, title: text(title, 320), detail: text(detail, 1800), ...extra };
}

function stageEvidence(stage, sourceSet, project, tools, failure) {
  const items = [item('stage', stage.index, `P${stage.index}：${compactTitle(stage.title, '会话阶段')}`, stage.request, { stageIndex: stage.index })];
  if (stage.classification?.type === 'correction') items.push(item('correction', stage.index, `阶段 ${stage.index} 的最新用户修正`, '该要求覆盖与其冲突的早期做法，能力包应以此为默认路径。', { stageIndex: stage.index }));
  if (failure) items.push(item('verification', `${stage.index}-failure`, `阶段 ${stage.index} 的失败或未完成验证`, failure, { stageIndex: stage.index, status: 'failed' }));
  for (const sessionId of stage.sourceSessions || []) {
    const session = (sourceSet?.sessions || []).find((candidate) => candidate.sessionId === sessionId);
    items.push(item('session', sessionId, session?.title || sessionId, `来源会话：${sessionId}`, { sessionId }));
  }
  for (const tool of tools) items.push(item('tool', `${stage.index}-${tool}`, tool, '原会话实际调用的工具或命令能力。', { stageIndex: stage.index, tool }));
  for (const file of project.stageFiles) items.push(item('file', file, file, '会话阶段或语义阶段直接关联的项目文件。', { path: file }));
  for (const change of project.fileMatrix) items.push(item('git-change', change.path, change.path, change.assessment || change.changeState || '已记录当前版本、原始版本或 Git 变更。', { path: change.path, changeState: change.changeState || null }));
  for (const lineage of project.lineages) items.push(item('artifact', lineage.path, lineage.path, lineage.conclusion || lineage.reproducibility?.status || '已识别生成产物及其来源。', { path: lineage.path }));
  for (const version of project.versions.slice(0, 24)) items.push(item('file-version', `${version.path}-${version.revision || version.order}`, `${version.path} 的版本记录`, version.changeState || version.action || '已记录文件版本。', { path: version.path, revision: version.revision || version.order || null }));
  return [...new Map(items.map((entry) => [entry.id, entry])).values()];
}

function failureSignal(stage) {
  const value = text(JSON.stringify({ outcome: stage.outcome, result: stage.result, response: stage.response }), 4000);
  return /失败|错误|未通过|未完成|超时|error|failed|failure|timeout/i.test(value) ? value : '';
}

function confidenceFor(evidence, project, tools, sourceCount) {
  const types = new Set(evidence.map((entry) => entry.type));
  const score = clamp(24 + Math.min(24, types.size * 4) + Math.min(16, evidence.length * 2) + Math.min(12, sourceCount * 4) + (project.fileMatrix.length ? 10 : 0) + (project.lineages.length ? 8 : 0) + (tools.length ? 6 : 0));
  return {
    level: confidenceLevel(score),
    score,
    basis: unique([...types].map((type) => ({ session: '会话', stage: '需求阶段', correction: '用户修正', tool: '工具调用', file: '项目文件', 'git-change': 'Git/文件变更', artifact: '生成产物', verification: '验证结果', 'file-version': '文件版本' }[type] || type))),
  };
}

function recommendationForStage(stage, index, context) {
  const correction = stage.classification?.type === 'correction';
  const project = stageProjectEvidence(stage, context.projectKnowledgeV4);
  const tools = unique((stage.toolCalls || []).map((entry) => entry.name || entry), 40);
  const outcome = stage.outcome || {};
  const failure = failureSignal(stage);
  const evidence = stageEvidence(stage, context.sourceSet, project, tools, failure);
  const sourceCount = Math.max(1, (stage.sourceSessions || []).length);
  const distillationComponents = {
    latestCorrection: correction ? 34 : 0,
    conflictOrFailure: failure ? 22 : 0,
    userPriority: Math.min(16, Math.max(0, Number(stage.classification?.priority || 0) / 70)),
    directEvidence: 16,
    projectEvidence: Math.min(16, project.stageFiles.length * 3 + project.fileMatrix.length * 2),
    deliveryEvidence: Math.min(10, project.lineages.length * 4 + Math.min(4, Number(outcome.changedFiles || 0))),
    sourceCoverage: Math.min(8, sourceCount * 3),
  };
  const distillationScore = clamp(Object.values(distillationComponents).reduce((total, value) => total + value, 0));
  const distillationLevel = scoreLevel(distillationScore, correction || Boolean(failure));
  const executionComponents = {
    blockingCorrection: correction ? 28 : 0,
    failedVerification: failure ? 30 : 0,
    concreteFiles: Math.min(14, project.stageFiles.length * 4),
    executableTools: Math.min(12, tools.length * 3 + Math.min(3, Number(outcome.toolCallCount || 0))),
    requiredDelivery: Math.min(10, project.lineages.length * 5 + Math.min(5, Number(outcome.changedFiles || 0))),
    explicitRequest: 14,
  };
  const executionScore = clamp(Object.values(executionComponents).reduce((total, value) => total + value, 0));
  const executionLevel = scoreLevel(executionScore, correction || Boolean(failure));
  const certainty = confidenceFor(evidence, project, tools, sourceCount);
  const title = compactTitle(stage.title, `会话工作阶段 ${index + 1}`);
  const why = unique([
    correction ? '这是后续用户明确提出的修正，必须覆盖冲突的旧做法。' : '',
    failure ? '该阶段出现失败、超时或未完成验证，继续执行前必须先处理。' : '',
    sourceCount > 1 ? `该做法跨 ${sourceCount} 条会话出现。` : '该做法来自已选会话的明确任务阶段。',
    project.stageFiles.length ? `已关联 ${project.stageFiles.length} 个项目文件。` : '',
    project.fileMatrix.length ? `其中 ${project.fileMatrix.length} 个文件存在可追溯变更或 Git 基线。` : '',
    project.lineages.length ? `已找到 ${project.lineages.length} 个生成产物或复现线索。` : '',
    tools.length ? `原会话实际使用了 ${tools.slice(0, 5).join('、')} 等工具。` : '',
  ], 10);
  const nextAction = distillationLevel === 'P0'
    ? '先写入能力包默认规则，处理最新修正、冲突或失败验证，再执行后续任务。'
    : distillationLevel === 'P1'
      ? '固化为核心任务流程，保留输入、步骤、产物和验证方式。'
      : distillationLevel === 'P2'
        ? '作为核心流程增强项，补齐关联文件、工具、产物血缘和验证。'
        : '保留为可选专长，出现同类任务或补足证据后再提升优先级。';
  return {
    id: `priority-${String(index + 1).padStart(3, '0')}`,
    rank: 0,
    level: distillationLevel,
    score: distillationScore,
    title,
    sourceOrder: index,
    sourceStages: unique((stage.originalStageIndexes || [stage.index]).map((value) => `P${value}`), 20),
    sourceSessions: stage.sourceSessions || [],
    purpose: text(stage.request, 1500),
    why,
    distillationPriority: { level: distillationLevel, score: distillationScore, reason: nextAction, components: distillationComponents },
    agentExecutionPriority: {
      level: executionLevel,
      score: executionScore,
      reason: failure ? '先修复失败验证并确认工作区状态。' : correction ? '先应用最新用户修正，再执行原流程。' : project.stageFiles.length ? '先读取关联文件与项目规则，再执行并验证。' : '先确认输入，再按提炼流程执行。',
      components: executionComponents,
    },
    evidenceConfidence: certainty,
    confidence: certainty,
    evidenceIds: evidence.map((entry) => entry.id),
    affectedFiles: project.stageFiles,
    observedTools: tools,
    expectedOutput: stage.outcome?.summary || (project.lineages.length ? '可复现的阶段产物与对应源文件关系。' : '可复核的阶段结果、文件差异与验证记录。'),
    nextAction,
    components: distillationComponents,
    evidence,
  };
}

function recommendationSummary(priorities, context) {
  const counts = Object.fromEntries(['P0', 'P1', 'P2', 'P3'].map((level) => [level, priorities.filter((entry) => entry.distillationPriority.level === level).length]));
  const project = context.projectEvidence?.project?.name;
  const sourceCount = Number(context.sourceSet?.sessionCount || context.sourceSet?.sessions?.length || 1);
  const first = priorities[0];
  return {
    sourceCount,
    project: project || null,
    counts,
    readiness: priorities.some((entry) => entry.distillationPriority.level === 'P0') ? '先处理最新修正或失败验证，再按建议生成' : project ? '可直接生成项目专属能力包' : '可直接生成会话专属能力包',
    headline: first ? `建议生成“${context.identity?.name || first.title}”，包含 ${priorities.filter((entry) => entry.level !== 'P3').length} 项重点能力，先处理 ${counts.P0} 项必须项。` : '当前没有可排序的需求阶段，请补充完整会话内容。',
    defaultAction: priorities.length ? '按推荐生成并打开能力包' : '补充会话后重新蒸馏',
  };
}

function buildEvidenceGraph(priorities, evidence) {
  const nodes = [...priorities.map((entry) => ({ id: entry.id, type: '能力判断', title: entry.title, priority: entry.distillationPriority.level })), ...evidence.map((entry) => ({ id: entry.id, type: entry.type, title: entry.title, detail: entry.detail }))];
  const edges = priorities.flatMap((priority) => priority.evidenceIds.map((id) => ({ from: priority.id, to: id, relation: '依据' })));
  return {
    nodes,
    edges,
    statistics: {
      nodes: nodes.length,
      edges: edges.length,
      sessions: evidence.filter((entry) => entry.type === 'session').length,
      corrections: evidence.filter((entry) => entry.type === 'correction').length,
      tools: evidence.filter((entry) => entry.type === 'tool').length,
      files: evidence.filter((entry) => ['file', 'git-change', 'file-version'].includes(entry.type)).length,
      artifacts: evidence.filter((entry) => entry.type === 'artifact').length,
      verifications: evidence.filter((entry) => entry.type === 'verification').length,
    },
  };
}

export function buildDistillationRecommendation({ identity, extraction, sourceSet, projectEvidence = null, projectKnowledgeV4 = null } = {}) {
  const context = { identity, extraction, sourceSet, projectEvidence, projectKnowledgeV4 };
  const stages = (extraction?.stages || []).slice(0, MAX_ITEMS);
  const priorities = stages.map((stage, index) => recommendationForStage(stage, index, context))
    .sort((left, right) => LEVEL_ORDER[left.distillationPriority.level] - LEVEL_ORDER[right.distillationPriority.level] || right.distillationPriority.score - left.distillationPriority.score || left.sourceOrder - right.sourceOrder)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  const evidenceMap = new Map();
  for (const priority of priorities) for (const evidence of priority.evidence) {
    const current = evidenceMap.get(evidence.id);
    evidenceMap.set(evidence.id, current ? { ...current, priorityIds: unique([...current.priorityIds, priority.id], 60) } : { ...evidence, priorityIds: [priority.id] });
  }
  const evidence = [...evidenceMap.values()];
  return {
    schemaVersion: '2.0.0',
    type: 'zero-code-work-capability-distillation-recommendation',
    generatedAt: new Date().toISOString(),
    identity: { title: identity?.name || '会话专属能力包', packageId: identity?.id || null, naming: identity?.naming || null },
    summary: recommendationSummary(priorities, context),
    judgements: { distillationPriority: '决定哪些内容先写入能力包。', agentExecutionPriority: '决定生成后的 Agent 接到任务时先处理什么。', evidenceConfidence: '衡量判断是否同时获得会话、文件、Git、产物和验证支持。' },
    priorities,
    evidence,
    evidenceGraph: buildEvidenceGraph(priorities, evidence),
    recommendedPackage: { title: identity?.name || '会话专属能力包', targets: ['skill', 'mcp', 'agent'], description: '默认生成可安装 Skill、MCP 服务、带独立中文界面的执行型 Agent，以及完整的优先级、任务目录和证据说明。' },
    missingEvidence: projectKnowledgeV4?.openEvidenceQuestions || [],
  };
}

export function distillationRecommendationMarkdown(recommendation) {
  const summary = recommendation?.summary || {};
  const rows = (recommendation?.priorities || []).map((entry) => `| ${entry.rank} | ${entry.distillationPriority?.level || entry.level} | ${entry.agentExecutionPriority?.level || entry.level} | ${entry.title.replace(/\|/g, '\\|')} | ${entry.evidenceConfidence?.score || entry.confidence?.score || 0} | ${entry.why.join('；').replace(/\|/g, '\\|')} |`).join('\n') || '| — | — | — | 未识别到可排序的需求阶段 | — | — |';
  const detail = (recommendation?.priorities || []).map((entry) => [
    `## ${entry.distillationPriority?.level || entry.level}｜${entry.title}`,
    '',
    `- **蒸馏优先级**：${entry.distillationPriority?.level || entry.level}（${entry.distillationPriority?.score ?? entry.score}/100），${entry.distillationPriority?.reason || entry.nextAction}`,
    `- **Agent 执行优先级**：${entry.agentExecutionPriority?.level || entry.level}（${entry.agentExecutionPriority?.score ?? entry.score}/100），${entry.agentExecutionPriority?.reason || '按提炼流程执行。'}`,
    `- **证据置信度**：${entry.evidenceConfidence?.level || entry.confidence?.level || '待确认'}（${entry.evidenceConfidence?.score || entry.confidence?.score || 0}/100）；来源：${(entry.evidenceConfidence?.basis || []).join('、') || '会话证据'}`,
    `- **为什么**：${entry.why.join('；') || '来自原会话阶段。'}`,
    `- **执行目标**：${entry.purpose}`,
    `- **预期产物**：${entry.expectedOutput}`,
    `- **来源阶段**：${entry.sourceStages.join('、') || '未记录'}`,
    `- **关联文件**：${entry.affectedFiles.map((file) => `\`${file}\``).join('、') || '未发现'}`,
    `- **原会话工具**：${entry.observedTools.join('、') || '未记录'}`,
    `- **证据编号**：${entry.evidenceIds.join('、') || '未记录'}`,
  ].join('\n')).join('\n\n');
  const missing = (recommendation?.missingEvidence || []).slice(0, 24).map((entry) => `- ${typeof entry === 'string' ? entry : entry.question || entry.title || '待补证问题'}`).join('\n') || '- 当前没有需要补充的关键证据。';
  return `# ${recommendation?.identity?.title || '会话能力包'}：蒸馏与执行优先级\n\n## 直接结论\n\n${summary.headline || '当前没有形成建议。'}\n\n- **生成状态**：${summary.readiness || '待分析'}\n- **默认动作**：${summary.defaultAction || '重新分析'}\n- **来源会话**：${summary.sourceCount || 0} 条${summary.project ? `；关联项目：${summary.project}` : ''}\n\n## 三套判断\n\n- **蒸馏优先级**：决定哪些内容先写入能力包。\n- **Agent 执行优先级**：决定接到任务时先处理什么。\n- **证据置信度**：衡量判断是否同时获得会话、文件、Git、产物和验证支持。\n\n## 优先级总览\n\n| 顺序 | 蒸馏 | 执行 | 专属能力 | 置信度 | 主要依据 |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n\n${detail}\n\n## 待补证信息\n\n${missing}\n`;
}

export function distillationRecommendationHtml(recommendation) {
  const summary = recommendation?.summary || {};
  const items = (recommendation?.priorities || []).map((entry) => `<article class="priority priority-${escapeHtml(entry.distillationPriority?.level || entry.level)}"><div class="priority-head"><span>${escapeHtml(entry.distillationPriority?.level || entry.level)}</span><h2>${escapeHtml(entry.title)}</h2><strong>${escapeHtml(entry.evidenceConfidence?.score || entry.confidence?.score || 0)}/100 置信度</strong></div><p>${escapeHtml(entry.purpose)}</p><dl><div><dt>蒸馏优先级</dt><dd>${escapeHtml(entry.distillationPriority?.level || entry.level)} · ${escapeHtml(entry.distillationPriority?.reason || entry.nextAction)}</dd></div><div><dt>Agent 执行优先级</dt><dd>${escapeHtml(entry.agentExecutionPriority?.level || entry.level)} · ${escapeHtml(entry.agentExecutionPriority?.reason || '按提炼流程执行')}</dd></div><div><dt>为什么这样判断</dt><dd>${entry.why.map((reason) => escapeHtml(reason)).join('<br>')}</dd></div><div><dt>证据置信度</dt><dd>${escapeHtml(entry.evidenceConfidence?.level || entry.confidence?.level || '待确认')} ${escapeHtml(entry.evidenceConfidence?.score || entry.confidence?.score || 0)}/100</dd></div><div><dt>关联文件</dt><dd>${entry.affectedFiles.length ? entry.affectedFiles.map((file) => `<code>${escapeHtml(file)}</code>`).join(' ') : '未发现'}</dd></div><div><dt>证据编号</dt><dd>${entry.evidenceIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(' ')}</dd></div></dl></article>`).join('') || '<p>未识别到可排序的需求阶段。</p>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(recommendation?.identity?.title || '蒸馏建议')}</title><style>body{margin:0;background:#f5f7f6;color:#152b28;font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1060px;margin:auto;padding:44px 24px}header{border-bottom:1px solid #c8d7d3;padding-bottom:22px}h1{font-size:32px;line-height:1.25;margin:0 0 10px;letter-spacing:0}.eyebrow{color:#08786f;font-weight:800}.summary{color:#52706b}.legend{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#c8d7d3;margin:22px 0}.legend div{background:white;padding:16px}.legend strong{display:block}.priority{margin:20px 0;padding:20px;border:1px solid #c8d7d3;background:#fff}.priority-head{display:flex;align-items:baseline;gap:12px}.priority-head span{padding:2px 8px;background:#e1f2ed;color:#076b62;font-weight:800}.priority-head h2{margin:0;flex:1;font-size:21px;letter-spacing:0}.priority-head strong{color:#52706b}dl{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:18px 0 0}dt{font-weight:800}dd{margin:3px 0;color:#46625e}code{display:inline-block;margin:2px;padding:1px 5px;background:#edf3f1;overflow-wrap:anywhere}.priority-P0{border-left:5px solid #be4b37}.priority-P1{border-left:5px solid #08786f}.priority-P2{border-left:5px solid #1d7599}.priority-P3{border-left:5px solid #8a7552}@media(max-width:680px){main{padding:28px 16px}h1{font-size:26px}.legend,dl{grid-template-columns:1fr}.priority-head{align-items:flex-start;flex-wrap:wrap}.priority-head h2{font-size:18px;flex-basis:70%}}</style></head><body><main><header><p class="eyebrow">零代码工作能力蒸馏建议</p><h1>${escapeHtml(recommendation?.identity?.title || '会话能力包')}</h1><p class="summary">${escapeHtml(summary.headline || '当前没有形成建议。')}</p><p class="summary">${escapeHtml(summary.readiness || '待分析')}；下一步：${escapeHtml(summary.defaultAction || '重新分析')}</p></header><section class="legend"><div><strong>蒸馏优先级</strong><span>决定先写入能力包的内容</span></div><div><strong>Agent 执行优先级</strong><span>决定接到任务后的执行顺序</span></div><div><strong>证据置信度</strong><span>说明判断获得了哪些证据支持</span></div></section>${items}</main></body></html>`;
}
