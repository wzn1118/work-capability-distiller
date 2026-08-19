import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, cleanText } from './shared.mjs';

let cache = null;

export async function loadEvidence(agentRoot) {
  if (cache) return cache;
  const optionalJson = async (fileName, fallback) => {
    try { return JSON.parse(await fs.readFile(path.join(agentRoot, fileName), 'utf8')); } catch { return fallback; }
  };
  const [blueprint, extraction, contract, sourceSessions, projectPortfolio, projectEvidence, projectUnderstanding, projectKnowledgeV4] = await Promise.all([
    fs.readFile(path.join(agentRoot, 'workflow-blueprint.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(agentRoot, 'conversation-extraction.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(agentRoot, 'capability-contract.json'), 'utf8').then(JSON.parse),
    optionalJson('source-sessions.json', []),
    optionalJson('project-portfolio.json', null),
    optionalJson('project-evidence.json', null),
    optionalJson('project-understanding.json', null),
    optionalJson('project-knowledge-v4.json', null),
  ]);
  cache = { blueprint, extraction, contract, sourceSessions, projectPortfolio, projectEvidence, projectUnderstanding, projectKnowledgeV4 };
  return cache;
}

function includes(value, query) {
  return cleanText(value, 100000).toLocaleLowerCase('zh-CN').includes(query);
}

export async function searchConversation(agentRoot, args = {}) {
  const { extraction } = await loadEvidence(agentRoot);
  const query = String(args.query || '').trim().toLocaleLowerCase('zh-CN');
  if (!query) throw new HttpError(400, 'query_required', '必须提供原对话搜索关键词。');
  const stageFilter = Number(args.stage || 0);
  const roleFilter = String(args.role || '').trim();
  const maximum = Math.min(Math.max(Number(args.maxResults) || 20, 1), 100);
  const hits = [];
  for (const stage of extraction.stages || []) {
    if (stageFilter && stage.index !== stageFilter) continue;
    if (includes(stage.request, query)) hits.push({ kind: 'request', stage: stage.index, eventIndex: stage.eventRange?.[0], actor: 'user', text: stage.request });
    for (const message of stage.messages || []) {
      if (roleFilter && message.actor !== roleFilter) continue;
      if (includes(message.text, query)) hits.push({ kind: 'message', stage: stage.index, eventIndex: message.eventIndex, actor: message.actor, text: message.text });
    }
    for (const tool of stage.toolCalls || []) {
      if (includes(tool.name, query) || includes(tool.arguments, query) || includes(tool.result?.excerpt, query)) hits.push({ kind: 'tool', stage: stage.index, eventIndex: tool.eventIndex, name: tool.name, arguments: tool.arguments, result: tool.result });
    }
    for (const command of stage.commands || []) if (includes(command.command, query)) hits.push({ kind: 'command', stage: stage.index, eventIndex: command.eventIndex, command: command.command });
    for (const file of stage.fileChanges || []) if (includes(file.path, query)) hits.push({ kind: 'file', stage: stage.index, eventIndex: file.eventIndex, path: file.path, action: file.action });
    if (hits.length >= maximum) break;
  }
  return { query: args.query, count: Math.min(hits.length, maximum), results: hits.slice(0, maximum) };
}

export async function getStage(agentRoot, args = {}) {
  const { extraction } = await loadEvidence(agentRoot);
  const index = Number(args.stage || args.index);
  const stage = (extraction.stages || []).find((item) => item.index === index);
  if (!stage) throw new HttpError(404, 'stage_not_found', `找不到原对话第 ${index} 阶段。`);
  return stage;
}

export async function getRequirementChanges(agentRoot) {
  const { extraction } = await loadEvidence(agentRoot);
  return { requirementEvolution: extraction.requirementEvolution || [], latestWins: true };
}

export async function getLatestCorrections(agentRoot) {
  const { extraction } = await loadEvidence(agentRoot);
  return { corrections: extraction.corrections || [], rule: '排序越靠前优先级越高；与早期要求冲突时执行后续纠正。' };
}

export async function getImprovedWorkflow(agentRoot) {
  const { extraction } = await loadEvidence(agentRoot);
  return { workflow: extraction.improvedWorkflow || [], acceptanceMatrix: extraction.acceptanceMatrix || [], recoveryRules: extraction.recoveryRules || [] };
}

function maximum(value, fallback = 20, limit = 100) {
  return Math.min(Math.max(Number(value) || fallback, 1), limit);
}

function compactProjectFile(item) {
  return {
    path: item.path,
    kind: item.kind || null,
    language: item.language || null,
    changeState: item.changeState || item.status || null,
    projectRole: item.projectRole || null,
    gitStatus: item.gitStatus || null,
    observedInConversation: Boolean(item.observedInConversation),
    originalAvailable: Boolean(item.original || item.originalAvailable),
    hasDiff: Boolean(item.diffExcerpt || item.hasDiff),
    currentExcerpt: item.currentExcerpt ? cleanText(item.currentExcerpt, 6000) : null,
    originalExcerpt: item.original?.excerpt ? cleanText(item.original.excerpt, 6000) : null,
    diffExcerpt: item.diffExcerpt ? cleanText(item.diffExcerpt, 8000) : null,
    conversation: item.conversation || null,
  };
}

export async function getSourceSessions(agentRoot) {
  const { sourceSessions, blueprint } = await loadEvidence(agentRoot);
  const sessions = Array.isArray(sourceSessions) ? sourceSessions : blueprint.selection?.sessions || [];
  return {
    mode: blueprint.selection?.mode || (sessions.length > 1 ? 'multi-session' : 'whole-session'),
    count: sessions.length,
    sessions: sessions.map((item, index) => ({
      order: index + 1,
      sessionId: item.sessionId || item.id || null,
      title: item.title || item.sessionId || `会话 ${index + 1}`,
      sourcePath: item.sourcePath || item.path || null,
      sha256: item.sha256 || null,
      recordCount: item.recordCount || 0,
      normalisedEventCount: item.normalisedEventCount || 0,
      messages: item.messages || 0,
      toolCalls: item.toolCalls || 0,
      fileChanges: item.fileChanges || 0,
    })),
  };
}

export async function getProjectPortfolio(agentRoot) {
  const { projectPortfolio } = await loadEvidence(agentRoot);
  if (!projectPortfolio) return { available: false, message: '能力包中没有可展示的项目组合记录。' };
  return {
    available: true,
    crossProject: Boolean(projectPortfolio.crossProject),
    mode: projectPortfolio.mode || '未识别',
    recommendedMode: projectPortfolio.recommendedMode || '按证据处理',
    projects: (projectPortfolio.projects || []).map((project) => ({
      projectId: project.projectId,
      name: project.name,
      root: project.root,
      confidence: project.confidence,
      markers: project.markers || [],
      sessionCount: project.sessionCount || (project.sessions || []).length || 0,
      sessionIds: project.sessionIds || (project.sessions || []).map((item) => item.sessionId).filter(Boolean),
      evidenceSummary: project.evidenceSummary || project.evidence?.summary || null,
      evidenceError: project.evidenceError || null,
    })),
    sessionAssignments: projectPortfolio.sessionAssignments || [],
    unassignedSessions: projectPortfolio.unassignedSessions || [],
  };
}

export async function getProjectEvidence(agentRoot, args = {}) {
  const { projectEvidence } = await loadEvidence(agentRoot);
  if (!projectEvidence) return { available: false, message: '能力包生成时没有指定项目文件夹，因此没有项目快照。' };
  const group = String(args.group || '摘要');
  const maximumResults = maximum(args.maxResults, 30, 160);
  const groups = {
    摘要: [],
    修改文件: projectEvidence.modifiedFiles || [],
    生成产物: projectEvidence.generatedFiles || [],
    原始版本: projectEvidence.originalFiles || [],
    会话关联: projectEvidence.conversationLinks || [],
    全部文件: projectEvidence.files || [],
  };
  const selected = groups[group];
  if (!selected) throw new HttpError(400, 'project_group_invalid', '项目证据分组必须是摘要、修改文件、生成产物、原始版本、会话关联或全部文件。');
  return {
    available: true,
    group,
    project: projectEvidence.project,
    summary: projectEvidence.summary,
    architecture: projectEvidence.architecture,
    git: projectEvidence.git,
    count: selected.length,
    files: selected.slice(0, maximumResults).map(compactProjectFile),
  };
}

function compactEvolution(item) {
  return {
    path: item.path,
    kind: item.kind || null,
    projectRole: item.projectRole || null,
    changeState: item.changeState || null,
    confidence: item.confidence || null,
    conversationEvidence: (item.conversationEvidence || []).slice(0, 12),
    commands: (item.commands || []).slice(0, 12),
    lineage: (item.lineage || []).slice(0, 24),
    dependencies: {
      imports: (item.dependencies?.imports || []).slice(0, 12),
      importedBy: (item.dependencies?.importedBy || []).slice(0, 12),
    },
    evidenceIds: (item.evidenceIds || []).slice(0, 24),
  };
}

export async function getProjectUnderstanding(agentRoot, args = {}) {
  const { projectUnderstanding } = await loadEvidence(agentRoot);
  if (!projectUnderstanding) return { available: false, message: '能力包生成时没有指定可分析项目，或该项目没有足够的文件证据。' };
  const group = String(args.group || '摘要');
  const maxItems = maximum(args.maxItems, 30, 160);
  const groups = {
    摘要: {
      purpose: projectUnderstanding.purpose || null,
      scope: projectUnderstanding.scope || null,
      projectCognition: projectUnderstanding.projectCognition || null,
      evidenceGraph: projectUnderstanding.evidenceGraph?.statistics || null,
    },
    文件演化: (projectUnderstanding.fileEvolution || []).slice(0, maxItems).map(compactEvolution),
    产物链路: (projectUnderstanding.fileEvolution || []).filter((item) => item.kind === '生成产物' && (item.lineage || []).length > 0).slice(0, maxItems).map(compactEvolution),
    冲突登记: (projectUnderstanding.conflictRegister || []).slice(0, maxItems),
    主动读取计划: (projectUnderstanding.activeReadPlan || []).slice(0, maxItems),
    全部: {
      purpose: projectUnderstanding.purpose || null,
      scope: projectUnderstanding.scope || null,
      projectCognition: projectUnderstanding.projectCognition || null,
      evidenceGraph: projectUnderstanding.evidenceGraph?.statistics || null,
      fileEvolution: (projectUnderstanding.fileEvolution || []).slice(0, maxItems).map(compactEvolution),
      generatedArtifactLineage: (projectUnderstanding.fileEvolution || []).filter((item) => item.kind === '生成产物' && (item.lineage || []).length > 0).slice(0, maxItems).map(compactEvolution),
      conflictRegister: (projectUnderstanding.conflictRegister || []).slice(0, maxItems),
      activeReadPlan: (projectUnderstanding.activeReadPlan || []).slice(0, maxItems),
    },
  };
  if (!(group in groups)) throw new HttpError(400, 'project_understanding_group_invalid', '项目理解分组必须是摘要、文件演化、产物链路、冲突登记、主动读取计划或全部。');
  const content = groups[group];
  return { available: true, group, count: Array.isArray(content) ? content.length : undefined, content };
}

function paged(items, args = {}) {
  const offset = Math.max(Number(args.offset) || 0, 0);
  const maxItems = Math.min(Math.max(Number(args.maxItems) || 100, 1), 5000);
  const source = Array.isArray(items) ? items : [];
  return {
    total: source.length,
    offset,
    count: Math.max(0, Math.min(maxItems, source.length - offset)),
    hasMore: offset + maxItems < source.length,
    nextOffset: offset + maxItems < source.length ? offset + maxItems : null,
    items: source.slice(offset, offset + maxItems),
  };
}

export async function getProjectKnowledgeV4(agentRoot, args = {}) {
  const { projectKnowledgeV4 } = await loadEvidence(agentRoot);
  if (!projectKnowledgeV4) return { available: false, message: '当前能力包没有 V4 多会话项目知识层。' };
  const group = String(args.group || '摘要');
  const groupBuilders = {
    摘要: () => ({
      schemaVersion: projectKnowledgeV4.schemaVersion,
      generatedAt: projectKnowledgeV4.generatedAt,
      name: projectKnowledgeV4.name,
      summary: projectKnowledgeV4.summary,
      coverage: projectKnowledgeV4.coverage,
      graphStatistics: projectKnowledgeV4.projectGraph?.statistics || null,
    }),
    语义阶段: () => paged(projectKnowledgeV4.semanticStages, args),
    证据账本: () => paged(projectKnowledgeV4.evidenceLedger, args),
    项目模型: () => projectKnowledgeV4.projectModel,
    项目图: () => ({
      statistics: projectKnowledgeV4.projectGraph?.statistics || null,
      nodes: paged(projectKnowledgeV4.projectGraph?.nodes, args),
      edges: paged(projectKnowledgeV4.projectGraph?.edges, args),
    }),
    文件版本: () => paged(projectKnowledgeV4.fileVersions, args),
    产物血缘: () => paged(projectKnowledgeV4.artifactLineage, args),
    跨会话时间线: () => paged(projectKnowledgeV4.crossSessionTimeline, args),
    文件变更矩阵: () => paged(projectKnowledgeV4.fileChangeMatrix, args),
    依赖影响: () => projectKnowledgeV4.dependencyImpact,
    产物复现: () => paged(projectKnowledgeV4.artifactReproducibility, args),
    项目快照: () => projectKnowledgeV4.projectSnapshot,
    待补证问题: () => paged(projectKnowledgeV4.openEvidenceQuestions, args),
    后续决策: () => paged(projectKnowledgeV4.decisionConflicts, args),
    覆盖率: () => projectKnowledgeV4.coverage,
    主动读取记录: () => paged(projectKnowledgeV4.activeReadLog, args),
    全部: () => ({
      schemaVersion: projectKnowledgeV4.schemaVersion,
      generatedAt: projectKnowledgeV4.generatedAt,
      name: projectKnowledgeV4.name,
      summary: projectKnowledgeV4.summary,
      semanticStages: paged(projectKnowledgeV4.semanticStages, args),
      evidenceLedger: paged(projectKnowledgeV4.evidenceLedger, args),
      projectModel: projectKnowledgeV4.projectModel,
      projectGraph: {
        statistics: projectKnowledgeV4.projectGraph?.statistics || null,
        nodes: paged(projectKnowledgeV4.projectGraph?.nodes, args),
        edges: paged(projectKnowledgeV4.projectGraph?.edges, args),
      },
      fileVersions: paged(projectKnowledgeV4.fileVersions, args),
      artifactLineage: paged(projectKnowledgeV4.artifactLineage, args),
      crossSessionTimeline: paged(projectKnowledgeV4.crossSessionTimeline, args),
      fileChangeMatrix: paged(projectKnowledgeV4.fileChangeMatrix, args),
      dependencyImpact: projectKnowledgeV4.dependencyImpact,
      artifactReproducibility: paged(projectKnowledgeV4.artifactReproducibility, args),
      projectSnapshot: projectKnowledgeV4.projectSnapshot,
      openEvidenceQuestions: paged(projectKnowledgeV4.openEvidenceQuestions, args),
      decisionConflicts: paged(projectKnowledgeV4.decisionConflicts, args),
      coverage: projectKnowledgeV4.coverage,
      activeReadLog: paged(projectKnowledgeV4.activeReadLog, args),
    }),
  };
  if (!(group in groupBuilders)) throw new HttpError(400, 'project_knowledge_v4_group_invalid', '项目知识分组必须是摘要、语义阶段、证据账本、项目模型、项目图、文件版本、产物血缘、跨会话时间线、文件变更矩阵、依赖影响、产物复现、项目快照、待补证问题、后续决策、覆盖率、主动读取记录或全部。');
  return { available: true, group, content: groupBuilders[group]() };
}

export async function searchProjectEvidence(agentRoot, args = {}) {
  const query = String(args.query || '').trim().toLocaleLowerCase('zh-CN');
  if (!query) throw new HttpError(400, 'query_required', '搜索项目证据时必须提供关键词。');
  const { projectEvidence } = await loadEvidence(agentRoot);
  if (!projectEvidence) return { available: false, query: args.query, count: 0, results: [] };
  const group = String(args.group || '全部文件');
  const source = group === '修改文件' ? projectEvidence.modifiedFiles || []
    : group === '生成产物' ? projectEvidence.generatedFiles || []
      : group === '原始版本' ? projectEvidence.originalFiles || []
        : group === '会话关联' ? projectEvidence.conversationLinks || []
          : projectEvidence.files || [];
  const results = source.filter((item) => includes(item.path, query) || includes(item.currentExcerpt, query) || includes(item.diffExcerpt, query) || includes(item.original?.excerpt || item.excerpt, query)).slice(0, maximum(args.maxResults, 20, 100)).map(compactProjectFile);
  return { available: true, query: args.query, group, count: results.length, results };
}

export async function createExecutionPlan(agentRoot, args = {}) {
  const task = String(args.task || '').trim();
  if (!task) throw new HttpError(400, 'task_required', '生成执行计划时必须提供任务内容。');
  const { extraction, contract, projectPortfolio, projectEvidence, projectUnderstanding, projectKnowledgeV4 } = await loadEvidence(agentRoot);
  return {
    task,
    createdAt: new Date().toISOString(),
    latestCorrections: (extraction.corrections || []).slice(0, 12),
    steps: extraction.improvedWorkflow || [],
    acceptanceMatrix: extraction.acceptanceMatrix || [],
    permissions: contract.tools.filter((tool) => tool.permission !== '始终开放').map((tool) => ({ tool: tool.name, permission: tool.permission })),
    projectPortfolio: projectPortfolio ? { crossProject: projectPortfolio.crossProject, recommendedMode: projectPortfolio.recommendedMode, projects: (projectPortfolio.projects || []).map((item) => ({ projectId: item.projectId, name: item.name, root: item.root, sessionCount: item.sessionCount, confidence: item.confidence })), sessionAssignments: projectPortfolio.sessionAssignments || [] } : null,
    projectEvidence: projectEvidence?.summary || null,
    projectUnderstanding: projectUnderstanding ? {
      purpose: projectUnderstanding.purpose || null,
      activeReadPlan: (projectUnderstanding.activeReadPlan || []).slice(0, 12),
      conflictRegister: (projectUnderstanding.conflictRegister || []).slice(0, 12),
      fileEvolution: (projectUnderstanding.fileEvolution || []).slice(0, 24).map(compactEvolution),
    } : null,
    projectKnowledgeV4: projectKnowledgeV4 ? {
      summary: projectKnowledgeV4.summary,
      semanticStages: (projectKnowledgeV4.semanticStages || []).map((item) => ({ id: item.id, title: item.title, purpose: item.purpose, evidenceIds: item.evidenceIds })),
      projectModel: projectKnowledgeV4.projectModel,
      decisionConflicts: (projectKnowledgeV4.decisionConflicts || []).slice(0, 30),
      fileChangeMatrix: (projectKnowledgeV4.fileChangeMatrix || []).slice(0, 60),
      dependencyImpact: projectKnowledgeV4.dependencyImpact,
      artifactReproducibility: (projectKnowledgeV4.artifactReproducibility || []).slice(0, 30),
      openEvidenceQuestions: (projectKnowledgeV4.openEvidenceQuestions || []).slice(0, 30),
      coverage: projectKnowledgeV4.coverage,
    } : null,
    status: '计划已生成，尚未证明文件修改或命令执行已经完成。',
  };
}

export function evidenceToolDefinitions() {
  return [
    { type: 'function', function: { name: 'search_original_conversation', description: '搜索完整原对话中的用户消息、助手回应、工具、命令和文件变更。', parameters: { type: 'object', properties: { query: { type: 'string' }, stage: { type: 'integer' }, role: { type: 'string', enum: ['user', 'assistant'] }, maxResults: { type: 'integer' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'get_original_conversation_stage', description: '读取指定需求阶段的完整提取内容。', parameters: { type: 'object', properties: { stage: { type: 'integer' } }, required: ['stage'] } } },
    { type: 'function', function: { name: 'get_requirement_changes', description: '读取全部需求演变和优先级。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'get_latest_corrections', description: '读取后续用户纠正和覆盖规则。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'get_improved_workflow', description: '读取改进工作流、验收矩阵和失败恢复规则。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'get_source_sessions', description: '读取本能力包联合蒸馏的全部来源会话，包含标题、编号、路径、哈希、记录量和工具量。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'get_project_portfolio', description: '读取多会话所属的全部项目、逐条会话归属、识别置信度和项目级证据摘要；跨项目任务应先调用此工具。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'get_project_evidence', description: '读取能力包生成时保存的项目结构、Git 基线、差异、修改文件、生成产物和会话关联文件。', parameters: { type: 'object', properties: { group: { type: 'string', enum: ['摘要', '修改文件', '生成产物', '原始版本', '会话关联', '全部文件'] }, maxResults: { type: 'integer' } } } } },
    { type: 'function', function: { name: 'get_project_understanding', description: '读取从多会话、当前文件、Git 原始版本、差异、命令和生成产物关联出的项目目的、文件演化、产物链路、冲突与主动验证计划。', parameters: { type: 'object', properties: { group: { type: 'string', enum: ['摘要', '文件演化', '产物链路', '冲突登记', '主动读取计划', '全部'] }, maxItems: { type: 'integer' } } } } },
    { type: 'function', function: { name: 'get_project_knowledge_v4', description: '读取跨会话时间线、语义阶段、逐条证据、项目模型、文件版本与变更矩阵、依赖影响、产物血缘与复现状态、项目快照、待补证问题、后续决策、覆盖率和主动读取记录。支持分页返回全量列表。', parameters: { type: 'object', properties: { group: { type: 'string', enum: ['摘要', '语义阶段', '证据账本', '项目模型', '项目图', '文件版本', '产物血缘', '跨会话时间线', '文件变更矩阵', '依赖影响', '产物复现', '项目快照', '待补证问题', '后续决策', '覆盖率', '主动读取记录', '全部'] }, offset: { type: 'integer', minimum: 0 }, maxItems: { type: 'integer', minimum: 1, maximum: 5000 } } } } },
    { type: 'function', function: { name: 'search_project_evidence', description: '按关键词搜索项目快照中的路径、当前内容、Git 原始版本和差异。', parameters: { type: 'object', properties: { query: { type: 'string' }, group: { type: 'string', enum: ['全部文件', '修改文件', '生成产物', '原始版本', '会话关联'] }, maxResults: { type: 'integer' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'create_execution_plan', description: '根据当前任务和能力契约生成证据优先执行计划。', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } } },
  ];
}

export async function executeEvidenceTool(agentRoot, name, args) {
  if (name === 'search_original_conversation') return searchConversation(agentRoot, args);
  if (name === 'get_original_conversation_stage') return getStage(agentRoot, args);
  if (name === 'get_requirement_changes') return getRequirementChanges(agentRoot);
  if (name === 'get_latest_corrections') return getLatestCorrections(agentRoot);
  if (name === 'get_improved_workflow') return getImprovedWorkflow(agentRoot);
  if (name === 'get_source_sessions') return getSourceSessions(agentRoot);
  if (name === 'get_project_portfolio') return getProjectPortfolio(agentRoot);
  if (name === 'get_project_evidence') return getProjectEvidence(agentRoot, args);
  if (name === 'get_project_understanding') return getProjectUnderstanding(agentRoot, args);
  if (name === 'get_project_knowledge_v4') return getProjectKnowledgeV4(agentRoot, args);
  if (name === 'search_project_evidence') return searchProjectEvidence(agentRoot, args);
  if (name === 'create_execution_plan') return createExecutionPlan(agentRoot, args);
  return null;
}
