import assert from 'node:assert/strict';
import test from 'node:test';
import { contentInputFingerprint, deriveContentAnalysis } from './content-analysis.mjs';
import {
  OUTREACH_DRAFT_BATCH_SCHEMA_VERSION,
  OUTREACH_DRAFT_SCHEMA_VERSION,
  buildEvidenceLockedOutreachDraft,
  buildEvidenceLockedOutreachDraftBatch,
  resolveOutreachDraftFreshness,
  updateEvidenceLockedOutreachDraft,
} from './outreach-drafts.mjs';

function capture({ targetId = 'creator-1', summary = 'A visible routine and review with practical usage steps.' } = {}) {
  return {
    id: `capture-${targetId}`,
    targetId,
    discoveryCreatorId: targetId,
    channel: 'douyin',
    name: targetId === 'creator-1' ? 'Evidence Creator' : `Creator ${targetId}`,
    sourceUrl: `https://www.douyin.com/user/${targetId}`,
    capturedAt: '2026-07-23T08:00:00.000Z',
    content: {
      visibleSamples: [{
        sourceUrl: `https://www.douyin.com/video/${targetId}-one`,
        title: 'Routine review',
        summary,
        contentType: 'video',
        hashtags: ['skincare', 'routine'],
        interactions: { digg_count: 260, comment_count: 12 },
      }],
    },
  };
}

function analysisRecord({ targetId = 'creator-1', captureSnapshot = capture({ targetId }), includeHook = true } = {}) {
  const evidence = {
    id: 'sample:1:text',
    kind: 'visible_content_text',
    sourceUrl: `https://www.douyin.com/video/${targetId}-one`,
    excerpt: 'A visible routine and review with practical usage steps.',
    sampleIndex: 1,
    observedFields: ['summary'],
    metrics: { publishedAt: '2026-07-22T09:00:00.000Z', startSeconds: 2, endSeconds: 18, timeSeconds: 10 },
  };
  return {
    id: `content-analysis-${targetId}`,
    targetId,
    discoveryCreatorId: targetId,
    channel: 'douyin',
    name: targetId === 'creator-1' ? 'Evidence Creator' : `Creator ${targetId}`,
    sourceUrl: `https://www.douyin.com/user/${targetId}`,
    analyzedAt: '2026-07-23T08:20:00.000Z',
    analysis: {
      capturedAt: '2026-07-23T08:20:00.000Z',
      source: {
        contentCaptureId: captureSnapshot.id,
        contentCapturedAt: captureSnapshot.capturedAt,
        sourceProfileUrl: captureSnapshot.sourceUrl,
        inputFingerprint: contentInputFingerprint(captureSnapshot),
        freshness: 'captured_snapshot',
      },
      evidence: [evidence],
      multimodal: {
        schemaVersion: 'multimodal-evidence/v1',
        attachedImageCount: 1,
        modalities: {
          text: { status: 'observed', count: 1, evidenceIds: ['sample:1:text'] },
          image: { status: 'attached', count: 1, evidenceIds: ['image:1'] },
          audio: { status: 'derived_transcript', count: 1, evidenceIds: ['audio:1'] },
        },
      },
      ...(includeHook ? {
        outreachHook: {
          schemaVersion: 'content-outreach-hook/v1',
          status: 'ready',
          source: {
            evidenceId: evidence.id,
            kind: evidence.kind,
            sampleIndex: evidence.sampleIndex,
            sourceUrl: evidence.sourceUrl,
            excerpt: evidence.excerpt,
            observedFields: evidence.observedFields,
            publishedAt: evidence.metrics.publishedAt,
            startSeconds: evidence.metrics.startSeconds,
            endSeconds: evidence.metrics.endSeconds,
            timeSeconds: evidence.metrics.timeSeconds,
          },
          analysis: {
            roleId: 'outreach_strategy',
            roleLabel: 'Outreach strategy',
            findingId: 'evidence-led-opening',
            statement: 'Start with the observed practical routine and invite a bounded co-creation discussion.',
          },
          evidenceIds: [evidence.id],
        },
      } : {}),
    },
  };
}

const campaign = {
  id: 'campaign-1',
  brief: {
    brand: 'MKT Master',
    product: 'skincare routine launch',
    objective: 'explore a practical tutorial collaboration',
    tone: 'respectful',
  },
  selectedCreatorIds: ['creator-1'],
};

test('builds a ready draft with locked primary evidence, multimodal manifest, and fresh source fingerprint', () => {
  const sourceCapture = capture();
  const record = analysisRecord({ captureSnapshot: sourceCapture });
  const draft = buildEvidenceLockedOutreachDraft({
    campaign,
    contentAnalysisJob: { id: 'analysis-job-1', contentJobId: 'content-job-1' },
    creator: { id: 'creator-1', name: 'Evidence Creator', channel: 'douyin', sourceUrl: sourceCapture.sourceUrl },
    analysisRecord: record,
    currentCapture: sourceCapture,
    generatedAt: '2026-07-23T09:00:00.000Z',
  });

  assert.equal(draft.schemaVersion, OUTREACH_DRAFT_SCHEMA_VERSION);
  assert.equal(draft.status, 'ready');
  assert.equal(draft.reason, null);
  assert.equal(draft.source.freshness, 'current_snapshot');
  assert.equal(draft.source.inputFingerprint, contentInputFingerprint(sourceCapture));
  assert.equal(draft.source.currentInputFingerprint, contentInputFingerprint(sourceCapture));
  assert.deepEqual(draft.evidence.primary, {
    id: 'sample:1:text',
    kind: 'visible_content_text',
    sourceUrl: 'https://www.douyin.com/video/creator-1-one',
    excerpt: 'A visible routine and review with practical usage steps.',
    sampleIndex: 1,
    observedFields: ['summary'],
    publishedAt: '2026-07-22T09:00:00.000Z',
    startSeconds: 2,
    endSeconds: 18,
    timeSeconds: 10,
  });
  assert.deepEqual(draft.evidence.ids, ['sample:1:text']);
  assert.equal(draft.multimodalManifest.modalities.image.status, 'attached');
  assert.match(draft.message.body, /visible routine and review/);
  assert.match(draft.message.body, /skincare routine launch/);
  assert.match(draft.message.body, /practical routine/);
  assert.equal(draft.review.status, 'draft');

  draft.multimodalManifest.modalities.image.status = 'mutated';
  assert.equal(record.analysis.multimodal.modalities.image.status, 'attached');
});

test('accepts the existing deriveContentAnalysis output shape without an adapter', () => {
  const sourceCapture = capture();
  const analysis = deriveContentAnalysis({
    capture: sourceCapture,
    campaignBrief: campaign.brief,
    capturedAt: '2026-07-23T08:20:00.000Z',
  });
  const draft = buildEvidenceLockedOutreachDraft({
    campaign,
    contentAnalysisJob: { id: 'analysis-job-actual', contentJobId: 'content-job-actual' },
    creator: { id: 'creator-1', name: 'Evidence Creator', channel: 'douyin', sourceUrl: sourceCapture.sourceUrl },
    analysisRecord: { targetId: 'creator-1', name: 'Evidence Creator', channel: 'douyin', sourceUrl: sourceCapture.sourceUrl, analysis },
    currentCapture: sourceCapture,
    generatedAt: '2026-07-23T09:00:00.000Z',
  });

  assert.equal(analysis.outreachHook.status, 'ready');
  assert.equal(draft.status, 'ready');
  assert.equal(draft.evidence.primary.id, analysis.outreachHook.source.evidenceId);
  assert.equal(draft.multimodalManifest.schemaVersion, 'multimodal-evidence/v1');
  assert.equal(draft.source.freshness, 'current_snapshot');
});

test('marks a draft stale and clears its body when the source capture fingerprint changes', () => {
  const savedCapture = capture();
  const changedCapture = capture({ summary: 'A new live-shopping format replaced the prior routine review.' });
  const draft = buildEvidenceLockedOutreachDraft({
    campaign,
    analysisRecord: analysisRecord({ captureSnapshot: savedCapture }),
    currentCapture: changedCapture,
    generatedAt: '2026-07-23T09:00:00.000Z',
  });

  assert.equal(draft.status, 'stale');
  assert.equal(draft.reason.code, 'SOURCE_CHANGED');
  assert.equal(draft.message.body, null);
  assert.equal(draft.evidence.primary, null);
  assert.notEqual(draft.source.inputFingerprint, draft.source.currentInputFingerprint);
});

test('blocks missing hooks, missing evidence references, and explicitly unavailable source captures', () => {
  const savedCapture = capture();
  const hookMissing = buildEvidenceLockedOutreachDraft({
    campaign,
    analysisRecord: analysisRecord({ captureSnapshot: savedCapture, includeHook: false }),
    generatedAt: '2026-07-23T09:00:00.000Z',
  });
  assert.equal(hookMissing.status, 'blocked');
  assert.equal(hookMissing.reason.code, 'OUTREACH_HOOK_UNAVAILABLE');

  const recordWithMissingEvidence = analysisRecord({ captureSnapshot: savedCapture });
  recordWithMissingEvidence.analysis.outreachHook.evidenceIds.push('missing:evidence');
  const evidenceMissing = buildEvidenceLockedOutreachDraft({
    campaign,
    analysisRecord: recordWithMissingEvidence,
    generatedAt: '2026-07-23T09:00:00.000Z',
  });
  assert.equal(evidenceMissing.status, 'blocked');
  assert.equal(evidenceMissing.reason.code, 'EVIDENCE_REFERENCE_MISSING');

  const unavailable = buildEvidenceLockedOutreachDraft({
    campaign,
    analysisRecord: analysisRecord({ captureSnapshot: savedCapture }),
    currentCapture: null,
    generatedAt: '2026-07-23T09:00:00.000Z',
  });
  assert.equal(unavailable.status, 'blocked');
  assert.equal(unavailable.reason.code, 'SOURCE_CAPTURE_UNAVAILABLE');
  assert.equal(unavailable.message.body, null);
});

test('builds batch drafts for campaign selection and preserves a blocked row for an unanalyzed creator', () => {
  const savedCapture = capture();
  const firstRecord = analysisRecord({ captureSnapshot: savedCapture });
  const batch = buildEvidenceLockedOutreachDraftBatch({
    campaign: { ...campaign, selectedCreatorIds: ['creator-1', 'creator-2'] },
    contentAnalysisJob: {
      id: 'analysis-job-1',
      contentJobId: 'content-job-1',
      selectedCreatorIds: ['creator-1', 'creator-2'],
      sourceCaptures: [savedCapture, capture({ targetId: 'creator-2' })],
      results: [firstRecord],
    },
    creators: [
      { id: 'creator-1', name: 'Evidence Creator', channel: 'douyin', sourceUrl: savedCapture.sourceUrl },
      { id: 'creator-2', name: 'Missing Analysis Creator', channel: 'xiaohongshu', sourceUrl: 'https://www.xiaohongshu.com/user/creator-2' },
    ],
    analysisRows: [firstRecord],
    currentCaptures: [savedCapture, capture({ targetId: 'creator-2' })],
    generatedAt: '2026-07-23T09:00:00.000Z',
  });

  assert.equal(batch.schemaVersion, OUTREACH_DRAFT_BATCH_SCHEMA_VERSION);
  assert.equal(batch.drafts.length, 2);
  assert.deepEqual(batch.drafts.map((draft) => draft.targetId), ['creator-1', 'creator-2']);
  assert.equal(batch.drafts[0].status, 'ready');
  assert.equal(batch.drafts[1].status, 'blocked');
  assert.equal(batch.drafts[1].reason.code, 'ANALYSIS_RECORD_MISSING');
  assert.deepEqual(batch.summary, { total: 2, ready: 1, blocked: 1, stale: 0 });
});

test('resolves saved freshness and permits only body/review edits without changing evidence locks', () => {
  const savedCapture = capture();
  const record = analysisRecord({ captureSnapshot: savedCapture });
  const freshness = resolveOutreachDraftFreshness({ analysisRecord: record });
  assert.equal(freshness.freshness, 'captured_snapshot');
  assert.equal(freshness.currentInputFingerprint, null);

  const draft = buildEvidenceLockedOutreachDraft({
    campaign,
    analysisRecord: record,
    generatedAt: '2026-07-23T09:00:00.000Z',
  });
  const updated = updateEvidenceLockedOutreachDraft(draft, {
    messageBody: '你好，想和你聊聊这条实用内容的共创方式。',
    reviewStatus: 'sent',
  }, { updatedAt: '2026-07-23T09:30:00.000Z' });
  assert.equal(updated.message.body, '你好，想和你聊聊这条实用内容的共创方式。');
  assert.equal(updated.review.status, 'sent');
  assert.equal(updated.review.sentAt, '2026-07-23T09:30:00.000Z');
  assert.equal(updated.updatedAt, '2026-07-23T09:30:00.000Z');
  assert.deepEqual(updated.evidence, draft.evidence);
  assert.deepEqual(updated.source, draft.source);
  assert.throws(() => updateEvidenceLockedOutreachDraft(updated, { evidence: { ids: [] } }), /OUTREACH_DRAFT_IMMUTABLE_evidence/);

  const stale = buildEvidenceLockedOutreachDraft({
    campaign,
    analysisRecord: record,
    currentCapture: capture({ summary: 'Changed snapshot.' }),
    generatedAt: '2026-07-23T09:00:00.000Z',
  });
  assert.throws(() => updateEvidenceLockedOutreachDraft(stale, { reviewStatus: 'sent' }), /OUTREACH_DRAFT_NOT_READY/);
});
