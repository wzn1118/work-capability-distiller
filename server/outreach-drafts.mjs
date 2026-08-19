import { contentInputFingerprint } from './content-analysis.mjs';

export const OUTREACH_DRAFT_SCHEMA_VERSION = 'outreach-draft/v1';
export const OUTREACH_DRAFT_BATCH_SCHEMA_VERSION = 'outreach-draft-batch/v1';

const READY_FRESHNESS = new Set(['captured_snapshot', 'current_snapshot']);
const BLOCKED_FRESHNESS = new Set([
  'source_capture_unavailable',
  'input_fingerprint_unavailable',
  'capture_time_unavailable',
  'freshness_unavailable',
]);
const REVIEW_STATUSES = new Set(['draft', 'approved', 'sent']);

function hasOwn(value, key) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, maximum = 600) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function unique(values, maximum = 96) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = text(value, 240);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= maximum) break;
  }
  return output;
}

function clone(value) {
  if (value === null || value === undefined) return null;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function safeUrl(value) {
  const candidate = text(value, 1_200);
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : '';
  } catch {
    return '';
  }
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function timestamp(value) {
  return text(value, 80) || new Date().toISOString();
}

function targetIdFor(...candidates) {
  for (const candidate of candidates) {
    const item = object(candidate);
    const targetId = text(item.targetId || item.discoveryCreatorId || item.id, 220);
    if (targetId) return targetId;
  }
  return '';
}

function analysisFor(record) {
  const candidate = object(record);
  if (Object.keys(object(candidate.analysis)).length) return object(candidate.analysis);
  if (candidate.outreachHook || candidate.evidence || candidate.source) return candidate;
  return {};
}

function campaignBrief(campaign) {
  const input = object(campaign);
  const brief = Object.keys(object(input.brief)).length
    ? object(input.brief)
    : Object.keys(object(input.campaignBrief)).length
      ? object(input.campaignBrief)
      : input;
  return {
    brand: text(brief.brand, 160),
    product: text(brief.product, 180),
    objective: text(brief.objective, 240),
    audience: text(brief.audience, 180),
    tone: text(brief.tone, 120),
  };
}

function creatorSnapshot({ creator, analysisRecord, currentCapture }) {
  const record = object(analysisRecord);
  const analysis = analysisFor(analysisRecord);
  const capture = object(currentCapture);
  const input = object(creator);
  const targetId = targetIdFor(record, input, capture, analysis.source);
  return {
    id: targetId,
    name: text(input.name || record.name || capture.name || analysis.creatorContext?.name, 180) || targetId || 'Creator',
    channel: text(input.channel || input.platform || record.channel || record.platform || capture.channel || capture.platform, 80).toLowerCase() || null,
    sourceUrl: safeUrl(input.sourceUrl || record.sourceUrl || capture.sourceUrl || analysis.source?.sourceProfileUrl) || null,
    identityKey: text(input.identityKey || record.identityKey || capture.identityKey, 240) || null,
  };
}

function currentCaptureFingerprint(capture) {
  try {
    return contentInputFingerprint(capture);
  } catch {
    return '';
  }
}

/**
 * Resolve freshness without I/O. Omitting currentCapture retains the freshness
 * calculated by the content-analysis job; passing null explicitly marks the
 * source capture as unavailable.
 */
export function resolveOutreachDraftFreshness(input = {}) {
  const analysis = analysisFor(input.analysisRecord);
  const source = object(analysis.source);
  const inputFingerprint = text(source.inputFingerprint, 128) || null;
  const savedFreshness = text(source.freshness, 80);
  const hasCurrentCapture = hasOwn(input, 'currentCapture');

  if (hasCurrentCapture) {
    if (!object(input.currentCapture) || !Object.keys(object(input.currentCapture)).length) {
      return {
        freshness: 'source_capture_unavailable',
        inputFingerprint,
        currentInputFingerprint: null,
        currentContentCapturedAt: null,
      };
    }
    const currentInputFingerprint = currentCaptureFingerprint(input.currentCapture) || null;
    if (!inputFingerprint || !currentInputFingerprint) {
      return {
        freshness: 'input_fingerprint_unavailable',
        inputFingerprint,
        currentInputFingerprint,
        currentContentCapturedAt: text(input.currentCapture?.capturedAt, 80) || null,
      };
    }
    return {
      freshness: currentInputFingerprint === inputFingerprint ? 'current_snapshot' : 'stale_source_changed',
      inputFingerprint,
      currentInputFingerprint,
      currentContentCapturedAt: text(input.currentCapture?.capturedAt, 80) || null,
    };
  }

  if (!inputFingerprint) {
    return {
      freshness: 'input_fingerprint_unavailable',
      inputFingerprint: null,
      currentInputFingerprint: null,
      currentContentCapturedAt: text(source.currentContentCapturedAt, 80) || null,
    };
  }

  return {
    freshness: savedFreshness || 'captured_snapshot',
    inputFingerprint,
    currentInputFingerprint: null,
    currentContentCapturedAt: text(source.currentContentCapturedAt, 80) || null,
  };
}

function reason(code, message) {
  return { code, message };
}

function freshnessReason(freshness) {
  if (freshness === 'stale_source_changed') {
    return reason('SOURCE_CHANGED', 'The saved evidence no longer matches the current content capture.');
  }
  if (freshness === 'source_capture_unavailable') {
    return reason('SOURCE_CAPTURE_UNAVAILABLE', 'A current source capture is required before drafting outreach.');
  }
  if (freshness === 'input_fingerprint_unavailable') {
    return reason('INPUT_FINGERPRINT_UNAVAILABLE', 'The analysis does not contain a source input fingerprint.');
  }
  if (BLOCKED_FRESHNESS.has(freshness)) {
    return reason('SOURCE_FRESHNESS_UNAVAILABLE', 'Source freshness cannot be verified for this content analysis.');
  }
  if (!READY_FRESHNESS.has(freshness)) {
    return reason('SOURCE_FRESHNESS_UNKNOWN', 'Source freshness is not in a draftable state.');
  }
  return null;
}

function evidenceIndex(analysis) {
  return new Map((Array.isArray(analysis.evidence) ? analysis.evidence : [])
    .map((entry) => [text(entry?.id, 240), object(entry)])
    .filter(([id]) => Boolean(id)));
}

function primaryEvidenceFor(analysis, outreachHook) {
  const source = object(outreachHook.source);
  const evidenceId = text(source.evidenceId, 240);
  if (!evidenceId) {
    return { issue: reason('PRIMARY_EVIDENCE_MISSING', 'The outreach hook has no primary evidence id.') };
  }
  const byId = evidenceIndex(analysis);
  const entry = byId.get(evidenceId);
  if (!entry) {
    return { issue: reason('PRIMARY_EVIDENCE_MISSING', 'The primary evidence is not present in the analysis evidence set.') };
  }
  const evidenceIds = unique([...(Array.isArray(outreachHook.evidenceIds) ? outreachHook.evidenceIds : []), evidenceId]);
  const missingEvidenceIds = evidenceIds.filter((id) => !byId.has(id));
  if (missingEvidenceIds.length) {
    return {
      issue: reason('EVIDENCE_REFERENCE_MISSING', `The outreach hook references missing evidence: ${missingEvidenceIds.join(', ')}.`),
    };
  }
  const metrics = object(entry.metrics);
  const primary = {
    id: evidenceId,
    kind: text(entry.kind || source.kind, 120) || null,
    sourceUrl: safeUrl(entry.sourceUrl || source.sourceUrl) || null,
    excerpt: text(entry.excerpt || entry.text || entry.summary || source.excerpt, 1_200) || null,
    sampleIndex: positiveInteger(entry.sampleIndex ?? source.sampleIndex),
    observedFields: unique(entry.observedFields || source.observedFields || [], 24),
    publishedAt: text(metrics.publishedAt || entry.publishedAt || source.publishedAt, 80) || null,
    startSeconds: finite(metrics.startSeconds ?? entry.startSeconds ?? source.startSeconds),
    endSeconds: finite(metrics.endSeconds ?? entry.endSeconds ?? source.endSeconds),
    timeSeconds: finite(metrics.timeSeconds ?? entry.timeSeconds ?? source.timeSeconds),
  };
  if (!primary.kind || !primary.sourceUrl || !primary.excerpt) {
    return {
      issue: reason('PRIMARY_EVIDENCE_INCOMPLETE', 'Primary evidence must include kind, source URL, and an observed excerpt.'),
    };
  }
  return { primary, evidenceIds };
}

function reasoningFor(outreachHook) {
  const analysis = object(outreachHook.analysis);
  return {
    roleId: text(analysis.roleId, 120) || null,
    roleLabel: text(analysis.roleLabel, 160) || null,
    findingId: text(analysis.findingId, 160) || null,
    statement: text(analysis.statement, 600) || null,
  };
}

function multimodalManifestFor(analysis) {
  const manifest = Object.keys(object(analysis.multimodal)).length
    ? analysis.multimodal
    : analysis.synthesis?.multimodal;
  return Object.keys(object(manifest)).length ? clone(manifest) : null;
}

function composeSource({ analysis, contentAnalysisJob, freshness }) {
  const source = object(analysis.source);
  return {
    contentAnalysisJobId: text(contentAnalysisJob?.id, 220) || null,
    contentJobId: text(contentAnalysisJob?.contentJobId, 220) || null,
    contentCaptureId: text(source.contentCaptureId, 220) || null,
    sourceProfileUrl: safeUrl(source.sourceProfileUrl) || null,
    contentCapturedAt: text(source.contentCapturedAt, 80) || null,
    analyzedAt: text(analysis.capturedAt, 80) || null,
    inputFingerprint: freshness.inputFingerprint,
    currentInputFingerprint: freshness.currentInputFingerprint,
    freshness: freshness.freshness,
    currentContentCapturedAt: freshness.currentContentCapturedAt,
  };
}

/**
 * Builds a bounded Chinese outreach opening from already verified evidence.
 * This function does not fetch content or call a model.
 */
export function composeEvidenceLockedMessage({
  campaign = null,
  creator = null,
  primaryEvidence = null,
  outreachAnalysis = null,
} = {}) {
  const brief = campaignBrief(campaign);
  const target = object(creator);
  const evidence = object(primaryEvidence);
  const analysis = object(outreachAnalysis);
  const creatorName = text(target.name, 180) || '你好';
  const excerpt = text(evidence.excerpt, 420);
  const statement = text(analysis.statement, 420);
  const brand = brief.brand || '我们团队';
  const product = brief.product ? `围绕 ${brief.product}` : '围绕本次内容方向';
  const objective = brief.objective ? `本次希望 ${brief.objective}` : '想进一步交流合适的共创方式';
  const tone = brief.tone ? `，希望以${brief.tone}的方式沟通` : '';

  return [
    `你好 ${creatorName}，我们留意到你在内容中分享了“${excerpt}”。`,
    statement || '这条内容呈现出的表达方式与受众沟通节奏很有参考价值。',
    `${brand}正在${product}探索合作内容，${objective}${tone}。`,
    '如果你愿意，想先听听你对内容方向和合作形式的想法。',
  ].join('');
}

function draftId({ campaign, contentAnalysisJob, targetId }) {
  const scope = text(campaign?.id || contentAnalysisJob?.id || 'local', 220);
  return `outreach-draft-${scope}-${targetId || 'unresolved'}`;
}

function baseDraft(input) {
  const { campaign, contentAnalysisJob, creator, analysisRecord, currentCapture, generatedAt } = input;
  const analysis = analysisFor(analysisRecord);
  const target = creatorSnapshot({ creator, analysisRecord, currentCapture });
  const freshnessInput = { analysisRecord };
  if (hasOwn(input, 'currentCapture')) freshnessInput.currentCapture = currentCapture;
  const freshness = resolveOutreachDraftFreshness(freshnessInput);
  return {
    schemaVersion: OUTREACH_DRAFT_SCHEMA_VERSION,
    id: draftId({ campaign, contentAnalysisJob, targetId: target.id }),
    campaignId: text(campaign?.id, 220) || null,
    targetId: target.id || null,
    creator: target,
    source: composeSource({ analysis, contentAnalysisJob, freshness }),
    evidence: { primary: null, ids: [] },
    reasoning: { roleId: null, roleLabel: null, findingId: null, statement: null },
    multimodalManifest: multimodalManifestFor(analysis),
    status: 'blocked',
    reason: null,
    message: {
      body: null,
      templateVersion: 'evidence-locked-message/v1',
      generatedAt,
      updatedAt: generatedAt,
    },
    review: { status: 'draft', approvedAt: null, sentAt: null },
    generatedAt,
    updatedAt: generatedAt,
  };
}

/**
 * Build one immutable-evidence outreach draft. A stale capture never receives
 * a reusable message body, so callers must refresh analysis before approval.
 */
export function buildEvidenceLockedOutreachDraft(input = {}) {
  const generatedAt = timestamp(input.generatedAt);
  const draft = baseDraft({ ...input, generatedAt });
  const analysis = analysisFor(input.analysisRecord);
  const outreachHook = object(analysis.outreachHook);
  const freshnessIssue = freshnessReason(draft.source.freshness);

  if (!draft.targetId) {
    draft.reason = reason('TARGET_ID_MISSING', 'A creator target id is required to build an outreach draft.');
    return draft;
  }
  if (!Object.keys(analysis).length) {
    draft.reason = reason('ANALYSIS_RECORD_MISSING', 'No content analysis record is available for this creator.');
    return draft;
  }
  if (freshnessIssue) {
    draft.status = draft.source.freshness === 'stale_source_changed' ? 'stale' : 'blocked';
    draft.reason = freshnessIssue;
    return draft;
  }
  if (outreachHook.status !== 'ready') {
    draft.reason = reason(
      'OUTREACH_HOOK_UNAVAILABLE',
      text(outreachHook.reason, 240) || 'The content analysis does not contain a ready outreach hook.',
    );
    return draft;
  }

  const evidence = primaryEvidenceFor(analysis, outreachHook);
  if (evidence.issue) {
    draft.reason = evidence.issue;
    return draft;
  }
  const reasoning = reasoningFor(outreachHook);
  if (!reasoning.statement) {
    draft.reason = reason('OUTREACH_REASONING_MISSING', 'The outreach hook has no evidence-linked reasoning statement.');
    return draft;
  }

  draft.status = 'ready';
  draft.reason = null;
  draft.evidence = { primary: evidence.primary, ids: evidence.evidenceIds };
  draft.reasoning = reasoning;
  draft.message.body = composeEvidenceLockedMessage({
    campaign: input.campaign,
    creator: draft.creator,
    primaryEvidence: evidence.primary,
    outreachAnalysis: reasoning,
  });
  return draft;
}

function capturesByTarget(value) {
  const captures = new Map();
  if (Array.isArray(value)) {
    for (const capture of value) {
      const id = targetIdFor(capture);
      if (id && !captures.has(id)) captures.set(id, capture);
    }
    return captures;
  }
  for (const [id, capture] of Object.entries(object(value))) {
    const targetId = targetIdFor(capture) || text(id, 220);
    if (targetId && !captures.has(targetId)) captures.set(targetId, capture);
  }
  return captures;
}

function recordsByTarget(records) {
  const output = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const id = targetIdFor(record);
    if (id && !output.has(id)) output.set(id, record);
  }
  return output;
}

function creatorsByTarget(creators) {
  const output = new Map();
  for (const creator of Array.isArray(creators) ? creators : []) {
    const id = targetIdFor(creator);
    if (id && !output.has(id)) output.set(id, creator);
  }
  return output;
}

function selectedTargetIds({ campaign, contentAnalysisJob, records, creators }) {
  const campaignIds = unique(campaign?.selectedCreatorIds, 10_000);
  if (campaignIds.length) return campaignIds;
  const analysisIds = unique(contentAnalysisJob?.selectedCreatorIds, 10_000);
  if (analysisIds.length) return analysisIds;
  return unique([
    ...records.map((record) => targetIdFor(record)),
    ...creators.map((creator) => targetIdFor(creator)),
  ], 10_000);
}

/**
 * Build a complete draft set for the selected campaign creators. When caller
 * supplied currentCaptures, every missing capture is treated as unavailable.
 */
export function buildEvidenceLockedOutreachDraftBatch(input = {}) {
  const generatedAt = timestamp(input.generatedAt);
  const records = Array.isArray(input.analysisRows)
    ? input.analysisRows
    : (Array.isArray(input.contentAnalysisJob?.results) ? input.contentAnalysisJob.results : []);
  const creators = Array.isArray(input.creators) ? input.creators : [];
  const recordsById = recordsByTarget(records);
  const creatorsById = creatorsByTarget(creators);
  const savedCaptures = capturesByTarget(input.contentAnalysisJob?.sourceCaptures);
  const hasCurrentCaptures = hasOwn(input, 'currentCaptures');
  const currentCaptures = capturesByTarget(input.currentCaptures);
  const targetIds = selectedTargetIds({
    campaign: input.campaign,
    contentAnalysisJob: input.contentAnalysisJob,
    records,
    creators,
  });
  const drafts = targetIds.map((targetId) => {
    const record = recordsById.get(targetId) || null;
    const creator = creatorsById.get(targetId) || record || savedCaptures.get(targetId) || { targetId };
    const draftInput = {
      campaign: input.campaign,
      contentAnalysisJob: input.contentAnalysisJob,
      creator,
      analysisRecord: record,
      generatedAt,
    };
    if (hasCurrentCaptures) draftInput.currentCapture = currentCaptures.get(targetId) || null;
    return buildEvidenceLockedOutreachDraft(draftInput);
  });
  const summary = drafts.reduce((counts, draft) => ({
    ...counts,
    [draft.status]: (counts[draft.status] || 0) + 1,
  }), { total: drafts.length, ready: 0, blocked: 0, stale: 0 });
  return {
    schemaVersion: OUTREACH_DRAFT_BATCH_SCHEMA_VERSION,
    campaignId: text(input.campaign?.id, 220) || null,
    contentAnalysisJobId: text(input.contentAnalysisJob?.id, 220) || null,
    generatedAt,
    drafts,
    summary,
  };
}

/**
 * Update only a draft's editable message/review fields. Source, evidence,
 * multimodal manifest, and draft status stay locked to the analyzed snapshot.
 */
export function updateEvidenceLockedOutreachDraft(draft, patch = {}, { updatedAt = new Date().toISOString() } = {}) {
  const input = object(draft);
  if (input.schemaVersion !== OUTREACH_DRAFT_SCHEMA_VERSION) {
    throw new Error('OUTREACH_DRAFT_INVALID');
  }
  const requestedPatch = object(patch);
  for (const field of ['source', 'evidence', 'multimodalManifest', 'status', 'reason', 'targetId', 'creator']) {
    if (hasOwn(requestedPatch, field)) throw new Error(`OUTREACH_DRAFT_IMMUTABLE_${field}`);
  }
  const next = clone(input);
  const patchTimestamp = timestamp(updatedAt);
  let changed = false;

  const hasMessageBody = hasOwn(requestedPatch, 'messageBody')
    || (hasOwn(requestedPatch, 'message') && hasOwn(object(requestedPatch.message), 'body'));
  if (hasMessageBody) {
    if (next.status !== 'ready') throw new Error('OUTREACH_DRAFT_NOT_READY');
    const body = text(
      hasOwn(requestedPatch, 'messageBody') ? requestedPatch.messageBody : requestedPatch.message.body,
      6_000,
    );
    if (!body) throw new Error('OUTREACH_DRAFT_MESSAGE_EMPTY');
    next.message = { ...object(next.message), body, updatedAt: patchTimestamp };
    changed = true;
  }

  const requestedReviewStatus = text(
    hasOwn(requestedPatch, 'reviewStatus')
      ? requestedPatch.reviewStatus
      : object(requestedPatch.review).status,
    32,
  ).toLowerCase();
  if (requestedReviewStatus) {
    if (!REVIEW_STATUSES.has(requestedReviewStatus)) throw new Error('OUTREACH_DRAFT_REVIEW_STATUS_INVALID');
    if (requestedReviewStatus !== 'draft' && next.status !== 'ready') throw new Error('OUTREACH_DRAFT_NOT_READY');
    if (requestedReviewStatus !== 'draft' && !text(next.message?.body, 6_000)) throw new Error('OUTREACH_DRAFT_MESSAGE_EMPTY');
    next.review = {
      ...object(next.review),
      status: requestedReviewStatus,
      approvedAt: requestedReviewStatus === 'approved' ? patchTimestamp : (next.review?.approvedAt || null),
      sentAt: requestedReviewStatus === 'sent' ? patchTimestamp : (next.review?.sentAt || null),
    };
    changed = true;
  }

  if (changed) next.updatedAt = patchTimestamp;
  return next;
}
