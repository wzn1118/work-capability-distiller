import { enforceSemanticDistillation } from './semantic-distillation-v2.mjs';

function text(value, fallback = '', maximum = 1000) {
  const result = String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  return (result || fallback).slice(0, maximum);
}

const MAX_PHASES = 48;

function list(values, maximum = 12) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => text(value)).filter(Boolean))].slice(0, maximum);
}

function pick(value, fallback, maximum = 1000) {
  return text(value, fallback, maximum);
}

function contains(corpus, pattern) {
  return pattern.test(corpus);
}

const VISUAL_FAMILIES = {
  'engineering-console': {
    label: '工程诊断台', accent: '#136f63', accentStrong: '#0d4f47', accentSoft: '#e0f2ee', contrast: '#d0573b', surface: '#f8fbfa',
    description: '围绕工作区诊断、真实文件变更、命令输出、Git 差异和验证闭环组织。',
  },
  'research-studio': {
    label: '证据研究室', accent: '#006d77', accentStrong: '#0b525b', accentSoft: '#e3f2f1', contrast: '#d96045', surface: '#fbfcfa',
    description: '围绕研究问题、来源材料、证据矩阵、判断依据和洞察交付组织。',
  },
  'data-lab': {
    label: '数据管线台', accent: '#18794e', accentStrong: '#125d3c', accentSoft: '#e5f4ea', contrast: '#b45309', surface: '#f9fcfa',
    description: '围绕数据集、字段口径、处理管线、质量检查和结果表组织。',
  },
  'document-studio': {
    label: '文档交付室', accent: '#a23e48', accentStrong: '#7d2e38', accentSoft: '#f7e8ea', contrast: '#1f6f78', surface: '#fdfbfb',
    description: '围绕原始材料、内容结构、版式预览、导出文件和交付验收组织。',
  },
  'content-operations': {
    label: '内容运营中枢', accent: '#b34b32', accentStrong: '#863521', accentSoft: '#f8e9e4', contrast: '#007f73', surface: '#fdfbf9',
    description: '围绕内容对象、受众信号、传播机会、行动建议和业务交付组织。',
  },
  'automation-control': {
    label: '自动化控制台', accent: '#5d5fef', accentStrong: '#4042b7', accentSoft: '#ececff', contrast: '#008b72', surface: '#fafaff',
    description: '围绕触发条件、任务编排、批量运行、异常处理和运行记录组织。',
  },
  'workflow-desk': {
    label: '专属任务台', accent: '#155e75', accentStrong: '#164e63', accentSoft: '#e6f4f8', contrast: '#b45309', surface: '#fbfcfc',
    description: '围绕当前目标、必要输入、执行步骤、交付物和验收依据组织。',
  },
};

const CHARACTERISTIC_RULES = {
  'engineering-console': [
    ['性能与卡顿', /性能|卡顿|耗时|启动慢|内存|崩溃|profil(?:e|ing)/gi, 6],
    ['诊断与修复', /诊断|修复|排错|调试|debug|bug|补丁|patch/gi, 5],
    ['代码与项目', /代码|源码|项目|工程|仓库|模块|依赖|codebase|repository/gi, 4],
    ['命令与验证', /命令|终端|构建|测试|验收|git|build|test|lint/gi, 4],
    ['文件变更', /文件|目录|写入|修改|差异|diff/gi, 2],
  ],
  'research-studio': [
    ['研究问题', /研究问题|调研|研究|假设|访谈|问卷|research/gi, 5],
    ['证据推理', /证据链|证据矩阵|来源|事实与推断|置信度|evidence/gi, 4],
    ['洞察归纳', /洞察|主题归纳|语境|扎根|编码|insight/gi, 4],
    ['一般分析', /分析|判断|解释|analysis/gi, 1],
  ],
  'data-lab': [
    ['结构化数据', /数据集|数据库|数据表|表格|csv|xlsx|excel|sql|dataset/gi, 6],
    ['统计与指标', /指标|统计|分层|聚合|透视|分布|口径|metric/gi, 4],
    ['数据质量', /清洗|去重|缺失值|异常值|校验|质量检查/gi, 4],
    ['一般数据', /数据|字段|样本/gi, 1],
  ],
  'document-studio': [
    ['演示文稿', /pptx?|演示文稿|幻灯片|presentation|slide/gi, 7],
    ['办公文档', /docx?|word|pdf|文档|报告|汇报稿/gi, 4],
    ['版式与渲染', /排版|版式|页面|视觉层级|渲染|导出|预览/gi, 5],
    ['内容重构', /重组|融合|改写|章节|目录|结构化交付/gi, 3],
  ],
  'content-operations': [
    ['内容平台', /抖音|小红书|视频号|社媒|短视频|内容平台/gi, 6],
    ['受众与营销', /受众|粉丝|营销|品牌|传播|转化|人群|campaign/gi, 5],
    ['评论与内容', /评论|视频|内容表现|热词|争议点/gi, 4],
    ['业务行动', /机会|建议|策略|行动|运营/gi, 2],
  ],
  'automation-control': [
    ['流程编排', /自动化|编排|工作流|workflow|pipeline|orchestrat/gi, 5],
    ['批量与触发', /批量|定时|触发器|调度|队列|webhook|schedule/gi, 5],
    ['服务集成', /接口|api|mcp|集成|同步|代理|服务/gi, 3],
    ['运行治理', /重试|恢复|任务状态|运行记录|失败处理/gi, 3],
  ],
};

const CHARACTERISTIC_COMBINATIONS = {
  'engineering-console': [
    ['性能问题与修复闭环', [/性能|卡顿|耗时|启动慢|崩溃/i, /诊断|修复|排错|调试|补丁/i], 14],
    ['项目变更与命令验证', [/代码|源码|项目|工程|仓库|文件/i, /命令|构建|测试|验收|git|diff/i], 10],
  ],
  'research-studio': [
    ['研究问题与证据推理', [/研究|调研|假设|访谈|问卷/i, /证据|来源|事实与推断|置信度/i], 12],
  ],
  'data-lab': [
    ['结构化数据质量闭环', [/数据集|数据表|表格|csv|xlsx|excel|sql/i, /清洗|去重|缺失值|异常值|质量检查/i], 9],
  ],
  'document-studio': [
    ['文档对象与交付闭环', [/pptx?|演示文稿|幻灯片|docx?|word|pdf|报告/i, /排版|版式|渲染|导出|预览|交付/i], 14],
  ],
  'content-operations': [
    ['内容对象与业务目标', [/评论|视频|短视频|抖音|小红书|内容平台/i, /受众|粉丝|营销|品牌|传播|转化|人群/i], 18],
    ['内容证据与行动交付', [/评论|视频|内容表现|热词|争议点/i, /洞察|报告|策略|机会|建议|行动/i], 9],
  ],
  'automation-control': [
    ['流程编排与运行治理', [/自动化|编排|工作流|workflow|pipeline/i, /批量|触发器|调度|队列|重试|恢复|运行记录/i], 13],
  ],
};

function characteristicScore(corpus, rules) {
  const signals = [];
  let score = 0;
  for (const [label, pattern, weight] of rules) {
    pattern.lastIndex = 0;
    const count = Math.min((String(corpus).match(pattern) || []).length, 8);
    if (!count) continue;
    const points = weight * (1 + Math.log2(count));
    score += points;
    signals.push({ label, count, points: Math.round(points * 10) / 10 });
  }
  return { score: Math.round(score * 10) / 10, signals };
}

function visualFor(corpus) {
  const evaluated = Object.entries(CHARACTERISTIC_RULES).map(([family, rules]) => {
    const base = characteristicScore(corpus, rules);
    const combinationSignals = [];
    let combinationScore = 0;
    for (const [label, patterns, points] of CHARACTERISTIC_COMBINATIONS[family] || []) {
      if (!patterns.every((pattern) => pattern.test(corpus))) continue;
      combinationScore += points;
      combinationSignals.push({ label, count: 1, points });
    }
    return {
      family,
      score: Math.round((base.score + combinationScore) * 10) / 10,
      signals: [...combinationSignals, ...base.signals],
    };
  });
  evaluated.sort((left, right) => right.score - left.score || left.family.localeCompare(right.family));
  const primary = evaluated[0];
  const secondary = evaluated[1];
  const family = primary?.score >= 7 ? primary.family : 'workflow-desk';
  const definition = VISUAL_FAMILIES[family];
  const total = Math.max(1, evaluated.reduce((sum, item) => sum + item.score, 0));
  return {
    family,
    ...definition,
    confidence: family === 'workflow-desk' ? 0.55 : Math.min(0.98, Math.max(0.6, primary.score / total + 0.38)),
    signals: (primary?.signals || []).slice(0, 4),
    scores: Object.fromEntries(evaluated.map((item) => [item.family, item.score])),
    secondaryFamily: secondary?.score >= Math.max(7, (primary?.score || 0) * 0.62) ? secondary.family : null,
    rationale: primary?.signals?.length
      ? `根据${primary.signals.slice(0, 3).map((item) => `${item.label}（${item.count} 处）`).join('、')}识别为${definition.label}。`
      : '当前证据未形成明显领域倾向，使用通用专属任务台。',
  };
}

function stageText(stage) {
  return [stage?.title, stage?.request, ...(stage?.assistantMessages || []).slice(-1).map((message) => message.text)].join('\n');
}

function firstUseful(values, fallback) {
  return list(values, 1)[0] || fallback;
}

function phaseTitle(stage, fallbackIndex) {
  const index = Number(stage?.index) || fallbackIndex;
  const title = pick(stage?.title, `P${index}｜会话目标梳理`, 160);
  return /^P\d+\s*[｜:：]/.test(title) ? title : `P${index}｜${title}`;
}

function cleanBrief(value, fallback, maximum = 360) {
  return pick(value, fallback, maximum).replace(/^#{1,6}\s*/gm, '').replace(/\s+/g, ' ').trim();
}

function stageEvidence(stage, fallbackIndex) {
  const toolNames = list((stage?.toolCalls || []).map((item) => item.name), 6);
  const filePaths = list((stage?.fileChanges || []).map((item) => item.path), 4);
  const toolCount = Number(stage?.outcome?.toolCallCount) || (stage?.toolCalls || []).length || 0;
  const sourceTitles = list(stage?.sourceTitles, 3);
  const originalStageIndexes = list(stage?.originalStageIndexes, 8).map((value) => Number(value)).filter(Number.isFinite);
  const sourceLabel = sourceTitles.length ? `来源会话“${sourceTitles.join('、')}”的 ` : '原会话 ';
  const parts = [`${sourceLabel}${phaseTitle(stage, fallbackIndex)}`];
  if (originalStageIndexes.length > 1) parts.push(`已合并重复原始阶段：${originalStageIndexes.map((value) => `P${value}`).join('、')}`);
  if (toolCount) parts.push(`记录 ${toolCount} 次工具调用${toolNames.length ? `（${toolNames.join('、')}）` : ''}`);
  if (filePaths.length) parts.push(`关联文件：${filePaths.join('、')}`);
  return parts.join('；');
}

function stageApproach(stage, corpus, fallbackIndex) {
  const source = stageText(stage).trim() || corpus;
  const prefix = `先回查 ${phaseTitle(stage, fallbackIndex)} 的原始要求、实际工具轨迹和后续纠正`;
  if (contains(source, /评论|视频|玩家|受众|营销|洞察|分析|研究/i)) {
    return `${prefix}，再按研究问题整理素材、区分事实与推断、形成带来源的分析结论。`;
  }
  if (contains(source, /报告|演示|汇报|文档|ppt|方案/i)) {
    return `${prefix}，再拆分现有材料的结构与证据，重组内容并核对交付格式。`;
  }
  if (contains(source, /代码|项目|文件|命令|测试|补丁|git|接口|服务/i)) {
    return `${prefix}，读取工作区和项目规则，创建检查点后实施文件或命令变更，最后运行验证。`;
  }
  return `${prefix}，补齐当前输入，按已确认的步骤执行，并将结果与原会话目标逐项核对。`;
}

function stageDeliverable(stage, corpus, fallbackIndex) {
  const source = stageText(stage).trim() || corpus;
  const filePaths = list((stage?.fileChanges || []).map((item) => item.path), 3);
  if (filePaths.length) return `可审查的文件变更、差异说明与验证记录（关联：${filePaths.join('、')}）。`;
  if (contains(source, /报告|演示|汇报|文档|ppt|方案/i)) return '可直接使用的结构化交付稿，包含内容结构、证据依据和需要确认的缺口。';
  if (contains(source, /评论|视频|玩家|受众|营销|洞察|分析|研究/i)) return '带证据来源的洞察结果、主题归纳、判断依据和可执行建议。';
  if (contains(source, /代码|项目|文件|命令|测试|补丁|git|接口|服务/i)) return '真实本地修改、命令输出、验收结论和可恢复检查点。';
  return `${phaseTitle(stage, fallbackIndex)} 对应的可复核结果、执行记录与下一步建议。`;
}

function phaseName(value, fallback = '会话专属能力') {
  return cleanBrief(value, fallback, 180).replace(/^P\d+\s*[｜:：]\s*/, '').trim() || fallback;
}

function stageCapabilityTitle(stage, corpus, fallbackIndex) {
  const title = phaseName(phaseTitle(stage, fallbackIndex));
  const source = stageText(stage).trim() || corpus;
  const tooBroad = /^(全量洞察|深度分析|内容分析|数据分析|需求梳理|任务执行|继续完成|升级报告|生成报告|根级重建|能力重建|能力升级|全面升级|系统升级|会话升级|改进原对话)$/i.test(title);
  if (!tooBroad && title.length >= 4) return title;
  if (contains(source, /评论/) && contains(source, /视频/)) return '评论与视频数据全量洞察';
  if (contains(source, /玩家/) && contains(source, /语境|扎根|编码/)) return '玩家语境与扎根分析';
  if (contains(source, /营销|粉丝|受众/)) return '营销、粉丝与受众量化';
  if (contains(source, /报告|演示|汇报|文档|ppt/)) return '洞察报告生成与升级';
  if (contains(source, /skill|mcp|agent|能力包|接口|封装/)) return '可复用工作流与能力包封装';
  if (contains(source, /代码|项目|文件|命令|测试|补丁|git/)) return '工程改造、命令执行与验证';
  return title;
}

function stageExpertiseDomain(stage, corpus, capability = '') {
  const title = `${capability}\n${phaseName(phaseTitle(stage, 0), '')}`;
  const source = stageText(stage).trim() || corpus;
  if (contains(title, /skill|mcp|agent|能力包|服务接口|工作流封装/i)) return 'packaging';
  if (contains(title, /验证|验收|修复|恢复|续跑|测试|检查点/i)) return 'verification';
  if (contains(title, /报告|演示|汇报|文档|ppt|交付升级|证据密度/i)) return 'report';
  if (contains(title, /营销|粉丝|受众|传播|转化/i)) return 'marketing';
  if (contains(title, /玩家|语境|扎根|编码/i)) return 'player-context';
  if (contains(title, /评论|视频|内容反馈|全量数据|数据洞察/i)) return 'content-data';
  if (contains(title, /代码|项目|文件|命令|补丁|git|工程/i)) return 'engineering';
  if (contains(source, /skill|mcp|agent|能力包|服务接口|工作流封装/i)) return 'packaging';
  if (contains(source, /验证|验收|修复|恢复|续跑|测试|检查点/i)) return 'verification';
  if (contains(source, /报告|演示|汇报|文档|ppt|交付升级|证据密度/i)) return 'report';
  if (contains(source, /营销|粉丝|受众|传播|转化/i)) return 'marketing';
  if (contains(source, /玩家/) && contains(source, /语境|扎根|编码/)) return 'player-context';
  if (contains(source, /评论/) && contains(source, /视频|内容|数据/)) return 'content-data';
  if (contains(source, /代码|项目|文件|命令|补丁|git|工程/i)) return 'engineering';
  return 'general';
}

function stageWhenToUse(stage, corpus, fallbackIndex, capability) {
  const trigger = cleanBrief(stage?.request, `${phaseTitle(stage, fallbackIndex)} 的原会话要求。`, 280);
  const domain = stageExpertiseDomain(stage, corpus, capability);
  if (domain === 'content-data') {
    return `当需要把评论、视频或内容反馈转成可追溯的主题、情绪、争议点和洞察时使用。原会话触发：${trigger}`;
  }
  if (domain === 'player-context') {
    return `当需要理解玩家表达、社区语境或将开放文本归纳为主题时使用。原会话触发：${trigger}`;
  }
  if (domain === 'marketing') {
    return `当需要把内容信号转成受众结构、需求动机、传播机会与营销动作时使用。原会话触发：${trigger}`;
  }
  if (domain === 'report') {
    return `当需要基于已有材料重构、补强或产出可审查的报告、演示或文档时使用。原会话触发：${trigger}`;
  }
  if (domain === 'packaging') {
    return `当需要把已验证的会话做法封装为可安装 Skill、可连接服务或独立界面时使用。原会话触发：${trigger}`;
  }
  if (domain === 'verification') {
    return `当需要继续执行、修复问题、运行验证或确认最终交付是否达到原会话标准时使用。原会话触发：${trigger}`;
  }
  if (domain === 'engineering') {
    return `当需要在本地项目中检查、修改文件、执行命令并留下验收记录时使用。原会话触发：${trigger}`;
  }
  return `当需要继续完成“${capability}”，并继承本会话的输入、交付标准与后续纠正时使用。原会话触发：${trigger}`;
}

function stageExecutionMethod(stage, corpus, fallbackIndex, capability) {
  const toolNames = list((stage?.toolCalls || []).map((item) => item.name), 5);
  const evidenceStep = toolNames.length
    ? `回查 P${fallbackIndex} 的原话及 ${toolNames.join('、')} 工具轨迹`
    : `回查 P${fallbackIndex} 的原话、助手产出和后续纠正`;
  const domain = stageExpertiseDomain(stage, corpus, capability);
  if (domain === 'content-data') {
    return `${evidenceStep} → 汇总评论与视频素材，按主题、情绪、争议和内容表现分层 → 标注证据来源并输出 ${capability} 结论`;
  }
  if (domain === 'player-context') {
    return `${evidenceStep} → 提取玩家表达，开放编码并归并主题 → 用原始语境解释主题、分歧和不确定项`;
  }
  if (domain === 'marketing') {
    return `${evidenceStep} → 定义营销问题与受众口径 → 量化内容信号、需求动机和传播机会 → 给出可执行动作及风险依据`;
  }
  if (domain === 'report') {
    return `${evidenceStep} → 比对现有材料、证据和目标结构 → 重组内容并补齐关键缺口 → 渲染或核对交付格式后给出验收结果`;
  }
  if (domain === 'packaging') {
    return `${evidenceStep} → 提炼重复出现的目标、输入、工具和交付契约 → 生成可安装能力定义、服务接口和独立界面 → 校验文件、启动入口与会话证据链接`;
  }
  if (domain === 'verification') {
    return `${evidenceStep} → 复现当前状态并定位未满足项 → 执行必要修复、命令或文件变更 → 运行验证并记录通过项、剩余问题与恢复路径`;
  }
  if (domain === 'engineering') {
    return `${evidenceStep} → 检查工作区、项目规则和当前差异 → 创建检查点后修改文件或执行命令 → 运行测试/构建并记录验证与恢复信息`;
  }
  return `${evidenceStep} → 补齐“${capability}”所需输入并按已确认步骤执行 → 将结果与该阶段的交付标准逐项核对`;
}

function deriveSpecializations(extraction, corpus) {
  return (extraction.stages || []).slice(0, MAX_PHASES).map((stage, index) => {
    const stageIndex = Number(stage?.index) || index + 1;
    const title = phaseTitle(stage, stageIndex);
    const goal = cleanBrief(stage?.request, `${title} 的原会话目标。`, 420);
    return {
      id: `phase-p${stageIndex}`,
      phase: `P${stageIndex}`,
      title,
      goal,
      approach: stageApproach(stage, corpus, stageIndex),
      deliverable: stageDeliverable(stage, corpus, stageIndex),
      evidence: stageEvidence(stage, stageIndex),
      action: `执行 ${title.replace(/^P\d+\s*[｜:：]\s*/, '').slice(0, 28) || `P${stageIndex}`}`,
      sourceStages: [stageIndex],
      originalStageIndexes: Array.isArray(stage?.originalStageIndexes) && stage.originalStageIndexes.length
        ? stage.originalStageIndexes.map(Number).filter(Number.isFinite)
        : [stageIndex],
    };
  });
}

function deriveExpertise(extraction, corpus, specializations) {
  const stages = new Map((extraction.stages || []).map((stage, index) => [Number(stage?.index) || index + 1, stage]));
  return specializations.slice(0, MAX_PHASES).map((item, index) => {
    const stageIndex = Number(item?.sourceStages?.[0]) || Number(String(item?.phase || '').replace(/\D/g, '')) || index + 1;
    const stage = stages.get(stageIndex) || {};
    const capability = stageCapabilityTitle(stage, corpus, stageIndex);
    return {
      id: `expertise-p${stageIndex}`,
      phase: `P${stageIndex}`,
      capability,
      whenToUse: stageWhenToUse(stage, corpus, stageIndex, capability),
      executionMethod: stageExecutionMethod(stage, corpus, stageIndex, capability),
      deliverable: item.deliverable,
      evidence: item.evidence,
      action: item.action,
      sourceStages: item.sourceStages?.length ? item.sourceStages : [stageIndex],
      originalStageIndexes: item.originalStageIndexes?.length ? item.originalStageIndexes : [stageIndex],
    };
  });
}

function specializationToCapability(item) {
  return {
    id: item.id,
    title: item.title,
    description: `目标：${item.goal}\n做法：${item.approach}\n预期交付：${item.deliverable}`,
    action: item.action,
    sourceStages: item.sourceStages,
    originalStageIndexes: item.originalStageIndexes,
  };
}

function deriveInputs(extraction, corpus) {
  const inputs = [];
  const requests = (extraction.stages || []).map((stage) => stage.request).join('\n');
  const add = (id, label, help, type = 'textarea', required = true) => {
    if (!inputs.some((item) => item.id === id)) inputs.push({ id, label, help, type, required });
  };
  if (contains(`${corpus}\n${requests}`, /评论|comment/i)) add('comments', '评论或反馈材料', '粘贴评论明细、导出文件路径或已有整理结果。');
  if (contains(`${corpus}\n${requests}`, /视频|video/i)) add('videos', '视频或内容素材', '提供视频摘要、链接说明、脚本或内容清单。');
  if (contains(`${corpus}\n${requests}`, /研究问题|问题|洞察|分析|受众|营销|玩家|语境/i)) add('question', '要回答的问题', '说明想理解的人群、内容、业务问题或判断标准。');
  if (contains(`${corpus}\n${requests}`, /报告|文档|交付|汇报/i)) add('reference', '已有报告或参考模板', '可选：上传既有报告、模板或希望保留的结构。', 'textarea', false);
  if (contains(`${corpus}\n${requests}`, /代码|项目|文件|命令|测试|补丁|git/i)) add('workspace', '项目文件夹', '选择要检查、修改或验证的本地项目目录。', 'path');
  if (!inputs.length) add('task', '当前任务与已有材料', '描述现在要完成什么，并粘贴或附上可用材料。');
  return inputs.slice(0, 5);
}

function deriveCapabilities(extraction, identity, corpus, specializations = []) {
  if (specializations.length) return specializations.slice(0, 10).map(specializationToCapability);
  const capabilities = [];
  const add = (id, title, description, action, sourceStages = []) => {
    if (!capabilities.some((item) => item.id === id)) capabilities.push({ id, title, description, action, sourceStages });
  };
  if (contains(corpus, /评论|视频|玩家|受众|营销|洞察|分析/i)) {
    add('organize-evidence', '整理会话与素材证据', '将原对话要求、评论、视频和已有材料按研究问题归档，保留来源与缺口。', '整理素材', [1]);
    add('derive-insights', '形成可追溯的洞察', '结合会话中已确认的分析口径，输出主题、玩家语境、受众或营销判断，并说明证据来源。', '生成洞察', [2]);
    add('upgrade-delivery', '升级最终交付物', '把证据、结论、建议和修正要求整合为可复核的报告或内容交付。', '生成交付物', [3]);
  }
  if (contains(corpus, /代码|项目|文件|命令|测试|补丁|git/i)) {
    add('inspect-project', '理解当前项目', '读取项目结构、现有规则和 Git 状态，再确定需要修改的文件。', '检查项目', [1]);
    add('implement-change', '实施真实修改', '按最新要求创建检查点、修改文件或应用补丁，并记录变更。', '开始修改', [2]);
    add('verify-result', '运行验收与恢复', '执行适合项目的测试、构建或校验；失败时保留证据并可恢复。', '运行验证', [3]);
  }
  if (!capabilities.length) {
    add('read-context', '读取完整上下文', '回查目标、约束、已有产出与后续修正，避免按过时要求执行。', '读取上下文', [1]);
    add('execute-workflow', '执行专属工作流', `按“${identity.name}”的会话证据完成当前任务。`, '开始执行', [2]);
    add('verify-delivery', '核对交付结果', '将实际产出与会话中确认的验收要求逐项核对。', '核对交付', [3]);
  }
  return capabilities.slice(0, 6);
}

function deriveDeliverables(extraction, corpus, specializations = []) {
  if (specializations.length) {
    return specializations.slice(0, 8).map((item) => ({
      title: `${item.phase}｜${item.title.replace(/^P\d+\s*[｜:：]\s*/, '')}`,
      description: item.deliverable,
    }));
  }
  const items = [];
  const add = (title, description) => {
    if (!items.some((item) => item.title === title)) items.push({ title, description });
  };
  if (contains(corpus, /报告|洞察|分析|评论|视频|玩家|营销|受众/i)) {
    add('洞察与证据摘要', '按主题、证据和不确定项组织的可复核结论。');
    add('可用交付稿', '可直接用于汇报、报告或内容规划的结构化初稿。');
  }
  if (contains(corpus, /代码|文件|补丁|命令|测试|验证/i)) {
    add('可审查的文件修改', '带路径、差异、检查点和变更记录的真实本地修改。');
    add('验证记录', '命令、退出码、输出摘要和未通过项。');
  }
  if (!items.length) add('可追溯的任务结果', '包含执行过程、产出、验证和可恢复信息。');
  return items.slice(0, 4);
}

function deriveNavigation(visual) {
  if (visual.family === 'research-studio') {
    return { execute: '研究工作台', features: '能力与交付', alignment: '执行范围', evidence: '对话依据', history: '工作记录', guide: '使用说明' };
  }
  if (visual.family === 'data-lab') {
    return { execute: '数据管线', features: '处理能力', alignment: '执行范围', evidence: '口径与依据', history: '运行记录', guide: '使用说明' };
  }
  if (visual.family === 'engineering-console') {
    return { execute: '诊断与修复', features: '工程工具', alignment: '执行边界', evidence: '需求依据', history: '运行记录', guide: '操作手册' };
  }
  if (visual.family === 'document-studio') {
    return { execute: '文档制作', features: '交付能力', alignment: '导出范围', evidence: '素材依据', history: '版本记录', guide: '交付说明' };
  }
  if (visual.family === 'content-operations') {
    return { execute: '内容任务', features: '运营能力', alignment: '执行范围', evidence: '内容证据', history: '任务记录', guide: '使用说明' };
  }
  if (visual.family === 'automation-control') {
    return { execute: '流程控制', features: '节点能力', alignment: '运行边界', evidence: '触发依据', history: '运行日志', guide: '编排说明' };
  }
  return { execute: '专属任务', features: '能力与交付', alignment: '执行范围', evidence: '对话依据', history: '任务记录', guide: '使用说明' };
}

const EXPERIENCE_DEFINITIONS = {
  'engineering-console': {
    layout: 'diagnostic-split', density: 'compact', eyebrow: '工程诊断与修复',
    taskTitle: '描述故障、目标或需要修改的工程项', primaryLabel: '开始诊断并执行',
    taskModes: ['诊断并修复', '复现并验证', '自由工程任务'],
    modules: [
      ['workspace', '工作区快照', '先读取项目规则、目录、依赖和 Git 状态。', '输入'],
      ['diagnosis', '问题诊断', '定位复现条件、影响范围和根因证据。', '判断'],
      ['change-plan', '变更计划', '明确要修改的文件、命令和恢复点。', '计划'],
      ['terminal', '命令与差异', '实时展示命令输出、文件差异和长期进程。', '执行'],
      ['verification', '测试与验收', '运行测试或构建，输出通过项和剩余问题。', '结果'],
    ],
    navigationOrder: ['execute', 'knowledge', 'evidence', 'history', 'features', 'alignment', 'distillation', 'guide'],
    resultLabels: { result: '诊断与修复结论', changes: '文件差异', verification: '命令与测试', processes: '开发服务', checkpoints: '恢复检查点' },
  },
  'research-studio': {
    layout: 'evidence-canvas', density: 'comfortable', eyebrow: '研究问题与证据链',
    taskTitle: '写下要回答的研究问题', primaryLabel: '开始证据研究',
    taskModes: ['基于证据研究', '复核原结论', '自由研究任务'],
    modules: [
      ['question', '研究问题', '先定义对象、范围、判断标准和未知项。', '问题'],
      ['sources', '来源材料', '归集会话、文件、网页和已有产物并标注来源。', '材料'],
      ['evidence', '证据矩阵', '区分事实、推断、冲突证据和待补证问题。', '分析'],
      ['findings', '洞察与判断', '形成可追溯结论，并标明置信度。', '结论'],
      ['delivery', '研究交付', '输出报告、建议和可复核的证据索引。', '交付'],
    ],
    navigationOrder: ['execute', 'distillation', 'evidence', 'knowledge', 'features', 'history', 'alignment', 'guide'],
    resultLabels: { result: '研究结论', changes: '新增与更新材料', verification: '证据核验', processes: '持续采集任务', checkpoints: '研究快照' },
  },
  'data-lab': {
    layout: 'pipeline-board', density: 'compact', eyebrow: '数据处理与质量控制',
    taskTitle: '选择数据并说明要得到的结果', primaryLabel: '运行数据管线',
    taskModes: ['处理并验证', '复现原口径', '自由数据任务'],
    modules: [
      ['dataset', '数据集', '识别文件、表、字段和数据范围。', '输入'],
      ['schema', '字段与口径', '确认类型、主键、指标定义和过滤条件。', '口径'],
      ['pipeline', '处理管线', '按清洗、转换、聚合和分析步骤运行。', '处理'],
      ['quality', '质量检查', '检查缺失、重复、异常和结果一致性。', '校验'],
      ['results', '结果与导出', '展示结果表、指标摘要和导出文件。', '输出'],
    ],
    navigationOrder: ['execute', 'knowledge', 'features', 'evidence', 'history', 'distillation', 'alignment', 'guide'],
    resultLabels: { result: '处理结果摘要', changes: '数据与脚本产物', verification: '质量检查', processes: '数据作业', checkpoints: '数据快照' },
  },
  'document-studio': {
    layout: 'document-workshop', density: 'comfortable', eyebrow: '内容结构与成品交付',
    taskTitle: '说明要制作或改进的文档成品', primaryLabel: '开始制作成品',
    taskModes: ['重构并交付', '沿用原结构', '自由文档任务'],
    modules: [
      ['sources', '原始材料', '读取原文件、参考模板和必须保留的内容。', '素材'],
      ['outline', '内容结构', '重组章节、叙事顺序和信息层级。', '结构'],
      ['layout', '版式与预览', '检查页面布局、文字适配和视觉一致性。', '制作'],
      ['export', '成品导出', '生成目标格式并保留可编辑源文件。', '导出'],
      ['acceptance', '逐页验收', '核对缺页、溢出、错位和最终交付要求。', '验收'],
    ],
    navigationOrder: ['execute', 'evidence', 'knowledge', 'history', 'features', 'distillation', 'alignment', 'guide'],
    resultLabels: { result: '成品交付说明', changes: '文档与素材变更', verification: '渲染与逐页验收', processes: '导出任务', checkpoints: '文档版本' },
  },
  'content-operations': {
    layout: 'campaign-board', density: 'comfortable', eyebrow: '内容、受众与行动机会',
    taskTitle: '说明内容对象、目标人群和业务问题', primaryLabel: '开始内容洞察',
    taskModes: ['洞察并给出行动', '复核原分析', '自由内容任务'],
    modules: [
      ['content', '内容对象', '汇总评论、视频、脚本和平台表现。', '素材'],
      ['audience', '受众信号', '识别人群、需求、情绪、争议和语境。', '人群'],
      ['opportunity', '传播机会', '量化机会、风险和可利用的内容主题。', '机会'],
      ['action', '运营行动', '把洞察转成明确动作、优先级和验证方式。', '行动'],
      ['report', '业务交付', '生成可汇报的洞察报告和证据附件。', '交付'],
    ],
    navigationOrder: ['execute', 'distillation', 'evidence', 'knowledge', 'features', 'history', 'alignment', 'guide'],
    resultLabels: { result: '内容洞察与行动建议', changes: '报告与分析产物', verification: '证据与口径检查', processes: '内容采集任务', checkpoints: '分析版本' },
  },
  'automation-control': {
    layout: 'control-room', density: 'compact', eyebrow: '触发、编排与运行治理',
    taskTitle: '说明触发条件、处理步骤和期望结果', primaryLabel: '启动自动化流程',
    taskModes: ['编排并运行', '复现原流程', '自由自动化任务'],
    modules: [
      ['trigger', '触发条件', '定义输入事件、运行条件和任务边界。', '触发'],
      ['workflow', '流程节点', '组织工具、依赖、分支和执行顺序。', '编排'],
      ['runs', '批量运行', '显示队列、进度、输出和资源状态。', '运行'],
      ['failures', '异常处理', '支持重试、续跑、回滚和失败证据。', '治理'],
      ['handoff', '结果交付', '输出产物、运行记录和外部调用接口。', '交付'],
    ],
    navigationOrder: ['execute', 'history', 'features', 'knowledge', 'evidence', 'alignment', 'distillation', 'guide'],
    resultLabels: { result: '流程运行结果', changes: '节点产物与变更', verification: '运行校验', processes: '活动流程', checkpoints: '续跑检查点' },
  },
  'workflow-desk': {
    layout: 'guided-workflow', density: 'comfortable', eyebrow: '会话专属任务',
    taskTitle: '说明这次要完成的具体结果', primaryLabel: '开始专属任务',
    taskModes: ['按最新要求执行', '复现原流程', '自由任务'],
    modules: [
      ['goal', '确认目标', '读取最新要求并确定这次要完成的结果。', '目标'],
      ['inputs', '准备输入', '收集会话证据、项目文件和必要材料。', '输入'],
      ['steps', '执行步骤', '按已确认流程调用工具完成任务。', '执行'],
      ['review', '结果核对', '对照原要求检查产出和遗漏。', '核对'],
      ['delivery', '交付与恢复', '提供最终结果、记录和恢复信息。', '交付'],
    ],
    navigationOrder: ['execute', 'distillation', 'knowledge', 'evidence', 'features', 'history', 'alignment', 'guide'],
    resultLabels: { result: '最终结果', changes: '文件变更', verification: '命令与验收', processes: '长期任务', checkpoints: '恢复点' },
  },
};

function deriveExperience({ visual, purpose, expertise, capabilities, deliverables }) {
  const definition = EXPERIENCE_DEFINITIONS[visual.family] || EXPERIENCE_DEFINITIONS['workflow-desk'];
  const sourceItems = expertise?.length ? expertise : capabilities;
  const quickStarts = (sourceItems || []).slice(0, 4).map((item, index) => ({
    id: item.id || `quick-${index + 1}`,
    label: pick(item.capability || item.title, `专属任务 ${index + 1}`, 64),
    prompt: pick(item.whenToUse || item.description || purpose, purpose, 420),
    phase: pick(item.phase, `P${index + 1}`, 12),
  }));
  return {
    schemaVersion: '1.0.0',
    layout: definition.layout,
    density: definition.density,
    hero: { eyebrow: definition.eyebrow, summary: visual.description, primaryLabel: definition.primaryLabel },
    task: { title: definition.taskTitle, modes: definition.taskModes },
    modules: definition.modules.map(([id, title, description, stage], index) => ({ id, title, description, stage, order: index + 1 })),
    quickStarts,
    navigationOrder: definition.navigationOrder,
    resultLabels: definition.resultLabels,
    deliverablePreview: (deliverables || []).slice(0, 3),
    rationale: visual.rationale,
  };
}

export function deriveConversationUiBlueprint({ analysis, extraction, identity, sourceSet = null, projectEvidence = null }) {
  const stages = extraction.stages || [];
  const sourceSessions = Array.isArray(sourceSet?.sessions) ? sourceSet.sessions : [];
  const project = projectEvidence?.project || null;
  const projectSummary = projectEvidence?.summary || {};
  const corpus = [
    identity?.name,
    ...sourceSessions.flatMap((source) => [source.title, source.sessionId, source.sourcePath]),
    project?.name,
    ...(projectEvidence?.architecture?.entryFiles || []),
    ...(projectEvidence?.architecture?.manifests || []),
    ...(stages.map(stageText)),
    ...(extraction.corrections || []).map((item) => item.request),
    ...(analysis.reusableCapabilities || []).map((item) => `${item.name}\n${item.trigger || ''}`),
  ].join('\n');
  const visual = visualFor(corpus);
  const corrections = (extraction.corrections || []).slice(0, 5).map((item) => ({
    stage: item.stage,
    authorityRank: item.authorityRank || null,
    title: pick(item.title, `P${item.stage}｜后续纠正`),
    instruction: pick(item.request, '后续要求优先于冲突的早期做法。', 280),
  }));
  const latestStage = stages.at(-1);
  const inputs = deriveInputs(extraction, corpus);
  const specializations = deriveSpecializations(extraction, corpus);
  const expertise = deriveExpertise(extraction, corpus, specializations);
  const capabilities = deriveCapabilities(extraction, identity, corpus, specializations);
  const deliverables = deriveDeliverables(extraction, corpus, specializations);
  const purpose = firstUseful([
    latestStage?.request,
    ...(analysis.reusableCapabilities || []).map((item) => item.trigger),
    analysis.skillBlueprint?.description,
  ], `围绕“${identity?.name || '当前会话'}”完成真实任务，并保留可核对的过程和结果。`);
  const title = visual.family === 'research-studio'
    ? `${firstUseful((identity?.naming?.contentTopics || []).slice(0, 2), '内容')}洞察室`
    : visual.family === 'data-lab'
      ? `${firstUseful((identity?.naming?.contentTopics || []).slice(0, 2), '数据')}管线台`
      : visual.family === 'engineering-console'
        ? `${firstUseful((identity?.naming?.contentTopics || []).slice(0, 2), '项目')}诊断台`
        : visual.family === 'document-studio'
          ? `${firstUseful((identity?.naming?.contentTopics || []).slice(0, 2), '文档')}交付室`
          : visual.family === 'content-operations'
            ? `${firstUseful((identity?.naming?.contentTopics || []).slice(0, 2), '内容')}运营中枢`
            : visual.family === 'automation-control'
              ? `${firstUseful((identity?.naming?.contentTopics || []).slice(0, 2), '流程')}控制台`
              : `${firstUseful((identity?.naming?.contentTopics || []).slice(0, 2), '会话')}专属工作台`;
  const experience = deriveExperience({ visual, purpose, expertise, capabilities, deliverables });
  return {
    schemaVersion: '1.0.0',
    generation: { method: 'deterministic-fallback', label: '多会话与项目结构提炼', model: null, reason: '未配置生成模型时，按全部选中会话、项目文件、Git 差异、工具、产出与后续纠正生成。' },
    identity: { title, subtitle: visual.label, packageName: identity?.name || '会话能力包' },
    purpose,
    audience: '需要复用这些会话目标、执行方式、项目文件依据和修正要求的使用者。',
    visual,
    experience,
    navigation: deriveNavigation(visual),
    inputs,
    capabilities,
    specializations,
    expertise,
    distillationSummary: specializations.length
      ? `已从 ${sourceSessions.length || 1} 个选中会话的 ${specializations.length} 个需求阶段中，结合项目文件和 Git 证据逐阶段蒸馏出专长、适用时机、执行方法、预期交付物和可回查证据。通用工具能力、联合会话能力与项目理解分开呈现。`
      : '当前选中的会话没有可分段的需求记录，因此仅保留可回查的通用执行流程和项目证据。',
    deliverables,
    corrections,
    primaryAction: { label: capabilities[0]?.action || '开始执行', prompt: purpose },
    taskPlaceholder: `例如：${purpose}`,
    sourceSummary: {
      stages: stages.length,
      messages: extraction.statistics?.messages || 0,
      toolCalls: extraction.statistics?.toolCalls || 0,
      corrections: corrections.length,
      sessionCount: sourceSessions.length || 1,
      authority: sourceSet?.authority || [],
      sessions: sourceSessions.map((source) => ({
        sessionId: source.sessionId,
        title: pick(source.title, source.sessionId || '未命名会话', 160),
        sourcePath: source.sourcePath,
        recordCount: source.recordCount,
        sha256: source.sha256,
        authorityRank: source.authorityRank || null,
        authorityReason: source.authorityReason || null,
        lastUserRequestAt: source.lastUserRequestAt || null,
        latestUserRequest: source.latestUserRequest || null,
      })),
      project: project ? {
        name: project.name,
        root: project.root,
        scannedFiles: projectSummary.scannedFiles || 0,
        modifiedFiles: projectSummary.modifiedFiles || 0,
        generatedFiles: projectSummary.generatedFiles || 0,
        linkedFiles: projectSummary.linkedFiles || 0,
        priorityFiles: projectSummary.priorityFiles || 0,
        scanTruncated: Boolean(projectSummary.scanTruncated),
        gitAvailable: Boolean(projectEvidence?.git?.available),
      } : null,
      sourceStages: stages.slice(0, MAX_PHASES).map((stage) => ({ index: stage.index, title: pick(stage.title, `P${stage.index}｜会话目标梳理`), sourceTitles: list(stage.sourceTitles, 3) })),
    },
  };
}

function modelEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function parseModelJson(value) {
  const raw = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象。');
  return JSON.parse(raw.slice(start, end + 1));
}

function modelPrompt({ analysis, extraction, identity, fallback, sourceSet = null, projectEvidence = null }) {
  const sourceSessions = Array.isArray(sourceSet?.sessions) ? sourceSet.sessions : [];
  const project = projectEvidence?.project || null;
  const summary = {
    packageName: identity.name,
    sourceSessions: sourceSessions.map((source) => ({
      sessionId: source.sessionId,
      title: text(source.title, '', 180),
      sourcePath: text(source.sourcePath, '', 260),
      recordCount: source.recordCount,
      sha256: source.sha256,
      authorityRank: source.authorityRank || null,
      lastUserRequestAt: source.lastUserRequestAt || null,
      latestUserRequest: text(source.latestUserRequest, '', 420),
    })),
    sourceAuthority: sourceSet?.authority || [],
    conflictRule: '跨会话发生冲突时，优先级排名 1 的会话最新用户要求覆盖较早要求；其余会话作为补充证据，不得被丢弃。',
    project: project ? {
      name: project.name,
      root: project.root,
      architecture: projectEvidence?.architecture,
      summary: projectEvidence?.summary,
      git: projectEvidence?.git,
      modifiedFiles: projectEvidence?.modifiedFiles,
      originalFiles: projectEvidence?.originalFiles,
      generatedFiles: projectEvidence?.generatedFiles,
      conversationLinks: projectEvidence?.conversationLinks,
    } : null,
    stages: (extraction.stages || []).map((stage) => ({
      index: stage.index,
      title: stage.title,
      request: text(stage.request, '', 1600),
      assistantOutcome: text(stage.assistantMessages?.at(-1)?.text, '', 900),
      tools: list((stage.toolCalls || []).map((tool) => tool.name), 12),
      files: list((stage.fileChanges || []).map((file) => file.path), 12),
      sourceSessions: list(stage.sourceSessions, 8),
      sourceAuthorityRank: stage.sourceAuthorityRank || null,
      originalStageIndexes: list(stage.originalStageIndexes, 8).map(Number).filter(Number.isFinite),
    })).slice(-MAX_PHASES),
    corrections: (extraction.corrections || []).slice(0, 10).map((item) => ({ stage: item.stage, authorityRank: item.authorityRank || null, request: text(item.request, '', 900) })),
    observedTools: list(extraction.observedTools, 60),
    fallback,
  };
  return `你是“多会话与项目转可安装能力包”的产品设计师。请基于下列全部选中会话、项目文件和 Git 证据，返回严格 JSON，不要 Markdown，不要解释。\n\n目标：为多个会话联合理解的项目生成专属、可操作、全中文的独立前端 UI 蓝图。必须同时保留“通用 Codex 执行能力底座”“跨会话专属能力蒸馏”“项目文件理解”三个层次。专属能力必须按 P 阶段逐条说明目标、做法、预期交付物、来源会话和文件证据，不能只给出“全量洞察”“深度分析”这类宽泛任务卡。界面类型、模块组合、导航顺序和执行结果视图由本地特征引擎确定，模型负责增强业务命名与表达，不得把不同领域改写成同一种工作台。\n\n重点：必须输出“从选中会话提炼出的专长”矩阵。每一项 expertise 必须绑定一个 P 阶段，填写：capability（有业务对象的具体专长名称，不得只写“分析”“洞察”“执行”）；whenToUse（什么输入/目标出现时使用）；executionMethod（至少 3 个由 → 连接的步骤，并优先写出该阶段实际出现的工具、文件、Git 差异或产物）；deliverable 和 evidence。必须区分不同会话的来源，不得把所有阶段写成同一类泛化流程。\n\nJSON 只允许这些字段：identity{title,subtitle}, purpose, audience, navigation{execute,features,alignment,evidence,history,guide}, inputs[{id,label,help,type,required}], specializations[{id,phase,title,goal,approach,deliverable,evidence,action,sourceStages}], expertise[{id,phase,capability,whenToUse,executionMethod,deliverable,evidence,action,sourceStages}], distillationSummary, capabilities[{id,title,description,action,sourceStages}], deliverables[{title,description}], corrections[{stage,title,instruction}], primaryAction{label,prompt}, taskPlaceholder。\n\n约束：所有值用简体中文；title 不超过 24 字；purpose 不超过 180 字；最多 5 个输入、${MAX_PHASES} 个 specializations、${MAX_PHASES} 个 expertise、10 个能力、8 个交付物、5 个纠正；每个 specialization 和 expertise 必须以 P1、P2 等阶段标识对应来源；不得输出 visual、experience、密钥或原始长对话，但可以引用必要的相对文件名、会话标题和差异摘要。\n\n联合会话与项目提炼数据：\n${JSON.stringify(summary)}`;
}

function normalizeSpecializations(fallback, values) {
  if (!Array.isArray(values) || !values.length) return fallback.specializations || [];
  return values.slice(0, MAX_PHASES).map((item, index) => {
    const sourceFallback = fallback.specializations?.[index] || {};
    const sourceStages = Array.isArray(item?.sourceStages)
      ? item.sourceStages.map(Number).filter(Number.isFinite).slice(0, 6)
      : (sourceFallback.sourceStages || [index + 1]);
    const originalStageIndexes = Array.isArray(item?.originalStageIndexes)
      ? item.originalStageIndexes.map(Number).filter(Number.isFinite).slice(0, 12)
      : (sourceFallback.originalStageIndexes || sourceStages);
    const phaseIndex = Number(String(item?.phase || '').replace(/\D/g, '')) || sourceStages[0] || index + 1;
    const title = pick(item?.title, sourceFallback.title || `P${phaseIndex}｜会话专属能力`, 120);
    return {
      id: text(item?.id, sourceFallback.id || `phase-p${phaseIndex}`, 48).replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
      phase: `P${phaseIndex}`,
      title: /^P\d+\s*[｜:：]/.test(title) ? title : `P${phaseIndex}｜${title}`,
      goal: pick(item?.goal, sourceFallback.goal || '完成该阶段在原会话中确认的目标。', 460),
      approach: pick(item?.approach, sourceFallback.approach || '先回查会话证据，再执行并核对结果。', 520),
      deliverable: pick(item?.deliverable, sourceFallback.deliverable || '可复核的阶段结果。', 420),
      evidence: pick(item?.evidence, sourceFallback.evidence || `原会话 P${phaseIndex} 阶段。`, 420),
      action: pick(item?.action, sourceFallback.action || '执行该阶段', 64),
      sourceStages,
      originalStageIndexes,
    };
  });
}

function normalizeExpertise(fallback, values, specializations) {
  if (!Array.isArray(values) || !values.length) return fallback.expertise || [];
  return values.slice(0, MAX_PHASES).map((item, index) => {
    const sourceFallback = fallback.expertise?.[index] || {};
    const specialization = specializations[index] || {};
    const sourceStages = Array.isArray(item?.sourceStages)
      ? item.sourceStages.map(Number).filter(Number.isFinite).slice(0, 6)
      : (sourceFallback.sourceStages || specialization.sourceStages || [index + 1]);
    const originalStageIndexes = Array.isArray(item?.originalStageIndexes)
      ? item.originalStageIndexes.map(Number).filter(Number.isFinite).slice(0, 12)
      : (sourceFallback.originalStageIndexes || specialization.originalStageIndexes || sourceStages);
    const phaseIndex = Number(String(item?.phase || '').replace(/\D/g, '')) || sourceStages[0] || index + 1;
    const fallbackCapability = sourceFallback.capability || phaseName(specialization.title, `P${phaseIndex} 会话专属能力`);
    const requestedCapability = pick(item?.capability, fallbackCapability, 120);
    const capability = /^(?:分析|洞察|执行|处理|任务|工作流|会话专属能力|需求梳理|数据处理|内容分析)$/u.test(requestedCapability.trim())
      ? fallbackCapability
      : requestedCapability;
    return {
      id: text(item?.id, sourceFallback.id || `expertise-p${phaseIndex}`, 48).replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
      phase: `P${phaseIndex}`,
      capability,
      whenToUse: pick(item?.whenToUse, sourceFallback.whenToUse || specialization.goal || '在原会话确认的输入和目标再次出现时使用。', 520),
      executionMethod: pick(item?.executionMethod, sourceFallback.executionMethod || specialization.approach || '回查会话证据 → 执行阶段做法 → 核对交付结果。', 760),
      deliverable: pick(item?.deliverable, sourceFallback.deliverable || specialization.deliverable || '可复核的阶段结果。', 420),
      evidence: pick(item?.evidence, sourceFallback.evidence || specialization.evidence || `原会话 P${phaseIndex} 阶段。`, 420),
      action: pick(item?.action, sourceFallback.action || specialization.action || '执行该专长', 64),
      sourceStages,
      originalStageIndexes,
    };
  });
}

function mergeModelBlueprint(fallback, draft, model) {
  const visual = { ...fallback.visual };
  const inputs = Array.isArray(draft.inputs) && draft.inputs.length ? draft.inputs.slice(0, 5).map((item, index) => ({
    id: text(item?.id, `input-${index + 1}`, 48).replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
    label: pick(item?.label, fallback.inputs[index]?.label || '所需材料', 80),
    help: pick(item?.help, fallback.inputs[index]?.help || '提供与任务相关的材料。', 240),
    type: ['textarea', 'text', 'path'].includes(item?.type) ? item.type : 'textarea',
    required: item?.required !== false,
  })) : fallback.inputs;
  const specializations = normalizeSpecializations(fallback, draft.specializations);
  const expertise = normalizeExpertise(fallback, draft.expertise, specializations);
  const capabilities = specializations.length
    ? specializations.slice(0, 10).map(specializationToCapability)
    : (Array.isArray(draft.capabilities) && draft.capabilities.length ? draft.capabilities.slice(0, 6).map((item, index) => ({
      id: text(item?.id, `capability-${index + 1}`, 48).replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
      title: pick(item?.title, fallback.capabilities[index]?.title || '会话专属能力', 80),
      description: pick(item?.description, fallback.capabilities[index]?.description || '按会话证据完成此项工作。', 260),
      action: pick(item?.action, fallback.capabilities[index]?.action || '开始处理', 48),
      sourceStages: Array.isArray(item?.sourceStages) ? item.sourceStages.map(Number).filter(Number.isFinite).slice(0, 6) : (fallback.capabilities[index]?.sourceStages || []),
    })) : fallback.capabilities);
  const deliverables = Array.isArray(draft.deliverables) && draft.deliverables.length ? draft.deliverables.slice(0, 4).map((item, index) => ({
    title: pick(item?.title, fallback.deliverables[index]?.title || '交付结果', 80),
    description: pick(item?.description, fallback.deliverables[index]?.description || '完成后提供可核对的结果。', 220),
  })) : fallback.deliverables;
  const corrections = Array.isArray(draft.corrections) && draft.corrections.length ? draft.corrections.slice(0, 5).map((item, index) => ({
    stage: Number(item?.stage) || fallback.corrections[index]?.stage || index + 1,
    title: pick(item?.title, fallback.corrections[index]?.title || '后续纠正', 90),
    instruction: pick(item?.instruction, fallback.corrections[index]?.instruction || '后续要求优先。', 300),
  })) : fallback.corrections;
  const result = {
    ...fallback,
    generation: { method: 'model', label: '生成模型会话蒸馏', model: text(model, '', 120) || null, reason: '模型已阅读会话阶段、产出、工具与后续纠正，并生成专属界面蓝图。' },
    identity: { ...fallback.identity, title: pick(draft.identity?.title, fallback.identity.title, 24), subtitle: pick(draft.identity?.subtitle, fallback.identity.subtitle, 60) },
    purpose: pick(draft.purpose, fallback.purpose, 180),
    audience: pick(draft.audience, fallback.audience, 160),
    visual,
    navigation: { ...fallback.navigation, ...(draft.navigation || {}) },
    inputs,
    capabilities,
    specializations,
    expertise,
    distillationSummary: pick(draft.distillationSummary, fallback.distillationSummary, 360),
    deliverables,
    corrections,
    primaryAction: {
      label: pick(draft.primaryAction?.label, capabilities[0]?.action || fallback.primaryAction.label, 48),
      prompt: pick(draft.primaryAction?.prompt, fallback.primaryAction.prompt, 600),
    },
    taskPlaceholder: pick(draft.taskPlaceholder, fallback.taskPlaceholder, 300),
  };
  result.experience = deriveExperience({
    visual,
    purpose: result.purpose,
    expertise: result.expertise,
    capabilities: result.capabilities,
    deliverables: result.deliverables,
  });
  return result;
}

export async function distillConversationUi({ analysis, extraction, identity, ai = {}, sourceSet = null, projectEvidence = null }) {
  const fallback = deriveConversationUiBlueprint({ analysis, extraction, identity, sourceSet, projectEvidence });
  const endpoint = modelEndpoint(ai.baseUrl);
  const model = text(ai.model, '', 200);
  if (!endpoint || !model || ai.enabled === false) return enforceSemanticDistillation(fallback, { extraction, identity });
  const timeoutMs = Math.min(Math.max(Number(ai.timeoutMs) || 45000, 5000), 120000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (text(ai.apiKey, '', 2000)) headers.authorization = `Bearer ${String(ai.apiKey).trim()}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你只返回符合用户字段约束的 JSON。' },
          { role: 'user', content: modelPrompt({ analysis, extraction, identity, fallback, sourceSet, projectEvidence }) },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(text(payload?.error?.message, `模型请求失败（${response.status}）。`, 500));
    const content = payload?.choices?.[0]?.message?.content ?? payload?.output_text ?? '';
    return enforceSemanticDistillation(mergeModelBlueprint(fallback, parseModelJson(content), model), { extraction, identity });
  } catch (error) {
    return enforceSemanticDistillation({
      ...fallback,
      generation: {
        method: 'deterministic-fallback',
        label: '会话结构提炼',
        model: model || null,
        reason: `生成模型未能完成蒸馏，已使用可验证的会话结构规则：${text(error?.message, '未知错误', 260)}`,
      },
    }, { extraction, identity });
  } finally {
    clearTimeout(timer);
  }
}

export function applyConversationUiOverrides(fallback, overrides = {}) {
  const merged = mergeModelBlueprint(fallback, overrides, fallback?.generation?.model || null);
  return enforceSemanticDistillation({
    ...merged,
    generation: {
      ...fallback.generation,
      method: 'ai-distilled-user-reviewed',
      label: '会话蒸馏后人工确认',
      reason: '先基于完整会话生成专属界面蓝图，再应用用户在转换器中的明确修改。',
    },
  });
}
