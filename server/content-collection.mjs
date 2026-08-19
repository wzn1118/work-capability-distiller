import { createHash } from 'node:crypto';
import { deriveCreatorPersona } from './enrichment.mjs';

const CONTENT_ITEM_LEDGER_SCHEMA_VERSION = 2;
const SEMANTIC_SEGMENT_SCHEMA_VERSION = 1;
const MAX_SEMANTIC_SEGMENT_TEXT = 480;
const MAX_SEMANTIC_SEGMENT_EXCERPT = 240;
const MAX_SEMANTIC_SOURCE_TEXT = 16_000;

export function contentCollectionWorkerCount({ requested, pendingCount, platformModes = [] } = {}) {
  const requestedWorkers = Number(requested);
  const pending = Math.max(1, Math.floor(Number(pendingCount) || 1));
  const configuredWorkers = Math.max(
    1,
    Number.isFinite(requestedWorkers) ? Math.floor(requestedWorkers) : 1,
  );
  const relayOwnsNavigation = platformModes.some((mode) => String(mode || '').toLowerCase() === 'browser_relay');
  return Math.min(relayOwnsNavigation ? 1 : configuredWorkers, pending);
}

export function contentCollectionReportedPhase(strategy, phase) {
  if (strategy !== 'breadth_first_full') return 'content';
  return phase === 'catalog' ? 'catalog_detail' : phase;
}

export function contentCollectionFollowUpPhase({
  strategy,
  phase,
  connectionPaused = false,
  completedPhases = [],
} = {}) {
  const completed = new Set(Array.isArray(completedPhases) ? completedPhases : []);
  if (
    strategy === 'breadth_first_full'
    && phase === 'catalog'
    && !connectionPaused
    && completed.has('catalog')
    && !completed.has('detail')
  ) {
    return 'detail';
  }
  return null;
}

export function contentDetailPriorityOrder(items, visibleCountByTarget) {
  const entries = Array.isArray(items) ? items : [];
  const countFor = (entry) => {
    const targetId = entry?.item?.target?.targetId;
    const raw = visibleCountByTarget instanceof Map
      ? visibleCountByTarget.get(targetId)
      : visibleCountByTarget?.[targetId];
    const count = Number(raw);
    return Number.isFinite(count) && count >= 0 ? count : Number.POSITIVE_INFINITY;
  };
  return entries
    .map((entry, position) => ({ entry, position, count: countFor(entry) }))
    .sort((left, right) => left.count - right.count || left.position - right.position)
    .map(({ entry }) => entry);
}

function text(value, maximum = 240) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function visibleSamples(persona) {
  return Array.isArray(persona?.content?.visibleSamples)
    ? persona.content.visibleSamples
    : [];
}

function publicContentUrl(value) {
  const raw = text(value, 2_000);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return '';
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname || '/'}`;
  } catch {
    return '';
  }
}

function canonicalContentIdentifier(channel, sourceUrl, sample, sampleIndex) {
  const fallback = [
    sampleIndex,
    text(sample?.title, 180),
    text(sample?.publishedAtIso || sample?.publishedAt, 80),
    text(sample?.summary || sample?.detailText, 320),
  ].join('|');
  const fingerprint = createHash('sha256')
    .update(`${text(channel, 80).toLowerCase()}|${sourceUrl || fallback}`)
    .digest('hex')
    .slice(0, 20);
  return `public-content-${fingerprint}`;
}

function ledgerEntryIdentifier(channel, canonicalContentId, sampleIndex) {
  const fingerprint = createHash('sha256')
    .update(`${text(channel, 80).toLowerCase()}|${canonicalContentId}|${sampleIndex}`)
    .digest('hex')
    .slice(0, 20);
  return `public-content-entry-${fingerprint}`;
}

function videoCandidate(sample, channel, sourceUrl) {
  const contentType = text(sample?.contentType, 80).toLowerCase();
  if (/video|short|reel|clip/.test(contentType)) return true;
  return ['douyin', 'bilibili'].includes(text(channel, 80).toLowerCase())
    && /\/video\//i.test(sourceUrl);
}

function publicInteractions(sample) {
  const source = sample?.interactions && typeof sample.interactions === 'object' && !Array.isArray(sample.interactions)
    ? sample.interactions
    : {};
  return Object.fromEntries(Object.entries(source)
    .filter(([, value]) => Number.isFinite(value) && value >= 0));
}

function observedText(value, maximum = MAX_SEMANTIC_SOURCE_TEXT) {
  if (typeof value === 'string') return value.trim().slice(0, maximum);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function observedBooleanText(value) {
  return typeof value === 'boolean' ? String(value) : '';
}

function observedTextFromFields(sample, fields, maximum = MAX_SEMANTIC_SOURCE_TEXT) {
  for (const field of fields) {
    const value = observedText(sample?.[field], maximum);
    if (value) return { field, value };
  }
  return { field: null, value: '' };
}

function observedTextList(value, maximum = 80) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,\uFF0C;\uFF1B]/u)
      : [];
  const seen = new Set();
  const values = [];
  for (const entry of raw) {
    const item = observedText(entry, MAX_SEMANTIC_SEGMENT_TEXT);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(item);
    if (values.length >= maximum) break;
  }
  return values;
}

function observedTextListFromFields(sample, fields, maximum = 80) {
  for (const field of fields) {
    const values = observedTextList(sample?.[field], maximum);
    if (values.length) return { field, values };
  }
  return { field: null, values: [] };
}

function splitLongSemanticFragment(value) {
  const source = observedText(value, MAX_SEMANTIC_SOURCE_TEXT);
  if (!source) return [];
  if (source.length <= MAX_SEMANTIC_SEGMENT_TEXT) return [source];

  const fragments = [];
  let remaining = source;
  const minimumPreferredBreak = Math.floor(MAX_SEMANTIC_SEGMENT_TEXT * 0.45);
  while (remaining.length > MAX_SEMANTIC_SEGMENT_TEXT) {
    const window = remaining.slice(0, MAX_SEMANTIC_SEGMENT_TEXT);
    const preferredBreak = Math.max(
      window.lastIndexOf(' '),
      window.lastIndexOf('\uFF0C'),
      window.lastIndexOf(','),
      window.lastIndexOf('\u3001'),
      window.lastIndexOf('\uFF1A'),
      window.lastIndexOf(':'),
    );
    const end = preferredBreak >= minimumPreferredBreak ? preferredBreak + 1 : MAX_SEMANTIC_SEGMENT_TEXT;
    const fragment = remaining.slice(0, end).trim();
    if (fragment) fragments.push(fragment);
    remaining = remaining.slice(end).trim();
  }
  if (remaining) fragments.push(remaining);
  return fragments;
}

function splitObservedSentences(value) {
  const source = observedText(value, MAX_SEMANTIC_SOURCE_TEXT);
  if (!source) return [];
  const fragments = [];
  let current = '';
  for (const character of source) {
    if (character === '\r') continue;
    if (character === '\n') {
      if (current.trim()) fragments.push(current.trim());
      current = '';
      continue;
    }
    current += character;
    if ('\u3002\uFF01\uFF1F!?\uFF1B;.'.includes(character)) {
      if (current.trim()) fragments.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) fragments.push(current.trim());
  return fragments.flatMap(splitLongSemanticFragment);
}

function semanticSegmentIdentifier(canonicalContentId, kind, sourceFields, occurrence, value) {
  const fingerprint = createHash('sha256')
    .update([
      canonicalContentId,
      kind,
      sourceFields.join(','),
      occurrence,
      value,
    ].join('|'))
    .digest('hex')
    .slice(0, 20);
  return `public-content-segment-${fingerprint}`;
}

function observedMetadataEntries(sample) {
  const entries = [];
  const add = (metadataKey, sourceField, value) => {
    const observed = observedText(value, MAX_SEMANTIC_SEGMENT_TEXT);
    if (observed) entries.push({ metadataKey, sourceField, value: observed });
  };
  add('content_type', 'contentType', sample?.contentType);
  add('content_format', 'contentFormat', sample?.contentFormat);
  if (observedText(sample?.publishedAtIso, 80)) {
    add('published_at', 'publishedAtIso', sample.publishedAtIso);
  } else {
    add('published_at', 'publishedAt', sample?.publishedAt);
  }
  add('published_time_text', 'publishedTimeText', sample?.publishedTimeText);
  add('duration_seconds', 'durationSeconds', sample?.durationSeconds);
  add('image_count', 'imageCount', sample?.imageCount);
  add('has_video', 'hasVideo', observedBooleanText(sample?.hasVideo));
  add('is_pinned', 'isPinned', observedBooleanText(sample?.isPinned));

  for (const [metadataKey, sourceField] of [
    ['commercial_marker', 'commercialMarkers'],
    ['brand_mention', 'brandMentions'],
    ['public_risk_flag', 'publicRiskFlags'],
  ]) {
    for (const value of observedTextList(sample?.[sourceField])) add(metadataKey, sourceField, value);
  }

  for (const [metric, value] of Object.entries(publicInteractions(sample)).sort(([left], [right]) => left.localeCompare(right))) {
    add(`interaction.${metric}`, `interactions.${metric}`, value);
  }
  return entries;
}

// This is deliberately evidence-only. It stores observed public text and public
// metadata in stable, extensible units without inferring a topic or a timeline.
export function buildPublicContentSemanticSegments({ sample, canonicalContentId } = {}) {
  const subjectId = observedText(canonicalContentId, 180) || 'unidentified-public-content';
  const segments = [];
  const occurrences = new Map();
  const add = ({ kind, value, sourceFields, metadataKey = null }) => {
    const segmentText = observedText(value, MAX_SEMANTIC_SEGMENT_TEXT);
    if (!segmentText) return;
    const fields = Array.from(new Set((Array.isArray(sourceFields) ? sourceFields : [])
      .map((field) => observedText(field, 80))
      .filter(Boolean)));
    if (!fields.length) return;
    const occurrenceKey = `${kind}|${fields.join(',')}|${segmentText}`;
    const occurrence = occurrences.get(occurrenceKey) || 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    segments.push({
      id: semanticSegmentIdentifier(subjectId, kind, fields, occurrence, segmentText),
      kind,
      sequence: segments.length + 1,
      text: segmentText,
      excerpt: observedText(segmentText, MAX_SEMANTIC_SEGMENT_EXCERPT),
      sourceFields: fields,
      startSeconds: null,
      endSeconds: null,
      status: 'observed',
      ...(metadataKey ? { metadataKey } : {}),
    });
  };

  const title = observedTextFromFields(sample, ['title', 'name', 'caption'], 1_200);
  if (title.value) add({ kind: 'title', value: title.value, sourceFields: [title.field] });

  const body = observedTextFromFields(sample, [
    'detailText', 'detail_text', 'body', 'description', 'caption', 'summary',
  ]);
  for (const sentence of splitObservedSentences(body.value)) {
    add({ kind: 'body_sentence', value: sentence, sourceFields: [body.field] });
  }

  const hashtags = observedTextListFromFields(sample, ['hashtags', 'tags']);
  for (const hashtag of hashtags.values) {
    add({ kind: 'hashtag', value: hashtag, sourceFields: [hashtags.field] });
  }

  for (const metadata of observedMetadataEntries(sample)) {
    add({
      kind: 'metadata',
      value: metadata.value,
      sourceFields: [metadata.sourceField],
      metadataKey: metadata.metadataKey,
    });
  }
  return segments;
}

// Keep per-item collection state independent from downstream semantic analysis.
// The visible sample remains the canonical public text record; this ledger only
// adds stable identity, availability, and scheduling facts for bulk processing.
export function buildPublicContentItemLedger({ samples, channel, requestedContentLimit = null } = {}) {
  const values = Array.isArray(samples) ? samples : [];
  const seenPublicUrls = new Map();
  const items = values.map((sample, index) => {
    const sampleIndex = index + 1;
    const sourceUrl = publicContentUrl(sample?.sourceUrl);
    const duplicateOf = sourceUrl ? seenPublicUrls.get(sourceUrl) || null : null;
    const canonicalContentId = canonicalContentIdentifier(channel, sourceUrl, sample, sampleIndex);
    const id = ledgerEntryIdentifier(channel, canonicalContentId, sampleIndex);
    if (sourceUrl && !duplicateOf) seenPublicUrls.set(sourceUrl, { sampleIndex, id, canonicalContentId });
    const hasPublicSource = Boolean(sourceUrl);
    const status = !hasPublicSource
      ? 'unavailable_source_url'
      : duplicateOf
        ? 'duplicate_visible_reference'
        : 'collected';
    const isVideo = hasPublicSource && !duplicateOf && videoCandidate(sample, channel, sourceUrl);
    const semanticSegments = buildPublicContentSemanticSegments({
      sample,
      canonicalContentId,
    });
    return {
      id,
      canonicalContentId,
      sampleIndex,
      sourceUrl,
      contentType: text(sample?.contentType, 80) || null,
      title: text(sample?.title, 180) || null,
      publishedAt: text(sample?.publishedAtIso || sample?.publishedAt, 80) || null,
      durationSeconds: Number.isFinite(sample?.durationSeconds) ? sample.durationSeconds : null,
      isPinned: sample?.isPinned === true,
      interactions: publicInteractions(sample),
      videoCandidate: isVideo,
      status,
      analysisStatus: status === 'collected' ? 'pending' : status === 'duplicate_visible_reference' ? 'deduplicated' : 'not_available',
      videoAnalysisStatus: isVideo ? 'pending' : 'not_applicable',
      semanticSegmentSchemaVersion: SEMANTIC_SEGMENT_SCHEMA_VERSION,
      semanticSegments,
      segmentStatus: semanticSegments.length ? 'segmented' : 'not_available',
      segmentCount: semanticSegments.length,
      // Timed video evidence is collected separately. Keeping this distinct from
      // the observed static segments makes later ASR/frame segmentation additive.
      timedSegmentStatus: isVideo ? 'pending_video_evidence' : 'not_applicable',
      timedSegmentCount: 0,
      unavailableReason: !hasPublicSource
        ? 'No usable public content URL was present in the rendered profile item.'
        : null,
      duplicateOfSampleIndex: duplicateOf?.sampleIndex || null,
      duplicateOfContentItemId: duplicateOf?.id || null,
      evidence: {
        scope: 'visible_public_profile_content',
        capturedFromSampleIndex: sampleIndex,
      },
    };
  });
  const uniqueItems = items.filter((item) => item.status === 'collected');
  const unavailableItems = items.filter((item) => item.status === 'unavailable_source_url');
  const duplicateItems = items.filter((item) => item.status === 'duplicate_visible_reference');
  const segmentedItems = items.filter((item) => item.segmentCount > 0);
  const segmentKindCounts = {};
  const segmentStatusCounts = {};
  for (const item of items) {
    segmentStatusCounts[item.segmentStatus] = (segmentStatusCounts[item.segmentStatus] || 0) + 1;
    for (const segment of item.semanticSegments) {
      segmentKindCounts[segment.kind] = (segmentKindCounts[segment.kind] || 0) + 1;
    }
  }
  const requestedLimit = Number.isFinite(requestedContentLimit) ? requestedContentLimit : null;
  return {
    schemaVersion: CONTENT_ITEM_LEDGER_SCHEMA_VERSION,
    scope: 'visible_public_profile_content',
    requestedSampleLimit: requestedLimit,
    observedVisibleSampleCount: values.length,
    uniquePublicContentCount: uniqueItems.length,
    duplicateVisibleReferenceCount: duplicateItems.length,
    unavailableContentCount: unavailableItems.length,
    pendingAnalysisCount: uniqueItems.length,
    publicVideoCandidateCount: uniqueItems.filter((item) => item.videoCandidate).length,
    semanticSegmentSchemaVersion: SEMANTIC_SEGMENT_SCHEMA_VERSION,
    totalSegmentCount: items.reduce((sum, item) => sum + item.segmentCount, 0),
    segmentedItemCount: segmentedItems.length,
    unsegmentedItemCount: items.length - segmentedItems.length,
    pendingTimedExpansionItemCount: items.filter((item) => item.timedSegmentStatus === 'pending_video_evidence').length,
    timedSegmentCount: 0,
    segmentStatusCounts,
    segmentKindCounts,
    status: uniqueItems.length
      ? (unavailableItems.length ? 'partial' : 'collected')
      : (values.length ? 'completed_empty' : 'completed_empty'),
    items,
  };
}

function collectionStopReason(collectionMeta) {
  return text(
    collectionMeta?.stop_reason
      || collectionMeta?.stopReason
      || collectionMeta?.completion_reason
      || collectionMeta?.completionReason,
    120,
  ).toLowerCase();
}

function continuationRecommendation(collectionMeta, stopReason) {
  const stopEvidence = collectionMeta?.stop_evidence && typeof collectionMeta.stop_evidence === 'object'
    ? collectionMeta.stop_evidence
    : collectionMeta?.stopEvidence && typeof collectionMeta.stopEvidence === 'object'
      ? collectionMeta.stopEvidence
      : null;
  const signals = [
    { value: collectionMeta?.continuation_recommended, source: 'collection_meta.continuation_recommended' },
    { value: collectionMeta?.continuationRecommended, source: 'collection_meta.continuationRecommended' },
    { value: stopEvidence?.continuation_recommended, source: 'stop_evidence.continuation_recommended' },
    { value: stopEvidence?.continuationRecommended, source: 'stop_evidence.continuationRecommended' },
  ];
  const explicitRecommendation = signals.find((signal) => signal.value === true);
  if (explicitRecommendation) {
    return {
      recommended: true,
      evidenceSource: explicitRecommendation.source,
    };
  }

  const retryableStopReason = stopReason === 'retryable' || stopReason.endsWith('_retryable');
  return {
    recommended: retryableStopReason,
    evidenceSource: retryableStopReason ? 'stop_reason' : null,
  };
}

function collectionMetaStopEvidence(collectionMeta) {
  if (collectionMeta?.stop_evidence && typeof collectionMeta.stop_evidence === 'object') {
    return collectionMeta.stop_evidence;
  }
  if (collectionMeta?.stopEvidence && typeof collectionMeta.stopEvidence === 'object') {
    return collectionMeta.stopEvidence;
  }
  return null;
}

function collectionMetaValue(collectionMeta, names) {
  const sources = [collectionMeta, collectionMetaStopEvidence(collectionMeta)];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const name of names) {
      if (source[name] !== undefined && source[name] !== null) return source[name];
    }
  }
  return null;
}

function collectionMetaBoolean(collectionMeta, names) {
  const value = collectionMetaValue(collectionMeta, names);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function collectionMetaCount(collectionMeta, names) {
  const value = Number(collectionMetaValue(collectionMeta, names));
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function contentCollectionCoverage(ledger, collectionMeta, requestedContentLimit) {
  const stopReason = collectionStopReason(collectionMeta);
  const requestedLimit = Number.isFinite(requestedContentLimit)
    ? Math.max(0, Math.trunc(requestedContentLimit))
    : collectionMetaCount(collectionMeta, [
      'requested_content_sample_limit',
      'content_sample_limit',
      'requestedContentSampleLimit',
      'contentSampleLimit',
    ]);
  const continuation = continuationRecommendation(collectionMeta, stopReason);
  const continuationRecommended = continuation.recommended;
  const explicitPageExhausted = collectionMetaBoolean(collectionMeta, [
    'public_profile_pages_exhausted',
    'page_exhausted',
    'pageExhausted',
  ]);
  const pageExhausted = explicitPageExhausted ?? [
    'page_exhausted',
    'profile_page_exhausted',
    'public_page_exhausted',
  ].includes(stopReason);
  const explicitSampleLimitReached = collectionMetaBoolean(collectionMeta, [
    'requested_limit_reached',
    'sample_limit_reached',
    'requestedLimitReached',
    'sampleLimitReached',
  ]);
  const sampleLimitReached = explicitSampleLimitReached ?? ([
    'target_reached',
    'sample_limit_reached',
    'profile_sample_limit_reached',
    'requested_limit_reached',
  ].includes(stopReason)
    || (!pageExhausted && !continuationRecommended && requestedLimit !== null
      && ledger.observedVisibleSampleCount >= requestedLimit));
  const completion = continuationRecommended
    ? 'retryable'
    : pageExhausted
      ? 'page_exhausted'
      : sampleLimitReached
        ? 'sample_limit_reached'
        : ledger.observedVisibleSampleCount
          ? 'completed_without_explicit_stop_reason'
          : 'completed_empty';
  const coverageState = continuationRecommended
    ? 'resumable'
    : pageExhausted
      ? 'page_exhausted'
      : sampleLimitReached
        ? 'requested_limit_reached'
        : ledger.observedVisibleSampleCount
          ? 'terminal_state_unconfirmed'
          : 'no_visible_content_returned';
  const morePublicContentMayBeAvailable = pageExhausted
    ? false
    : (sampleLimitReached || continuationRecommended ? true : null);
  const sourceReportedVisibleSampleCount = collectionMetaCount(collectionMeta, [
    'returned_visible_content_samples',
    'returnedVisibleContentSamples',
    'returned_visible_sample_count',
    'returnedVisibleSampleCount',
    'observed_profile_card_count',
    'observedVisibleSampleCount',
  ]);
  return {
    completion,
    stopReason: stopReason || null,
    continuationRecommended,
    continuationEvidenceSource: continuation.evidenceSource,
    resumeState: continuationRecommended
      ? 'continuation_recommended'
      : sampleLimitReached && !pageExhausted
        ? 'increase_sample_limit_to_continue'
        : pageExhausted
          ? 'not_recommended'
          : 'stop_state_unconfirmed',
    coverageState,
    nextCollectionAction: continuationRecommended
      ? 'resume_collection'
      : sampleLimitReached && !pageExhausted
        ? 'increase_sample_limit'
        : pageExhausted
          ? 'none'
          : 'inspect_stop_evidence',
    requestedSampleLimit: requestedLimit,
    returnedVisibleSampleCount: ledger.observedVisibleSampleCount,
    sourceReportedVisibleSampleCount,
    observedVisibleSampleCount: ledger.observedVisibleSampleCount,
    uniquePublicContentCount: ledger.uniquePublicContentCount,
    duplicateVisibleReferenceCount: ledger.duplicateVisibleReferenceCount,
    unavailableContentCount: ledger.unavailableContentCount,
    pageExhausted,
    sampleLimitReached,
    requestedLimitReached: sampleLimitReached,
    morePublicContentMayBeAvailable,
  };
}

export function contentCaptureVisibleSampleCount(capture) {
  const uniqueCount = capture?.content?.itemLedger?.uniquePublicContentCount;
  if (Number.isFinite(uniqueCount) && uniqueCount >= 0) return uniqueCount;
  return Array.isArray(capture?.content?.visibleSamples)
    ? capture.content.visibleSamples.length
    : 0;
}

function observedValue(previous, next) {
  if (typeof next === 'string') return next.trim() ? next : previous;
  if (typeof next === 'number') return Number.isFinite(next) ? next : previous;
  if (typeof next === 'boolean') return next;
  if (Array.isArray(next)) return next.length ? next : (Array.isArray(previous) ? previous : []);
  if (next && typeof next === 'object') {
    const before = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
    return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(next)])]
      .map((key) => [key, observedValue(before[key], next[key])]));
  }
  return next === null || next === undefined ? previous : next;
}

function mergedVisibleSamples(previousCapture, nextCapture) {
  const merged = [];
  const positions = new Map();
  const add = (sample) => {
    const sourceUrl = publicContentUrl(sample?.sourceUrl);
    const key = sourceUrl || text(sample?.contentItemId, 180);
    if (key && positions.has(key)) {
      const position = positions.get(key);
      merged[position] = observedValue(merged[position], sample);
      return;
    }
    if (key) positions.set(key, merged.length);
    merged.push(sample);
  };
  visibleSamples(previousCapture).forEach(add);
  visibleSamples(nextCapture).forEach(add);
  return merged;
}

// Browser profiles can temporarily render an empty grid during a retry. A
// refresh is additive and must not erase evidence committed by an earlier pass.
export function mergeCreatorContentCaptures(previousCapture, nextCapture) {
  if (!previousCapture) return nextCapture;
  if (!nextCapture) return previousCapture;
  const previousTargetId = text(previousCapture?.targetId || previousCapture?.discoveryCreatorId, 180);
  const nextTargetId = text(nextCapture?.targetId || nextCapture?.discoveryCreatorId, 180);
  if (!previousTargetId || previousTargetId !== nextTargetId) return nextCapture;

  const samples = mergedVisibleSamples(previousCapture, nextCapture);
  const requestedContentLimit = [
    previousCapture?.content?.requestedSampleLimit,
    nextCapture?.content?.requestedSampleLimit,
  ].filter(Number.isFinite).reduce((maximum, value) => Math.max(maximum, value), 0) || null;
  const itemLedger = buildPublicContentItemLedger({
    samples,
    channel: nextCapture.channel || previousCapture.channel,
    requestedContentLimit,
  });
  const annotatedSamples = samples.map((sample, index) => {
    const item = itemLedger.items[index];
    return {
      ...sample,
      contentItemId: item?.id || sample?.contentItemId || null,
      collectionStatus: item?.status || sample?.collectionStatus || 'not_available',
      analysisStatus: sample?.analysisStatus || item?.analysisStatus || 'not_available',
      videoAnalysisStatus: sample?.videoAnalysisStatus || item?.videoAnalysisStatus || 'not_applicable',
      contentSegments: Array.isArray(sample?.contentSegments) && sample.contentSegments.length
        ? sample.contentSegments
        : (Array.isArray(item?.semanticSegments) ? item.semanticSegments : []),
      segmentStatus: sample?.segmentStatus || item?.segmentStatus || 'not_available',
      segmentCount: Number.isFinite(sample?.segmentCount) ? sample.segmentCount : (item?.segmentCount || 0),
      timedSegmentStatus: sample?.timedSegmentStatus || item?.timedSegmentStatus || 'not_applicable',
      timedSegmentCount: Number.isFinite(sample?.timedSegmentCount) ? sample.timedSegmentCount : 0,
      unavailableReason: item?.unavailableReason || sample?.unavailableReason || null,
      duplicateOfSampleIndex: item?.duplicateOfSampleIndex || null,
      duplicateOfContentItemId: item?.duplicateOfContentItemId || null,
    };
  });
  const { items: _items, ...itemLedgerSummary } = itemLedger;
  const collectionMeta = nextCapture?.evidence?.collectionMeta
    || previousCapture?.evidence?.collectionMeta
    || null;
  const profile = observedValue(previousCapture.profile, nextCapture.profile);
  if (profile?.missingReasons) {
    if (Number.isFinite(profile.followerCount)) profile.missingReasons.followers = null;
    if (Number.isFinite(profile.followingCount)) profile.missingReasons.following = null;
    if (Number.isFinite(profile.totalLikes)) profile.missingReasons.totalLikes = null;
    if (Number.isFinite(profile.workCount)) profile.missingReasons.works = null;
  }
  const content = observedValue(previousCapture.content, nextCapture.content);
  content.visibleSamples = annotatedSamples;
  content.visibleSampleCount = annotatedSamples.length;
  content.reportedVisibleSampleCount = Math.max(
    Number(previousCapture?.content?.reportedVisibleSampleCount) || 0,
    Number(nextCapture?.content?.reportedVisibleSampleCount) || 0,
    annotatedSamples.length,
  );
  content.requestedSampleLimit = requestedContentLimit;
  content.itemLedger = itemLedgerSummary;
  content.collectionCoverage = contentCollectionCoverage(itemLedger, collectionMeta, requestedContentLimit);

  return {
    ...observedValue(previousCapture, nextCapture),
    capturedAt: nextCapture.capturedAt || previousCapture.capturedAt,
    status: annotatedSamples.length ? 'collected' : (nextCapture.status || previousCapture.status || 'completed_empty'),
    profile,
    content,
  };
}

export function contentResumeCompletedPhases({ strategy, completedPhases, resumable } = {}) {
  const phases = [...new Set((Array.isArray(completedPhases) ? completedPhases : [])
    .filter((phase) => typeof phase === 'string' && phase.trim())
    .map((phase) => phase.trim()))];
  if (strategy !== 'breadth_first_full' || resumable !== true) return phases;
  return phases.filter((phase) => phase === 'profile');
}

// A discovery card can establish the first account-metric snapshot without a
// second browser navigation. Catalog and detail phases still visit the public
// profile and replace this baseline with richer observations.
export function discoveryCardProfileBaselineResult(creator, capturedAt = new Date().toISOString()) {
  const hasFollowerCount = Number.isFinite(creator?.followers) && creator.followers >= 0;
  const hasProfileLikes = Number.isFinite(creator?.profileLikes) && creator.profileLikes >= 0;
  if (!hasFollowerCount && !hasProfileLikes) return null;

  const sourceUrl = text(creator?.sourceUrl, 1200);
  const observedName = text(creator?.name, 120);
  const record = {
    observed_name: observedName,
    author: observedName,
    author_profile: sourceUrl,
    handle: text(creator?.handle, 140),
    avatar_url: text(creator?.avatar, 1200),
  };
  return {
    source: 'saved_discovery_public_card',
    sourceUrl,
    records: [record],
    collectionMeta: {
      mode: 'content',
      collection_phase: 'profile',
      completion: 'discovery_card_baseline',
      stop_reason: 'saved_discovery_profile_metrics_committed',
      continuation_recommended: false,
      public_data_scope: 'discovery_card',
      captured_at: capturedAt,
      metric_source: 'saved_discovery_public_card',
    },
    confirmation: {
      status: 'confirmed',
      expectedName: observedName,
      observedName,
      matchMethod: 'saved_discovery_profile_identity',
    },
    outcome: 'succeeded',
    truncated: false,
  };
}

// Keep a content refresh independent from persona enrichment while preserving the
// same normalized public-content shape and field-level provenance.
export function deriveCreatorContentCapture({
  creator,
  records,
  source = 'browser_relay',
  collectionMeta = null,
  confirmation = null,
  requestedContentLimit = null,
  capturedAt = new Date().toISOString(),
}) {
  const contentLimit = Number.isFinite(requestedContentLimit) ? requestedContentLimit : null;
  const persona = deriveCreatorPersona({
    creator,
    records,
    source,
    collectionMeta,
    visibleContentSampleLimit: contentLimit,
    capturedAt,
  });
  const samples = visibleSamples(persona);
  const itemLedger = buildPublicContentItemLedger({
    samples,
    channel: creator?.channel,
    requestedContentLimit: contentLimit,
  });
  const collectionCoverage = contentCollectionCoverage(itemLedger, collectionMeta, contentLimit);
  const annotatedSamples = samples.map((sample, index) => {
    const item = itemLedger.items[index];
    return {
      ...sample,
      contentItemId: item?.id || null,
      collectionStatus: item?.status || 'not_available',
      analysisStatus: item?.analysisStatus || 'not_available',
      videoAnalysisStatus: item?.videoAnalysisStatus || 'not_applicable',
      contentSegments: Array.isArray(item?.semanticSegments) ? item.semanticSegments : [],
      segmentStatus: item?.segmentStatus || 'not_available',
      segmentCount: Number.isFinite(item?.segmentCount) ? item.segmentCount : 0,
      timedSegmentStatus: item?.timedSegmentStatus || 'not_applicable',
      timedSegmentCount: Number.isFinite(item?.timedSegmentCount) ? item.timedSegmentCount : 0,
      unavailableReason: item?.unavailableReason || null,
      duplicateOfSampleIndex: item?.duplicateOfSampleIndex || null,
      duplicateOfContentItemId: item?.duplicateOfContentItemId || null,
    };
  });
  const { items: _duplicateLedgerItems, ...itemLedgerSummary } = itemLedger;
  const sourceUrl = text(persona.sourceUrl, 1200) || text(creator?.sourceUrl, 1200);
  const targetId = text(creator?.id, 180);
  const observedName = text(confirmation?.observedName, 120) || persona.name;
  const expectedName = text(confirmation?.expectedName, 120) || text(creator?.name, 120);

  return {
    schemaVersion: 1,
    id: `${targetId}-content-capture`,
    targetId,
    discoveryCreatorId: targetId,
    channel: creator.channel,
    platform: creator.platform || creator.channel,
    identityKey: persona.identityKey || creator.identityKey,
    name: persona.name || creator.name,
    handle: persona.handle || creator.handle || null,
    sourceUrl,
    capturedAt,
    status: samples.length ? 'collected' : 'completed_empty',
    profileConfirmation: {
      status: 'confirmed',
      expectedName,
      observedName,
      matchMethod: text(confirmation?.matchMethod, 80) || 'direct_profile_url',
    },
    content: {
      ...persona.content,
      visibleSamples: annotatedSamples,
      visibleSampleCount: samples.length,
      reportedVisibleSampleCount: Number.isFinite(persona.content?.visibleSampleCount)
        ? persona.content.visibleSampleCount
        : samples.length,
      requestedSampleLimit: contentLimit,
      itemLedger: itemLedgerSummary,
      collectionCoverage,
    },
    profile: persona.profile,
    audience: persona.audience,
    performance: persona.performance,
    commercial: persona.commercial,
    risk: persona.risk,
    quality: persona.quality,
    provenance: {
      schemaVersion: persona.provenance?.schemaVersion || 1,
      source: persona.provenance?.source || {
        collector: source,
        capturedAt,
        publicDataScope: persona.evidence?.publicDataScope || 'profile',
        rawRecordCount: Array.isArray(records) ? records.length : 0,
      },
      dimensions: {
        contentStrategy: persona.provenance?.dimensions?.contentStrategy || {},
        engagement: persona.provenance?.dimensions?.engagement || {},
        commercial: persona.provenance?.dimensions?.commercial || {},
        risk: persona.provenance?.dimensions?.risk || {},
        dataQuality: persona.provenance?.dimensions?.dataQuality || {},
      },
    },
    evidence: {
      source,
      sourceProfileUrl: text(persona.evidence?.profileUrl, 1200) || sourceUrl,
      targetSourceUrl: text(creator?.sourceUrl, 1200),
      capturedAt,
      collectionMeta: collectionMeta && typeof collectionMeta === 'object' ? collectionMeta : null,
      publicDataScope: text(persona.evidence?.publicDataScope, 80) || (samples.length ? 'profile_and_visible_content' : 'profile'),
      rawRecordCount: Array.isArray(records) ? records.length : 0,
    },
  };
}
