const GENERIC = /^(?:会话(?:分析|目标梳理|专属能力)?|通用(?:请求|任务|能力|工作流)|(?:全量|深度|内容|数据)?分析|洞察|执行|处理|任务(?:执行)?|工作流|需求梳理|继续(?:推进|升级|实施|完成)?(?:本方案)?|优化(?:此)?方案|实施(?:本)?方案|能力(?:升级|重建)?|项目(?:处理|工作)?|未命名.*)$/u;
const META_LINE = /^(?:#|<|\[?AGENTS\.md|in-app-browser-context|Response annotations|My request:)/iu;

function clean(value, fallback = '', maximum = 360) {
  const result = String(value ?? '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const limited = (result || fallback).slice(0, maximum).trim();
  return limited.length === maximum ? `${limited.slice(0, -1)}…` : limited;
}

function isGeneric(value) {
  const title = clean(value, '', 160)
    .replace(/^P\d+\s*[｜:：]\s*/u, '')
    .replace(/[。！!？?].*$/u, '')
    .trim();
  return !title || title.length < 4 || GENERIC.test(title);
}

function stageSource(stage) {
  return clean([
    stage?.title,
    stage?.request,
    ...(stage?.assistantMessages || []).map((item) => item?.text),
    ...(stage?.fileChanges || []).map((item) => item?.path),
    ...(stage?.toolCalls || []).map((item) => item?.name),
  ].filter(Boolean).join('\n'), '', 6000);
}

function requestSubject(stage, fallback) {
  const raw = clean(stage?.request || stage?.title || '', '', 1200);
  const segments = raw.split(/[\n。！？!?；;]+/u)
    .map((item) => clean(item, '', 220)
      .replace(/^\s*(?:用户(?:请求|需求)?|任务|目标|请|帮我|我想|我需要|我要|希望(?:你)?)\s*[:：，,]?\s*/u, '')
      .replace(/^\s*(?:继续|立即|现在|请先|需要|必须|希望)\s*/u, '')
      .trim())
    .filter((item) => item.length >= 4 && !META_LINE.test(item) && !isGeneric(item));
  return clean(segments[0], fallback, 72);
}

function semanticOperation(stage, fallback) {
  const source = stageSource(stage);
  const subject = requestSubject(stage, '原会话目标');
  if (/蒸馏|能力包|技能|skill|mcp|agent|工作流封装/iu.test(source)) return /会话|codex|对话/iu.test(source) ? '会话能力蒸馏与可安装包生成' : '可复用工作流与能力包封装';
  if (/本机.*(?:会话|codex)|会话.*(?:搜索|选择|标题|列表)/iu.test(source)) return '本机 Codex 会话发现与语义选择';
  if (/项目|代码|文件|命令|测试|补丁|git|构建|接口|服务|前端|后端/iu.test(source)) {
    if (/前端|ui|界面|页面/iu.test(source)) return '独立界面功能实现与交互验证';
    if (/git|原始文件|差异|变更|证据/iu.test(source)) return '项目文件版本证据提取与变更验证';
    return '项目文件修改、命令执行与结果验证';
  }
  if (/报告|汇报|文档|ppt|演示/iu.test(source)) return '报告内容重构、产物生成与格式验证';
  if (/评论|视频|玩家|受众|营销|洞察|调研/iu.test(source)) return '内容数据洞察与可追溯结论生成';
  if (!isGeneric(subject)) return subject;
  return fallback;
}

function stageEvidence(stage, phase) {
  const tools = [...new Set((stage?.toolCalls || []).map((item) => clean(item?.name, '', 60)).filter(Boolean))].slice(0, 5);
  const files = [...new Set((stage?.fileChanges || []).map((item) => clean(item?.path, '', 140)).filter(Boolean))].slice(0, 3);
  const parts = [`原会话 ${phase} 阶段`];
  if (tools.length) parts.push(`工具：${tools.join('、')}`);
  if (files.length) parts.push(`文件：${files.join('、')}`);
  return parts.join('；');
}

function indexedStages(extraction) {
  return new Map((extraction?.stages || []).map((stage, index) => [Number(stage?.index) || index + 1, stage]));
}

function stageFor(item, stages, index) {
  const phase = Number(String(item?.phase || '').replace(/\D/g, '')) || Number(item?.sourceStages?.[0]) || index + 1;
  return { phase, stage: stages.get(phase) || {} };
}

function normalizeSpecialization(item, stage, index) {
  const phase = `P${Number(stage?.index) || index + 1}`;
  const semanticTitle = semanticOperation(stage, '原会话任务执行与验收');
  const rawTitle = clean(item?.title, '', 160).replace(/^P\d+\s*[｜:：]\s*/u, '');
  const title = isGeneric(rawTitle) ? semanticTitle : rawTitle;
  const goal = clean(item?.goal, clean(stage?.request, `${title}的原会话目标。`, 420), 600);
  const tools = [...new Set((stage?.toolCalls || []).map((tool) => clean(tool?.name, '', 60)).filter(Boolean))].slice(0, 4);
  const files = [...new Set((stage?.fileChanges || []).map((file) => clean(file?.path, '', 140)).filter(Boolean))].slice(0, 3);
  const approachFallback = `回查${phase}原始要求${tools.length ? `与${tools.join('、')}工具记录` : ''} → ${files.length ? `核对${files.join('、')}等关联文件 → ` : ''}执行具体操作并逐项验证交付结果`;
  return {
    ...item,
    id: clean(item?.id, `phase-p${index + 1}`, 64),
    phase,
    title: `${phase}｜${title}`,
    goal,
    approach: clean(item?.approach, approachFallback, 900),
    deliverable: clean(item?.deliverable, `${title}的可审查结果、验证结论和后续处理记录。`, 600),
    evidence: clean(item?.evidence, stageEvidence(stage, phase), 600),
    action: clean(item?.action, `执行${title}`, 120),
    sourceStages: Array.isArray(item?.sourceStages) && item.sourceStages.length ? item.sourceStages.map(Number).filter(Number.isFinite) : [Number(stage?.index) || index + 1],
    originalStageIndexes: Array.isArray(item?.originalStageIndexes) && item.originalStageIndexes.length ? item.originalStageIndexes.map(Number).filter(Number.isFinite) : [Number(stage?.index) || index + 1],
  };
}

function normalizeExpertise(item, specialization, stage, index) {
  const phase = specialization.phase || `P${index + 1}`;
  const title = specialization.title.replace(/^P\d+\s*[｜:：]\s*/u, '');
  const capability = isGeneric(item?.capability) ? title : clean(item?.capability, title, 180);
  const whenFallback = `当出现“${requestSubject(stage, title)}”对应的输入、项目或交付目标时使用。`;
  return {
    ...item,
    id: clean(item?.id, `expertise-p${index + 1}`, 64),
    phase,
    capability,
    whenToUse: clean(item?.whenToUse, whenFallback, 700),
    executionMethod: clean(item?.executionMethod, specialization.approach, 1100),
    deliverable: clean(item?.deliverable, specialization.deliverable, 700),
    evidence: clean(item?.evidence, specialization.evidence, 700),
    action: clean(item?.action, specialization.action, 120),
    sourceStages: specialization.sourceStages,
    originalStageIndexes: specialization.originalStageIndexes,
  };
}

function qualityReport(specializations, expertise, sourceStageCount) {
  const issues = [];
  if (!sourceStageCount) issues.push('未识别到可拆分的用户需求阶段，已保留完整会话执行链。');
  if (specializations.some((item) => isGeneric(item.title))) issues.push('仍存在泛化阶段标题。');
  if (expertise.some((item) => isGeneric(item.capability))) issues.push('仍存在泛化专长名称。');
  if (expertise.some((item) => !item.executionMethod.includes('→'))) issues.push('存在未形成步骤链的执行方法。');
  if (specializations.some((item) => !item.evidence || !item.deliverable)) issues.push('存在缺少证据或交付物的阶段。');
  return {
    schemaVersion: '2.0.0',
    status: issues.length ? '需要复核' : '通过',
    sourceStageCount,
    specializationCount: specializations.length,
    expertiseCount: expertise.length,
    issues,
    guarantees: [
      '每个 P 阶段都绑定原会话需求、工具轨迹或文件变更证据。',
      '专长必须说明使用时机、执行步骤、交付物和证据，不以泛化标题替代。',
      '后续人工或模型改写会再次经过同一质量门禁。',
    ],
  };
}

export function enforceSemanticDistillation(ui, { extraction = {}, identity = {} } = {}) {
  const stages = indexedStages(extraction);
  const base = Array.isArray(ui?.specializations) && ui.specializations.length
    ? ui.specializations
    : (extraction.stages || []).map((stage, index) => ({ phase: `P${Number(stage?.index) || index + 1}`, sourceStages: [Number(stage?.index) || index + 1] }));
  const specializations = base.map((item, index) => {
    const { stage } = stageFor(item, stages, index);
    return normalizeSpecialization(item, stage, index);
  });
  const expertiseByPhase = new Map((ui?.expertise || []).map((item) => [String(item?.phase || ''), item]));
  const expertise = specializations.map((item, index) => {
    const stage = stages.get(Number(String(item.phase).replace(/\D/g, ''))) || {};
    return normalizeExpertise(expertiseByPhase.get(item.phase) || {}, item, stage, index);
  });
  const capabilities = specializations.slice(0, 10).map((item) => ({
    id: item.id,
    title: item.title,
    description: `目标：${item.goal}\n执行做法：${item.approach}\n交付：${item.deliverable}\n证据：${item.evidence}`,
    action: item.action,
    sourceStages: item.sourceStages,
    originalStageIndexes: item.originalStageIndexes,
  }));
  const primary = specializations[0];
  const existingTitle = clean(ui?.identity?.title, '', 80);
  const title = isGeneric(existingTitle) && primary ? `${primary.title.replace(/^P\d+\s*[｜:：]\s*/u, '').slice(0, 18)}工作台` : existingTitle || `${clean(identity?.name, '会话能力', 18)}工作台`;
  const quality = qualityReport(specializations, expertise, (extraction.stages || []).length);
  return {
    ...ui,
    schemaVersion: '2.0.0',
    identity: { ...(ui?.identity || {}), title },
    specializations,
    expertise,
    capabilities,
    deliverables: specializations.slice(0, 8).map((item) => ({ title: item.title, description: item.deliverable })),
    primaryAction: { ...(ui?.primaryAction || {}), label: primary?.action || ui?.primaryAction?.label || '开始执行', prompt: primary?.goal || ui?.primaryAction?.prompt || '' },
    semanticQuality: quality,
  };
}
