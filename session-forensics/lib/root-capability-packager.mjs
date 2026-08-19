import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_ROOT,
  writeAnalysisArtifacts,
} from './session-forensics.mjs';
import { applyConversationUiOverrides, distillConversationUi } from './conversation-ai-distiller.mjs';
import { loadConversationSources } from './conversation-evidence-sources.mjs';
import { discoverRelatedProjects, projectDiscoveryMarkdown, projectPortfolioMarkdown } from './project-discovery.mjs';
import { analyseProjectEvidence, projectEvidenceMarkdown } from './project-evidence.mjs';
import { buildProjectUnderstanding, projectUnderstandingMarkdown } from './project-understanding.mjs';
import { buildProjectKnowledgeV4, knowledgeV4Markdown, ndjson } from './project-knowledge-v4.mjs';
import { buildDistillationRecommendation, distillationRecommendationHtml, distillationRecommendationMarkdown } from './distillation-recommendation.mjs';
import { normalizeScopePolicy } from './scope-policy.mjs';
import { buildPackageWorkCapability, evidenceLedgerNdjson } from './package-work-capability.mjs';
import { evaluateHeldOutSuite } from './evaluation/held-out-evaluator.mjs';
import { validateAgentRuntimeInIsolation } from './evaluation/isolated-agent-validator.mjs';
import { replayOriginalTask } from './evaluation/original-task-replay.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = path.resolve(MODULE_DIR, '..', 'templates', 'root-capability');
const TARGETS = ['skill', 'mcp', 'agent'];

export const ROOT_CAPABILITY_PACKAGES_ROOT = path.join(WORKSPACE_ROOT, 'output', 'conversation-packages');

function cleanText(value, maximum = 64000) {
  const text = String(value ?? '').replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\n……内容过长，已保留前 ${maximum} 个字符。`;
}

function unique(values, maximum = 200) {
  return [...new Set((values || []).map((value) => cleanText(value, 4000)).filter(Boolean))].slice(0, maximum);
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function normalizeTargets(targets) {
  const selected = unique(Array.isArray(targets) ? targets : TARGETS, 10);
  const invalid = selected.filter((item) => !TARGETS.includes(item));
  if (invalid.length) throw new Error(`不支持的能力包目标：${invalid.join('、')}。`);
  return selected.length ? selected : TARGETS;
}

function safePackageId(value, fallback) {
  const normalized = slug(value);
  if (/^[a-z0-9][a-z0-9-]{2,62}$/.test(normalized)) return normalized;
  return fallback;
}

function isGenericIdentity(value) {
  const normalized = String(value || '').trim();
  return !normalized
    || /^(conversation|session|package|capability|conversation-ai|conversation-\w+|.*019ffb5e.*)$/i.test(normalized)
    || /^(完整会话|目标会话|独立人工智能|会话.*)(能力包|智能体|工作流)?$/i.test(normalized);
}

function countSemanticSignals(corpus, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return (String(corpus || '').match(new RegExp(pattern.source, flags)) || []).length;
}

function semanticNamingProfile(corpus) {
  const profiles = [
    {
      id: 'sanguosha-wuhu-comment-video-insight-report',
      name: '三国杀 WUHU 评论与视频洞察报告自动化能力包',
      topics: ['三国杀', 'WUHU', '评论与视频数据', '玩家洞察', '报告自动化'],
      signals: [[/三国杀/iu, 15], [/\bWUHU\b/iu, 15], [/评论/gu, 4], [/视频/gu, 4], [/洞察|扎根分析/gu, 3], [/报告/gu, 2]],
      minimum: 18,
    },
    {
      id: 'multi-conversation-project-evidence-distiller',
      name: '多会话项目证据蒸馏与可执行 Agent 生成能力包',
      topics: ['多会话', '项目证据', '工作能力蒸馏', '可执行 Agent'],
      signals: [[/蒸馏/gu, 4], [/多会话|多个对话/gu, 7], [/证据图谱|项目证据/gu, 5], [/能力包/gu, 2], [/独立\s*Agent|执行型\s*Agent/giu, 3]],
      minimum: 18,
    },
    {
      id: 'codex-startup-performance-repair',
      name: 'Codex 启动卡顿诊断与持久化修复 Agent 能力包',
      topics: ['Codex', '启动卡顿', '性能诊断', '持久化修复'],
      signals: [[/\bCodex\b/giu, 2], [/卡顿|变卡|特别卡|很卡|输入卡/gu, 9], [/重启|开机|启动/gu, 3], [/修复|性能|响应/gu, 2]],
      minimum: 16,
    },
    {
      id: 'ppt-version-merge-presentation-rebuild',
      name: 'PPT 多版本融合与高质量演示文稿重构能力包',
      topics: ['PPT', '多版本融合', '演示文稿重构'],
      signals: [[/\bPPT\b|PowerPoint/giu, 12], [/多版本|融合/gu, 5], [/演示文稿/gu, 6], [/重构|重组|高质量/gu, 3]],
      minimum: 15,
    },
    {
      id: 'comment-video-insight-report',
      name: '评论与视频数据洞察报告自动化能力包',
      topics: ['评论与视频数据', '内容洞察', '报告自动化'],
      signals: [[/评论/gu, 5], [/视频/gu, 5], [/洞察|分析/gu, 3], [/报告/gu, 3]],
      minimum: 16,
    },
  ];
  const ranked = profiles.map((profile) => ({
    ...profile,
    score: profile.signals.reduce((total, [pattern, weight]) => total + countSemanticSignals(corpus, pattern) * weight, 0),
  })).filter((profile) => profile.score >= profile.minimum)
    .sort((left, right) => right.score - left.score || profiles.indexOf(left) - profiles.indexOf(right));
  const selected = ranked[0];
  if (!selected) return null;
  return { id: selected.id, name: selected.name, topics: selected.topics, score: selected.score };
}

function detectIdentity(analysis, parsed, sourceSet = null, projectEvidence = null) {
  const corpus = [
    ...(analysis.episodes || []).map((episode) => episode.requestContent || episode.request),
    ...(parsed.messages || []).filter((message) => message.actor === 'user').map((message) => message.text),
    ...(analysis.codeArtifacts?.fileChanges || []).map((item) => item.path),
    ...(sourceSet?.sessions || []).map((item) => item.title),
    projectEvidence?.project?.name || '',
    ...(projectEvidence?.architecture?.manifests || []).map((item) => item.path),
    ...(projectEvidence?.architecture?.likelyEntryFiles || []),
  ].join('\n');
  const semanticProfile = semanticNamingProfile(corpus);
  const topicRules = [
    [/三国杀/i, '三国杀', 'sanguosha'],
    [/\bWUHU\b/i, 'WUHU', 'wuhu'],
    [/抖音|douyin/i, '抖音', 'douyin'],
    [/评论|comment/i, '评论数据', 'comment'],
    [/视频|video/i, '视频数据', 'video'],
    [/玩家|用户语境|语境/i, '玩家语境', 'player-context'],
    [/扎根分析|grounded/i, '扎根分析', 'grounded-analysis'],
    [/营销|marketing|\bMKT\b/i, '营销洞察', 'mkt'],
    [/受众|audience/i, '受众量化', 'audience'],
    [/报告|report|文档/i, '报告生成与升级', 'report'],
    [/会话|conversation|session/i, '原对话提取与改进', 'conversation'],
  ];
  const matches = topicRules.filter(([pattern]) => pattern.test(corpus));
  const observedTools = unique([
    ...(analysis.skillBlueprint?.observedTools || []),
    ...(analysis.toolCatalog || []).map((item) => item.name),
  ], 160);
  const hasExec = observedTools.some((name) => /exec|shell|command|terminal/i.test(name));
  const hasEdit = observedTools.some((name) => /patch|write|edit|file/i.test(name)) || (analysis.codeArtifacts?.fileChanges || []).length > 0;
  const labels = semanticProfile?.topics || unique(matches.map(([, label]) => label), 7);
  const ids = semanticProfile ? [semanticProfile.id] : unique(matches.map(([, , id]) => id), 5);
  if (hasExec) ids.push('exec');
  if (hasEdit) ids.push('edit');
  const id = safePackageId(ids.join('-').slice(0, 63), `conversation-root-agent-${String(parsed.sessionId || 'session').slice(0, 8).toLowerCase()}`);
  const toolLabel = [hasExec ? '命令执行' : '', hasEdit ? '文件修改' : '', '证据验证'].filter(Boolean).join('、');
  const subject = labels.length ? labels.join('、') : projectEvidence?.project?.name || '完整会话工作流';
  const sourceLabel = Number(sourceSet?.sessionCount || 1) > 1 ? `${sourceSet.sessionCount} 条会话联合` : '完整会话';
  const projectLabel = projectEvidence?.project?.name ? `、项目 ${projectEvidence.project.name}` : '';
  return {
    id,
    name: semanticProfile?.name || `${subject}（${sourceLabel}${projectLabel}、${toolLabel}）执行型 Agent 能力包`,
    naming: {
      mode: '根据会话主题、跨会话证据、实际工具、项目结构和文件变更自动命名',
      contentTopics: labels,
      semanticProfile,
      observedTools,
      implementationFiles: unique((analysis.codeArtifacts?.fileChanges || []).map((item) => item.path), 120),
      toolTerms: [hasExec ? '命令执行' : '', hasEdit ? '文件修改' : '', '结果验证'].filter(Boolean),
      sourceSessions: (sourceSet?.sessions || []).map((item) => ({ sessionId: item.sessionId, title: item.title })),
      project: projectEvidence?.summary || null,
    },
  };
}

function refineIdentityFromDistillation(identity, ui, sourceSet = null, projectEvidence = null) {
  const ignored = /^(?:会话(?:分析|目标梳理|专属能力)?|通用(?:请求|任务|能力|工作流)|分析|洞察|执行|处理|任务|工作流|原会话目标|检查一下|继续(?:推进)?|实施本方案|优化此方案)$/u;
  const expertise = unique((ui?.expertise || [])
    .map((item) => cleanText(item?.capability || item?.title || '', 120).replace(/^P\d+\s*[｜:：]\s*/u, ''))
    .filter((item) => item.length >= 4 && !ignored.test(item)), 2);
  const topics = unique(identity?.naming?.contentTopics || [], 4);
  // Keep the business entities extracted from the original conversation. A phase-only
  // title such as "报告封装" is not sufficient to identify a reusable capability package.
  const subjectParts = unique([...topics, ...expertise], 4);
  const subject = subjectParts.join('、') || projectEvidence?.project?.name || '会话专属工作流';
  const scope = Number(sourceSet?.sessionCount || 1) > 1 ? `${sourceSet.sessionCount} 条会话联合` : '完整会话';
  const project = projectEvidence?.project?.name ? `、项目 ${projectEvidence.project.name}` : '';
  const toolTerms = unique(identity?.naming?.toolTerms || [], 3);
  const toolScope = toolTerms.length ? `、${toolTerms.join('、')}` : '';
  const name = identity?.naming?.semanticProfile?.name || `${subject}（${scope}${project}${toolScope}）执行型 Agent 能力包`;
  identity.name = cleanText(name, 180);
  identity.naming = {
    ...(identity.naming || {}),
    mode: identity?.naming?.semanticProfile ? '根据会话主导对象、核心目标、主要产物和执行方式自动命名' : '根据 P 阶段专长、联合会话、实际工具和项目证据自动命名',
    contentTopics: topics,
    distilledExpertise: expertise,
  };
  if (ui?.identity) ui.identity.packageName = identity.name;
  return identity;
}

function stageLabel(stage, index) {
  const title = cleanText(stage?.title || '', 160);
  return /^P\d+｜/.test(title) ? title : `P${index}｜${title || '会话目标梳理'}`;
}

function projectUnderstanding(projectEvidence) {
  if (!projectEvidence) return null;
  const simplify = (items, maximum = 120) => (items || []).slice(0, maximum).map((item) => ({
    path: item.path,
    kind: item.kind || null,
    language: item.language || null,
    changeState: item.changeState || item.status || null,
    projectRole: item.projectRole || null,
      originalAvailable: Boolean(item.original || item.originalAvailable),
      hasDiff: Boolean(item.diffExcerpt || item.hasDiff),
      observedInConversation: Boolean(item.observedInConversation),
      evidencePriority: Number(item.evidencePriority || 0),
      evidenceReasons: item.evidenceReasons || [],
  }));
  const understanding = projectEvidence.understanding || null;
  const compactEvolution = (understanding?.fileEvolution || []).slice(0, 120).map((item) => ({
    path: item.path,
    role: item.projectRole || item.kind || null,
    status: item.changeState || item.gitStatus || null,
    confidence: item.confidence?.level || item.confidence || null,
    sourceStages: (item.conversationEvidence || []).map((evidence) => evidence.stageLabel || `P${evidence.stage || '?'}`).slice(0, 8),
    originalAvailable: Boolean(item.original?.available),
    hasDiff: Boolean(item.diff?.available),
    generatedLineage: (item.lineage || []).map((lineage) => lineage.relation).slice(0, 6),
  }));
  return {
    summary: projectEvidence.summary,
    project: projectEvidence.project,
    scan: {
      filesScanned: projectEvidence.scan?.filesScanned || 0,
      discoveredFiles: projectEvidence.scan?.discoveredFiles || 0,
      priorityFiles: projectEvidence.scan?.priorityFiles || 0,
      truncated: Boolean(projectEvidence.scan?.truncated),
      selectionPolicy: projectEvidence.scan?.selectionPolicy || null,
    },
    architecture: {
      languages: projectEvidence.architecture?.languages || [],
      manifests: (projectEvidence.architecture?.manifests || []).map((item) => item.path),
      instructions: (projectEvidence.architecture?.instructions || []).map((item) => item.path),
      likelyEntryFiles: projectEvidence.architecture?.likelyEntryFiles || [],
    },
    git: {
      available: Boolean(projectEvidence.git?.available),
      branch: projectEvidence.git?.branch || null,
      diffStat: projectEvidence.git?.diffStat || null,
    },
    linkedFiles: simplify(projectEvidence.conversationLinks),
    modifiedFiles: simplify(projectEvidence.modifiedFiles),
    generatedFiles: simplify(projectEvidence.generatedFiles),
    originalFiles: simplify(projectEvidence.originalFiles),
    deepUnderstanding: understanding ? {
      purpose: understanding.purpose || null,
      scope: understanding.scope || null,
      evidenceGraph: understanding.evidenceGraph?.statistics || null,
      fileEvolution: compactEvolution,
      conflicts: (understanding.conflictRegister || []).slice(0, 80),
      activeReadPlan: (understanding.activeReadPlan || []).slice(0, 80),
    } : null,
  };
}

function buildConversationDistillation(identity, extraction, ui, sourceSet = null, projectEvidence = null, analysis = null) {
  const universalTools = (extraction.capabilityCatalog || []).map((item) => ({
    name: cleanText(item.name || 'unnamed_tool', 120),
    label: cleanText(item.label || item.name || '未命名工具', 120),
    category: cleanText(item.category || '其他', 120),
    description: cleanText(item.description || '按能力契约执行对应操作。', 800),
    permission: cleanText(item.permission || '始终开放', 120),
  }));
  const specializations = (ui?.specializations || []).map((item, index) => ({
    id: cleanText(item.id || `phase-p${index + 1}`, 64),
    phase: cleanText(item.phase || `P${index + 1}`, 20),
    title: cleanText(item.title || `P${index + 1}｜会话专属能力`, 180),
    goal: cleanText(item.goal || '完成该阶段在原会话中确认的目标。', 1200),
    approach: cleanText(item.approach || '先回查会话证据，再执行并核对结果。', 1600),
    deliverable: cleanText(item.deliverable || '可复核的阶段结果。', 1200),
    evidence: cleanText(item.evidence || `原会话 P${index + 1} 阶段。`, 1200),
    action: cleanText(item.action || '执行该阶段', 120),
    sourceStages: Array.isArray(item.sourceStages) ? item.sourceStages.map(Number).filter(Number.isFinite).slice(0, 8) : [index + 1],
  }));
  const expertise = (ui?.expertise?.length ? ui.expertise : specializations.map((item) => ({
    id: `expertise-${item.id}`,
    phase: item.phase,
    capability: cleanText(item.title, 180).replace(/^P\d+\s*[｜:：]\s*/, ''),
    whenToUse: item.goal,
    executionMethod: item.approach,
    deliverable: item.deliverable,
    evidence: item.evidence,
    action: item.action,
    sourceStages: item.sourceStages,
  }))).map((item, index) => ({
    id: cleanText(item.id || `expertise-p${index + 1}`, 64),
    phase: cleanText(item.phase || `P${index + 1}`, 20),
    capability: cleanText(item.capability || item.title || `P${index + 1} 会话专属能力`, 220),
    whenToUse: cleanText(item.whenToUse || item.goal || '在原会话确认的输入和目标再次出现时使用。', 1400),
    executionMethod: cleanText(item.executionMethod || item.approach || '回查会话证据 → 执行阶段做法 → 核对交付结果。', 1800),
    deliverable: cleanText(item.deliverable || '可复核的阶段结果。', 1200),
    evidence: cleanText(item.evidence || `原会话 P${index + 1} 阶段。`, 1200),
    action: cleanText(item.action || '执行该专长', 120),
    sourceStages: Array.isArray(item.sourceStages) ? item.sourceStages.map(Number).filter(Number.isFinite).slice(0, 8) : [index + 1],
  }));
  const categories = unique(universalTools.map((item) => item.category), 30);
  return {
    schemaVersion: '2.1.0',
    type: 'universal-core-multi-conversation-project-specialization',
    title: `${identity.name}：多源能力蒸馏`,
    summary: cleanText(ui?.distillationSummary
      ? `已按语义阶段蒸馏：${ui.distillationSummary}`
      : `从 ${Number(sourceSet?.sessionCount || 1)} 条完整会话${projectEvidence ? `和项目“${projectEvidence.project.name}”` : ''}中蒸馏出 ${specializations.length} 个带 P 阶段的专属能力；通用 Codex 工具底座保持完整，但不替代会话和项目中的具体目标。`, 1000),
    universalCore: {
      title: '通用 Codex 执行能力底座',
      description: `完整保留 ${universalTools.length} 项通用工具能力，用于对话检索、文件读写、命令执行、验证、Git、进程、技能与受控网页读取。蒸馏结果直接列出每项工具的中文名称、直白说明和开放条件。`,
      toolCount: universalTools.length,
      categories,
      tools: universalTools,
    },
    specializedCapabilities: specializations,
    distilledExpertise: expertise,
    semanticQuality: ui?.semanticQuality || {
      status: '未执行',
      issues: ['当前蒸馏产物未提供语义质量报告。'],
    },
    source: {
      sessionId: extraction.source?.sessionId || null,
      mode: sourceSet?.mode || 'whole-session',
      contextMode: analysis.scopePolicy?.contextMode || 'conversation-only',
      projectScope: analysis.scopePolicy?.projectScope || 'sessions-only',
      projectConfirmed: Boolean(analysis.scopePolicy?.projectConfirmed),
      projectContext: analysis.scopePolicy?.projectContext || null,
      sessionCount: Number(sourceSet?.sessionCount || 1),
      sessions: sourceSet?.sessions || [],
      stages: Number(extraction.statistics?.stages || extraction.stages?.length || 0),
      toolCalls: Number(extraction.statistics?.toolCalls || 0),
      corrections: Number(extraction.statistics?.corrections || 0),
    },
    projectUnderstanding: projectUnderstanding(projectEvidence),
  };
}

function conversationDistillationMarkdown(distillation) {
  const universal = distillation?.universalCore || {};
  const toolRows = (universal.tools || []).map((item) => `| \`${item.name}\` | ${item.label} | ${item.description} | ${item.permission} |`).join('\n') || '| - | 未识别 | 当前会话未提供通用工具目录。 | - |';
  const cell = (value) => String(value || '—').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const expertise = distillation?.distilledExpertise || [];
  const expertiseRows = expertise.map((item) => `| ${cell(`${item.phase}｜${item.capability}`)} | ${cell(item.whenToUse)} | ${cell(item.executionMethod)} |`).join('\n') || '| 未识别 | 当前会话未提供可拆分的专属专长。 | 请查看原会话阶段。 |';
  const specializationDetails = (distillation?.specializedCapabilities || []).map((item) => `### ${item.title}\n\n- **阶段目标**：${item.goal}\n- **执行做法**：${item.approach}\n- **预期交付**：${item.deliverable}\n- **原会话证据**：${item.evidence}\n- **界面操作**：点击“${item.action}”会将该阶段的目标与做法预填入真实任务。`).join('\n\n') || '尚未从当前会话识别到可拆分的需求阶段。';
  const sourceRows = (distillation?.source?.sessions || []).map((item, index) => `| ${index + 1} | ${cell(item.title)} | \`${cell(item.sessionId)}\` | ${Number(item.recordCount || 0).toLocaleString('zh-CN')} | \`${cell(item.sourcePath)}\` |`).join('\n') || '| 1 | 当前完整会话 | — | — | — |';
  const project = distillation?.projectUnderstanding;
  const projectRows = (project?.modifiedFiles || []).map((item) => `| \`${cell(item.path)}\` | ${cell(item.changeState)} | ${cell(item.projectRole)} | ${item.originalAvailable ? '已提取' : '无'} | ${item.hasDiff ? '已提取' : '无'} |`).join('\n') || '| — | 未指定项目或未发现关联文件 | — | — | — |';
  const generatedRows = (project?.generatedFiles || []).map((item) => `- \`${item.path}\`：${item.language || '未知类型'}，${item.changeState || '已识别'}。`).join('\n') || '- 未发现或未指定项目。';
  const deep = project?.deepUnderstanding;
  const evolutionRows = (deep?.fileEvolution || []).slice(0, 24).map((item) => `| \`${cell(item.path)}\` | ${cell(item.role)} | ${cell(item.status)} | ${cell((item.sourceStages || []).join('、'))} | ${cell(item.confidence)} |`).join('\n') || '| — | 未形成可验证的文件演化关系 | — | — | — |';
  const conflictRows = (deep?.conflicts || []).slice(0, 16).map((item) => `- **${cell(item.title || item.type)}**：${cell(item.detail || item.message || '')}（${cell(item.status || '待核对')}）`).join('\n') || '- 没有发现需要覆盖的冲突或待核对项。';
  const readPlanRows = (deep?.activeReadPlan || []).slice(0, 16).map((item, index) => `${index + 1}. **${cell(item.action || item.title)}**：${cell(item.target || item.path || '')}。原因：${cell(item.reason || '')}。`).join('\n') || '当前没有新增的项目读取步骤。';
  const quality = distillation?.semanticQuality || {};
  const qualityIssues = (quality.issues || []).map((item) => `- ${cell(item)}`).join('\n') || '- 未发现会导致泛化命名的缺项。';
  const qualityGuarantees = (quality.guarantees || []).map((item) => `- ${cell(item)}`).join('\n') || '- 每项专长均需关联会话阶段或项目证据。';
  const specializations = `${specializationDetails}\n\n## 语义质量检查\n\n状态：${cell(quality.status || '未执行')}；原始需求阶段：${Number(quality.sourceStageCount || 0)}；已生成专属能力：${Number(quality.specializationCount || 0)}。\n\n### 本包保证\n\n${qualityGuarantees}\n\n### 待补充证据\n\n${qualityIssues}`;
  const deepSection = deep ? `\n## 深度项目理解（证据图、文件演化与校验）\n\n项目目的：${cell(deep.purpose || '待从项目证据确认')}。\n\n范围：${Number(deep.scope?.sourceSessions || 0)} 条联合会话、${Number(deep.scope?.stages || 0)} 个语义阶段、${Number(deep.scope?.files || 0)} 个文件节点。\n\n证据图：${Number(deep.evidenceGraph?.nodes || 0)} 个节点、${Number(deep.evidenceGraph?.edges || 0)} 条关系。\n\n| 文件 | 项目角色 | 演化状态 | 会话阶段 | 证据置信度 |\n| --- | --- | --- | --- | --- |\n${evolutionRows}\n\n### 冲突与待核对项\n\n${conflictRows}\n\n### 主动读取与验证计划\n\n${readPlanRows}\n` : '';
  return `# ${distillation?.title || '会话能力蒸馏'}\n\n## 蒸馏结论\n\n${distillation?.summary || '按完整会话生成。'}\n\n## 选择的会话来源\n\n模式：${distillation?.source?.mode === 'multi-session' ? '多会话联合蒸馏' : '完整会话蒸馏'}；共 ${Number(distillation?.source?.sessionCount || 1)} 条。每条会话均完整保留原始记录、消息、工具调用和文件变更，不会只取片段。\n\n| 顺序 | 会话标题 | 会话编号 | 原始记录 | 来源文件 |\n| --- | --- | --- | --- | --- |\n${sourceRows}\n\n## 项目与文件理解\n\n${project ? `已读取项目“${project.project?.name || '未命名项目'}”。项目根目录：\`${project.project?.root || '—'}\`；Git：${project.git?.available ? `已识别（分支 ${project.git.branch || '未命名'}）` : '未识别'}；扫描 ${Number(project.summary?.scannedFiles || 0).toLocaleString('zh-CN')} 个文件；会话关联 ${Number(project.summary?.linkedFiles || 0)} 个文件；修改或新增 ${Number(project.summary?.modifiedFiles || 0)} 个文件；生成产物 ${Number(project.summary?.generatedFiles || 0)} 个。` : '本次没有指定项目文件夹；能力包仍完整保留会话证据。'}\n\n| 文件 | 当前状态 | 项目角色 | 原始版本 | Git 差异 |\n| --- | --- | --- | --- | --- |\n${projectRows}\n\n### 生成产物\n\n${generatedRows}${deepSection}\n## 从原会话提炼出的专长\n\n每一项都来自选中会话的具体需求阶段、工具轨迹、产物或后续纠正；不是通用能力清单。\n\n| 专长 | 什么时候使用 | 执行方法 |\n| --- | --- | --- |\n${expertiseRows}\n\n## 通用 Codex 执行能力底座\n\n${universal.description || '当前会话未提供通用工具目录。'}\n\n工具类别：${(universal.categories || []).join('、') || '未分类'}。\n\n### 完整通用能力说明与功能清单\n\n| 工具 | 中文名称 | 直白说明 | 开放条件 |\n| --- | --- | --- | --- |\n${toolRows}\n\n## 会话专属能力（阶段明细与证据）\n\n${specializations}\n`;
}

function buildPackageDescription(identity, analysis, extraction, targets, distillation, sourceSet = null, projectEvidence = null) {
  const phases = (extraction.stages || []).slice(0, 48).map((stage, index) => ({
    id: `P${stage.index || index + 1}`,
    title: stageLabel(stage, stage.index || index + 1),
    role: stage.classification?.label || '要求细化',
  }));
  const actualTools = unique([
    ...(analysis.skillBlueprint?.observedTools || []),
    ...(analysis.toolCatalog || []).map((item) => item.name),
  ], 24);
  const contentTopics = identity.naming?.contentTopics || [];
  const targetLabels = [
    targets.includes('skill') ? '可安装 Skill（把阶段语义、规则和执行流程带入 Codex）' : '',
    targets.includes('mcp') ? 'MCP 服务（向支持 MCP 的客户端提供会话证据和执行工具）' : '',
    targets.includes('agent') ? '独立 Agent（含中文操作界面、任务执行、文件修改、命令与验证记录）' : '',
  ].filter(Boolean);
  const phaseNames = phases.map((item) => item.title).join('；');
  const specializations = distillation?.specializedCapabilities || [];
  const expertise = distillation?.distilledExpertise || [];
  return {
    title: identity.name,
    summary: `这是围绕“${contentTopics.join('、') || '当前会话目标'}”生成的专属能力包。它联合理解 ${Number(sourceSet?.sessionCount || 1)} 条完整会话${projectEvidence ? `与项目“${projectEvidence.project.name}”` : ''}，完整保留通用 Codex 工具底座，并按跨会话语义阶段蒸馏成 ${specializations.length || phases.length} 个可追溯的 P 阶段专属能力：${phaseNames || '尚未识别出阶段'}。后续执行会优先遵循更晚的用户纠正，并以项目当前文件、Git 原始版本和差异作为文件证据。`,
    namingExplanation: `包名来自会话主题（${contentTopics.join('、') || '完整会话工作流'}）、${Number(sourceSet?.sessionCount || 1)} 条选中会话、实际观测工具（${actualTools.slice(0, 12).join('、') || '未识别'}）${projectEvidence ? `、项目 ${projectEvidence.project.name} 的结构/规则/文件差异` : ''}和文件实现证据；不是人工填写的通用名称。`,
    phases,
    specializedCapabilities: specializations.map((item) => ({ phase: item.phase, title: item.title, goal: item.goal, deliverable: item.deliverable })),
    expertise: expertise.map((item) => ({ phase: item.phase, capability: item.capability, whenToUse: item.whenToUse, executionMethod: item.executionMethod, deliverable: item.deliverable, evidence: item.evidence })),
    specializationSummary: distillation?.summary || '会话专属能力按 P 阶段生成。',
    sources: sourceSet?.sessions || [],
    projectUnderstanding: projectUnderstanding(projectEvidence),
    actualTools,
    deliverables: targetLabels,
    firstStep: targets.includes('agent')
      ? '下载并解压完整 ZIP 后，Windows 双击 install-and-start.cmd；页面会打开专属 Agent，并在首屏显示本包的目标、输入、能力、产物、P 阶段要求和系统优先建议。先点击“按建议填入任务”，再选择工作区并按需开启文件修改或命令权限。完整的排序依据同时保存在 PRIORITY-PLAN.md、distillation-recommendation.json 和 distillation-recommendation.html。'
      : '先打开 README.md 查看本包的阶段地图、能力清单和对应的使用入口。',
  };
}

function classifyChange(request, stage) {
  const value = cleanText(request, 24000);
  if (stage === 1) return { type: 'initial', label: '初始目标', priority: 10 };
  if (/太弱|太差|完全不行|不够|不足|缺少|必须|务必|从根|重做|重新创建|升级|改进|优化|纠正|不是.*而是|需要的是|必须得|必须要|too weak|not enough|must|rebuild|from scratch|upgrade|improve/i.test(value)) {
    return { type: 'correction', label: '用户纠正与升级要求', priority: 1000 + stage };
  }
  if (/还要|并且|同时|增加|补充|继续|另外|扩展|also|add|continue|expand/i.test(value)) {
    return { type: 'expansion', label: '范围扩展', priority: 500 + stage };
  }
  return { type: 'refinement', label: '要求细化', priority: 100 + stage };
}

function buildStages(analysis, parsed) {
  const episodes = analysis.episodes || [];
  return episodes.map((episode, index) => {
    const start = Number(episode.triggerEventIndex || 1);
    const end = Number(episodes[index + 1]?.triggerEventIndex || Number.MAX_SAFE_INTEGER) - 1;
    const inRange = (eventIndex) => Number(eventIndex) >= start && Number(eventIndex) <= end;
    const request = cleanText(episode.requestContent || episode.request, 48000);
    const classification = classifyChange(request, index + 1);
    const messages = (parsed.messages || []).filter((item) => inRange(item.eventIndex)).map((item) => ({
      eventIndex: item.eventIndex,
      timestamp: item.timestamp || null,
      actor: item.actor,
      channel: item.channel || null,
      contextKind: item.contextKind || null,
      sourceSessionId: item.sourceSessionId || null,
      sourceTitle: item.sourceTitle || null,
      sourcePath: item.sourcePath || null,
      text: cleanText(item.text, 48000),
    }));
    const toolCalls = (parsed.toolCalls || []).filter((item) => inRange(item.eventIndex)).map((item) => ({
      eventIndex: item.eventIndex,
      timestamp: item.timestamp || null,
      name: item.name,
      callId: item.callId || null,
      arguments: cleanText(item.argumentsExcerpt, 16000),
      argumentKeys: item.argumentSchema || [],
      nestedTools: item.nestedTools || [],
      durationMs: item.durationMs ?? null,
      sourceSessionId: item.sourceSessionId || null,
      sourceTitle: item.sourceTitle || null,
      sourcePath: item.sourcePath || null,
      result: item.output ? {
        eventIndex: item.output.eventIndex,
        success: item.output.success,
        excerpt: cleanText(item.output.excerpt, 24000),
      } : null,
    }));
    const commands = (analysis.codeArtifacts?.commands || []).filter((item) => inRange(item.eventIndex)).map((item) => ({
      eventIndex: item.eventIndex,
      tool: item.tool,
      category: item.category,
      command: cleanText(item.command, 16000),
      sourceSessionId: item.sourceSessionId || null,
      sourceTitle: item.sourceTitle || null,
      sourcePath: item.sourcePath || null,
    }));
    const fileChanges = (analysis.codeArtifacts?.fileChanges || []).filter((item) => inRange(item.eventIndex)).map((item) => ({
      eventIndex: item.eventIndex,
      path: item.path,
      action: item.action,
      tool: item.tool || null,
      sourceSessionId: item.sourceSessionId || null,
      sourceTitle: item.sourceTitle || null,
      sourcePath: item.sourcePath || null,
    }));
    return {
      index: index + 1,
      title: episode.title || `需求阶段 ${index + 1}`,
      timestamp: episode.timestamp || null,
      eventRange: [start, Number.isFinite(end) ? end : null],
      request,
      classification,
      messages,
      userMessages: messages.filter((item) => item.actor === 'user'),
      assistantMessages: messages.filter((item) => item.actor === 'assistant'),
      toolCalls,
      commands,
      fileChanges,
      sourceSessions: unique([
        ...messages.map((item) => item.sourceSessionId),
        ...toolCalls.map((item) => item.sourceSessionId),
        ...fileChanges.map((item) => item.sourceSessionId),
      ], 24),
      sourceTitles: unique([
        ...messages.map((item) => item.sourceTitle),
        ...toolCalls.map((item) => item.sourceTitle),
        ...fileChanges.map((item) => item.sourceTitle),
      ], 24),
      outcome: {
        toolCallCount: toolCalls.length,
        succeeded: toolCalls.filter((item) => item.result?.success === true).length,
        failed: toolCalls.filter((item) => item.result && item.result.success !== true).length,
        changedFileCount: fileChanges.length,
      },
    };
  });
}

function normalizeStageSemanticText(value) {
  return cleanText(value, 48000)
    .replace(/^P\d+\s*[|｜:：-]?\s*/iu, '')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function stageSemanticKey(stage) {
  const title = normalizeStageSemanticText(stage?.title);
  const request = normalizeStageSemanticText(stage?.request);
  if (!title && !request) return `stage-${stage?.index || 'unknown'}`;
  return `${title}\n${request}`;
}

function stagePreference(stage) {
  const authority = Number(stage?.sourceAuthorityRank);
  const priority = Number(stage?.classification?.priority) || 0;
  const timestamp = Date.parse(stage?.timestamp || '') || 0;
  return [Number.isFinite(authority) ? authority : 9999, -priority, -timestamp, Number(stage?.index) || 9999];
}

function isPreferredStage(candidate, current) {
  const candidateRank = stagePreference(candidate);
  const currentRank = stagePreference(current);
  for (let index = 0; index < candidateRank.length; index += 1) {
    if (candidateRank[index] !== currentRank[index]) return candidateRank[index] < currentRank[index];
  }
  return false;
}

function mergeStageRecords(existing, incoming, keyFields) {
  const seen = new Set();
  const output = [];
  for (const item of [...(existing || []), ...(incoming || [])]) {
    if (!item || typeof item !== 'object') continue;
    const key = keyFields.map((field) => item[field] ?? '').join('\\u001f');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function consolidateStages(rawStages) {
  const groups = new Map();
  for (const raw of rawStages) {
    const sourceAuthorityRank = raw.sourceAuthorityRank ?? null;
    const entry = {
      ...raw,
      originalStageIndexes: [Number(raw.index) || 0].filter(Boolean),
      mergedFrom: [{
        stage: Number(raw.index) || null,
        title: raw.title || null,
        sourceSessions: raw.sourceSessions || [],
        sourceAuthorityRank,
      }],
    };
    const key = stageSemanticKey(raw);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, entry);
      continue;
    }
    const preferred = isPreferredStage(entry, current) ? entry : current;
    const other = preferred === current ? entry : current;
    const start = Math.min(Number(current.eventRange?.[0]) || Number.MAX_SAFE_INTEGER, Number(entry.eventRange?.[0]) || Number.MAX_SAFE_INTEGER);
    const currentEnd = current.eventRange?.[1];
    const entryEnd = entry.eventRange?.[1];
    const end = currentEnd == null || entryEnd == null
      ? null
      : Math.max(Number(currentEnd) || 0, Number(entryEnd) || 0);
    const timestamps = [current.timestamp, entry.timestamp].filter(Boolean).sort();
    const merged = {
      ...preferred,
      timestamp: timestamps[0] || preferred.timestamp || null,
      eventRange: [start === Number.MAX_SAFE_INTEGER ? null : start, end],
      request: preferred.request || other.request || '',
      messages: mergeStageRecords(current.messages, entry.messages, ['sourceSessionId', 'eventIndex', 'actor', 'text']),
      userMessages: mergeStageRecords(current.userMessages, entry.userMessages, ['sourceSessionId', 'eventIndex', 'actor', 'text']),
      assistantMessages: mergeStageRecords(current.assistantMessages, entry.assistantMessages, ['sourceSessionId', 'eventIndex', 'actor', 'text']),
      toolCalls: mergeStageRecords(current.toolCalls, entry.toolCalls, ['sourceSessionId', 'eventIndex', 'name', 'callId']),
      commands: mergeStageRecords(current.commands, entry.commands, ['sourceSessionId', 'eventIndex', 'tool', 'command']),
      fileChanges: mergeStageRecords(current.fileChanges, entry.fileChanges, ['sourceSessionId', 'eventIndex', 'path', 'action']),
      sourceSessions: unique([...current.sourceSessions, ...entry.sourceSessions], 24),
      sourceTitles: unique([...current.sourceTitles, ...entry.sourceTitles], 24),
      originalStageIndexes: [...new Set([...(current.originalStageIndexes || []), ...(entry.originalStageIndexes || [])])].sort((a, b) => a - b),
      mergedFrom: [...(current.mergedFrom || []), ...(entry.mergedFrom || [])],
    };
    merged.outcome = {
      toolCallCount: merged.toolCalls.length,
      succeeded: merged.toolCalls.filter((item) => item.result?.success === true).length,
      failed: merged.toolCalls.filter((item) => item.result && item.result.success !== true).length,
      changedFileCount: merged.fileChanges.length,
    };
    groups.set(key, merged);
  }
  return [...groups.values()]
    .sort((a, b) => {
      const left = Math.min(...(a.originalStageIndexes || [Number.MAX_SAFE_INTEGER]));
      const right = Math.min(...(b.originalStageIndexes || [Number.MAX_SAFE_INTEGER]));
      return left - right;
    })
    .map((stage, index) => {
      const title = normalizeStageSemanticText(stage.title) || `会话目标梳理 ${index + 1}`;
      const displayTitle = title.charAt(0).toLocaleUpperCase() + title.slice(1);
      return {
        ...stage,
        index: index + 1,
        title: `P${index + 1}｜${displayTitle}`,
        mergedStageCount: stage.originalStageIndexes?.length || 1,
      };
    });
}

function toolDefinition(name, label, category, description, permission = '始终开放') {
  return { name, label, category, description, permission };
}

function buildCapabilityCatalog() {
  return [
    toolDefinition('search_original_conversation', '搜索原对话', '原对话证据', '按关键词、角色、阶段和工具名称检索完整会话证据。'),
    toolDefinition('get_original_conversation_stage', '读取需求阶段', '原对话证据', '读取某个阶段的用户原话、助手回应、工具调用、命令和文件变更。'),
    toolDefinition('get_requirement_changes', '读取需求演变', '原对话证据', '按时间和优先级读取初始目标、扩展、细化与纠正。'),
    toolDefinition('get_latest_corrections', '读取最新纠正', '原对话证据', '优先读取后续纠正，避免继续执行已经被否定的旧方案。'),
    toolDefinition('get_improved_workflow', '读取升级流程', '执行规划', '读取证据优先、执行、验证和恢复的统一工作流。'),
    toolDefinition('create_execution_plan', '生成执行计划', '执行规划', '把当前任务、原对话纠正、所需工具和验收标准编译为可执行计划。'),
    toolDefinition('list_files', '浏览工作区', '本地文件', '递归或分层列出工作区目录与文件。', '选择有效工作区'),
    toolDefinition('stat_path', '检查路径', '本地文件', '读取文件或目录的大小、时间和类型。', '选择有效工作区'),
    toolDefinition('search_files', '搜索文件内容', '本地文件', '在工作区文本文件中搜索关键词并返回行号。', '选择有效工作区'),
    toolDefinition('read_file', '读取文件', '本地文件', '按行读取 UTF-8 文本文件。', '选择有效工作区'),
    toolDefinition('create_directory', '创建目录', '本地修改', '在工作区边界内创建目录。', '开启文件写入'),
    toolDefinition('write_file', '写入文件', '本地修改', '创建或完整写入文本文件，并在覆盖前保存检查点。', '开启文件写入'),
    toolDefinition('replace_text', '精确替换', '本地修改', '要求旧文本唯一匹配后进行替换，并记录前后差异。', '开启文件写入'),
    toolDefinition('apply_edits', '批量编辑', '本地修改', '一次提交多个精确替换，任何一项失败则不写入。', '开启文件写入'),
    toolDefinition('move_path', '移动或重命名', '本地修改', '在工作区内移动文件或目录。', '开启文件写入'),
    toolDefinition('delete_path', '删除路径', '本地修改', '删除前自动保存检查点，只允许删除工作区内部路径。', '开启删除权限'),
    toolDefinition('create_checkpoint', '创建检查点', '恢复与审计', '为指定文件或目录创建可恢复副本。', '开启文件写入'),
    toolDefinition('restore_checkpoint', '恢复检查点', '恢复与审计', '把文件或目录恢复到某个已记录检查点。', '开启文件写入'),
    toolDefinition('get_change_journal', '读取变更记录', '恢复与审计', '查看本次任务修改过的文件、哈希和检查点。'),
    toolDefinition('execute_command', '执行本地命令', '本地命令', '在工作区中执行命令，返回退出码、输出、耗时和超时状态。', '开启命令执行'),
    toolDefinition('run_verification', '运行验收命令', '结果验证', '执行一个或多个检查命令并形成结构化验收结果。', '开启命令执行'),
    toolDefinition('inspect_project', '识别项目结构', '项目理解', '识别项目语言、构建文件、依赖清单、测试入口和 Git 仓库状态，先理解项目再动手。', '选择有效工作区'),
    toolDefinition('read_project_instructions', '读取项目说明', '项目理解', '读取工作区内的 AGENTS.md、README、贡献说明和项目约定，避免忽略仓库规则。', '选择有效工作区'),
    toolDefinition('apply_patch', '应用标准补丁', '代码修改', '应用带文件路径和上下文的标准补丁；写入前创建检查点，任一块不匹配则停止。', '开启文件写入'),
    toolDefinition('get_file_diff', '查看文件差异', '代码审查', '根据当前文件和指定检查点生成可读的行级差异，用于审查修改是否准确。', '选择有效工作区'),
    toolDefinition('git_status', '读取 Git 状态', 'Git 版本控制', '读取当前分支、已修改、未跟踪和暂存文件，不修改仓库。', '开启命令执行'),
    toolDefinition('git_diff', '读取 Git 差异', 'Git 版本控制', '读取工作区 Git 差异，可按文件或暂存状态过滤，不修改仓库。', '开启命令执行'),
    toolDefinition('git_log', '读取 Git 历史', 'Git 版本控制', '读取最近提交的摘要、作者和时间，用于理解变更背景。', '开启命令执行'),
    toolDefinition('git_branch', '读取 Git 分支', 'Git 版本控制', '读取当前分支及本地分支列表，不修改仓库。', '开启命令执行'),
    toolDefinition('git_commit', '创建 Git 提交', 'Git 版本控制', '在明确开启 Git 写入后，以指定信息提交已暂存内容；不会推送远程仓库。', '开启 Git 写入'),
    toolDefinition('start_process', '启动长期进程', '终端与进程', '启动开发服务器、监视器或交互式脚本，保留进程编号和输出供后续读取。', '开启命令执行'),
    toolDefinition('read_process_output', '读取进程输出', '终端与进程', '读取长期进程从指定位置开始的标准输出、错误输出和退出状态。', '开启命令执行'),
    toolDefinition('write_process_input', '写入进程输入', '终端与进程', '向仍在运行的交互式本地进程写入一行输入。', '开启命令执行'),
    toolDefinition('stop_process', '停止长期进程', '终端与进程', '停止指定的本地长期进程，并保留其最后输出。', '开启命令执行'),
    toolDefinition('list_processes', '查看长期进程', '终端与进程', '列出当前能力包启动且仍受管理的本地长期进程。', '开启命令执行'),
    toolDefinition('list_skills', '列出可用技能', '技能与扩展', '扫描配置的 Codex 技能目录，显示可复用技能名称、说明和路径。'),
    toolDefinition('read_skill', '读取技能说明', '技能与扩展', '读取指定可用技能的 SKILL.md，以便按既有工作流执行。'),
    toolDefinition('fetch_url', '联网读取页面', '网页取证', '在明确开启网络访问后读取公开网页内容，记录最终地址、状态和截断信息。', '开启网络访问'),
  ];
}

function buildImprovedWorkflow(stages) {
  const correctionStages = stages.filter((stage) => stage.classification.type === 'correction').map((stage) => stage.index);
  return [
    { order: 1, name: '确定当前目标和覆盖关系', description: '先读取最新用户要求，明确哪些后续纠正覆盖早期做法。', requiredTools: ['get_requirement_changes', 'get_latest_corrections'], sourceStages: correctionStages },
    { order: 2, name: '检索原对话直接证据', description: '检索相关用户原话、助手回应、工具参数、结果、命令和文件变更。', requiredTools: ['search_original_conversation', 'get_original_conversation_stage'], sourceStages: stages.slice(-8).map((stage) => stage.index) },
    { order: 3, name: '理解项目和现有约定', description: '识别项目语言、构建入口、Git 上下文以及 AGENTS.md、README 等仓库规则，再检查具体文件。', requiredTools: ['inspect_project', 'read_project_instructions', 'git_status', 'list_files', 'search_files', 'read_file'], sourceStages: [] },
    { order: 4, name: '生成可执行计划与验收项', description: '列出要修改的文件、要运行的命令、失败恢复和完成标准。', requiredTools: ['create_execution_plan'], sourceStages: correctionStages },
    { order: 5, name: '带检查点执行并审查补丁', description: '在写入前创建检查点，优先使用标准补丁或精确修改，并在提交前查看文件与 Git 差异。', requiredTools: ['create_checkpoint', 'apply_patch', 'write_file', 'replace_text', 'apply_edits', 'get_file_diff', 'git_diff'], sourceStages: [] },
    { order: 6, name: '运行命令、长期服务和自动验收', description: '执行构建、测试、语法检查；需要开发服务时启动可读取、可停止的长期进程。', requiredTools: ['execute_command', 'start_process', 'read_process_output', 'run_verification'], sourceStages: [] },
    { order: 7, name: '失败恢复与继续执行', description: '工具失败时保留证据；按错误调整参数，必要时恢复检查点后继续。', requiredTools: ['get_change_journal', 'restore_checkpoint'], sourceStages: [] },
    { order: 8, name: '交付结果和审计记录', description: '直白列出完成内容、修改文件、命令结果、剩余问题和可恢复点。', requiredTools: ['get_change_journal'], sourceStages: [] },
  ];
}

function buildExtraction(analysis, parsed, { sourceSet = null, projectEvidence = null } = {}) {
  const rawStages = buildStages(analysis, parsed);
  const authorityBySession = new Map((sourceSet?.sessions || []).map((source) => [source.sessionId, Number(source.authorityRank) || null]));
  const applyAuthority = (stage) => {
    const ranks = stage.sourceSessions.map((sessionId) => authorityBySession.get(sessionId)).filter((rank) => Number.isFinite(rank));
    stage.sourceAuthorityRank = ranks.length ? Math.min(...ranks) : null;
    stage.sourceAuthorityReason = stage.sourceAuthorityRank
      ? (sourceSet?.authority || []).find((source) => source.rank === stage.sourceAuthorityRank)?.reason || null
      : null;
  };
  rawStages.forEach(applyAuthority);
  const stages = consolidateStages(rawStages);
  stages.forEach(applyAuthority);
  const corrections = stages.filter((stage) => stage.classification.type === 'correction').map((stage) => ({
    stage: stage.index,
    originalStageIndexes: stage.originalStageIndexes || [stage.index],
    mergedStageCount: stage.mergedStageCount || 1,
    priority: stage.classification.priority,
    authorityRank: stage.sourceAuthorityRank,
    authorityReason: stage.sourceAuthorityReason,
    title: stage.title,
    request: stage.request,
    rule: '该要求覆盖与其冲突的早期做法，执行和验收时必须优先满足。',
  })).sort((a, b) => (Number(a.authorityRank || 9999) - Number(b.authorityRank || 9999)) || (b.priority - a.priority));
  const requirementEvolution = stages.map((stage) => ({
    stage: stage.index,
    originalStageIndexes: stage.originalStageIndexes || [stage.index],
    mergedStageCount: stage.mergedStageCount || 1,
    title: stage.title,
    type: stage.classification.type,
    label: stage.classification.label,
    priority: stage.classification.priority,
    authorityRank: stage.sourceAuthorityRank,
    authorityReason: stage.sourceAuthorityReason,
    request: stage.request,
  }));
  const capabilityCatalog = buildCapabilityCatalog();
  const improvedWorkflow = buildImprovedWorkflow(stages);
  const acceptanceMatrix = [
    { id: 'evidence-first', title: '先取证再执行', passCondition: '变更前至少读取一条相关原对话证据和当前工作区文件。', evidence: ['工具轨迹', '原对话命中记录'] },
    { id: 'latest-wins', title: '最新纠正优先', passCondition: '结果逐条覆盖所有后续纠正，不继续沿用被否定的旧方案。', evidence: corrections.map((item) => `阶段 ${item.stage}`) },
    { id: 'real-changes', title: '真实修改', passCondition: '所有文件修改都有路径、前后哈希、差异或检查点记录。', evidence: ['变更日志'] },
    { id: 'verified', title: '命令验证', passCondition: '要求验证时必须有实际命令、退出码和输出摘要。', evidence: ['验收命令记录'] },
    { id: 'recoverable', title: '可恢复', passCondition: '覆盖或删除前保存检查点，失败时可恢复。', evidence: ['检查点清单'] },
    { id: 'truthful', title: '结果如实', passCondition: '未执行、失败和仍需人工判断的部分必须明确标注。', evidence: ['最终结果'] },
  ];
  const timeline = [
    ...(parsed.messages || []).map((item) => ({ kind: 'message', eventIndex: item.eventIndex, timestamp: item.timestamp || null, actor: item.actor, sourceSessionId: item.sourceSessionId || null, sourceTitle: item.sourceTitle || null, sourcePath: item.sourcePath || null, text: cleanText(item.text, 48000) })),
    ...(parsed.toolCalls || []).map((item) => ({ kind: 'tool', eventIndex: item.eventIndex, timestamp: item.timestamp || null, name: item.name, callId: item.callId || null, sourceSessionId: item.sourceSessionId || null, sourceTitle: item.sourceTitle || null, sourcePath: item.sourcePath || null, arguments: cleanText(item.argumentsExcerpt, 16000), result: item.output ? { success: item.output.success, excerpt: cleanText(item.output.excerpt, 24000) } : null })),
  ].sort((a, b) => Number(a.eventIndex) - Number(b.eventIndex));
  const observedFiles = unique((analysis.codeArtifacts?.fileChanges || []).map((item) => item.path), 600);
  const weaknesses = unique([
    ...corrections.map((item) => `阶段 ${item.stage} 明确指出前序方案需要升级：${cleanText(item.request, 600)}`),
    ...(analysis.toolCatalog || []).filter((item) => item.failed > 0).map((item) => `工具 ${item.name} 出现 ${item.failed} 次非成功结果，后续执行必须检查错误并调整。`),
  ], 60);
  return {
    schemaVersion: '3.0.0',
    generatedAt: new Date().toISOString(),
    extractionMode: sourceSet?.mode === 'multi-session'
      ? '多会话联合、每条完整会话、完整需求阶段、完整可见消息、完整工具索引、项目文件与 Git 证据'
      : '完整会话、完整需求阶段、完整可见消息、完整工具索引、项目文件与 Git 证据',
    source: analysis.source,
    sources: sourceSet?.sessions || [],
    sourceAuthority: sourceSet?.authority || [],
    projectEvidenceSummary: projectEvidence?.summary || null,
    coverage: analysis.coverage,
    summary: analysis.summary,
    requirementEvolution,
    corrections,
    stages,
    timeline,
    capabilityCatalog,
    improvedWorkflow,
    acceptanceMatrix,
    recoveryRules: [
      '工具失败后保留原始错误、参数和结果，不把失败描述为成功。',
      '文件覆盖、移动或删除前创建检查点，并把检查点编号写入变更日志。',
      '当前目标与旧阶段冲突时，以更晚的用户纠正为准。',
      '达到自动步骤上限时持久化任务状态，允许用户继续执行或恢复检查点。',
      '模型服务失败时保留任务、计划、工具轨迹和已完成修改，连接恢复后可继续。',
    ],
    strengths: unique((analysis.reusableCapabilities || []).map((item) => `${item.name}：${item.trigger || item.description || '已在原对话中形成可复用做法。'}`), 40),
    weaknesses,
    observedTools: unique((analysis.toolCatalog || []).map((item) => item.name), 240),
    observedFiles,
    statistics: {
      sourceRecords: analysis.source.recordCount,
      sessions: Number(sourceSet?.sessionCount || 1),
      stages: stages.length,
      messages: (parsed.messages || []).length,
      toolCalls: (parsed.toolCalls || []).length,
      commands: (analysis.codeArtifacts?.commands || []).length,
      fileChanges: (analysis.codeArtifacts?.fileChanges || []).length,
      corrections: corrections.length,
      projectFiles: Number(projectEvidence?.scan?.filesScanned || 0),
      projectModifiedFiles: Number(projectEvidence?.modifiedFiles?.length || 0),
      projectGeneratedFiles: Number(projectEvidence?.generatedFiles?.length || 0),
    },
  };
}

function buildBlueprint(analysis, extraction, identity, targets, skillName, redacted, ui, sourceSet = null, projectEvidence = null, projectPortfolio = null) {
  const latestCorrections = extraction.corrections.slice(0, 12);
  return {
    schemaVersion: '3.0.0',
    generatedAt: new Date().toISOString(),
    package: {
      id: identity.id,
      name: identity.name,
      type: 'root-conversation-capability-package',
      architecture: 'evidence-planner-executor-verifier-recovery',
      targets,
      naming: identity.naming,
    },
    selection: {
      mode: sourceSet?.mode || 'whole-session',
      label: sourceSet?.label || '完整会话：所有原始记录、可见消息、工具调用、工具结果、命令和文件变更',
      sessionId: analysis.source.sessionId,
      sourcePath: analysis.source.path,
      sourceSha256: analysis.source.sha256,
      sourceBytes: analysis.source.bytes,
      sourceFormat: analysis.source.format,
      recordCount: analysis.source.recordCount,
      normalisedEventCount: analysis.coverage.normalisedEventCount,
      selectedRecordRange: [1, analysis.source.recordCount],
      sessionCount: Number(sourceSet?.sessionCount || 1),
      sessions: sourceSet?.sessions || [],
      redacted,
    },
    capabilityContract: {
      schemaVersion: '3.0.0',
      title: identity.name,
      plainSummary: `这是一个从 ${Number(sourceSet?.sessionCount || 1)} 条完整原对话${projectPortfolio?.projects?.length ? `和 ${projectPortfolio.projects.length} 个关联项目` : (projectEvidence ? `和项目“${projectEvidence.project.name}”` : '')}重建的 Codex 工程能力包。它会先回查跨会话原话和最新纠正，再读取项目结构、规则、当前文件、Git 原始版本与差异，通过补丁、文件、终端、长期进程、技能和受控网络工具完成真实工作，并保留可审查的任务、差异、验收和恢复证据。`,
      operatingPrinciples: [
        '最新用户要求优先于早期方案。',
        '多会话冲突按每条会话内时间顺序和全局选择顺序保留，执行时优先遵循更晚的明确纠正。',
        '先读取证据和当前文件，再进行修改。',
        '项目理解必须同时参考当前文件、项目规则、Git 原始版本、Git 差异、会话中的文件操作和生成产物。',
        '先识别项目结构、仓库规则和 Git 状态，再选择修改方式。',
        '写入、删除、命令、Git 写入和网络访问分别控制。',
        '每次任务都有计划、状态、步骤、工具轨迹、变更日志、进程记录和验收结果。',
        '失败可以继续、重试或恢复检查点。',
      ],
      codexAlignment: {
        title: 'Codex 工程能力对齐图',
        description: '能力包以本地工作区 Agent、Skill 和 MCP 三种形态实现工程工作闭环；每项能力都在独立界面中展示开放条件和直白用途。',
        domains: [
          { name: '多会话与长期上下文', status: '已实现', description: '完整提取多条原对话、标题、用户纠正、工具轨迹和文件变更，并保留每条证据的来源会话。' },
          { name: '项目理解与指令遵循', status: '已实现', description: '识别项目构建入口、依赖、测试、Git 仓库，并读取 AGENTS.md、README 等项目说明。' },
          { name: '精确代码修改与审查', status: '已实现', description: '支持标准补丁、精确替换、批量编辑、检查点、文件差异和 Git 差异审查。' },
          { name: '本地终端与长期任务', status: '已实现', description: '支持一次性命令、验证命令、长期进程启动、输出读取、输入写入和停止。' },
          { name: 'Git 工作流', status: '已实现', description: '支持状态、差异、历史、分支和受控提交；不会自行推送远程仓库。' },
          { name: '技能与工作流复用', status: '已实现', description: '支持列出与读取本地 Codex 技能，并将当前会话生成可安装 Skill。' },
          { name: '网页取证', status: '已实现', description: '在网络开关打开后读取公开页面，用于需要时效信息的事实核验。' },
          { name: '浏览器和桌面操作', status: '可通过 MCP 扩展', description: '本包不伪造系统级鼠标键盘控制；可在 Codex 中通过已配置的浏览器或计算机使用 MCP 扩展。' },
          { name: '模型推理与多模态', status: '取决于所连模型', description: '能力包使用 OpenAI 兼容接口；文本、视觉、推理深度和上下文长度由你连接的模型决定。' },
        ],
      },
      tools: extraction.capabilityCatalog,
      specializedCapabilities: (ui?.specializations || []).map((item) => ({
        id: item.id,
        phase: item.phase,
        title: item.title,
        goal: item.goal,
        approach: item.approach,
        deliverable: item.deliverable,
        evidence: item.evidence,
        action: item.action,
        sourceStages: item.sourceStages,
        originalStageIndexes: item.originalStageIndexes,
      })),
      distilledExpertise: (ui?.expertise || []).map((item) => ({
        id: item.id,
        phase: item.phase,
        capability: item.capability,
        whenToUse: item.whenToUse,
        executionMethod: item.executionMethod,
        deliverable: item.deliverable,
        evidence: item.evidence,
        action: item.action,
        sourceStages: item.sourceStages,
        originalStageIndexes: item.originalStageIndexes,
      })),
      workflow: extraction.improvedWorkflow,
      acceptanceMatrix: extraction.acceptanceMatrix,
      latestCorrections,
      limits: [
        '能力包不内置模型权重，需要连接 OpenAI 兼容模型服务。',
        '文件工具严格限制在用户选择的工作区内。',
        '文件写入、删除、本地命令、Git 写入和网络访问默认关闭，需要在界面中分别开启。',
        '命令使用当前系统账户权限，输出与运行时间受限制。',
        'Git 提交只提交已暂存内容，能力包不会自行推送远程仓库。',
        '网络工具只读取页面内容，不发送模型密钥、Cookie、Authorization 或工作区文件。',
      ],
    },
    evidence: {
      statistics: extraction.statistics,
      requirementEvolution: extraction.requirementEvolution,
      corrections: extraction.corrections,
      strengths: extraction.strengths,
      weaknesses: extraction.weaknesses,
      sourceFiles: [
        'conversation-extraction.json',
        'source-sessions.json',
        'project-discovery.json',
        'project-discovery.md',
        'project-evidence.json',
        'project-evidence.md',
        'project-understanding.json',
        'project-understanding.md',
        'project-portfolio.json',
        'project-portfolio.md',
        'evidence/analysis.json',
        'evidence/normalized-events.ndjson',
      ],
      sourceSessions: sourceSet?.sessions || [],
      projectEvidence: projectUnderstanding(projectEvidence),
      projectPortfolio: projectPortfolio ? {
        mode: projectPortfolio.mode,
        recommendedMode: projectPortfolio.recommendedMode,
        crossProject: projectPortfolio.crossProject,
        projects: (projectPortfolio.projects || []).map((project) => ({
          projectId: project.projectId,
          name: project.name,
          root: project.root,
          sessionCount: project.sessionCount,
          sessionIds: project.sessionIds,
          confidence: project.confidence,
          relatedFiles: project.relatedFiles,
        })),
        sessionAssignments: projectPortfolio.sessionAssignments || [],
        unassignedSessions: projectPortfolio.unassignedSessions || [],
      } : null,
    },
    ui,
    runtime: {
      taskPersistence: true,
      taskStates: ['等待', '取证', '规划', '执行', '验证', '完成', '失败', '已停止'],
      resumable: true,
      checkpoints: true,
      rollback: true,
      streaming: true,
      visibleToolTrace: true,
      workspaceBoundary: true,
      secretFiltering: true,
      projectInspection: true,
      standardPatch: true,
      gitContext: true,
      managedProcesses: true,
      skillDiscovery: true,
      controlledNetworkFetch: true,
      multiConversationEvidence: true,
      projectSnapshotEvidence: true,
      gitBaselineEvidence: true,
      projectEvidenceGraph: true,
      multiProjectRecognition: true,
      sessionProjectAssignment: true,
      crossProjectPackaging: Boolean(projectPortfolio?.crossProject),
      fileEvolutionEvidence: true,
      generatedArtifactLineage: true,
      conflictRegister: true,
      activeProjectReadPlan: true,
      semanticMultiSessionConsolidation: true,
      projectKnowledgeV4: true,
      evidenceLedger: true,
      projectModel: true,
      fileVersionChain: true,
      artifactLineageV4: true,
      decisionConflictResolution: true,
      projectCoverageAccounting: true,
      activeReadLog: true,
      crossSessionTimeline: true,
      fileChangeMatrix: true,
      dependencyImpactAnalysis: true,
      artifactReproducibility: true,
      incrementalProjectSnapshot: true,
      openEvidenceQuestions: true,
    },
    delivery: {
      guideFile: 'README.md',
      extractionFile: 'conversation-extraction.json',
      sourceSessionsFile: 'source-sessions.json',
      projectDiscoveryFile: 'project-discovery.json',
      projectDiscoveryMarkdownFile: 'project-discovery.md',
      projectEvidenceFile: 'project-evidence.json',
      projectEvidenceMarkdownFile: 'project-evidence.md',
      projectUnderstandingFile: 'project-understanding.json',
      projectUnderstandingMarkdownFile: 'project-understanding.md',
      projectPortfolioFile: 'project-portfolio.json',
      projectPortfolioMarkdownFile: 'project-portfolio.md',
      projectKnowledgeFile: 'project-knowledge-v4.json',
      projectKnowledgeMarkdownFile: 'project-knowledge-v4.md',
      crossSessionTimelineFile: 'cross-session-timeline.ndjson',
      fileChangeMatrixFile: 'file-change-matrix.json',
      dependencyImpactFile: 'dependency-impact.json',
      artifactReproducibilityFile: 'artifact-reproducibility.json',
      projectSnapshotFile: 'project-snapshot.json',
      distillationFile: 'conversation-distillation.json',
      distillationMarkdownFile: 'conversation-distillation.md',
      contractFile: 'capability-contract.json',
      skill: targets.includes('skill') ? { directory: `skill/${skillName}`, skillFile: `skill/${skillName}/SKILL.md`, installDirectory: path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.codex', '.codex'), 'skills', skillName) } : null,
      mcp: targets.includes('mcp') ? { directory: 'mcp', serverFile: `mcp/${identity.id}-server.mjs`, configFile: 'mcp/mcp.config.example.json' } : null,
      agent: targets.includes('agent') ? { directory: 'agent', serverFile: 'agent/agent-server.mjs', launcherFile: 'agent/launcher.mjs', profileFile: 'agent/ai-profile.json', uiDirectory: 'agent/ui', uiBlueprintFile: 'agent/ui/capability-ui.json', oneClickInstall: 'install-and-start.cmd', directLaunch: 'launch.cmd', startCommand: 'node agent/launcher.mjs' } : null,
    },
  };
}

async function writeText(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
}

async function copyTree(source, target) {
  await fsp.mkdir(target, { recursive: true });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(sourcePath, targetPath);
    else if (entry.isFile()) await fsp.copyFile(sourcePath, targetPath);
  }
}

function agentLauncherSource() {
  return `import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const AGENT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const minimumMajor = 18;
const nodeMajor = Number(String(process.versions.node || '0').split('.')[0]) || 0;
if (nodeMajor < minimumMajor) {
  process.stderr.write(\`需要 Node.js \${minimumMajor} 或更高版本，当前版本为 \${process.version}。请运行包根目录的 install-and-start.cmd，或安装 Node.js LTS 后重试。\\n\`);
  process.exit(1);
}

const env = { ...process.env };
if (!env.CONVERSATION_AGENT_PORT && !env.PORT) env.CONVERSATION_AGENT_PORT = '0';
if (!env.CONVERSATION_AGENT_HOST && !env.HOST) env.CONVERSATION_AGENT_HOST = '127.0.0.1';
const child = spawn(process.execPath, ['agent-server.mjs'], { cwd: AGENT_ROOT, env, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: false });
let seen = '';
let browserOpened = false;

function openBrowser(address) {
  if (process.env.CONVERSATION_AGENT_NO_BROWSER === '1' || browserOpened) return;
  browserOpened = true;
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', address] : [address];
  const opener = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  opener.unref();
}

function observe(chunk, output) {
  const text = chunk.toString();
  output.write(text);
  seen = (seen + text).slice(-8192);
  const match = seen.match(/http:\\/\\/(?:127\\.0\\.0\\.1|localhost):\\d+\\//);
  if (match) {
    openBrowser(match[0]);
    if (browserOpened) process.stdout.write(\`已打开独立操作界面：\${match[0]}\\n\`);
  }
}

child.stdout.on('data', (chunk) => observe(chunk, process.stdout));
child.stderr.on('data', (chunk) => observe(chunk, process.stderr));
child.on('error', (error) => { process.stderr.write(\`启动失败：\${error.message}\\n\`); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = Number.isInteger(code) ? code : 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
`;
}

function windowsLaunchPowerShell() {
  return String.raw`param([switch]$InstallNode)
$ErrorActionPreference = 'Stop'
$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-Node {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @('C:\Program Files\nodejs\node.exe', 'C:\Program Files (x86)\nodejs\node.exe')
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
  foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { return $candidate } }
  return $null
}

$node = Find-Node
if (-not $node -and $InstallNode) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Host '正在安装 Node.js LTS，完成后将自动启动能力包...'
    & $winget.Source install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    $node = Find-Node
  }
}
if (-not $node) {
  Write-Host '未检测到 Node.js 18+。请双击 install-and-start.cmd 自动安装，或安装 Node.js LTS 后重新运行 launch.cmd。'
  exit 1
}
& $node (Join-Path $PackageRoot 'agent\launcher.mjs')
exit $LASTEXITCODE
`;
}

function windowsInstallPowerShell(packageId) {
  return String.raw`$ErrorActionPreference = 'Stop'
$SourceRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$PackageId = '${packageId.replace(/'/g, "''")}'
$BaseRoot = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'ConversationCapabilityAgents' } else { Join-Path $HOME 'ConversationCapabilityAgents' }
$TargetRoot = Join-Path $BaseRoot $PackageId

if (-not [string]::Equals($SourceRoot.TrimEnd('\'), $TargetRoot.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
  New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null
  Get-ChildItem -LiteralPath $SourceRoot -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $TargetRoot -Recurse -Force }
}

try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $desktop ('能力包-' + $PackageId + '.lnk')))
    $shortcut.TargetPath = (Join-Path $TargetRoot 'launch.cmd')
    $shortcut.WorkingDirectory = $TargetRoot
    $shortcut.Description = '启动本地能力包独立操作界面'
    $shortcut.Save()
  }
} catch { Write-Host '桌面快捷方式创建失败，不影响使用。' }

Write-Host ('能力包已安装到当前用户目录：' + $TargetRoot)
& (Join-Path $TargetRoot 'launch.ps1') -InstallNode
exit $LASTEXITCODE
`;
}

function windowsCmd(powerShellFile) {
  return `@echo off\r\nsetlocal\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0${powerShellFile}"\r\nif errorlevel 1 pause\r\nendlocal\r\n`;
}

function posixLaunchShell() {
  return `#!/usr/bin/env sh\nset -eu\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nif ! command -v node >/dev/null 2>&1; then\n  printf '%s\\n' '未检测到 Node.js 18+。请运行 sh install-and-start.sh，或安装 Node.js LTS 后重试。' >&2\n  exit 1\nfi\nexec node "$ROOT/agent/launcher.mjs"\n`;
}

function posixInstallShell(packageId) {
  return `#!/usr/bin/env sh\nset -eu\nSOURCE_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nPACKAGE_ID="${packageId}"\nif ! command -v node >/dev/null 2>&1; then\n  if command -v brew >/dev/null 2>&1; then brew install node\n  elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y nodejs npm\n  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y nodejs\n  else printf '%s\\n' '请先安装 Node.js 18 或更高版本，再运行此文件。' >&2; exit 1\n  fi\nfi\nTARGET_ROOT="\${XDG_DATA_HOME:-$HOME/.local/share}/conversation-capability-agents/$PACKAGE_ID"\nmkdir -p "$TARGET_ROOT"\nif [ "$SOURCE_ROOT" != "$TARGET_ROOT" ]; then cp -R "$SOURCE_ROOT"/. "$TARGET_ROOT"/; fi\nprintf '%s\\n' "能力包已安装到：$TARGET_ROOT"\nexec sh "$TARGET_ROOT/launch.sh"\n`;
}

function skillMarkdown(blueprint, skillName) {
  return `---
name: ${skillName}
description: "从一条或多条完整原对话，以及关联项目的当前文件、Git 原始版本、差异和生成产物中提取证据；按证据优先流程执行本地文件修改、命令验证与失败恢复。"
---

# ${blueprint.package.name}

## 执行规则

1. 先读取 \`references/capability-contract.json\` 的最新纠正、工具权限和验收矩阵。
2. 先读取 \`references/source-sessions.json\`，明确本次联合蒸馏包含哪些会话、标题、顺序和来源文件。
3. 需要原话时搜索 \`references/conversation-extraction.json\`；大型文件使用 \`rg -n "关键词" references/conversation-extraction.json\`，不要一次加载全部内容。
4. 先读取 \`references/project-knowledge-v4.md\`；需要精确追溯时按任务分别读取 \`semantic-stages.json\`、\`cross-session-timeline.ndjson\`、\`evidence-ledger.ndjson\`、\`project-model.json\`、\`file-versions.ndjson\`、\`file-change-matrix.json\`、\`dependency-impact.json\`、\`artifact-lineage.json\`、\`artifact-reproducibility.json\`、\`project-snapshot.json\`、\`open-evidence-questions.json\`、\`decision-conflicts.json\`、\`coverage.json\` 和 \`active-read-log.ndjson\`。不得把“仅元数据”或“计划读取”描述成已读正文。
5. 如果有 \`references/project-understanding.json\`，再按主动读取计划核对项目目的、文件演化、生成产物链路和冲突登记；结合 \`references/project-evidence.json\` 的项目规则、关联文件、Git 原始版本和差异读取工作区真实文件，不能只依据会话摘要。
6. 后续用户纠正覆盖冲突的早期做法；多会话时保留来源并以更晚的明确纠正为准。
7. 默认执行到真实产物和验证完成；只有用户明确只要计划时才停止在计划阶段。
8. 修改前保留恢复点，修改后运行适合项目的语法检查、测试或构建命令。
9. 最终列出修改文件、命令、验证结果、失败项和恢复点。

## 可复用脚本

- \`node scripts/inspect-package.mjs\`：查看能力、纠正和验收摘要。
- \`node scripts/prepare-task.mjs "任务内容"\`：根据最新纠正生成证据优先执行清单。

## 参考文件

- \`references/capability-contract.json\`：功能、工具、工作流、权限和验收标准。
- \`references/source-sessions.json\`：所有选中会话的标题、编号、路径、哈希和记录量。
- \`references/conversation-extraction.json\`：完整需求阶段、消息、工具、命令和文件变更。
- \`references/project-evidence.json\`、\`references/project-evidence.md\`：项目结构、规则、当前文件、Git 原始版本/差异、会话关联文件和生成产物。
- \`references/project-understanding.json\`、\`references/project-understanding.md\`：跨会话到项目文件的证据图、逐文件演化、产物链路、冲突登记和主动读取/验证计划。
- \`references/project-knowledge-v4.json\`、\`references/project-knowledge-v4.md\`：联合会话、项目现状和版本证据形成的完整 V4.1 项目级知识层和中文阅读版。
- \`references/semantic-stages.json\`：强语义归并后的 P 阶段、具体目标、来源会话、工具、文件和证据编号。
- \`references/cross-session-timeline.ndjson\`、\`references/file-change-matrix.json\`：多条会话按时间形成的目标、纠正和执行演进，以及每个文件从 Git 原始版本、会话修改到当前版本的状态矩阵。
- \`references/evidence-ledger.ndjson\`、\`references/file-versions.ndjson\`：逐条证据账本，以及 Git 原始版本、会话操作、当前版本的文件演化链。
- \`references/project-model.json\`、\`references/project-graph.json\`：项目目的、模块、入口、规则、能力及会话到文件和产物的关系图。
- \`references/dependency-impact.json\`：被修改文件的导入方、被依赖方和直接影响范围。
- \`references/artifact-lineage.json\`、\`references/artifact-reproducibility.json\`：产物输入/命令/可信度，以及基于当前输入快照能否复现的核验结果。
- \`references/project-snapshot.json\`、\`references/open-evidence-questions.json\`：当前项目、Git、文件和产物证据快照，以及仍然缺少正文、基线或生成命令的待补证问题。
- \`references/decision-conflicts.json\`：后续纠正、覆盖关系和证据缺口。
- \`references/coverage.json\`、\`references/active-read-log.ndjson\`：实际读取覆盖率，并明确区分已完成、仅元数据与后续计划。
- \`references/workflow-blueprint.json\`：能力包结构、来源锚点和运行时约束。
`;
}

function inspectScript() {
  return `import fs from 'node:fs/promises';\nconst contract=JSON.parse(await fs.readFile(new URL('../references/capability-contract.json',import.meta.url),'utf8'));\nprocess.stdout.write(JSON.stringify({name:contract.title,summary:contract.plainSummary,tools:contract.tools.map(x=>x.label),latestCorrections:contract.latestCorrections,workflow:contract.workflow,acceptance:contract.acceptanceMatrix},null,2)+'\\n');\n`;
}

function prepareTaskScript() {
  return `import fs from 'node:fs/promises';\nconst task=process.argv.slice(2).join(' ').trim();\nif(!task) throw new Error('用法：node scripts/prepare-task.mjs "任务内容"');\nconst contract=JSON.parse(await fs.readFile(new URL('../references/capability-contract.json',import.meta.url),'utf8'));\nconst plan={task,principles:contract.operatingPrinciples,latestCorrections:contract.latestCorrections.slice(0,8),steps:contract.workflow,acceptance:contract.acceptanceMatrix,status:'仅为执行清单，尚未修改文件或运行命令'};\nprocess.stdout.write(JSON.stringify(plan,null,2)+'\\n');\n`;
}

function packageGuide(blueprint, skillName) {
  const stats = blueprint.evidence.statistics;
  const tools = blueprint.capabilityContract.tools.map((item) => `| \`${item.name}\` | ${item.label} | ${item.description} | ${item.permission} |`).join('\n');
  const workflow = blueprint.capabilityContract.workflow.map((item) => `${item.order}. **${item.name}**：${item.description}`).join('\n');
  const ui = blueprint.ui || {};
  const distillation = blueprint.conversationDistillation || {};
  const specializedCapabilities = (distillation.specializedCapabilities || []).map((item) => `### ${item.title}\n\n- **阶段目标**：${item.goal}\n- **执行做法**：${item.approach}\n- **预期交付**：${item.deliverable}\n- **原会话证据**：${item.evidence}\n- **界面操作**：点击“${item.action}”会预填该阶段的具体任务。`).join('\n\n') || '- 尚未识别到可拆分的 P 阶段。';
  const expertiseRows = (distillation.distilledExpertise || []).map((item) => `| ${String(`${item.phase}｜${item.capability}`).replace(/\|/g, '\\|')} | ${String(item.whenToUse || '—').replace(/\|/g, '\\|')} | ${String(item.executionMethod || '—').replace(/\|/g, '\\|')} |`).join('\n') || '| 未识别 | 当前会话未提供可拆分的专属专长。 | 请查看原会话阶段。 |';
  const packageDescription = blueprint.package.description || {};
  const phaseMap = (packageDescription.phases || []).map((item) => `- **${item.title}**：${item.role}`).join('\n') || '- 未识别到语义阶段。';
  const actualTools = (packageDescription.actualTools || []).map((item) => `\`${item}\``).join('、') || '未识别到工具。';
  const uiInputs = (ui.inputs || []).map((item) => `- **${item.label}**${item.required === false ? '（可选）' : ''}：${item.help}`).join('\n') || '- 以页面中的当前任务输入为准。';
  const uiCapabilities = (ui.capabilities || []).map((item) => `- **${item.action || item.title}**：${item.description}`).join('\n') || '- 按会话工作流执行。';
  const uiDeliverables = (ui.deliverables || []).map((item) => `- **${item.title}**：${item.description}`).join('\n') || '- 可核对的任务结果。';
  const uiCorrections = (ui.corrections || []).map((item) => `- **${item.title || `阶段 ${item.stage}`}**：${item.instruction}`).join('\n') || '- 未识别到明确纠正时，以当前任务为最高优先级。';
  const selectedSessions = (blueprint.selection.sessions || []).map((item, index) => `| ${index + 1} | ${item.title || '未命名会话'} | \`${item.sessionId || '—'}\` | ${Number(item.recordCount || 0).toLocaleString('zh-CN')} | \`${item.sourcePath || '—'}\` |`).join('\n') || `| 1 | 当前完整会话 | \`${blueprint.selection.sessionId || '—'}\` | ${Number(blueprint.selection.recordCount || 0).toLocaleString('zh-CN')} | \`${blueprint.selection.sourcePath || '—'}\` |`;
  const project = blueprint.evidence.projectEvidence;
  const projectFiles = (project?.modifiedFiles || []).map((item) => `| \`${item.path}\` | ${item.changeState || '—'} | ${item.projectRole || '—'} | ${item.originalAvailable ? '已提取' : '无'} | ${item.hasDiff ? '已提取' : '无'} |`).join('\n') || '| — | 未指定项目或未发现关联文件 | — | — | — |';
  return `# ${blueprint.package.name}

## 这份包到底做什么

${packageDescription.summary || blueprint.capabilityContract.plainSummary}

${packageDescription.namingExplanation || ''}

### 需求阶段地图

${phaseMap}

### 实际使用过的工具

${actualTools}

### 生成后第一步

${packageDescription.firstStep || '先阅读本说明，再按下方入口启动。'}

## 这份会话生成了什么专属应用

**名称**：${ui.identity?.title || blueprint.package.name}

**目标**：${ui.purpose || blueprint.capabilityContract.plainSummary}

**生成方式**：${ui.generation?.label || '完整会话结构提炼'}。该应用不是通用“填入任务”页面；首屏直接显示本会话的目标、输入、可执行能力、交付物和后续纠正，点击能力按钮会预填对应任务。

### 开始前需要提供

${uiInputs}

### 可以直接执行的能力

${uiCapabilities}

### 预期交付物

${uiDeliverables}

### 必须继承的后续纠正

${uiCorrections}

### 专属界面文件

- \`conversation-ui-blueprint.json\`：本会话的 UI 定义，可供人工复核和再生成。
- \`agent/ui/capability-ui.json\`：独立 Agent 首屏实际读取的 UI 定义。
- \`agent/ui/index.html\`、\`agent/ui/app.js\`、\`agent/ui/styles.css\`：可操作的本地独立界面。

## 蒸馏器输出：通用底座 + 多会话/项目专属能力

${distillation.summary || '蒸馏器按完整会话生成。'}

### 从原会话提炼出的专长

这张表只描述选中会话真正做过或明确要求过的专长，不把通用工具能力混进来。

| 专长 | 什么时候使用 | 执行方法 |
| --- | --- | --- |
${expertiseRows}

### 通用 Codex 执行能力底座

${distillation.universalCore?.description || '完整工具目录见下方“完整能力说明与功能清单”。'}

通用能力不会被会话专属任务替代；它仍负责原对话检索、文件、命令、验证、Git、进程、技能和网页工具。

### 会话专属能力（按 P 阶段）

${specializedCapabilities}

完整结构化结果：\`conversation-distillation.json\`；可直接阅读的版本：\`conversation-distillation.md\`。

## 这个能力包能做什么

${blueprint.capabilityContract.plainSummary}

它不是静态会话总结，也不是只有聊天框的演示页面。独立 Agent 会把每次请求保存为任务，展示取证、规划、执行、验证、完成或失败状态，并保存项目识别结果、标准补丁、Git 差异、长期进程、工具轨迹、文件变更、命令结果和恢复点。

## 选择的会话与项目证据

蒸馏范围：${blueprint.selection.mode === 'multi-session' ? '多会话联合蒸馏' : '完整会话蒸馏'}。每条选中会话均完整读取；每个需求阶段、消息、工具调用和文件变更都保留来源会话。

| 顺序 | 会话标题 | 会话编号 | 原始记录 | 来源文件 |
| --- | --- | --- | --- | --- |
${selectedSessions}

### 项目理解结果

${project ? `项目：**${project.project?.name || '未命名项目'}**；根目录：\`${project.project?.root || '—'}\`；Git：${project.git?.available ? `已识别（${project.git.branch || '未命名分支'}）` : '未识别'}；扫描 ${Number(project.summary?.scannedFiles || 0).toLocaleString('zh-CN')} 个文件；会话关联 ${Number(project.summary?.linkedFiles || 0)} 个；修改或新增 ${Number(project.summary?.modifiedFiles || 0)} 个；生成产物 ${Number(project.summary?.generatedFiles || 0)} 个。` : '本次没有指定项目文件夹。'}

| 文件 | 当前状态 | 项目角色 | 原始版本 | Git 差异 |
| --- | --- | --- | --- | --- |
${projectFiles}

项目证据完整内容：\`project-evidence.json\`（结构化）和 \`project-evidence.md\`（阅读版）。项目级因果理解请优先打开 \`project-knowledge-v4.md\`，或在独立界面进入“项目知识”：它会完整展示跨会话时间线、项目模型、文件原始/会话/当前版本、变更矩阵、依赖影响、产物血缘与复现状态、后续决策、证据快照、待补证问题、覆盖率和主动读取记录。精确数据分别位于 \`semantic-stages.json\`、\`cross-session-timeline.ndjson\`、\`evidence-ledger.ndjson\`、\`project-model.json\`、\`project-graph.json\`、\`file-versions.ndjson\`、\`file-change-matrix.json\`、\`dependency-impact.json\`、\`artifact-lineage.json\`、\`artifact-reproducibility.json\`、\`project-snapshot.json\`、\`open-evidence-questions.json\`、\`decision-conflicts.json\`、\`coverage.json\` 与 \`active-read-log.ndjson\`；旧版 \`project-understanding.json\` 和 \`project-understanding.md\` 继续作为兼容证据层保留。

## 来源统计

- 联合会话数：${Number(blueprint.selection.sessionCount || 1)} 条
- 会话集合编号：\`${blueprint.selection.sessionId}\`
- 原始记录：${Number(blueprint.selection.recordCount || 0).toLocaleString('zh-CN')} 条
- 需求阶段：${stats.stages} 个
- 可见消息：${stats.messages} 条
- 工具调用：${stats.toolCalls} 次
- 命令记录：${stats.commands} 条
- 文件变更：${stats.fileChanges} 条
- 后续纠正：${stats.corrections} 条
- 来源 SHA-256：\`${blueprint.selection.sourceSha256}\`

## 完整能力说明与功能清单

| 工具 | 中文名称 | 直白说明 | 开放条件 |
| --- | --- | --- | --- |
${tools}

## 改进后的执行流程

${workflow}

## 三种交付形态

### 独立 Agent

这是可解压即用的独立应用，不依赖生成它的工作区，也不需要 \`npm install\`。Windows 用户解压 ZIP 后双击根目录的 \`install-and-start.cmd\`，它会安装到当前用户目录、创建桌面快捷方式、检查 Node.js LTS 并自动打开独立网页；只是临时使用时双击 \`launch.cmd\` 即可。macOS/Linux 用户可运行 \`sh install-and-start.sh\` 或 \`sh launch.sh\`。所有任务记录都按当前系统用户保存，能力包所在目录可以只读。

界面提供模型配置、工作区权限、Codex 对齐图、完整功能清单、原对话纠正、项目知识、任务执行、工具记录、Git 与进程状态、变更日志、检查点和恢复操作。“项目知识”不是摘要卡片：默认全量展示跨会话时间线、项目模块、逐文件版本链、文件变更矩阵、依赖影响、产物血缘与复现状态、纠正决策、项目证据快照、待补证问题、覆盖率与每次主动读取状态，并可按关键词筛选。首次打开时，它会自动读取当前用户本机 Codex 的 \`CODEX_HOME/config.toml\` 和本机密钥来源，自动带入正在使用的模型接口、模型名称和接口类型；密钥只留在 Agent 进程内存，页面不会显示，也不会写入能力包或任务记录。未检测到当前 Codex 时，界面仍可手动填写模型接口。页面还会自动搜索本机 Codex 对话归档，并以会话标题、时间和编号列出；可在“完整任务链目录”一键选择一组相关会话。点击“加载所选对话到任务”后，系统在本机脱敏读取全部已选会话：文本框展示会话索引，执行时 Agent 自动接收全部索引及每条会话的最新需求阶段，用于识别后续纠正和最终目标，不会因为文本框长度而只理解首条对话。保存模型接口后，界面会自动读取接口返回的模型，并在“接口模型全量列表”中完整显示；搜索框只筛选当前显示，点击任意模型即可填入模型名称。

### MCP

服务文件：\`mcp/${blueprint.package.id}-server.mjs\`。配置示例：\`mcp/mcp.config.example.json\`。MCP 提供同一份原对话证据、项目理解、补丁、Git、长期进程、技能、网络和受环境变量控制的本地文件命令能力。

### Skill

包内目录：\`skill/${skillName}\`。已安装目录：\`${blueprint.delivery.skill?.installDirectory || '未生成'}\`。Skill 保持精简，只在需要时读取大型证据文件。

## 新手第一次使用

1. 解压交付的 ZIP。Windows 双击 \`install-and-start.cmd\`；首次操作会自动检查 Node.js LTS、复制到当前用户应用目录、创建桌面快捷方式并打开网页。临时使用可直接双击 \`launch.cmd\`。macOS/Linux 运行 \`sh install-and-start.sh\`。
2. 网页顶部“安装与启动状态”应显示“可直接使用”。它会说明 Node.js 版本、启动文件和任务数据保存方式；这里显示异常时，按卡片中列出的启动文件重试。
3. 先看“自动连接当前 Codex”卡片：检测成功会自动填入当前 Codex 的接口、模型和接口类型，直接继续下一步即可；需要重新读取时点击“重新连接当前 Codex”。未检测到时，再在“模型与本地权限”中填写 OpenAI 兼容地址、模型和密钥，点击“保存并测试模型”。保存成功后会自动读取接口返回的全部模型；“接口模型全量列表”不会截断返回结果，搜索只用于筛选，点击模型名称即可选用。
4. 在“自动加载本机 Codex 对话”卡片中按标题搜索、勾选一条或多条会话，或在默认展开的“完整任务链目录”一键选择整条链，再点击“加载所选对话到任务”。系统会在本机读取并脱敏生成任务上下文；输入框显示全部会话索引，真正执行时还会自动注入每条会话的最新阶段证据，无需手动找到 JSONL 文件。
5. 在“工作区”中选择项目目录后可以读取；写入、删除、命令、Git 提交和网络读取需要分别明确开启。
6. 进入“项目知识”，先确认语义阶段名称和目标，再查看项目模块、文件原始/会话/当前版本、产物生成链路和覆盖率；“仅元数据”表示没有读取正文，“计划”表示尚未执行，界面不会混淆。
7. 在“功能总览”查看“Codex 工程能力对齐图”，每项功能会直接说明用途和开关条件。
8. 在“任务执行”输入目标。需要重做旧方案时选择“提取并改进原对话”。
9. 查看证据、计划、工具轨迹、Git 差异、进程输出、文件变更和验收结果；失败后可继续任务或恢复检查点。

## 文件说明

- \`package-description.json\`：本包的直白说明、包名依据、P 阶段地图、实际工具和启动第一步。
- \`capability-contract.json\`：所有功能、工具、权限、工作流和验收标准的唯一契约。
- \`conversation-extraction.json\`：完整会话提取和时间线。
- \`source-sessions.json\`：选中会话的标题、编号、哈希、路径和记录量。
- \`project-evidence.json\`、\`project-evidence.md\`：项目结构、规则、当前文件、Git 原始版本/差异、会话关联文件和生成产物。
- \`project-understanding.json\`、\`project-understanding.md\`：项目目的、证据图、文件演化、生成产物链路、冲突登记和下次执行的主动读取计划。
- \`project-knowledge-v4.json\`、\`project-knowledge-v4.md\`：跨会话和项目文件的完整 V4.1 项目级知识数据与中文说明。
- \`semantic-stages.json\`、\`evidence-ledger.ndjson\`：强语义 P 阶段和逐条来源证据。
- \`cross-session-timeline.ndjson\`、\`file-change-matrix.json\`：跨会话演进和文件原始/会话/当前版本矩阵。
- \`project-model.json\`、\`project-graph.json\`：项目目的、模块、入口、规则、能力和关系图。
- \`file-versions.ndjson\`、\`artifact-lineage.json\`：文件原始/会话/当前版本链和生成产物血缘。
- \`dependency-impact.json\`、\`artifact-reproducibility.json\`：修改文件的依赖影响和生成产物复现核验。
- \`project-snapshot.json\`、\`open-evidence-questions.json\`：可对比的项目证据快照和待补证问题。
- \`decision-conflicts.json\`：后续纠正、覆盖关系和仍需确认的证据缺口。
- \`coverage.json\`、\`active-read-log.ndjson\`：会话/项目覆盖率以及已完成、仅元数据、计划三类读取状态。
- \`conversation-distillation.json\`、\`conversation-distillation.md\`：通用能力底座与跨会话 P 阶段专属能力的蒸馏结果。
- \`workflow-blueprint.json\`：来源锚点、运行时和交付结构。
- \`package-manifest.json\`：所有产物哈希和大小。
- \`verify.mjs\`：完整性校验程序。
`;
}

function agentReadme(blueprint) {
  const ui = blueprint.ui || {};
  const distillation = blueprint.conversationDistillation || {};
  const uiInputs = (ui.inputs || []).map((item) => `- **${item.label}**${item.required === false ? '（可选）' : ''}：${item.help}`).join('\n') || '- 以当前任务为准。';
  const uiCapabilities = (ui.capabilities || []).map((item) => `- **${item.action || item.title}**：${item.description}`).join('\n') || '- 按会话工作流执行。';
  const specializedCapabilities = (distillation.specializedCapabilities || []).map((item) => `- **${item.title}**：目标是“${item.goal}”；做法是“${item.approach}”；预期交付“${item.deliverable}”；证据为“${item.evidence}”。`).join('\n') || '- 尚未识别到可拆分的 P 阶段。';
  const expertiseRows = (distillation.distilledExpertise || []).map((item) => `| ${String(`${item.phase}｜${item.capability}`).replace(/\|/g, '\\|')} | ${String(item.whenToUse || '—').replace(/\|/g, '\\|')} | ${String(item.executionMethod || '—').replace(/\|/g, '\\|')} |`).join('\n') || '| 未识别 | 当前会话未提供可拆分的专属专长。 | 请查看原会话阶段。 |';
  const sessions = (distillation.source?.sessions || []).map((item, index) => `| ${index + 1} | ${item.title || '未命名会话'} | \`${item.sessionId || '—'}\` | ${Number(item.recordCount || 0).toLocaleString('zh-CN')} | \`${item.sourcePath || '—'}\` |`).join('\n') || '| 1 | 当前完整会话 | — | — | — |';
  const project = distillation.projectUnderstanding;
  const projectFiles = (project?.modifiedFiles || []).map((item) => `| \`${item.path}\` | ${item.changeState || '—'} | ${item.projectRole || '—'} | ${item.originalAvailable ? '已提取' : '无'} | ${item.hasDiff ? '已提取' : '无'} |`).join('\n') || '| — | 未指定项目或未发现关联文件 | — | — | — |';
  return `# ${blueprint.package.name} - 独立 Agent

## 功能定位

### 本会话专属能力与首页操作

- **专属名称**：${ui.identity?.title || blueprint.package.name}
- **要完成的目标**：${ui.purpose || blueprint.capabilityContract.plainSummary}
- **首页的直白说明**：页面首屏会显示这次要完成什么、开始前需要提供什么、会生成哪些结果、必须继承的后续纠正和可以直接执行的会话能力；不再展示与当前会话无关的批量任务。首屏还会直接显示“系统建议先做这件事”：P0-P3 优先级、具体阶段、原会话/文件/工具依据、置信度、预期交付物和排序分数都来自本次蒸馏。
- **第一个操作**：优先点击首屏“按建议填入任务”，系统会把该 P 阶段的目标、优先依据、建议动作、关联文件、实际工具和预期交付一次写入任务区；也可以点击“${ui.primaryAction?.label || '开始执行'}”或任一会话能力按钮。再选择工作区、按需打开文件修改或命令权限并开始执行。
- **完整排序说明**：界面首屏可点击“查看排序依据”；包内 \`PRIORITY-PLAN.md\`、\`distillation-recommendation.json\` 和 \`distillation-recommendation.html\` 保留每个 P 阶段的优先理由、证据、待补信息和完整排序，方便审阅或再次生成。
- **专属界面定义**：\`ui/capability-ui.json\`，生成方式为“${ui.generation?.label || '完整会话结构提炼'}”。这个文件由会话目标、阶段产出、工具记录与后续纠正组成，可审阅、留存或重新生成。

#### 开始前需要提供

${uiInputs}

#### 可以直接执行的能力

${uiCapabilities}

### 蒸馏器输出的多会话与项目专属能力

${distillation.summary || '蒸馏器按完整会话生成专属能力。'}

#### 从原会话提炼出的专长

| 专长 | 什么时候使用 | 执行方法 |
| --- | --- | --- |
${expertiseRows}

通用 Codex 工具底座仍完整可用：${distillation.universalCore?.description || '详见“功能总览”中的完整能力清单。'}

${specializedCapabilities}

独立界面的“会话蒸馏”页面会逐条展示上述 P 阶段，并同时展示每个来源会话和项目文件证据。“项目知识”页面进一步全量展示跨会话时间线、项目模型、逐文件版本链、文件变更矩阵、依赖影响、产物血缘与复现状态、后续纠正、项目证据快照、待补证问题、覆盖率和主动读取状态。结构化文件为 \`conversation-distillation.json\` 与 \`project-knowledge-v4.json\`，阅读版为 \`conversation-distillation.md\` 与 \`project-knowledge-v4.md\`；它们都随包交付。

## 这次能力包理解了哪些来源

蒸馏模式：${distillation.source?.mode === 'multi-session' ? '多会话联合蒸馏' : '完整会话蒸馏'}；共 ${Number(distillation.source?.sessionCount || 1)} 条会话。

| 顺序 | 会话标题 | 会话编号 | 原始记录 | 来源文件 |
| --- | --- | --- | --- | --- |
${sessions}

### 项目与文件证据

${project ? `项目“${project.project?.name || '未命名项目'}”位于 \`${project.project?.root || '—'}\`；Git：${project.git?.available ? `已识别（${project.git.branch || '未命名分支'}）` : '未识别'}；扫描 ${Number(project.summary?.scannedFiles || 0).toLocaleString('zh-CN')} 个文件。蒸馏器将会话里提到的文件与项目当前文件、Git 原始版本和差异合并理解。` : '本次没有指定项目文件夹，Agent 仍可在运行时选择工作区后执行项目检查。'}

| 文件 | 当前状态 | 项目角色 | 原始版本 | Git 差异 |
| --- | --- | --- | --- | --- |
${projectFiles}

完整结构化项目证据：\`project-evidence.json\`；阅读版：\`project-evidence.md\`。V4.1 项目级知识总表：\`project-knowledge-v4.json\`；阅读版：\`project-knowledge-v4.md\`。跨会话时间线、阶段、证据账本、项目模型、项目图、文件版本、文件变更矩阵、依赖影响、产物血缘、产物复现核验、项目证据快照、待补证问题、后续决策、覆盖率和主动读取记录均另有独立文件，执行前必须核对真实读取状态、文件演化、生成产物来源和待确认冲突。

这是一个可操作的本地 Codex 工程 Agent，不是静态页面。它能够检索多条原对话、读取最新纠正、理解项目和仓库规则、查看当前文件与 Git 原始版本/差异、识别生成产物、应用标准补丁、修改文件、执行命令、管理长期进程、读取本地技能、受控读取网页、运行验收、保存任务记录，并在失败时继续或恢复检查点。

## 启动

无需 \`npm install\`。解压 ZIP 后，优先使用包根目录的启动器：

- Windows：双击 \`install-and-start.cmd\`。它会安装到当前用户目录、创建桌面快捷方式、检查 Node.js LTS 并自动打开网页；临时使用时可双击 \`launch.cmd\`。
- macOS/Linux：在终端运行 \`sh install-and-start.sh\`；临时使用时运行 \`sh launch.sh\`。

安装后的任务和配置记录都保存在当前用户的本地数据目录，不写入能力包目录，因此压缩包可以解压到任意位置、也可以置于只读目录。启动网页的“安装与启动状态”会直接显示 Node.js 是否满足要求、使用的启动文件以及数据保存方式。

需要排查启动问题时，也可以在当前目录运行：

\`\`\`powershell
node agent/launcher.mjs
\`\`\`

启动器会自动选择未占用本地端口并打开独立界面。Node.js 要求 18 或更高版本。

## 模型列表操作

填写并保存 OpenAI 兼容接口后，界面会自动请求 \`GET /api/runtime/models\`。返回的每一个模型都会保留在“接口模型全量列表”中，不会只显示第一个或截断为固定数量。搜索框只筛选当前可见项；点击任意模型名称会自动填入“模型名称”，再保存即可使用。

## 自动连接当前 Codex

启动后，独立 Agent 会先探测本机正在使用的 Codex 配置：优先读取 \`CODEX_HOME/config.toml\`，也支持在 \`.env\` 中指定 \`CONVERSATION_AGENT_CODEX_HOME\` 或 \`CONVERSATION_AGENT_CODEX_CONFIG\`。探测成功时，界面会自动带入当前 Codex 的模型接口地址、模型名称和 \`responses\` 或 \`chat_completions\` 接口类型，并尝试读取完整模型列表。

模型密钥只从当前用户的本机环境或 Codex 本机凭据文件读取到 Agent 进程内存。接口 \`GET /api/runtime/codex-link\` 只返回是否检测到配置和密钥，不返回密钥；\`POST /api/runtime/codex-link\` 仅接受本机回环地址访问，用于重新应用当前 Codex 配置。未检测到时不会阻断 Agent，可使用下方的手动模型配置。

## 网页聊天记录由主工作台统一处理

ChatGPT、DeepSeek、Gemini 和豆包的网页聊天读取入口只放在蒸馏器主工作台，不放进生成后的独立 Agent 子界面。用户在主工作台选择平台后，可以打开对应网页、读取当前已加载的历史对话标题与链接、读取当前完整用户与 AI 消息，并将真实对话加入蒸馏范围。独立 Agent 只负责使用已经生成的能力执行本地任务，避免把来源接入和执行操作混在一个页面里。

首次使用时，在主工作台点击“自动准备浏览器伴侣”，系统会打开伴侣文件夹和 Chrome 或 Edge 扩展管理页。用户只需在扩展页确认一次“加载已解压的扩展程序”，选中伴侣文件夹，再点击工具栏中的“能力包网页聊天记录伴侣”。扩展会自动发现主工作台并完成配对；平台选择、历史目录读取、完整对话读取和导入操作全部回到主工作台完成。主工作台会显示“等待配对”“已连接”或“连接已中断”，以及当前网页平台、标题和最近响应时间。

网页连接与模型接口连接是两项独立能力：网页伴侣只在主工作台发起“读取历史对话目录”或“读取当前完整对话”时读取网页显示内容，不扫描未加载的历史记录；本地文件修改、命令执行、Git、验证和恢复点由独立 Agent 的正式模型接口及本地工具闭环完成。网页伴侣不会读取、导出或保存 Cookie、账号密码和网页令牌；配对令牌仅存在于浏览器扩展本地存储和本机服务进程内存，服务默认只监听 \`127.0.0.1\`。

## 权限

- 读取工作区：选择有效目录后开放。
- 文件写入：默认关闭，在界面中单独开启。
- 删除文件：默认关闭，必须单独开启；删除前创建检查点。
- 执行命令：默认关闭，在界面中单独开启。
- Git 写入：默认关闭；只允许创建本地提交，不会推送远程仓库。
- 网络读取：默认关闭；只读取公开页面内容，不携带密钥、Cookie 或工作区内容。
- 模型密钥：只保存在当前进程内存，不写入能力包、任务记录或命令环境。

## 任务状态

每个任务会经历等待、取证、规划、执行、验证和完成；也可能进入失败或已停止。任务数据按当前系统用户保存在本地数据目录，服务重启后仍可查看并继续，能力包本身可以只读。

## 接口

- \`GET /api/runtime/health\`：运行状态。
- \`GET /api/runtime/installation\`：安装条件、启动方式与数据保存说明。
- \`GET|PUT /api/runtime/config\`：模型配置。
- \`GET|POST /api/runtime/codex-link\`：读取或重新连接当前用户本机 Codex 的模型配置。
- \`GET /api/runtime/chatgpt-web\`：读取网页聊天记录伴侣的配对状态、当前网页、四个平台和支持的功能。
- \`POST /api/runtime/chatgpt-web/open\`：按请求中的 \`platform\` 使用系统浏览器打开 ChatGPT、DeepSeek、Gemini 或豆包网页。
- \`POST /api/runtime/chatgpt-web/companion/open-folder\`：打开包内浏览器伴侣安装文件夹。
- \`POST /api/runtime/chatgpt-web/companion/open-extensions\`：打开当前系统浏览器的扩展管理页。
- \`POST /api/runtime/chatgpt-web/companion/setup\`：一次性打开伴侣文件夹和扩展管理页，并返回当前工作台地址与备用配对信息；扩展弹窗会自动发现本机工作台。
- \`POST /api/runtime/chatgpt-web/jobs\`：发起历史目录读取、当前完整对话读取，或可选地向已配对网页发送任务。
- \`GET /api/runtime/chatgpt-web/jobs/:id\`：读取网页任务状态、历史标题与链接、回答或导入的完整对话快照。
- \`POST /api/runtime/chatgpt-web/disconnect\`：断开当前浏览器伴侣并轮换配对码。
- \`GET /api/runtime/models\`：读取接口返回的完整模型列表，供独立界面展示、筛选和选用。
- \`GET /api/runtime/capabilities\`：完整能力清单。
- \`GET /api/runtime/distillation\`：通用能力底座和本会话 P 阶段蒸馏结果。
- \`GET /api/runtime/sources\`：读取本次联合蒸馏的全部会话标题、编号、路径和统计。
- \`GET /api/runtime/project-evidence\`：读取项目结构、规则、文件状态、Git 原始版本/差异和生成产物证据。
- \`GET /api/runtime/project-understanding\`：读取跨会话证据图、逐文件演化、生成产物链路、冲突登记和主动读取/验证计划。
- \`GET /api/runtime/project-knowledge-v4\`：按分组分页读取跨会话时间线、语义阶段、证据账本、项目模型、项目图、文件版本、文件变更矩阵、依赖影响、产物血缘与复现状态、项目快照、待补证问题、后续决策、覆盖率和主动读取记录。
- \`GET /api/runtime/conversation/search\`：搜索原对话。
- \`GET|PUT /api/runtime/workspace\`：工作区与权限。
- \`GET|POST /api/runtime/tasks\`：任务列表与新建任务。
- \`GET /api/runtime/tasks/:id\`：任务详情。
- \`POST /api/runtime/tasks/:id/continue\`：继续任务。
- \`POST /api/runtime/tasks/:id/cancel\`：停止任务。
- \`POST /api/runtime/checkpoints/:id/restore\`：恢复检查点。
- \`POST /api/runtime/agent\`：兼容的流式 Agent 接口。
- \`GET /api/runtime/processes\`：查看由 Agent 管理的长期进程。
- \`GET /api/runtime/codex-alignment\`：读取 Codex 工程能力对齐说明。
`;
}

function envExample() {
  return `# 留空时，独立 Agent 会自动读取当前 Codex 的 CODEX_HOME/config.toml 和 env.json。\n# 使用启动器时无需填写这些变量；它不需要 npm install。\nCONVERSATION_AGENT_CODEX_HOME=\nCONVERSATION_AGENT_CODEX_CONFIG=\nCONVERSATION_AGENT_CODEX_ENV_FILE=\nCONVERSATION_AGENT_CODEX_BASE_URL=\nCONVERSATION_AGENT_CODEX_MODEL=\nCONVERSATION_AGENT_CODEX_WIRE_API=responses\nCONVERSATION_AGENT_OPENAI_BASE_URL=https://api.openai.com/v1\nCONVERSATION_AGENT_OPENAI_API_KEY=\nCONVERSATION_AGENT_OPENAI_MODEL=gpt-4.1-mini\nCONVERSATION_AGENT_OPENAI_WIRE_API=chat_completions\nCONVERSATION_AGENT_OPENAI_TIMEOUT_MS=60000\nCONVERSATION_AGENT_WORKSPACE_ROOT=\nCONVERSATION_AGENT_ALLOW_WRITE=0\nCONVERSATION_AGENT_ALLOW_DELETE=0\nCONVERSATION_AGENT_ALLOW_COMMAND=0\nCONVERSATION_AGENT_ALLOW_GIT_WRITE=0\nCONVERSATION_AGENT_ALLOW_NETWORK=0\n# 可填写一个或多个用户自己的 Skill 目录，使用分号分隔。\nCONVERSATION_AGENT_SKILL_ROOTS=\n# 默认按当前系统用户保存任务；仅在需要自定义时填写。\nCONVERSATION_AGENT_STATE_ROOT=\nCONVERSATION_AGENT_COMMAND_TIMEOUT_MS=60000\nCONVERSATION_AGENT_MAX_STEPS=24\nCONVERSATION_AGENT_HOST=127.0.0.1\nCONVERSATION_AGENT_PORT=8890\nCONVERSATION_AGENT_ALLOW_INSECURE_HTTP=0\n`;
}

function agentProfile(blueprint) {
  return {
    schemaVersion: '6.3.0',
    name: blueprint.package.name,
    packageId: blueprint.package.id,
    provider: 'openai-compatible',
    language: 'zh-CN',
    secretsPersisted: false,
    persistence: { tasks: 'local-json', configuration: 'memory-only', checkpoints: 'workspace-local' },
    features: {
      fullConversationExtraction: true,
      universalAndSpecializedDistillation: true,
      latestCorrectionPriority: true,
      evidenceFirstExecution: true,
      autonomousToolLoop: true,
      taskPersistence: true,
      taskResume: true,
      fileDiffJournal: true,
      checkpoints: true,
      rollback: true,
      commandVerification: true,
      visibleToolTrace: true,
      independentChineseUi: true,
      projectInspection: true,
      standardPatch: true,
      gitWorkflow: true,
      managedLongRunningProcesses: true,
      skillDiscovery: true,
      controlledWebResearch: true,
      codexAlignmentMatrix: true,
      fullModelCatalog: true,
      autoModelCatalogRefresh: true,
      currentCodexAutoLink: true,
      chatGptWebCompanion: true,
      chatGptWebPrompt: true,
      chatGptConversationImport: true,
      chatGptWebHistoryIndex: true,
      chatGptWebCurrentConversationRead: true,
      chatGptCredentialIsolation: true,
      webChatMainWorkbenchControls: true,
      webChatPlatformSelection: true,
      webChatPlatforms: ['chatgpt', 'deepseek', 'gemini', 'doubao'],
      localCodexConversationDiscovery: true,
      localCodexConversationLoading: true,
      localCodexTaskChainDiscovery: true,
      dynamicLocalConversationContext: true,
      loadedConversationContextTool: true,
      nativePathSelection: true,
      responsesApiAdapter: true,
      portableDistribution: true,
      oneClickInstall: true,
      automaticBrowserLaunch: true,
      zeroThirdPartyPackages: true,
      perUserStateStorage: true,
      multiConversationEvidence: true,
      projectSnapshotEvidence: true,
      projectArchitectureReading: true,
      gitBaselineEvidence: true,
      originalGeneratedFileComparison: true,
      sourceTraceableDistillation: true,
      projectEvidenceGraph: true,
      fileEvolutionEvidence: true,
      generatedArtifactLineage: true,
      conflictRegister: true,
      activeProjectReadPlan: true,
      crossSessionTimeline: true,
      fileChangeMatrix: true,
      dependencyImpactAnalysis: true,
      artifactReproducibility: true,
      incrementalProjectSnapshot: true,
      openEvidenceQuestions: true,
    },
    endpoints: {
      health: '/api/runtime/health', installation: '/api/runtime/installation', config: '/api/runtime/config', codexLink: '/api/runtime/codex-link', webChat: '/api/runtime/chatgpt-web', webChatJobs: '/api/runtime/chatgpt-web/jobs', chatGptWeb: '/api/runtime/chatgpt-web', chatGptWebJobs: '/api/runtime/chatgpt-web/jobs', localSessions: '/api/runtime/local-sessions', localTaskChains: '/api/runtime/task-chains', loadLocalSessions: '/api/runtime/local-sessions/load', pathPicker: '/api/runtime/path-picker', models: '/api/runtime/models', capabilities: '/api/runtime/capabilities',
      conversationSearch: '/api/runtime/conversation/search', distillation: '/api/runtime/distillation', recommendation: '/api/runtime/recommendation', sources: '/api/runtime/sources', projectEvidence: '/api/runtime/project-evidence', projectUnderstanding: '/api/runtime/project-understanding', projectKnowledgeV4: '/api/runtime/project-knowledge-v4', workspace: '/api/runtime/workspace', tools: '/api/runtime/tools', tasks: '/api/runtime/tasks', processes: '/api/runtime/processes', codexAlignment: '/api/runtime/codex-alignment', agent: '/api/runtime/agent',
    },
  };
}

async function writeKnowledgeV4Artifacts(root, knowledge) {
  if (!knowledge) return null;
  const files = {
    overview: path.join(root, 'project-knowledge-v4.json'),
    markdown: path.join(root, 'project-knowledge-v4.md'),
    semanticStages: path.join(root, 'semantic-stages.json'),
    evidenceLedger: path.join(root, 'evidence-ledger.ndjson'),
    projectModel: path.join(root, 'project-model.json'),
    projectGraph: path.join(root, 'project-graph.json'),
    fileVersions: path.join(root, 'file-versions.ndjson'),
    artifactLineage: path.join(root, 'artifact-lineage.json'),
    crossSessionTimeline: path.join(root, 'cross-session-timeline.ndjson'),
    fileChangeMatrix: path.join(root, 'file-change-matrix.json'),
    dependencyImpact: path.join(root, 'dependency-impact.json'),
    artifactReproducibility: path.join(root, 'artifact-reproducibility.json'),
    projectSnapshot: path.join(root, 'project-snapshot.json'),
    openEvidenceQuestions: path.join(root, 'open-evidence-questions.json'),
    decisionConflicts: path.join(root, 'decision-conflicts.json'),
    coverage: path.join(root, 'coverage.json'),
    activeReadLog: path.join(root, 'active-read-log.ndjson'),
  };
  await Promise.all([
    writeText(files.overview, JSON.stringify(knowledge, null, 2) + '\n'),
    writeText(files.markdown, knowledgeV4Markdown(knowledge)),
    writeText(files.semanticStages, JSON.stringify(knowledge.semanticStages, null, 2) + '\n'),
    writeText(files.evidenceLedger, ndjson(knowledge.evidenceLedger)),
    writeText(files.projectModel, JSON.stringify(knowledge.projectModel, null, 2) + '\n'),
    writeText(files.projectGraph, JSON.stringify(knowledge.projectGraph, null, 2) + '\n'),
    writeText(files.fileVersions, ndjson(knowledge.fileVersions)),
    writeText(files.artifactLineage, JSON.stringify(knowledge.artifactLineage, null, 2) + '\n'),
    writeText(files.crossSessionTimeline, ndjson(knowledge.crossSessionTimeline)),
    writeText(files.fileChangeMatrix, JSON.stringify(knowledge.fileChangeMatrix || [], null, 2) + '\n'),
    writeText(files.dependencyImpact, JSON.stringify(knowledge.dependencyImpact || null, null, 2) + '\n'),
    writeText(files.artifactReproducibility, JSON.stringify(knowledge.artifactReproducibility || [], null, 2) + '\n'),
    writeText(files.projectSnapshot, JSON.stringify(knowledge.projectSnapshot || null, null, 2) + '\n'),
    writeText(files.openEvidenceQuestions, JSON.stringify(knowledge.openEvidenceQuestions || [], null, 2) + '\n'),
    writeText(files.decisionConflicts, JSON.stringify(knowledge.decisionConflicts, null, 2) + '\n'),
    writeText(files.coverage, JSON.stringify(knowledge.coverage, null, 2) + '\n'),
    writeText(files.activeReadLog, ndjson(knowledge.activeReadLog)),
  ]);
  return files;
}

async function createSkill(packageRoot, blueprint, extraction, skillName, sourceSet = null, projectEvidence = null, understanding = null, knowledgeV4 = null, recommendation = null, projectPortfolio = null) {
  const skillContainer = path.join(packageRoot, 'skill');
  const root = path.join(skillContainer, skillName);
  await writeText(path.join(root, 'SKILL.md'), skillMarkdown(blueprint, skillName));
  await writeText(path.join(root, 'agents', 'openai.yaml'), `interface:\n  display_name: "${blueprint.package.name.replace(/"/g, '\\"')}"\n  short_description: "回查原对话后执行本地修改与验证"\n  default_prompt: "回查原对话中的最新纠正，检查当前工作区，完成真实修改并运行验证。"\n`);
  await writeText(path.join(root, 'scripts', 'inspect-package.mjs'), inspectScript());
  await writeText(path.join(root, 'scripts', 'prepare-task.mjs'), prepareTaskScript());
  await writeText(path.join(root, 'references', 'capability-contract.json'), JSON.stringify(blueprint.capabilityContract, null, 2) + '\n');
  if (blueprint.conversationDistillation) await writeText(path.join(root, 'references', 'conversation-distillation.json'), JSON.stringify(blueprint.conversationDistillation, null, 2) + '\n');
  await writeText(path.join(root, 'references', 'source-sessions.json'), JSON.stringify(sourceSet?.sessions || [], null, 2) + '\n');
  await writeText(path.join(root, 'references', 'project-evidence.json'), JSON.stringify(projectEvidence || null, null, 2) + '\n');
  await writeText(path.join(root, 'references', 'project-evidence.md'), projectEvidenceMarkdown(projectEvidence));
  await writeText(path.join(root, 'references', 'project-understanding.json'), JSON.stringify(understanding || null, null, 2) + '\n');
  await writeText(path.join(root, 'references', 'project-understanding.md'), projectUnderstandingMarkdown(understanding));
  await writeText(path.join(root, 'references', 'project-portfolio.json'), JSON.stringify(projectPortfolio || null, null, 2) + '\n');
  await writeText(path.join(root, 'references', 'project-portfolio.md'), projectPortfolioMarkdown(projectPortfolio));
  await writeText(path.join(root, 'references', 'distillation-recommendation.json'), JSON.stringify(recommendation || null, null, 2) + '\n');
  await writeText(path.join(root, 'references', 'PRIORITY-PLAN.md'), distillationRecommendationMarkdown(recommendation || {}));
  const projectKnowledge = await writeKnowledgeV4Artifacts(path.join(root, 'references'), knowledgeV4);
  await writeText(path.join(root, 'references', 'conversation-extraction.json'), JSON.stringify(extraction, null, 2) + '\n');
  await writeText(path.join(root, 'references', 'workflow-blueprint.json'), JSON.stringify(blueprint, null, 2) + '\n');
  const codexHome = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.codex');
  const installRoot = path.join(codexHome, 'skills', skillName);
  await copyTree(root, installRoot);
  const packageEntryFile = path.join(skillContainer, 'SKILL.md');
  await writeText(packageEntryFile, `# ${blueprint.package.name} Skill\n\n这是能力包内 Skill 的固定中文入口。\n\n- 可安装技能目录：\`./${skillName}/\`\n- 主技能文件：\`./${skillName}/SKILL.md\`\n- 当前用户安装目录：\`${installRoot.replace(/\\/g, '/')}\`\n- 安装状态：生成能力包时已复制到当前用户的 Codex Skills 目录；外部用户运行根目录的 \`install-and-start.cmd\` 即可完成本机安装并启动独立 Agent。\n\n执行前请从主技能文件开始读取，并结合其 \`references/\` 中的会话、项目、文件、Git、产物与验证证据。\n`);
  return {
    root,
    packageEntryFile,
    installDirectory: installRoot,
    skillFile: path.join(root, 'SKILL.md'),
    interfaceFile: path.join(root, 'agents', 'openai.yaml'),
    runner: path.join(root, 'scripts', 'prepare-task.mjs'),
    projectKnowledge,
  };
}

async function createMcp(packageRoot, blueprint) {
  const root = path.join(packageRoot, 'mcp');
  await fsp.mkdir(root, { recursive: true });
  const server = path.join(root, `${blueprint.package.id}-server.mjs`);
  await fsp.copyFile(path.join(TEMPLATE_ROOT, 'mcp-server.mjs'), server);
  const config = path.join(root, 'mcp.config.example.json');
  await writeText(config, JSON.stringify({
    mcpServers: {
      [blueprint.package.id]: {
        command: 'node',
        args: [server],
        env: {
          CAPABILITY_MCP_WORKSPACE_ROOT: 'C:\\你的项目目录',
          CAPABILITY_MCP_ALLOW_WRITE: '0',
          CAPABILITY_MCP_ALLOW_DELETE: '0',
          CAPABILITY_MCP_ALLOW_COMMAND: '0',
          CAPABILITY_MCP_ALLOW_GIT_WRITE: '0',
          CAPABILITY_MCP_ALLOW_NETWORK: '0',
          CAPABILITY_MCP_SKILL_ROOTS: '',
        },
      },
    },
  }, null, 2) + '\n');
  return { root, server, config };
}

async function createAgent(packageRoot, blueprint, extraction, sourceSet = null, projectEvidence = null, understanding = null, knowledgeV4 = null, recommendation = null, projectPortfolio = null, workCompilation = null) {
  const root = path.join(packageRoot, 'agent');
  await copyTree(path.join(TEMPLATE_ROOT, 'agent'), root);
  // The generated Agent is installable on its own, so ship the local Codex session reader with it.
  await fsp.copyFile(path.join(MODULE_DIR, 'session-forensics.mjs'), path.join(root, 'runtime', 'session-forensics.mjs'));
  // session-forensics.mjs imports the versioned IR bridge; ship that tree too.
  await copyTree(path.join(MODULE_DIR, 'ir'), path.join(root, 'runtime', 'ir'));
  await copyTree(path.join(MODULE_DIR, 'compilers'), path.join(root, 'runtime', 'compilers'));
  await copyTree(path.join(MODULE_DIR, 'evaluation'), path.join(root, 'runtime', 'evaluation'));
  await copyTree(path.join(MODULE_DIR, 'registry'), path.join(root, 'runtime', 'registry'));
  await copyTree(path.join(MODULE_DIR, 'evidence'), path.join(root, 'runtime', 'evidence'));
  await copyTree(path.join(MODULE_DIR, 'quality'), path.join(root, 'runtime', 'quality'));
  await copyTree(path.join(MODULE_DIR, 'source-adapters'), path.join(root, 'runtime', 'source-adapters'));
  await fsp.copyFile(path.join(MODULE_DIR, 'session-semantic-index.mjs'), path.join(root, 'runtime', 'session-semantic-index.mjs'));
  await fsp.copyFile(path.join(MODULE_DIR, 'local-path-picker.mjs'), path.join(root, 'runtime', 'local-path-picker.mjs'));
  const workflow = path.join(root, 'workflow-blueprint.json');
  const conversationExtraction = path.join(root, 'conversation-extraction.json');
  const capabilityContract = path.join(root, 'capability-contract.json');
  const conversationDistillation = path.join(root, 'conversation-distillation.json');
  const conversationDistillationMd = path.join(root, 'conversation-distillation.md');
  const sourceSessions = path.join(root, 'source-sessions.json');
  const projectEvidenceJson = path.join(root, 'project-evidence.json');
  const projectEvidenceMd = path.join(root, 'project-evidence.md');
  const projectUnderstandingJson = path.join(root, 'project-understanding.json');
  const projectUnderstandingMd = path.join(root, 'project-understanding.md');
  const projectPortfolioJson = path.join(root, 'project-portfolio.json');
  const projectPortfolioMd = path.join(root, 'project-portfolio.md');
  const recommendationJson = path.join(root, 'distillation-recommendation.json');
  const recommendationMd = path.join(root, 'PRIORITY-PLAN.md');
  const recommendationHtml = path.join(root, 'distillation-recommendation.html');
  const capabilityMd = path.join(root, 'CAPABILITY.md');
  const taskCatalogMd = path.join(root, 'TASK-CATALOG.md');
  const recommendationAlias = path.join(root, 'recommendation.json');
  const evidenceManifestJson = path.join(root, 'evidence-manifest.json');
  const uiBlueprint = path.join(root, 'ui', 'capability-ui.json');
  const aiProfile = path.join(root, 'ai-profile.json');
  const readme = path.join(root, 'README.md');
  const envPath = path.join(root, '.env.example');
  const launcher = path.join(root, 'launcher.mjs');
  const windowsLaunchPs1 = path.join(packageRoot, 'launch.ps1');
  const windowsInstallPs1 = path.join(packageRoot, 'install-and-start.ps1');
  const windowsLaunchCmd = path.join(packageRoot, 'launch.cmd');
  const windowsInstallCmd = path.join(packageRoot, 'install-and-start.cmd');
  const posixLaunch = path.join(packageRoot, 'launch.sh');
  const posixInstall = path.join(packageRoot, 'install-and-start.sh');
  await writeText(workflow, JSON.stringify(blueprint, null, 2) + '\n');
  await writeText(conversationExtraction, JSON.stringify(extraction, null, 2) + '\n');
  await writeText(capabilityContract, JSON.stringify(blueprint.capabilityContract, null, 2) + '\n');
  await writeText(conversationDistillation, JSON.stringify(blueprint.conversationDistillation || {}, null, 2) + '\n');
  await writeText(conversationDistillationMd, conversationDistillationMarkdown(blueprint.conversationDistillation || {}));
  await writeText(sourceSessions, JSON.stringify(sourceSet?.sessions || [], null, 2) + '\n');
  await writeText(projectEvidenceJson, JSON.stringify(projectEvidence || null, null, 2) + '\n');
  await writeText(projectEvidenceMd, projectEvidenceMarkdown(projectEvidence));
  await writeText(projectUnderstandingJson, JSON.stringify(understanding || null, null, 2) + '\n');
  await writeText(projectUnderstandingMd, projectUnderstandingMarkdown(understanding));
  await writeText(projectPortfolioJson, JSON.stringify(projectPortfolio || null, null, 2) + '\n');
  await writeText(projectPortfolioMd, projectPortfolioMarkdown(projectPortfolio));
  await writeText(recommendationJson, JSON.stringify(recommendation || null, null, 2) + '\n');
  await writeText(recommendationMd, distillationRecommendationMarkdown(recommendation || {}));
  await writeText(recommendationHtml, distillationRecommendationHtml(recommendation || {}));
  for (const [source, target] of [
    [path.join(packageRoot, 'CAPABILITY.md'), capabilityMd],
    [path.join(packageRoot, 'TASK-CATALOG.md'), taskCatalogMd],
    [path.join(packageRoot, 'recommendation.json'), recommendationAlias],
    [path.join(packageRoot, 'evidence-manifest.json'), evidenceManifestJson],
    [path.join(packageRoot, 'work-capability-ir.v2.json'), path.join(root, 'work-capability-ir.v2.json')],
    [path.join(packageRoot, 'coverage-matrix.json'), path.join(root, 'coverage-matrix.json')],
    [path.join(packageRoot, 'work-evidence-ledger.ndjson'), path.join(root, 'work-evidence-ledger.ndjson')],
    [path.join(packageRoot, 'execution-graph.json'), path.join(root, 'execution-graph.json')],
    [path.join(packageRoot, 'release-decision.json'), path.join(root, 'release-decision.json')],
    [path.join(packageRoot, 'coverage-gaps.json'), path.join(root, 'coverage-gaps.json')],
    [path.join(packageRoot, 'semantic-evaluation-plan.json'), path.join(root, 'semantic-evaluation-plan.json')],
    [path.join(packageRoot, 'deterministic-replay.json'), path.join(root, 'deterministic-replay.json')],
    [path.join(packageRoot, 'original-task-replay.json'), path.join(root, 'original-task-replay.json')],
    [path.join(packageRoot, 'held-out-evaluation.json'), path.join(root, 'held-out-evaluation.json')],
    [path.join(packageRoot, 'isolated-agent-validation.json'), path.join(root, 'isolated-agent-validation.json')],
  ]) await fsp.copyFile(source, target);
  await writeText(path.join(root, 'ui', 'work-capability.json'), JSON.stringify(workCompilation?.workCapability || null, null, 2) + '\n');
  const projectKnowledge = await writeKnowledgeV4Artifacts(root, knowledgeV4);
  await writeText(uiBlueprint, JSON.stringify(blueprint.ui, null, 2) + '\n');
  await writeText(aiProfile, JSON.stringify(agentProfile(blueprint), null, 2) + '\n');
  await writeText(readme, agentReadme(blueprint));
  await writeText(envPath, envExample());
  await writeText(launcher, agentLauncherSource());
  await writeText(windowsLaunchPs1, windowsLaunchPowerShell());
  await writeText(windowsInstallPs1, windowsInstallPowerShell(blueprint.package.id));
  await writeText(windowsLaunchCmd, windowsCmd('launch.ps1'));
  await writeText(windowsInstallCmd, windowsCmd('install-and-start.ps1'));
  await writeText(posixLaunch, posixLaunchShell());
  await writeText(posixInstall, posixInstallShell(blueprint.package.id));
  await Promise.all([posixLaunch, posixInstall].map(async (filePath) => { try { await fsp.chmod(filePath, 0o755); } catch {} }));
  return {
    root,
    server: path.join(root, 'agent-server.mjs'),
    aiProfile,
    readme,
    envExample: envPath,
    workflow,
    conversationExtraction,
    capabilityContract,
    conversationDistillation,
    conversationDistillationMarkdown: conversationDistillationMd,
    sourceSessions,
    projectEvidence: projectEvidenceJson,
    projectEvidenceMarkdown: projectEvidenceMd,
    projectUnderstanding: projectUnderstandingJson,
    projectUnderstandingMarkdown: projectUnderstandingMd,
    projectPortfolio: projectPortfolioJson,
    projectPortfolioMarkdown: projectPortfolioMd,
    recommendation: { json: recommendationJson, markdown: recommendationMd, html: recommendationHtml },
    capability: capabilityMd,
    taskCatalog: taskCatalogMd,
    evidenceManifest: evidenceManifestJson,
    workCapability: path.join(root, 'work-capability-ir.v2.json'),
    coverageMatrix: path.join(root, 'coverage-matrix.json'),
    evidenceLedger: path.join(root, 'work-evidence-ledger.ndjson'),
    executionGraph: path.join(root, 'execution-graph.json'),
    releaseDecision: path.join(root, 'release-decision.json'),
    coverageGaps: path.join(root, 'coverage-gaps.json'),
    semanticEvaluationPlan: path.join(root, 'semantic-evaluation-plan.json'),
    deterministicReplay: path.join(root, 'deterministic-replay.json'),
    originalTaskReplay: path.join(root, 'original-task-replay.json'),
    heldOutEvaluation: path.join(root, 'held-out-evaluation.json'),
    isolatedAgentValidation: path.join(root, 'isolated-agent-validation.json'),
    projectKnowledge,
    localSessionReader: path.join(root, 'runtime', 'session-forensics.mjs'),
    localPathPicker: path.join(root, 'runtime', 'local-path-picker.mjs'),
    uiBlueprint,
    launcher,
    install: {
      windows: { oneClick: windowsInstallCmd, direct: windowsLaunchCmd, installer: windowsInstallPs1, launcher: windowsLaunchPs1 },
      posix: { oneClick: posixInstall, direct: posixLaunch },
    },
    ui: {
      index: path.join(root, 'ui', 'index.html'),
      app: path.join(root, 'ui', 'app.js'),
      styles: path.join(root, 'ui', 'styles.css'),
      blueprint: uiBlueprint,
    },
    chatGptWeb: {
      companion: path.join(root, 'chatgpt-companion'),
      readme: path.join(root, 'chatgpt-companion', 'README.md'),
      manifest: path.join(root, 'chatgpt-companion', 'manifest.json'),
    },
    startCommand: 'node agent/launcher.mjs',
  };
}

function capabilityMarkdown(identity, recommendation, packageDescription, blueprint, projectEvidence) {
  const priorities = recommendation?.priorities || [];
  const primary = priorities.filter((item) => item.distillationPriority?.level !== 'P3');
  const capabilities = primary.map((item) => [
    `### ${item.distillationPriority?.level || item.level}｜${item.title}`,
    '',
    `- **能完成什么**：${item.purpose || item.expectedOutput}`,
    `- **什么时候使用**：收到与“${item.title}”目标相同，或涉及 ${(item.affectedFiles || []).slice(0, 4).join('、') || '对应业务输入'} 的任务时。`,
    `- **执行方法**：${item.agentExecutionPriority?.reason || item.nextAction}`,
    `- **产出**：${item.expectedOutput}`,
    `- **原会话实际工具**：${(item.observedTools || []).join('、') || '会话没有留下可核对的工具记录'}`,
    `- **证据**：${(item.evidenceIds || []).join('、') || '未记录'}`,
  ].join('\n')).join('\n\n') || '当前没有形成可执行的核心能力。';
  const naming = identity?.naming || {};
  const sourceTopics = unique([...(naming.contentTopics || []), ...(naming.subjects || [])], 12);
  const tools = unique([...(naming.observedTools || []), ...priorities.flatMap((item) => item.observedTools || [])], 20);
  const project = projectEvidence?.project?.name || recommendation?.summary?.project || '未发现唯一项目名称';
  const projectFiles = unique(priorities.flatMap((item) => item.affectedFiles || []), 16);
  return `# ${identity?.name || '会话专属能力包'}：直白能力说明

## 一句话说明

${packageDescription?.summary || recommendation?.summary?.headline || '本包把所选会话中已经执行并验证过的工作流程封装成可复用能力。'}

## 这个包能做什么

${capabilities}

## 默认工作方式

1. 读取所选工作区、项目规则和当前文件。
2. 对照本包的 P0-P3 计划，先应用最新用户修正并处理失败验证。
3. 列出准备读取、修改和执行的内容，再开始实际工作。
4. 修改文件或执行命令后查看差异并运行验证。
5. 展示生成文件、验证结果和恢复检查点。

## 适合交给它的任务

${primary.map((item) => `- ${item.title}：${item.purpose}`).join('\n') || '- 与已选会话目标一致，并能提供必要输入的工作。'}

## 不会自动假定的内容

- 未出现在会话、项目文件、Git、产物或验证证据中的业务规则，不会被当成已确认事实。
- 当前工作区与蒸馏时证据冲突时，Agent 会先显示差异，再执行修改。
- 需要外部账号、密钥或付费服务的步骤，必须由使用者在本机配置；这些秘密不会写进能力包。
- P3 内容默认只作为候选专长，不会覆盖 P0/P1 的执行路径。

## 名称为什么这样定

- **最终名称**：${identity?.name || '会话专属能力包'}
- **会话主题**：${sourceTopics.join('、') || '依据完整会话需求阶段提取'}
- **关联项目**：${project}
- **实际工具链**：${tools.join('、') || '依据会话中的工具调用生成'}
- **关联文件与产物**：${projectFiles.join('、') || '未发现可公开列出的项目文件'}
- **命名规则**：领域或对象 + 核心目标 + 主要产物 + 执行方式；最新用户修正优先于早期方案。

## 交付物

- 可安装 Skill：把专属工作法装入支持 Skill 的环境。
- MCP 服务：让其他智能体读取建议、证据与项目能力。
- 独立 Agent 与中文 UI：选择工作区、输入目标后直接执行。
- PRIORITY-PLAN.md：三套独立判断和 P0-P3 顺序。
- TASK-CATALOG.md：可以直接交给 Agent 的具体任务。
- evidence-manifest.json：会话、文件、Git、产物和验证证据索引。
- workflow-blueprint.json：供程序读取的完整执行约定。

## 启动

Windows 双击 install-and-start.cmd。首次打开后只需选择工作区、填写目标并点击“开始执行”。高级模型和权限设置在界面中按需展开。
`;
}

function taskCatalogMarkdown(recommendation) {
  const tasks = (recommendation?.priorities || []).map((item) => [
    `## ${item.rank}. ${item.distillationPriority?.level || item.level}｜${item.title}`,
    '',
    `- **任务目标**：${item.purpose}`,
    `- **蒸馏优先级**：${item.distillationPriority?.level || item.level}（${item.distillationPriority?.score ?? item.score}/100）`,
    `- **Agent 执行优先级**：${item.agentExecutionPriority?.level || item.level}（${item.agentExecutionPriority?.score ?? item.score}/100）`,
    `- **开始前读取**：${(item.affectedFiles || []).map((file) => `\`${file}\``).join('、') || '工作区规则、输入文件和已有产物'}`,
    `- **执行步骤**：理解输入 → ${item.agentExecutionPriority?.reason || '按会话提炼流程执行'} → 生成或修改文件 → 查看差异 → 运行验证`,
    `- **预期产物**：${item.expectedOutput}`,
    `- **完成标准**：产物存在、差异可解释、验证有结果、失败时保留恢复检查点。`,
    `- **为什么排序在这里**：${(item.why || []).join('；') || '来自完整会话的明确需求。'}`,
    `- **证据置信度**：${item.evidenceConfidence?.level || '待确认'}（${item.evidenceConfidence?.score || 0}/100）`,
    `- **证据编号**：${(item.evidenceIds || []).join('、') || '未记录'}`,
  ].join('\n')).join('\n\n');
  return `# 可直接执行的任务目录

本目录按确定性规则排序。P0 先处理最新修正、冲突和失败验证；P1 是核心工作流；P2 是文件、脚本、产物和验证增强；P3 是待补证的候选流程。

${tasks || '当前没有可执行任务。'}
`;
}

function packageEvidenceManifest(recommendation, sourceSet, projectDiscovery, projectEvidence, projectKnowledgeV4, projectPortfolio = null) {
  return {
    schemaVersion: '2.0.0',
    generatedAt: new Date().toISOString(),
    sessions: (sourceSet?.sessions || []).map((item) => ({ sessionId: item.sessionId, title: item.title || null, sourcePath: item.sourcePath || null, sha256: item.sha256 || null, recordCount: item.recordCount || null })),
    project: { mode: projectDiscovery?.mode || '未发现', selectedPath: projectDiscovery?.selectedPath || projectEvidence?.project?.root || null, name: projectEvidence?.project?.name || null, git: projectEvidence?.git || null },
    projectPortfolio: projectPortfolio ? {
      mode: projectPortfolio.mode,
      recommendedMode: projectPortfolio.recommendedMode,
      crossProject: projectPortfolio.crossProject,
      projects: (projectPortfolio.projects || []).map((item) => ({
        projectId: item.projectId,
        name: item.name,
        root: item.root,
        sessionCount: item.sessionCount,
        sessionIds: item.sessionIds || [],
        confidence: item.confidence,
        evidenceSummary: item.evidenceSummary || null,
      })),
      sessionAssignments: projectPortfolio.sessionAssignments || [],
      unassignedSessions: projectPortfolio.unassignedSessions || [],
    } : null,
    graph: recommendation?.evidenceGraph || { nodes: [], edges: [], statistics: {} },
    evidence: recommendation?.evidence || [],
    files: projectKnowledgeV4?.fileChangeMatrix || [],
    fileVersions: projectKnowledgeV4?.fileVersions || [],
    artifacts: projectKnowledgeV4?.artifactLineage || [],
    verifications: (recommendation?.evidence || []).filter((item) => item.type === 'verification'),
  };
}

async function collectArtifacts(root) {
  const artifacts = {};
  async function visit(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile()) {
        const relative = path.relative(root, filePath).split(path.sep).join('/');
        if (relative === 'package-manifest.json') continue;
        const data = await fsp.readFile(filePath);
        artifacts[relative] = { bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
      }
    }
  }
  await visit(root);
  return artifacts;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xEDB88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data) {
  let value = 0xFFFFFFFF;
  for (const byte of data) value = CRC32_TABLE[(value ^ byte) & 0xFF] ^ (value >>> 8);
  return (value ^ 0xFFFFFFFF) >>> 0;
}

function zipTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getSeconds() >> 1) | (date.getMinutes() << 5) | (date.getHours() << 11),
    day: date.getDate() | ((date.getMonth() + 1) << 5) | ((year - 1980) << 9),
  };
}

async function createPortableArchive(packageRoot, archivePath) {
  const names = [];
  async function visit(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile()) names.push(filePath);
    }
  }
  await visit(packageRoot);
  names.sort((left, right) => left.localeCompare(right));
  const prefix = path.basename(packageRoot);
  const local = [];
  const central = [];
  let offset = 0;
  const now = zipTime(new Date());
  for (const filePath of names) {
    const data = await fsp.readFile(filePath);
    const relative = path.relative(packageRoot, filePath).split(path.sep).join('/');
    const name = Buffer.from(`${prefix}/${relative}`, 'utf8');
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034B50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(now.time, 10);
    header.writeUInt16LE(now.day, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014B50, 0);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(now.time, 12);
    record.writeUInt16LE(now.day, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + data.length;
  }
  const centralBytes = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBytes, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  await fsp.writeFile(archivePath, Buffer.concat([...local, ...central, end]));
  return { path: archivePath, files: names.length, bytes: (await fsp.stat(archivePath)).size };
}

async function verifyPortableArchive(archivePath, targets = []) {
  const data = await fsp.readFile(archivePath);
  const knowledgeFiles = ['project-knowledge-v4.json', 'project-knowledge-v4.md', 'semantic-stages.json', 'evidence-ledger.ndjson', 'project-model.json', 'project-graph.json', 'file-versions.ndjson', 'artifact-lineage.json', 'cross-session-timeline.ndjson', 'file-change-matrix.json', 'dependency-impact.json', 'artifact-reproducibility.json', 'project-snapshot.json', 'open-evidence-questions.json', 'decision-conflicts.json', 'coverage.json', 'active-read-log.ndjson'];
  const required = ['README.md', 'CAPABILITY.md', 'PRIORITY-PLAN.md', 'TASK-CATALOG.md', 'recommendation.json', 'evidence-manifest.json', 'package-manifest.json', 'conversation-distillation.json', 'conversation-distillation.md', 'source-sessions.json', 'project-discovery.json', 'project-discovery.md', 'project-portfolio.json', 'project-portfolio.md', 'project-evidence.json', 'project-evidence.md', 'project-understanding.json', 'project-understanding.md', ...knowledgeFiles];
  if (targets.includes('agent')) required.push('agent/launcher.mjs', 'agent/ui/index.html', 'agent/CAPABILITY.md', 'agent/PRIORITY-PLAN.md', 'agent/TASK-CATALOG.md', 'agent/recommendation.json', 'agent/evidence-manifest.json', 'agent/conversation-distillation.json', 'agent/source-sessions.json', 'agent/project-portfolio.json', 'agent/project-portfolio.md', 'agent/project-evidence.json', 'agent/project-understanding.json', 'agent/project-understanding.md', ...knowledgeFiles.map((file) => `agent/${file}`), 'launch.cmd', 'install-and-start.cmd');
  const missing = required.filter((file) => !data.includes(Buffer.from(file, 'utf8')));
  return { ok: data.subarray(0, 4).equals(Buffer.from([0x50, 0x4B, 0x03, 0x04])) && data.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06])) >= 0 && missing.length === 0, missing };
}

export async function createConversationCapabilityArchive(packageRoot, archivePath) {
  return createPortableArchive(packageRoot, archivePath);
}

function verifyScript() {
  return `import crypto from 'node:crypto';\nimport fs from 'node:fs/promises';\nimport path from 'node:path';\nimport {fileURLToPath} from 'node:url';\nconst root=path.dirname(fileURLToPath(import.meta.url));\nconst manifest=JSON.parse(await fs.readFile(path.join(root,'package-manifest.json'),'utf8'));\nconst failures=[];\nfor(const [relative,expected] of Object.entries(manifest.integrity.artifacts)){try{const data=await fs.readFile(path.resolve(root,...relative.split('/')));const hash=crypto.createHash('sha256').update(data).digest('hex');if(hash!==expected.sha256||data.length!==expected.bytes)failures.push(relative);}catch{failures.push(relative);}}\nif(!['3.0.0','3.1.0'].includes(manifest.schemaVersion)||!['whole-session','multi-session'].includes(manifest.selection.mode))failures.push('能力包契约');\nif(failures.length){process.stderr.write('能力包校验失败：'+failures.join('、')+'\\n');process.exitCode=1;}else process.stdout.write('能力包校验通过：'+Object.keys(manifest.integrity.artifacts).length+' 个文件，v3 Codex 工程能力契约和完整来源锚点有效。\\n');\n`;
}

function relatedProjectFiles(extraction, analysis) {
  const staged = (extraction?.stages || []).flatMap((stage) => (stage.fileChanges || []).map((change) => ({
    ...change,
    stage: stage.index,
    stageTitle: stageLabel(stage, stage.index),
    sourceSessionId: change.sourceSessionId || stage.sourceSessions?.[0] || null,
    sourceTitle: change.sourceTitle || stage.sourceTitles?.[0] || null,
  })));
  const raw = analysis?.codeArtifacts?.fileChanges || [];
  const merged = new Map();
  for (const item of [...raw, ...staged]) {
    const key = [item.sourceSessionId || '', item.eventIndex ?? '', item.path || '', item.action || ''].join('\u001f');
    const existing = merged.get(key) || {};
    // Stage records add semantic context; raw records preserve events that
    // stage segmentation did not capture.
    merged.set(key, { ...existing, ...item, stage: item.stage ?? existing.stage, stageTitle: item.stageTitle ?? existing.stageTitle });
  }
  return [...merged.values()];
}

function pathBelongsToProject(projectRoot, candidatePath) {
  if (!projectRoot || !candidatePath || !path.isAbsolute(candidatePath)) return false;
  const relative = path.relative(path.resolve(projectRoot), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function filesForProject(project, relatedFiles) {
  const sessionIds = new Set((project?.sessions || []).map((item) => item.sessionId).filter(Boolean));
  return (relatedFiles || []).filter((item) => {
    const sourceSessionId = item?.sourceSessionId || item?.sessionId || null;
    if (sourceSessionId && sessionIds.has(sourceSessionId)) return true;
    return pathBelongsToProject(project?.root, item?.path);
  });
}

function sameProjectRoot(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function buildProjectPortfolio({ projectDiscovery, relatedFiles, redact, primaryEvidence = null }) {
  const projects = [];
  for (const project of projectDiscovery?.projects || []) {
    const projectFiles = filesForProject(project, relatedFiles);
    let evidence = sameProjectRoot(project.root, primaryEvidence?.project?.root) ? primaryEvidence : null;
    let evidenceError = null;
    if (!evidence) {
      try {
        evidence = await analyseProjectEvidence({
          projectPath: project.root,
          relatedFiles: projectFiles,
          redact,
          relevanceOnly: true,
          relevanceMaxFiles: 120,
          relevanceKeywords: projectFiles.flatMap((item) => [item?.path, item?.stageTitle, item?.action, item?.kind]),
        });
      } catch (error) {
        evidenceError = cleanText(error?.message || error, 1000);
      }
    }
    projects.push({
      projectId: project.projectId,
      name: evidence?.project?.name || project.name,
      root: project.root,
      score: project.score,
      confidence: project.confidence,
      git: project.git,
      markers: project.markers || [],
      linkedFiles: project.linkedFiles || 0,
      sessionCount: project.sessionCount || (project.sessions || []).length,
      sessionIds: (project.sessions || []).map((item) => item.sessionId).filter(Boolean),
      sessions: project.sessions || [],
      relatedFiles: projectFiles,
      evidenceSummary: evidence?.summary || null,
      evidence,
      evidenceError,
    });
  }
  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    mode: projectDiscovery?.mode || '未发现',
    recommendedMode: projectDiscovery?.recommendedMode || '按现有证据蒸馏',
    crossProject: Boolean(projectDiscovery?.crossProject),
    projects,
    sessionAssignments: projectDiscovery?.sessionAssignments || [],
    unassignedSessions: projectDiscovery?.unassignedSessions || [],
  };
}

function sessionsOnlyProjectDiscovery(sources = []) {
  return {
    schemaVersion: '2.0.0',
    mode: 'sessions-only',
    selectedPath: null,
    selectedProjectRoot: null,
    confidence: '高',
    reason: '当前选择仅包含明确会话，不读取关联项目或整个工作区。',
    candidates: [],
    signalsConsidered: 0,
    crossProject: false,
    recommendedMode: '仅按选中会话蒸馏',
    projects: [],
    sessionAssignments: [],
    unassignedSessions: (sources || []).map((source) => ({
      sessionId: source.sessionId || source.parsed?.sessionId || null,
      title: source.title || null,
      sourcePath: source.sourcePath || null,
      reason: '当前为会话范围；如需读取项目，请单独选择项目或工作区。',
    })),
  };
}

async function resolveProjectEvidence({ projectPath, projectScope = 'sessions-only', contextMode = 'conversation-only', projectConfirmed = false, projectContext = null, sources, parsed, extraction, analysis, redact }) {
  const scopePolicy = normalizeScopePolicy({ projectPath, projectScope, contextMode, projectConfirmed, projectContext });
  if (!scopePolicy.projectConfirmed || scopePolicy.projectScope === 'sessions-only') {
    const projectDiscovery = sessionsOnlyProjectDiscovery(sources);
    const projectPortfolio = await buildProjectPortfolio({ projectDiscovery, relatedFiles: [], redact, primaryEvidence: null });
    return { projectDiscovery, projectEvidence: null, projectPortfolio };
  }
  const relatedFiles = relatedProjectFiles(extraction, analysis);
  const projectDiscovery = await discoverRelatedProjects({ projectPath, sources, parsed, relatedFiles });
  const primaryProject = (projectDiscovery.projects || []).find((item) => sameProjectRoot(item.root, projectDiscovery.selectedPath)) || projectDiscovery.projects?.[0] || null;
  const primaryFiles = primaryProject ? filesForProject(primaryProject, relatedFiles) : relatedFiles;
  const projectEvidence = await analyseProjectEvidence({
    projectPath: projectDiscovery.selectedPath,
    relatedFiles: primaryFiles,
    redact,
    relevanceOnly: true,
    relevanceMaxFiles: projectContext?.maxFiles || 120,
    relevanceKeywords: [
      ...primaryFiles.flatMap((item) => [item?.path, item?.stageTitle, item?.action, item?.kind]),
      ...(extraction?.stages || []).flatMap((item) => [item?.title, item?.purpose, item?.action]),
    ],
  });
  if (projectEvidence) {
    projectEvidence.discovery = projectDiscovery;
    projectEvidence.project.selectionMode = projectDiscovery.mode;
    projectEvidence.project.selectionConfidence = projectDiscovery.confidence;
    projectEvidence.summary.discoveryMode = projectDiscovery.mode;
    projectEvidence.summary.discoveryConfidence = projectDiscovery.confidence;
    projectEvidence.summary.discoveryReason = projectDiscovery.reason;
    projectEvidence.summary.candidateProjects = projectDiscovery.candidates.length;
  }
  const projectPortfolio = await buildProjectPortfolio({ projectDiscovery, relatedFiles, redact, primaryEvidence: projectEvidence });
  return { projectDiscovery, projectEvidence, projectPortfolio };
}

export async function previewConversationCapabilityV2({
  threadId,
  sourcePath,
  threadIds = [],
  sourcePaths = [],
  roots = [],
  projectPath,
  projectScope = 'sessions-only',
  contextMode = 'conversation-only',
  projectConfirmed = false,
  projectContext = null,
  packageId,
  packageName,
  includeEvidence = true,
  redact = true,
  ai = {},
} = {}) {
  const loaded = await loadConversationSources({ threadId, sourcePath, threadIds, sourcePaths, roots, redact });
  const { mergedParsed: parsed, analysis, sourceSet } = loaded;
  const preliminaryExtraction = buildExtraction(analysis, parsed, { sourceSet });
  const { projectDiscovery, projectEvidence, projectPortfolio } = await resolveProjectEvidence({
    projectPath,
    projectScope,
    contextMode,
    projectConfirmed,
    projectContext,
    sources: loaded.sources,
    parsed,
    extraction: preliminaryExtraction,
    analysis,
    redact,
  });
  analysis.sourceSet = sourceSet;
  analysis.scopePolicy = normalizeScopePolicy({ projectPath, projectScope, contextMode, projectConfirmed, projectContext });
  analysis.projectDiscovery = projectDiscovery;
  analysis.projectEvidenceSummary = projectEvidence?.summary || null;
  analysis.projectEvidence = projectEvidence;
  analysis.projectPortfolio = projectPortfolio;
  const derived = detectIdentity(analysis, parsed, sourceSet, projectEvidence);
  const identity = {
    ...derived,
    id: isGenericIdentity(packageId) ? derived.id : safePackageId(packageId, derived.id),
    name: isGenericIdentity(packageName) ? derived.name : cleanText(packageName, 180),
  };
  if (identity.name !== derived.name) identity.naming = { ...derived.naming, mode: `${derived.naming.mode}（人工名称覆盖）`, overriddenName: identity.name };
  const extraction = buildExtraction(analysis, parsed, { sourceSet, projectEvidence });
  const understanding = buildProjectUnderstanding({ projectEvidence, extraction, sourceSet });
  if (projectEvidence) projectEvidence.understanding = understanding;
  analysis.projectUnderstanding = understanding;
  const projectKnowledgeV4 = buildProjectKnowledgeV4({ extraction, sourceSet, projectDiscovery, projectEvidence, projectUnderstanding: understanding });
  analysis.projectKnowledgeV4 = projectKnowledgeV4;
  const ui = await distillConversationUi({ analysis, extraction, identity, ai, sourceSet, projectEvidence });
  refineIdentityFromDistillation(identity, ui, sourceSet, projectEvidence);
  const recommendation = buildDistillationRecommendation({ identity, extraction, sourceSet, projectEvidence, projectKnowledgeV4 });
  return { source: loaded.sources[0] || null, sources: loaded.sources, sourceSet, projectDiscovery, projectPortfolio, projectEvidence, projectUnderstanding: understanding, projectKnowledgeV4, recommendation, parsed, analysis, identity, extraction, ui };
}

export async function packageConversationV2({
  threadId,
  sourcePath,
  threadIds = [],
  sourcePaths = [],
  roots = [],
  projectPath,
  projectScope = 'sessions-only',
  contextMode = 'conversation-only',
  projectConfirmed = false,
  projectContext = null,
  packageId,
  packageName,
  requestedSubject = null,
  targets = TARGETS,
  scope = 'whole-session',
  includeEvidence = true,
  redact = true,
  ai = {},
  recommendationOverride = null,
  uiBlueprintOverride = null,
  heldOutCandidate = null,
  outputRoot = ROOT_CAPABILITY_PACKAGES_ROOT,
} = {}) {
  if (scope !== 'whole-session') throw new Error('新版能力包固定提取完整会话，不能选择不完整范围。');
  const selectedTargets = normalizeTargets(targets);
  const loaded = await loadConversationSources({ threadId, sourcePath, threadIds, sourcePaths, roots, redact });
  const { mergedParsed: parsed, analysis, sourceSet } = loaded;
  const preliminaryExtraction = buildExtraction(analysis, parsed, { sourceSet });
  const { projectDiscovery, projectEvidence, projectPortfolio } = await resolveProjectEvidence({
    projectPath,
    projectScope,
    contextMode,
    projectConfirmed,
    projectContext,
    sources: loaded.sources,
    parsed,
    extraction: preliminaryExtraction,
    analysis,
    redact,
  });
  analysis.sourceSet = sourceSet;
  analysis.scopePolicy = normalizeScopePolicy({ projectPath, projectScope, contextMode, projectConfirmed, projectContext });
  analysis.projectDiscovery = projectDiscovery;
  analysis.projectEvidenceSummary = projectEvidence?.summary || null;
  analysis.projectEvidence = projectEvidence;
  analysis.projectPortfolio = projectPortfolio;
  const derived = detectIdentity(analysis, parsed, sourceSet, projectEvidence);
  const identity = {
    ...derived,
    id: isGenericIdentity(packageId) ? derived.id : safePackageId(packageId, derived.id),
    name: isGenericIdentity(packageName) ? derived.name : cleanText(packageName, 180),
  };
  if (identity.name !== derived.name) identity.naming = { ...derived.naming, mode: `${derived.naming.mode}（人工名称覆盖）`, overriddenName: identity.name };
  const outputKey = `${identity.id}-${sourceSet.mode === 'multi-session' ? `multi-${sourceSet.sessionCount}` : String(parsed.sessionId || 'source').slice(0, 8).toLowerCase()}-${Date.now()}`;
  const packageRoot = path.resolve(outputRoot, outputKey);
  const outputRelative = path.relative(path.resolve(outputRoot), packageRoot);
  if (!outputRelative || outputRelative.startsWith('..') || path.isAbsolute(outputRelative)) throw new Error('能力包输出目录超出允许范围。');
  await fsp.mkdir(packageRoot, { recursive: true });
  const extraction = buildExtraction(analysis, parsed, { sourceSet, projectEvidence });
  const understanding = buildProjectUnderstanding({ projectEvidence, extraction, sourceSet });
  if (projectEvidence) projectEvidence.understanding = understanding;
  analysis.projectUnderstanding = understanding;
  const projectKnowledgeV4 = buildProjectKnowledgeV4({ extraction, sourceSet, projectDiscovery, projectEvidence, projectUnderstanding: understanding });
  analysis.projectKnowledgeV4 = projectKnowledgeV4;
  const skillName = `${identity.id}-workflow`.slice(0, 63).replace(/-+$/g, '');
  const distilledUi = await distillConversationUi({ analysis, extraction, identity, ai, sourceSet, projectEvidence });
  const ui = uiBlueprintOverride && typeof uiBlueprintOverride === 'object'
    ? applyConversationUiOverrides(distilledUi, uiBlueprintOverride)
    : distilledUi;
  refineIdentityFromDistillation(identity, ui, sourceSet, projectEvidence);
  const recommendation = recommendationOverride || buildDistillationRecommendation({ identity, extraction, sourceSet, projectEvidence, projectKnowledgeV4 });
  const conversationDistillation = buildConversationDistillation(identity, extraction, ui, sourceSet, projectEvidence, analysis);
  const packageDescription = buildPackageDescription(identity, analysis, extraction, selectedTargets, conversationDistillation, sourceSet, projectEvidence);
  const blueprint = buildBlueprint(analysis, extraction, identity, selectedTargets, skillName, redact !== false, ui, sourceSet, projectEvidence, projectPortfolio);
  blueprint.package.description = packageDescription;
  blueprint.conversationDistillation = conversationDistillation;
  blueprint.distillationRecommendation = recommendation;
  const workCompilationInput = {
    runId: outputKey,
    identity,
    requestedSubject,
    sourceSet,
    extraction,
    recommendation,
    projectKnowledgeV4,
    projectUnderstanding: understanding,
    projectPortfolio,
    ui,
  };
  const replayFirst = buildPackageWorkCapability(workCompilationInput);
  const replaySecond = buildPackageWorkCapability(workCompilationInput);
  const deterministicReplay = {
    schemaVersion: 'deterministic-replay/v2',
    runId: outputKey,
    status: replayFirst.workCapability.fingerprint === replaySecond.workCapability.fingerprint ? 'pass' : 'fail',
    firstFingerprint: replayFirst.workCapability.fingerprint,
    secondFingerprint: replaySecond.workCapability.fingerprint,
    reason: replayFirst.workCapability.fingerprint === replaySecond.workCapability.fingerprint
      ? '相同输入连续编译两次得到相同 Work Capability IR 指纹。'
      : '相同输入连续编译两次得到不同指纹，需要检查非确定性字段。',
  };
  const originalTaskReplay = replayOriginalTask({ extraction, workCapability: replayFirst.workCapability });
  const heldOutEvaluation = evaluateHeldOutSuite(replayFirst.workCapability, heldOutCandidate ? (Array.isArray(heldOutCandidate) ? heldOutCandidate : [heldOutCandidate]) : []);
  const isolatedAgentValidation = selectedTargets.includes('agent')
    ? await validateAgentRuntimeInIsolation(path.join(TEMPLATE_ROOT, 'agent', 'runtime'))
    : {
        schemaVersion: 'isolated-agent-validation/v2',
        status: 'pass',
        reason: '当前交付目标不包含独立 Agent，G9 不适用。',
        checks: {},
        failedChecks: [],
      };
  const workCompilation = buildPackageWorkCapability({
    ...workCompilationInput,
    evaluationContext: {
      results: {
        G4: {
          status: deterministicReplay.status,
          reason: deterministicReplay.reason,
          evidence: ['deterministic-replay.json'],
        },
        G6: {
          status: originalTaskReplay.status,
          reason: originalTaskReplay.reason,
          evidence: ['original-task-replay.json'],
        },
        G7: {
          status: heldOutEvaluation.status,
          reason: heldOutEvaluation.reason,
          evidence: heldOutEvaluation.status === 'pending' ? [] : ['held-out-evaluation.json'],
        },
        G9: {
          status: isolatedAgentValidation.status,
          reason: isolatedAgentValidation.reason,
          evidence: ['isolated-agent-validation.json'],
        },
      },
    },
  });
  workCompilation.deterministicReplay = deterministicReplay;
  workCompilation.originalTaskReplay = originalTaskReplay;
  workCompilation.heldOutEvaluation = heldOutEvaluation;
  workCompilation.isolatedAgentValidation = isolatedAgentValidation;
  blueprint.workCapabilityRuntime = workCompilation.runtime;
  blueprint.releaseDecision = workCompilation.evaluation.releaseDecision;
  await writeAnalysisArtifacts(parsed, analysis, path.join(packageRoot, 'evidence'));
  await writeText(path.join(packageRoot, 'conversation-extraction.json'), JSON.stringify(extraction, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'source-sessions.json'), JSON.stringify(sourceSet.sessions || [], null, 2) + '\n');
  await writeText(path.join(packageRoot, 'project-discovery.json'), JSON.stringify(projectDiscovery, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'project-discovery.md'), projectDiscoveryMarkdown(projectDiscovery));
  await writeText(path.join(packageRoot, 'project-portfolio.json'), JSON.stringify(projectPortfolio, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'project-portfolio.md'), projectPortfolioMarkdown(projectPortfolio));
  await writeText(path.join(packageRoot, 'project-evidence.json'), JSON.stringify(projectEvidence || null, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'project-evidence.md'), projectEvidenceMarkdown(projectEvidence));
  await writeText(path.join(packageRoot, 'project-understanding.json'), JSON.stringify(understanding || null, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'project-understanding.md'), projectUnderstandingMarkdown(understanding));
  await writeText(path.join(packageRoot, 'distillation-recommendation.json'), JSON.stringify(recommendation, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'PRIORITY-PLAN.md'), distillationRecommendationMarkdown(recommendation));
  await writeText(path.join(packageRoot, 'distillation-recommendation.html'), distillationRecommendationHtml(recommendation));
  await writeText(path.join(packageRoot, 'recommendation.json'), JSON.stringify(recommendation, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'CAPABILITY.md'), capabilityMarkdown(identity, recommendation, packageDescription, blueprint, projectEvidence));
  await writeText(path.join(packageRoot, 'TASK-CATALOG.md'), taskCatalogMarkdown(recommendation));
  await writeText(path.join(packageRoot, 'evidence-manifest.json'), JSON.stringify(packageEvidenceManifest(recommendation, sourceSet, projectDiscovery, projectEvidence, projectKnowledgeV4, projectPortfolio), null, 2) + '\n');
  const projectKnowledgeFiles = await writeKnowledgeV4Artifacts(packageRoot, projectKnowledgeV4);
  await writeText(path.join(packageRoot, 'package-description.json'), JSON.stringify(packageDescription, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'conversation-distillation.json'), JSON.stringify(conversationDistillation, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'conversation-distillation.md'), conversationDistillationMarkdown(conversationDistillation));
  await writeText(path.join(packageRoot, 'capability-contract.json'), JSON.stringify(blueprint.capabilityContract, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'conversation-ui-blueprint.json'), JSON.stringify(ui, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'workflow-blueprint.json'), JSON.stringify(blueprint, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'work-capability-ir.v2.json'), JSON.stringify(workCompilation.workCapability, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'coverage-matrix.json'), JSON.stringify(workCompilation.workCapability.coverageMatrix, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'work-evidence-ledger.ndjson'), evidenceLedgerNdjson(workCompilation.workCapability));
  await writeText(path.join(packageRoot, 'execution-graph.json'), JSON.stringify(workCompilation.workCapability.executionGraph, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'release-decision.json'), JSON.stringify(workCompilation.evaluation, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'coverage-gaps.json'), JSON.stringify(workCompilation.coverageGaps, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'semantic-evaluation-plan.json'), JSON.stringify(workCompilation.semanticEvaluationPlan, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'deterministic-replay.json'), JSON.stringify(workCompilation.deterministicReplay, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'original-task-replay.json'), JSON.stringify(workCompilation.originalTaskReplay, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'held-out-evaluation.json'), JSON.stringify(workCompilation.heldOutEvaluation, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'isolated-agent-validation.json'), JSON.stringify(workCompilation.isolatedAgentValidation, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'compiled-targets.v2.json'), JSON.stringify(workCompilation.targets, null, 2) + '\n');
  await writeText(path.join(packageRoot, 'README.md'), packageGuide(blueprint, skillName));
  const delivery = {
    evidence: {
      analysis: path.join(packageRoot, 'evidence', 'analysis.json'),
      markdown: path.join(packageRoot, 'evidence', 'report.md'),
      html: path.join(packageRoot, 'evidence', 'report.html'),
      events: path.join(packageRoot, 'evidence', 'normalized-events.ndjson'),
    },
    skill: selectedTargets.includes('skill') ? await createSkill(packageRoot, blueprint, extraction, skillName, sourceSet, projectEvidence, understanding, projectKnowledgeV4, recommendation, projectPortfolio) : null,
    mcp: selectedTargets.includes('mcp') ? await createMcp(packageRoot, blueprint) : null,
    agent: selectedTargets.includes('agent') ? await createAgent(packageRoot, blueprint, extraction, sourceSet, projectEvidence, understanding, projectKnowledgeV4, recommendation, projectPortfolio, workCompilation) : null,
  };
  delivery.guide = path.join(packageRoot, 'README.md');
  delivery.distillation = {
    json: path.join(packageRoot, 'conversation-distillation.json'),
    markdown: path.join(packageRoot, 'conversation-distillation.md'),
  };
  delivery.recommendation = {
    json: path.join(packageRoot, 'distillation-recommendation.json'),
    markdown: path.join(packageRoot, 'PRIORITY-PLAN.md'),
    html: path.join(packageRoot, 'distillation-recommendation.html'),
  };
  delivery.capability = path.join(packageRoot, 'CAPABILITY.md');
  delivery.taskCatalog = path.join(packageRoot, 'TASK-CATALOG.md');
  delivery.evidenceManifest = path.join(packageRoot, 'evidence-manifest.json');
  delivery.workCapability = {
    ir: path.join(packageRoot, 'work-capability-ir.v2.json'),
    coverageMatrix: path.join(packageRoot, 'coverage-matrix.json'),
    evidenceLedger: path.join(packageRoot, 'work-evidence-ledger.ndjson'),
    executionGraph: path.join(packageRoot, 'execution-graph.json'),
    releaseDecision: path.join(packageRoot, 'release-decision.json'),
    coverageGaps: path.join(packageRoot, 'coverage-gaps.json'),
    semanticEvaluationPlan: path.join(packageRoot, 'semantic-evaluation-plan.json'),
    deterministicReplay: path.join(packageRoot, 'deterministic-replay.json'),
    originalTaskReplay: path.join(packageRoot, 'original-task-replay.json'),
    heldOutEvaluation: path.join(packageRoot, 'held-out-evaluation.json'),
    isolatedAgentValidation: path.join(packageRoot, 'isolated-agent-validation.json'),
    compiledTargets: path.join(packageRoot, 'compiled-targets.v2.json'),
  };
  delivery.sources = path.join(packageRoot, 'source-sessions.json');
  delivery.projectDiscovery = {
    json: path.join(packageRoot, 'project-discovery.json'),
    markdown: path.join(packageRoot, 'project-discovery.md'),
  };
  delivery.projectPortfolio = {
    json: path.join(packageRoot, 'project-portfolio.json'),
    markdown: path.join(packageRoot, 'project-portfolio.md'),
  };
  delivery.projectEvidence = {
    json: path.join(packageRoot, 'project-evidence.json'),
    markdown: path.join(packageRoot, 'project-evidence.md'),
  };
  delivery.projectUnderstanding = {
    json: path.join(packageRoot, 'project-understanding.json'),
    markdown: path.join(packageRoot, 'project-understanding.md'),
  };
  delivery.projectKnowledgeV4 = projectKnowledgeFiles;
  await writeText(path.join(packageRoot, 'verify.mjs'), verifyScript());
  const artifacts = await collectArtifacts(packageRoot);
  const manifest = {
    schemaVersion: '3.1.0',
    knowledgeSchemaVersion: projectKnowledgeV4.schemaVersion,
    workCapabilitySchemaVersion: workCompilation.workCapability.schemaVersion,
    generatedAt: new Date().toISOString(),
    package: blueprint.package,
    selection: blueprint.selection,
    runtime: blueprint.runtime,
    workCapabilityRuntime: workCompilation.runtime,
    releaseDecision: workCompilation.evaluation.releaseDecision,
    distillationRecommendation: recommendation,
    capabilityDocuments: {
      capability: 'CAPABILITY.md',
      priorityPlan: 'PRIORITY-PLAN.md',
      taskCatalog: 'TASK-CATALOG.md',
      recommendation: 'recommendation.json',
      evidenceManifest: 'evidence-manifest.json',
      workCapability: 'work-capability-ir.v2.json',
      coverageMatrix: 'coverage-matrix.json',
      evidenceLedger: 'work-evidence-ledger.ndjson',
      executionGraph: 'execution-graph.json',
      releaseDecision: 'release-decision.json',
      coverageGaps: 'coverage-gaps.json',
      semanticEvaluationPlan: 'semantic-evaluation-plan.json',
      deterministicReplay: 'deterministic-replay.json',
      originalTaskReplay: 'original-task-replay.json',
      heldOutEvaluation: 'held-out-evaluation.json',
      isolatedAgentValidation: 'isolated-agent-validation.json',
    },
    integrity: { algorithm: 'sha256', artifacts },
  };
  const manifestPath = path.join(packageRoot, 'package-manifest.json');
  await writeText(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const archive = await createPortableArchive(packageRoot, path.join(path.dirname(packageRoot), `${path.basename(packageRoot)}.zip`));
  const archiveVerification = await verifyPortableArchive(archive.path, selectedTargets);
  if (!archiveVerification.ok) throw new Error(`可分发 ZIP 校验失败：${archiveVerification.missing.join('、') || 'ZIP 结构无效'}`);
  delivery.archive = archive.path;
  return {
    package: {
      id: identity.id,
      name: identity.name,
      root: packageRoot,
      manifest: manifestPath,
      archive: archive.path,
      selection: blueprint.selection,
      naming: identity.naming,
      sourceSet,
      projectDiscovery,
      projectPortfolio,
      projectEvidenceSummary: projectEvidence?.summary || null,
      projectUnderstandingSummary: {
        purpose: understanding?.purpose || null,
        scope: understanding?.scope || null,
        evidenceGraph: understanding?.evidenceGraph?.statistics || null,
        conflicts: Number(understanding?.conflictRegister?.length || 0),
        activeReadPlan: Number(understanding?.activeReadPlan?.length || 0),
      },
      projectKnowledgeV4Summary: projectKnowledgeV4.summary,
      recommendation,
      description: packageDescription,
      releaseDecision: workCompilation.evaluation.releaseDecision,
      releaseValidation: {
        deterministicReplay,
        originalTaskReplay,
        heldOutEvaluation,
        isolatedAgentValidation,
      },
      delivery,
    },
    analysis,
    projectPortfolio,
    verification: {
      status: 'generated',
      artifactCount: Object.keys(artifacts).length,
      architecture: blueprint.package.architecture,
      archive: { ...archive, ...archiveVerification },
      checks: ['完整会话来源锚点已记录。', '统一能力契约已生成。', '任务持久化、检查点与恢复功能已封装。', '所有生成文件已写入 SHA-256 清单。', '可解压即用的 ZIP 已创建并校验。'],
    },
  };
}

export async function verifyConversationPackageV2(packageRoot) {
  const root = path.resolve(packageRoot);
  const manifest = JSON.parse(await fsp.readFile(path.join(root, 'package-manifest.json'), 'utf8'));
  const failures = [];
  for (const [relative, expected] of Object.entries(manifest.integrity?.artifacts || {})) {
    const filePath = path.resolve(root, ...relative.split('/'));
    const check = path.relative(root, filePath);
    if (check.startsWith('..') || path.isAbsolute(check)) {
      failures.push({ relative, reason: '路径超出能力包根目录' });
      continue;
    }
    try {
      const data = await fsp.readFile(filePath);
      const actual = crypto.createHash('sha256').update(data).digest('hex');
      if (actual !== expected.sha256 || data.length !== expected.bytes) failures.push({ relative, reason: '哈希或文件大小不匹配' });
    } catch {
      failures.push({ relative, reason: '文件缺失或读取失败' });
    }
  }
  if (!['3.0.0', '3.1.0'].includes(manifest.schemaVersion)) failures.push({ relative: 'schemaVersion', reason: '不是 v3 Codex 工程能力包' });
  if (!['whole-session', 'multi-session'].includes(manifest.selection?.mode)) failures.push({ relative: 'selection.mode', reason: '不是完整会话或多会话范围' });
  return { ok: failures.length === 0, manifest, failures, checkedArtifacts: Object.keys(manifest.integrity?.artifacts || {}).length };
}
