import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_ROOT,
  analyseParsedSession,
  parseCodexSessionFile,
  resolveSessionSource,
  writeAnalysisArtifacts,
} from './session-forensics.mjs';
import { packageConversationV2, verifyConversationPackageV2 } from './root-capability-packager.mjs';

export const CONVERSATION_PACKAGES_ROOT = path.join(WORKSPACE_ROOT, 'output', 'conversation-packages');
export const PACKAGE_TARGETS = ['skill', 'mcp', 'agent'];

const PACKAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value, fallback = '') {
  const output = String(value ?? fallback).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return output || fallback;
}

function yamlString(value) {
  return JSON.stringify(text(value));
}

function escapeMarkdown(value) {
  return text(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function normalisePackageId(value, sessionId) {
  const cleaned = text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const fallback = `conversation-${String(sessionId || 'workflow').slice(0, 8).toLowerCase()}`;
  const id = cleaned || fallback;
  if (!PACKAGE_ID_RE.test(id)) throw new Error('能力包标识仅包含小写字母、数字和短横线，长度上限为 63。');
  return id;
}

function normaliseTargets(targets) {
  const requested = Array.isArray(targets) && targets.length ? targets : PACKAGE_TARGETS;
  const result = [...new Set(requested.map((target) => text(target).toLowerCase()))];
  if (result.length === 0 || result.some((target) => !PACKAGE_TARGETS.includes(target))) {
    throw new Error('请选择至少一个有效交付物：技能、模型上下文协议服务或独立智能代理。');
  }
  return result;
}

function normaliseName(value, fallback) {
  return text(value, fallback).slice(0, 80);
}

function isGenericPackageId(value) {
  const candidate = text(value).toLowerCase();
  return !candidate || /^conversation(?:-ai-final)?(?:-[0-9a-f]{8})?(?:-workflow)?$/.test(candidate);
}

function isGenericPackageName(value) {
  const candidate = text(value);
  return !candidate
    || /^完整会话(?:派生)?能力包$/.test(candidate)
    || /^目标会话独立人工智能能力包$/.test(candidate)
    || /^会话\s*[0-9a-f]{4,16}\s*能力包$/i.test(candidate);
}

function compactSlug(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function derivePackageIdentity(analysis, sessionId) {
  const episodes = analysis.episodes || [];
  const sourceText = episodes
    .map((episode) => [episode.title, episode.requestContent, episode.assistantContent].join(' '))
    .join('\n');
  const implementationFiles = analysis.skillBlueprint?.implementationFiles || [];
  const observedTools = analysis.skillBlueprint?.observedTools || [];
  const evidenceText = `${sourceText}\n${implementationFiles.join('\n')}`;
  const subjects = [];
  if (/三国杀/i.test(evidenceText)) subjects.push('三国杀');
  if (/\bwuhu\b/i.test(evidenceText)) subjects.push('WUHU');
  if (/抖音|douyin/i.test(evidenceText)) subjects.push('抖音');

  const contentTopics = [];
  const contentSlugs = [];
  const hasComments = /all-comments|comments?|评论|commenter/i.test(evidenceText);
  const hasVideos = /videos-summary|video|视频/i.test(evidenceText);
  const hasPlayerContext = /玩家|player|语境|context|扎根|grounded/i.test(evidenceText);
  const hasMarketing = /\bmkt\b|营销|marketing|market/i.test(evidenceText);
  const hasAudience = /粉丝|受众|audience|follower/i.test(evidenceText);
  const hasReport = /报告|report|内容.*升级|升级优化|优化|generate.*report/i.test(evidenceText);
  if (hasComments && hasVideos) contentTopics.push('评论与视频数据洞察');
  else if (hasComments) contentTopics.push('评论数据洞察');
  else if (hasVideos) contentTopics.push('视频数据洞察');
  if (hasComments) contentSlugs.push('comment');
  if (hasVideos) contentSlugs.push('video');
  if (hasPlayerContext) {
    contentTopics.push('玩家语境与扎根分析');
    contentSlugs.push('player');
  }
  if (hasMarketing && hasAudience) contentTopics.push('营销与受众量化');
  else if (hasMarketing) contentTopics.push('营销洞察');
  else if (hasAudience) contentTopics.push('受众量化');
  if (hasMarketing) contentSlugs.push('mkt');
  if (hasAudience) contentSlugs.push('audience');
  if (hasReport) {
    contentTopics.push('报告生成与升级');
    contentSlugs.push('report');
  }
  if (!contentTopics.length) {
    const fallbackTopics = (analysis.reusableCapabilities || [])
      .map((item) => text(item.name))
      .filter(Boolean)
      .slice(0, 2);
    contentTopics.push(...(fallbackTopics.length ? fallbackTopics : ['会话工作流执行']));
  }

  const toolNames = [...new Set(observedTools.map((item) => text(item)).filter(Boolean))];
  const fileText = implementationFiles.join('\n');
  const toolTerms = [];
  const toolSlugs = [];
  if (toolNames.some((name) => /exec|shell_command|write_stdin/i.test(name))) {
    toolTerms.push('命令执行');
    toolSlugs.push('exec');
  }
  if (toolNames.some((name) => /apply_patch|filechange|edit/i.test(name)) || /patch|修改|edit/i.test(fileText)) {
    toolTerms.push('代码修改');
    toolSlugs.push('patch');
  }
  if (toolNames.some((name) => /test|verify|view_image|update_plan/i.test(name)) || /test|verify|验收|校验/i.test(fileText)) {
    toolTerms.push('结果验证');
    toolSlugs.push('verify');
  }
  if (toolNames.some((name) => /spawn_agent|list_agents|wait_agent|followup_task/i.test(name))) {
    toolTerms.push('多代理编排');
    toolSlugs.push('agents');
  }
  if (toolNames.some((name) => /web__run|browser/i.test(name))) {
    toolTerms.push('网页检索');
    toolSlugs.push('web');
  }
  if (!toolTerms.length) toolTerms.push('会话工具调用');

  const subjectLabel = subjects.slice(0, 3).join(' ');
  const topicLabel = contentTopics.slice(0, 4).join('、');
  const toolLabel = toolTerms.length > 3
    ? `${toolTerms.slice(0, 3).join('、')}等工具`
    : `${toolTerms.join('、')}工具`;
  const name = `${subjectLabel ? `${subjectLabel} ` : ''}${topicLabel}（${toolLabel}）能力包`;
  const prioritisedContentSlugs = ['comment', 'video', 'mkt', 'report', 'player', 'audience']
    .filter((slug) => contentSlugs.includes(slug))
    .slice(0, 4);
  const idParts = [
    ...subjects.slice(0, 2).map((item) => ({ 三国杀: 'sanguosha', WUHU: 'wuhu', 抖音: 'douyin' }[item] || compactSlug(item))),
    ...prioritisedContentSlugs,
    ...toolSlugs.slice(0, 1),
  ].filter(Boolean);
  const id = normalisePackageId(idParts.join('-'), sessionId);
  const implementationSignals = implementationFiles
    .filter((item) => /wuhu|comment|video|mkt|audience|report|verify|generate|analy|skill|mcp/i.test(item))
    .slice(0, 10);
  return {
    id,
    name: normaliseName(name, `会话 ${String(sessionId || '').slice(0, 8)} 能力包`),
    naming: {
      mode: '会话内容与实际工具自动命名',
      subjects,
      contentTopics,
      toolTerms,
      observedTools: toolNames,
      implementationSignals,
      evidence: {
        episodeCount: episodes.length,
        implementationFileCount: implementationFiles.length,
        observedToolCount: toolNames.length,
      },
    },
  };
}

async function ensurePackageDirectory(outputRoot, key) {
  const root = path.resolve(outputRoot);
  await fs.mkdir(root, { recursive: true });
  const rootReal = await fs.realpath(root);
  const outputDir = path.resolve(root, key);
  const relative = path.relative(root, outputDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error('能力包输出目录必须是 conversation-packages 下的直接子目录。');
  }
  await fs.mkdir(outputDir, { recursive: true });
  const outputReal = await fs.realpath(outputDir);
  if (path.dirname(outputReal) !== rootReal) throw new Error('能力包输出目录解析后超出了允许范围。');
  return outputReal;
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

function selectWorkflowTriggers(rules) {
  const direct = rules.filter((rule) => rule.confidence === 'direct');
  const inferred = rules.filter((rule) => rule.confidence !== 'direct');
  const selected = [...direct];
  const seen = new Set(direct.map((rule) => `${rule.trigger}\u0000${rule.action}`));
  for (const rule of inferred) {
    const retryTool = rule.trigger.match(/观察到工具\s+([^\s]+)\s+的非成功结果/);
    const key = retryTool ? `retry:${retryTool[1]}` : `${rule.trigger}\u0000${rule.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(rule);
    if (selected.length >= direct.length + 32) break;
  }
  return {
    rules: selected.map((rule) => ({
      evidenceLevel: rule.confidence,
      trigger: rule.trigger,
      condition: rule.condition,
      action: rule.action,
      evidence: rule.evidence,
    })),
    coverage: {
      total: rules.length,
      included: selected.length,
      omitted: Math.max(0, rules.length - selected.length),
      strategy: '保留全部直接触发，并对时序推断与重复重试规则去重；完整规则见 evidence/analysis.json。',
    },
  };
}

function buildCapabilityGuide(analysis, workflow, targets) {
  const reusableSpecialities = (analysis.reusableCapabilities || []).map((capability) => ({
    name: text(capability.name, '会话派生能力'),
    description: text(capability.trigger, '按来源会话中验证过的流程处理相近任务。'),
    steps: (capability.workflow || []).map((step) => text(step)).filter(Boolean),
    confidence: capability.confidence || 'unrated',
  }));
  const seenTasks = new Set();
  const suitableTasks = [];
  for (const stage of analysis.episodes || []) {
    const title = text(stage.title, `第 ${stage.index} 个需求阶段`);
    const key = title.replace(/^第\s*\d+\s*个需求阶段[：:]?\s*/, '');
    if (!key || seenTasks.has(key)) continue;
    seenTasks.add(key);
    suitableTasks.push({
      title: key,
      prompt: text(stage.requestContent, title).slice(0, 600),
      sourceStage: stage.index,
    });
    if (suitableTasks.length >= 8) break;
  }
  const sourceText = (analysis.episodes || [])
    .map((stage) => `${text(stage.title)} ${text(stage.requestContent)}`)
    .join('\n');
  const focusLabels = [];
  const sessionSpecialities = [];
  const requiredInputs = [];
  const outputs = [];
  const verification = [];

  if (/all-comments|videos-summary|评论|视频|数据|洞察/i.test(sourceText)) {
    focusLabels.push('评论与视频数据洞察');
    requiredInputs.push('评论明细、视频摘要或其他待分析数据');
    outputs.push('全量数据洞察、主题分布与关键问题清单');
    verification.push('所有统计口径、主题判断和关键结论都能回到具体数据字段或代表性原文。');
    sessionSpecialities.push({
      name: '评论与视频数据全量洞察',
      description: '汇总评论和视频数据，识别高频主题、情绪、争议点、内容表现与可追溯证据。',
      steps: ['检查数据字段', '统计与分层', '提取主题和证据', '形成完整洞察'],
      confidence: 'direct',
    });
  }
  if (/玩家|语境|扎根/i.test(sourceText)) {
    focusLabels.push('玩家语境与扎根分析');
    requiredInputs.push('需要重点理解的玩家群体、内容语境或研究问题');
    outputs.push('结合玩家语境的扎根编码、内容解读与代表性证据');
    verification.push('扎根编码、玩家语境解释和引用示例相互对应，并区分直接证据与分析推断。');
    sessionSpecialities.push({
      name: '玩家语境与扎根分析',
      description: '结合玩家黑话、社区语境和内容上下文做开放编码、主题归纳与解释。',
      steps: ['识别玩家表达', '开放编码', '归并主题', '结合语境解释'],
      confidence: 'direct',
    });
  }
  if (/\bMKT\b|营销|粉丝|受众/i.test(sourceText)) {
    focusLabels.push('营销与受众量化');
    requiredInputs.push('品牌、粉丝、受众或营销目标，以及希望回答的业务问题');
    outputs.push('粉丝与受众量化、营销机会、风险判断和行动建议');
    verification.push('受众量化写清样本范围、计算口径和限制，营销建议逐项对应数据证据。');
    sessionSpecialities.push({
      name: '营销、粉丝与受众量化',
      description: '把内容信号转成受众结构、需求动机、传播机会、风险和营销动作。',
      steps: ['定义营销问题', '量化受众信号', '识别机会与风险', '给出可执行建议'],
      confidence: 'direct',
    });
  }
  if (/报告|论证|内容.*升级|升级优化/i.test(sourceText)) {
    focusLabels.push('洞察报告生成与升级');
    requiredInputs.push('已有报告或参考模板（需要模仿、补强或升级时）');
    outputs.push('结构完整、可复制或下载的洞察报告');
    verification.push('报告覆盖目标、方法、发现、证据、营销含义、行动建议和限制，并完成前后一致性检查。');
    sessionSpecialities.push({
      name: '洞察报告生成与升级',
      description: '把分析结果组织成结构化报告，并按内容深度、量化证据和营销价值逐项补强。',
      steps: ['对照参考报告', '组织证据与结论', '补强量化和营销分析', '检查完整性'],
      confidence: 'direct',
    });
  }

  if (!requiredInputs.length) {
    requiredInputs.push(...(workflow.inputs.length ? workflow.inputs : ['当前任务目标', '完成任务所需的资料或上下文']));
  }
  requiredInputs.push('期望的交付形式、分析范围和重点');
  if (!outputs.length) outputs.push(...workflow.expectedOutputs);
  if (!verification.length) verification.push(...workflow.verification);
  const specialities = [...sessionSpecialities, ...reusableSpecialities]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.name === item.name) === index)
    .slice(0, 6);
  const focusTitle = focusLabels.length ? focusLabels.join('、') : workflow.name;
  const focusSummary = focusLabels.length
    ? `它会围绕你提供的业务资料，完成${focusLabels.join('、')}，并把原会话中验证过的分析步骤和验收要求自动带入每次对话。`
    : `它会把“${workflow.name}”所需的输入、执行步骤和验收要求自动带入人工智能对话，帮助你分析问题、生成可交付内容并检查已有内容。`;
  return {
    title: `这个能力包专门用于：${focusTitle}`,
    plainSummary: focusSummary,
    independentUiCapabilities: [
      { name: '执行本地任务', description: '根据任务自动浏览工作区、读取文件；获得权限后可创建和修改文件、执行本地命令，并持续处理到完成或达到步骤上限。' },
      { name: '分析问题', description: '根据当前工作流说明要准备哪些资料、先做什么、如何判断结果是否可靠。' },
      { name: '生成结果', description: '根据你在对话中提供的资料生成完整文本结果，并支持复制或下载为 Markdown 文件。' },
      { name: '检查内容', description: '把已有内容逐项对照本能力包的验收要求，指出缺口并给出具体修改建议。' },
      { name: '提取并改进原对话', description: '回查原会话中的用户目标、后续纠正、助手回应、工具结果和文件变更，先说明旧方案缺口，再按最新要求执行。' },
      { name: '连续自主执行', description: '模型会根据每个工具结果决定下一步；界面实时显示工具名称、参数、状态、耗时和结果，并支持停止执行。' },
    ],
    specialities,
    suitableTasks,
    requiredInputs: [...new Set(requiredInputs)],
    outputs: [...new Set(outputs)],
    verification: [...new Set(verification)],
    deliveryForms: [
      ...(targets.includes('skill') ? [{ name: '技能', description: '在 Codex 中复用工作流，并由 Codex 按需调用本地工具、读取文件和生成实际产物。' }] : []),
      ...(targets.includes('mcp') ? [{ name: '模型上下文协议服务', description: '向兼容客户端提供工作流、原对话提炼、按关键词检索、证据摘要、执行计划和白名单产物读取工具。' }] : []),
      ...(targets.includes('agent') ? [{ name: '独立本地执行型人工智能', description: '连接 OpenAI 兼容模型后，在浏览器中选择工作区和权限，直接浏览、读取、修改本地文件并运行命令，全程展示工具执行轨迹。' }] : []),
    ],
    limits: [
      '能力包不包含模型或模型权重；独立界面必须先连接一个可用的 OpenAI 兼容模型服务。',
      '文件工具只允许访问你在界面中选择的工作区；写入权限默认关闭，需要你主动开启。',
      '命令执行权限默认关闭，需要你主动开启；命令使用当前系统账户权限，命令本身可能调用工作区外的系统程序或绝对路径。',
      '本地命令不会继承名称包含 key、token、secret、password 等敏感字样的环境变量；命令输出和文件读取内容有长度上限。',
      '模型上下文协议服务负责提供工作流、证据和执行计划，本身不代替人工智能模型执行任务。',
      '最终结果仍取决于你提供的资料完整度和所连接模型的能力；重要结论应按页面列出的验收要求复核。',
    ],
  };
}

function conversationText(value, maximum = 12000) {
  const raw = String(value ?? '').replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
  if (raw.length <= maximum) return raw;
  return `${raw.slice(0, maximum)}\n……原文过长，已截取前 ${maximum} 个字符。`;
}

function uniqueStrings(values, maximum = 80) {
  return [...new Set((values || []).map((value) => text(value)).filter(Boolean))].slice(0, maximum);
}

function classifyRequirementChange(request, index) {
  const value = text(request);
  if (index === 1) return { type: 'initial', label: '初始目标', summary: '建立本次会话的初始目标和交付方向。' };
  if (/不够|太弱|太差|不行|不足|缺少|没有.*(展示|说明|功能)|必须|还要|需要.*(改进|优化|补强|升级|完整|直白)|改成|修正|重做|重新|继续完善|提升/i.test(value)) {
    return { type: 'correction', label: '用户纠正或补强', summary: '本阶段明确修正前序结果的缺口，后续执行必须优先满足这条新要求。' };
  }
  if (/继续|接着|然后|另外|再加|同时|并且|还需要/i.test(value)) {
    return { type: 'expansion', label: '目标扩展', summary: '在前序目标上增加新的范围、交付物或操作要求。' };
  }
  return { type: 'refinement', label: '目标细化', summary: '把前序目标细化成更明确的执行约束或交付形式。' };
}

function artifactRole(filePath, action = '') {
  const value = `${filePath} ${action}`.toLowerCase();
  if (/test|verify|check|lint|验收|校验/.test(value)) return '验证';
  if (/skill|mcp|agent|workflow|package|能力包|技能/.test(value)) return '能力封装';
  if (/report|analysis|summary|分析|报告|洞察/.test(value)) return '分析与报告';
  if (/ui|html|css|app|component|页面|界面/.test(value)) return '界面';
  if (/config|json|yaml|toml|env/.test(value)) return '配置';
  return '实现文件';
}

function buildConversationIntelligence(analysis, parsed) {
  const episodes = analysis.episodes || [];
  const starts = episodes.map((episode, index) => ({ episode, start: Number(episode.triggerEventIndex) || 1, end: Number(episodes[index + 1]?.triggerEventIndex || Number.MAX_SAFE_INTEGER) - 1 }));
  const stageRecords = starts.map(({ episode, start, end }) => {
    const change = classifyRequirementChange(episode.requestContent || episode.request, episode.index);
    const inRange = (eventIndex) => Number(eventIndex) >= start && Number(eventIndex) <= end;
    const messages = (parsed.messages || [])
      .filter((message) => inRange(message.eventIndex))
      .map((message) => ({
        eventIndex: message.eventIndex,
        timestamp: message.timestamp || null,
        actor: message.actor,
        channel: message.channel || null,
        contextKind: message.contextKind || null,
        text: conversationText(message.text, 16000),
      }));
    const toolCalls = (parsed.toolCalls || [])
      .filter((tool) => inRange(tool.eventIndex))
      .map((tool) => ({
        eventIndex: tool.eventIndex,
        timestamp: tool.timestamp || null,
        name: tool.name,
        callId: tool.callId || null,
        arguments: conversationText(tool.argumentsExcerpt, 6000),
        argumentKeys: tool.argumentSchema || [],
        nestedTools: tool.nestedTools || [],
        result: tool.output ? {
          eventIndex: tool.output.eventIndex,
          success: tool.output.success,
          excerpt: conversationText(tool.output.excerpt, 6000),
        } : null,
        durationMs: tool.durationMs ?? null,
      }));
    const commands = (analysis.codeArtifacts?.commands || [])
      .filter((command) => inRange(command.eventIndex))
      .map((command) => ({ eventIndex: command.eventIndex, tool: command.tool, category: command.category, command: conversationText(command.command, 4000) }));
    const fileChanges = (analysis.codeArtifacts?.fileChanges || [])
      .filter((change) => inRange(change.eventIndex))
      .map((change) => ({ ...change, role: artifactRole(change.path, change.action) }));
    const userMessages = messages.filter((message) => message.actor === 'user');
    const assistantMessages = messages.filter((message) => message.actor === 'assistant');
    const failedTools = toolCalls.filter((tool) => tool.result && !tool.result.success).map((tool) => tool.name);
    return {
      index: episode.index,
      title: episode.title,
      timestamp: episode.timestamp || null,
      eventRange: [start, Number.isFinite(end) ? end : null],
      changeType: change.type,
      changeLabel: change.label,
      changeSummary: change.summary,
      request: conversationText(episode.requestContent || episode.request, 16000),
      userMessages,
      assistantMessages,
      toolNames: uniqueStrings(toolCalls.map((tool) => tool.name), 120),
      toolCalls,
      commands,
      fileChanges,
      outcome: {
        toolCount: toolCalls.length,
        completed: toolCalls.filter((tool) => tool.result).length,
        succeeded: toolCalls.filter((tool) => tool.result?.success).length,
        failed: failedTools.length,
        failedTools: uniqueStrings(failedTools, 40),
      },
    };
  });
  const corrections = stageRecords
    .filter((stage) => stage.changeType === 'correction')
    .map((stage) => ({ stage: stage.index, title: stage.title, request: stage.request, requiredChange: stage.changeSummary }));
  const requirementEvolution = stageRecords.map((stage) => ({
    stage: stage.index,
    title: stage.title,
    type: stage.changeType,
    label: stage.changeLabel,
    summary: stage.changeSummary,
    request: stage.request,
  }));
  const strengths = uniqueStrings([
    ...(analysis.reusableCapabilities || []).map((item) => `${item.name}：${item.trigger}`),
    ...stageRecords.filter((stage) => stage.outcome.toolCount > 0 && stage.outcome.failed === 0).slice(0, 8).map((stage) => `第 ${stage.index} 阶段已完成工具链：${stage.toolNames.join('、')}`),
  ], 16);
  const weaknesses = uniqueStrings([
    ...corrections.map((item) => `第 ${item.stage} 阶段指出前序不足：${item.request}`),
    ...analysis.toolCatalog.filter((tool) => tool.failed > 0).slice(0, 12).map((tool) => `工具 ${tool.name} 曾出现 ${tool.failed} 次非成功结果，后续需要检查结果并调整方案。`),
  ], 24);
  const improvedWorkflow = [
    { order: 1, name: '读取原对话目标和最新纠正', description: '先查看需求演进，识别哪些后续要求覆盖了前序做法。', sourceStages: stageRecords.slice(0, 3).map((stage) => stage.index), requiredTools: ['get_original_conversation_stage'] },
    { order: 2, name: '回查阶段证据和实际工具链', description: '按当前目标检索原用户话语、助手回应、工具参数、结果、命令和文件变更，不凭短摘要猜测。', sourceStages: stageRecords.slice(0, 8).map((stage) => stage.index), requiredTools: ['search_original_conversation', 'get_original_conversation_stage'] },
    { order: 3, name: '保留有效做法并修正已暴露缺口', description: '复用已有成功工具链；对用户明确指出的弱点逐项增加内容、功能、展示或验证。', sourceStages: corrections.map((item) => item.stage), requiredTools: ['get_improved_workflow'] },
    { order: 4, name: '围绕当前目标执行真实操作', description: '先检查工作区，再按需要读取、修改文件、运行命令或生成结果；每一步都以工具返回为准。', sourceStages: stageRecords.filter((stage) => stage.toolNames.length).map((stage) => stage.index), requiredTools: ['list_files', 'read_file', 'write_file', 'replace_text', 'execute_command'] },
    { order: 5, name: '按最新验收标准复核', description: '逐项对照需求演进、纠正意见和来源证据，确认结果不是只完成旧版本目标。', sourceStages: stageRecords.map((stage) => stage.index), requiredTools: ['execute_command', 'read_file'] },
    { order: 6, name: '交付完整结果和证据索引', description: '直白说明实际完成、未完成、修改文件、命令结果和仍需人工判断的部分。', sourceStages: stageRecords.map((stage) => stage.index), requiredTools: [] },
  ];
  const acceptanceCriteria = uniqueStrings([
    ...(analysis.skillBlueprint?.guardrails || []),
    ...corrections.map((item) => `必须满足第 ${item.stage} 阶段的最新要求：${item.request}`),
    '不能只复述旧会话摘要；需要能够回查原对话证据并说明改进依据。',
    '所有文件修改、命令执行和验证结果必须有实际工具轨迹或明确标注未执行。',
  ], 30);
  const recoveryRules = uniqueStrings([
    ...(analysis.triggerLogic || []).filter((rule) => /重试|非成功|失败|错误|调整|检查结果/.test(`${rule.trigger}${rule.action}${rule.condition}`)).map((rule) => `${rule.trigger}：${rule.action}`),
    '工具失败时保留错误证据，调整参数或方案后再继续，不把失败描述为成功。',
    '如果当前目标与旧阶段冲突，以更晚的用户纠正为准，并在最终结果中说明覆盖关系。',
  ], 24);
  const artifactIndex = uniqueStrings((analysis.codeArtifacts?.fileChanges || []).map((change) => `${change.path}（${artifactRole(change.path, change.action)}）`), 120);
  const extraction = {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    purpose: '保留原对话中可见的目标、回应、工具、命令、文件变更与用户纠正，供能力包回查和改进执行使用。',
    source: analysis.source,
    coverage: analysis.coverage,
    requirementEvolution,
    corrections,
    stages: stageRecords,
    artifactIndex,
    observedTools: analysis.skillBlueprint?.observedTools || [],
    improvedWorkflow,
    acceptanceCriteria,
    recoveryRules,
    strengths,
    weaknesses,
  };
  const distillation = {
    purpose: '从原对话提取证据，并将后续用户纠正转化为优先级更高的改进执行规则。',
    requirementEvolution: requirementEvolution.slice(0, 24),
    corrections: corrections.slice(0, 16),
    retainedStrengths: strengths,
    weaknesses,
    improvedWorkflow,
    acceptanceCriteria,
    recoveryRules,
    evidence: {
      stageCount: stageRecords.length,
      correctionCount: corrections.length,
      messageCount: stageRecords.reduce((sum, stage) => sum + stage.userMessages.length + stage.assistantMessages.length, 0),
      toolCallCount: stageRecords.reduce((sum, stage) => sum + stage.toolCalls.length, 0),
      artifactCount: artifactIndex.length,
      sourceFile: 'conversation-extraction.json',
    },
  };
  extraction.distillation = distillation;
  return { extraction, distillation };
}

function makeWorkflowBlueprint(analysis, conversation, { packageId, packageName, skillName, targets, redacted, naming }) {
  const steps = analysis.skillBlueprint.workflow.length
    ? analysis.skillBlueprint.workflow
    : ['收集上下文', '执行会话派生工作流', '验证产物'];
  const expectedOutputs = [
    '可审计的执行计划',
    '输入、步骤和验证要求清单',
    ...(targets.includes('skill') ? ['可安装的技能'] : []),
    ...(targets.includes('mcp') ? ['可独立注册的模型上下文协议服务'] : []),
    ...(targets.includes('agent') ? ['可独立启动的智能代理界面'] : []),
  ];
  const triggers = selectWorkflowTriggers(analysis.triggerLogic);
  const workflow = {
    id: analysis.skillBlueprint.candidateId || skillName,
    name: analysis.skillBlueprint.candidateName || packageName,
    description: analysis.skillBlueprint.description || '根据完整会话的可见证据提炼出的可复用工作流。',
    inputs: analysis.skillBlueprint.requiredInputs || [],
    steps,
    verification: analysis.skillBlueprint.guardrails || [],
    expectedOutputs,
    triggers: triggers.rules,
    triggerCoverage: triggers.coverage,
  };
  const capabilityGuide = buildCapabilityGuide(analysis, workflow, targets);
  const distillation = {
    ...conversation.distillation,
    acceptanceCriteria: uniqueStrings([...(conversation.distillation.acceptanceCriteria || []), ...(capabilityGuide.verification || [])], 40),
  };
  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    package: {
      id: packageId,
      name: packageName,
      type: 'conversation-capability-package',
      targets,
      naming,
    },
    selection: {
      mode: 'whole-session',
      label: '完整会话（所有原始记录、可见消息、工具调用、工具结果与文件变更）',
      sessionId: analysis.source.sessionId,
      sourcePath: analysis.source.path,
      sourceSha256: analysis.source.sha256,
      sourceBytes: analysis.source.bytes,
      sourceFormat: analysis.source.format,
      recordCount: analysis.source.recordCount,
      normalisedEventCount: analysis.coverage.normalisedEventCount,
      selectedRecordRange: [1, analysis.source.recordCount],
      redacted,
    },
    workflow,
    capabilityGuide,
    distillation,
    evidence: {
      summary: analysis.summary,
      userRequestStages: analysis.episodes.map((episode) => ({
        index: episode.index,
        title: episode.title,
        requestContent: episode.requestContent,
        assistantContent: episode.assistantContent,
        intentLabels: episode.intentLabels,
        stageLabels: episode.stageLabels,
        toolCount: episode.toolCount,
        toolNames: episode.toolNames,
        outcomeSummary: episode.outcomeSummary,
        triggerEventIndex: episode.triggerEventIndex,
      })),
      observedTools: analysis.skillBlueprint.observedTools || [],
      implementationFiles: analysis.skillBlueprint.implementationFiles || [],
      reusableCapabilities: analysis.reusableCapabilities || [],
      evidenceFiles: ['evidence/analysis.json', 'evidence/report.md', 'evidence/report.html', 'evidence/normalized-events.ndjson', 'conversation-extraction.json'],
    },
    delivery: {
      guideFile: 'README.md',
      skill: targets.includes('skill') ? {
        directory: `skill/${skillName}`,
        skillFile: `skill/${skillName}/SKILL.md`,
        interfaceFile: `skill/${skillName}/agents/openai.yaml`,
        installDirectory: path.join(process.env.CODEX_HOME || 'E:\\CodexHome', 'skills', skillName),
      } : null,
      mcp: targets.includes('mcp') ? {
        directory: 'mcp',
        serverFile: `mcp/${packageId}-server.mjs`,
        configFile: 'mcp/mcp.config.example.json',
      } : null,
      agent: targets.includes('agent') ? {
        directory: 'agent',
        serverFile: 'agent/agent-server.mjs',
        aiProfileFile: 'agent/ai-profile.json',
        readmeFile: 'agent/README.md',
        envExampleFile: 'agent/.env.example',
        workflowFile: 'agent/workflow-blueprint.json',
        conversationExtractionFile: 'agent/conversation-extraction.json',
        uiFiles: {
          index: 'agent/ui/index.html',
          app: 'agent/ui/app.js',
          styles: 'agent/ui/styles.css',
        },
        startCommand: 'node agent-server.mjs',
      } : null,
    },
  };
}

function buildSkillMarkdown(blueprint, skillName) {
  const workflow = blueprint.workflow.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const inputs = blueprint.workflow.inputs.map((input) => `- ${input}`).join('\n') || '- 用户目标与可用上下文';
  const verification = blueprint.workflow.verification.map((item) => `- ${item}`).join('\n') || '- 对照会话证据验证输出。';
  return `---
name: ${skillName}
description: ${yamlString(`从完整会话“${blueprint.package.name}”提炼可复用工作流；当用户提出相近目标、需要相同输入输出契约或希望复用该会话的执行步骤时使用。`)}
---

# ${blueprint.package.name}

## 使用条件

- 用户目标与本技能的触发逻辑相符。
- 需要复用完整会话中已验证的工作流、输入契约或交付形式。
- 先读取 \`references/conversation-extraction.json\`，再读取 \`references/conversation-contract.md\`；按其中与当前目标相关的阶段检索原话、工具和文件证据，优先执行后续用户纠正；需要预览确定性步骤时运行 \`scripts/prepare-workflow.mjs\`。

## 必需输入

${inputs}

## 执行流程

${workflow}

## 原对话改进规则

- 先看 \`references/conversation-extraction.json\` 的 \`requirementEvolution\`、\`corrections\` 和 \`improvedWorkflow\`，不要只看短摘要。
- 后续用户纠正覆盖早期弱要求；保留 \`strengths\` 中已经被工具结果验证的做法。
- 需要事实依据时回查对应阶段的用户消息、助手消息、工具参数、工具结果、命令和文件变更。
- 工具失败必须保留失败证据并调整方案；没有实际工具轨迹时，不把修改、命令或验证写成已完成。

## 产出要求

- 默认完成实际工具调用、代码或文件修改、报告生成与结果验证，不把执行计划当作最终交付物。
- 交付与用户目标对应的真实内容、代码、文件或报告，并附上实际完成的验证结果；仅在用户明确只要计划时停在计划层。
- 将 \`scripts/prepare-workflow.mjs\` 的输出作为执行检查表，而不是完成证明。
- 将直接证据与时序推断分开陈述，不把不可见推理视为事实。
- 遇到缺失输入时先从工作区和会话证据中查找；仅在信息不足且会改变结果时向用户询问。

## 验收要求

${verification}

## 会话证据

- 选择范围：${blueprint.selection.label}
- 来源会话：\`${blueprint.selection.sessionId || '源文件未内嵌会话编号'}\`
- 来源 SHA-256：\`${blueprint.selection.sourceSha256}\`
- 完整证据索引见 \`references/conversation-contract.md\`；原对话提取见 \`references/conversation-extraction.json\`；结构化分析、工作流蓝图和脱敏后的全量事件流均已封装在 \`references/\` 中。
`;
}

function buildSkillContract(blueprint) {
  const stageRows = blueprint.evidence.userRequestStages.length
    ? blueprint.evidence.userRequestStages.map((stage) => `| ${stage.index} | ${escapeMarkdown(stage.title)} | ${escapeMarkdown((stage.intentLabels || []).join('、') || '未标注')} | ${escapeMarkdown((stage.stageLabels || []).join(' → ') || '未记录')} | ${stage.toolCount} |`).join('\n')
    : '| 暂无 | 暂无 | 暂无 | 暂无 | 0 |';
  const triggers = blueprint.workflow.triggers.length
    ? blueprint.workflow.triggers.map((rule) => `- **${rule.evidenceLevel === 'direct' ? '直接证据' : '时序推断'}**：${rule.trigger}。成立条件：${rule.condition}。动作：${rule.action}。`).join('\n')
    : '- 暂无可提取的触发规则。';
  return `# 完整会话工作流合同

## 选择锚点

- 选择模式：完整会话
- 会话编号：\`${blueprint.selection.sessionId || '源文件未内嵌会话编号'}\`
- 来源文件：\`${blueprint.selection.sourcePath}\`
- 来源 SHA-256：\`${blueprint.selection.sourceSha256}\`
- 已选原始记录范围：第 ${blueprint.selection.selectedRecordRange[0]} 至 ${blueprint.selection.selectedRecordRange[1]} 条
- 标准化事件数量：${blueprint.selection.normalisedEventCount}
- 脱敏：${blueprint.selection.redacted ? '已启用' : '未启用'}

## 请求阶段

| 阶段 | 标题 | 意图 | 观察到的执行阶段 | 工具调用 |
| --- | --- | --- | --- | --- |
${stageRows}

## 触发逻辑

${triggers}

## 输入与输出

### 必需输入

${blueprint.workflow.inputs.map((item) => `- ${item}`).join('\n') || '- 用户目标与可用上下文'}

### 预期产物

${blueprint.workflow.expectedOutputs.map((item) => `- ${item}`).join('\n')}

## 验证项

${blueprint.workflow.verification.map((item) => `- ${item}`).join('\n') || '- 对照来源证据完成复核。'}

## 需求演进与改进

${(blueprint.distillation?.requirementEvolution || []).map((item) => `- 第 ${item.stage} 阶段（${item.label}）：${escapeMarkdown(item.summary)} 原始要求：${escapeMarkdown(item.request)}`).join('\n') || '- 暂无可分辨的需求演进。'}

### 用户明确纠正

${(blueprint.distillation?.corrections || []).map((item) => `- 第 ${item.stage} 阶段：${escapeMarkdown(item.request)}；执行要求：${escapeMarkdown(item.requiredChange)}`).join('\n') || '- 暂无明确纠正；仍需以当前用户目标为准。'}

### 保留有效做法

${(blueprint.distillation?.retainedStrengths || []).map((item) => `- ${escapeMarkdown(item)}`).join('\n') || '- 以工具返回结果验证每个步骤。'}

### 已识别不足

${(blueprint.distillation?.weaknesses || []).map((item) => `- ${escapeMarkdown(item)}`).join('\n') || '- 暂未发现可从记录直接确认的不足。'}

### 改进后执行流程

${(blueprint.distillation?.improvedWorkflow || []).map((item) => `${item.order}. **${escapeMarkdown(item.name)}**：${escapeMarkdown(item.description)}${item.requiredTools?.length ? `（需要：${item.requiredTools.map((tool) => `\`${tool}\``).join('、')}）` : ''}`).join('\n')}

### 改进验收标准

${(blueprint.distillation?.acceptanceCriteria || []).map((item) => `- ${escapeMarkdown(item)}`).join('\n') || '- 必须能回查原对话证据，并对实际执行结果完成复核。'}

## 技术证据索引

- 观测到的工具：${blueprint.evidence.observedTools.map((item) => `\`${item}\``).join('、') || '暂无'}
- 相关实现文件：${blueprint.evidence.implementationFiles.map((item) => `\`${item}\``).join('、') || '暂无'}
- 工作流蓝图：\`workflow-blueprint.json\`
- 原对话提取：\`conversation-extraction.json\`
- 完整脱敏事件流：\`normalized-events.ndjson\`
- 结构化分析：\`analysis.json\`
`;
}

function buildPackageGuide(blueprint, skillName) {
  const capabilityRows = blueprint.capabilityGuide.specialities.length
    ? blueprint.capabilityGuide.specialities.map((item) => `| ${escapeMarkdown(item.name)} | ${escapeMarkdown(item.description)} | ${escapeMarkdown(item.steps.join(' → ') || '按当前工作流执行')} |`).join('\n')
    : '| 会话派生工作流 | 按来源会话中验证过的流程处理相近任务 | 读取输入 → 执行 → 验证 |';
  const uiCapabilityRows = blueprint.capabilityGuide.independentUiCapabilities
    .map((item) => `| ${escapeMarkdown(item.name)} | ${escapeMarkdown(item.description)} |`).join('\n');
  const deliveryRows = blueprint.capabilityGuide.deliveryForms
    .map((item) => `| ${escapeMarkdown(item.name)} | ${escapeMarkdown(item.description)} |`).join('\n');
  const taskRows = blueprint.capabilityGuide.suitableTasks.length
    ? blueprint.capabilityGuide.suitableTasks.map((item) => `| ${item.sourceStage} | ${escapeMarkdown(item.title)} | ${escapeMarkdown(item.prompt.slice(0, 180))} |`).join('\n')
    : '| - | 使用当前工作流处理相近任务 | 在独立界面中说明目标并提供资料 |';
  const stages = blueprint.capabilityGuide.specialities.slice(0, 4)
    .map((item, index) => `${index + 1}. ${item.name}：${item.steps.join(' → ') || '按页面提示执行'}`)
    .join('\n') || blueprint.workflow.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const inputs = blueprint.capabilityGuide.requiredInputs.map((item) => `- ${item}`).join('\n');
  const outputs = blueprint.capabilityGuide.outputs.map((item) => `- ${item}`).join('\n');
  const limits = blueprint.capabilityGuide.limits.map((item) => `- ${item}`).join('\n');
  const verification = blueprint.capabilityGuide.verification.map((item) => `- ${item}`).join('\n') || '- 对照来源证据复核关键结论。';
  const skillDirectory = blueprint.delivery.skill?.installDirectory || 'CODEX_HOME/skills/技能名称';
  const naming = blueprint.package.naming || {};
  const namingTopics = (naming.contentTopics || []).join('、') || '未提取到明确主题';
  const namingTools = (naming.toolTerms || []).join('、') || '未提取到工具类别';
  const namingObservedTools = (naming.observedTools || []).map((item) => `\`${item}\``).join('、') || '暂无';
  const namingFiles = (naming.implementationSignals || []).map((item) => `\`${item}\``).join('、') || '暂无';

  return `# ${blueprint.package.name} - 完整能力说明

## 一句话说明

**${blueprint.capabilityGuide.plainSummary}**

## 包名称为什么这样命名

这是根据完整会话分析后自动生成的名称，不是按会话编号套模板：

- 识别到的业务主题：${(naming.subjects || []).join('、') || '未提取到具体业务主题'}
- 识别到的内容方向：${namingTopics}
- 实际工具类别：${namingTools}
- 会话中实际出现的工具：${namingObservedTools}
- 参与命名判断的实现文件信号：${namingFiles}

上面的主题、工具和文件证据共同决定包名称；如果你在工作台填写了自定义名称，系统会保留这份自动分析依据，并把自定义名称标为人工覆盖。

这不是一份只有配置文件的空壳。能力包同时提供可安装的技能、可注册的模型上下文协议服务和可独立启动的中文人工智能界面。三者使用同一份会话派生工作流，但用途不同。

## 它实际能做什么

### 独立界面能直接完成

| 功能 | 直白说明 |
| --- | --- |
${uiCapabilityRows}

### 从原会话提炼出的专长

| 能力 | 什么时候用 | 执行方法 |
| --- | --- | --- |
${capabilityRows}

### 三种交付形态分别负责什么

| 形态 | 能力说明 |
| --- | --- |
${deliveryRows}

## 适合处理哪些任务

以下任务不是通用示例，而是从所选会话的实际需求阶段提炼而来：

| 来源阶段 | 适用任务 | 原需求摘要 |
| --- | --- | --- |
${taskRows}

## 你需要提供什么

${inputs}

使用独立界面时，可以把资料直接放进对话，也可以选择一个本地工作区，让人工智能自行浏览和读取项目文件。需要修改文件或运行命令时，在页面中明确开启对应权限。

## 它会怎样执行

${stages}

每次独立界面对话都会自动注入上述步骤、触发规则、预期产物和验收要求。模型还会获得当前实际开放的本地工具，并根据工具结果连续决定下一步，不需要重新粘贴原会话提示词。

## 如何提取并改进原对话

这部分是本能力包的核心增强，不是泛化的“总结会话”：

- **提取范围**：保存每个需求阶段的原始用户消息、助手回应、工具名称、工具参数、工具结果、命令和文件变更；完整结构化内容位于 \`conversation-extraction.json\`。
- **需求演进**：按阶段标出初始目标、目标细化、目标扩展和用户纠正；后出现的明确纠正优先级高于早期目标。
- **改进依据**：把用户说“不够、太弱、缺少、必须”等内容列为纠正，单独展示旧方案不足、保留的有效做法和新的验收标准。
- **执行方式**：Agent 在执行前可调用原对话检索工具，按关键词找到原话与工具证据，再按“读取纠正 → 回查证据 → 修正缺口 → 真实操作 → 验收 → 交付”的改进流程工作。
- **可核对性**：每个改进步骤都带来源阶段或所需工具；实际未发生的文件修改、命令和验证不会被当成完成结果。

### 改进后的重点流程

${(blueprint.distillation?.improvedWorkflow || []).map((item) => `${item.order}. **${escapeMarkdown(item.name)}**：${escapeMarkdown(item.description)}`).join('\n') || '- 读取原对话 → 执行当前目标 → 按证据验证。'}

### 本会话的需求演进

${(blueprint.distillation?.requirementEvolution || []).slice(0, 12).map((item) => `- 第 ${item.stage} 阶段，${item.label}：${escapeMarkdown(item.request)}`).join('\n') || '- 暂无可展示的需求演进。'}

### 已识别的纠正和不足

${(blueprint.distillation?.corrections || []).slice(0, 12).map((item) => `- 第 ${item.stage} 阶段：${escapeMarkdown(item.request)}；必须改进：${escapeMarkdown(item.requiredChange)}`).join('\n') || '- 暂无明确纠正；运行时仍以当前用户最新要求为准。'}

原对话检索在独立 Agent 中对应 \`search_original_conversation\`、\`get_original_conversation_stage\` 和 \`get_improved_workflow\` 三个内置工具；它们不需要配置工作区写入权限即可读取能力包自身的证据。

## 你会得到什么

${outputs}

独立界面的人工智能回复可以直接复制或下载为 Markdown 文件；它也可以在所选工作区中真实读取文件。开启权限后，还能修改文件、执行脚本、运行测试并生成工作区产物。每次本地工具操作都会显示在对话中。

## 新手推荐用法：直接打开独立界面

### 第一次启动

1. 打开能力包的 \`agent\` 文件夹。
2. 在文件夹地址栏输入 \`powershell\` 并按回车。
3. 运行 \`node --version\`，确认版本为 18 或更高。
4. 运行 \`node agent-server.mjs\`。
5. 保持终端开启，在浏览器打开终端显示的地址，默认通常为 \`http://127.0.0.1:8890/\`。
6. 停止使用时回到终端按 \`Ctrl+C\`。

请运行 \`agent-server.mjs\` 后再打开界面。直接双击 \`agent/ui/index.html\` 只会显示静态页面；模型连接和任务执行由后端服务提供。

### 页面上每个主要功能的作用

| 页面功能 | 作用 | 什么时候点 |
| --- | --- | --- |
| 在线模型 / 本地模型 | 切换模型服务类型并填写对应连接 | 第一次连接或更换服务时 |
| 获取全部模型 | 从模型服务读取并完整显示接口返回的模型列表；可搜索并点击选用 | 不知道准确模型名称时 |
| 保存并检查连接 | 保存本次内存配置并真实访问模型列表验证连接 | 地址、模型或密钥有变化后 |
| 工作区文件夹 | 指定允许人工智能浏览和操作的本地项目范围 | 第一次使用或切换项目时 |
| 允许创建和修改文件 | 开放创建目录、写文件和精确文本替换 | 任务需要真正落地修改时 |
| 允许自动执行本地命令 | 开放 PowerShell、构建、测试和检查命令 | 只对可信任务按需开启 |
| 执行本地任务 | 让模型自动选择文件和命令工具并连续处理 | 要像 Codex 一样完成本地工作时 |
| 分析问题 | 让人工智能先说明资料、步骤、风险和判断方法 | 目标还不清楚时 |
| 生成结果 | 按工作流生成一份完整文本交付结果 | 已经提供足够资料时 |
| 检查内容 | 对照验收要求审查你提供的现有内容 | 已有草稿或报告时 |
| 开始执行 | 把任务、历史、工作流和当前工具权限交给人工智能 | 模型与工作区都准备好后 |
| 停止执行 | 中止当前模型请求或正在运行的本地命令 | 任务跑偏或不再需要时 |
| 复制结果 | 复制单条人工智能回复 | 要粘贴到其他应用时 |
| 下载 Markdown | 把单条结果保存为 Markdown 文件 | 要形成可交付文件时 |
| 清空对话 | 删除当前浏览器页面里的对话上下文 | 要开始完全不同的新任务时 |
| 能力说明 | 查看本能力包能做什么、适用任务、输入输出和边界 | 不确定该不该用时 |
| 执行工作流 | 查看步骤、产物和验收标准 | 需要核对执行依据时 |
| 操作说明 | 查看模型连接、任务模式和按钮说明 | 第一次使用或操作受阻时 |

### 连接模型

- 在线模型：填写兼容接口的 HTTPS 地址、模型名称和服务商要求的密钥。
- 本地模型：先启动本地模型程序，再填写它提供的 OpenAI 兼容地址；通常可以不填密钥。
- 能力包不附带模型，也不会自动安装或启动本地模型。
- 网页中填写的密钥只保存在当前服务进程内存中，关闭服务后自动清除，能力包文件不会记录该密钥。

### 本地工作区与命令

- 浏览目录和读取文本文件始终开放，但只限你保存的工作区。
- 创建或修改文件默认关闭，需要单独勾选并保存。
- 执行本地命令默认关闭，需要单独勾选并保存。命令使用当前系统账户权限。
- 命令环境会移除常见密钥、令牌和密码变量；命令输出和文件内容会限制长度。
- 对话会显示工具名称、参数、状态、耗时与结果，可据此核对人工智能实际做了什么。

独立智能体的更详细启动、接口和排错说明见 \`agent/README.md\`。

## 在 Codex 中使用技能

技能名称：\`${skillName}\`

包内位置：\`skill/${skillName}\`

建议安装位置：\`${skillDirectory}\`

安装后，在 Codex 中提出与上述适用任务相近的目标，或明确写出 \`$${skillName}\`。技能会先读取会话合同，再根据当前工作区资料执行，并把计划作为检查表而不是最终结果。

技能适合需要以下操作的任务：读取本地文件、运行脚本、修改代码、生成真实产物、执行测试或浏览器验收。

## 注册模型上下文协议服务

配置示例位于 \`mcp/mcp.config.example.json\`。其中已经写入本能力包生成时的服务脚本绝对路径，可将对应服务项合并到兼容客户端的 MCP 配置中。

服务提供八个工具：

| 工具 | 作用 |
| --- | --- |
| \`get_conversation_workflow\` | 读取工作流、输入、触发逻辑和验收要求 |
| \`get_conversation_evidence_summary\` | 读取完整会话选择锚点、需求阶段、工具和文件证据摘要 |
| \`get_conversation_distillation\` | 读取需求演进、用户纠正、已识别不足、保留做法和改进后流程 |
| \`search_original_conversation\` | 按关键词搜索原用户话语、助手回应、工具、命令和文件变更 |
| \`get_original_conversation_stage\` | 读取指定需求阶段的完整提取证据 |
| \`get_improved_workflow\` | 读取改进后执行流程、验收标准和失败恢复规则 |
| \`prepare_agent_execution\` | 根据当前目标生成可审计执行计划，要求传入 \`objective\` |
| \`get_package_artifact\` | 分页读取能力包白名单文本产物 |

模型上下文协议服务只负责向客户端提供结构化上下文、原对话证据和计划，不会自行连接模型，也不会自动执行计划中的本地操作。

## 验收标准

${verification}

在能力包根目录运行 \`node verify.mjs\`，可校验清单中每个生成文件的大小和 SHA-256。看到“能力包校验通过”才说明文件没有缺失或被意外修改。

## 明确的能力边界

${limits}

## 来源与可追溯性

- 会话编号：\`${blueprint.selection.sessionId || '源文件未内嵌会话编号'}\`
- 选择范围：${blueprint.selection.label}
- 原始记录：第 ${blueprint.selection.selectedRecordRange[0]} 至 ${blueprint.selection.selectedRecordRange[1]} 条，共 ${blueprint.selection.recordCount} 条
- 标准化事件：${blueprint.selection.normalisedEventCount} 条
- 来源 SHA-256：\`${blueprint.selection.sourceSha256}\`
- 脱敏状态：${blueprint.selection.redacted ? '已启用' : '未启用'}

\`evidence/report.md\` 是中文取证报告，\`evidence/analysis.json\` 是结构化分析，\`evidence/normalized-events.ndjson\` 是标准化事件流。它们用于追溯能力是怎样从原会话提炼出来的，不是独立界面运行模型的必需输入。

## 文件目录

| 路径 | 用途 |
| --- | --- |
| \`README.md\` | 当前这份完整、针对本能力包的中文说明 |
| \`workflow-blueprint.json\` | 工作流、能力说明、触发规则、来源和交付结构 |
| \`conversation-extraction.json\` | 原对话的需求演进、用户纠正、消息、工具、命令、文件变更和改进流程 |
| \`agent/\` | 可独立启动的人工智能服务和中文操作界面 |
| \`agent/README.md\` | 独立智能体启动、连接、接口和排错说明 |
| \`skill/${skillName}/\` | 可安装到 Codex 的技能 |
| \`mcp/\` | 模型上下文协议服务与注册配置示例 |
| \`evidence/\` | 取证报告、结构化分析和标准化事件 |
| \`package-manifest.json\` | 文件清单、来源锚点和完整性哈希 |
| \`verify.mjs\` | 离线完整性校验脚本 |

## 常见问题

| 问题 | 直接处理方法 |
| --- | --- |
| 页面打不开 | 确认 \`node agent-server.mjs\` 仍在运行，并打开终端实际显示的地址 |
| 页面打开后“开始执行”尚未开放 | 先在左侧完成“保存并检查连接”，真实连接成功后执行按钮会自动开放 |
| 不知道模型名称 | 保存接口后会自动读取完整模型列表；也可以点击“获取全部模型”，搜索并直接点击选用。服务不支持模型列表时按服务说明手动填写 |
| 本地模型连不上 | 先启动本地模型程序，核对端口和 \`/v1\` 路径，再重新检查 |
| 在线模型返回 401 或 403 | 重新粘贴完整密钥，并确认该密钥有权访问所选模型 |
| 希望人工智能读取电脑上的 CSV 或代码 | 在独立界面选择包含这些文件的工作区；文本文件可直接读取，二进制格式需由命令或合适工具转换 |
| 希望人工智能修改文件 | 在工作区配置中勾选“允许创建和修改文件”，保存后重新执行任务 |
| 希望人工智能运行构建或测试 | 勾选“允许自动执行本地命令”，确认工作区后再开始任务 |
| 希望确认能力来源 | 查看 \`evidence/report.md\` 和 \`workflow-blueprint.json\` |
| 怀疑文件被改坏 | 在根目录运行 \`node verify.mjs\` |
`;
}

function skillRunnerSource() {
  return `import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const blueprintPath = path.resolve(here, '../references/workflow-blueprint.json');
const objective = process.argv.slice(2).join(' ').trim();
const blueprint = JSON.parse(await fs.readFile(blueprintPath, 'utf8'));

const plan = {
  package: blueprint.package,
  objective: objective || '请在命令参数中提供要处理的目标。',
  selection: blueprint.selection,
  steps: blueprint.workflow.steps.map((name, index) => ({ order: index + 1, name, status: '待执行' })),
  expectedOutputs: blueprint.workflow.expectedOutputs,
  verification: blueprint.workflow.verification,
};

process.stdout.write(JSON.stringify(plan, null, 2) + '\\n');
`;
}

function mcpServerSource() {
  return `import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, '..');
const BLUEPRINT_PATH = path.join(PACKAGE_ROOT, 'workflow-blueprint.json');
const CONVERSATION_PATH = path.join(PACKAGE_ROOT, 'conversation-extraction.json');
const ARTIFACTS = new Set(['README.md', 'workflow-blueprint.json', 'conversation-extraction.json', 'package-manifest.json', 'evidence/report.md']);

function jsonResponse(id, result) { return JSON.stringify({ jsonrpc: '2.0', id, result }); }
function errorResponse(id, code, message) { return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }); }
function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}
function boundedInt(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), minimum), maximum);
}
async function loadBlueprint() { return JSON.parse(await fs.readFile(BLUEPRINT_PATH, 'utf8')); }
async function loadConversation() { return JSON.parse(await fs.readFile(CONVERSATION_PATH, 'utf8')); }
function preparePlan(blueprint, args) {
  const objective = String(args.objective || '').trim();
  if (!objective) throw new Error('请提供 objective 作为当前执行目标。');
  const inputs = args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs) ? args.inputs : {};
  return {
    package: blueprint.package,
    objective,
    selection: blueprint.selection,
    providedInputs: inputs,
    steps: (blueprint.distillation?.improvedWorkflow?.length ? blueprint.distillation.improvedWorkflow : blueprint.workflow.steps.map((name) => ({ name, description: name }))).map((step, index) => ({
      order: index + 1,
      name: step.name || step,
      instruction: '围绕“' + objective + '”执行：' + (step.description || step.name || step),
      status: '待执行',
    })),
    expectedOutputs: blueprint.workflow.expectedOutputs,
    verification: blueprint.workflow.verification,
    triggerSummary: blueprint.workflow.triggers,
  };
}
function compactStage(stage) {
  return {
    index: stage.index,
    title: stage.title,
    changeType: stage.changeType,
    changeLabel: stage.changeLabel,
    changeSummary: stage.changeSummary,
    request: stage.request,
    userMessages: (stage.userMessages || []).slice(0, 20),
    assistantMessages: (stage.assistantMessages || []).slice(0, 20),
    toolNames: stage.toolNames || [],
    toolCalls: (stage.toolCalls || []).slice(0, 40),
    commands: (stage.commands || []).slice(0, 40),
    fileChanges: (stage.fileChanges || []).slice(0, 40),
    outcome: stage.outcome,
  };
}
function searchConversation(extraction, args) {
  const query = String(args.query || '').trim().toLowerCase();
  if (!query) throw new Error('请提供 query 作为原对话搜索词。');
  const maxResults = boundedInt(args.maxResults, 10, 1, 20);
  const results = [];
  for (const stage of extraction.stages || []) {
    const haystack = JSON.stringify(stage).toLowerCase();
    const position = haystack.indexOf(query);
    if (position < 0) continue;
    const source = [
      ...(stage.userMessages || []).map((item) => ({ kind: '用户消息', text: item.text, eventIndex: item.eventIndex })),
      ...(stage.assistantMessages || []).map((item) => ({ kind: '助手回应', text: item.text, eventIndex: item.eventIndex })),
      ...(stage.toolCalls || []).map((item) => ({ kind: '工具调用', text: item.name + ' ' + item.arguments + (item.result?.excerpt || ''), eventIndex: item.eventIndex })),
      ...(stage.commands || []).map((item) => ({ kind: '命令', text: item.command, eventIndex: item.eventIndex })),
      ...(stage.fileChanges || []).map((item) => ({ kind: '文件变更', text: item.path + ' ' + item.action, eventIndex: item.eventIndex })),
    ];
    const matches = source.filter((item) => String(item.text || '').toLowerCase().includes(query)).slice(0, 8);
    results.push({ stage: stage.index, title: stage.title, changeLabel: stage.changeLabel, request: stage.request, matches });
    if (results.length >= maxResults) break;
  }
  return { query, count: results.length, results };
}
async function readArtifact(name, offset, maxChars) {
  if (!ARTIFACTS.has(name)) throw new Error('读取范围仅限能力包白名单文件。');
  const filePath = path.resolve(PACKAGE_ROOT, name);
  const relative = path.relative(PACKAGE_ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('文件路径超出能力包根目录。');
  const content = await fs.readFile(filePath, 'utf8');
  const start = boundedInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const size = boundedInt(maxChars, 30000, 100, 200000);
  const fragment = content.slice(start, start + size);
  return { artifact: name, offset: start, nextOffset: start + fragment.length, totalChars: content.length, hasMore: start + fragment.length < content.length, content: fragment };
}

const tools = [
  {
    name: 'get_conversation_workflow',
    description: '读取由完整 Codex 会话提炼出的工作流、输入契约、触发逻辑与验证项。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_conversation_evidence_summary',
    description: '读取完整会话选择锚点、请求阶段、工具和文件证据的结构化摘要。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_conversation_distillation',
    description: '读取原对话的需求演进、用户纠正、保留做法、已识别不足、改进后流程和验收标准。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_original_conversation',
    description: '按关键词检索原用户消息、助手回应、工具调用、命令和文件变更，并返回所属阶段。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: '要检索的关键词或短句。' },
        maxResults: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回多少个阶段，默认 10。' },
      },
    },
  },
  {
    name: 'get_original_conversation_stage',
    description: '读取指定需求阶段的原始消息、工具参数和结果、命令、文件变更及执行结果。',
    inputSchema: {
      type: 'object',
      required: ['stageIndex'],
      properties: { stageIndex: { type: 'integer', minimum: 1, description: '需求阶段编号，从 1 开始。' } },
    },
  },
  {
    name: 'get_improved_workflow',
    description: '读取根据原对话纠正和证据生成的改进后执行流程、验收标准和恢复规则。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'prepare_agent_execution',
    description: '根据会话派生工作流和当前目标生成可审计的执行计划，并明确标记各步骤的执行状态。',
    inputSchema: {
      type: 'object',
      required: ['objective'],
      properties: {
        objective: { type: 'string', description: '本次要处理的目标。' },
        inputs: { type: 'object', description: '已掌握的结构化输入。' },
      },
    },
  },
  {
    name: 'get_package_artifact',
    description: '读取能力包内经白名单限定的文本产物，并支持按字符偏移分页。',
    inputSchema: {
      type: 'object',
      required: ['artifact'],
      properties: {
        artifact: { type: 'string', enum: ['README.md', 'workflow-blueprint.json', 'conversation-extraction.json', 'package-manifest.json', 'evidence/report.md'] },
        offset: { type: 'integer', minimum: 0, description: '字符偏移，默认 0。' },
        maxChars: { type: 'integer', minimum: 100, maximum: 200000, description: '本次返回的最大字符数。' },
      },
    },
  },
];

async function handle(request) {
  const { id, method, params = {} } = request;
  if (method === 'initialize') {
    return jsonResponse(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'conversation-capability-package', version: '1.0.0' } });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return jsonResponse(id, {});
  if (method === 'tools/list') return jsonResponse(id, { tools });
  if (method === 'tools/call') {
    try {
      const blueprint = await loadBlueprint();
      const args = params.arguments || {};
      if (params.name === 'get_conversation_workflow') return jsonResponse(id, textResult({ package: blueprint.package, selection: blueprint.selection, workflow: blueprint.workflow }));
      if (params.name === 'get_conversation_evidence_summary') return jsonResponse(id, textResult({ package: blueprint.package, selection: blueprint.selection, evidence: blueprint.evidence }));
      if (params.name === 'get_conversation_distillation') return jsonResponse(id, textResult(blueprint.distillation || {}));
      if (params.name === 'search_original_conversation') return jsonResponse(id, textResult(searchConversation(await loadConversation(), args)));
      if (params.name === 'get_original_conversation_stage') {
        const extraction = await loadConversation();
        const stage = (extraction.stages || []).find((item) => Number(item.index) === Number(args.stageIndex));
        if (!stage) throw new Error('未找到指定的原对话需求阶段。');
        return jsonResponse(id, textResult(compactStage(stage)));
      }
      if (params.name === 'get_improved_workflow') return jsonResponse(id, textResult({ improvedWorkflow: blueprint.distillation?.improvedWorkflow || [], acceptanceCriteria: blueprint.distillation?.acceptanceCriteria || [], recoveryRules: blueprint.distillation?.recoveryRules || [] }));
      if (params.name === 'prepare_agent_execution') return jsonResponse(id, textResult(preparePlan(blueprint, args)));
      if (params.name === 'get_package_artifact') return jsonResponse(id, textResult(await readArtifact(args.artifact, args.offset, args.maxChars)));
      return errorResponse(id, -32602, '未识别的工具：' + String(params.name || ''));
    } catch (error) {
      return errorResponse(id, -32000, error instanceof Error ? error.message : String(error));
    }
  }
  if (id === undefined) return null;
  return errorResponse(id, -32601, '未找到请求的方法：' + String(method || ''));
}

let buffer = '';
let queue = Promise.resolve();
function enqueue(line) {
  queue = queue.then(async () => {
    if (!line.trim()) return;
    try {
      const response = await handle(JSON.parse(line));
      if (response) process.stdout.write(response + '\\n');
    } catch (error) {
      process.stdout.write(errorResponse(null, -32700, error instanceof Error ? error.message : String(error)) + '\\n');
    }
  });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) enqueue(line);
});
process.stdin.on('end', () => { if (buffer.trim()) enqueue(buffer); });
`;
}

function agentHtmlSource() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="由完整会话派生的独立执行智能代理" />
    <title>会话派生智能代理</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header class="topbar">
      <div class="brand"><span class="mark">执行</span><div><strong>会话派生智能代理</strong><span>完整会话工作流的独立界面</span></div></div>
      <span id="connection" class="connection">正在连接</span>
    </header>
    <main>
      <section class="intro" aria-labelledby="title">
        <span class="eyebrow">完整会话封装</span>
        <h1 id="title">正在读取工作流</h1>
        <p id="description">将显示所选会话的来源锚点、触发逻辑、执行步骤和验证要求。</p>
        <div id="selection" class="selection"></div>
      </section>
      <section class="band overview" aria-labelledby="overview-title">
        <div class="section-heading"><div><span class="eyebrow">工作流概览</span><h2 id="overview-title">输入、步骤与输出</h2></div><div id="artifact-links" class="artifact-links"></div></div>
        <div class="overview-grid"><div><h3>必需输入</h3><ul id="inputs-list"></ul></div><div><h3>预期产物</h3><ul id="outputs-list"></ul></div><div><h3>验证要求</h3><ul id="verification-list"></ul></div></div>
      </section>
      <section class="band split" aria-label="执行准备">
        <div class="workflow-panel"><span class="eyebrow">会话派生步骤</span><h2>执行顺序</h2><ol id="steps-list" class="steps"></ol><h3>触发逻辑</h3><div id="triggers" class="triggers"></div></div>
        <form id="plan-form" class="plan-panel"><span class="eyebrow">执行准备</span><h2>生成本次执行计划</h2><label for="objective">当前目标</label><textarea id="objective" required placeholder="例如：根据当前项目生成可复用的交付计划"></textarea><label for="context">已有上下文</label><textarea id="context" placeholder="可填写已知数据、约束、路径或验收标准"></textarea><button type="submit">生成执行计划</button><p id="form-status" class="status">输入目标后生成步骤、产物和验证项。</p></form>
      </section>
      <section class="band plan-result" aria-live="polite"><div class="section-heading"><div><span class="eyebrow">本次计划</span><h2 id="plan-title">待生成</h2></div></div><div id="plan-output" class="empty">填写目标后会在这里生成执行步骤、预期产物和验证项。</div></section>
    </main>
    <script type="module" src="/app.js"></script>
  </body>
</html>
`;
}

function agentAppSource() {
  return `const $ = (selector) => document.querySelector(selector);
const state = { blueprint: null };

function escape(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function list(values, empty = '暂无') { return values && values.length ? values.map((value) => '<li>' + escape(value) + '</li>').join('') : '<li>' + escape(empty) + '</li>'; }
function evidenceLevel(value) { return value === 'direct' ? '直接证据' : value === 'inferred' ? '时序推断' : '未标注'; }
function renderBlueprint(blueprint) {
  state.blueprint = blueprint;
  $('#title').textContent = blueprint.package.name;
  $('#description').textContent = blueprint.workflow.description;
  $('#selection').innerHTML = '<span>选择范围：' + escape(blueprint.selection.label) + '</span><span>会话编号：<code>' + escape(blueprint.selection.sessionId || '源文件未内嵌会话编号') + '</code></span><span>记录：' + escape(blueprint.selection.recordCount) + ' 条</span><span>SHA-256：<code>' + escape(blueprint.selection.sourceSha256) + '</code></span>';
  $('#inputs-list').innerHTML = list(blueprint.workflow.inputs, '当前工作流没有额外必需输入。');
  $('#outputs-list').innerHTML = list(blueprint.workflow.expectedOutputs);
  $('#verification-list').innerHTML = list(blueprint.workflow.verification, '请对照会话证据完成复核。');
  $('#steps-list').innerHTML = (blueprint.workflow.steps || []).map((step, index) => '<li><span>' + (index + 1) + '</span><strong>' + escape(step) + '</strong></li>').join('') || '<li><span>1</span><strong>暂无可提取步骤</strong></li>';
  $('#triggers').innerHTML = (blueprint.workflow.triggers || []).map((rule) => '<article><span class="badge ' + escape(rule.evidenceLevel) + '">' + evidenceLevel(rule.evidenceLevel) + '</span><strong>' + escape(rule.trigger) + '</strong><p>成立条件：' + escape(rule.condition) + '</p><p>执行动作：' + escape(rule.action) + '</p></article>').join('') || '<p class="empty">暂无可提取触发逻辑。</p>';
  const links = [['manifest', '查看能力包清单'], ['skill', '查看技能定义'], ['mcpConfig', '查看协议服务配置']];
  $('#artifact-links').innerHTML = links.filter(([key]) => key !== 'skill' || blueprint.delivery.skill).filter(([key]) => key !== 'mcpConfig' || blueprint.delivery.mcp).map(([key, label]) => '<a href="/api/artifact?name=' + key + '" target="_blank" rel="noreferrer">' + label + '</a>').join('');
}
function renderPlan(plan) {
  const steps = (plan.steps || []).map((step) => '<li><span>' + escape(step.order) + '</span><div><strong>' + escape(step.name) + '</strong><p>' + escape(step.instruction) + '</p></div></li>').join('');
  const outputs = (plan.expectedOutputs || []).map((item) => '<li>' + escape(item) + '</li>').join('');
  const verification = (plan.verification || []).map((item) => '<li>' + escape(item) + '</li>').join('');
  $('#plan-title').textContent = '执行计划已生成';
  $('#plan-output').className = 'plan';
  $('#plan-output').innerHTML = '<p class="plan-objective">当前目标：' + escape(plan.objective) + '</p><h3>待执行步骤</h3><ol class="steps plan-steps">' + steps + '</ol><div class="plan-grid"><div><h3>预期产物</h3><ul>' + outputs + '</ul></div><div><h3>验证项</h3><ul>' + verification + '</ul></div></div>';
}
async function load() {
  try {
    const response = await fetch('/api/workflow');
    const blueprint = await response.json();
    if (!response.ok) throw new Error(blueprint.error || '工作流读取失败。');
    renderBlueprint(blueprint);
    $('#connection').textContent = '工作流已就绪';
    $('#connection').dataset.state = 'ok';
  } catch (error) {
    $('#connection').textContent = '连接失败';
    $('#connection').dataset.state = 'error';
    $('#description').textContent = error instanceof Error ? error.message : '工作流读取失败。';
  }
}
$('#plan-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  $('#form-status').textContent = '正在生成可审计执行计划……';
  try {
    const inputs = { 已有上下文: $('#context').value.trim() };
    const response = await fetch('/api/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective: $('#objective').value.trim(), inputs }) });
    const plan = await response.json();
    if (!response.ok) throw new Error(plan.error || '执行计划生成失败。');
    renderPlan(plan);
    $('#form-status').textContent = '执行计划已生成。';
  } catch (error) {
    $('#form-status').textContent = error instanceof Error ? error.message : '执行计划生成失败。';
  } finally {
    button.disabled = false;
  }
});
load();
`;
}

function agentStylesSource() {
  return `:root { color-scheme: light; --ink: #18231f; --muted: #60716a; --line: #d5ded9; --canvas: #f4f7f5; --panel: #ffffff; --teal: #096b60; --teal-soft: #e5f2ee; --blue: #1e608c; --yellow: #8a6b1a; --shadow: 0 10px 26px rgba(23, 33, 30, .07); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--canvas); color: var(--ink); font: 14px/1.55 Inter, "Segoe UI", "Microsoft YaHei", Arial, sans-serif; }
button, textarea { font: inherit; }
button { cursor: pointer; }
.topbar { min-height: 70px; padding: 12px clamp(18px, 5vw, 72px); display: flex; align-items: center; justify-content: space-between; gap: 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
.brand { display: flex; align-items: center; gap: 12px; }
.mark { display: grid; width: 38px; height: 38px; place-items: center; border: 1px solid #9bc9be; border-radius: 5px; background: var(--teal-soft); color: var(--teal); font-size: 11px; font-weight: 800; }
.brand strong, .brand span { display: block; }
.brand strong { font-size: 16px; }
.brand span, .connection { color: var(--muted); font-size: 12px; }
.connection[data-state="ok"] { color: var(--teal); }
.connection[data-state="error"] { color: #a44f37; }
main { max-width: 1280px; margin: 0 auto; padding-bottom: 48px; }
.intro { padding: clamp(30px, 7vw, 78px) clamp(18px, 5vw, 72px) 30px; border-bottom: 1px solid var(--line); background: #fbfdfc; }
.eyebrow { color: var(--teal); font-size: 10px; font-weight: 800; letter-spacing: .08em; }
h1, h2, h3, p { margin-top: 0; }
h1 { max-width: 880px; margin: 7px 0 10px; font-size: clamp(28px, 4vw, 46px); line-height: 1.18; letter-spacing: 0; }
h2 { margin-bottom: 7px; font-size: 20px; letter-spacing: 0; }
h3 { margin-bottom: 8px; font-size: 14px; }
.intro > p { max-width: 820px; color: #456056; font-size: 16px; }
.selection { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 22px; color: var(--muted); font-size: 12px; }
.selection span { max-width: 100%; overflow-wrap: anywhere; }
code { overflow-wrap: anywhere; }
.band { margin: 0 clamp(18px, 5vw, 72px); padding: 30px 0; border-bottom: 1px solid var(--line); }
.section-heading { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.artifact-links { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.artifact-links a { padding: 6px 9px; border: 1px solid #b8cec5; border-radius: 4px; color: var(--teal); text-decoration: none; font-size: 12px; }
.artifact-links a:hover { background: var(--teal-soft); }
.overview-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; margin-top: 20px; }
.overview-grid > div { min-width: 0; }
ul { margin: 0; padding-left: 18px; }
li { margin: 5px 0; overflow-wrap: anywhere; }
.split { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(280px, .85fr); gap: 42px; }
.workflow-panel, .plan-panel { min-width: 0; }
.steps { display: grid; gap: 0; margin: 16px 0 26px; padding: 0; list-style: none; border-top: 1px solid var(--line); }
.steps li { display: flex; gap: 12px; align-items: flex-start; margin: 0; padding: 12px 0; border-bottom: 1px solid var(--line); }
.steps li > span { flex: 0 0 24px; display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid #a9cbbf; border-radius: 50%; background: var(--teal-soft); color: var(--teal); font-size: 11px; font-weight: 800; }
.steps strong { line-height: 1.7; }
.triggers { display: grid; gap: 8px; }
.triggers article { padding: 12px 0; border-top: 1px solid var(--line); }
.triggers strong { display: block; margin-top: 5px; }
.triggers p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.badge { display: inline-block; padding: 2px 6px; border: 1px solid #b9d8ce; border-radius: 3px; background: var(--teal-soft); color: var(--teal); font-size: 11px; }
.badge.inferred { border-color: #ead9a1; background: #fff8dc; color: var(--yellow); }
.plan-panel { align-self: start; padding: 20px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); box-shadow: var(--shadow); }
.plan-panel label { display: block; margin: 16px 0 6px; color: var(--muted); font-size: 12px; font-weight: 700; }
textarea { display: block; width: 100%; min-height: 90px; padding: 9px 10px; border: 1px solid #bdc9c3; border-radius: 4px; resize: vertical; color: var(--ink); }
textarea:focus { border-color: var(--teal); outline: 3px solid rgba(9, 107, 96, .12); }
button[type="submit"] { width: 100%; min-height: 40px; margin-top: 16px; border: 1px solid var(--teal); border-radius: 4px; background: var(--teal); color: #fff; font-weight: 800; }
button[type="submit"]:hover { background: #07584f; }
button[disabled] { cursor: wait; opacity: .65; }
.status { min-height: 38px; margin: 11px 0 0; color: var(--muted); font-size: 12px; }
.plan-result { min-height: 220px; }
.empty { padding: 28px 0; color: var(--muted); }
.plan-objective { padding: 12px; border-left: 3px solid var(--teal); background: var(--teal-soft); }
.plan-steps { max-width: 820px; }
.plan-steps p { margin: 4px 0 0; color: var(--muted); }
.plan-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin-top: 20px; }
@media (max-width: 780px) { .overview-grid, .split, .plan-grid { grid-template-columns: 1fr; } .artifact-links { justify-content: flex-start; } }
@media (max-width: 500px) { .topbar { align-items: flex-start; } .connection { max-width: 88px; text-align: right; } h1 { font-size: 30px; } .section-heading { display: block; } .artifact-links { margin-top: 12px; } }
`;
}

async function createSkill(packageRoot, blueprint, skillName) {
  const skillRoot = path.join(packageRoot, 'skill', skillName);
  const referencesRoot = path.join(skillRoot, 'references');
  await writeFile(path.join(skillRoot, 'SKILL.md'), buildSkillMarkdown(blueprint, skillName));
  await writeFile(path.join(skillRoot, 'agents', 'openai.yaml'), `interface:\n  display_name: ${yamlString(blueprint.package.name)}\n  short_description: ${yamlString('复用完整会话工作流并直接生成实际产物')}\n  default_prompt: ${yamlString(`使用 $${skillName} 按完整会话工作流直接执行当前目标，生成实际产物并完成验证。`)}\n`);
  await writeFile(path.join(referencesRoot, 'conversation-contract.md'), buildSkillContract(blueprint));
  await writeFile(path.join(referencesRoot, 'workflow-blueprint.json'), JSON.stringify(blueprint, null, 2) + '\n');
  await Promise.all([
    fs.copyFile(path.join(packageRoot, 'evidence', 'analysis.json'), path.join(referencesRoot, 'analysis.json')),
    fs.copyFile(path.join(packageRoot, 'evidence', 'normalized-events.ndjson'), path.join(referencesRoot, 'normalized-events.ndjson')),
    fs.copyFile(path.join(packageRoot, 'conversation-extraction.json'), path.join(referencesRoot, 'conversation-extraction.json')),
  ]);
  await writeFile(path.join(skillRoot, 'scripts', 'prepare-workflow.mjs'), skillRunnerSource());
  return {
    root: skillRoot,
    skillFile: path.join(skillRoot, 'SKILL.md'),
    interfaceFile: path.join(skillRoot, 'agents', 'openai.yaml'),
    runner: path.join(skillRoot, 'scripts', 'prepare-workflow.mjs'),
    installDirectory: blueprint.delivery.skill.installDirectory,
  };
}

async function createMcp(packageRoot, blueprint) {
  const root = path.join(packageRoot, 'mcp');
  const server = path.join(root, `${blueprint.package.id}-server.mjs`);
  const config = path.join(root, 'mcp.config.example.json');
  await writeFile(server, mcpServerSource());
  await writeFile(config, JSON.stringify({
    mcpServers: {
      [`conversation-${blueprint.package.id}`]: {
        command: process.execPath,
        args: [server],
      },
    },
  }, null, 2) + '\n');
  return { root, server, config };
}

function agentAiProfile(blueprint) {
  return {
    schemaVersion: '4.0.0',
    name: blueprint.package.name,
    packageId: blueprint.package.id,
    provider: 'openai-compatible',
    persistence: 'memory-only',
    secretsPersisted: false,
    defaults: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      timeoutMs: 60000,
    },
    environment: {
      baseUrl: 'CONVERSATION_AGENT_OPENAI_BASE_URL',
      apiKey: 'CONVERSATION_AGENT_OPENAI_API_KEY',
      model: 'CONVERSATION_AGENT_OPENAI_MODEL',
      organization: 'CONVERSATION_AGENT_OPENAI_ORGANIZATION',
      project: 'CONVERSATION_AGENT_OPENAI_PROJECT',
      timeoutMs: 'CONVERSATION_AGENT_OPENAI_TIMEOUT_MS',
      workspaceRoot: 'CONVERSATION_AGENT_WORKSPACE_ROOT',
      workspaceWrite: 'CONVERSATION_AGENT_WORKSPACE_WRITE',
      commandExecution: 'CONVERSATION_AGENT_COMMAND_EXECUTION',
      commandTimeoutMs: 'CONVERSATION_AGENT_COMMAND_TIMEOUT_MS',
      maxAgentSteps: 'CONVERSATION_AGENT_MAX_STEPS',
    },
    endpoints: {
      health: '/api/runtime/health',
      config: '/api/runtime/config',
      models: '/api/runtime/models',
      context: '/api/runtime/context',
      distillation: '/api/runtime/distillation',
      conversationSearch: '/api/runtime/conversation/search',
      chat: '/api/runtime/chat',
      workspace: '/api/runtime/workspace',
      tools: '/api/runtime/tools',
      agent: '/api/runtime/agent',
      openaiModels: '/v1/models',
      openaiChat: '/v1/chat/completions',
    },
    compatibilityAliases: {
      status: '/api/ai/status',
      config: '/api/ai/config',
      models: '/api/ai/models',
      context: '/api/ai/context',
      distillation: '/api/ai/distillation',
      conversationSearch: '/api/ai/conversation/search',
      chat: '/api/ai/chat',
      workspace: '/api/ai/workspace',
      tools: '/api/ai/tools',
      agent: '/api/ai/agent',
    },
    features: {
      streaming: true,
      workflowContext: true,
      originalConversationExtraction: true,
      originalConversationSearch: true,
      improvedWorkflow: true,
      runtimeKeyStorage: 'memory-only',
      operableUi: true,
      beginnerGuidedSetup: true,
      verifiedConnectionGate: true,
      promptExamples: true,
      errorRecovery: true,
      resultCopyAndDownload: true,
      conversationHistory: true,
      stopGeneration: true,
      modelConnectionTest: true,
      localWorkspace: true,
      workspaceBoundFileTools: true,
      fileRead: true,
      fileWriteWithExplicitPermission: true,
      commandExecutionWithExplicitPermission: true,
      autonomousToolLoop: true,
      visibleToolTrace: true,
      commandEnvironmentSecretFiltering: true,
      modes: ['执行本地任务', '分析问题', '生成结果', '检查内容', '提取并改进原对话'],
    },
  };
}

function agentEnvExampleSource() {
  return `# 高级启动配置参考：新手无需修改此文件，请先启动服务，再通过网页填写连接。
# 程序不会自动读取本文件，也不需要把它改名为 .env。
# 如需使用这些变量，请在终端或进程管理器中设置；不要在本文件中保存真实密钥。

# OpenAI 兼容模型服务：在线服务通常使用 HTTPS，本地服务通常使用 http://127.0.0.1:端口/v1
CONVERSATION_AGENT_OPENAI_BASE_URL=https://api.openai.com/v1
CONVERSATION_AGENT_OPENAI_API_KEY=
CONVERSATION_AGENT_OPENAI_MODEL=gpt-4.1-mini
CONVERSATION_AGENT_OPENAI_ORGANIZATION=
CONVERSATION_AGENT_OPENAI_PROJECT=
# 最长等待时间，单位为毫秒；60000 表示 60 秒
CONVERSATION_AGENT_OPENAI_TIMEOUT_MS=60000

# 本地工作区。新手可不填，启动后直接在网页中选择。
# 工作区必须是已经存在的文件夹。
CONVERSATION_AGENT_WORKSPACE_ROOT=
# 启动时是否允许修改文件：1 允许，0 不允许。默认应保持 0。
CONVERSATION_AGENT_WORKSPACE_WRITE=0
# 启动时是否允许执行本地命令：1 允许，0 不允许。默认应保持 0。
CONVERSATION_AGENT_COMMAND_EXECUTION=0
# 单条本地命令超时毫秒数，允许范围 1000 至 120000。
CONVERSATION_AGENT_COMMAND_TIMEOUT_MS=30000
# 单次任务最多进行多少轮模型判断和工具调用，允许范围 1 至 30。
CONVERSATION_AGENT_MAX_STEPS=12

# 服务监听地址（默认只接受本机连接）
CONVERSATION_AGENT_HOST=127.0.0.1
CONVERSATION_AGENT_PORT=8890

# 仅当可信内网模型服务必须使用明文 HTTP 时设置为 1
CONVERSATION_AGENT_ALLOW_INSECURE_HTTP=0
`;
}

function agentReadmeSource(blueprint) {
  return `# ${blueprint.package.name} - 独立智能体

该目录是从完整 Codex 会话生成的可独立启动项目。它不是只会聊天的界面：服务端会向模型提供原对话检索、改进工作流以及受控的本地文件和命令工具。模型可以先回查用户纠正和实际工具证据，再根据工具结果持续决定下一步，直到完成任务或达到自动步骤上限。

能力包的完整能力、适用任务、三种交付形态、能力边界和验收方法见上一级目录的 \`README.md\`。同样内容会在独立界面顶部和“能力说明”标签页直接展示。

## 开始前需要准备什么

- **Node.js 18 或更高版本**：用于运行独立智能体服务。
- **一个可用的模型连接**：可以是在线模型的 OpenAI 兼容接口，也可以是已经启动的本地模型服务。
- **在线模型的密钥**：只有在线服务要求时才需要；本地模型通常可以留空。
- **一个本地工作区**：也就是允许人工智能查看和操作的现有项目文件夹。

能力包保存了原对话提取、改进工作流和操作界面，**不包含模型本身或模型权重**。不知道接口地址、模型名称或密钥时，请先查看所用模型服务的连接说明。

## 第一次启动（Windows）

1. 在文件资源管理器中打开当前 \`agent\` 目录。
2. 点击顶部地址栏，输入 \`powershell\` 并按回车，即可在当前目录打开终端。
3. 输入 \`node --version\`。能看到 \`v18\` 或更高版本即可继续；如提示找不到命令，请先安装 Node.js 18 或更高版本。
4. 输入 \`node agent-server.mjs\`。
5. **保持终端窗口开启**，浏览器打开终端显示的本地地址，默认通常是 \`http://127.0.0.1:8890/\`。

停止使用时，回到终端按 \`Ctrl+C\`。服务停止后网页会断开，本次通过网页填写的配置和内存密钥也会清除。

界面位于 \`ui/index.html\`，请通过 \`agent-server.mjs\` 启动后访问。直接双击 HTML 文件只显示静态页；模型调用需要后端服务。

## 第一次连接模型

页面左侧会显示四步进度。第一步先连接模型：

1. 选择“在线模型”或“本地模型”。
2. 填写“模型接口地址”。在线服务通常是 HTTPS 地址；本地服务通常是 \`http://127.0.0.1:端口/v1\`，并且需要先启动本地模型程序。
3. 保存接口后会自动读取“接口模型全量列表”；也可以点击“获取全部模型”。列表完整保留接口返回结果，可搜索并点击模型名称直接选用；仍可手动填写。
4. 在线服务需要时，粘贴 API 密钥。本地模型通常可以留空。
5. 点击“保存并检查连接”。只有实际连接成功后，“开始执行”按钮才会开放。

修改地址、模型或密钥后，页面会要求重新检查。连接失败时，页面会保留已填写内容，并给出“重新检查”或返回修改的处理提示。

## 本地执行能力：选择工作区和权限

模型连接成功后，继续在页面左侧完成第二步和第三步：

1. 在“本地工作区文件夹”中填写一个已经存在的文件夹，例如 \`C:\\项目\\我的应用\`。
2. 点击“保存工作区与权限”。即使不勾选任何开关，人工智能也可以在该工作区内浏览目录和读取 UTF-8 文本文件。
3. 需要创建或修改文件时，勾选“允许创建和修改文件”。文件工具仍然只能访问当前工作区。
4. 需要运行构建、测试或检查命令时，勾选“允许自动执行本地命令”。命令从工作区内启动，但使用当前 Windows 账户权限。
5. 设置“单条命令超时”和“最多自动步骤”，然后再次保存。

### 三个原对话工具分别做什么

这三个工具始终开放，只读取能力包自身的 \`conversation-extraction.json\`，不依赖工作区写入或命令权限：

| 工具 | 直白说明 |
| --- | --- |
| \`search_original_conversation\` | 按关键词搜索原用户消息、助手回应、工具、命令和文件变更 |
| \`get_original_conversation_stage\` | 读取指定需求阶段的完整提取内容和执行结果 |
| \`get_improved_workflow\` | 读取根据用户纠正生成的改进流程、验收标准和失败恢复规则 |

### 六个工作区工具分别做什么

| 工具 | 直白说明 | 开放条件 |
| --- | --- | --- |
| \`list_files\` | 列出工作区内的文件和目录 | 始终开放 |
| \`read_file\` | 按行读取工作区内的 UTF-8 文本文件 | 始终开放 |
| \`create_directory\` | 在工作区内创建目录 | 开启文件写入 |
| \`write_file\` | 在工作区内新建或完整覆盖文本文件 | 开启文件写入 |
| \`replace_text\` | 精确替换文件中的指定文本 | 开启文件写入 |
| \`execute_command\` | 执行 PowerShell 或 shell 命令，读取退出码和输出 | 开启命令执行 |

文件路径会经过工作区边界和链接目标检查。命令环境会移除名称包含 \`key\`、\`token\`、\`secret\`、\`password\`、\`credential\`、\`authorization\` 的环境变量，避免把模型密钥直接传给子进程。

## 开始执行任务

1. 需要回查旧方案并补强时选择“提取并改进原对话”；需要真正操作项目时选择“执行本地任务”；也可以选择“分析问题”“生成结果”或“检查内容”。
2. 点击一个示例任务，或输入自己的任务。
3. 点击“开始执行”。人工智能会自动携带当前对话历史、能力包工作流和当前本地工具权限。
4. 模型提出工具调用后，服务端会真实执行，并把结果送回模型。这个循环会持续到模型给出最终结果或达到步骤上限。
5. 对话中会显示每次工具调用的名称、参数、状态、耗时和结果。执行过程中可以点击“停止执行”。
6. 完成后可以“复制结果”或“下载 Markdown”。
7. 右侧“原对话提炼”页展示需求演进、用户纠正、旧方案不足、保留做法、改进流程和验收标准；“执行工作流”页用于核对通用步骤；“操作说明”页可以打开能力包的其他文件。

### 工具调用循环怎样工作

每一步都由模型先判断需要使用哪个工具，服务端真实执行该工具，再把文件内容、修改结果或命令输出交回模型。模型会依据新结果继续调用下一项工具，或在任务完成后给出最终答复；界面同步显示整个过程。

## 在线模型和本地模型的区别

| 连接方式 | 需要准备 | 常见地址 | 密钥 |
| --- | --- | --- | --- |
| 在线模型 | 网络、服务商提供的兼容接口和模型名 | \`https://服务地址/v1\` | 通常需要 |
| 本地模型 | 已启动的本地模型程序及兼容接口 | \`http://127.0.0.1:端口/v1\` | 通常不需要 |

选择“本地模型”只会帮你填写常用地址，不会自动安装或启动本地模型程序。

## 常见问题

| 现象 | 处理方法 |
| --- | --- |
| 终端提示找不到 \`node\` | 安装 Node.js 18 或更高版本，重新打开终端后再运行 \`node --version\`。 |
| 页面打不开 | 确认运行 \`node agent-server.mjs\` 的终端仍然开启，并使用终端实际显示的地址。 |
| 提示地址格式不正确 | 填写完整的 \`http://\` 或 \`https://\` 地址；兼容接口通常需要以 \`/v1\` 结尾。 |
| 本地模型连接失败 | 先启动本地模型程序，核对端口，再点击“重新检查”。 |
| 提示 401 或 403 | 重新粘贴完整密钥，并确认密钥有权访问所选模型。 |
| 提示 404 | 检查接口地址末尾是否需要 \`/v1\`。 |
| 获取不到模型 | 确认模型服务支持 OpenAI 兼容的 \`/models\` 接口，或手动填写正确模型名称。 |
| 模型响应超时 | 检查网络和服务状态，或在“高级设置”中延长最长等待时间。 |
| 提示工作区不存在 | 填写一个已经存在的本地文件夹，不要填写尚未创建的路径。 |
| 人工智能只能读文件 | 在“本地工作区与权限”中勾选“允许创建和修改文件”，然后保存。 |
| 人工智能不能运行命令 | 勾选“允许自动执行本地命令”，然后保存；只对可信任务开启。 |
| 达到自动步骤上限 | 缩小任务范围，或提高“最多自动步骤”，上限为 30。 |
| 8890 端口已占用 | 在 PowerShell 中运行 \`$env:PORT=8891; node agent-server.mjs\`，再打开终端显示的新地址。 |

## 隐私和密钥

通过网页提交的 API 密钥只保存在当前进程内存中，不会写入能力包文件、工作流、日志或接口响应；关闭服务后自动清除。界面不会回显已保存的密钥。

调用模型时，当前任务、对话历史以及 \`workflow-blueprint.json\` 中必要的工作流和改进摘要会发送到你配置的模型服务。只有模型主动调用原对话检索工具时，对应的原消息、工具证据或文件变更才会作为工具结果继续发送。使用在线模型前，请确认所提交的内容符合你对该服务的隐私要求。

本地文件内容和命令结果会在模型需要继续判断时发送给所配置的模型服务。文件读取和命令输出均有长度上限。文件工具限制在所选工作区内；命令执行使用当前系统账户，因此命令本身仍可能访问系统允许的其他位置。命令权限默认关闭，只应在理解任务和命令影响时开启。

\`.env.example\` 只是高级启动配置参考，程序不会自动读取，新手无需修改。真实密钥不要写入示例文件或提交到代码仓库。

## 高级启动配置

熟悉环境变量的用户可以参考 \`.env.example\`，在启动进程前由系统、终端或进程管理器注入配置。Node.js 不会自动读取 \`.env\` 文件。

## 目录说明

| 文件 | 用途 |
| --- | --- |
| \`agent-server.mjs\` | 独立人工智能服务、模型工具循环、本地文件与命令执行器、静态界面服务器 |
| \`ui/index.html\` | 可操作的中文独立界面 |
| \`ui/app.js\` | 模型配置、工作区权限、连续对话、工具执行轨迹和停止操作 |
| \`ai-profile.json\` | 人工智能能力、接口和运行配置清单 |
| \`workflow-blueprint.json\` | 从完整会话提取的工作流与证据上下文 |
| \`conversation-extraction.json\` | 原对话的需求演进、用户纠正、完整阶段消息、工具、命令、文件变更和改进规则 |
| \`.env.example\` | 环境变量配置示例 |

## 运行时接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | \`/api/runtime/health\` | 服务、能力包和模型配置状态 |
| GET | \`/api/runtime/config\` | 返回脱敏后的公开配置 |
| PUT | \`/api/runtime/config\` | 本机内存配置；可提交 \`baseUrl\`、\`apiKey\`、\`model\`、\`organization\`、\`project\`、\`timeoutMs\` |
| DELETE | \`/api/runtime/config\` | 恢复启动时的环境变量配置 |
| GET | \`/api/runtime/models\` | 代理上游兼容服务的模型列表 |
| GET | \`/api/runtime/context\` | 查看将注入模型的结构化工作流上下文 |
| GET | \`/api/runtime/distillation\` | 查看需求演进、纠正、不足、保留做法和改进流程 |
| POST | \`/api/runtime/conversation/search\` | 按关键词检索原对话中的消息、工具、命令和文件变更 |
| POST | \`/api/runtime/chat\` | 非流式或 SSE 流式对话 |
| GET | \`/api/runtime/workspace\` | 查看当前工作区和脱敏后的权限状态 |
| PUT | \`/api/runtime/workspace\` | 本机保存工作区、写入权限、命令权限、超时和步骤上限 |
| DELETE | \`/api/runtime/workspace\` | 恢复启动时的工作区配置 |
| GET | \`/api/runtime/tools\` | 查看当前真正开放给模型的本地工具定义 |
| POST | \`/api/runtime/agent\` | 运行模型与本地工具自动循环；支持自定义 SSE 工具轨迹 |

兼容别名为 \`/api/ai/status\`、\`/api/ai/config\`、\`/api/ai/models\`、\`/api/ai/context\`、\`/api/ai/distillation\`、\`/api/ai/conversation/search\`、\`/api/ai/chat\`、\`/api/ai/workspace\`、\`/api/ai/tools\`、\`/api/ai/agent\`。标准 OpenAI 兼容入口为 \`/v1/models\` 和 \`/v1/chat/completions\`。

## 对话请求

\`POST /api/runtime/chat\` 接受 OpenAI Chat Completions 的 \`messages\`、\`stream\`、\`tools\`、\`tool_choice\` 等常用字段。也可提交 \`objective\` 和可选的 \`inputs\`，服务会把它转换为用户消息。\`stream: true\` 时原样转发上游 SSE 数据流；否则返回上游 JSON，并附加 \`_conversationAgent\` 来源元数据。

独立界面使用 \`POST /api/runtime/agent\`。该接口由服务端提供固定的本地工具，不接受客户端覆盖工具定义。非流式响应会在 \`_conversationAgent.toolTrace\` 中返回完整工具轨迹；流式响应依次发送 \`status\`、\`tool_start\`、\`tool_result\`、\`assistant\` 和 \`done\` 事件。

所有接口错误均返回 \`error.code\`、中文 \`error.message\` 和 \`error.requestId\`。上游密钥不会出现在错误详情中。
`;
}

async function createAgent(packageRoot, blueprint) {
  const root = path.join(packageRoot, 'agent');
  const server = path.join(root, 'agent-server.mjs');
  const aiProfile = path.join(root, 'ai-profile.json');
  const readme = path.join(root, 'README.md');
  const envExample = path.join(root, '.env.example');
  const workflow = path.join(root, 'workflow-blueprint.json');
  const conversationExtraction = path.join(root, 'conversation-extraction.json');
  const ui = {
    index: path.join(root, 'ui', 'index.html'),
    app: path.join(root, 'ui', 'app.js'),
    styles: path.join(root, 'ui', 'styles.css'),
  };
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: `${blueprint.package.id}-agent`,
    private: true,
    version: '1.0.0',
    type: 'module',
    scripts: { start: 'node agent-server.mjs' },
  }, null, 2) + '\n');
  const [serverTemplate, htmlTemplate, appTemplate, stylesTemplate] = await Promise.all([
    fs.readFile(new URL('../templates/conversation-agent-server.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../templates/conversation-agent-ui/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../templates/conversation-agent-ui/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../templates/conversation-agent-ui/styles.css', import.meta.url), 'utf8'),
  ]);
  await writeFile(server, serverTemplate);
  await writeFile(aiProfile, JSON.stringify(agentAiProfile(blueprint), null, 2) + '\n');
  await writeFile(readme, agentReadmeSource(blueprint));
  await writeFile(envExample, agentEnvExampleSource());
  await writeFile(workflow, JSON.stringify(blueprint, null, 2) + '\n');
  await fs.copyFile(path.join(packageRoot, 'conversation-extraction.json'), conversationExtraction);
  await writeFile(ui.index, htmlTemplate);
  await writeFile(ui.app, appTemplate);
  await writeFile(ui.styles, stylesTemplate);
  return {
    root,
    server,
    aiProfile,
    readme,
    envExample,
    workflow,
    conversationExtraction,
    ui,
    startCommand: `node "${server}"`,
  };
}

async function sha256(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function collectArtifacts(root) {
  const result = {};
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.isFile()) {
        const relative = path.relative(root, filePath).split(path.sep).join('/');
        if (relative === 'package-manifest.json') continue;
        const stat = await fs.stat(filePath);
        result[relative] = { bytes: stat.size, sha256: await sha256(filePath) };
      }
    }
  }
  await visit(root);
  return result;
}

function manifestFor(blueprint, packageRoot, artifacts) {
  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    selection: blueprint.selection,
    package: {
      ...blueprint.package,
      root: packageRoot,
    },
    derivedWorkflow: blueprint.workflow,
    evidence: {
      userRequestStageCount: blueprint.evidence.userRequestStages.length,
      observedToolCount: blueprint.evidence.observedTools.length,
      implementationFileCount: blueprint.evidence.implementationFiles.length,
      extractedMessageCount: blueprint.distillation?.evidence?.messageCount || 0,
      extractedToolCallCount: blueprint.distillation?.evidence?.toolCallCount || 0,
      extractedCorrectionCount: blueprint.distillation?.evidence?.correctionCount || 0,
      extractedArtifactCount: blueprint.distillation?.evidence?.artifactCount || 0,
      evidenceFiles: blueprint.evidence.evidenceFiles,
    },
    delivery: blueprint.delivery,
    integrity: {
      algorithm: 'sha256',
      excludedFromCoverage: ['package-manifest.json'],
      artifacts,
    },
  };
}

function cleanSessionId(value) {
  const candidate = text(value).toLowerCase();
  return SESSION_ID_RE.test(candidate) ? candidate : null;
}

async function packageConversationLegacy({
  threadId,
  sourcePath,
  roots = [],
  packageId,
  packageName,
  targets = PACKAGE_TARGETS,
  scope = 'whole-session',
  includeEvidence = true,
  redact = true,
  outputRoot = CONVERSATION_PACKAGES_ROOT,
} = {}) {
  if (scope !== 'whole-session') throw new Error('封装范围固定为完整会话，需包含全部中间记录和需求阶段。');
  const selectedTargets = normaliseTargets(targets);
  const source = sourcePath
    ? await resolveSessionSource({ sourcePath })
    : await resolveSessionSource({ threadId, roots });
  const parsed = await parseCodexSessionFile(source.sourcePath, { redact });
  if (!parsed.sessionId && source.sessionId) parsed.sessionId = source.sessionId;
  const requestedSessionId = cleanSessionId(threadId);
  const actualSessionId = cleanSessionId(parsed.sessionId);
  if (requestedSessionId && actualSessionId && requestedSessionId !== actualSessionId) {
    throw new Error(`会话编号 ${requestedSessionId} 与所选源文件中的会话 ${actualSessionId} 不一致。`);
  }
  const analysis = analyseParsedSession(parsed, { includeEvidence: Boolean(includeEvidence) });
  const conversation = buildConversationIntelligence(analysis, parsed);
  const derivedIdentity = derivePackageIdentity(analysis, parsed.sessionId || source.sessionId);
  const packageKey = isGenericPackageId(packageId)
    ? derivedIdentity.id
    : normalisePackageId(packageId, parsed.sessionId || source.sessionId);
  const outputKey = `${packageKey}-${String(parsed.sessionId || 'source').slice(0, 8).toLowerCase()}-${Date.now()}`;
  const packageRoot = await ensurePackageDirectory(outputRoot, outputKey);
  const skillName = `${packageKey}-workflow`.slice(0, 63).replace(/-+$/g, '');
  const customName = !isGenericPackageName(packageName) ? normaliseName(packageName, derivedIdentity.name) : '';
  const name = customName || derivedIdentity.name;
  const naming = customName
    ? { ...derivedIdentity.naming, mode: '会话内容与实际工具自动命名（人工名称覆盖）', overriddenName: customName }
    : derivedIdentity.naming;
  const evidence = await writeAnalysisArtifacts(parsed, analysis, path.join(packageRoot, 'evidence'));
  const blueprint = makeWorkflowBlueprint(analysis, conversation, {
    packageId: packageKey,
    packageName: name,
    skillName,
    targets: selectedTargets,
    redacted: redact !== false,
    naming,
  });
  conversation.extraction.distillation = blueprint.distillation;
  await writeFile(path.join(packageRoot, 'conversation-extraction.json'), JSON.stringify(conversation.extraction, null, 2) + '\n');
  await writeFile(path.join(packageRoot, 'workflow-blueprint.json'), JSON.stringify(blueprint, null, 2) + '\n');
  const delivery = {
    evidence: evidence.paths,
    skill: selectedTargets.includes('skill') ? await createSkill(packageRoot, blueprint, skillName) : null,
    mcp: selectedTargets.includes('mcp') ? await createMcp(packageRoot, blueprint) : null,
    agent: selectedTargets.includes('agent') ? await createAgent(packageRoot, blueprint) : null,
  };
  const guide = path.join(packageRoot, blueprint.delivery.guideFile);
  await writeFile(guide, buildPackageGuide(blueprint, skillName));
  delivery.guide = guide;
  await writeFile(path.join(packageRoot, 'verify.mjs'), `import crypto from 'node:crypto';\nimport fs from 'node:fs/promises';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n\nconst root = path.dirname(fileURLToPath(import.meta.url));\nconst manifest = JSON.parse(await fs.readFile(path.join(root, 'package-manifest.json'), 'utf8'));\nconst failures = [];\nfor (const [relative, expected] of Object.entries(manifest.integrity.artifacts)) {\n  const filePath = path.join(root, ...relative.split('/'));\n  try {\n    const data = await fs.readFile(filePath);\n    const actual = crypto.createHash('sha256').update(data).digest('hex');\n    if (actual !== expected.sha256 || data.length !== expected.bytes) failures.push(relative);\n  } catch { failures.push(relative); }\n}\nif (manifest.selection.mode !== 'whole-session') failures.push('selection.mode');\nif (!manifest.selection.sourceSha256 || !manifest.selection.recordCount) failures.push('selection anchor');\nif (failures.length) { process.stderr.write('能力包校验失败：' + failures.join('、') + '\\n'); process.exitCode = 1; }\nelse process.stdout.write('能力包校验通过：' + Object.keys(manifest.integrity.artifacts).length + ' 个文件，完整会话选择锚点有效。\\n');\n`);
  const artifacts = await collectArtifacts(packageRoot);
  const manifest = manifestFor(blueprint, packageRoot, artifacts);
  const manifestPath = path.join(packageRoot, 'package-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return {
    package: {
      id: packageKey,
      name,
      root: packageRoot,
      manifest: manifestPath,
      selection: blueprint.selection,
      naming,
      delivery,
    },
    analysis,
    verification: {
      status: 'generated',
      artifactCount: Object.keys(artifacts).length,
      checks: [
        '完整会话范围已记录为第 1 至最后一条原始记录。',
        '来源 SHA-256、记录数和标准化事件数量已写入能力包清单。',
        '所有生成文件均已写入 SHA-256 完整性清单。',
      ],
    },
  };
}

async function verifyConversationPackageLegacy(packageRoot) {
  const root = path.resolve(packageRoot);
  const manifestPath = path.join(root, 'package-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const failures = [];
  for (const [relative, expected] of Object.entries(manifest.integrity?.artifacts || {})) {
    const filePath = path.resolve(root, ...relative.split('/'));
    const check = path.relative(root, filePath);
    if (check.startsWith('..') || path.isAbsolute(check)) {
      failures.push({ relative, reason: '路径超出能力包根目录' });
      continue;
    }
    try {
      const data = await fs.readFile(filePath);
      const actual = crypto.createHash('sha256').update(data).digest('hex');
      if (actual !== expected.sha256 || data.length !== expected.bytes) failures.push({ relative, reason: '哈希或文件大小不匹配' });
    } catch {
      failures.push({ relative, reason: '文件缺失或读取失败' });
    }
  }
  if (manifest.selection?.mode !== 'whole-session') failures.push({ relative: 'selection.mode', reason: '不是完整会话范围' });
  return { ok: failures.length === 0, manifest, failures, checkedArtifacts: Object.keys(manifest.integrity?.artifacts || {}).length };
}

export async function packageConversation(options = {}) {
  return packageConversationV2(options);
}

export async function verifyConversationPackage(packageRoot) {
  return verifyConversationPackageV2(packageRoot);
}

export { packageConversationLegacy, verifyConversationPackageLegacy };
