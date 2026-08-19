import { sha256, stableStringify } from '../ir/trace-ir.mjs';

export const SEMANTIC_EVALUATION_PLAN_SCHEMA_VERSION = 'semantic-evaluation-plan/v2';

const DEFAULT_STRATA = Object.freeze([
  ['short-text', '短文本', '验证极短表达、口语和省略句。'],
  ['long-text', '长文本', '验证多观点、因果链和上下文保持。'],
  ['root-message', '根消息', '验证独立主题与主诉识别。'],
  ['reply-message', '回复消息', '验证线程归属与上下文理解。'],
  ['duplicate-text', '重复文本', '验证去重后统计口径。'],
  ['negative-or-ironic', '负向与反讽候选', '验证否定、反讽和引用不被简单关键词误判。'],
  ['image-only', '仅图片内容', '验证未执行 OCR 或视觉模型时不会冒充已分析。'],
  ['high-engagement', '高互动样本', '验证高权重内容不会放大单一主题。'],
  ['low-engagement', '低互动样本', '验证长尾观点仍进入抽样。'],
]);

function array(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

export function buildSemanticEvaluationPlan(workCapability = {}, options = {}) {
  const evaluation = workCapability.semanticEvaluation || {};
  const required = Boolean(workCapability.domainProfile?.semanticEvaluationRequired || options.required);
  const strata = (options.strata || DEFAULT_STRATA).map((entry, index) => {
    const [id, name, purpose] = Array.isArray(entry) ? entry : [entry.id, entry.name, entry.purpose];
    return {
      id,
      name,
      purpose,
      minimumSamples: Number(options.minimumSamplesPerStratum || 30),
      status: 'pending',
      evidenceRefs: [],
      order: index + 1,
    };
  });
  const thresholds = {
    precision: Number(options.precisionThreshold || 0.85),
    recall: Number(options.recallThreshold || 0.8),
    f1: Number(options.f1Threshold || 0.82),
  };
  const reproducibility = {
    sourceFingerprint: workCapability.fingerprint || null,
    ruleVersion: evaluation.ruleVersion || null,
    modelVersion: evaluation.modelVersion || null,
    promptVersion: options.promptVersion || 'semantic-candidate/v2',
  };
  return {
    schemaVersion: SEMANTIC_EVALUATION_PLAN_SCHEMA_VERSION,
    required,
    status: required ? 'pending' : 'not-required',
    purpose: '把模型输出限制为候选，经过固定标签、分层抽样和人工修正后再进入统计。',
    stages: [
      { id: 'deterministic', name: '确定性处理', outputs: ['清洗结果', '去重结果', '线程恢复结果'] },
      { id: 'candidate', name: '模型候选', outputs: ['主题候选', '关系候选', '反讽候选', '图片语义候选'] },
      { id: 'adjudication', name: '人工与规则裁决', outputs: ['最终标签', '修正记录', '可统计样本'] },
    ],
    strata,
    thresholds,
    requiredOutputs: ['precision', 'recall', 'f1', 'confusionMatrix', 'correctionLog', 'sampleManifest'],
    reproducibility: {
      ...reproducibility,
      cacheKey: sha256(stableStringify(reproducibility)),
    },
    limitations: required
      ? ['评估完成前，语义能力只能作为候选，不得把模型分类数量写成已验证事实。']
      : ['当前能力不依赖模型语义结论。'],
  };
}

export function evaluateSemanticReadiness(plan = {}, results = {}) {
  if (!plan.required) return { status: 'pass', reason: '当前能力不依赖模型语义结论。', metrics: {} };
  const metrics = {
    precision: Number(results.precision),
    recall: Number(results.recall),
    f1: Number(results.f1),
  };
  const missingOutputs = array(plan.requiredOutputs).filter((name) => results[name] === undefined || results[name] === null);
  if (missingOutputs.length) return { status: 'pending', reason: `仍缺少：${missingOutputs.join('、')}。`, metrics, missingOutputs };
  const failed = Object.entries(plan.thresholds || {}).filter(([name, threshold]) => Number(metrics[name]) < Number(threshold));
  return failed.length
    ? { status: 'restricted', reason: `语义评估未达到声明阈值：${failed.map(([name]) => name).join('、')}。`, metrics, failed: failed.map(([name]) => name) }
    : { status: 'pass', reason: '分层抽样、人工修正和语义指标达到能力声明阈值。', metrics, evidenceRefs: array(results.evidenceRefs) };
}
