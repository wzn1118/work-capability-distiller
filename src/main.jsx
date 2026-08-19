import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, AlertCircle, ArrowLeft, ArrowRight, ArrowUpRight, BarChart3, Bot, Check, CheckCircle2,
  ChevronDown, CircleDollarSign, Clipboard, Clock3, DatabaseZap, Download, ExternalLink,
  Command, FileText, Gauge, Globe2, History, Layers3, Link2, ListChecks, LoaderCircle, Menu, MessageSquareText, Play,
  Plus, Radar, RefreshCw, Search, Send, Settings2, ShieldCheck, Sparkles, Target,
  TrendingUp, Upload, Users, WandSparkles, Wifi, X, Zap,
} from 'lucide-react';
import './styles.css';
import './capture-status.css';
import './creator-data-ledger.css';
import './codex-agent.css';
import './multimodal-coverage.css';
import './content-capture-polish.css';
import { DouyinCommentWorkspace } from './douyin-comments/DouyinCommentWorkspace.jsx';
import './douyin-comments/douyin-comments.css';

const steps = [
  { id: 1, short: 'BRIEF', title: '输入背景信息', icon: FileText },
  { id: 2, short: 'CHANNEL', title: '选择所在渠道', icon: Globe2 },
  { id: 3, short: 'CREATORS', title: '选择渠道 KOL', icon: Users },
  { id: 4, short: 'CRAWL', title: '采集 KOL 数据', icon: Radar },
  { id: 5, short: 'MESSAGE', title: '生成个性化信息', icon: WandSparkles },
  { id: 6, short: 'REPORT', title: '统计并生成报告', icon: BarChart3 },
];

const SUPPORTED_CHANNEL_IDS = ['xiaohongshu', 'douyin', 'bilibili'];
const POST_SEARCH_MAX_RESULTS = 10_000;
const DEFAULT_POST_SEARCH_LIMIT = 100;
const DEFAULT_POST_SEARCH_CONTINUATION_BATCH = 100;
const POST_SEARCH_LIMIT_PRESETS = [24, 50, 100, 200, 500, 1000];

function parsePostSearchLimit(value) {
  const parsed = Number(String(value ?? '').trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > POST_SEARCH_MAX_RESULTS) return null;
  return parsed;
}

function PostSearchLimitPresets({ value, onChange, ariaLabel }) {
  return <div className="post-search-limit-presets" role="group" aria-label={ariaLabel}>
    {POST_SEARCH_LIMIT_PRESETS.map((preset) => (
      <button
        key={preset}
        type="button"
        className={String(value) === String(preset) ? 'active' : ''}
        aria-pressed={String(value) === String(preset)}
        onClick={() => onChange(String(preset))}
      >{preset}</button>
    ))}
  </div>;
}

function localApiOriginFromQuery() {
  if (typeof window === 'undefined') return '';
  const rawOrigin = new URLSearchParams(window.location.search).get('api');
  if (!rawOrigin) return '';
  try {
    const origin = new URL(rawOrigin);
    const loopback = origin.hostname === '127.0.0.1' || origin.hostname === 'localhost';
    if (origin.protocol !== 'http:' || !loopback || origin.pathname !== '/' || origin.search || origin.hash) return '';
    return origin.origin;
  } catch {
    return '';
  }
}

const localApiOrigin = localApiOriginFromQuery();
const apiPath = (path) => localApiOrigin ? `${localApiOrigin}${path}` : path;

function notifyContentHistoryUpdated() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('content-history-updated'));
}

function detailRouteFromLocation() {
  if (typeof window === 'undefined') return { view: 'workspace', key: '' };
  const rawHash = window.location.hash.replace(/^#/, '');
  const queryIndex = rawHash.indexOf('?');
  const path = (queryIndex === -1 ? rawHash : rawHash.slice(0, queryIndex))
    .replace(/^\/+/, '')
    .toLowerCase();
  const params = new URLSearchParams(queryIndex === -1 ? '' : rawHash.slice(queryIndex + 1));
  const view = path === 'creator' || path === 'content' ? path : 'workspace';
  return {
    view,
    campaignId: params.get('campaign') || '',
    creatorId: params.get('creator') || '',
    contentId: params.get('item') || '',
    sourceUrl: params.get('source') || '',
    sampleIndex: params.get('sample') || '',
    discoveryJobId: params.get('discoveryJob') || '',
    enrichmentJobId: params.get('enrichmentJob') || '',
    contentJobId: params.get('contentJob') || '',
    analysisJobId: params.get('analysisJob') || '',
    key: rawHash,
  };
}

function detailRouteHash({ view, campaignId, creatorId, contentId, sourceUrl, sampleIndex, discoveryJobId, enrichmentJobId, contentJobId, analysisJobId }) {
  const params = new URLSearchParams();
  const values = {
    campaign: campaignId,
    creator: creatorId,
    item: contentId,
    source: sourceUrl,
    sample: sampleIndex,
    discoveryJob: discoveryJobId,
    enrichmentJob: enrichmentJobId,
    contentJob: contentJobId,
    analysisJob: analysisJobId,
  };
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  });
  return `#/${view}?${params.toString()}`;
}

function detailRouteHref(route) {
  if (typeof window === 'undefined') return detailRouteHash(route);
  const url = new URL(window.location.href);
  url.hash = detailRouteHash(route);
  return `${url.pathname}${url.search}${url.hash}`;
}

function workspaceHref() {
  if (typeof window === 'undefined') return '/';
  const url = new URL(window.location.href);
  url.hash = '';
  return `${url.pathname}${url.search}`;
}

function useDetailRoute() {
  const [route, setRoute] = useState(() => detailRouteFromLocation());
  useEffect(() => {
    const handleRoute = () => setRoute(detailRouteFromLocation());
    window.addEventListener('hashchange', handleRoute);
    return () => window.removeEventListener('hashchange', handleRoute);
  }, []);
  return route;
}

function appModuleFromLocation() {
  if (typeof window === 'undefined') return 'kol';
  const module = new URLSearchParams(window.location.search).get('module');
  return ['content-capture', 'douyin-comments'].includes(module) ? module : 'kol';
}

function useAppModule() {
  const [module, setModule] = useState(() => appModuleFromLocation());
  useEffect(() => {
    const handleRoute = () => setModule(appModuleFromLocation());
    window.addEventListener('popstate', handleRoute);
    return () => window.removeEventListener('popstate', handleRoute);
  }, []);
  const navigate = (nextModule) => {
    const url = new URL(window.location.href);
    if (['content-capture', 'douyin-comments'].includes(nextModule)) url.searchParams.set('module', nextModule);
    else url.searchParams.delete('module');
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
    setModule(['content-capture', 'douyin-comments'].includes(nextModule) ? nextModule : 'kol');
  };
  return [module, navigate];
}

const terminalStatuses = new Set([
  'succeeded',
  'partial_success',
  'completed_empty',
  'waiting_for_connection',
  'waiting_for_configuration',
  'interrupted',
  'failed',
]);

const channelOptions = [
  {
    id: 'bilibili', name: '\u0042\u7ad9', mark: 'B', color: '#00aeec', signal: '\u957f\u89c6\u9891\u4e0e\u4e13\u680f\u5185\u5bb9',
    adapter: '\u767b\u5f55\u6d4f\u89c8\u5668 Relay / \u5408\u4f5c\u65b9 HTTP', scope: '\u89c6\u9891\u3001\u4e13\u680f\u3001\u4f5c\u8005\u4e3b\u9875\u4e0e\u516c\u5f00\u4e92\u52a8\u6e90\u8bb0\u5f55',
  },
  {
    id: 'xiaohongshu', name: '小红书', mark: '小', color: '#e85248', signal: '笔记种草',
    adapter: '登录浏览器 Relay / 合作方 HTTP', scope: '笔记、话题、收藏与评论真实源记录', loginUrl: 'https://www.xiaohongshu.com/',
  },
  {
    id: 'douyin', name: '抖音', mark: '抖', color: '#252525', signal: '短视频扩散',
    adapter: '登录浏览器 Relay / 合作方 HTTP', scope: '视频、作者卡片与互动真实源记录', loginUrl: 'https://www.douyin.com/',
  },
];

const agentNodes = [
  { id: 'discover', name: 'Discovery Agent', role: '调用平台连接器检索候选', icon: Search },
  { id: 'profile', name: 'Profile Agent', role: '归一化账号与内容来源', icon: Users },
  { id: 'content', name: 'Content Agent', role: '保留内容样本与互动字段', icon: Layers3 },
  { id: 'fit', name: 'Fit Agent', role: '按 Brief 计算匹配线索', icon: Gauge },
];

const contentAnalysisRoleCatalog = [
  { id: 'content_strategist', label: '内容策略', caption: 'CONTENT STRATEGIST', icon: Layers3, description: '识别主题、表达方式与可复用内容线索。' },
  { id: 'commercial_fit', label: '商业匹配', caption: 'COMMERCIAL FIT', icon: CircleDollarSign, description: '从公开内容证据提取合作切入与限制。' },
  { id: 'audience_resonance', label: '受众共鸣', caption: 'AUDIENCE RESONANCE', icon: Users, description: '汇总可见互动、话题与受众回应信号。' },
  { id: 'brand_safety', label: '品牌边界', caption: 'BRAND SAFETY', icon: ShieldCheck, description: '标注公开内容中可追溯的风险与缺口。' },
  { id: 'video_visual', label: '视频视觉', caption: 'VIDEO VISUAL', icon: Play, description: '从已取得的关键帧与 OCR 证据识别画面表达。' },
  { id: 'video_audio', label: '视频音频', caption: 'VIDEO AUDIO', icon: MessageSquareText, description: '从可用转写与音频元数据提取语言和节奏线索。' },
  { id: 'outreach_strategy', label: '建联策略', caption: 'OUTREACH STRATEGY', icon: WandSparkles, description: '把可复核的内容线索整理成首轮沟通与人工复核动作。' },
];

const initialBrief = {
  brand: 'LUMA',
  product: '澄光精华 2.0',
  objective: '新品上市种草，建立温和提亮与敏感肌友好的产品心智',
  audience: '22–35 岁一二线城市女性，关注成分、敏感肌护理与真实使用体验',
  budget: '300,000',
  market: '中国大陆',
  tone: '真诚、专业、克制',
  avoid: '夸大功效、医疗术语、强制脚本',
};

function isActiveJob(job) {
  return job && !terminalStatuses.has(job.status);
}

function isCreatorProfileUrl(channel, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    if (channel === 'xiaohongshu') {
      const validHost = url.hostname === 'xiaohongshu.com' || url.hostname.endsWith('.xiaohongshu.com');
      return validHost && /^\/user\/profile\/[^/]+/i.test(url.pathname);
    }
    if (channel === 'douyin') {
      const validHost = ['douyin.com', 'iesdouyin.com'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
      const match = url.pathname.match(/^\/(?:user|share\/user)\/([^/]+)/i);
      if (!validHost || !match) return false;
      const profileId = decodeURIComponent(match[1]).toLowerCase();
      return !new Set(['self', 'login', 'search', 'discover', 'following', 'follower']).has(profileId);
    }
    if (channel === 'bilibili') {
      const validHost = url.hostname === 'space.bilibili.com' || url.hostname.endsWith('.space.bilibili.com');
      return validHost && /^\/\d+\/?$/i.test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

function statusLabel(status) {
  if (status === 'completed_empty') return '未返回可用候选';
  if (status === 'waiting_for_configuration') return '等待配置';
  if (status === 'interrupted') return '可续跑';
  return {
    queued: '等待执行', running: '正在采集', succeeded: '采集完成', partial_success: '部分完成', retryable: '可续跑',
    waiting_for_connection: '等待连接', failed: '采集失败',
  }[status] || '尚未开始';
}

function eventTime(value) {
  if (!value) return '--:--:--';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}

function profileList(value, maximum = 6) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[、,，|/]+/) : [];
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, maximum);
}

function profileValue(profile, keys) {
  for (const key of keys) {
    const value = profile?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function objectSection(...values) {
  return values.map((value) => plainObject(value)).find((value) => Object.keys(value).length) || {};
}

function profileText(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.map((item) => profileText(item)).filter(Boolean).join(' · ') || fallback;
  if (typeof value === 'object') {
    const summary = firstPresent(value.summary, value.label, value.name, value.title, value.text, value.value);
    return summary === undefined ? fallback : profileText(summary, fallback);
  }
  return String(value);
}

function countLabel(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }
  return String(value);
}

function percentLabel(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${Math.round(value <= 1 ? value * 100 : value)}%`;
  }
  const text = String(value);
  if (text.endsWith('%')) return text;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? `${Math.round(parsed <= 1 ? parsed * 100 : parsed)}%` : text;
}

function profileSections(profile) {
  const root = plainObject(profile);
  const data = plainObject(root.data);
  return {
    root: { ...data, ...root },
    account: objectSection(root.profile, data.profile),
    content: objectSection(root.content, data.content),
    commercial: objectSection(root.commercial, data.commercial),
    audience: objectSection(root.audience, data.audience, root.fanAudience, data.fanAudience),
    growth: objectSection(root.growth, data.growth),
    performance: objectSection(root.performance, data.performance),
    risk: objectSection(root.risk, data.risk),
    quality: objectSection(root.quality, data.quality),
    evidence: firstPresent(root.evidence, data.evidence),
  };
}

function evidenceText(value) {
  if (Array.isArray(value)) return value.map((item) => evidenceText(item)).filter(Boolean).join(' · ');
  if (value && typeof value === 'object') {
    return profileText(firstPresent(value.summary, value.label, value.title, value.text, value.note, value.url));
  }
  return profileText(value);
}

function enrichmentTargetId(record) {
  return record?.targetId || record?.creatorId || record?.discoveryCreatorId || record?.candidateId || record?.sourceCreatorId
    || record?.creator?.targetId || record?.creator?.id || record?.profile?.targetId
    || record?.profile?.creatorId || record?.enrichment?.targetId || record?.enrichment?.creatorId
    || record?.data?.targetId || record?.data?.creatorId || record?.data?.discoveryCreatorId || null;
}

function isTransportErrorTitle(value) {
  const title = profileText(value).replace(/\s+/g, ' ').trim();
  return /^(?:error[:\s-]*)?(?:[45]\d{2}\s+)?(?:bad gateway|gateway time[-\s]?out|service unavailable|internal server error|origin error)$/i.test(title);
}

function personaHasTransportError(persona) {
  const profile = plainObject(persona?.profile);
  const confirmation = plainObject(persona?.profileConfirmation);
  return [
    persona?.name,
    persona?.observedName,
    persona?.title,
    profile.displayName,
    profile.nickname,
    profile.name,
    confirmation.observedName,
    confirmation.observed_name,
  ].some(isTransportErrorTitle);
}

function uniqueJobs(jobs) {
  const seen = new Set();
  return (Array.isArray(jobs) ? jobs : []).filter((job) => {
    if (!job?.id || seen.has(job.id)) return false;
    seen.add(job.id);
    return true;
  });
}

function profileMapFromJob(job) {
  const rawRecords = firstPresent(job?.results, job?.enrichments, job?.profiles, job?.data?.results, []);
  const records = Array.isArray(rawRecords)
    ? rawRecords
    : Object.entries(plainObject(rawRecords)).map(([targetId, value]) => ({ ...plainObject(value), targetId: plainObject(value).targetId || targetId }));
  return Object.fromEntries(records.map((record) => {
    const data = plainObject(record?.data);
    const targetId = enrichmentTargetId(record) || enrichmentTargetId(data);
    const profile = objectSection(record?.profile, data.profile, record?.creatorProfile, record?.enrichment?.profile);
    const content = objectSection(record?.content, data.content, record?.enrichment?.content);
    const commercial = objectSection(record?.commercial, data.commercial, record?.enrichment?.commercial);
    const quality = objectSection(record?.quality, data.quality, record?.enrichment?.quality);
    const evidence = firstPresent(record?.evidence, data.evidence, record?.enrichment?.evidence);
    const persona = {
      ...plainObject(record),
      ...data,
      ...profile,
      targetId,
      profile,
      content,
      commercial,
      quality,
      evidence,
    };
    return targetId && !personaHasTransportError(persona) ? [targetId, persona] : null;
  }).filter(Boolean));
}

function hasConfirmedProfile(persona) {
  return persona?.profileConfirmation?.status === 'confirmed' && !personaHasTransportError(persona);
}

function profileMapFromJobs(jobs) {
  return uniqueJobs(jobs).reduce((profiles, job) => ({ ...profiles, ...profileMapFromJob(job) }), {});
}

function contentMapFromJob(job) {
  const rawRecords = firstPresent(job?.results, job?.contentCaptures, job?.data?.results, []);
  const records = Array.isArray(rawRecords)
    ? rawRecords
    : Object.entries(plainObject(rawRecords)).map(([targetId, value]) => ({ ...plainObject(value), targetId: plainObject(value).targetId || targetId }));
  return Object.fromEntries(records.map((record) => {
    const data = plainObject(record?.data);
    const targetId = enrichmentTargetId(record) || enrichmentTargetId(data);
    const capture = {
      ...plainObject(record),
      ...data,
      targetId,
      contentJobId: firstPresent(record?.contentJobId, data.contentJobId, job?.id),
      contentJobStatus: firstPresent(record?.contentJobStatus, data.contentJobStatus, job?.status),
      contentJobUpdatedAt: firstPresent(
        record?.contentJobUpdatedAt,
        data.contentJobUpdatedAt,
        job?.updatedAt,
        job?.finishedAt,
        job?.createdAt,
        record?.capturedAt,
        data.capturedAt,
      ),
      profile: objectSection(record?.profile, data.profile),
      content: objectSection(record?.content, data.content, record?.capture?.content),
      performance: objectSection(record?.performance, data.performance),
      commercial: objectSection(record?.commercial, data.commercial),
      risk: objectSection(record?.risk, data.risk),
      quality: objectSection(record?.quality, data.quality),
      evidence: firstPresent(record?.evidence, data.evidence),
    };
    return targetId && !personaHasTransportError(capture) ? [targetId, capture] : null;
  }).filter(Boolean));
}

function contentCaptureSampleCount(capture) {
  const content = plainObject(capture?.content);
  const coverage = objectSection(content.collectionCoverage, content.contentCoverage, content.captureCoverage);
  const ledger = plainObject(content.itemLedger);
  return firstNumericMetric(
    coverage.uniquePublicContentCount,
    coverage.observedVisibleSampleCount,
    ledger.uniquePublicContentCount,
    ledger.observedVisibleSampleCount,
    content.reportedVisibleSampleCount,
    content.visibleSampleCount,
    content.retainedVisibleSampleCount,
    publicContentSamples(content.visibleSamples).length,
  ) || 0;
}

function contentCaptureCollectionState(capture) {
  const content = plainObject(capture?.content);
  const coverage = objectSection(content.collectionCoverage, content.contentCoverage, content.captureCoverage);
  return profileText(firstPresent(
    coverage.completion,
    coverage.resumeState,
    capture?.contentJobStatus,
    capture?.status,
  )).toLowerCase();
}

function contentCaptureRank(capture) {
  if (contentCaptureSampleCount(capture) > 0) return 3;
  const state = contentCaptureCollectionState(capture);
  if (['collected', 'succeeded', 'partial_success', 'completed'].includes(state)) return 2;
  if (['retryable', 'running', 'queued', 'pending', 'continuation_recommended'].includes(state)) return 1;
  return 0;
}

function contentCaptureTimestamp(capture) {
  const value = firstPresent(
    capture?.contentJobUpdatedAt,
    capture?.capturedAt,
    capture?.evidence?.capturedAt,
  );
  return Date.parse(profileText(value)) || 0;
}

function preferredContentCapture(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;
  const currentSamples = contentCaptureSampleCount(current);
  const candidateSamples = contentCaptureSampleCount(candidate);
  if (candidateSamples !== currentSamples) return candidateSamples > currentSamples ? candidate : current;
  const currentRank = contentCaptureRank(current);
  const candidateRank = contentCaptureRank(candidate);
  if (candidateRank !== currentRank) return candidateRank > currentRank ? candidate : current;
  return contentCaptureTimestamp(candidate) >= contentCaptureTimestamp(current) ? candidate : current;
}

function mergeContentCaptureMaps(...maps) {
  return maps.reduce((merged, captures) => Object.entries(plainObject(captures)).reduce((next, [targetId, capture]) => {
    next[targetId] = preferredContentCapture(next[targetId], capture);
    return next;
  }, merged), {});
}

function contentMapFromJobs(jobs) {
  return uniqueJobs(jobs).reduce(
    (captures, job) => mergeContentCaptureMaps(captures, contentMapFromJob(job)),
    {},
  );
}

function mergeContentJobSnapshot(previous, incoming) {
  if (!previous || previous.id !== incoming?.id) return incoming;
  const preservePopulatedArray = (nextValue, previousValue, expectedCount = 0) => (
    Array.isArray(nextValue) && (nextValue.length > 0 || !expectedCount)
      ? nextValue
      : previousValue
  );
  const expectedResults = Number(incoming.resultCount || incoming.metrics?.contentCaptures || 0);
  const expectedTargets = Number(incoming.selectedCreatorCount || incoming.metrics?.targetCreators || expectedResults || 0);
  const incomingChannelResults = plainObject(incoming.channelResults);
  return {
    ...previous,
    ...incoming,
    targets: preservePopulatedArray(incoming.targets, previous.targets, expectedTargets),
    selectedCreatorIds: preservePopulatedArray(incoming.selectedCreatorIds, previous.selectedCreatorIds, expectedTargets),
    results: preservePopulatedArray(incoming.results, previous.results, expectedResults),
    channelResults: Object.keys(incomingChannelResults).length > 0
      ? incomingChannelResults
      : previous.channelResults,
  };
}

function analysisMapFromJob(job) {
  const rawRecords = firstPresent(job?.results, job?.analyses, job?.data?.results, job?.data?.analyses, []);
  const records = Array.isArray(rawRecords)
    ? rawRecords
    : Object.entries(plainObject(rawRecords)).map(([targetId, value]) => ({ ...plainObject(value), targetId: plainObject(value).targetId || targetId }));
  return Object.fromEntries(records.map((record) => {
    const data = plainObject(record?.data);
    const targetId = enrichmentTargetId(record) || enrichmentTargetId(data);
    const analysis = objectSection(record?.analysis, data.analysis);
    if (!targetId || !Object.keys(analysis).length) return null;
    return [targetId, {
      ...plainObject(record),
      ...data,
      targetId,
      name: firstPresent(record?.name, data.name),
      sourceUrl: firstPresent(record?.sourceUrl, data.sourceUrl),
      analysis,
    }];
  }).filter(Boolean));
}

function analysisMapFromJobs(jobs) {
  return uniqueJobs(jobs).reduce((analyses, job) => ({ ...analyses, ...analysisMapFromJob(job) }), {});
}

function effectiveProfileSourcesFor(jobs, selectedIds) {
  const remaining = new Set(selectedIds);
  const sources = [];
  for (const job of [...uniqueJobs(jobs)].reverse()) {
    const targetIds = Object.keys(profileMapFromJob(job)).filter((targetId) => remaining.has(targetId));
    if (!targetIds.length) continue;
    targetIds.forEach((targetId) => remaining.delete(targetId));
    sources.push({ job, targetIds });
  }
  return sources.reverse();
}

function effectiveContentSourcesFor(jobs, selectedIds) {
  const remaining = new Set(selectedIds);
  const sources = [];
  for (const job of [...uniqueJobs(jobs)].reverse()) {
    const targetIds = Object.keys(contentMapFromJob(job)).filter((targetId) => remaining.has(targetId));
    if (!targetIds.length) continue;
    targetIds.forEach((targetId) => remaining.delete(targetId));
    sources.push({ job, targetIds });
  }
  return sources.reverse();
}

function effectiveAnalysisSourcesFor(jobs, selectedIds) {
  const remaining = new Set(selectedIds);
  const sources = [];
  for (const job of [...uniqueJobs(jobs)].reverse()) {
    const targetIds = Object.keys(analysisMapFromJob(job)).filter((targetId) => remaining.has(targetId));
    if (!targetIds.length) continue;
    targetIds.forEach((targetId) => remaining.delete(targetId));
    sources.push({ job, targetIds });
  }
  return sources.reverse();
}

function analysisStatusLabel(status) {
  return {
    ready_no_model: '证据矩阵已就绪',
    completed: '已完成分析',
    completed_empty: '未返回可分析内容',
    fallback_model_error: '证据矩阵已就绪（模型回退）',
    succeeded: '证据矩阵已就绪',
    partial: '部分视频已完成分析',
    partial_success: '部分证据矩阵已就绪',
    running: '分析中',
    queued: '等待分析',
    failed: '分析失败',
  }[status] || '等待分析';
}

function agentRunStatusLabel(status) {
  return {
    queued: '\u7b49\u5f85\u8c03\u5ea6',
    running: '\u6b63\u5728\u8fd0\u884c',
    completed: '\u5df2\u5b8c\u6210',
    completed_cached: '\u5df2\u590d\u7528\u7f13\u5b58',
    fallback: '\u8bc1\u636e\u77e9\u9635\u56de\u9000',
    failed: '\u672a\u5b8c\u6210',
    not_configured: '\u672a\u914d\u7f6e\u6a21\u578b',
  }[String(status || '').trim()] || '\u7b49\u5f85\u8c03\u5ea6';
}

function agentRunTone(status) {
  if (['completed', 'completed_cached'].includes(status)) return 'complete';
  if (status === 'running') return 'running';
  if (['failed', 'fallback'].includes(status)) return 'failed';
  return 'queued';
}

function artifactAssetUrl(jobId, artifactPath) {
  if (!jobId || typeof artifactPath !== 'string') return '';
  const segments = artifactPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) return '';
  return `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function videoDurationLabel(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, '0')}`;
}

function evidenceLevelLabel(value, fallback = '') {
  const normalized = String(value ?? '').trim().toLowerCase();
  const labels = { high: '高', medium: '中', low: '低' };
  return labels[normalized] || fallback || profileText(value);
}

function videoSelectionReasonLabel(value) {
  const labels = {
    observed_pinned_sample: '按可见置顶内容优先',
    observed_recent_sample: '按可见近期内容优先',
    observed_interaction_rank: '按已观测互动优先',
    visible_source_order_fallback: '按可见来源顺序补位',
  };
  return labels[String(value ?? '').trim().toLowerCase()] || profileText(value);
}

function videoLocalMediaCacheLabel(value) {
  const labels = {
    completed: '本地临时媒体已处理',
    disabled: '未启用本地临时媒体',
    timed_out: '本地临时媒体超时',
    cache_failed: '本地临时媒体未完成',
    local_probe_failed: '本地临时媒体校验未通过',
    size_limit_exceeded: '本地临时媒体超出上限',
    tooling_unavailable: '本地临时媒体工具不可用',
    not_attempted_after_probe_failure: '媒体探测失败，未下载临时媒体',
  };
  return labels[String(value ?? '').trim().toLowerCase()] || '';
}

function videoTranscriptProviderLabel(value) {
  const labels = {
    funasr: 'FunASR 本地转写',
    ffmpeg_whisper: 'Whisper 本地转写',
  };
  return labels[String(value ?? '').trim().toLowerCase()] || '';
}

function videoTimelineAnchorLabel(value) {
  const labels = {
    opening: '开场',
    early: '前段',
    midpoint: '中点',
    middle: '中段',
    late: '后段',
    closing: '结尾',
  };
  return labels[String(value ?? '').trim().toLowerCase()] || profileText(value);
}

function videoSamplingReasonLabel(value) {
  const labels = {
    uniform_timeline_anchor: '按时间线锚点均匀采样',
    browser_rendered_timeline_anchor: '按浏览器渲染时间线取帧',
  };
  return labels[String(value ?? '').trim().toLowerCase()] || profileText(value);
}

function videoFrameSourceLabel(value) {
  const labels = {
    browser_rendered: '浏览器渲染画面取帧',
    ffmpeg: '媒体流关键帧提取',
  };
  return labels[String(value ?? '').trim().toLowerCase()] || '';
}

function videoDimensionLabel(value) {
  const dimensions = plainObject(value);
  const width = firstPresent(dimensions.width, dimensions.videoWidth);
  const height = firstPresent(dimensions.height, dimensions.videoHeight);
  if (width !== undefined && height !== undefined) return `${width} x ${height}`;
  return profileText(value);
}

function videoMediaState(video) {
  const status = String(video?.status || '').toLowerCase();
  const frames = Array.isArray(video?.frames) ? video.frames : [];
  const coverage = plainObject(video?.coverage);
  const mediaReady = Boolean(
    plainObject(video?.rendered) && Object.keys(plainObject(video?.rendered)).length
    || plainObject(video?.probe) && Object.keys(plainObject(video?.probe)).length
    || frames.length
    || coverage.renderedMediaSampleCount
    || coverage.probedVideoSampleCount
    || coverage.sampledFrameCount
    || coverage.keyFrameCount,
  );
  if (mediaReady || ['completed', 'complete', 'succeeded', 'ready', 'available'].includes(status)) return { label: '媒体已完成', tone: 'complete' };
  if (['queued', 'pending', 'running', 'processing', 'rendering', 'probing'].includes(status)) return { label: '媒体处理中', tone: 'pending' };
  if (['failed', 'error'].includes(status)) return { label: '媒体未完成', tone: 'failed' };
  return { label: '未取得媒体', tone: 'unavailable' };
}

function videoTranscriptState(video, mediaState) {
  const transcript = plainObject(video?.transcript);
  const status = String(transcript.status || '').toLowerCase();
  if (profileText(transcript.text) || ['completed', 'complete', 'succeeded', 'ready', 'available'].includes(status)) return { label: '转写已完成', tone: 'complete' };
  if (['not_configured', 'unconfigured', 'disabled'].includes(status)) return { label: '未配置转写', tone: 'unavailable' };
  if (['queued', 'pending', 'running', 'processing'].includes(status)) return { label: '转写处理中', tone: 'pending' };
  if (['failed', 'error'].includes(status)) return { label: '转写未完成', tone: 'failed' };
  if (mediaState.tone === 'unavailable') return { label: '未取得媒体', tone: 'unavailable' };
  return { label: '未配置转写', tone: 'unavailable' };
}

function videoVisionState(vision) {
  const status = String(vision?.status || '').toLowerCase();
  const result = plainObject(vision?.result);
  const hasResult = Boolean(
    profileText(result.summary)
    || profileText(result.visualThemes)
    || profileText(result.sceneTypes)
    || profileText(result.onScreenTextSignals)
    || profileText(result.productSignals)
    || profileText(result.brandSafetyFlags)
    || (Array.isArray(result.frameObservations) && result.frameObservations.length)
    || result.confidence !== undefined,
  );
  if (hasResult || ['completed', 'complete', 'succeeded', 'ready', 'available'].includes(status)) return { label: '视觉语义已完成', tone: 'complete' };
  if (['not_configured', 'unconfigured', 'disabled', 'not_enabled', 'no_model'].includes(status)) return { label: '未配置视觉模型', tone: 'unavailable' };
  if (['model_unavailable', 'provider_unavailable', 'unavailable', 'not_available', 'unsupported'].includes(status)) return { label: '视觉模型不可用', tone: 'unavailable' };
  if (['no_frames', 'no_keyframes', 'no_media'].includes(status)) return { label: '未取得可分析关键帧', tone: 'unavailable' };
  if (['queued', 'pending', 'running', 'processing'].includes(status)) return { label: '视觉理解中', tone: 'pending' };
  if (['failed', 'error'].includes(status)) return { label: '视觉分析未完成', tone: 'failed' };
  return { label: '未返回视觉语义', tone: 'unavailable' };
}

function evidenceTextList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => profileText(item)).filter(Boolean);
}

function analysisFindingCount(record) {
  return (Array.isArray(record?.analysis?.roles) ? record.analysis.roles : [])
    .reduce((total, role) => total + (Array.isArray(role?.findings) ? role.findings.length : 0), 0);
}

function analysisStatement(value, fallback = '') {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return profileText(firstPresent(value.statement, value.summary, value.text, value.value), fallback);
  }
  return profileText(value, fallback);
}

const OUTREACH_CONTENT_EVIDENCE_PRIORITY = new Map([
  ['visible_content_text', 0],
  ['local_audio_transcript_segment', 1],
  ['sampled_video_frame_ocr', 2],
  ['local_video_frame_semantics', 3],
  ['external_video_summary', 4],
  ['local_video_visual_semantics', 5],
]);

const OUTREACH_CONTENT_KIND_LABELS = {
  visible_content_text: '公开内容文本',
  local_audio_transcript_segment: '视频口播片段',
  sampled_video_frame_ocr: '视频画面文字',
  local_video_frame_semantics: '视频画面理解',
  external_video_summary: '视频结构化摘要',
  local_video_visual_semantics: '视频视觉理解',
};

function compactOutreachExcerpt(value, maximum = 96) {
  const normalized = profileText(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maximum ? `${normalized.slice(0, maximum).trim()}…` : normalized;
}

function isUsableOutreachContentEvidence(entry) {
  const kind = profileText(entry?.kind);
  return OUTREACH_CONTENT_EVIDENCE_PRIORITY.has(kind)
    && Boolean(profileText(entry?.id))
    && /^https?:\/\//i.test(profileText(entry?.sourceUrl))
    && Boolean(compactOutreachExcerpt(entry?.excerpt));
}

function outreachContentTimeAnchor(entry) {
  const metrics = plainObject(entry?.metrics);
  const seconds = Number(firstPresent(metrics.startSeconds, metrics.timeSeconds));
  if (Number.isFinite(seconds) && seconds >= 0) {
    const minutes = Math.floor(seconds / 60);
    const remaining = String(Math.floor(seconds % 60)).padStart(2, '0');
    return `视频 ${minutes}:${remaining}`;
  }
  const sampleIndex = Number(entry?.sampleIndex);
  return Number.isFinite(sampleIndex) && sampleIndex > 0 ? `第 ${sampleIndex} 条公开内容` : '公开内容';
}

function evidenceBackedOutreachContext(record) {
  const analysis = plainObject(record?.analysis);
  const roles = Array.isArray(analysis.roles) ? analysis.roles : [];
  const evidenceEntries = [
    ...(Array.isArray(analysis.evidence) ? analysis.evidence : []),
    ...roles.flatMap((role) => (Array.isArray(role?.evidence) ? role.evidence : [])),
  ];
  const evidenceById = new Map();
  evidenceEntries.forEach((entry) => {
    const id = profileText(entry?.id);
    if (id && !evidenceById.has(id)) evidenceById.set(id, entry);
  });
  const availableEvidenceIds = new Set(evidenceById.keys());
  const completeEvidenceIds = (value) => {
    const ids = [...new Set((Array.isArray(value) ? value : [])
      .map((id) => profileText(id))
      .filter(Boolean))];
    return ids.length && ids.every((id) => availableEvidenceIds.has(id)) ? ids : [];
  };

  const selectContentEvidence = (preferredEvidenceIds = []) => {
    const preferred = new Set(preferredEvidenceIds);
    return [...evidenceById.values()]
      .filter((entry) => isUsableOutreachContentEvidence(entry))
      .sort((left, right) => {
        const preferredOrder = Number(preferred.has(right.id)) - Number(preferred.has(left.id));
        if (preferredOrder) return preferredOrder;
        const kindOrder = (OUTREACH_CONTENT_EVIDENCE_PRIORITY.get(left.kind) ?? 99)
          - (OUTREACH_CONTENT_EVIDENCE_PRIORITY.get(right.kind) ?? 99);
        if (kindOrder) return kindOrder;
        const engagementOrder = (right.totalObservedInteractions ?? -1) - (left.totalObservedInteractions ?? -1);
        if (engagementOrder) return engagementOrder;
        return (left.sampleIndex ?? Number.MAX_SAFE_INTEGER) - (right.sampleIndex ?? Number.MAX_SAFE_INTEGER);
      })[0] || null;
  };

  const makeContext = ({ source, sourceLabel, statement, evidenceIds }) => {
    const ids = completeEvidenceIds(evidenceIds);
    if (!ids.length || !analysisStatement(statement)) return null;
    const sourceEvidenceId = profileText(source?.evidenceId);
    const sourceEvidence = sourceEvidenceId ? evidenceById.get(sourceEvidenceId) : null;
    const contentEvidence = sourceEvidence && isUsableOutreachContentEvidence(sourceEvidence)
      ? sourceEvidence : selectContentEvidence(ids);
    if (!contentEvidence) return null;
    return {
      source: sourceEvidence ? 'outreach_hook' : 'role_finding',
      sourceLabel: profileText(sourceLabel, '内容理解结论'),
      statement: analysisStatement(statement),
      evidenceIds: [...new Set([...ids, profileText(contentEvidence.id)])],
      contentEvidenceId: profileText(contentEvidence.id),
      contentExcerpt: compactOutreachExcerpt(contentEvidence.excerpt),
      contentSourceUrl: profileText(contentEvidence.sourceUrl),
      contentKind: profileText(contentEvidence.kind),
      contentKindLabel: OUTREACH_CONTENT_KIND_LABELS[contentEvidence.kind] || '公开内容证据',
      contentTimeAnchor: outreachContentTimeAnchor(contentEvidence),
      contentPublishedAt: profileText(plainObject(contentEvidence.metrics).publishedAt),
    };
  };

  const hook = plainObject(analysis.outreachHook);
  if (hook.status === 'ready') {
    const context = makeContext({
      source: plainObject(hook.source),
      sourceLabel: profileText(plainObject(hook.analysis).roleLabel, '内容理解结论'),
      statement: plainObject(hook.analysis).statement,
      evidenceIds: hook.evidenceIds,
    });
    if (context) return context;
  }

  const roleFindingContext = (role, preferredIds = []) => {
    const findings = Array.isArray(role?.findings) ? role.findings : [];
    const ranked = [
      ...preferredIds.map((id) => findings.find((item) => item?.id === id)).filter(Boolean),
      ...findings.filter((item) => !preferredIds.includes(item?.id)),
    ];
    for (const finding of ranked) {
      const context = makeContext({
        sourceLabel: profileText(role.label, '内容理解角色判断'),
        statement: finding?.statement,
        evidenceIds: finding?.evidenceIds,
      });
      if (context) return context;
    }
    return null;
  };

  const outreachRoleContext = roleFindingContext(
    roles.find((role) => role?.id === 'outreach_strategy'),
    ['evidence-led-opening', 'co-creation-hypothesis'],
  );
  if (outreachRoleContext) return outreachRoleContext;
  const synthesis = plainObject(analysis.synthesis);
  const recommendation = analysisStatement(synthesis.recommendation);
  const recommendationEvidenceIds = completeEvidenceIds([
    synthesis.recommendationEvidenceIds,
    synthesis.recommendation?.evidenceIds,
    synthesis.evidenceIds,
  ].find((ids) => Array.isArray(ids) && ids.length));
  if (recommendation && recommendationEvidenceIds.length) {
    const context = makeContext({
      sourceLabel: '内容理解合成建议',
      statement: recommendation,
      evidenceIds: recommendationEvidenceIds,
    });
    if (context) return context;
  }
  const rolePriority = new Map([
    ['commercial_fit', 0],
    ['content_strategist', 1],
    ['audience_resonance', 2],
  ]);
  const rankedRoles = [...roles].sort((left, right) => (
    (rolePriority.get(left?.id) ?? 9) - (rolePriority.get(right?.id) ?? 9)
  ));
  for (const role of rankedRoles) {
    const context = roleFindingContext(role);
    if (context) return context;
  }
  return null;
}

function profileArtifactCountFromSources(sources) {
  return sources.reduce((total, { job, targetIds }) => total + targetIds.reduce((count, targetId) => {
    const result = Object.values(plainObject(job?.channelResults))
      .find((candidate) => candidate?.targetId === targetId);
    return count + (Array.isArray(result?.artifacts) ? result.artifacts.length : 0);
  }, 0), 0);
}

function creatorWithPersona(creator, persona) {
  const publicCreator = creatorWithPublicCardMetrics(creator);
  if (!persona) return publicCreator;
  const profile = plainObject(persona.profile);
  const content = plainObject(persona.content);
  return {
    ...publicCreator,
    name: firstPresent(persona.name, profile.displayName, publicCreator.name),
    handle: firstPresent(persona.handle, publicCreator.handle),
    sourceUrl: firstPresent(persona.sourceUrl, publicCreator.sourceUrl),
    followers: firstPresent(profile.followerCount, publicCreator.followers),
    followersLabel: firstPresent(profile.followerLabel, publicCreator.followersLabel),
    profileLikes: firstPresent(profile.totalLikes, profile.profileLikes, publicCreator.profileLikes),
    interactions: firstPresent(content.engagement?.totals?.likes, publicCreator.interactions),
    sampleCount: firstPresent(content.visibleSampleCount, content.discoverySampleCount, publicCreator.sampleCount),
    niche: firstPresent(content.discoveryNiche, publicCreator.niche),
    angle: firstPresent(content.discoveryAngle, publicCreator.angle),
    persona,
  };
}

function mergeProfileWithContentCapture(profile, capture) {
  if (!capture) return profile;
  const base = plainObject(profile);
  const contentCapture = plainObject(capture);
  const captureProfile = plainObject(contentCapture.profile);
  const numericHandle = profileText(contentCapture.handle).replace(/\D/g, '');
  const numericFollowing = profileText(captureProfile.followingCount).replace(/\D/g, '');
  const legacyAccountIdFollowing = numericHandle.length >= 8 && numericFollowing === numericHandle;
  const normalizedCaptureProfile = legacyAccountIdFollowing
    ? {
      ...captureProfile,
      followingCount: null,
      followingLabel: '未提供',
      metricSources: { ...plainObject(captureProfile.metricSources), following: null },
      missingReasons: {
        ...plainObject(captureProfile.missingReasons),
        following: 'legacy_account_id_misparsed_as_following',
      },
    }
    : captureProfile;
  return {
    ...base,
    ...contentCapture,
    profile: { ...plainObject(base.profile), ...normalizedCaptureProfile },
    content: { ...plainObject(base.content), ...plainObject(contentCapture.content) },
    performance: { ...plainObject(base.performance), ...plainObject(contentCapture.performance) },
    commercial: { ...plainObject(base.commercial), ...plainObject(contentCapture.commercial) },
    risk: { ...plainObject(base.risk), ...plainObject(contentCapture.risk) },
    quality: { ...plainObject(base.quality), ...plainObject(contentCapture.quality) },
    evidence: firstPresent(contentCapture.evidence, base.evidence),
  };
}

function publicProfileMetricSource(profile) {
  const paths = Object.values(plainObject(profile?.metricSources)).filter(Boolean);
  const hasDiscovery = paths.some((value) => String(value).startsWith('saved_discovery.'));
  const hasProfile = paths.some((value) => !String(value).startsWith('saved_discovery.'));
  if (hasDiscovery && hasProfile) return '公开主页 + 发现页公开卡片';
  if (hasProfile) return '公开主页';
  if (hasDiscovery) return '发现页公开卡片';
  return '';
}

function creatorWithContentCapture(creator, capture) {
  const publicCreator = creatorWithPublicCardMetrics(creator);
  if (!capture) return publicCreator;
  const profile = plainObject(capture.profile);
  const content = plainObject(capture.content);
  return {
    ...publicCreator,
    name: firstPresent(capture.name, publicCreator.name),
    handle: firstPresent(capture.handle, publicCreator.handle),
    sourceUrl: firstPresent(capture.sourceUrl, publicCreator.sourceUrl),
    followers: firstPresent(profile.followerCount, profile.followers, publicCreator.followers),
    followersLabel: firstPresent(profile.followerLabel, profile.followersLabel, publicCreator.followersLabel),
    profileLikes: firstPresent(profile.totalLikes, profile.profileLikes, publicCreator.profileLikes),
    interactions: firstPresent(content.engagement?.totals?.likes, publicCreator.interactions),
    sampleCount: firstPresent(content.visibleSampleCount, content.discoverySampleCount, publicCreator.sampleCount),
    niche: firstPresent(content.discoveryNiche, publicCreator.niche),
    angle: firstPresent(content.discoveryAngle, publicCreator.angle),
    metricSource: firstPresent(publicProfileMetricSource(profile), capture.source, capture.evidence?.source, publicCreator.metricSource),
    metricCapturedAt: firstPresent(profile.metricsCapturedAt, capture.capturedAt, capture.evidence?.capturedAt, publicCreator.metricCapturedAt),
    metricMissingReasons: plainObject(profile.missingReasons),
    contentCapture: capture,
  };
}

function creatorsFromContentJobs(baseCreators, jobs, captures = contentMapFromJobs(jobs)) {
  const creatorsById = new Map((baseCreators || [])
    .filter((creator) => creator?.id && isCreatorProfileUrl(creator.channel, creator.sourceUrl))
    .map((creator) => [creator.id, creatorWithContentCapture(creator, captures[creator.id])]));
  const records = uniqueJobs(jobs).flatMap((job) => [
    ...(Array.isArray(job?.targets) ? job.targets : []),
    ...(Array.isArray(job?.results) ? job.results : []),
  ]);
  Object.entries(captures).forEach(([targetId, capture]) => {
    records.push({ ...plainObject(capture), id: targetId, targetId });
  });
  records.forEach((record) => {
    const targetId = enrichmentTargetId(record) || record?.id;
    if (!targetId) return;
    const capture = captures[targetId];
    const current = creatorsById.get(targetId);
    const base = {
      ...plainObject(record),
      ...plainObject(current),
      id: targetId,
      targetId,
      channel: firstPresent(current?.channel, record?.channel, capture?.channel, capture?.platform),
      platform: firstPresent(current?.platform, record?.platform, capture?.platform, capture?.channel),
      name: firstPresent(current?.name, record?.name, capture?.name, capture?.profile?.displayName, '未命名达人'),
      handle: firstPresent(current?.handle, record?.handle, capture?.handle),
      sourceUrl: firstPresent(current?.sourceUrl, record?.sourceUrl, capture?.sourceUrl),
      niche: firstPresent(current?.niche, record?.niche, capture?.content?.discoveryNiche),
      angle: firstPresent(current?.angle, record?.angle, capture?.content?.discoveryAngle),
      sampleCount: firstPresent(current?.sampleCount, record?.sampleCount, capture?.content?.visibleSampleCount, 0),
    };
    const creator = creatorWithContentCapture(base, capture);
    if (isCreatorProfileUrl(creator.channel, creator.sourceUrl)) creatorsById.set(targetId, creator);
  });
  return [...creatorsById.values()];
}

function profileTopics(creator, profile) {
  const { root, content } = profileSections(profile);
  const values = [
    profileValue(content, ['primaryTopics', 'topics', 'themes', 'contentTags', 'tags', 'keywords', 'contentPillars']),
    profileValue(root, ['topics', 'themes', 'contentTags', 'tags', 'keywords', 'contentPillars']),
    content.discoveryNiche,
    content.discoveryAngle,
    creator.angle || creator.niche,
  ].flatMap((value) => profileList(value));
  return [...new Set(values)];
}

function firstNumericMetric(...values) {
  for (const value of values) {
    const numeric = metricNumber(value);
    if (numeric !== null && Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function observedMetricAverage(samples, metric) {
  const values = samples
    .map((sample) => metricNumber(sample?.interactionValues?.[metric]))
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function observedInteractionAverage(samples) {
  const values = samples.map((sample) => {
    const interactions = Object.values(plainObject(sample?.interactionValues))
      .map((value) => metricNumber(value))
      .filter((value) => Number.isFinite(value));
    return interactions.length ? interactions.reduce((total, value) => total + value, 0) : null;
  }).filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function contentKeywordValues(value) {
  if (Array.isArray(value)) return value.flatMap((item) => contentKeywordValues(item));
  const source = plainObject(value);
  if (Object.keys(source).length) {
    const label = profileText(firstPresent(source.label, source.name, source.title, source.value, source.text));
    return label ? [label] : [];
  }
  return profileList(value, Number.POSITIVE_INFINITY);
}

function uniqueContentKeywords(values, maximum = 4) {
  const seen = new Set();
  return values.flatMap((value) => contentKeywordValues(value)).filter((value) => {
    const label = profileText(value).trim();
    const key = label.toLocaleLowerCase();
    if (!label || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, maximum);
}

function creatorContentKeywords(creator, profile, analysisRecord) {
  const { root, content, performance } = profileSections(profile);
  const analysis = plainObject(analysisRecord?.analysis);
  const analysisContext = plainObject(analysis.creatorContext);
  const strategies = [
    performance.contentStrategy,
    content.contentStrategy,
    root.contentStrategy,
    analysisContext.contentStrategy,
  ].map((strategy) => plainObject(strategy));
  const strategyKeywords = strategies.flatMap((strategy) => {
    const topics = plainObject(strategy.topics);
    return [
      topics.hashtagSampleCounts,
      topics.labels,
      topics.publicProfileTags,
      topics.dominantVisibleHashtag,
      topics.discoveryContext,
    ];
  });
  return uniqueContentKeywords([
    ...strategyKeywords,
    profileTopics(creator, profile),
  ]);
}

function publicCardMetric(value, suffix) {
  const source = profileText(value);
  if (!source) return null;
  const pattern = new RegExp(`(\\d+(?:\\.\\d+)?\\s*(?:\\u4e07|\\u4ebf|w|k)?)\\s*${suffix}`, 'giu');
  const matches = [...source.matchAll(pattern)].reverse();
  for (const match of matches) {
    const metric = metricNumber(match[1]);
    if (metric !== null && metric <= 1000000000) return metric;
  }
  return null;
}

function creatorPublicProfileSignals(creator) {
  const cardText = [creator?.name, creator?.niche, creator?.angle].map((value) => profileText(value)).filter(Boolean).join(' ');
  const followers = firstNumericMetric(
    creator?.followers,
    creator?.profileFollowers,
    publicCardMetric(cardText, '\u7c89\u4e1d'),
  );
  const profileLikes = firstNumericMetric(
    creator?.profileLikes,
    creator?.receivedLikes,
    publicCardMetric(cardText, '(?:\u83b7\u8d5e|\u83b7\u5f97\u8d5e|\u7d2f\u8ba1\u8d5e)'),
  );
  return [
    followers !== null ? { label: '\u7c89\u4e1d', value: metricDisplay(followers) } : null,
    profileLikes !== null ? { label: '\u83b7\u8d5e', value: metricDisplay(profileLikes) } : null,
  ].filter(Boolean);
}

function creatorDisplayName(creator) {
  const observed = profileText(creator?.name);
  const boundary = observed.match(/(?:\u8d26\u53f7)?\u5173\u6ce8\s*(?:\u6296\u97f3\u53f7\s*)?[:\uff1a]/u);
  if (!boundary?.index) return observed;
  const compact = observed.slice(0, boundary.index)
    .replace(/\u8ba4\u8bc1\u5fbd\u7ae0\s*\u65d7\u8230\u5e97$/u, '')
    .trim();
  return compact || observed;
}

function creatorWithPublicCardMetrics(creator) {
  if (!creator) return creator;
  const cardText = [creator.name, creator.niche, creator.angle]
    .map((value) => profileText(value))
    .filter(Boolean)
    .join(' ');
  const cardFollowers = publicCardMetric(cardText, '\u7c89\u4e1d');
  const cardProfileLikes = publicCardMetric(cardText, '(?:\u83b7\u8d5e|\u83b7\u5f97\u8d5e|\u7d2f\u8ba1\u8d5e)');
  const handleMatch = cardText.match(/\u6296\u97f3\u53f7\s*[:\uff1a]\s*([A-Za-z0-9._-]+?)(?=\d+(?:\.\d+)?\s*(?:\u4e07|\u4ebf|w|k)?\s*(?:\u83b7\u8d5e|\u7c89\u4e1d)|\s|$)/u);
  const hasPublicMetric = cardFollowers !== null || cardProfileLikes !== null || Boolean(handleMatch?.[1]);
  return {
    ...creator,
    name: creatorDisplayName(creator),
    handle: firstPresent(handleMatch?.[1], creator.handle),
    followers: firstPresent(cardFollowers, creator.followers),
    followersLabel: firstPresent(cardFollowers !== null ? metricDisplay(cardFollowers) : null, creator.followersLabel),
    profileLikes: firstPresent(cardProfileLikes, creator.profileLikes),
    metricSource: firstPresent(hasPublicMetric ? '\u53d1\u73b0\u9875\u516c\u5f00\u5361\u7247' : null, creator.metricSource),
    metricCapturedAt: firstPresent(creator.capturedAt, creator.metricCapturedAt),
  };
}

function creatorContentMetricSummary(creator, profile, analysisRecord) {
  const { root, account, content, performance } = profileSections(profile);
  const samples = publicContentSamples(content.visibleSamples);
  const itemLedger = plainObject(content.itemLedger);
  const hasContentCapture = Boolean(creator?.contentCapture);
  const captureProgress = contentCaptureProgress(creator?.contentCapture);
  const captureState = contentCaptureCollectionState(creator?.contentCapture);
  const captureJobId = profileText(creator?.contentCapture?.contentJobId);
  const captureJobSuffix = captureJobId ? ` · 任务 ${captureJobId.slice(0, 8)}` : '';
  const retryableCapture = captureState === 'retryable' || captureState === 'continuation_recommended';
  const fullCardComplete = creator?.contentCapture?.pipeline?.fullCardComplete === true;
  const capturedSampleCount = firstNumericMetric(
    content.collectionCoverage?.uniquePublicContentCount,
    itemLedger.uniquePublicContentCount,
    itemLedger.observedVisibleSampleCount,
    content.reportedVisibleSampleCount,
    content.visibleSampleCount,
    content.retainedVisibleSampleCount,
    samples.length || null,
  );
  const hasProfile = Object.keys(plainObject(profile)).length > 0;
  const hasCapturedContent = hasContentCapture && (samples.length > 0 || (capturedSampleCount !== null && capturedSampleCount > 0));
  const publicProfileSignals = creatorPublicProfileSignals(creator);
  const missingDetail = hasContentCapture
    ? '本次公开作品快照未返回该字段'
    : '尚未采集真实公开作品，完成作品采集后计算';
  const profileWorkCount = firstProfilePath([account, root], [
    'workCount',
    'works',
    'postCount',
    'videoCount',
    'noteCount',
    'awemeCount',
    'totalWorks',
    'totalPosts',
    'workCountLabel',
    'metrics.works',
    'metrics.workCount',
    'metrics.postCount',
    'statistics.workCount',
    'statistics.postCount',
    'stats.workCount',
    'stats.postCount',
    'dimensions.account.scale.workCount',
  ]);
  const parsedWorkCount = firstNumericMetric(profileWorkCount);
  // A zero observed before a resumable profile catalog has settled is not proof
  // that the account has no public works.
  const explicitWorkCount = retryableCapture && parsedWorkCount === 0 ? null : parsedWorkCount;
  const displayedWorkCount = retryableCapture && explicitWorkCount === null && capturedSampleCount === 0
    ? null
    : firstNumericMetric(explicitWorkCount, capturedSampleCount);
  const averageInteractions = firstNumericMetric(
    firstProfilePath([performance, content, root], [
      'engagement.averageObservedInteractionActions',
      'engagement.averages.interactions',
      'engagement.averages.totalActions',
      'engagement.averageInteraction',
      'engagement.avgInteraction',
      'averageObservedInteractionActions',
      'averageInteractions',
      'avgInteractions',
      'averageEngagement',
    ]),
    observedInteractionAverage(samples),
  );
  const averageLikes = firstNumericMetric(
    firstProfilePath([performance, content, root], [
      'engagement.averages.likes',
      'engagement.averages.likeCount',
      'engagement.averageLikes',
      'engagement.avgLikes',
      'averageLikes',
      'avgLikes',
    ]),
    observedMetricAverage(samples, 'likes'),
  );
  const averageCollects = firstNumericMetric(
    firstProfilePath([performance, content, root], [
      'engagement.averages.collects',
      'engagement.averages.collectCount',
      'engagement.averages.favorites',
      'engagement.averageCollects',
      'engagement.avgCollects',
      'averageCollects',
      'avgCollects',
      'averageFavorites',
    ]),
    observedMetricAverage(samples, 'collects'),
  );
  const estimatedPostsPer30Days = firstNumericMetric(firstProfilePath([performance, content, root], [
    'postingCadence.estimatedPostsPer30Days',
    'cadence.estimatedPostsPer30Days',
    'postingFrequency.postsPer30Days',
    'postingFrequency.estimatedPostsPer30Days',
    'estimatedPostsPer30Days',
  ]));
  const averageIntervalDays = firstNumericMetric(firstProfilePath([performance, content, root], [
    'postingCadence.averageIntervalDays',
    'postingCadence.medianIntervalDays',
    'cadence.averageIntervalDays',
    'postingFrequency.averageIntervalDays',
    'averageIntervalDays',
  ]));
  const postingFrequency = estimatedPostsPer30Days !== null
    ? `${metricDisplay(estimatedPostsPer30Days)} 条 / 30 天`
    : averageIntervalDays !== null
      ? `每 ${metricDisplay(averageIntervalDays)} 天`
      : '';
  const metric = (label, value, detail) => {
    const display = metricDisplay(value);
    const retryableDetail = '作品目录尚未采集完成，任务已保留检查点并继续采集';
    return {
      label,
      value: display || (retryableCapture ? '续采中' : '—'),
      unavailable: !display,
      detail: display ? detail : retryableCapture ? retryableDetail : missingDetail,
    };
  };
  const originBase = hasCapturedContent
    ? capturedSampleCount !== null
      ? `基于本次请求内 ${countLabel(capturedSampleCount)} 条公开可见样本${captureProgress.requested !== null ? ` / 请求 ${countLabel(captureProgress.requested)} 条` : ''}，不代表账号总作品数`
      : '已采集公开可见内容'
    : hasContentCapture
      ? retryableCapture
        ? '作品目录尚未穷尽，当前空值为续采中的临时状态，不代表账号没有作品'
        : `本次请求未返回可分析公开样本，不代表账号总作品数`
      : explicitWorkCount !== null
        ? '公开主页作品字段；尚未采集逐条作品'
        : '尚未采集真实作品，作品表现指标待生成';
  const origin = `${originBase}${captureJobSuffix}`;
  const capture = fullCardComplete
    ? {
      state: 'full',
      label: '全量卡已完成 · 主页/目录/详情均已核验',
      contentJobId: captureJobId,
    }
    : hasCapturedContent
    ? {
      state: 'captured',
      label: `${captureProgress.scopeLabel} · ${captureProgress.phaseLabel}`,
      contentJobId: captureJobId,
    }
    : hasContentCapture
      ? {
        state: retryableCapture ? 'empty retryable' : 'empty',
        label: `${captureProgress.scopeLabel} · ${captureProgress.phaseLabel}`,
        contentJobId: captureJobId,
      }
    : { state: 'pending', label: '待采集真实作品' };
  return {
    metrics: [
      metric(explicitWorkCount !== null ? '作品数' : '本次公开样本', displayedWorkCount, explicitWorkCount !== null ? '平台公开主页返回的作品总数' : `${captureProgress.scopeLabel}${hasContentCapture ? '；不是账号总作品数' : '；完成采集后显示本次请求内样本数'}`),
      metric('平均互动', averageInteractions, '公开可见作品的平均互动动作'),
      metric('发文频率', postingFrequency, '基于公开作品发布时间估算'),
      metric('平均点赞', averageLikes, '公开可见作品的平均点赞'),
      metric('平均收藏', averageCollects, '公开可见作品的平均收藏'),
    ],
    keywords: creatorContentKeywords(creator, profile, analysisRecord),
    keywordDetail: hasCapturedContent || hasProfile ? '公开内容与画像标签' : missingDetail,
    publicProfileSignals,
    origin,
    capture,
  };
}

function externalHttpsUrl(value) {
  const candidate = profileText(value);
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

const MULTIMODAL_MODALITY_CATALOG = [
  { id: 'text', label: '文本', aliases: ['text', 'copy', 'caption', 'body'] },
  { id: 'image', label: '图片/画面', aliases: ['image', 'images', 'picture', 'frame', 'frames'] },
  { id: 'video', label: '视频', aliases: ['video', 'videos', 'media'] },
  { id: 'ocr', label: 'OCR', aliases: ['ocr', 'screen_text', 'frame_ocr'] },
  { id: 'audio', label: '音频转写', aliases: ['audio', 'asr', 'transcript', 'speech'] },
  { id: 'vision', label: '视觉理解', aliases: ['vision', 'visual', 'semantic'] },
  { id: 'external', label: '外部上下文', aliases: ['external', 'context', 'source', 'web'] },
];

function multimodalNumericCount(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
    }
    const source = plainObject(value);
    if (Object.keys(source).length) {
      const nested = multimodalNumericCount(
        source.count,
        source.total,
        source.itemCount,
        source.assetCount,
        source.observedCount,
        source.availableCount,
        source.items,
        source.assets,
        source.records,
        source.samples,
        source.entries,
      );
      if (nested !== null) return nested;
    }
  }
  return null;
}

function multimodalStatus(value, count = 0) {
  const source = plainObject(value);
  const raw = profileText(firstPresent(
    source.status,
    source.state,
    source.availability,
    source.result,
    typeof value === 'string' ? value : '',
  )).trim().toLowerCase();
  const explicitBoolean = typeof value === 'boolean'
    ? value
    : typeof source.available === 'boolean'
      ? source.available
      : typeof source.ready === 'boolean'
        ? source.ready
        : typeof source.completed === 'boolean'
          ? source.completed
          : null;
  let tone = 'unavailable';
  if (/fail|error|denied|blocked/.test(raw)) tone = 'failed';
  else if (/running|pending|queue|process|loading/.test(raw)) tone = 'processing';
  else if (/partial|limited|incomplete/.test(raw)) tone = 'partial';
  else if (/ready|available|complete|success|observed|captured|present/.test(raw) || explicitBoolean === true || count > 0) tone = 'ready';
  const labels = {
    ready: '已取得',
    processing: '处理中',
    partial: '不完整',
    failed: '失败',
    unavailable: '未取得',
  };
  return { tone, statusLabel: labels[tone] };
}

function multimodalAssetCount(assets, aliases) {
  return (Array.isArray(assets) ? assets : []).filter((asset) => {
    const source = plainObject(asset);
    const type = profileText(firstPresent(
      source.modality,
      source.type,
      source.kind,
      source.category,
      source.mediaType,
      source.media_type,
    )).toLowerCase();
    return aliases.some((alias) => type === alias || type.includes(alias));
  }).length;
}

function multimodalModalityValue(source, definition) {
  const modalities = plainObject(source?.modalities);
  for (const alias of definition.aliases) {
    const value = firstPresent(modalities[alias], source?.[alias]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeMultimodalCoverage(value) {
  const source = plainObject(value);
  const assets = Array.isArray(source.assets) ? source.assets : [];
  return {
    sharedAcrossAgents: source.sharedAcrossAgents === true || source.shared_across_agents === true,
    inputMode: profileText(firstPresent(
      source.inputMode,
      source.input_mode,
      source.inputTransport,
      source.input_transport,
      source.mode,
    )),
    assets,
    modalities: MULTIMODAL_MODALITY_CATALOG.map((definition) => {
      const raw = multimodalModalityValue(source, definition);
      const directCount = multimodalNumericCount(raw);
      const assetCount = multimodalAssetCount(assets, definition.aliases);
      const count = directCount === null ? assetCount : directCount;
      return {
        ...definition,
        count,
        ...multimodalStatus(raw, count),
      };
    }),
  };
}

function aggregateMultimodalCoverage(values, options = {}) {
  const sources = (Array.isArray(values) ? values : []).filter((value) => Object.keys(plainObject(value)).length > 0);
  const normalized = sources.map((value) => normalizeMultimodalCoverage(value));
  const assets = normalized.flatMap((coverage) => coverage.assets);
  return {
    sharedAcrossAgents: options.sharedAcrossAgents === true || normalized.some((coverage) => coverage.sharedAcrossAgents),
    inputMode: profileText(firstPresent(options.inputMode, normalized.map((coverage) => coverage.inputMode).find(Boolean))),
    assets,
    modalities: MULTIMODAL_MODALITY_CATALOG.map((definition) => {
      const states = normalized.map((coverage) => coverage.modalities.find((item) => item.id === definition.id)).filter(Boolean);
      const count = states.reduce((total, item) => total + item.count, 0);
      const tones = new Set(states.map((item) => item.tone));
      let tone = 'unavailable';
      if (tones.has('processing')) tone = 'processing';
      else if (tones.has('ready') && (tones.has('failed') || tones.has('partial'))) tone = 'partial';
      else if (tones.has('ready')) tone = 'ready';
      else if (tones.has('partial')) tone = 'partial';
      else if (tones.has('failed')) tone = 'failed';
      return {
        ...definition,
        count,
        ...multimodalStatus(tone, count),
      };
    }),
  };
}

function mergeMultimodalCoverage(primary, fallback) {
  const primarySource = plainObject(primary);
  const fallbackSource = plainObject(fallback);
  return {
    ...fallbackSource,
    ...primarySource,
    modalities: {
      ...plainObject(fallbackSource.modalities),
      ...plainObject(primarySource.modalities),
    },
    assets: Array.isArray(primarySource.assets) ? primarySource.assets : Array.isArray(fallbackSource.assets) ? fallbackSource.assets : [],
  };
}

function MultimodalCoverageStrip({ multimodal, label = '多模态输入覆盖', compact = false }) {
  const coverage = normalizeMultimodalCoverage(multimodal);
  const inputNote = [
    coverage.sharedAcrossAgents ? '已共享给所有 Agent' : '',
    coverage.inputMode ? `输入：${coverage.inputMode}` : '',
    coverage.assets.length ? `${coverage.assets.length} 个资产` : '',
  ].filter(Boolean).join(' · ');
  return <div className={`multimodal-coverage-strip ${compact ? 'compact' : ''}`} aria-label={label}>
    <div className="multimodal-coverage-head"><small>MULTIMODAL COVERAGE</small><strong>{label}</strong>{inputNote && <span>{inputNote}</span>}</div>
    <div className="multimodal-coverage-modalities" role="list">
      {coverage.modalities.map((modality) => <div className={`multimodal-coverage-modality ${modality.tone}`} key={modality.id} role="listitem">
        <small>{modality.label}</small><strong>{modality.count}</strong><span>{modality.statusLabel}</span><em>{modality.statusLabel === '未取得' ? '0 项' : `${modality.count} 项`}</em>
      </div>)}
    </div>
  </div>;
}

function publicContentImageAssets(value) {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : [];
  const seen = new Set();
  return entries.map((entry, index) => {
    const asset = plainObject(entry);
    const rawUrl = typeof entry === 'string' ? entry : firstPresent(asset.url, asset.src, asset.sourceUrl, asset.source_url, asset.imageUrl, asset.image_url, asset.coverUrl, asset.cover_url);
    const url = externalHttpsUrl(rawUrl);
    const artifactPath = profileText(firstPresent(asset.artifactPath, asset.artifact_path, asset.path));
    const key = `${url}|${artifactPath}`;
    if ((!url && !artifactPath) || seen.has(key)) return null;
    seen.add(key);
    return {
      ...asset,
      id: profileText(firstPresent(asset.id, asset.assetId, asset.asset_id), `image-${index + 1}`),
      url,
      artifactPath,
      alt: profileText(firstPresent(asset.alt, asset.title, asset.caption, asset.description)),
    };
  }).filter(Boolean);
}

function publicContentSamples(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map((entry, index) => {
    const sample = plainObject(entry);
    const sourceUrl = externalHttpsUrl(firstPresent(sample.sourceUrl, sample.noteUrl, sample.note_url, sample.url, sample.link));
    const title = profileText(firstPresent(sample.title, sample.name, sample.caption));
    const summary = profileText(firstPresent(sample.summary, sample.body, sample.description, sample.caption));
    const key = `${sourceUrl}|${title}|${summary.slice(0, 96)}`.toLowerCase();
    if ((!sourceUrl && !title && !summary) || seen.has(key)) return null;
    seen.add(key);
    const interactions = {
      ...plainObject(sample.statistics),
      ...plainObject(sample.stats),
      ...plainObject(sample.interactions),
    };
    const interactionValues = {
      likes: firstPresent(interactions.likes, interactions.likeCount, interactions.diggCount, interactions.digg_count),
      collects: firstPresent(interactions.collects, interactions.collectCount, interactions.favorites, interactions.collect_count),
      comments: firstPresent(interactions.comments, interactions.commentCount, interactions.comment_count),
      shares: firstPresent(interactions.shares, interactions.shareCount, interactions.share_count),
      plays: firstPresent(interactions.plays, interactions.playCount, interactions.views, interactions.viewCount, interactions.play_count),
    };
    const interactionAvailability = plainObject(firstPresent(
      sample.interactionAvailability,
      sample.interaction_availability,
    ));
    const availabilityState = (name) => {
      const entry = interactionAvailability[name];
      return profileText(plainObject(entry).state || entry).toLowerCase();
    };
    const interactionFacts = [
      ['\u64ad\u653e', interactionValues.plays],
      ['点赞', interactionValues.likes],
      ['收藏', interactionValues.collects],
      ['评论', interactionValues.comments],
      ['分享', interactionValues.shares],
    ].filter(([, metric]) => metric !== undefined && metric !== null && metric !== '')
      .map(([label, metric]) => `${label} ${countLabel(metric)}`)
      .concat([
        ['likes', '\u70b9\u8d5e'],
        ['collects', '\u6536\u85cf'],
        ['comments', '\u8bc4\u8bba'],
        ['shares', '\u5206\u4eab'],
      ].filter(([name]) => (
        interactionValues[name] === undefined
        || interactionValues[name] === null
        || interactionValues[name] === ''
      ) && availabilityState(name) === 'action_visible_count_not_shown')
        .map(([, label]) => `${label}\uff1a\u516c\u5f00\u9875\u672a\u5c55\u793a\u6570\u91cf`));
    const media = plainObject(sample.media);
    const rawImageAssets = [
      sample.imageAssets,
      sample.image_assets,
      sample.images,
      sample.imageUrls,
      sample.image_urls,
      media.imageAssets,
      media.image_assets,
      media.images,
      media.imageUrls,
      media.image_urls,
    ].find((candidate) => Array.isArray(candidate) || typeof candidate === 'string') || [];
    const imageAssets = publicContentImageAssets(rawImageAssets);
    const coverUrl = externalHttpsUrl(firstPresent(sample.coverUrl, sample.cover_url, sample.thumbnailUrl));
    const explicitImageCount = multimodalNumericCount(
      sample.imageCount,
      sample.image_count,
      media.imageCount,
      media.image_count,
    );
    const imageCount = explicitImageCount === null ? Math.max(imageAssets.length, coverUrl ? 1 : 0) : explicitImageCount;
    const contentFormat = profileText(firstPresent(
      sample.contentFormat,
      sample.content_format,
      sample.format,
      media.format,
      sample.contentType,
      sample.content_type,
      sample.type,
    ));
    const explicitHasVideo = firstPresent(
      sample.hasVideo,
      sample.has_video,
      sample.isVideo,
      sample.is_video,
      media.hasVideo,
      media.has_video,
      sample.videoUrl,
      sample.video_url,
      media.videoUrl,
      media.video_url,
    );
    const formatSignals = `${contentFormat} ${profileText(sample.contentType)} ${profileText(sample.type)}`.toLowerCase();
    const hasVideo = typeof explicitHasVideo === 'boolean'
      ? explicitHasVideo
      : explicitHasVideo !== undefined
        ? !/^(?:false|0|no)$/i.test(profileText(explicitHasVideo).trim())
        : /video|clip|reel|short|视频|短片|影片/i.test(formatSignals);
    const multimodal = objectSection(sample.multimodal, sample.multiModal, sample.multi_modal, media.multimodal);
    return {
      id: sourceUrl || `${title}-${index}`,
      contentItemId: profileText(firstPresent(sample.contentItemId, sample.content_item_id, sample.id)),
      sampleIndex: index + 1,
      sourceUrl,
      title,
      summary,
      detailText: profileText(firstPresent(sample.detailText, sample.detail_text, sample.body, sample.description)),
      coverUrl,
      contentType: profileText(firstPresent(sample.contentType, sample.content_type, sample.type)),
      contentFormat,
      hasVideo,
      imageCount,
      imageAssets,
      multimodal,
      hashtags: profileList(firstPresent(sample.hashtags, sample.tags), Number.POSITIVE_INFINITY),
      publishedAt: profileText(firstPresent(sample.publishedAt, sample.published_at, sample.createdAt, sample.created_at)),
      durationSeconds: firstPresent(sample.durationSeconds, sample.duration_seconds),
      isPinned: typeof sample.isPinned === 'boolean' ? sample.isPinned : typeof sample.is_pinned === 'boolean' ? sample.is_pinned : null,
      collectionStatus: profileText(firstPresent(sample.collectionStatus, sample.collection_status)),
      segmentStatus: profileText(firstPresent(sample.segmentStatus, sample.segment_status, sample.segmentationStatus, sample.segmentation_status)),
      analysisStatus: profileText(firstPresent(sample.analysisStatus, sample.analysis_status)),
      videoAnalysisStatus: profileText(firstPresent(sample.videoAnalysisStatus, sample.video_analysis_status)),
      unavailableReason: profileText(firstPresent(sample.unavailableReason, sample.unavailable_reason, sample.failureReason, sample.failure_reason)),
      contentSegments: mergeContentSegmentSources(
        { value: sample.contentSegments, sourceField: 'sample.contentSegments', status: sample.segmentStatus },
        { value: sample.content_segments, sourceField: 'sample.content_segments', status: sample.segment_status },
        { value: sample.segments, sourceField: 'sample.segments', status: sample.segmentStatus },
        { value: plainObject(sample.segmentation).segments, sourceField: 'sample.segmentation.segments', status: plainObject(sample.segmentation).status },
      ),
      semanticSegments: mergeContentSegmentSources(
        { value: sample.semanticSegments, sourceField: 'sample.semanticSegments', status: sample.segmentStatus, defaultKind: 'content_segment' },
        { value: sample.semantic_segments, sourceField: 'sample.semantic_segments', status: sample.segment_status, defaultKind: 'content_segment' },
        { value: plainObject(sample.segmentation).semanticSegments, sourceField: 'sample.segmentation.semanticSegments', status: plainObject(sample.segmentation).status, defaultKind: 'content_segment' },
        { value: plainObject(sample.segmentation).semantic_segments, sourceField: 'sample.segmentation.semantic_segments', status: plainObject(sample.segmentation).status, defaultKind: 'content_segment' },
      ),
      timelineSegments: mergeContentSegmentSources(
        { value: sample.timelineSegments, sourceField: 'sample.timelineSegments', status: sample.segmentStatus, defaultKind: 'video_timeline' },
        { value: sample.timeline_segments, sourceField: 'sample.timeline_segments', status: sample.segment_status, defaultKind: 'video_timeline' },
        { value: plainObject(sample.segmentation).timelineSegments, sourceField: 'sample.segmentation.timelineSegments', status: plainObject(sample.segmentation).status, defaultKind: 'video_timeline' },
        { value: plainObject(sample.segmentation).timeline_segments, sourceField: 'sample.segmentation.timeline_segments', status: plainObject(sample.segmentation).status, defaultKind: 'video_timeline' },
      ),
      commercialMarkers: profileList(firstPresent(sample.commercialMarkers, sample.commercial_markers), Number.POSITIVE_INFINITY),
      brandMentions: profileList(firstPresent(sample.brandMentions, sample.brand_mentions), Number.POSITIVE_INFINITY),
      publicRiskFlags: profileList(firstPresent(sample.publicRiskFlags, sample.public_risk_flags), Number.POSITIVE_INFINITY),
      interactionFacts,
      interactionValues,
      interactionAvailability,
      allInteractionFacts: Object.entries(interactions)
        .filter(([, metric]) => metric !== undefined && metric !== null && metric !== '')
        .map(([label, metric]) => `${label} ${countLabel(metric)}`)
        .concat(interactionFacts.filter((fact) => fact.includes('\u516c\u5f00\u9875\u672a\u5c55\u793a\u6570\u91cf'))),
    };
  }).filter(Boolean);
}

function contentSegmentEntries(value) {
  if (Array.isArray(value)) return value;
  const source = plainObject(value);
  const nested = [
    source.segments,
    source.contentSegments,
    source.content_segments,
    source.semanticSegments,
    source.semantic_segments,
    source.timelineSegments,
    source.timeline_segments,
    source.items,
  ]
    .find((candidate) => Array.isArray(candidate));
  if (nested) return nested;
  const looksLikeSegment = [
    source.text,
    source.content,
    source.excerpt,
    source.transcript,
    source.transcriptText,
    source.transcript_text,
    source.caption,
    source.startSeconds,
    source.start_seconds,
    source.startTime,
    source.start_time,
    source.start,
    source.endSeconds,
    source.end_seconds,
    source.endTime,
    source.end_time,
    source.end,
    source.kind,
    source.segmentKind,
    source.segment_kind,
    source.type,
  ].some((field) => field !== undefined && field !== null && field !== '');
  return looksLikeSegment ? [source] : [];
}

function contentSegmentSeconds(value, millisecondsValue) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const milliseconds = Number(millisecondsValue);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 1000 : null;
}

function contentSegmentKindLabel(value) {
  const normalized = profileText(value).trim().toLowerCase();
  const labels = {
    text: '文本片段', paragraph: '段落', sentence: '句子', caption: '文案', title: '标题', hashtag: '话题',
    image: '图片', image_ocr: '图片 OCR', ocr: 'OCR 文本', visual: '画面语义', scene: '镜头',
    transcript: '音频转写', transcript_segment: '转写片段', audio: '音频片段', video: '视频片段',
    video_timeline: '视频时间线', timeline: '时间线', content_segment: '内容片段',
  };
  return labels[normalized] || profileText(value, '内容片段');
}

function contentSegmentStatusLabel(value) {
  const normalized = profileText(value).trim().toLowerCase();
  const labels = {
    completed: '切分完成', complete: '切分完成', succeeded: '切分完成', available: '已返回', ready: '已返回',
    running: '切分中', processing: '切分中', queued: '等待切分', pending: '等待切分',
    failed: '切分失败', unavailable: '不可用', not_available: '不可用', skipped: '已跳过',
  };
  return labels[normalized] || profileText(value, '已返回');
}

function normalizeContentSegment(value, index, { sourceField = '', status = '', defaultKind = '', sourceUrl: sourceUrlFallback = '' } = {}) {
  const segment = plainObject(value);
  const directText = typeof value === 'string' ? value : '';
  const startSeconds = contentSegmentSeconds(
    firstPresent(segment.startSeconds, segment.start_seconds, segment.startTime, segment.start_time, segment.start),
    firstPresent(segment.startMs, segment.start_ms, segment.startTimeMs, segment.start_time_ms),
  );
  const endSeconds = contentSegmentSeconds(
    firstPresent(segment.endSeconds, segment.end_seconds, segment.endTime, segment.end_time, segment.end),
    firstPresent(segment.endMs, segment.end_ms, segment.endTimeMs, segment.end_time_ms),
  );
  const text = profileText(firstPresent(
    directText,
    segment.text,
    segment.content,
    segment.excerpt,
    segment.transcript,
    segment.transcriptText,
    segment.transcript_text,
    segment.summary,
    segment.caption,
    segment.value,
  ));
  const kind = profileText(firstPresent(
    segment.kind,
    segment.segmentKind,
    segment.segment_kind,
    segment.type,
    segment.modality,
    segment.category,
    defaultKind,
  ), 'content_segment');
  const segmentStatus = profileText(firstPresent(
    segment.status,
    segment.segmentStatus,
    segment.segment_status,
    segment.analysisStatus,
    segment.analysis_status,
    status,
  ));
  const resolvedSourceField = profileText(firstPresent(
    segment.sourceField,
    segment.source_field,
    segment.field,
    segment.originField,
    segment.origin_field,
    segment.basis,
    segment.evidenceKind,
    segment.evidence_kind,
    segment.source,
    sourceField,
  ));
  const sourceUrl = externalHttpsUrl(firstPresent(segment.sourceUrl, segment.source_url, segment.url, segment.link, sourceUrlFallback));
  if (!text && startSeconds === null && endSeconds === null && !resolvedSourceField && !segmentStatus) return null;
  return {
    id: profileText(firstPresent(segment.id, segment.segmentId, segment.segment_id), `segment-${index + 1}`),
    kind,
    status: segmentStatus,
    text,
    startSeconds,
    endSeconds: startSeconds !== null && endSeconds !== null && endSeconds < startSeconds ? null : endSeconds,
    sourceField: resolvedSourceField,
    sourceUrl,
  };
}

function mergeContentSegmentSources(...sources) {
  const byKey = new Map();
  sources.forEach((source) => {
    const input = plainObject(source);
    contentSegmentEntries(input.value).forEach((entry, index) => {
      const segment = normalizeContentSegment(entry, index, input);
      if (!segment) return;
      const key = [
        profileText(segment.id),
        profileText(segment.kind),
        segment.startSeconds ?? '',
        segment.endSeconds ?? '',
        profileText(segment.text).slice(0, 280),
      ].join('|');
      const current = byKey.get(key);
      if (!current) {
        byKey.set(key, segment);
        return;
      }
      byKey.set(key, {
        ...current,
        status: current.status || segment.status,
        sourceField: current.sourceField || segment.sourceField,
        sourceUrl: current.sourceUrl || segment.sourceUrl,
      });
    });
  });
  return [...byKey.values()];
}

function contentItemMatchesSample(item, sample) {
  const candidate = plainObject(item);
  const candidateContentId = profileText(firstPresent(candidate.contentItemId, candidate.content_item_id, candidate.sourceContentId, candidate.source_content_id));
  const sampleContentId = profileText(firstPresent(sample?.contentItemId, sample?.content_item_id, sample?.id));
  if (candidateContentId && sampleContentId && candidateContentId === sampleContentId) return true;
  const candidateUrl = profileText(firstPresent(candidate.sourceUrl, candidate.source_url, candidate.url, candidate.link));
  if (candidateUrl && sample?.sourceUrl && candidateUrl === sample.sourceUrl) return true;
  const candidateIndex = Number(firstPresent(candidate.sampleIndex, candidate.sample_index, candidate.index));
  const sampleIndex = Number(sample?.sampleIndex);
  return Number.isFinite(candidateIndex) && Number.isFinite(sampleIndex) && candidateIndex === sampleIndex;
}

function contentLedgerItemForSample(contentCapture, sample) {
  const items = Array.isArray(contentCapture?.content?.itemLedger?.items)
    ? contentCapture.content.itemLedger.items
    : [];
  return items.map((item) => plainObject(item)).find((item) => contentItemMatchesSample(item, sample)) || null;
}

function contentAnalysisItemForSample(analysis, sample) {
  const items = Array.isArray(analysis?.contentItems) ? analysis.contentItems : [];
  return items.map((item) => plainObject(item)).find((item) => contentItemMatchesSample(item, sample)) || null;
}

function contentSegmentsForSample({ contentCapture, record, sample, interpretation } = {}) {
  const ledgerItem = contentLedgerItemForSample(contentCapture, sample);
  const analysis = plainObject(record?.analysis);
  const analysisItem = contentAnalysisItemForSample(analysis, sample);
  const ledgerStatus = firstPresent(ledgerItem?.segmentStatus, ledgerItem?.segment_status, ledgerItem?.segmentationStatus, ledgerItem?.segmentation_status);
  const analysisStatus = firstPresent(analysisItem?.segmentStatus, analysisItem?.segment_status, analysisItem?.segmentationStatus, analysisItem?.segmentation_status, interpretation?.segmentStatus, interpretation?.segment_status);
  return mergeContentSegmentSources(
    { value: sample?.contentSegments, sourceField: 'sample.contentSegments', status: sample?.segmentStatus },
    { value: sample?.content_segments, sourceField: 'sample.content_segments', status: sample?.segment_status },
    { value: sample?.semanticSegments, sourceField: 'sample.semanticSegments', status: sample?.segmentStatus, defaultKind: 'content_segment', sourceUrl: sample?.sourceUrl },
    { value: sample?.semantic_segments, sourceField: 'sample.semantic_segments', status: sample?.segment_status, defaultKind: 'content_segment', sourceUrl: sample?.sourceUrl },
    { value: sample?.timelineSegments, sourceField: 'sample.timelineSegments', status: sample?.segmentStatus, defaultKind: 'video_timeline', sourceUrl: sample?.sourceUrl },
    { value: sample?.timeline_segments, sourceField: 'sample.timeline_segments', status: sample?.segment_status, defaultKind: 'video_timeline', sourceUrl: sample?.sourceUrl },
    { value: ledgerItem?.contentSegments, sourceField: 'capture.content.itemLedger.items[].contentSegments', status: ledgerStatus },
    { value: ledgerItem?.content_segments, sourceField: 'capture.content.itemLedger.items[].content_segments', status: ledgerStatus },
    { value: ledgerItem?.semanticSegments, sourceField: 'capture.content.itemLedger.items[].semanticSegments', status: ledgerStatus, defaultKind: 'content_segment', sourceUrl: sample?.sourceUrl },
    { value: ledgerItem?.semantic_segments, sourceField: 'capture.content.itemLedger.items[].semantic_segments', status: ledgerStatus, defaultKind: 'content_segment', sourceUrl: sample?.sourceUrl },
    { value: ledgerItem?.timelineSegments, sourceField: 'capture.content.itemLedger.items[].timelineSegments', status: ledgerStatus, defaultKind: 'video_timeline', sourceUrl: sample?.sourceUrl },
    { value: ledgerItem?.timeline_segments, sourceField: 'capture.content.itemLedger.items[].timeline_segments', status: ledgerStatus, defaultKind: 'video_timeline', sourceUrl: sample?.sourceUrl },
    { value: ledgerItem?.segments, sourceField: 'capture.content.itemLedger.items[].segments', status: ledgerStatus },
    { value: ledgerItem?.segmentation, sourceField: 'capture.content.itemLedger.items[].segmentation', status: plainObject(ledgerItem?.segmentation).status || ledgerStatus },
    { value: analysisItem?.contentSegments, sourceField: 'analysis.contentItems[].contentSegments', status: analysisStatus },
    { value: analysisItem?.content_segments, sourceField: 'analysis.contentItems[].content_segments', status: analysisStatus },
    { value: analysisItem?.semanticSegments, sourceField: 'analysis.contentItems[].semanticSegments', status: analysisStatus, defaultKind: 'content_segment', sourceUrl: sample?.sourceUrl },
    { value: analysisItem?.semantic_segments, sourceField: 'analysis.contentItems[].semantic_segments', status: analysisStatus, defaultKind: 'content_segment', sourceUrl: sample?.sourceUrl },
    { value: analysisItem?.timelineSegments, sourceField: 'analysis.contentItems[].timelineSegments', status: analysisStatus, defaultKind: 'video_timeline', sourceUrl: sample?.sourceUrl },
    { value: analysisItem?.timeline_segments, sourceField: 'analysis.contentItems[].timeline_segments', status: analysisStatus, defaultKind: 'video_timeline', sourceUrl: sample?.sourceUrl },
    { value: analysisItem?.segments, sourceField: 'analysis.contentItems[].segments', status: analysisStatus },
    { value: plainObject(analysisItem?.segmentation).semanticSegments, sourceField: 'analysis.contentItems[].segmentation.semanticSegments', status: plainObject(analysisItem?.segmentation).status || analysisStatus, defaultKind: 'content_segment', sourceUrl: sample?.sourceUrl },
    { value: plainObject(analysisItem?.segmentation).semantic_segments, sourceField: 'analysis.contentItems[].segmentation.semantic_segments', status: plainObject(analysisItem?.segmentation).status || analysisStatus, defaultKind: 'content_segment', sourceUrl: sample?.sourceUrl },
    { value: plainObject(analysisItem?.segmentation).timelineSegments, sourceField: 'analysis.contentItems[].segmentation.timelineSegments', status: plainObject(analysisItem?.segmentation).status || analysisStatus, defaultKind: 'video_timeline', sourceUrl: sample?.sourceUrl },
    { value: plainObject(analysisItem?.segmentation).timeline_segments, sourceField: 'analysis.contentItems[].segmentation.timeline_segments', status: plainObject(analysisItem?.segmentation).status || analysisStatus, defaultKind: 'video_timeline', sourceUrl: sample?.sourceUrl },
    { value: plainObject(analysisItem?.segmentation).videoTimelineSegments, sourceField: 'analysis.contentItems[].segmentation.videoTimelineSegments', status: plainObject(analysisItem?.segmentation).status || analysisStatus, defaultKind: 'video_timeline', sourceUrl: sample?.sourceUrl },
    { value: plainObject(analysisItem?.segmentation).video_timeline_segments, sourceField: 'analysis.contentItems[].segmentation.video_timeline_segments', status: plainObject(analysisItem?.segmentation).status || analysisStatus, defaultKind: 'video_timeline', sourceUrl: sample?.sourceUrl },
    { value: analysisItem?.segmentation, sourceField: 'analysis.contentItems[].segmentation', status: plainObject(analysisItem?.segmentation).status || analysisStatus },
  );
}

function contentItemSegmentCount(item, segments) {
  const intelligentSummary = plainObject(firstPresent(item?.intelligentSummary, item?.intelligent_summary));
  const segmentation = plainObject(item?.segmentation);
  const reported = [
    intelligentSummary.segmentCount,
    intelligentSummary.segment_count,
    intelligentSummary.semanticSegmentCount,
    intelligentSummary.semantic_segment_count,
    intelligentSummary.timedSegmentCount,
    intelligentSummary.timed_segment_count,
    item?.segmentCount,
    item?.segment_count,
    item?.semanticSegmentCount,
    item?.semantic_segment_count,
    item?.timedSegmentCount,
    item?.timed_segment_count,
    segmentation.segmentCount,
    segmentation.segment_count,
    segmentation.semanticSegmentCount,
    segmentation.semantic_segment_count,
    segmentation.timedSegmentCount,
    segmentation.timed_segment_count,
  ].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0);
  return Math.max(Array.isArray(segments) ? segments.length : 0, 0, ...reported);
}

function contentItemSummaryText(item, fallback = '') {
  const rawIntelligentSummary = firstPresent(item?.intelligentSummary, item?.intelligent_summary);
  const intelligentSummary = plainObject(rawIntelligentSummary);
  return profileText(firstPresent(intelligentSummary.statement, item?.summary, rawIntelligentSummary), fallback);
}

function contentCollectionAggregation(captures) {
  const captureList = Array.isArray(captures) ? captures.filter(Boolean) : [];
  const numericMaximum = (...values) => Math.max(0, ...values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0));
  const segmentKeysByContent = new Map();
  let enumeratedWorks = 0;
  let pageExhaustedCaptures = 0;
  let requestedLimitReachedCaptures = 0;
  let continuationCaptures = 0;
  let terminalStateUnconfirmedCaptures = 0;
  captureList.forEach((capture, captureIndex) => {
    const content = plainObject(capture?.content);
    const coverage = plainObject(content.collectionCoverage);
    const ledger = plainObject(content.itemLedger);
    const ledgerItems = Array.isArray(ledger.items) ? ledger.items.map((item) => plainObject(item)) : [];
    const samples = publicContentSamples(content.visibleSamples);
    const uniqueLedgerItems = ledgerItems.filter((item) => !/duplicate_visible_reference/i.test(profileText(item.status)));
    enumeratedWorks += numericMaximum(
      coverage.uniquePublicContentCount,
      ledger.uniquePublicContentCount,
      uniqueLedgerItems.length,
      samples.length,
    );
    const completion = profileText(firstPresent(coverage.completion, coverage.status, ledger.status, content.stopReason)).trim().toLowerCase();
    const stopReason = profileText(firstPresent(coverage.stopReason, content.stopReason, ledger.stopReason)).trim().toLowerCase();
    if (coverage.pageExhausted === true || ledger.pageExhausted === true || completion === 'page_exhausted' || stopReason === 'page_exhausted') pageExhaustedCaptures += 1;
    if (coverage.sampleLimitReached === true || coverage.requestedLimitReached === true || completion === 'sample_limit_reached'
      || ['sample_limit_reached', 'profile_sample_limit_reached', 'requested_limit_reached', 'target_reached'].includes(stopReason)) requestedLimitReachedCaptures += 1;
    if (coverage.continuationRecommended === true || ledger.continuationRecommended === true || completion === 'retryable' || stopReason === 'retryable') continuationCaptures += 1;
    if (coverage.coverageState === 'terminal_state_unconfirmed' || completion === 'completed_without_explicit_stop_reason') terminalStateUnconfirmedCaptures += 1;
    const addSegments = (contentKey, segments) => {
      if (!segments.length) return;
      const key = contentKey || `capture-${captureIndex}-content-${segmentKeysByContent.size + 1}`;
      const keys = segmentKeysByContent.get(key) || new Set();
      segments.forEach((segment) => keys.add([
        profileText(segment.id), profileText(segment.kind), segment.startSeconds ?? '', segment.endSeconds ?? '', profileText(segment.text).slice(0, 280),
      ].join('|')));
      segmentKeysByContent.set(key, keys);
    };
    uniqueLedgerItems.forEach((item, itemIndex) => {
      const key = profileText(firstPresent(item.contentItemId, item.content_item_id, item.sourceUrl, item.source_url, item.sampleIndex), `capture-${captureIndex}-ledger-${itemIndex}`);
      addSegments(key, mergeContentSegmentSources(
        { value: item.contentSegments, sourceField: 'capture.content.itemLedger.items[].contentSegments', status: item.segmentStatus },
        { value: item.content_segments, sourceField: 'capture.content.itemLedger.items[].content_segments', status: item.segment_status },
        { value: item.segments, sourceField: 'capture.content.itemLedger.items[].segments', status: item.segmentStatus },
        { value: plainObject(item.segmentation).segments, sourceField: 'capture.content.itemLedger.items[].segmentation.segments', status: plainObject(item.segmentation).status || item.segmentStatus },
      ));
    });
    samples.forEach((sample, sampleIndex) => {
      const key = profileText(firstPresent(sample.contentItemId, sample.sourceUrl, sample.sampleIndex), `capture-${captureIndex}-sample-${sampleIndex}`);
      addSegments(key, contentSegmentsForSample({ contentCapture: capture, sample }));
    });
  });
  return {
    captureCount: captureList.length,
    enumeratedWorks,
    segmentedWorks: [...segmentKeysByContent.values()].filter((segments) => segments.size > 0).length,
    segmentCount: [...segmentKeysByContent.values()].reduce((total, segments) => total + segments.size, 0),
    pageExhaustedCaptures,
    requestedLimitReachedCaptures,
    continuationCaptures,
    terminalStateUnconfirmedCaptures,
  };
}

function detailContentIdentifier(sample) {
  return profileText(firstPresent(sample?.contentItemId, sample?.id));
}

function resolveDetailContentSample(samples, route) {
  const entries = publicContentSamples(samples);
  const contentId = profileText(route?.contentId);
  const sourceUrl = profileText(route?.sourceUrl);
  const sampleIndex = Number(route?.sampleIndex);
  return entries.find((sample) => contentId && detailContentIdentifier(sample) === contentId)
    || entries.find((sample) => sourceUrl && sample.sourceUrl === sourceUrl)
    || entries.find((sample) => Number.isFinite(sampleIndex) && sample.sampleIndex === sampleIndex)
    || null;
}

function creatorForDetail({ creatorId, creator, profile, contentCapture, analysisRecord, fallbackChannel = '' }) {
  if (creator) return creatorWithContentCapture(creator, contentCapture);
  const profileSection = objectSection(profile?.profile, contentCapture?.profile);
  const content = plainObject(contentCapture?.content);
  const analysis = plainObject(analysisRecord);
  const channel = profileText(firstPresent(
    profile?.channel,
    contentCapture?.channel,
    analysis?.channel,
    fallbackChannel,
  ));
  return {
    id: creatorId,
    targetId: creatorId,
    channel,
    platform: profileText(firstPresent(profile?.platform, contentCapture?.platform, analysis?.platform, channel)),
    name: profileText(firstPresent(
      profile?.name,
      profile?.displayName,
      contentCapture?.name,
      analysis?.name,
      profileSection.displayName,
      profileSection.name,
      '未命名达人',
    )),
    handle: profileText(firstPresent(profile?.handle, contentCapture?.handle, analysis?.handle, profileSection.handle)),
    sourceUrl: profileText(firstPresent(profile?.sourceUrl, contentCapture?.sourceUrl, analysis?.sourceUrl, profileSection.sourceUrl)),
    niche: profileText(firstPresent(content.discoveryNiche, profile?.niche, analysis?.niche)),
    angle: profileText(firstPresent(content.discoveryAngle, profile?.angle, analysis?.angle)),
    followers: firstPresent(profile?.followers, profile?.followerCount, profileSection.followerCount, 0),
    interactions: firstPresent(content.engagement?.totals?.likes, profile?.interactions, null),
    sampleCount: firstPresent(content.visibleSampleCount, analysis?.analysis?.coverage?.visibleSampleCount, 0),
    fit: firstPresent(profile?.fit, 0),
    priceLabel: profileText(firstPresent(profile?.priceLabel, '未提供')),
  };
}

function interactionFacts(value) {
  const source = plainObject(value);
  return [
    ['\u64ad\u653e', firstPresent(source.plays, source.playCount, source.views, source.viewCount)],
    ['点赞', firstPresent(source.likes, source.likeCount, source.diggCount)],
    ['收藏', firstPresent(source.collects, source.collectCount, source.favorites)],
    ['评论', firstPresent(source.comments, source.commentCount)],
    ['分享', firstPresent(source.shares, source.shareCount)],
  ].filter(([, metric]) => metric !== undefined && metric !== null && metric !== '')
    .map(([label, metric]) => `${label} ${countLabel(metric)}`);
}

function metricNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\s,，]/g, '').toLowerCase();
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)(万|w|k)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  if (match[2] === '万' || match[2] === 'w') return amount * 10000;
  if (match[2] === 'k') return amount * 1000;
  return amount;
}

function metricDisplay(value) {
  const numeric = metricNumber(value);
  const display = numeric === null ? profileText(value) : countLabel(numeric);
  return /^(未提供|—|-|未知)$/u.test(display) ? '' : display;
}

function profilePath(source, path) {
  return String(path).split('.').reduce((current, key) => (
    current && typeof current === 'object' ? current[key] : undefined
  ), source);
}

function firstProfilePath(sources, paths) {
  for (const source of sources) {
    for (const path of paths) {
      const value = profilePath(source, path);
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return null;
}

function compactDimensionValues(value, maximum = 6) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => compactDimensionValues(item, maximum)).slice(0, maximum);
  }
  if (!value || typeof value !== 'object') return profileList(value, maximum);
  return Object.entries(value).map(([label, entry]) => {
    if (entry === undefined || entry === null || entry === '') return label;
    if (typeof entry === 'object') {
      const details = profileText(firstPresent(entry.label, entry.name, entry.title, entry.value, entry.summary, entry.rate, entry.percent));
      return details ? `${label} ${details}` : label;
    }
    return `${label} ${metricDisplay(entry)}`;
  }).filter(Boolean).slice(0, maximum);
}

function dimensionText(value, maximum = 3) {
  return profileText(value) || compactDimensionValues(value, maximum).join(' · ');
}

function metricFact(label, value, note = '') {
  const display = metricDisplay(value);
  return display ? { label, value: display, note } : null;
}

function textFact(label, value, note = '') {
  const display = profileText(value);
  return display ? { label, value: display, note } : null;
}

function latestSampleDate(samples) {
  const dated = samples.map((sample) => ({
    label: profileText(sample.publishedAt),
    time: new Date(sample.publishedAt).getTime(),
  })).filter((item) => item.label && Number.isFinite(item.time));
  if (!dated.length) return '';
  return dated.sort((left, right) => right.time - left.time)[0].label;
}

function sampleInteractionTotals(samples, summary) {
  const direct = plainObject(summary);
  const keys = {
    plays: ['plays', 'playCount', 'views', 'viewCount'],
    likes: ['likes', 'likeCount', 'diggCount'],
    collects: ['collects', 'collectCount', 'favorites'],
    comments: ['comments', 'commentCount'],
    shares: ['shares', 'shareCount'],
  };
  return Object.fromEntries(Object.entries(keys).map(([name, aliases]) => {
    const directValue = firstPresent(...aliases.map((alias) => direct[alias]));
    if (metricNumber(directValue) !== null) return [name, metricNumber(directValue)];
    const total = samples.reduce((sum, sample) => {
      const raw = firstPresent(...aliases.map((alias) => sample.interactionValues?.[alias]));
      const value = metricNumber(raw);
      return value === null ? sum : sum + value;
    }, 0);
    const observed = samples.some((sample) => aliases.some((alias) => metricNumber(sample.interactionValues?.[alias]) !== null));
    return [name, observed ? total : null];
  }).filter(([, value]) => value !== null));
}

function creatorPersona(creator, profile) {
  const { root, account, content, commercial, audience, growth, performance, risk, quality, evidence: rawEvidence } = profileSections(profile);
  const contentCapture = plainObject(firstPresent(creator?.contentCapture, root.contentCapture));
  const capturedContent = plainObject(contentCapture.content);
  const capturedPerformance = plainObject(contentCapture.performance);
  const summary = profileText(firstPresent(
    content.discoveryNiche,
    content.discoveryAngle,
    profileValue(root, ['summary', 'persona', 'positioning', 'profileSummary', 'accountSummary']),
    account.bio,
  )) || `${creator.platform} · ${creator.niche || '真实内容创作者'}`;
  const bio = profileText(firstPresent(account.bio, root.bio));
  const visibleMetrics = profileList(
    Array.isArray(account.visibleMetrics) && account.visibleMetrics.length ? account.visibleMetrics : root.visibleMetrics,
    Number.POSITIVE_INFINITY,
  );
  const publicAudienceSignals = profileList(
    Array.isArray(account.publicAudienceSignals) && account.publicAudienceSignals.length
      ? account.publicAudienceSignals
      : root.publicAudienceSignals,
    Number.POSITIVE_INFINITY,
  );
  const rawVisibleSamples = Array.isArray(capturedContent.visibleSamples) && capturedContent.visibleSamples.length
    ? capturedContent.visibleSamples
    : Array.isArray(content.visibleSamples) && content.visibleSamples.length
      ? content.visibleSamples
    : Array.isArray(root.visibleSamples) ? root.visibleSamples : [];
  const visibleSamples = publicContentSamples(rawVisibleSamples);
  const capturedSampleCount = firstNumericMetric(
    capturedContent.collectionCoverage?.uniquePublicContentCount,
    capturedContent.reportedVisibleSampleCount,
    capturedContent.visibleSampleCount,
    capturedContent.retainedVisibleSampleCount,
    visibleSamples.length || null,
    content.collectionCoverage?.uniquePublicContentCount,
    content.reportedVisibleSampleCount,
    content.visibleSampleCount,
    content.retainedVisibleSampleCount,
    root.visibleSampleCount,
  );
  const visibleSampleCount = capturedSampleCount ?? visibleSamples.length;
  const capturedEngagement = objectSection(
    capturedPerformance.engagement,
    capturedContent.engagement,
    performance.engagement,
    content.engagement,
  );
  const capturedInteractionSummary = objectSection(
    capturedEngagement.totals,
    capturedContent.sampleInteractions,
    content.sampleInteractions,
    root.sampleInteractions,
  );
  const sampleInteractionMetrics = sampleInteractionTotals(
    visibleSamples,
    capturedInteractionSummary,
  );
  const sampleInteractionFacts = interactionFacts(capturedInteractionSummary).length
    ? interactionFacts(capturedInteractionSummary)
    : interactionFacts(sampleInteractionMetrics);
  const style = profileText(firstPresent(
    visibleSamples[0]?.title,
    content.discoveryAngle,
    profileValue(root, ['contentStyle', 'style', 'voice', 'contentFormat']),
    content.contentSample,
  )) || creator.angle || creator.niche || '待采集';
  const followers = firstPresent(
    account.followerLabel,
    root.followerLabel,
    account.followersLabel,
    root.followersLabel,
    countLabel(firstPresent(account.followerCount, root.followerCount)),
    creator.followersLabel,
    '未提供',
  );
  const profileLikes = metricDisplay(firstPresent(
    account.totalLikesLabel,
    root.totalLikesLabel,
    account.totalLikes,
    root.totalLikes,
    account.profileLikes,
    root.profileLikes,
    creator.profileLikes,
  )) || '未提供';
  const averageCapturedInteractions = firstNumericMetric(
    capturedEngagement.averageObservedInteractionActions,
    capturedEngagement.averages?.interactions,
    capturedEngagement.averages?.totalActions,
    capturedEngagement.averageInteraction,
    capturedEngagement.avgInteraction,
    observedInteractionAverage(visibleSamples),
  );
  const totalCapturedInteractions = firstNumericMetric(
    capturedEngagement.totalObservedInteractionActions,
    capturedEngagement.totals?.interactions,
    capturedEngagement.totals?.totalActions,
  );
  const interactions = firstPresent(
    averageCapturedInteractions !== null ? `平均 ${countLabel(averageCapturedInteractions)} / 条` : '',
    totalCapturedInteractions !== null ? `累计 ${countLabel(totalCapturedInteractions)}` : '',
    countLabel(firstPresent(commercial.discoveryInteractions, root.discoveryInteractions)),
    profileText(profileValue(root, ['engagementLabel', 'engagement', 'engagementRate', 'avgEngagement'])),
    creator.engagementLabel,
    '未提供',
  );
  const samples = firstPresent(
    capturedSampleCount !== undefined && capturedSampleCount !== null ? countLabel(capturedSampleCount) : '',
    visibleSamples.length ? countLabel(visibleSamples.length) : '',
    countLabel(firstPresent(content.discoverySampleCount, root.discoverySampleCount)),
    countLabel(profileValue(root, ['sampleCount', 'postCount', 'recentPostCount', 'sourceRecords'])),
    countLabel(creator.sampleCount),
    '0',
  );
  const fit = percentLabel(firstPresent(commercial.discoveryFit, root.discoveryFit, profileValue(root, ['fit', 'matchScore', 'brandFit']), creator.fit)) || '—';
  const qualityFacts = [
    quality.completeness !== undefined && quality.completeness !== null ? `完整度 ${percentLabel(quality.completeness)}` : '',
    quality.confidence !== undefined && quality.confidence !== null ? `置信度 ${percentLabel(quality.confidence)}` : '',
  ].filter(Boolean);
  const accountFacts = [
    profileText(firstPresent(account.location, root.location)) ? `地区 ${profileText(firstPresent(account.location, root.location))}` : '',
    account.verified === true || root.verified === true ? '已认证' : account.verified === false || root.verified === false ? '未认证' : '',
    profileText(firstPresent(commercial.creatorTierLabel, root.creatorTierLabel)) ? profileText(firstPresent(commercial.creatorTierLabel, root.creatorTierLabel)) : '',
    countLabel(firstPresent(account.followingLabel, root.followingLabel, account.followingCount, root.followingCount)) ? `关注 ${countLabel(firstPresent(account.followingLabel, root.followingLabel, account.followingCount, root.followingCount))}` : '',
    profileLikes !== '未提供' ? `获赞 ${profileLikes}` : '',
  ].filter(Boolean);
  const metricCapturedAt = creator.metricCapturedAt ? new Date(creator.metricCapturedAt) : null;
  const metricCapturedLabel = metricCapturedAt && !Number.isNaN(metricCapturedAt.getTime())
    ? metricCapturedAt.toLocaleString('zh-CN', { hour12: false })
    : '来源未返回';
  const hasPublicProfileMetrics = metricDisplay(creator.followers) || metricDisplay(creator.followersLabel)
    || metricDisplay(creator.profileLikes);
  const missingMetricFields = Object.entries(plainObject(creator.metricMissingReasons))
    .filter(([, reason]) => Boolean(reason))
    .map(([field]) => ({ followers: '粉丝', following: '关注', totalLikes: '获赞', works: '作品数' })[field] || field);
  const metricEvidence = hasPublicProfileMetrics
    ? `主页指标来源：${profileText(creator.metricSource, '公开发现卡片')} · 采集时间：${metricCapturedLabel}${missingMetricFields.length ? ` · 未返回：${missingMetricFields.join('、')}` : ''}`
    : `主页指标缺失：${missingMetricFields.length ? missingMetricFields.join('、') : '当前公开来源未返回粉丝、获赞等数值'}`;
  const observedFields = profileList(quality.observedFields, Number.POSITIVE_INFINITY);
  const evidence = evidenceText(rawEvidence) || profileText(profileValue(root, ['dataQuality', 'crawlNote', 'sourceNote']))
    || (profile ? '深度任务已回填可用字段' : `${creator.sampleCount || 0} 条真实发现样本`);
  const deep = Boolean(profile && !profile.error && (
    Object.keys(account).length || Object.keys(content).length || Object.keys(commercial).length
    || Object.keys(audience).length || Object.keys(growth).length || Object.keys(risk).length
    || Object.keys(quality).length || evidenceText(rawEvidence)
  ));
  const dataPoints = [
    ['粉丝', followers],
    ['获赞', profileLikes],
    ['互动', interactions],
    ['样本', `${samples} 条`],
    ['匹配', fit],
  ];
  return {
    displayName: profileText(firstPresent(account.displayName, root.displayName)) || creator.name,
    avatar: profileText(firstPresent(account.avatar, root.avatar)),
    summary,
    bio,
    style,
    topics: profileTopics(creator, profile),
    dataPoints,
    metricEvidence,
    evidence,
    accountFacts,
    qualityFacts,
    observedFields,
    visibleMetrics,
    publicAudienceSignals,
    visibleSamples,
    sampleInteractionFacts,
    sampleInteractionMetrics,
    visibleSampleCount,
    sections: { root, account, content, commercial, audience, growth, risk, quality },
    deep,
  };
}

function creatorDimensionGroups({ creator, persona, audienceInsight }) {
  const sections = persona.sections || {};
  const root = plainObject(sections.root);
  const account = plainObject(sections.account);
  const content = plainObject(sections.content);
  const commercial = plainObject(sections.commercial);
  const audience = plainObject(sections.audience);
  const growth = plainObject(sections.growth);
  const risk = plainObject(sections.risk);
  const quality = plainObject(sections.quality);
  const performance = plainObject(root.performance);
  const groups = [];
  const value = (sources, paths) => firstProfilePath(sources, paths);
  const addGroup = (group) => {
    const facts = (group.facts || []).filter(Boolean);
    const tags = [...new Set((group.tags || []).map((item) => profileText(item)).filter(Boolean))].slice(0, 8);
    const observed = facts.some((fact) => profileText(fact.value) && profileText(fact.value) !== '未返回') || tags.length > 0;
    groups.push({
      ...group,
      observed,
      facts: observed ? facts : [textFact('状态', '未返回')],
      tags,
    });
  };

  const verified = value([account, root], ['verified']);
  const verifiedLabel = verified === true ? '已认证' : verified === false ? '未认证' : '';
  const visibleAccountMetrics = compactDimensionValues(value([account, root], ['visibleMetrics']), 6);
  const publicProfileTags = compactDimensionValues(value([account, root], ['publicProfileTags', 'profileTags']), 8);
  addGroup({
    id: 'account',
    caption: 'ACCOUNT SIGNALS',
    title: '账号基础',
    basis: '公开主页字段',
    facts: [
      textFact('认证状态', verifiedLabel),
      textFact('\u8d26\u53f7\u7c7b\u578b', value([account, root], ['accountType', 'creatorType'])),
      textFact('地区', value([account, root], ['location', 'region', 'city'])),
      metricFact('关注', value([account, root], ['followingCount', 'following', 'followingLabel', 'metrics.following'])),
      metricFact('累计获赞', value([account, root, creator], ['totalLikes', 'profileLikes', 'likeCount', 'likes', 'totalLikesLabel', 'metrics.likes'])),
    ],
    tags: [...visibleAccountMetrics, ...publicProfileTags],
  });

  addGroup({
    id: 'identity',
    caption: 'ACCOUNT IDENTITY',
    title: '账号身份',
    basis: '发现任务候选与公开主页',
    facts: [
      textFact('平台', profileText(firstPresent(account.platform, root.platform, creator.platform))),
      textFact('主页名称', profileText(firstPresent(account.displayName, root.displayName, creator.name))),
      textFact('账号标识', profileText(firstPresent(account.handle, root.handle, creator.handle))),
      textFact('认证状态', verifiedLabel),
    ],
  });

  addGroup({
    id: 'account-scale',
    caption: 'ACCOUNT SCALE',
    title: '账号规模',
    basis: '公开主页指标',
    facts: [
      metricFact('粉丝', value([account, root, creator], ['followerCount', 'followers', 'followerLabel', 'followersLabel', 'metrics.followers'])),
      metricFact('关注', value([account, root, creator], ['followingCount', 'following', 'followingLabel', 'metrics.following'])),
      metricFact('累计获赞', value([account, root, creator], ['totalLikes', 'profileLikes', 'likeCount', 'likes', 'totalLikesLabel', 'metrics.likes'])),
      metricFact('作品数', value([account, root], ['workCount', 'works', 'postCount', 'workCountLabel', 'metrics.works'])),
    ],
    tags: [profileText(value([commercial, root], ['creatorTierLabel', 'tierLabel', 'creatorTier']))],
  });

  const contentMixData = plainObject(value([performance, content, root], ['contentMix']));
  const contentMix = Array.isArray(contentMixData.byType) && contentMixData.byType.length
    ? contentMixData.byType.map((entry) => {
      const type = profileText(entry?.type);
      const percent = percentLabel(entry?.percent);
      return type ? `${type}${percent ? ` ${percent}` : ''}` : '';
    }).filter(Boolean)
    : [
      ...compactDimensionValues(value([content, root], ['formatMix', 'contentFormats', 'formats', 'formatDistribution']), 5),
      ...persona.visibleSamples.map((sample) => profileText(sample.contentType)).filter(Boolean),
    ];
  const verticalData = plainObject(value([content, root], ['verticals']));
  const verticals = [
    ...profileList(verticalData.labels, 6),
    ...compactDimensionValues(value([content, root], ['primaryTopics', 'topics', 'themes', 'contentPillars']), 6),
    ...persona.topics,
  ];
  const cadenceData = plainObject(value([performance, content, root], ['postingCadence']));
  const estimatedPostsPer30Days = metricNumber(cadenceData.estimatedPostsPer30Days);
  const medianIntervalDays = metricNumber(cadenceData.medianIntervalDays);
  const averageIntervalDays = metricNumber(cadenceData.averageIntervalDays);
  const cadence = firstPresent(
    estimatedPostsPer30Days !== null ? `${metricDisplay(estimatedPostsPer30Days)} 条 / 30 天` : '',
    medianIntervalDays !== null ? `中位间隔 ${metricDisplay(medianIntervalDays)} 天` : '',
    averageIntervalDays !== null ? `平均间隔 ${metricDisplay(averageIntervalDays)} 天` : '',
    dimensionText(value([content, root], ['cadence', 'publishingCadence', 'postingFrequency'])),
  );
  const latestPublishedAt = audienceCapturedLabel(cadenceData.newestPublishedAt) || latestSampleDate(persona.visibleSamples);
  const averageDurationSeconds = metricNumber(contentMixData.duration?.averageSeconds);
  const pinnedObservedCount = metricNumber(contentMixData.pinned?.observedSampleCount);
  const pinnedSampleCount = metricNumber(contentMixData.pinned?.pinnedSampleCount);
  addGroup({
    id: 'content',
    caption: 'CONTENT RHYTHM',
    title: '内容结构',
    basis: persona.visibleSampleCount ? `基于 ${countLabel(persona.visibleSampleCount)} 条公开内容样本` : '公开内容字段',
    facts: [
      persona.visibleSampleCount > 0 ? textFact('可见样本', `${countLabel(persona.visibleSampleCount)} 条`) : null,
      textFact('内容形式', [...new Set(contentMix)].slice(0, 3).join(' · ')),
      textFact('发布节奏', cadence),
      textFact('最近可见发布', latestPublishedAt),
      averageDurationSeconds !== null ? textFact('平均时长', `${metricDisplay(averageDurationSeconds)} 秒`) : null,
      pinnedObservedCount !== null && pinnedSampleCount !== null
        ? textFact('置顶样本', `${metricDisplay(pinnedSampleCount)} / ${metricDisplay(pinnedObservedCount)} 条`)
        : null,
    ],
    tags: [...new Set(verticals)].slice(0, 8),
  });

  const positioningTopics = [...new Set(verticals.map((item) => profileText(item)).filter(Boolean))].slice(0, 6);
  addGroup({
    id: 'positioning',
    caption: 'CONTENT POSITIONING',
    title: '内容定位',
    basis: '公开简介与内容标题',
    facts: [
      textFact('垂类', value([content, root], ['discoveryNiche', 'niche', 'vertical', 'category'])),
      textFact('内容角度', value([content, root], ['discoveryAngle', 'angle', 'positioning'])),
      textFact('表达风格', value([content, root], ['contentStyle', 'style', 'voice', 'tone'])),
      positioningTopics.length ? textFact('可见话题', `${positioningTopics.length} 个`) : null,
    ],
    tags: positioningTopics,
  });

  addGroup({
    id: 'content-format',
    caption: 'CONTENT FORMAT',
    title: '内容形式',
    basis: persona.visibleSampleCount ? `基于 ${countLabel(persona.visibleSampleCount)} 条公开内容样本` : '公开内容字段',
    facts: [
      textFact('内容形式', [...new Set(contentMix)].slice(0, 3).join(' · ')),
      averageDurationSeconds !== null ? textFact('平均时长', `${metricDisplay(averageDurationSeconds)} 秒`) : null,
      pinnedObservedCount !== null && pinnedSampleCount !== null
        ? textFact('置顶样本', `${metricDisplay(pinnedSampleCount)} / ${metricDisplay(pinnedObservedCount)} 条`)
        : null,
      persona.visibleSampleCount > 0 ? textFact('可见样本', `${countLabel(persona.visibleSampleCount)} 条`) : null,
    ],
    tags: [...new Set(contentMix)].slice(0, 6),
  });

  addGroup({
    id: 'cadence',
    caption: 'PUBLISHING CADENCE',
    title: '发布节奏',
    basis: '带时间戳的公开内容样本',
    facts: [
      textFact('更新频率', cadence),
      textFact('最近可见发布', latestPublishedAt),
      cadenceData.timestampedSampleCount !== undefined && cadenceData.timestampedSampleCount !== null
        ? textFact('时间戳样本', `${metricDisplay(cadenceData.timestampedSampleCount)} 条`)
        : null,
      textFact('计算状态', profileText(cadenceData.status)),
    ],
  });

  const directEngagement = plainObject(value([performance, content, root], ['engagement', 'engagementSummary']));
  const engagementTotals = plainObject(directEngagement.totals);
  const engagementAverages = plainObject(directEngagement.averages);
  const interactionTotals = Object.keys(engagementTotals).length ? engagementTotals : persona.sampleInteractionMetrics;
  const likesCoverage = metricNumber(directEngagement.interactionCoverage?.likes);
  const averageLikes = metricNumber(engagementAverages.likes)
    ?? (likesCoverage !== null && likesCoverage === persona.visibleSampleCount && persona.sampleInteractionMetrics.likes !== undefined
      ? persona.sampleInteractionMetrics.likes / likesCoverage
      : null);
  const engagementRate = value([directEngagement, content, root], ['audienceEngagementRate', 'engagementRate', 'rate', 'avgEngagementRate']);
  const engagementFacts = [
    metricFact('\u6837\u672c\u64ad\u653e', interactionTotals.plays, '\u516c\u5f00\u6837\u672c\u6c47\u603b'),
    metricFact('样本点赞', interactionTotals.likes, '公开样本汇总'),
    metricFact('样本收藏', interactionTotals.collects, '公开样本汇总'),
    metricFact('样本评论', interactionTotals.comments, '公开样本汇总'),
    metricFact('样本分享', interactionTotals.shares, '公开样本汇总'),
    averageLikes !== null ? metricFact('单条平均点赞', averageLikes, '按已观测点赞样本计算') : null,
    textFact('样本互动率', percentLabel(engagementRate), directEngagement.audienceEngagementRateBasis ? '样本均值 / 当前公开粉丝' : ''),
  ];
  addGroup({
    id: 'engagement',
    caption: 'VISIBLE-SAMPLE ENGAGEMENT',
    title: '互动表现',
    basis: persona.visibleSampleCount ? `基于 ${countLabel(persona.visibleSampleCount)} 条公开样本，不代表全量内容` : '公开内容字段',
    facts: engagementFacts,
  });

  const interactionMix = plainObject(directEngagement.interactionMixPer100Likes);
  addGroup({
    id: 'engagement-efficiency',
    caption: 'ENGAGEMENT EFFICIENCY',
    title: '互动效率',
    basis: '公开样本互动与当前公开粉丝',
    facts: [
      averageLikes !== null ? metricFact('单条平均点赞', averageLikes) : null,
      metricFact('单条平均评论', engagementAverages.comments),
      textFact('样本互动率', percentLabel(engagementRate)),
      likesCoverage !== null && persona.visibleSampleCount
        ? textFact('点赞可用样本', `${metricDisplay(likesCoverage)} / ${countLabel(persona.visibleSampleCount)} 条`)
        : null,
    ],
    tags: [
      interactionMix.comments !== undefined ? `每百赞评论 ${metricDisplay(interactionMix.comments)}` : '',
      interactionMix.collects !== undefined ? `每百赞收藏 ${metricDisplay(interactionMix.collects)}` : '',
      interactionMix.shares !== undefined ? `每百赞分享 ${metricDisplay(interactionMix.shares)}` : '',
    ],
  });

  const disclosure = plainObject(value([commercial, root], ['explicitDisclosure']));
  const brandMentionData = plainObject(value([commercial, root], ['brandMentions']));
  const commercialSignals = [
    ...profileList(value([commercial, root], ['signals', 'commercialSignals', 'collaborationSignals', 'cooperationSignals']), 6),
    ...profileList(disclosure.labels, 6),
  ];
  const brandMentions = brandMentionData.labels?.length
    ? profileList(brandMentionData.labels, 6)
    : compactDimensionValues(value([commercial, root], ['mentionedBrands', 'cooperatedBrands']), 6);
  const disclosureSamples = metricNumber(disclosure.sampleCount);
  const disclosureDetected = metricNumber(disclosure.detectedSampleCount);
  const fit = percentLabel(value([commercial, root], ['discoveryFit', 'fit', 'matchScore', 'brandFit']));
  addGroup({
    id: 'commercial',
    caption: 'COMMERCIAL FIT',
    title: '商业匹配',
    basis: '任务匹配与公开合作字段',
    facts: [
      textFact('达人量级', value([commercial, root], ['creatorTierLabel', 'tierLabel', 'creatorTier'])),
      textFact('Brief 匹配', fit),
      textFact('参考报价', value([commercial, root], ['quoteLabel', 'priceLabel', 'quote', 'price', 'estimatedPrice'])),
      textFact('合作状态', value([commercial, root], ['cooperationStatus', 'availability', 'collaborationStatus'])),
      disclosureSamples !== null && disclosureDetected !== null
        ? textFact('公开披露样本', `${metricDisplay(disclosureDetected)} / ${metricDisplay(disclosureSamples)} 条`)
        : null,
    ],
    tags: [...commercialSignals, ...brandMentions],
  });

  addGroup({
    id: 'commercial-evidence',
    caption: 'PUBLIC COMMERCIAL SIGNALS',
    title: '合作线索',
    basis: '公开主页标签与内容样本',
    facts: [
      disclosureSamples !== null && disclosureDetected !== null
        ? textFact('披露样本', `${metricDisplay(disclosureDetected)} / ${metricDisplay(disclosureSamples)} 条`)
        : null,
      textFact('披露状态', profileText(disclosure.status)),
      brandMentions.length ? textFact('提及品牌', `${brandMentions.length} 个`) : null,
      commercialSignals.length ? textFact('合作信号', `${commercialSignals.length} 项`) : null,
    ],
    tags: [...commercialSignals, ...brandMentions],
  });

  const audienceTotal = value([audience, root], ['totalAudience', 'audienceTotal', 'total', 'aggregate.totalAudience'])
    ?? profileValue(audienceInsight?.profile, ['totalAudience', 'audienceTotal', 'total']);
  const audienceSample = firstPresent(
    audienceInsight?.coverage?.sampleSize,
    value([audience, root], ['sampleSize', 'aggregate.sampleSize', 'coverage.sampleSize']),
  );
  const audienceCoverage = firstPresent(
    audienceInsight?.coverage?.coverageRate,
    value([audience, root], ['coverageRate', 'aggregate.coverageRate', 'coverage.coverageRate']),
  );
  const audienceInterests = (audienceInsight?.interests || []).map((entry) => entry.label).filter(Boolean).slice(0, 4);
  const audienceHours = (audienceInsight?.activeHours || []).map((entry) => entry.label).filter(Boolean).slice(0, 3);
  const audienceSignals = [
    ...persona.publicAudienceSignals,
    ...compactDimensionValues(value([audience, root], ['publicSignals', 'signals', 'interests', 'interestTags']), 6),
    ...audienceInterests,
  ];
  addGroup({
    id: 'audience',
    caption: 'AUDIENCE / AGGREGATE',
    title: '受众线索',
    basis: audienceInsight ? '官方或已授权聚合受众数据' : '公开主页受众信号',
    includeWhenEmpty: true,
    facts: [
      metricFact('受众总量', audienceTotal),
      metricFact('聚合样本', audienceSample),
      textFact('覆盖率', percentLabel(audienceCoverage)),
      textFact('活跃时段', audienceHours.join(' · ') || dimensionText(value([audience, root], ['activeHours', 'activityHours']))),
      !audienceTotal && !audienceSample && !audienceCoverage && !audienceSignals.length ? textFact('状态', '未返回') : null,
    ],
    tags: audienceSignals,
  });

  const audienceDistributionRows = (provided, paths) => (
    Array.isArray(provided) && provided.length ? provided : audienceDistribution(value([audience, root], paths))
  );
  const dominantAudienceSegment = (items) => {
    const [top] = [...items]
      .filter((item) => profileText(item?.label))
      .sort((left, right) => Number(right?.percent || 0) - Number(left?.percent || 0));
    return top ? [profileText(top.label), profileText(firstPresent(top.percentLabel, top.value))].filter(Boolean).join(' ') : '';
  };
  const genderDistribution = audienceDistributionRows(audienceInsight?.gender, ['gender', 'genderDistribution']);
  const ageDistribution = audienceDistributionRows(audienceInsight?.age, ['age', 'ageDistribution']);
  const cityTierDistribution = audienceDistributionRows(audienceInsight?.cityTier, ['cityTier', 'cityTierDistribution']);
  addGroup({
    id: 'audience-demographics',
    caption: 'AUDIENCE DEMOGRAPHICS',
    title: '受众人口属性',
    basis: audienceInsight ? '官方或已授权聚合受众数据' : '达人数据任务返回字段',
    facts: [
      textFact('性别偏好', dominantAudienceSegment(genderDistribution)),
      textFact('年龄偏好', dominantAudienceSegment(ageDistribution)),
      textFact('城市层级', dominantAudienceSegment(cityTierDistribution)),
    ],
  });

  addGroup({
    id: 'audience-preferences',
    caption: 'AUDIENCE INTERESTS',
    title: '受众兴趣与活跃',
    basis: audienceInsight ? '官方或已授权聚合受众数据' : '公开主页受众信号',
    facts: [
      textFact('活跃时段', audienceHours.join(' · ') || dimensionText(value([audience, root], ['activeHours', 'activityHours']))),
      audienceSignals.length ? textFact('可见兴趣线索', `${audienceSignals.length} 项`) : null,
      audienceInsight?.interests?.length ? textFact('聚合兴趣分组', `${audienceInsight.interests.length} 组`) : null,
      audienceInsight?.activeHours?.length ? textFact('活跃分组', `${audienceInsight.activeHours.length} 组`) : null,
    ],
    tags: audienceSignals,
  });

  const growthMetrics = plainObject(value([growth], ['metrics']));
  const followerGrowth = plainObject(growthMetrics.followers);
  const growthRate = firstPresent(
    followerGrowth.changePercent,
    value([growth, root], ['followerGrowthRate', 'followersGrowthRate', 'growthRate', 'rate', 'followers.rate']),
  );
  const followerDelta = firstPresent(
    followerGrowth.change,
    value([growth, root], ['followerDelta', 'followersDelta', 'netFollowerGrowth', 'followers.change', 'change']),
  );
  const observationWindowDays = metricNumber(growth.observationWindowDays);
  const growthWindow = firstPresent(
    observationWindowDays !== null ? `${metricDisplay(observationWindowDays)} 天` : '',
    dimensionText(value([growth, root], ['window', 'period', 'observationWindow', 'timeframe'])),
  );
  const priorFollowers = metricDisplay(followerGrowth.previous);
  const currentFollowers = metricDisplay(followerGrowth.current);
  addGroup({
    id: 'growth',
    caption: 'GROWTH SIGNALS',
    title: '增长趋势',
    basis: observationWindowDays !== null ? '同一达人两次公开主页快照对比' : '历史采集返回字段',
    facts: [
      metricFact('粉丝变化', followerDelta),
      textFact('增长率', percentLabel(growthRate)),
      textFact('观察周期', growthWindow),
      priorFollowers && currentFollowers
        ? textFact('快照对比', `${priorFollowers} → ${currentFollowers}`)
        : textFact('趋势', value([growth], ['trend', 'label'])),
    ],
  });

  const riskSignals = compactDimensionValues(value([risk, root], ['publicFlags', 'flags', 'signals', 'alerts', 'issues', 'reviewNotes']), 6);
  const capturedAt = audienceCapturedLabel(value([root], ['capturedAt']) || value([risk], ['capturedAt', 'reviewedAt']));
  const reviewStatus = value([risk, quality], ['reviewStatus', 'level', 'summary']);
  addGroup({
    id: 'risk',
    caption: 'RISK / REVIEW',
    title: '风险与审核',
    basis: '公开内容样本与已返回审核字段',
    includeWhenEmpty: true,
    facts: [
      textFact('审核状态', reviewStatus || '未返回'),
      textFact('公开风险信号', riskSignals.length ? `${riskSignals.length} 项` : '未返回'),
      textFact('最近审核', audienceCapturedLabel(value([risk], ['reviewedAt', 'capturedAt']))),
    ],
    tags: riskSignals,
  });
  addGroup({
    id: 'quality',
    caption: 'DATA / REVIEW',
    title: '数据与审核',
    basis: '来源快照与已返回审核字段',
    facts: [
      textFact('字段完整度', percentLabel(quality.completeness)),
      textFact('数据置信度', ({ high: '高', medium: '中', low: '低' }[quality.confidence] || quality.confidence)),
      textFact('审核状态', reviewStatus),
      textFact('采集时间', capturedAt),
    ],
    tags: [...riskSignals, ...persona.observedFields],
  });

  return groups;
}

function numericPercent(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace('%', '').trim());
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed <= 1 ? parsed * 100 : parsed));
}

function audienceDistribution(value) {
  const records = Array.isArray(value)
    ? value
    : Object.entries(plainObject(value)).map(([label, entry]) => (
      typeof entry === 'object' && entry !== null
        ? { ...plainObject(entry), label: profileText(firstPresent(entry.label, entry.name, entry.title, label)) }
        : { label, value: entry, percent: entry }
    ));
  return records.map((entry, index) => {
    const item = plainObject(entry);
    const label = profileText(firstPresent(item.label, item.name, item.title, item.key, item.category, item.group), `分组 ${index + 1}`);
    const valueLabel = countLabel(firstPresent(item.value, item.count, item.total, item.audience, item.size));
    const rawPercent = firstPresent(item.percent, item.percentage, item.share, item.rate, item.ratio);
    const percent = numericPercent(rawPercent);
    return {
      label,
      value: valueLabel,
      percent,
      percentLabel: rawPercent === undefined || rawPercent === null || rawPercent === '' ? '' : percentLabel(rawPercent),
    };
  }).filter((entry) => entry.label);
}

function additionalAudienceDimensions(root, data) {
  const knownDimensions = new Set(['gender', 'age', 'citytier', 'interests', 'activehours']);
  const dimensions = new Map();
  [plainObject(root.dimensions), plainObject(data.dimensions)].forEach((container) => {
    Object.entries(container).forEach(([key, value]) => {
      const id = profileText(key).replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || `dimension-${dimensions.size + 1}`;
      if (knownDimensions.has(id) || dimensions.has(id)) return;
      const descriptor = plainObject(value);
      const entries = audienceDistribution(firstPresent(
        descriptor.rows,
        descriptor.items,
        descriptor.values,
        descriptor.buckets,
        value,
      ));
      if (!entries.length) return;
      dimensions.set(id, {
        id,
        title: profileText(firstPresent(descriptor.label, descriptor.title, descriptor.name), profileText(key)),
        caption: profileText(descriptor.caption, profileText(key).toUpperCase()),
        entries,
      });
    });
  });
  return [...dimensions.values()];
}

function normalizeAudienceInsight(value, fallbackCreatorId = '') {
  const raw = plainObject(value);
  const nested = plainObject(firstPresent(raw.audienceInsight, raw.audience, raw.insight));
  const root = Object.keys(nested).length ? nested : raw;
  const data = plainObject(root.data);
  const source = objectSection(root.source, data.source);
  const profile = objectSection(root.profile, data.profile);
  const coverage = objectSection(root.coverage, data.coverage);
  const gender = audienceDistribution(firstPresent(root.gender, data.gender, root.genderDistribution, data.genderDistribution));
  const age = audienceDistribution(firstPresent(root.age, data.age, root.ageDistribution, data.ageDistribution));
  const cityTier = audienceDistribution(firstPresent(root.cityTier, data.cityTier, root.cityTierDistribution, data.cityTierDistribution));
  const interests = audienceDistribution(firstPresent(root.interests, data.interests, root.interestDistribution, data.interestDistribution));
  const activeHours = audienceDistribution(firstPresent(root.activeHours, data.activeHours, root.activityHours, data.activityHours, root.activeTime, data.activeTime));
  const dimensions = additionalAudienceDimensions(root, data);
  const creatorId = profileText(firstPresent(root.creatorId, root.targetId, data.creatorId, data.targetId, fallbackCreatorId));
  const hasData = [gender, age, cityTier, interests, activeHours].some((items) => items.length)
    || dimensions.length
    || Object.keys(source).length > 0 || Object.keys(coverage).length > 0;
  if (!hasData) return null;
  return {
    ...root,
    id: profileText(firstPresent(root.id, data.id)),
    discoveryJobId: profileText(firstPresent(root.discoveryJobId, data.discoveryJobId)),
    creatorId,
    creatorName: profileText(firstPresent(root.creatorName, data.creatorName)),
    channel: profileText(firstPresent(root.channel, data.channel)),
    capturedAt: firstPresent(root.capturedAt, data.capturedAt, source.capturedAt),
    source: {
      type: profileText(firstPresent(source.type, source.sourceType)),
      label: profileText(firstPresent(source.label, source.name, source.provider, source.type, source.sourceType)),
      capturedAt: firstPresent(source.capturedAt, root.capturedAt, data.capturedAt),
      dataScope: profileText(firstPresent(source.dataScope, source.scope), 'aggregate'),
    },
    profile,
    gender,
    age,
    cityTier,
    interests,
    activeHours,
    dimensions,
    coverage: {
      sampleSize: firstPresent(coverage.sampleSize, coverage.sample, coverage.audienceSize),
      coverageRate: firstPresent(coverage.coverageRate, coverage.rate),
      completeness: firstPresent(coverage.completeness, coverage.completenessRate),
      confidence: firstPresent(coverage.confidence, coverage.confidenceRate),
    },
    evidence: objectSection(root.evidence, data.evidence),
  };
}

function audienceInsightMap(items) {
  const records = Array.isArray(items) ? items : [];
  return Object.fromEntries(records.map((record) => {
    const insight = normalizeAudienceInsight(record);
    return insight?.creatorId ? [insight.creatorId, insight] : null;
  }).filter(Boolean));
}

function audienceInsightFromProfile(profile, creatorId) {
  const root = plainObject(profile);
  const data = plainObject(root.data);
  const candidates = [
    root.audienceInsight,
    root.audience,
    root.audienceInsights,
    root.fanAudience,
    root.followerAudience,
    data.audienceInsight,
    data.audience,
    data.audienceInsights,
    data.fanAudience,
    data.followerAudience,
  ].flatMap((candidate) => Array.isArray(candidate) ? candidate : [candidate]);
  return candidates.map((candidate) => normalizeAudienceInsight(candidate, creatorId)).find(Boolean) || null;
}

function audienceInsightForCreator(creator, profile, audienceByTargetId) {
  return audienceByTargetId?.[creator.id] || audienceInsightFromProfile(profile, creator.id);
}

function audienceInsightsFromProfiles(profiles) {
  return Object.fromEntries(Object.entries(profiles || {}).map(([creatorId, profile]) => {
    const insight = audienceInsightFromProfile(profile, creatorId);
    return insight ? [creatorId, insight] : null;
  }).filter(Boolean));
}

function audienceCapturedLabel(value) {
  if (!value) return '';
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return profileText(value);
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(timestamp);
}

function archivedEnrichmentJobs(entry) {
  const jobs = [
    ...(Array.isArray(entry?.enrichmentJobs) ? entry.enrichmentJobs : []),
    entry?.currentEnrichmentJob,
    entry?.enrichmentJob,
  ].filter((job) => job?.id);
  return jobs.filter((job, index) => jobs.findIndex((candidate) => candidate.id === job.id) === index);
}

function archivedContentJobs(entry) {
  const jobs = [
    ...(Array.isArray(entry?.contentJobs) ? entry.contentJobs : []),
    entry?.currentContentJob,
    entry?.contentJob,
  ].filter((job) => job?.id);
  return jobs.filter((job, index) => jobs.findIndex((candidate) => candidate.id === job.id) === index);
}

function archivedContentAnalysisJobs(entry) {
  const jobs = [
    ...(Array.isArray(entry?.contentAnalysisJobs) ? entry.contentAnalysisJobs : []),
    entry?.currentContentAnalysisJob,
    entry?.contentAnalysisJob,
  ].filter((job) => job?.id);
  return jobs
    .filter((job, index) => jobs.findIndex((candidate) => candidate.id === job.id) === index)
    .sort((left, right) => String(right.updatedAt || right.createdAt)
      .localeCompare(String(left.updatedAt || left.createdAt)));
}

function jobContainsTarget(job, targetId) {
  if (!job?.id || !targetId) return false;
  if (Array.isArray(job.selectedCreatorIds) && job.selectedCreatorIds.includes(targetId)) return true;
  if (Array.isArray(job.targets) && job.targets.some((target) => target?.id === targetId || target?.targetId === targetId)) return true;
  if (Array.isArray(job.results) && job.results.some((result) => (
    result?.targetId === targetId || result?.creatorId === targetId || result?.id === targetId
  ))) return true;
  return Object.values(plainObject(job.channelResults)).some((result) => (
    result?.targetId === targetId || result?.creatorId === targetId
  ));
}

function defaultJobForTarget(jobs, targetId, pinnedJobId = '') {
  const matching = uniqueJobs(jobs || []).filter((job) => jobContainsTarget(job, targetId));
  const pinned = matching.find((job) => job.id === pinnedJobId);
  if (pinned && !['failed', 'cancelled'].includes(pinned.status)) return pinned;
  return matching
    .filter((job) => !['failed', 'cancelled'].includes(job.status))
    .sort((left, right) => String(right.updatedAt || right.createdAt)
      .localeCompare(String(left.updatedAt || left.createdAt)))[0] || null;
}

function detailJobSummaries(jobs, targetId, pinnedJobId = '') {
  const candidates = uniqueJobs(jobs || []);
  if (!targetId) return candidates;

  if (pinnedJobId) {
    const pinned = candidates.find((job) => job.id === pinnedJobId);
    if (!pinned) return [];

    const selectedIds = Array.isArray(pinned.selectedCreatorIds) ? pinned.selectedCreatorIds : [];
    const selectedCount = Number(pinned.selectedCreatorCount || selectedIds.length);
    const hasCompleteTargetList = selectedCount > 0 && selectedIds.length >= selectedCount;
    if (hasCompleteTargetList && !jobContainsTarget(pinned, targetId)) return [];
    return [pinned];
  }

  return candidates.filter((job) => jobContainsTarget(job, targetId));
}

function App() {
  const detailRoute = useDetailRoute();
  const [appModule, navigateModule] = useAppModule();
  const [detailRouteLoading, setDetailRouteLoading] = useState(() => detailRoute.view !== 'workspace');
  const [detailRouteError, setDetailRouteError] = useState('');
  const [currentStep, setCurrentStep] = useState(1);
  const [maxUnlocked, setMaxUnlocked] = useState(1);
  const [brief, setBrief] = useState(initialBrief);
  const [channels, setChannels] = useState(['xiaohongshu', 'douyin']);
  const [creators, setCreators] = useState([]);
  const [selectedKols, setSelectedKols] = useState([]);
  const [discoveryQuery, setDiscoveryQuery] = useState('');
  const [candidateLimit, setCandidateLimit] = useState('full');
  const [candidatePage, setCandidatePage] = useState({
    jobId: '',
    loaded: 0,
    total: 0,
    nextCursor: null,
    loading: false,
    error: '',
  });
  const [priorityBatchLimit, setPriorityBatchLimit] = useState('500');
  const [creatorFilter, setCreatorFilter] = useState('');
  const [connectors, setConnectors] = useState({});
  const [connectionRetention, setConnectionRetention] = useState(null);
  const [connectorChecking, setConnectorChecking] = useState(false);
  const [connectorRecovery, setConnectorRecovery] = useState('');
  const [discoveryJob, setDiscoveryJob] = useState(null);
  const [verificationJob, setVerificationJob] = useState(null);
  const [verifiedByTargetId, setVerifiedByTargetId] = useState({});
  const [enrichmentJob, setEnrichmentJob] = useState(null);
  const [enrichmentJobs, setEnrichmentJobs] = useState([]);
  const [enrichedByTargetId, setEnrichedByTargetId] = useState({});
  const [enrichmentError, setEnrichmentError] = useState('');
  const [contentJob, setContentJob] = useState(null);
  const [contentJobs, setContentJobs] = useState([]);
  const [contentByTargetId, setContentByTargetId] = useState({});
  const [contentError, setContentError] = useState('');
  const [contentSampleLimit, setContentSampleLimit] = useState('10000');
  const [contentAnalysisJob, setContentAnalysisJob] = useState(null);
  const [contentAnalysisJobs, setContentAnalysisJobs] = useState([]);
  const [contentAnalysisByTargetId, setContentAnalysisByTargetId] = useState({});
  const [contentAnalysisError, setContentAnalysisError] = useState('');
  const [contentAnalysisSourceJobId, setContentAnalysisSourceJobId] = useState('');
  const [audienceByTargetId, setAudienceByTargetId] = useState({});
  const [audienceLoading, setAudienceLoading] = useState(false);
  const [audienceImportingTargetId, setAudienceImportingTargetId] = useState('');
  const [audienceError, setAudienceError] = useState('');
  const [activeJob, setActiveJob] = useState(null);
  const [generated, setGenerated] = useState(false);
  const [sent, setSent] = useState([]);
  const [outreachDrafts, setOutreachDrafts] = useState([]);
  const [outreachDraftsLoading, setOutreachDraftsLoading] = useState(false);
  const [outreachDraftsError, setOutreachDraftsError] = useState('');
  const [campaign, setCampaign] = useState(null);
  const [campaignArchive, setCampaignArchive] = useState([]);
  const [recentCollections, setRecentCollections] = useState([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const completedJobs = useRef(new Set());
  const restoringCampaign = useRef(false);
  const initialDetailRouteKey = useRef(detailRoute.key);

  const activeChannels = channelOptions.filter((channel) => channels.includes(channel.id));
  const collectionArchiveEntries = useMemo(() => {
    const campaignJobIds = new Set(campaignArchive.flatMap((entry) => [
      entry.discoveryJob,
      ...(entry.verificationJobs || []),
      ...archivedEnrichmentJobs(entry),
      ...archivedContentJobs(entry),
      ...archivedContentAnalysisJobs(entry),
    ].map((job) => job?.id).filter(Boolean)));
    const archiveEntries = [
      ...campaignArchive.flatMap((entry) => [
        {
          id: entry.campaign.id,
          kind: 'campaign',
          campaign: entry.campaign,
          job: entry.discoveryJob,
        },
        ...(entry.verificationJobs || []).map((job) => ({
          id: job.id,
          kind: 'verification',
          campaign: entry.campaign,
          job,
        })),
        ...archivedEnrichmentJobs(entry).map((job) => ({
          id: job.id,
          kind: 'enrichment',
          campaign: entry.campaign,
          job,
        })),
        ...archivedContentJobs(entry).map((job) => ({
          id: job.id,
          kind: 'content',
          campaign: entry.campaign,
          job,
        })),
        ...archivedContentAnalysisJobs(entry).map((job) => ({
          id: job.id,
          kind: 'content_analysis',
          campaign: entry.campaign,
          job,
        })),
      ]),
      ...recentCollections
        .filter((job) => !campaignJobIds.has(job.id))
        .map((job) => ({ id: job.id, kind: 'job', campaign: null, job })),
    ];
    const distinctArchiveEntries = new Map();
    archiveEntries.forEach((entry) => {
      const key = `${entry.kind}-${entry.id}`;
      if (!distinctArchiveEntries.has(key)) distinctArchiveEntries.set(key, entry);
    });
    return [...distinctArchiveEntries.values()].sort((left, right) => String(
      right.job?.updatedAt || right.job?.createdAt || right.campaign?.updatedAt || right.campaign?.createdAt,
    ).localeCompare(String(
      left.job?.updatedAt || left.job?.createdAt || left.campaign?.updatedAt || left.campaign?.createdAt,
    ))).slice(0, 12);
  }, [campaignArchive, recentCollections]);
  const activeSelectedKols = useMemo(() => selectedKols
    .map((id) => creators.find((creator) => creator.id === id))
    .map((creator) => {
      if (!creator || !channels.includes(creator.channel)) return null;
      const persona = enrichedByTargetId[creator.id];
      const withProfile = persona ? creatorWithPersona(creator, persona) : creator;
      return creatorWithContentCapture(withProfile, contentByTargetId[creator.id]);
    })
    .filter(Boolean), [selectedKols, creators, channels, enrichedByTargetId, contentByTargetId]);
  const verifiedSelectedKols = useMemo(() => activeSelectedKols
    .map((creator) => {
      const verification = verifiedByTargetId[creator.id];
      if (!verification) return null;
      return creatorWithContentCapture({
        ...creator,
        ...verification,
        id: creator.id,
        channel: creator.channel,
        platform: creator.platform,
      }, contentByTargetId[creator.id]);
    })
    .filter(Boolean), [activeSelectedKols, verifiedByTargetId, contentByTargetId]);
  const profileConfirmedSelectedKols = useMemo(() => activeSelectedKols
    .map((creator) => {
      const persona = enrichedByTargetId[creator.id];
      return hasConfirmedProfile(persona)
        ? creatorWithContentCapture(creatorWithPersona(creator, persona), contentByTargetId[creator.id])
        : null;
    })
    .filter(Boolean), [activeSelectedKols, enrichedByTargetId, contentByTargetId]);
  const running = isActiveJob(activeJob?.job);
  const enrichmentRunning = isActiveJob(enrichmentJob);
  const contentRunning = isActiveJob(contentJob);
  const contentAnalysisRunning = isActiveJob(contentAnalysisJob);
  const verificationComplete = activeSelectedKols.length > 0 && verifiedSelectedKols.length === activeSelectedKols.length;
  const profileConfirmationComplete = activeSelectedKols.length > 0 && profileConfirmedSelectedKols.length === activeSelectedKols.length;
  const outreachReady = verificationComplete || profileConfirmationComplete;
  const outreachSelectedKols = verificationComplete ? verifiedSelectedKols : profileConfirmedSelectedKols;
  const outreachContentMissing = useMemo(() => outreachSelectedKols.filter((creator) => (
    !evidenceBackedOutreachContext(contentAnalysisByTargetId[creator.id])
  )), [outreachSelectedKols, contentAnalysisByTargetId]);
  const contentOutreachReady = outreachSelectedKols.length > 0 && outreachContentMissing.length === 0;
  const effectiveProfileSources = useMemo(() => effectiveProfileSourcesFor(
    enrichmentJobs,
    activeSelectedKols.map((creator) => creator.id),
  ), [enrichmentJobs, activeSelectedKols]);
  const enrichmentArtifactCount = useMemo(() => profileArtifactCountFromSources(effectiveProfileSources), [effectiveProfileSources]);
  const enrichmentRunCount = useMemo(
    () => new Set(effectiveProfileSources.map(({ job }) => job?.id).filter(Boolean)).size,
    [effectiveProfileSources],
  );
  const effectiveContentSources = useMemo(() => effectiveContentSourcesFor(
    contentJobs,
    activeSelectedKols.map((creator) => creator.id),
  ), [contentJobs, activeSelectedKols]);
  const contentArtifactCount = useMemo(
    () => profileArtifactCountFromSources(effectiveContentSources),
    [effectiveContentSources],
  );
  const contentRunCount = useMemo(
    () => new Set(effectiveContentSources.map(({ job }) => job?.id).filter(Boolean)).size,
    [effectiveContentSources],
  );
  const contentSampleCount = useMemo(() => activeSelectedKols.reduce((total, creator) => (
    total + publicContentSamples(contentByTargetId[creator.id]?.content?.visibleSamples).length
  ), 0), [activeSelectedKols, contentByTargetId]);
  const effectiveContentAnalysisSources = useMemo(() => effectiveAnalysisSourcesFor(
    contentAnalysisJobs,
    activeSelectedKols.map((creator) => creator.id),
  ), [contentAnalysisJobs, activeSelectedKols]);
  const contentAnalysisRunCount = useMemo(
    () => new Set(effectiveContentAnalysisSources.map(({ job }) => job?.id).filter(Boolean)).size,
    [effectiveContentAnalysisSources],
  );
  const contentAnalysisCreatorCount = useMemo(() => activeSelectedKols
    .filter((creator) => Boolean(contentAnalysisByTargetId[creator.id]?.analysis)).length,
  [activeSelectedKols, contentAnalysisByTargetId]);
  const contentAnalysisFindingCount = useMemo(() => activeSelectedKols.reduce((total, creator) => (
    total + analysisFindingCount(contentAnalysisByTargetId[creator.id])
  ), 0), [activeSelectedKols, contentAnalysisByTargetId]);
  const readyOutreachDraftCount = useMemo(
    () => outreachDrafts.filter((draft) => draft?.status === 'ready').length,
    [outreachDrafts],
  );

  useEffect(() => {
    const handleKeydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
      }
      if (event.key === 'Escape') setCommandPaletteOpen(false);
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, []);

  const notify = (message) => {
    setToast(message);
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setToast(''), 3400);
  };

  const clearOutreachDraftState = () => {
    setGenerated(false);
    setSent([]);
    setOutreachDrafts([]);
    setOutreachDraftsError('');
  };

  const refreshConnectors = async ({ recheck = false } = {}) => {
    setConnectorChecking(true);
    try {
      const response = await fetch(apiPath(recheck ? '/api/connectors/recheck' : '/api/connectors'), {
        method: recheck ? 'POST' : 'GET',
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || '连接器状态读取失败');
      setConnectors(payload.connectors || {});
      setConnectionRetention(payload.connectionRetention || null);
    } catch (error) {
      setConnectors({ _error: { status: 'failed', detail: error.message, action: '启动本地 API 服务后刷新页面。' } });
      setConnectionRetention(null);
    } finally {
      setConnectorChecking(false);
    }
  };

  const recoverConnector = async (platform) => {
    setConnectorRecovery(platform);
    try {
      const response = await fetch(apiPath('/api/connectors/recover'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || payload.recovery?.message || '\u8fde\u63a5\u5668\u4fee\u590d\u5931\u8d25');
      setConnectors(payload.connectors || {});
      setConnectionRetention(payload.connectionRetention || null);
      notify(payload.recovery?.message || '\u8fde\u63a5\u5668\u5df2\u6062\u590d');
    } catch (error) {
      notify(error.message || '\u8fde\u63a5\u5668\u4fee\u590d\u5931\u8d25');
    } finally {
      setConnectorRecovery('');
    }
  };

  const fetchJob = async (jobId, { summary = false } = {}) => {
    const response = await fetch(apiPath(`/api/jobs/${encodeURIComponent(jobId)}${summary ? '?summary=1' : ''}`));
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || '任务档案读取失败');
    return payload.job;
  };

  const loadDiscoveryCandidatePage = async (jobId, { reset = false } = {}) => {
    const current = candidatePage.jobId === jobId
      ? candidatePage
      : { jobId, loaded: 0, total: 0, nextCursor: null, loading: false, error: '' };
    if (!reset && (!current.nextCursor || current.loading)) return null;
    const cursor = reset ? '' : current.nextCursor;
    setCandidatePage({
      ...current,
      jobId,
      ...(reset ? { loaded: 0, total: 0, nextCursor: null } : {}),
      loading: true,
      error: '',
    });
    try {
      const params = new URLSearchParams({ limit: '1000' });
      if (cursor) params.set('cursor', cursor);
      const response = await fetch(apiPath(`/api/jobs/${encodeURIComponent(jobId)}/candidates?${params.toString()}`));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || '候选分页读取失败');
      const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
      setCreators((previous) => {
        const base = reset || candidatePage.jobId !== jobId ? [] : previous;
        const byId = new Map(base
          .filter((creator) => isCreatorProfileUrl(creator.channel, creator.sourceUrl))
          .map((creator) => [creator.id, creator]));
        candidates
          .filter((creator) => isCreatorProfileUrl(creator.channel, creator.sourceUrl))
          .forEach((creator) => byId.set(creator.id, creator));
        return [...byId.values()];
      });
      const total = Math.max(0, Number(payload.total) || 0);
      const offset = Math.max(0, Number(payload.offset) || 0);
      setCandidatePage({
        jobId,
        loaded: Math.min(total, offset + candidates.length),
        total,
        nextCursor: payload.nextCursor || null,
        loading: false,
        error: '',
      });
      return payload;
    } catch (error) {
      setCandidatePage((previous) => previous.jobId === jobId
        ? { ...previous, loading: false, error: error.message || '候选分页读取失败' }
        : previous);
      notify(`候选分页读取失败：${error.message}`);
      return null;
    }
  };

  const fetchContentAnalysisJob = async (jobId) => {
    const response = await fetch(apiPath(`/api/jobs/${jobId}/content-analysis`));
    const payload = await response.json().catch(() => ({}));
    if (response.status === 404) return fetchJob(jobId);
    if (!response.ok) throw new Error(payload.error?.message || '内容分析任务档案读取失败');
    const job = payload.job || payload.data?.job;
    if (!job?.id) throw new Error('内容分析任务未返回可追踪的任务编号');
    const analyses = Array.isArray(payload.analyses) ? payload.analyses : job.results;
    return {
      ...job,
      results: Array.isArray(analyses) ? analyses : [],
      artifactsUrl: payload.artifactsUrl || job.artifactsUrl,
    };
  };

  const refreshAudienceInsights = async (jobId = discoveryJob?.id, { quiet = false } = {}) => {
    if (!jobId) return null;
    setAudienceLoading(true);
    try {
      const response = await fetch(apiPath(`/api/audience-insights?discoveryJobId=${encodeURIComponent(jobId)}`));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || '粉丝画像读取失败');
      const insights = audienceInsightMap(payload.audienceInsights || payload.data?.audienceInsights || []);
      setAudienceByTargetId((current) => ({ ...current, ...insights }));
      setAudienceError('');
      if (!quiet) notify(`已同步 ${Object.keys(insights).length} 份粉丝画像。`);
      return insights;
    } catch (error) {
      setAudienceError(error.message || '粉丝画像读取失败');
      if (!quiet) notify(`粉丝画像读取失败：${error.message}`);
      return null;
    } finally {
      setAudienceLoading(false);
    }
  };

  const importAudienceInsight = async (creator, file) => {
    if (!discoveryJob?.id || !creator?.id) {
      notify('请先完成候选采集后再导入粉丝画像。');
      return;
    }
    if (!file) return;
    setAudienceImportingTargetId(creator.id);
    setAudienceError('');
    try {
      const text = await file.text();
      if (!text.trim()) throw new Error('JSON 文件为空');
      let importedPayload;
      try {
        importedPayload = JSON.parse(text);
      } catch {
        throw new Error('请选择有效的 JSON 文件');
      }
      if (importedPayload === null || typeof importedPayload !== 'object' || Array.isArray(importedPayload)) throw new Error('JSON 根节点必须是对象');
      const response = await fetch(apiPath('/api/audience-insights/import'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          discoveryJobId: discoveryJob.id,
          creatorId: creator.id,
          payload: importedPayload,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error?.message || '粉丝画像导入失败');
      const insight = normalizeAudienceInsight(result.audienceInsight || result.data?.audienceInsight, creator.id);
      if (insight) setAudienceByTargetId((current) => ({ ...current, [creator.id]: insight }));
      else await refreshAudienceInsights(discoveryJob.id, { quiet: true });
      notify(`${creator.name} 的粉丝画像已导入。`);
    } catch (error) {
      const message = error.message || '粉丝画像导入失败';
      setAudienceError(message);
      notify(`粉丝画像导入失败：${message}`);
    } finally {
      setAudienceImportingTargetId('');
    }
  };

  const refreshArchive = async ({ quiet = false } = {}) => {
    setArchiveLoading(true);
    try {
      const [campaignResponse, jobsResponse] = await Promise.all([
        fetch(apiPath('/api/campaigns?limit=12')),
        fetch(apiPath('/api/jobs?limit=50')),
      ]);
      const [campaignPayload, jobsPayload] = await Promise.all([campaignResponse.json(), jobsResponse.json()]);
      if (!campaignResponse.ok) throw new Error(campaignPayload.error?.message || '项目档案读取失败');
      if (!jobsResponse.ok) throw new Error(jobsPayload.error?.message || '采集档案读取失败');
      const nextCampaigns = campaignPayload.campaigns || [];
      const nextJobs = jobsPayload.jobs || [];
      setCampaignArchive(nextCampaigns);
      setRecentCollections(nextJobs);
      return { campaigns: nextCampaigns, jobs: nextJobs };
    } catch (error) {
      if (!quiet) notify(`任务档案读取失败：${error.message}`);
      return { campaigns: [], jobs: [] };
    } finally {
      setArchiveLoading(false);
    }
  };

  const saveCampaign = async (campaignId, patch, { quiet = true } = {}) => {
    if (!campaignId) return null;
    try {
      const response = await fetch(apiPath(`/api/campaigns/${campaignId}`), {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || '项目保存失败');
      setCampaign(payload.campaign);
      return payload.campaign;
    } catch (error) {
      if (!quiet) notify(`项目保存失败：${error.message}`);
      return null;
    }
  };

  const ensureCampaign = async () => {
    if (campaign?.id) return campaign;
    try {
      const response = await fetch(apiPath('/api/campaigns'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          brief,
          channels,
          selectedCreatorIds: selectedKols,
          sentCreatorIds: sent,
          generated,
          currentStep,
          ...(discoveryJob?.id ? { discoveryJobId: discoveryJob.id } : {}),
          ...(enrichmentJob?.id ? { enrichmentJobId: enrichmentJob.id } : {}),
          ...(contentAnalysisJob?.id ? { contentAnalysisJobId: contentAnalysisJob.id } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || '项目创建失败');
      setCampaign(payload.campaign);
      void refreshArchive({ quiet: true });
      return payload.campaign;
    } catch (error) {
      notify(`无法建立本地项目档案：${error.message}`);
      return null;
    }
  };

  const applyOutreachDraftPayload = (payload = {}) => {
    const drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
    const readyCount = Number(payload.summary?.ready ?? drafts.filter((draft) => draft?.status === 'ready').length);
    const sentCreatorIds = drafts
      .filter((draft) => draft?.review?.status === 'sent')
      .map((draft) => draft.targetId)
      .filter(Boolean);
    setOutreachDrafts(drafts);
    setGenerated(readyCount > 0);
    setSent(sentCreatorIds);
    if (payload.campaign) setCampaign(payload.campaign);
    return drafts;
  };

  const refreshOutreachDrafts = async (campaignId, contentAnalysisJobId = '', { quiet = true } = {}) => {
    if (!campaignId) return [];
    setOutreachDraftsLoading(true);
    setOutreachDraftsError('');
    try {
      const search = contentAnalysisJobId ? `?contentAnalysisJobId=${encodeURIComponent(contentAnalysisJobId)}` : '';
      const response = await fetch(apiPath(`/api/campaigns/${encodeURIComponent(campaignId)}/outreach-drafts${search}`));
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || 'Failed to load outreach drafts.');
      return applyOutreachDraftPayload(payload);
    } catch (error) {
      const message = error.message || 'Failed to load outreach drafts.';
      setOutreachDraftsError(message);
      if (!quiet) notify(`建联草稿读取失败：${message}`);
      return [];
    } finally {
      setOutreachDraftsLoading(false);
    }
  };

  const hydrateCampaign = async (campaignId, { announce = true, quiet = false, detailSnapshot = null } = {}) => {
    restoringCampaign.current = true;
    try {
      const pinnedDiscoveryJobId = profileText(detailSnapshot?.discoveryJobId);
      const pinnedEnrichmentJobId = profileText(detailSnapshot?.enrichmentJobId);
      const pinnedContentJobId = profileText(detailSnapshot?.contentJobId);
      const pinnedAnalysisJobId = profileText(detailSnapshot?.analysisJobId);
      const detailCreatorId = profileText(detailSnapshot?.creatorId);
      const response = await fetch(apiPath(`/api/campaigns/${campaignId}`));
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || '项目档案读取失败');
      const nextCampaign = payload.campaign;
      const nextVerificationSummary = payload.currentVerificationJob || null;
      const nextEnrichmentSummaries = detailJobSummaries([
        ...(Array.isArray(payload.enrichmentJobs) ? payload.enrichmentJobs : []),
        payload.currentEnrichmentJob,
        payload.enrichmentJob,
        ...(pinnedEnrichmentJobId ? [{ id: pinnedEnrichmentJobId }] : []),
      ], detailCreatorId, pinnedEnrichmentJobId);
      const nextContentSummaries = detailJobSummaries([
        ...(Array.isArray(payload.contentJobs) ? payload.contentJobs : []),
        payload.currentContentJob,
        payload.contentJob,
        ...(pinnedContentJobId ? [{ id: pinnedContentJobId }] : []),
      ], detailCreatorId, pinnedContentJobId);
      const nextContentAnalysisSummaries = detailJobSummaries([
        ...(Array.isArray(payload.contentAnalysisJobs) ? payload.contentAnalysisJobs : []),
        ...(Array.isArray(payload.contentAnalysisJobIds) ? payload.contentAnalysisJobIds.map((id) => ({ id })) : []),
        ...(Array.isArray(nextCampaign.contentAnalysisJobIds) ? nextCampaign.contentAnalysisJobIds.map((id) => ({ id })) : []),
        payload.currentContentAnalysisJob,
        payload.contentAnalysisJob,
        ...(pinnedAnalysisJobId ? [{ id: pinnedAnalysisJobId }] : []),
      ], detailCreatorId, pinnedAnalysisJobId);
      const [nextDiscovery, nextVerification, ...relatedJobs] = await Promise.all([
        (pinnedDiscoveryJobId || payload.discoveryJob?.id)
          ? fetchJob(pinnedDiscoveryJobId || payload.discoveryJob.id)
          : Promise.resolve(null),
        nextVerificationSummary?.id ? fetchJob(nextVerificationSummary.id) : Promise.resolve(null),
        ...nextEnrichmentSummaries.map((job) => fetchJob(job.id).catch(() => null)),
        ...nextContentSummaries.map((job) => fetchJob(job.id).catch(() => null)),
        ...nextContentAnalysisSummaries.map((job) => fetchContentAnalysisJob(job.id).catch(() => null)),
      ]);
      const restoredEnrichmentJobs = relatedJobs.slice(0, nextEnrichmentSummaries.length).filter(Boolean);
      const restoredContentJobs = relatedJobs.slice(
        nextEnrichmentSummaries.length,
        nextEnrichmentSummaries.length + nextContentSummaries.length,
      ).filter(Boolean);
      const restoredContentAnalysisJobs = relatedJobs.slice(
        nextEnrichmentSummaries.length + nextContentSummaries.length,
      ).filter(Boolean);
      const nextEnrichment = restoredEnrichmentJobs.find((job) => job.id === pinnedEnrichmentJobId)
        || restoredEnrichmentJobs.at(-1) || null;
      const nextContent = restoredContentJobs.find((job) => job.id === pinnedContentJobId)
        || restoredContentJobs.at(-1) || null;
      const nextContentAnalysis = restoredContentAnalysisJobs.find((job) => job.id === pinnedAnalysisJobId)
        || restoredContentAnalysisJobs.find((job) => (
          job.id === payload.currentContentAnalysisJob?.id
        )) || [...restoredContentAnalysisJobs]
        .sort((left, right) => String(right.updatedAt || right.createdAt)
          .localeCompare(String(left.updatedAt || left.createdAt)))
        .at(0) || null;
      const restoredVerified = Object.fromEntries((nextVerification?.results || [])
        .filter((creator) => creator?.targetId && creator?.verification?.status === 'verified')
        .map((creator) => [creator.targetId, creator]));
      const restoredProfiles = profileMapFromJobs(restoredEnrichmentJobs);
      const restoredContent = contentMapFromJobs(restoredContentJobs);
      const restoredContentAnalyses = analysisMapFromJobs(restoredContentAnalysisJobs);
      const discoveryCreators = (nextDiscovery?.results || [])
        .filter((creator) => isCreatorProfileUrl(creator.channel, creator.sourceUrl));
      const usableCreators = creatorsFromContentJobs(discoveryCreators, restoredContentJobs, restoredContent);
      const savedSelection = Array.isArray(nextCampaign.selectedCreatorIds) ? nextCampaign.selectedCreatorIds : [];
      const contentSelection = Array.isArray(nextContent?.selectedCreatorIds) ? nextContent.selectedCreatorIds : [];
      const restoredSelected = (savedSelection.length ? savedSelection : contentSelection)
        .filter((id) => usableCreators.some((creator) => creator.id === id));
      const restoredProfileConfirmed = restoredSelected.filter((id) => hasConfirmedProfile(restoredProfiles[id]));
      const restoredOutreachReady = restoredSelected.length > 0 && (
        Object.keys(restoredVerified).length === restoredSelected.length
        || restoredProfileConfirmed.length === restoredSelected.length
      );
      const unlock = Math.max(
        1,
        nextDiscovery ? 3 : 1,
        restoredSelected.length ? 4 : 1,
        restoredOutreachReady ? 5 : 1,
        nextCampaign.generated && restoredOutreachReady ? 6 : 1,
      );
      setCampaign(nextCampaign);
      setBrief({ ...initialBrief, ...(nextCampaign.brief || {}) });
      setChannels((nextCampaign.channels || []).filter((channel) => SUPPORTED_CHANNEL_IDS.includes(channel)));
      setDiscoveryQuery(nextDiscovery?.query || '');
      setCreators(usableCreators);
      setCandidatePage({
        jobId: nextDiscovery?.id || '',
        loaded: usableCreators.length,
        total: Math.max(
          usableCreators.length,
          Number(nextDiscovery?.resultCount || nextDiscovery?.results?.length || 0),
        ),
        nextCursor: null,
        loading: false,
        error: '',
      });
      setSelectedKols(restoredSelected);
      setDiscoveryJob(nextDiscovery);
      setVerificationJob(nextVerification);
      setVerifiedByTargetId(restoredVerified);
      setEnrichmentJob(nextEnrichment);
      setEnrichmentJobs(restoredEnrichmentJobs);
      setEnrichedByTargetId(restoredProfiles);
      setEnrichmentError('');
      setContentJob(nextContent);
      setContentJobs(restoredContentJobs);
      setContentByTargetId(restoredContent);
      setContentError('');
      if (nextContent?.contentLimit) setContentSampleLimit(String(nextContent.contentLimit));
      setContentAnalysisJob(nextContentAnalysis);
      setContentAnalysisJobs(restoredContentAnalysisJobs);
      setContentAnalysisByTargetId(restoredContentAnalyses);
      setContentAnalysisError('');
      setContentAnalysisSourceJobId(nextContentAnalysis?.contentJobId || nextContent?.id || '');
      setAudienceByTargetId(audienceInsightsFromProfiles(restoredProfiles));
      setAudienceError('');
      setOutreachDrafts(Array.isArray(nextCampaign.outreachDrafts) ? nextCampaign.outreachDrafts : []);
      setOutreachDraftsError('');
      setGenerated(Boolean(nextCampaign.generated) && restoredOutreachReady);
      setSent(nextCampaign.sentCreatorIds || []);
      const outreachAnalysisJobId = nextCampaign.contentAnalysisJobId || nextContentAnalysis?.id || '';
      if (outreachAnalysisJobId) await refreshOutreachDrafts(nextCampaign.id, outreachAnalysisJobId, { quiet: true });
      setMaxUnlocked(unlock);
      setCurrentStep(Math.min(Math.max(1, nextCampaign.currentStep || 1), unlock));
      setActiveJob(isActiveJob(nextVerification) ? { kind: 'verify', job: nextVerification }
        : isActiveJob(nextDiscovery) ? { kind: 'discover', job: nextDiscovery } : null);
      if (announce) notify(`已恢复项目档案：${nextDiscovery?.metrics?.creators || 0} 位真实候选。`);
      return true;
    } catch (error) {
      if (!quiet) notify(`项目恢复失败：${error.message}`);
      return false;
    } finally {
      window.setTimeout(() => { restoringCampaign.current = false; }, 0);
    }
  };

  const restoreStandaloneCollection = async (jobId) => {
    restoringCampaign.current = true;
    try {
      const job = await fetchJob(jobId);
      const usableCreators = (job.results || []).filter((creator) => isCreatorProfileUrl(creator.channel, creator.sourceUrl));
      setCampaign(null);
      setChannels((job.channels || []).filter((channel) => SUPPORTED_CHANNEL_IDS.includes(channel)));
      setDiscoveryQuery(job.query || '');
      setCreators(usableCreators);
      setCandidatePage({
        jobId: job.id,
        loaded: usableCreators.length,
        total: Number(job.resultCount || job.results?.length || usableCreators.length),
        nextCursor: null,
        loading: false,
        error: '',
      });
      setSelectedKols([]);
      setDiscoveryJob(job);
      setVerificationJob(null);
      setVerifiedByTargetId({});
      setEnrichmentJob(null);
      setEnrichmentJobs([]);
      setEnrichedByTargetId({});
      setEnrichmentError('');
      setContentJob(null);
      setContentJobs([]);
      setContentByTargetId({});
      setContentError('');
      setContentAnalysisJob(null);
      setContentAnalysisJobs([]);
      setContentAnalysisByTargetId({});
      setContentAnalysisError('');
      setContentAnalysisSourceJobId('');
      setAudienceByTargetId({});
      setAudienceError('');
      clearOutreachDraftState();
      setCurrentStep(3);
      setMaxUnlocked(3);
      setActiveJob(isActiveJob(job) ? { kind: 'discover', job } : null);
      notify(`已载入历史采集：${job.metrics?.creators || 0} 位真实候选。`);
      return true;
    } catch (error) {
      notify(`历史采集恢复失败：${error.message}`);
      return false;
    } finally {
      window.setTimeout(() => { restoringCampaign.current = false; }, 0);
    }
  };

  const restoreStandaloneEnrichment = async (jobId) => {
    restoringCampaign.current = true;
    try {
      const job = await fetchJob(jobId);
      const sourceDiscovery = job.discoveryJobId ? await fetchJob(job.discoveryJobId) : null;
      const profiles = profileMapFromJob(job);
      const sourceCreators = (sourceDiscovery?.results || [])
        .filter((creator) => isCreatorProfileUrl(creator.channel, creator.sourceUrl));
      const fallbackCreators = (job.targets || job.results || [])
        .map((target) => {
          const targetId = target.targetId || target.id;
          const profile = profiles[targetId] || target;
          return {
            ...target,
            id: targetId,
            targetId,
            name: target.name || profile?.name || profile?.profile?.displayName || '未命名达人',
            handle: target.handle || profile?.handle || '',
            sourceUrl: target.sourceUrl || profile?.sourceUrl || '',
            niche: target.niche || profile?.content?.discoveryNiche || '',
            angle: target.angle || profile?.content?.discoveryAngle || '',
            followers: target.followers ?? profile?.profile?.followerCount ?? 0,
            followersLabel: target.followersLabel || profile?.profile?.followerLabel || '未提供',
            interactions: target.interactions ?? profile?.content?.engagement?.totals?.likes ?? null,
            sampleCount: target.sampleCount ?? profile?.content?.visibleSampleCount ?? 0,
            fit: target.fit ?? profile?.fit?.discoveryScore ?? 0,
            avatar: target.avatar || profile?.profile?.avatar || '',
          };
        })
        .filter((creator) => creator.id && isCreatorProfileUrl(creator.channel, creator.sourceUrl));
      const creatorsById = new Map(sourceCreators.map((creator) => [creator.id, creator]));
      fallbackCreators.forEach((creator) => {
        if (!creatorsById.has(creator.id)) creatorsById.set(creator.id, creator);
      });
      const restoredCreators = [...creatorsById.values()];
      const restoredSelected = [...new Set([
        ...(job.selectedCreatorIds || []),
        ...Object.keys(profiles),
      ])].filter((id) => creatorsById.has(id));
      const restoredProfileComplete = restoredSelected.length > 0
        && restoredSelected.every((id) => hasConfirmedProfile(profiles[id]));
      setCampaign(null);
      setChannels((job.channels || sourceDiscovery?.channels || []).filter((channel) => SUPPORTED_CHANNEL_IDS.includes(channel)));
      setDiscoveryQuery(job.query || sourceDiscovery?.query || '');
      setCreatorFilter('');
      setCreators(restoredCreators);
      setSelectedKols(restoredSelected);
      setDiscoveryJob(sourceDiscovery);
      setVerificationJob(null);
      setVerifiedByTargetId({});
      setEnrichmentJob(job);
      setEnrichmentJobs([job]);
      setEnrichedByTargetId(profiles);
      setEnrichmentError('');
      setContentJob(null);
      setContentJobs([]);
      setContentByTargetId({});
      setContentError('');
      setContentAnalysisJob(null);
      setContentAnalysisJobs([]);
      setContentAnalysisByTargetId({});
      setContentAnalysisError('');
      setContentAnalysisSourceJobId('');
      setAudienceByTargetId(audienceInsightsFromProfiles(profiles));
      setAudienceError('');
      clearOutreachDraftState();
      setCurrentStep(3);
      setMaxUnlocked(restoredProfileComplete ? 5 : restoredSelected.length ? 4 : 3);
      setActiveJob(null);
      notify(`已载入历史达人画像：${Object.keys(profiles).length} 份。`);
      return true;
    } catch (error) {
      notify(`历史达人画像恢复失败：${error.message}`);
      return false;
    } finally {
      window.setTimeout(() => { restoringCampaign.current = false; }, 0);
    }
  };

  const restoreStandaloneContent = async (jobId) => {
    restoringCampaign.current = true;
    try {
      const job = await fetchJob(jobId);
      const sourceDiscovery = job.discoveryJobId ? await fetchJob(job.discoveryJobId).catch(() => null) : null;
      const captures = contentMapFromJob(job);
      const sourceCreators = (sourceDiscovery?.results || [])
        .filter((creator) => isCreatorProfileUrl(creator.channel, creator.sourceUrl));
      const restoredCreators = creatorsFromContentJobs(sourceCreators, [job], captures);
      const restoredCreatorIds = new Set(restoredCreators.map((creator) => creator.id));
      const restoredSelected = [...new Set([
        ...(job.selectedCreatorIds || []),
        ...Object.keys(captures),
      ])].filter((id) => restoredCreatorIds.has(id));
      setCampaign(null);
      setChannels((job.channels || sourceDiscovery?.channels || []).filter((channel) => SUPPORTED_CHANNEL_IDS.includes(channel)));
      setDiscoveryQuery(job.query || sourceDiscovery?.query || '');
      setCreatorFilter('');
      setCreators(restoredCreators);
      setCandidatePage({
        jobId: sourceDiscovery?.id || '',
        loaded: restoredCreators.length,
        total: Math.max(restoredCreators.length, Number(sourceDiscovery?.resultCount || 0)),
        nextCursor: null,
        loading: false,
        error: '',
      });
      setSelectedKols(restoredSelected);
      setDiscoveryJob(sourceDiscovery);
      setVerificationJob(null);
      setVerifiedByTargetId({});
      setEnrichmentJob(null);
      setEnrichmentJobs([]);
      setEnrichedByTargetId({});
      setEnrichmentError('');
      setContentJob(job);
      setContentJobs([job]);
      setContentByTargetId(captures);
      setContentError('');
      if (job.contentLimit) setContentSampleLimit(String(job.contentLimit));
      setContentAnalysisJob(null);
      setContentAnalysisJobs([]);
      setContentAnalysisByTargetId({});
      setContentAnalysisError('');
      setContentAnalysisSourceJobId(job.id);
      setAudienceByTargetId({});
      setAudienceError('');
      clearOutreachDraftState();
      setCurrentStep(3);
      setMaxUnlocked(restoredSelected.length ? 4 : 3);
      setActiveJob(null);
      notify(`已载入历史公开内容：${job.metrics?.visibleContentSamples ?? Object.values(captures).reduce((total, capture) => total + publicContentSamples(capture.content?.visibleSamples).length, 0)} 条样本。`);
      return true;
    } catch (error) {
      notify(`历史公开内容恢复失败：${error.message}`);
      return false;
    } finally {
      window.setTimeout(() => { restoringCampaign.current = false; }, 0);
    }
  };

  const restoreStandaloneContentAnalysis = async (jobId) => {
    restoringCampaign.current = true;
    try {
      const job = await fetchContentAnalysisJob(jobId);
      const analyses = analysisMapFromJob(job);
      if (job.contentJobId) {
        const restored = await restoreStandaloneContent(job.contentJobId);
        if (!restored) return false;
        restoringCampaign.current = true;
      } else {
        const fallbackCreators = Object.values(analyses).map((record) => ({
          id: record.targetId,
          targetId: record.targetId,
          channel: record.channel || job.channels?.[0] || '',
          platform: record.platform || record.channel || job.channels?.[0] || '',
          name: record.name || '未命名达人',
          handle: record.handle || '',
          sourceUrl: record.sourceUrl || '',
          niche: record.niche || '',
          angle: record.angle || '',
          sampleCount: record.analysis?.coverage?.visibleSampleCount || 0,
          followers: 0,
          interactions: null,
          fit: 0,
          priceLabel: '未提供',
        })).filter((creator) => creator.id && isCreatorProfileUrl(creator.channel, creator.sourceUrl));
        setCampaign(null);
        setChannels((job.channels || []).filter((channel) => SUPPORTED_CHANNEL_IDS.includes(channel)));
        setDiscoveryQuery(job.query || '');
        setCreatorFilter('');
        setCreators(fallbackCreators);
        setSelectedKols(fallbackCreators.map((creator) => creator.id));
        setDiscoveryJob(null);
        setVerificationJob(null);
        setVerifiedByTargetId({});
        setEnrichmentJob(null);
        setEnrichmentJobs([]);
        setEnrichedByTargetId({});
        setEnrichmentError('');
        setContentJob(null);
        setContentJobs([]);
        setContentByTargetId({});
        setContentError('');
        setAudienceByTargetId({});
        setAudienceError('');
        clearOutreachDraftState();
        setMaxUnlocked(fallbackCreators.length ? 4 : 3);
      }
      setContentAnalysisJob(job);
      setContentAnalysisJobs([job]);
      setContentAnalysisByTargetId(analyses);
      setContentAnalysisError('');
      setContentAnalysisSourceJobId(job.contentJobId || '');
      setCurrentStep(3);
      setActiveJob(null);
      notify(`已载入历史内容理解：${Object.keys(analyses).length} 位达人、${Object.values(analyses).reduce((total, record) => total + analysisFindingCount(record), 0)} 条判断。`);
      return true;
    } catch (error) {
      notify(`历史内容理解恢复失败：${error.message}`);
      return false;
    } finally {
      window.setTimeout(() => { restoringCampaign.current = false; }, 0);
    }
  };

  const hydrateDetailRoute = async (route) => {
    if (route.campaignId) {
      return hydrateCampaign(route.campaignId, {
        announce: false,
        quiet: true,
        detailSnapshot: route,
      });
    }

    // Historic runs can exist without a campaign archive. Restore the closest
    // usable task first, then pin every supplied task source onto the page.
    if (!route.analysisJobId && !route.contentJobId && !route.enrichmentJobId && !route.discoveryJobId) return false;
    let restored = false;
    if (route.analysisJobId) restored = await restoreStandaloneContentAnalysis(route.analysisJobId);
    else if (route.contentJobId) restored = await restoreStandaloneContent(route.contentJobId);
    else if (route.enrichmentJobId) restored = await restoreStandaloneEnrichment(route.enrichmentJobId);
    else if (route.discoveryJobId) restored = await restoreStandaloneCollection(route.discoveryJobId);
    if (!restored) return false;

    const [pinnedEnrichment, pinnedContent, pinnedAnalysis] = await Promise.all([
      route.enrichmentJobId ? fetchJob(route.enrichmentJobId).catch(() => null) : Promise.resolve(null),
      route.contentJobId ? fetchJob(route.contentJobId).catch(() => null) : Promise.resolve(null),
      route.analysisJobId ? fetchContentAnalysisJob(route.analysisJobId).catch(() => null) : Promise.resolve(null),
    ]);
    if (pinnedEnrichment) {
      const profiles = profileMapFromJob(pinnedEnrichment);
      setEnrichmentJob(pinnedEnrichment);
      setEnrichmentJobs([pinnedEnrichment]);
      setEnrichedByTargetId(profiles);
      setAudienceByTargetId(audienceInsightsFromProfiles(profiles));
    }
    if (pinnedContent) {
      setContentJob(pinnedContent);
      setContentJobs([pinnedContent]);
      setContentByTargetId(contentMapFromJob(pinnedContent));
    }
    if (pinnedAnalysis) {
      setContentAnalysisJob(pinnedAnalysis);
      setContentAnalysisJobs([pinnedAnalysis]);
      setContentAnalysisByTargetId(analysisMapFromJob(pinnedAnalysis));
      setContentAnalysisSourceJobId(pinnedAnalysis.contentJobId || route.contentJobId || '');
    }
    return true;
  };

  const resumeCollection = async (job) => {
    try {
      const response = await fetch(apiPath(`/api/jobs/${job.id}/resume`), { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || '任务无法续跑');
      completedJobs.current.delete(job.id);
      if (job.type === 'content_analysis') applyContentAnalysisJob(payload.job);
      else if (job.type === 'content') applyContentJob(payload.job);
      else if (['enrich', 'enrichment', 'profile'].includes(job.type)) applyEnrichmentJob(payload.job);
      else applyJob(job.type, payload.job);
      notify('任务已续跑；已完成的渠道快照会被保留。');
      void refreshArchive({ quiet: true });
    } catch (error) {
      notify(`任务续跑失败：${error.message}`);
    }
  };

  useEffect(() => {
    try {
      if (campaign?.id) window.localStorage.setItem('kolforge.activeCampaignId', campaign.id);
      else window.localStorage.removeItem('kolforge.activeCampaignId');
    } catch {
      // Local storage is an optional convenience; the server archive remains the source of truth.
    }
  }, [campaign?.id]);

  useEffect(() => {
    void refreshConnectors();
    void (async () => {
      const initialRoute = detailRouteFromLocation();
      if (initialRoute.view !== 'workspace') {
        const restored = await hydrateDetailRoute(initialRoute);
        if (!restored) setDetailRouteError('活动或关联任务快照不存在，无法打开该独立页面。');
        setDetailRouteLoading(false);
        return;
      }
      const archived = await refreshArchive({ quiet: true });
      let activeCampaignId = '';
      try { activeCampaignId = window.localStorage.getItem('kolforge.activeCampaignId') || ''; } catch { /* no local storage */ }
      const campaignIds = [activeCampaignId, ...archived.campaigns.map((entry) => entry.campaign?.id)]
        .filter(Boolean)
        .filter((id, index, values) => values.indexOf(id) === index);
      let restored = false;
      for (const campaignId of campaignIds) {
        if (await hydrateCampaign(campaignId, { announce: false, quiet: true })) {
          restored = true;
          break;
        }
      }
      if (!restored) {
        const latestDiscovery = archived.jobs.find((job) => job.type === 'discover');
        if (latestDiscovery) await restoreStandaloneCollection(latestDiscovery.id);
        else {
          const latestContentAnalysis = archived.jobs.find((job) => job.type === 'content_analysis');
          const latestContent = archived.jobs.find((job) => job.type === 'content');
          if (latestContentAnalysis) await restoreStandaloneContentAnalysis(latestContentAnalysis.id);
          else if (latestContent) await restoreStandaloneContent(latestContent.id);
        }
      }
      setDetailRouteLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (detailRoute.key === initialDetailRouteKey.current) return;
    if (detailRoute.view === 'workspace') {
      setDetailRouteError('');
      setDetailRouteLoading(false);
      return;
    }
    let cancelled = false;
    setDetailRouteError('');
    setDetailRouteLoading(true);
    void (async () => {
      const restored = await hydrateDetailRoute(detailRoute);
      if (cancelled) return;
      if (!restored) setDetailRouteError('活动或关联任务快照不存在，无法打开该独立页面。');
      setDetailRouteLoading(false);
    })();
    return () => { cancelled = true; };
  }, [detailRoute.key]);

  useEffect(() => {
    if (detailRoute.view !== 'workspace' || !campaign?.id || restoringCampaign.current) return undefined;
    const timer = window.setTimeout(() => {
      void saveCampaign(campaign.id, {
        brief,
        channels,
        selectedCreatorIds: selectedKols,
        sentCreatorIds: sent,
        generated,
        currentStep,
        enrichmentJobId: enrichmentJob?.id || null,
        contentAnalysisJobId: contentAnalysisJob?.id || null,
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [detailRoute.view, campaign?.id, brief, channels, selectedKols, sent, generated, currentStep, enrichmentJob?.id, contentAnalysisJob?.id]);

  useEffect(() => {
    setVerifiedByTargetId({});
  }, [discoveryJob?.id, verificationJob?.id]);

  useEffect(() => {
    if (!verificationJob || !terminalStatuses.has(verificationJob.status)) return;
    const verified = Object.fromEntries((verificationJob.results || [])
      .filter((creator) => creator?.targetId && creator?.verification?.status === 'verified')
      .map((creator) => [creator.targetId, creator]));
    setVerifiedByTargetId(verified);
  }, [verificationJob?.id, verificationJob?.status, verificationJob?.finishedAt]);

  const applyJob = (kind, job) => {
    if (kind === 'discover') setDiscoveryJob(job);
    else setVerificationJob(job);
    setActiveJob({ kind, job });

    if (!terminalStatuses.has(job.status) || completedJobs.current.has(job.id)) return;
    completedJobs.current.add(job.id);
    if (kind === 'discover') {
      const usableCreators = (job.results || []).filter((creator) => isCreatorProfileUrl(creator.channel, creator.sourceUrl));
      if (Array.isArray(job.results)) {
        setCreators(usableCreators);
        setCandidatePage({
          jobId: job.id,
          loaded: usableCreators.length,
          total: Number(job.resultCount || job.results.length),
          nextCursor: null,
          loading: false,
          error: '',
        });
      } else {
        setCreators([]);
        void loadDiscoveryCandidatePage(job.id, { reset: true });
      }
      setSelectedKols([]);
      if (job.status === 'succeeded' || job.status === 'partial_success') {
        notify(`真实采集完成：${job.metrics?.sourceRecords || 0} 条源记录，${job.metrics?.creators || 0} 位候选。`);
      } else if (job.status === 'interrupted') {
        notify('部分公开检索路线可续跑，已保留当前候选与路线状态。');
      } else if (job.status === 'waiting_for_connection') {
        notify('连接器等待浏览器会话或合作方配置，请查看任务提示。');
      } else {
        notify('采集未完成，请查看执行日志。');
      }
    } else if (job.status === 'succeeded' || job.status === 'partial_success') {
      notify(`已完成 ${job.metrics?.sourceRecords || 0} 条目标账号核验源记录。`);
    } else {
      notify('目标账号核验未完成，请查看连接器提示。');
    }
    void refreshConnectors();
  };

  const applyEnrichmentJob = (job) => {
    setEnrichmentJob(job);
    setEnrichmentJobs((current) => uniqueJobs([
      ...current.filter((candidate) => candidate.id !== job.id),
      job,
    ]));
    const profiles = profileMapFromJob(job);
    if (Object.keys(profiles).length) {
      setEnrichedByTargetId((current) => ({ ...current, ...profiles }));
      const embeddedInsights = audienceInsightsFromProfiles(profiles);
      if (Object.keys(embeddedInsights).length) {
        setAudienceByTargetId((current) => ({ ...current, ...embeddedInsights }));
      }
    }
    if (!terminalStatuses.has(job.status) || completedJobs.current.has(job.id)) return;
    completedJobs.current.add(job.id);
    if (job.status === 'succeeded' || job.status === 'partial_success') {
      notify(`达人数据采集完成：已回填 ${Object.keys(profiles).length || job.metrics?.creators || 0} 份画像。`);
    } else {
      notify('达人数据采集未完成，请查看画像任务状态。');
    }
  };

  const applyContentJob = (job) => {
    setContentJob((current) => mergeContentJobSnapshot(current, job));
    setContentJobs((current) => {
      const existing = current.find((candidate) => candidate.id === job.id);
      const merged = mergeContentJobSnapshot(existing, job);
      return uniqueJobs([
        ...current.filter((candidate) => candidate.id !== job.id),
        merged,
      ]);
    });
    const captures = contentMapFromJob(job);
    if (Object.keys(captures).length) {
      setContentByTargetId((current) => mergeContentCaptureMaps(current, captures));
    }
    if (!terminalStatuses.has(job.status) || completedJobs.current.has(job.id)) return;
    completedJobs.current.add(job.id);
    if (job.status === 'succeeded' || job.status === 'partial_success') {
      notify(`公开内容采集完成：已回填 ${Object.keys(captures).length || job.metrics?.contentCaptures || 0} 位达人、${job.metrics?.visibleContentSamples || 0} 条样本。`);
    } else {
      notify('公开内容采集未完成，请查看内容任务状态。');
    }
  };

  const applyContentAnalysisJob = (job) => {
    setContentAnalysisJob(job);
    setContentAnalysisJobs((current) => uniqueJobs([
      ...current.filter((candidate) => candidate.id !== job.id),
      job,
    ]));
    if (job.contentJobId) setContentAnalysisSourceJobId(job.contentJobId);
    const analyses = analysisMapFromJob(job);
    if (Object.keys(analyses).length) {
      setContentAnalysisByTargetId((current) => ({ ...current, ...analyses }));
    }
    if (!terminalStatuses.has(job.status) || completedJobs.current.has(job.id)) return;
    completedJobs.current.add(job.id);
    if (job.status === 'succeeded' || job.status === 'partial_success') {
      const findingCount = Object.values(analyses).reduce((total, record) => total + analysisFindingCount(record), 0);
      notify(`内容理解完成：已回填 ${Object.keys(analyses).length || job.metrics?.analyzedCreators || 0} 位达人、${findingCount || job.metrics?.findings || 0} 条可追溯判断。`);
    } else if (job.status === 'completed_empty') {
      notify('内容理解任务未返回可分析的公开内容样本。');
    } else {
      notify('内容理解未完成，请查看矩阵任务状态。');
    }
  };

  useEffect(() => {
    if (!activeJob?.job?.id) return undefined;
    let disposed = false;
    const poll = async () => {
      try {
        const job = await fetchJob(activeJob.job.id, { summary: activeJob.kind === 'discover' });
        if (!disposed) applyJob(activeJob.kind, job);
      } catch (error) {
        if (!disposed) notify(`任务状态读取失败：${error.message}`);
      }
    };
    void poll();
    if (!terminalStatuses.has(activeJob.job.status)) {
      const timer = window.setInterval(poll, 1200);
      return () => { disposed = true; window.clearInterval(timer); };
    }
    return () => { disposed = true; };
  }, [activeJob?.job?.id, activeJob?.job?.status, activeJob?.kind]);

  useEffect(() => {
    if (!enrichmentJob?.id) return undefined;
    let disposed = false;
    const poll = async () => {
      try {
        const job = await fetchJob(enrichmentJob.id);
        if (!disposed) applyEnrichmentJob(job);
      } catch (error) {
        if (!disposed) setEnrichmentError(error.message || '画像任务状态读取失败');
      }
    };
    void poll();
    if (!terminalStatuses.has(enrichmentJob.status)) {
      const timer = window.setInterval(poll, 1200);
      return () => { disposed = true; window.clearInterval(timer); };
    }
    return () => { disposed = true; };
  }, [enrichmentJob?.id, enrichmentJob?.status]);

  useEffect(() => {
    if (!contentJob?.id) return undefined;
    let disposed = false;
    const poll = async () => {
      try {
        const job = await fetchJob(contentJob.id, { summary: true });
        if (!disposed) applyContentJob(job);
      } catch (error) {
        if (!disposed) setContentError(error.message || '公开内容任务状态读取失败');
      }
    };
    void poll();
    // A waiting job can be resumed by another tab, the archive action, or the
    // service after a connector reconnect. Keep polling these two resumable
    // states so the workspace does not remain stuck on a stale "等待连接".
    const contentMayResume = ['waiting_for_connection', 'waiting_for_configuration'].includes(contentJob.status);
    if (!terminalStatuses.has(contentJob.status) || contentMayResume) {
      const timer = window.setInterval(poll, 1200);
      return () => { disposed = true; window.clearInterval(timer); };
    }
    return () => { disposed = true; };
  }, [contentJob?.id, contentJob?.status]);

  useEffect(() => {
    if (!contentAnalysisJob?.id) return undefined;
    let disposed = false;
    const poll = async () => {
      try {
        const job = await fetchContentAnalysisJob(contentAnalysisJob.id);
        if (!disposed) {
          setContentAnalysisError('');
          applyContentAnalysisJob(job);
        }
      } catch (error) {
        if (!disposed) setContentAnalysisError(error.message || '内容理解任务状态读取失败');
      }
    };
    void poll();
    if (!terminalStatuses.has(contentAnalysisJob.status)) {
      const timer = window.setInterval(poll, 1200);
      return () => { disposed = true; window.clearInterval(timer); };
    }
    return () => { disposed = true; };
  }, [contentAnalysisJob?.id, contentAnalysisJob?.status]);

  useEffect(() => {
    const jobId = discoveryJob?.id;
    if (!jobId) {
      setAudienceByTargetId({});
      setAudienceError('');
      setAudienceLoading(false);
      return undefined;
    }
    let disposed = false;
    const load = async () => {
      setAudienceLoading(true);
      try {
        const response = await fetch(apiPath(`/api/audience-insights?discoveryJobId=${encodeURIComponent(jobId)}`));
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error?.message || '粉丝画像读取失败');
        const insights = audienceInsightMap(payload.audienceInsights || payload.data?.audienceInsights || []);
        if (!disposed) {
          setAudienceByTargetId((current) => ({ ...current, ...insights }));
          setAudienceError('');
        }
      } catch (error) {
        if (!disposed) setAudienceError(error.message || '粉丝画像读取失败');
      } finally {
        if (!disposed) setAudienceLoading(false);
      }
    };
    void load();
    return () => { disposed = true; };
  }, [discoveryJob?.id]);

  const startCollection = async (kind, payload) => {
    try {
      const response = await fetch(apiPath('/api/collect'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || '无法创建采集任务');
      return result.job;
    } catch (error) {
      notify(`未能启动真实采集：${error.message}`);
      return null;
    }
  };

  const runDiscovery = async () => {
    const owner = await ensureCampaign();
    if (!owner) return;
    const querySeeds = [discoveryQuery.trim(), brief.product]
      .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const query = discoveryQuery.trim() || querySeeds.find(Boolean) || '';
    const discoveryContext = {
      product: brief.product,
      objective: brief.objective,
      audience: brief.audience,
      market: brief.market,
    };
    const limit = candidateLimit === 'full' ? undefined : Number(candidateLimit);
    const saved = await saveCampaign(owner.id, {
      brief,
      channels,
      selectedCreatorIds: [],
      sentCreatorIds: [],
      generated: false,
      currentStep: 3,
      enrichmentJobId: null,
      contentAnalysisJobId: null,
    }, { quiet: false });
    if (!saved) return;
    const job = await startCollection('discover', {
      type: 'discover', channels, query, querySeeds, discoveryContext, campaignId: owner.id, ...(limit ? { limit } : {}),
    });
    if (!job) return;
    completedJobs.current.delete(job.id);
    setDiscoveryQuery(query);
    setCreators([]);
    setCandidatePage({ jobId: job.id, loaded: 0, total: 0, nextCursor: null, loading: false, error: '' });
    setSelectedKols([]);
    setVerifiedByTargetId({});
    setEnrichmentJob(null);
    setEnrichmentJobs([]);
    setEnrichedByTargetId({});
    setEnrichmentError('');
    setContentJob(null);
    setContentJobs([]);
    setContentByTargetId({});
    setContentError('');
    setContentAnalysisJob(null);
    setContentAnalysisJobs([]);
    setContentAnalysisByTargetId({});
    setContentAnalysisError('');
    setContentAnalysisSourceJobId('');
    setAudienceByTargetId({});
    setAudienceError('');
    clearOutreachDraftState();
    setVerificationJob(null);
    setMaxUnlocked((value) => Math.min(value, 3));
    applyJob('discover', job);
    void refreshArchive({ quiet: true });
  };

  const runVerification = async () => {
    if (!activeSelectedKols.length) return;
    if (!discoveryJob?.id) {
      notify('请先恢复或完成一条真实候选采集任务，再核验账号。');
      return;
    }
    const targets = activeSelectedKols
      .filter((creator) => isCreatorProfileUrl(creator.channel, creator.sourceUrl))
      .map((creator) => ({ targetId: creator.id, channel: creator.channel, name: creator.name, sourceUrl: creator.sourceUrl }));
    if (!targets.length) {
      notify('所选候选没有可核验的平台资料链接。');
      return;
    }
    if (targets.length !== activeSelectedKols.length) {
      notify('已移除无效来源链接的候选，请重新选择后核验。');
      setSelectedKols(targets.map((target) => target.targetId));
      return;
    }
    const owner = await ensureCampaign();
    if (!owner) return;
    const saved = await saveCampaign(owner.id, {
      brief,
      channels,
      selectedCreatorIds: targets.map((target) => target.targetId),
      sentCreatorIds: [],
      generated: false,
      currentStep: 4,
    }, { quiet: false });
    if (!saved) return;
    const job = await startCollection('verify', {
      type: 'verify',
      channels: [...new Set(activeSelectedKols.map((creator) => creator.channel))],
      query: discoveryQuery || brief.product,
      limit: targets.length,
      targets,
      campaignId: owner.id,
      discoveryJobId: discoveryJob.id,
    });
    if (!job) return;
    completedJobs.current.delete(job.id);
    clearOutreachDraftState();
    applyJob('verify', job);
    void refreshArchive({ quiet: true });
  };

  const runEnrichment = async (creatorIds) => {
    if (!discoveryJob?.id) {
      notify('请先恢复或完成一条真实候选采集任务，再采集达人数据。');
      return;
    }
    const targets = [...new Set(creatorIds || [])]
      .map((id) => creators.find((creator) => creator.id === id))
      .filter((creator) => creator && isCreatorProfileUrl(creator.channel, creator.sourceUrl))
      .map((creator) => ({
        targetId: creator.id,
        creatorId: creator.id,
        channel: creator.channel,
        name: creator.name,
        sourceUrl: creator.sourceUrl,
      }));
    if (!targets.length) {
      notify('请选择至少一位带真实平台主页链接的候选。');
      return;
    }
    const owner = await ensureCampaign();
    if (!owner) return;
    setEnrichmentError('');
    try {
      const response = await fetch(apiPath('/api/enrich'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          discoveryJobId: discoveryJob.id,
          campaignId: owner.id,
          creatorIds: targets.map((target) => target.targetId),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || `画像任务创建失败（${response.status}）`);
      let job = payload.job || payload.enrichmentJob || payload.data?.job || null;
      const jobId = job?.id || payload.jobId || payload.enrichmentJobId || payload.data?.jobId;
      if (!job && jobId) job = await fetchJob(jobId);
      if (!job?.id) throw new Error('画像任务未返回可追踪的任务编号');
      completedJobs.current.delete(job.id);
      applyEnrichmentJob(job);
      void saveCampaign(owner.id, { enrichmentJobId: job.id });
      notify(`已开始采集 ${targets.length} 位达人的主页数据与内容画像。`);
      void refreshArchive({ quiet: true });
    } catch (error) {
      const message = error.message || '画像服务暂未返回任务';
      setEnrichmentError(message);
      notify(`达人数据采集暂未启动：${message}`);
    }
  };

  const runContentCollection = async (creatorIds = [], options = {}) => {
    const allDiscoveredCandidates = Boolean(options?.allDiscoveredCandidates);
    if (!discoveryJob?.id) {
      notify('请先恢复或完成一条真实候选采集任务，再采集公开内容。');
      return;
    }
    const targets = [...new Set(creatorIds || [])]
      .map((id) => creators.find((creator) => creator.id === id))
      .filter((creator) => creator && isCreatorProfileUrl(creator.channel, creator.sourceUrl))
      .map((creator) => ({
        targetId: creator.id,
        creatorId: creator.id,
        channel: creator.channel,
        name: creator.name,
        sourceUrl: creator.sourceUrl,
      }));
    if (!allDiscoveredCandidates && !targets.length) {
      notify('请选择至少一位带真实平台主页链接的候选。');
      return;
    }
    const owner = await ensureCampaign();
    if (!owner) return;
    clearOutreachDraftState();
    setContentError('');
    try {
      const response = await fetch(apiPath('/api/content-collect'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          discoveryJobId: discoveryJob.id,
          campaignId: owner.id,
          ...(allDiscoveredCandidates
            ? { allDiscoveredCandidates: true }
            : { creatorIds: targets.map((target) => target.targetId) }),
          contentLimit: Number(contentSampleLimit),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || `公开内容任务创建失败（${response.status}）`);
      let job = payload.job || payload.contentJob || payload.data?.job || null;
      const jobId = job?.id || payload.jobId || payload.contentJobId || payload.data?.jobId;
      if (!job && jobId) job = await fetchJob(jobId);
      if (!job?.id) throw new Error('公开内容任务未返回可追踪的任务编号');
      completedJobs.current.delete(job.id);
      applyContentJob(job);
      const targetScope = allDiscoveredCandidates ? '当前发现任务的全部候选' : `${targets.length} 位达人`;
      const completeVisibleMode = Number(contentSampleLimit) >= 10_000;
      notify(completeVisibleMode
        ? `已开始采集 ${targetScope} 的尽可能完整公开内容；将持续翻页至页面明确到底，单人安全上限 10,000 条。`
        : `已开始采集 ${targetScope} 的公开内容；每位最多保存 ${contentSampleLimit} 条当前可见样本。`);
      void refreshArchive({ quiet: true });
    } catch (error) {
      const message = error.message || '公开内容服务暂未返回任务';
      setContentError(message);
      notify(`公开内容采集暂未启动：${message}`);
    }
  };

  const runContentAnalysis = async (sourceJobId, creatorIds = [], options = {}) => {
    const allCapturedCreators = Boolean(options?.allCapturedCreators);
    const contentJobId = sourceJobId || contentJob?.id;
    const targetIds = [...new Set(creatorIds || [])].filter(Boolean);
    if (!contentJobId) {
      notify('请先选择一条已完成的公开内容采集任务。');
      return;
    }
    if (!allCapturedCreators && !targetIds.length) {
      notify('所选达人在该内容任务中尚无可分析的公开内容样本。');
      return;
    }
    const sourceContentJob = contentJobs.find((candidate) => candidate.id === contentJobId)
      || (contentJob?.id === contentJobId ? contentJob : null);
    if (isActiveJob(sourceContentJob)) {
      setContentAnalysisError('');
      notify(`内容批次 ${contentJobId.slice(0, 8)} 仍在采集；已保存的数据可以查看，采集完成后再启动内容理解。`);
      return;
    }
    const owner = await ensureCampaign();
    if (!owner) return;
    clearOutreachDraftState();
    setContentAnalysisError('');
    try {
      const response = await fetch(apiPath('/api/content-analysis'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          campaignId: owner.id,
          contentJobId,
          ...(allCapturedCreators
            ? { allCapturedCreators: true }
            : { creatorIds: targetIds }),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || `内容理解任务创建失败（${response.status}）`);
      let job = payload.job || payload.contentAnalysisJob || payload.data?.job || null;
      const jobId = job?.id || payload.jobId || payload.contentAnalysisJobId || payload.data?.jobId;
      if (!job && jobId) job = await fetchContentAnalysisJob(jobId);
      if (!job?.id) throw new Error('内容理解任务未返回可追踪的任务编号');
      if (jobId || job.id) job = await fetchContentAnalysisJob(job.id).catch(() => job);
      if (!allCapturedCreators) {
        setContentAnalysisByTargetId((current) => {
          const next = { ...current };
          targetIds.forEach((targetId) => { delete next[targetId]; });
          return next;
        });
      }
      completedJobs.current.delete(job.id);
      applyContentAnalysisJob(job);
      void saveCampaign(owner.id, { contentAnalysisJobId: job.id });
      const targetScope = allCapturedCreators ? '该内容批次全部已采集达人' : `${targetIds.length} 位达人`;
      notify(`已开始理解 ${targetScope} 的已采集内容；逐条结论会附带可追溯证据与覆盖度。`);
      void refreshArchive({ quiet: true });
    } catch (error) {
      const message = error.message || '内容理解服务暂未返回任务';
      setContentAnalysisError(message);
      notify(`内容理解暂未启动：${message}`);
    }
  };

  const resetDownstream = () => {
    clearOutreachDraftState();
    setVerificationJob(null);
    setVerifiedByTargetId({});
    setMaxUnlocked((value) => Math.min(value, 3));
  };

  const updateChannels = (nextChannels) => {
    const allowedChannels = nextChannels.filter((id) => SUPPORTED_CHANNEL_IDS.includes(id));
    setChannels(allowedChannels);
    setCreators([]);
    setSelectedKols([]);
    setDiscoveryJob(null);
    setEnrichmentJob(null);
    setEnrichmentJobs([]);
    setEnrichedByTargetId({});
    setEnrichmentError('');
    setContentJob(null);
    setContentJobs([]);
    setContentByTargetId({});
    setContentError('');
    setContentAnalysisJob(null);
    setContentAnalysisJobs([]);
    setContentAnalysisByTargetId({});
    setContentAnalysisError('');
    setContentAnalysisSourceJobId('');
    setAudienceByTargetId({});
    setAudienceError('');
    resetDownstream();
    setMaxUnlocked((value) => Math.min(value, 2));
  };

  const updateSelectedKols = (updater) => {
    setSelectedKols((items) => (typeof updater === 'function' ? updater(items) : updater));
    resetDownstream();
  };

  const goNext = () => {
    const next = Math.min(6, currentStep + 1);
    setMaxUnlocked((value) => Math.max(value, next));
    setCurrentStep(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const goToStep = (id) => {
    if (id <= maxUnlocked) {
      setCurrentStep(id);
      setMobileNav(false);
    }
  };

  const generateMessages = async ({ regenerate = false } = {}) => {
    if (!outreachReady) {
      notify('请先完成全部已选账号的独立核验或主页画像确认。');
      return;
    }
    if (!contentOutreachReady) {
      const names = outreachContentMissing.slice(0, 3).map((creator) => creator.name).join('、');
      const suffix = outreachContentMissing.length > 3 ? ` 等 ${outreachContentMissing.length} 位` : '';
      notify(`已阻止生成：${names}${suffix} 缺少可引用的内容采集与分析锚点。`);
      return;
    }
    const owner = await ensureCampaign();
    if (!owner?.id) return;
    setOutreachDraftsLoading(true);
    setOutreachDraftsError('');
    try {
      const response = await fetch(apiPath(`/api/campaigns/${encodeURIComponent(owner.id)}/outreach-drafts`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contentAnalysisJobId: contentAnalysisJob?.id || owner.contentAnalysisJobId || undefined,
          regenerate,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || 'Failed to generate outreach drafts.');
      const drafts = applyOutreachDraftPayload(payload);
      const summary = payload.summary || {};
      if (drafts.some((draft) => draft.status === 'ready')) setMaxUnlocked((value) => Math.max(value, 6));
      const unavailable = Number(summary.blocked || 0) + Number(summary.stale || 0);
      notify(unavailable
        ? `已生成 ${summary.ready || 0} 位可用草稿；${unavailable} 位因内容证据状态暂不可发送。`
        : `已生成 ${summary.ready || drafts.length} 位内容证据锁定的建联草稿。`);
      void refreshArchive({ quiet: true });
    } catch (error) {
      const message = error.message || 'Failed to generate outreach drafts.';
      setOutreachDraftsError(message);
      notify(`建联草稿生成失败：${message}`);
    } finally {
      setOutreachDraftsLoading(false);
    }
  };

  const updateOutreachDraft = async (targetId, patch) => {
    const owner = campaign?.id ? campaign : await ensureCampaign();
    if (!owner?.id || !targetId) return false;
    setOutreachDraftsLoading(true);
    setOutreachDraftsError('');
    try {
      const response = await fetch(apiPath(`/api/campaigns/${encodeURIComponent(owner.id)}/outreach-drafts/${encodeURIComponent(targetId)}`), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || 'Failed to update outreach draft.');
      applyOutreachDraftPayload(payload);
      void refreshArchive({ quiet: true });
      return true;
    } catch (error) {
      const message = error.message || 'Failed to update outreach draft.';
      setOutreachDraftsError(message);
      notify(`建联草稿未保存：${message}`);
      return false;
    } finally {
      setOutreachDraftsLoading(false);
    }
  };

  const reportJob = discoveryJob;
  const exportReport = () => {
    const activeSelectedKols = outreachSelectedKols;
    const confirmationSource = verificationComplete ? '独立账号核验' : '主页画像确认';
    const enrichmentJobIds = effectiveProfileSources.map(({ job }) => job.id);
    const contentJobIds = effectiveContentSources.map(({ job }) => job.id);
    const contentAnalysisJobIds = effectiveContentAnalysisSources.map(({ job }) => job.id);
    const outreachSummary = summarizeOutreachDrafts(outreachDrafts);
    const outreachDraftsByTargetId = new Map(outreachDrafts.map((draft) => [draft.targetId, draft]));
    const report = [
      `${brief.brand} KOL 建联执行报告`,
      '',
      `产品：${brief.product}`,
      `渠道：${activeChannels.map((channel) => channel.name).join('、') || '未选择'}`,
      `候选采集任务：${reportJob?.id || '尚未创建'}`,
      `候选采集状态：${statusLabel(reportJob?.status)}`,
      `候选源记录：${reportJob?.metrics?.sourceRecords ?? 0}`,
      `归一化候选：${reportJob?.metrics?.creators ?? 0}`,
      `账号核验任务：${verificationJob?.id || '尚未创建'}`,
      `核验源记录：${verificationJob?.metrics?.sourceRecords ?? 0}`,
      `已核验账号：${verificationJob?.metrics?.verifiedTargets ?? 0}`,
      `达人画像任务：${enrichmentJobIds.join('、') || '尚未创建'}`,
      `达人画像批次：${enrichmentJobIds.length}`,
      `达人画像状态：${statusLabel(enrichmentJob?.status)}`,
      `已确认主页画像：${profileConfirmedSelectedKols.length}`,
      `画像快照产物：${enrichmentArtifactCount}`,
      `公开内容任务：${contentJobIds.join('、') || '尚未创建'}`,
      `公开内容批次：${contentJobIds.length}`,
      `公开内容状态：${statusLabel(contentJob?.status)}`,
      `公开内容快照产物：${contentArtifactCount}`,
      `公开内容样本：${contentSampleCount}`,
      `内容理解任务：${contentAnalysisJobIds.join('、') || '尚未创建'}`,
      `内容理解批次：${contentAnalysisJobIds.length}`,
      `内容理解状态：${statusLabel(contentAnalysisJob?.status)}`,
      `已理解达人：${contentAnalysisCreatorCount}`,
      `可追溯判断：${contentAnalysisFindingCount}`,
      `下游凭据：${confirmationSource}`,
      `已选 KOL：${activeSelectedKols.length}`,
      `证据锁定草稿：${outreachSummary.total}`,
      `可用草稿：${outreachSummary.ready}`,
      `待补齐证据：${outreachSummary.blocked}`,
      `内容已变化：${outreachSummary.stale}`,
      `已审核：${outreachSummary.approved}`,
      `已标记发送：${outreachSummary.sent || sent.length}`,
      '',
      '候选明细：',
      ...activeSelectedKols.map((creator) => {
        const persona = creator.persona || enrichedByTargetId[creator.id || creator.targetId];
        const confirmation = creator.verification?.status === 'verified'
          ? '独立核验'
          : hasConfirmedProfile(persona) ? '主页确认' : '待确认';
        const dimensionCount = Object.keys(plainObject(persona?.dimensions)).length;
        const analysis = contentAnalysisByTargetId[creator.id]?.analysis;
        const synthesis = profileText(analysis?.synthesis?.summary, '未返回内容理解结论');
        const outreachDraft = outreachDraftsByTargetId.get(creator.id);
        const primaryEvidence = outreachDraft?.evidence?.primary;
        const outreach = outreachDraft
          ? `建联：${outreachDraftStatusLabel(outreachDraft.status)} · ${outreachReviewStatusLabel(outreachDraft.review?.status)} · ${outreachFreshnessLabel(outreachDraft.source?.freshness)}${primaryEvidence ? ` · 证据 ${outreachEvidenceTimeAnchor(primaryEvidence)} · ${primaryEvidence.excerpt}` : ''}`
          : '建联：尚未生成';
        return `${creator.name} | ${creator.platform} | ${creator.sampleCount} 条样本 | ${confirmation} | ${dimensionCount} 个画像维度 | 内容理解：${analysis ? `${analysisStatusLabel(analysis.status)} · ${analysisFindingCount(contentAnalysisByTargetId[creator.id])} 条判断 · ${synthesis}` : '未运行'} | ${outreach} | ${creator.sourceUrl || '源链接未提供'}`;
      }),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${brief.brand || 'KOL'}-outreach-report.txt`;
    link.click();
    URL.revokeObjectURL(url);
    notify('真实任务快照报告已导出');
  };

  const disableNext = (currentStep === 2 && channels.length === 0)
    || (currentStep === 3 && activeSelectedKols.length === 0)
    || (currentStep === 4 && !outreachReady)
    || (currentStep === 5 && readyOutreachDraftCount === 0);
  const attachedConnectorCount = channelOptions.filter((channel) => ['ready', 'relay_connected'].includes(connectors[channel.id]?.status)).length;
  const workspaceRunning = running || enrichmentRunning || contentRunning || contentAnalysisRunning;
  const workspaceStatus = workspaceRunning ? 'Agents 正在运行'
    : contentAnalysisJob?.status ? `内容理解：${statusLabel(contentAnalysisJob.status)}`
      : contentJob?.status ? `内容任务：${statusLabel(contentJob.status)}`
      : verificationJob?.status ? `核验任务：${statusLabel(verificationJob.status)}`
      : discoveryJob?.status ? `候选采集：${statusLabel(discoveryJob.status)}`
        : attachedConnectorCount ? `${attachedConnectorCount} 条连接器已附着，等待真实采集` : '等待真实连接器';
  const workflowStages = useMemo(() => {
    const hasBrief = Boolean(brief.brand?.trim() && brief.product?.trim() && brief.objective?.trim());
    const hasChannels = channels.length > 0;
    const hasCandidates = creators.length > 0 || Number(discoveryJob?.metrics?.creators || 0) > 0;
    const hasSelection = activeSelectedKols.length > 0;
    const hasVerification = outreachReady;
    const hasOutreach = readyOutreachDraftCount > 0;
    const stages = [
      { id: 1, label: '定义任务', caption: 'BRIEF', metric: hasBrief ? '已就绪' : '待补全', done: hasBrief, detail: brief.product || '填写产品与目标' },
      { id: 2, label: '连接渠道', caption: 'CHANNELS', metric: `${channels.length} 个渠道`, done: hasBrief && hasChannels, detail: attachedConnectorCount ? `${attachedConnectorCount} 条已附着` : '等待连接状态' },
      { id: 3, label: '构建候选池', caption: 'DISCOVERY', metric: hasCandidates ? `${creators.length || discoveryJob?.metrics?.creators || 0} 位候选` : '待采集', done: hasCandidates && hasSelection, detail: hasSelection ? `已选 ${activeSelectedKols.length} 位` : '筛选优先合作对象' },
      { id: 4, label: '验证与取证', caption: 'EVIDENCE', metric: hasVerification ? `${outreachSelectedKols.length} 位可用` : '待验证', done: hasVerification, detail: contentSampleCount ? `${contentSampleCount} 条内容样本` : '验证主页与内容证据' },
      { id: 5, label: '审核建联', caption: 'OUTREACH', metric: hasOutreach ? `${readyOutreachDraftCount} 份草稿` : '待生成', done: hasOutreach, detail: hasOutreach ? `${summarizeOutreachDrafts(outreachDrafts).approved} 份已审核` : '生成证据锁定草稿' },
      { id: 6, label: '交付报告', caption: 'DELIVERY', metric: hasOutreach ? '可导出' : '待就绪', done: false, detail: hasOutreach ? '汇总当前任务快照' : '完成建联草稿后开放' },
    ];
    return stages.map((stage) => ({
      ...stage,
      state: currentStep === stage.id ? 'active' : stage.done ? 'complete' : stage.id > maxUnlocked ? 'blocked' : 'ready',
    }));
  }, [brief, channels.length, creators.length, discoveryJob, activeSelectedKols.length, outreachReady, outreachSelectedKols.length, contentSampleCount, readyOutreachDraftCount, outreachDrafts, attachedConnectorCount, currentStep, maxUnlocked]);
  const nextWorkflowAction = useMemo(() => workflowStages.find((stage) => !stage.done && stage.id < 6) || workflowStages[5], [workflowStages]);

  const creatorDetailHref = (creatorId, overrides = {}) => {
    if (!creatorId) return '';
    const creatorEnrichmentJob = defaultJobForTarget(enrichmentJobs, creatorId);
    const creatorContentJob = defaultJobForTarget(contentJobs, creatorId);
    const creatorAnalysisJob = defaultJobForTarget(contentAnalysisJobs, creatorId);
    return detailRouteHref({
      view: 'creator',
      campaignId: campaign?.id || '',
      creatorId,
      discoveryJobId: overrides.discoveryJobId || creatorContentJob?.discoveryJobId || discoveryJob?.id || '',
      enrichmentJobId: overrides.enrichmentJobId || creatorEnrichmentJob?.id || '',
      contentJobId: overrides.contentJobId || creatorContentJob?.id || '',
      analysisJobId: overrides.analysisJobId || creatorAnalysisJob?.id || '',
    });
  };
  const contentDetailHref = (creatorId, sample, overrides = {}) => {
    if (!creatorId || !sample) return '';
    const creatorEnrichmentJob = defaultJobForTarget(enrichmentJobs, creatorId);
    const creatorContentJob = defaultJobForTarget(contentJobs, creatorId);
    const creatorAnalysisJob = defaultJobForTarget(contentAnalysisJobs, creatorId);
    return detailRouteHref({
      view: 'content',
      campaignId: campaign?.id || '',
      creatorId,
      contentId: detailContentIdentifier(sample),
      sourceUrl: sample.sourceUrl || '',
      sampleIndex: sample.sampleIndex || '',
      discoveryJobId: overrides.discoveryJobId || creatorContentJob?.discoveryJobId || discoveryJob?.id || '',
      enrichmentJobId: overrides.enrichmentJobId || creatorEnrichmentJob?.id || '',
      contentJobId: overrides.contentJobId || creatorContentJob?.id || '',
      analysisJobId: overrides.analysisJobId || creatorAnalysisJob?.id || '',
    });
  };
  const detailContentSourceJob = defaultJobForTarget(contentJobs, detailRoute.creatorId, detailRoute.contentJobId);
  const detailAnalysisSourceJob = defaultJobForTarget(contentAnalysisJobs, detailRoute.creatorId, detailRoute.analysisJobId);
  const detailEnrichmentSourceJob = defaultJobForTarget(enrichmentJobs, detailRoute.creatorId, detailRoute.enrichmentJobId);
  const detailProfileMap = detailEnrichmentSourceJob ? profileMapFromJob(detailEnrichmentSourceJob) : enrichedByTargetId;
  const detailContentMap = detailContentSourceJob ? contentMapFromJob(detailContentSourceJob) : contentByTargetId;
  const detailAnalysisMap = detailAnalysisSourceJob ? analysisMapFromJob(detailAnalysisSourceJob) : contentAnalysisByTargetId;
  const detailProfile = detailProfileMap[detailRoute.creatorId];
  const detailCapture = detailContentMap[detailRoute.creatorId];
  const detailAnalysisRecord = detailAnalysisMap[detailRoute.creatorId];
  const detailCreator = creatorForDetail({
    creatorId: detailRoute.creatorId,
    creator: creators.find((creator) => creator.id === detailRoute.creatorId),
    profile: detailProfile,
    contentCapture: detailCapture,
    analysisRecord: detailAnalysisRecord,
    fallbackChannel: channels[0],
  });
  const detailSample = resolveDetailContentSample(detailCapture?.content?.visibleSamples, detailRoute);
  const detailAudienceInsight = detailRoute.creatorId
    ? audienceInsightForCreator(
      detailCreator,
      mergeProfileWithContentCapture(detailProfile, detailCapture),
      audienceByTargetId,
    )
    : null;
  const routeSnapshot = {
    discoveryJobId: detailRoute.discoveryJobId || discoveryJob?.id || '',
    enrichmentJobId: detailRoute.enrichmentJobId || detailEnrichmentSourceJob?.id || '',
    contentJobId: detailRoute.contentJobId || detailContentSourceJob?.id || '',
    analysisJobId: detailRoute.analysisJobId || detailAnalysisSourceJob?.id || '',
  };

  if (detailRoute.view !== 'workspace') {
    if (detailRouteLoading) return <EntityPageLoading backHref={workspaceHref()} />;
    if (detailRouteError) return <EntityPageEmpty title="无法打开独立页面" detail={detailRouteError} backHref={workspaceHref()} />;
    if (!detailRoute.creatorId || detailCreator.name === '未命名达人') {
      return <EntityPageEmpty title="未找到达人快照" detail="该链接对应的达人不在当前活动或指定任务版本中。" backHref={workspaceHref()} />;
    }
    const currentCreatorHref = creatorDetailHref(detailCreator.id, routeSnapshot);
    const currentContentHref = (sample) => contentDetailHref(detailCreator.id, sample, routeSnapshot);
    if (detailRoute.view === 'content') {
      if (!detailSample) {
        return <EntityPageEmpty title="未找到内容快照" detail="该内容可能已更新、被移除，或链接中的内容任务版本不存在。" backHref={workspaceHref()} />;
      }
      return <ContentDetailPage
        creator={detailCreator}
        profile={detailProfile}
        contentCapture={detailCapture}
        contentAnalysisRecord={detailAnalysisRecord}
        contentAnalysisJob={detailAnalysisSourceJob}
        contentJob={detailContentSourceJob}
        sample={detailSample}
        backHref={workspaceHref()}
        creatorHref={currentCreatorHref}
      />;
    }
    return <CreatorDetailPage
      creator={detailCreator}
      profile={detailProfile}
      contentCapture={detailCapture}
      contentAnalysisRecord={detailAnalysisRecord}
      contentAnalysisJob={detailAnalysisSourceJob}
      contentAnalysisRunning={contentAnalysisRunning && detailAnalysisSourceJob?.id === contentAnalysisJob?.id}
      enrichmentJob={detailEnrichmentSourceJob}
      enrichmentRunning={enrichmentRunning && detailEnrichmentSourceJob?.id === enrichmentJob?.id}
      contentJob={detailContentSourceJob}
      contentRunning={contentRunning && detailContentSourceJob?.id === contentJob?.id}
      audienceInsight={detailAudienceInsight}
      audienceLoading={audienceLoading}
      audienceImporting={audienceImportingTargetId === detailCreator.id}
      audienceError={audienceError}
      onImportAudience={importAudienceInsight}
      onRefreshAudience={refreshAudienceInsights}
      onEnrich={runEnrichment}
      onCollectContent={runContentCollection}
      backHref={workspaceHref()}
      creatorHref={currentCreatorHref}
      contentPageHref={currentContentHref}
    />;
  }

  if (appModule === 'content-capture') {
    return <ContentCaptureModule
      onBack={() => navigateModule('kol')}
      notify={notify}
      toast={toast}
      connectors={connectors}
      connectionRetention={connectionRetention}
      connectorChecking={connectorChecking}
      recoveringPlatform={connectorRecovery}
      onRecheck={() => void refreshConnectors({ recheck: true })}
      onRecover={recoverConnector}
    />;
  }

  if (appModule === 'douyin-comments') {
    return <DouyinCommentWorkspace onBack={() => navigateModule('kol')} />;
  }

  return (
    <div className="agent-app">
      <aside className={`rail ${mobileNav ? 'open' : ''}`}>
        <div className="wordmark"><span>A</span><strong>aftercode</strong><small>AGENT OS</small><button onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={18} /></button></div>
        <div className="project-meta"><div className="project-dot">{(brief.brand || 'K').slice(0, 1).toUpperCase()}</div><div><strong>{brief.brand || '未命名项目'}</strong><span>{brief.product || '创建本次营销任务'}</span></div><ChevronDown size={15} /></div>
        <div className="module-switcher" aria-label="工作模块">
          <button type="button" className="module-switch active"><Users size={14} /><span><small>KOL WORKFLOW</small><strong>KOL 采集</strong></span></button>
          <button type="button" className="module-switch" onClick={() => navigateModule('content-capture')}><Search size={14} /><span><small>DIRECT CONTENT</small><strong>直接内容采集</strong></span><ArrowRight size={13} /></button>
          <button type="button" className="module-switch" onClick={() => navigateModule('douyin-comments')}><MessageSquareText size={14} /><span><small>DOUYIN COMMENTS</small><strong>主页评论采集</strong></span><ArrowRight size={13} /></button>
        </div>
        <div className="step-rail">
          {workflowStages.map((stage) => {
            const step = steps[stage.id - 1];
            const Icon = step.icon;
            const complete = stage.done;
            const locked = step.id > maxUnlocked;
            return <button key={step.id} className={`${currentStep === step.id ? 'active' : ''} ${complete ? 'complete' : ''}`} onClick={() => goToStep(step.id)} disabled={locked} title={stage.detail}>
              <span className="step-index">{complete ? <Check size={13} /> : String(step.id).padStart(2, '0')}</span>
              <span className="step-copy"><small>{stage.caption}</small><strong>{stage.label}</strong></span>
              <Icon size={16} />
            </button>;
          })}
        </div>
        <div className="agent-capacity"><div><span><Activity size={14} /> Agent 运载</span><strong>{workspaceRunning ? 'LIVE' : 'READY'}</strong></div><div className="capacity-track">{[1, 2, 3, 4, 5].map((slot) => <i key={slot} className={slot <= Math.max(1, Math.min(5, attachedConnectorCount + (workspaceRunning ? 2 : 1))) ? 'on' : ''} />)}</div><small>{workspaceRunning ? '任务正在写入证据与快照' : '连接器、任务、来源均可恢复'}</small></div>
        <div className="rail-actions"><button className="rail-settings" onClick={() => setCommandPaletteOpen(true)}><Command size={16} />命令面板 <kbd>Ctrl K</kbd></button><button className="rail-settings" onClick={() => void refreshConnectors()}><Settings2 size={16} />刷新连接器</button></div>
      </aside>

      <main className="workbench">
        <header className="appbar">
          <button className="icon-btn mobile-only" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={19} /></button>
          <div className="run-status"><span className={workspaceRunning ? 'live' : ''} /><div><small>WORKSPACE STATUS</small><strong>{workspaceStatus}</strong></div></div>
          <div className="appbar-actions"><button className="quiet-btn command-trigger" onClick={() => setCommandPaletteOpen(true)}><Command size={15} />命令 <kbd>Ctrl K</kbd></button><button className="quiet-btn" onClick={() => void refreshConnectors()}><Wifi size={15} />连接器状态</button><button className="avatar-button" title="当前工作区操作员"><img src="/avatars/operator.jpg" alt="阿棠" /></button></div>
        </header>

        <div className="canvas">
          <CampaignCommandCenter
            stages={workflowStages}
            activeStage={currentStep}
            onNavigate={goToStep}
            nextAction={nextWorkflowAction}
            workspaceRunning={workspaceRunning}
            connectors={attachedConnectorCount}
            candidates={creators.length || Number(discoveryJob?.metrics?.creators || 0)}
            selected={activeSelectedKols.length}
            evidence={contentSampleCount}
            drafts={readyOutreachDraftCount}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          />
          <StepHeader step={steps[currentStep - 1]} currentStep={currentStep} stage={workflowStages[currentStep - 1]} />
          {currentStep === 1 && <BriefStep brief={brief} setBrief={setBrief} />}
          {currentStep === 2 && <ChannelStep selected={channels} onChange={updateChannels} connectors={connectors} connectionRetention={connectionRetention} connectorChecking={connectorChecking} recoveringPlatform={connectorRecovery} onRecheck={() => void refreshConnectors({ recheck: true })} onRecover={recoverConnector} />}
          {currentStep === 3 && <CreatorStep creators={creators} channels={channels} selected={activeSelectedKols.map((creator) => creator.id)} setSelected={updateSelectedKols} discoveryQuery={discoveryQuery} setDiscoveryQuery={setDiscoveryQuery} candidateLimit={candidateLimit} setCandidateLimit={setCandidateLimit} candidatePage={candidatePage} onLoadMoreCandidates={() => discoveryJob?.id && loadDiscoveryCandidatePage(discoveryJob.id, { reset: Boolean(candidatePage.error) })} priorityBatchLimit={priorityBatchLimit} setPriorityBatchLimit={setPriorityBatchLimit} creatorFilter={creatorFilter} setCreatorFilter={setCreatorFilter} onDiscover={runDiscovery} running={activeJob?.kind === 'discover' && running} job={discoveryJob} connectors={connectors} archiveEntries={collectionArchiveEntries} archiveLoading={archiveLoading} onRefreshArchive={refreshArchive} onRestoreCampaign={hydrateCampaign} onRestoreCollection={restoreStandaloneCollection} onRestoreEnrichment={restoreStandaloneEnrichment} onRestoreContent={restoreStandaloneContent} onRestoreContentAnalysis={restoreStandaloneContentAnalysis} onResume={resumeCollection} profilesByTargetId={enrichedByTargetId} enrichmentJob={enrichmentJob} enrichmentRunning={enrichmentRunning} enrichmentError={enrichmentError} contentByTargetId={contentByTargetId} contentJob={contentJob} contentRunning={contentRunning} contentError={contentError} contentSampleLimit={contentSampleLimit} setContentSampleLimit={setContentSampleLimit} contentJobs={contentJobs} contentAnalysisByTargetId={contentAnalysisByTargetId} contentAnalysisJob={contentAnalysisJob} contentAnalysisRunning={contentAnalysisRunning} contentAnalysisError={contentAnalysisError} contentAnalysisSourceJobId={contentAnalysisSourceJobId} setContentAnalysisSourceJobId={setContentAnalysisSourceJobId} onAnalyzeContent={runContentAnalysis} onEnrich={runEnrichment} onCollectContent={runContentCollection} audienceByTargetId={audienceByTargetId} audienceLoading={audienceLoading} audienceImportingTargetId={audienceImportingTargetId} audienceError={audienceError} onImportAudience={importAudienceInsight} onRefreshAudience={refreshAudienceInsights} creatorPageHref={(creatorId, overrides) => creatorDetailHref(creatorId, overrides)} />}
          {currentStep === 4 && <CrawlStep job={verificationJob} running={activeJob?.kind === 'verify' && running} onRun={runVerification} count={activeSelectedKols.length} channels={channels} selected={activeSelectedKols} profileConfirmedCount={profileConfirmedSelectedKols.length} profileArtifactCount={enrichmentArtifactCount} profileConfirmationComplete={profileConfirmationComplete} />}
          {currentStep === 5 && <EvidenceLockedMessageStep selected={outreachSelectedKols} brief={brief} contentReady={contentOutreachReady} missingContentCreators={outreachContentMissing} onOpenContentFlow={() => goToStep(3)} drafts={outreachDrafts} loading={outreachDraftsLoading} error={outreachDraftsError} onGenerate={generateMessages} onUpdateDraft={updateOutreachDraft} notify={notify} />}
          {currentStep === 6 && <ReportStep selected={outreachSelectedKols} channels={channels} sent={sent} generated={generated} outreachDrafts={outreachDrafts} onExport={exportReport} brief={brief} job={reportJob} verificationJob={verificationJob} enrichmentJob={enrichmentJob} enrichmentRunCount={enrichmentRunCount} profileConfirmedCount={profileConfirmedSelectedKols.length} profileArtifactCount={enrichmentArtifactCount} contentJob={contentJob} contentRunCount={contentRunCount} contentArtifactCount={contentArtifactCount} contentSampleCount={contentSampleCount} contentAnalysisJob={contentAnalysisJob} contentAnalysisRunCount={contentAnalysisRunCount} contentAnalysisCreatorCount={contentAnalysisCreatorCount} contentAnalysisFindingCount={contentAnalysisFindingCount} contentAnalysisByTargetId={contentAnalysisByTargetId} />}

          <footer className="step-footer">
            <button className="back-btn" onClick={() => setCurrentStep((value) => Math.max(1, value - 1))} disabled={currentStep === 1}><ArrowLeft size={16} />上一步</button>
            <span>步骤 {currentStep} / 6</span>
            {currentStep < 6
              ? <button className="next-btn" onClick={goNext} disabled={disableNext}>确认并继续<ArrowRight size={16} /></button>
              : <button className="next-btn" onClick={exportReport}><Download size={16} />导出报告</button>}
          </footer>
        </div>
      </main>
      {mobileNav && <button className="rail-scrim" onClick={() => setMobileNav(false)} aria-label="关闭导航" />}
      {commandPaletteOpen && <CommandPalette
        stages={workflowStages}
        currentStep={currentStep}
        onNavigate={(step) => { goToStep(step); setCommandPaletteOpen(false); }}
        onRefresh={() => { void refreshConnectors({ recheck: true }); setCommandPaletteOpen(false); }}
        onExport={() => { if (readyOutreachDraftCount > 0) exportReport(); setCommandPaletteOpen(false); }}
        onClose={() => setCommandPaletteOpen(false)}
        canExport={readyOutreachDraftCount > 0}
      />}
      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
    </div>
  );
}

function DirectCaptureControlPanel({ runtimeConfig, contentModelPreference, videoVisionPreference, onContentModelChange, onVideoVisionChange, previewQuery, setPreviewQuery, onOpenSearch }) {
  const relay = runtimeConfig?.relay || {};
  const browser = runtimeConfig?.browser || {};
  const contentModels = runtimeConfig?.models?.content?.options?.length
    ? runtimeConfig.models.content.options
    : [
      { id: 'configured', label: '服务端模型', description: '使用服务端当前配置', enabled: true },
      { id: 'evidence_matrix', label: '证据矩阵 · 仅本地证据', description: '不调用模型', enabled: true },
    ];
  const videoModels = runtimeConfig?.models?.videoVision?.options?.length
    ? runtimeConfig.models.videoVision.options
    : [
      { id: 'configured', label: '视频视觉模型', description: '使用服务端当前配置', enabled: true },
      { id: 'keyframes_only', label: '关键帧 / OCR / 转写', description: '不调用视觉模型', enabled: true },
    ];
  const openSearch = () => {
    const value = previewQuery.trim();
    if (!value) return;
    onOpenSearch(value);
  };
  return <section className="capture-control-panel">
    <div className="capture-control-header">
      <div><small>RELAY CONTROL CONSOLE</small><h2>采集控制台</h2><span>基础参数、运行参数、渠道连接和前端浏览集中在一个面板。</span></div>
      <div className="capture-control-status"><span className="live-dot" />{browser.profileAlias || 'attached-browser'}<strong>DOUYIN {relay.douyinPort || 18801}</strong></div>
    </div>
    <div className="capture-control-grid">
      <fieldset className="capture-control-fieldset">
        <legend>基础参数</legend>
        <div className="capture-control-row"><span>浏览器会话</span><strong>{browser.profileAlias || 'attached-browser'}</strong></div>
        <div className="capture-control-row"><span>小红书 Relay</span><strong>{runtimeConfig?.channels?.find((channel) => channel.id === 'xiaohongshu')?.relayPort || '18800'}</strong></div>
        <div className="capture-control-row"><span>抖音 Relay</span><strong className="fixed-port">{relay.douyinPort || 18801} · FIXED</strong></div>
        <div className="capture-control-search-row"><input value={previewQuery} onChange={(event) => setPreviewQuery(event.target.value)} placeholder="输入前端浏览关键词" aria-label="前端浏览关键词" /><button type="button" onClick={openSearch} disabled={!previewQuery.trim()}><Globe2 size={13} />打开抖音搜索页</button></div>
      </fieldset>
      <fieldset className="capture-control-fieldset">
        <legend>运行参数</legend>
        <label className="capture-control-select"><span>内容分析模型</span><select value={contentModelPreference} onChange={(event) => onContentModelChange(event.target.value)}>{contentModels.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><small>{contentModels.find((option) => option.id === contentModelPreference)?.description || ''}</small></label>
        <label className="capture-control-select"><span>视频视觉模式</span><select value={videoVisionPreference} onChange={(event) => onVideoVisionChange(event.target.value)}>{videoModels.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><small>{videoModels.find((option) => option.id === videoVisionPreference)?.description || ''}</small></label>
        <div className="capture-control-runtime"><Bot size={14} /><span>{runtimeConfig?.models?.content?.provider || 'server'} / {runtimeConfig?.models?.content?.model || 'evidence matrix'}</span><em>{runtimeConfig?.models?.content?.enabled ? 'MODEL READY' : 'EVIDENCE READY'}</em></div>
      </fieldset>
    </div>
  </section>;
}

function ContentCaptureModule({ onBack, notify, toast, connectors, connectionRetention, connectorChecking, recoveringPlatform, onRecheck, onRecover }) {
  const [mobileNav, setMobileNav] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState(null);
  const [contentModelPreference, setContentModelPreference] = useState('configured');
  const [videoVisionPreference, setVideoVisionPreference] = useState('configured');
  const [previewQuery, setPreviewQuery] = useState('短发女');
  const directRelayStatuses = ['douyin', 'xiaohongshu'].map((platform) => connectors?.[platform]?.status);
  const directRelayReadyCount = directRelayStatuses.filter((status) => ['ready', 'relay_connected'].includes(status)).length;
  const directRelayLabel = directRelayReadyCount === 2 ? 'READY' : directRelayReadyCount === 1 ? 'PARTIAL' : 'CHECK';
  useEffect(() => {
    let cancelled = false;
    fetch(apiPath('/api/runtime-config'))
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (!cancelled && payload) setRuntimeConfig(payload);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return (
    <div className="agent-app content-capture-app">
      <aside className={`rail ${mobileNav ? 'open' : ''}`}>
        <div className="wordmark"><span>A</span><strong>aftercode</strong><small>AGENT OS</small><button onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={18} /></button></div>
        <div className="module-context"><small>STANDALONE MODULE</small><strong>内容采集</strong><span>直接抓取公开内容，不进入 KOL 候选池</span></div>
        <div className="module-switcher" aria-label="工作模块">
          <button type="button" className="module-switch" onClick={onBack}><Users size={14} /><span><small>KOL WORKFLOW</small><strong>KOL 采集</strong></span><ArrowRight size={13} /></button>
          <button type="button" className="module-switch active"><Search size={14} /><span><small>DIRECT CONTENT</small><strong>直接内容采集</strong></span></button>
        </div>
        <div className="agent-capacity"><div><span><Activity size={14} /> Relay 状态</span><strong>{directRelayLabel}</strong></div><div className="capacity-track">{[1, 2, 3, 4, 5].map((slot) => <i key={slot} className={slot <= Math.max(1, directRelayReadyCount * 2) ? 'on' : ''} />)}</div><small>检索、媒体解析与分析流程独立运行</small></div>
      </aside>

      <main className="workbench">
        <header className="appbar">
          <button className="icon-btn mobile-only" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={19} /></button>
          <div className="run-status"><span className="live" /><div><small>CONTENT CAPTURE</small><strong>DIRECT INGESTION</strong></div></div>
          <div className="appbar-actions"><button className="quiet-btn" onClick={onBack}><ArrowLeft size={15} />返回 KOL 采集</button><button className="avatar-button" title="当前工作区操作员"><img src="/avatars/operator.jpg" alt="操作员" /></button></div>
        </header>
        <div className="canvas content-capture-canvas">
          <DirectCaptureControlPanel
            runtimeConfig={runtimeConfig}
            contentModelPreference={contentModelPreference}
            videoVisionPreference={videoVisionPreference}
            onContentModelChange={setContentModelPreference}
            onVideoVisionChange={setVideoVisionPreference}
            previewQuery={previewQuery}
            setPreviewQuery={setPreviewQuery}
            onOpenSearch={(value) => {
              const template = runtimeConfig?.channels?.find((channel) => channel.id === 'douyin')?.postSearchUrlTemplate
                || 'https://www.douyin.com/search/{query}?type=general';
              window.open(template.replace('{query}', encodeURIComponent(value)), '_blank', 'noopener,noreferrer');
            }}
          />
          <div className="capture-control-channel-section">
            <div className="capture-control-section-label"><span>链接渠道</span><small>SESSION / RELAY RETENTION</small></div>
            <ConnectionRetentionPanel
              channels={['douyin', 'xiaohongshu']}
              retention={connectionRetention}
              connectors={connectors}
              checking={connectorChecking}
              recoveringPlatform={recoveringPlatform}
              onRecheck={onRecheck}
              onRecover={onRecover}
            />
          </div>
          <ContentHistoryPanel />
          <PostSearchWorkbench campaign={null} onCampaignUpdate={() => {}} onClose={onBack} notify={notify} contentModelPreference={contentModelPreference} videoVisionPreference={videoVisionPreference} />
        </div>
      </main>
      {mobileNav && <button className="rail-scrim" onClick={() => setMobileNav(false)} aria-label="关闭导航" />}
      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
    </div>
  );
}

function historyRecordTypeLabel(recordType, jobType = '') {
  if (jobType === 'post_search') return '关键词采集';
  if (jobType === 'post_search_comments') return '热评采集';
  if (jobType === 'post_search_media') return '视频关键帧';
  return recordType === 'analysis' ? '智能分析' : recordType === 'job' ? '采集任务' : '采集快照';
}

function historyRecordStatusLabel(status) {
  const labels = {
    succeeded: '已完成',
    partial_success: '部分完成',
    completed_empty: '无结果',
    running: '采集中',
    collecting: '采集中',
    analyzing: '分析中',
    failed: '失败',
  };
  return labels[status] || status || '已保存';
}

function contentHistoryVideoUrl(sample) {
  const media = plainObject(sample?.media);
  const value = firstPresent(
    sample?.videoUrl,
    sample?.video_url,
    sample?.playUrl,
    sample?.play_url,
    sample?.mediaUrl,
    sample?.media_url,
    media.videoUrl,
    media.video_url,
    media.playUrl,
    media.play_url,
  );
  return /^https?:\/\//i.test(String(value || '').trim()) ? String(value).trim() : '';
}

function ContentHistoryPostCard({ post, onPreviewImage }) {
  const tags = Array.isArray(post?.tags) ? post.tags.filter(Boolean).slice(0, 6) : [];
  const profile = post?.profile || post?.authorProfileData || null;
  const mediaState = post?.mediaState || post?.media || null;
  return <article className="post-search-card content-history-post-card">
    <PostSearchMedia post={post} mediaState={mediaState} onPreviewImage={onPreviewImage} />
    <div className="post-search-card-body">
      <div className="post-search-author"><span className="post-author-mark">{(post?.authorName || '博').slice(0, 1)}</span><div><strong>{post?.authorName || '未知博主'}</strong><small>{post?.publishedAt ? formatPostDate(post.publishedAt) : post?.publishedAtText || '公开内容'}</small></div>{post?.contentUrl && <a href={post.contentUrl} target="_blank" rel="noreferrer" title="打开帖子"><ExternalLink size={14} /></a>}</div>
      {post?.authorProfile && <a className="post-profile-link" href={post.authorProfile} target="_blank" rel="noreferrer"><Users size={12} />打开博主个人主页</a>}
      <PostSearchProfileSummary post={post} profile={profile} />
      <h2>{post?.title || '未返回标题'}</h2>
      <p className="post-search-body">{post?.body || '暂无正文摘要'}</p>
      {tags.length > 0 && <div className="post-search-tags">{tags.map((tag) => <span key={tag}>#{String(tag).replace(/^#/, '')}</span>)}</div>}
      <div className="post-search-metrics">{postMetricItems(post).map((metric) => <span key={metric.label}><small>{metric.label}</small><strong>{metric.value}</strong></span>)}</div>
      {post?.contentUrl && <a className="content-history-source" href={post.contentUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />打开帖子来源</a>}
    </div>
  </article>;
}

function ContentHistoryPostHotComments({ post }) {
  const comments = Array.isArray(post?.comments) ? post.comments.slice(0, 10) : [];
  if (!comments.length) return null;
  return <section className="content-history-post-hot-comments" aria-label="帖子热评">
    <div className="content-history-section-title"><strong>帖子热评</strong><small>前 {comments.length} 条</small></div>
    <ol>{comments.map((comment, index) => <li key={comment.id || comment.commentId || index}>
      <span className="content-history-comment-rank">{comment.rank || index + 1}</span>
      <div><strong>{comment.authorName || comment.userName || '匿名用户'}</strong><p>{comment.text || comment.content || comment.body || '暂无评论内容'}</p><small>{comment.likeCount ?? comment.likes ?? comment.diggCount ?? 0} 赞</small></div>
    </li>)}</ol>
  </section>;
}

function postSearchProgressLabel(phase) {
  const labels = {
    connecting: '正在连接 Relay',
    search: '正在扫描搜索结果',
    detail: '正在打开帖子并抓取热评',
    saving: '正在保存本批结果',
    complete: '本批采集完成',
    completed: '本批采集完成',
    failed: '本批采集失败',
  };
  return labels[phase] || '正在采集';
}

function PostSearchLiveProgress({ progress }) {
  if (!progress) return null;
  const percent = Math.max(0, Math.min(100, Number(progress.progress) || 0));
  const discovered = Number(progress.newPosts ?? progress.visible);
  const skipped = Number(progress.skipped ?? progress.duplicates);
  const detailTotal = Number(progress.total);
  const attempted = Number(progress.attempted);
  const commentsCollected = Number(progress.commentsCollected);
  return <div className={`post-search-live-progress ${progress.phase === 'failed' ? 'failed' : ''}`}>
    <div className="post-search-live-progress-head">
      <span><LoaderCircle className={progress.phase === 'completed' || progress.phase === 'failed' ? '' : 'spin'} size={13} /><strong>{postSearchProgressLabel(progress.phase)}</strong></span>
      <b>{percent}%</b>
    </div>
    <div className="post-search-live-progress-track"><i style={{ width: `${percent}%` }} /></div>
    <small>
      {Number.isFinite(discovered) ? `已发现 ${discovered} 条新帖` : '正在发现新帖'}
      {Number.isFinite(skipped) ? ` · 已跳过 ${skipped} 条重复` : ''}
      {Number.isFinite(detailTotal) && detailTotal > 0 ? ` · 详情 ${Math.min(attempted || 0, detailTotal)} / ${detailTotal}` : ''}
      {Number.isFinite(commentsCollected) ? ` · 热评 ${commentsCollected} 条` : ''}
    </small>
  </div>;
}

async function waitForPostSearchTask(jobId, readJob, onUpdate) {
  const terminal = new Set(['succeeded', 'completed_empty', 'failed', 'cancelled']);
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const job = await readJob(jobId);
    onUpdate?.(job);
    if (job && terminal.has(job.status)) return job;
    await wait(700);
  }
  throw new Error('续爬任务等待超时，请稍后在历史记录中查看最终状态');
}

function ContentHistoryPanel() {
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyType, setHistoryType] = useState('all');
  const [historyChannel, setHistoryChannel] = useState('');
  const [historyRecords, setHistoryRecords] = useState([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyNextCursor, setHistoryNextCursor] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historySaving, setHistorySaving] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyDetail, setHistoryDetail] = useState(null);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const [historyContinuationLoading, setHistoryContinuationLoading] = useState(false);
  const [historyContinuationProgress, setHistoryContinuationProgress] = useState(null);
  const [historyContinuationLimit, setHistoryContinuationLimit] = useState(String(DEFAULT_POST_SEARCH_CONTINUATION_BATCH));
  const [historyMediaPreview, setHistoryMediaPreview] = useState(null);

  const historyParams = (cursor = '0') => {
    const params = new URLSearchParams({ cursor: String(cursor), limit: '50' });
    if (historyQuery.trim()) params.set('q', historyQuery.trim());
    if (historyType !== 'all') params.set('type', historyType);
    if (historyChannel) params.set('channel', historyChannel);
    return params;
  };

  const loadHistoryPage = async (cursor = '0', append = false) => {
    if (append) setHistoryLoadingMore(true);
    else setHistoryLoading(true);
    try {
      const response = await fetch(apiPath(`/api/content-history?${historyParams(cursor).toString()}`));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || '历史记录读取失败');
      const nextRecords = Array.isArray(payload.records) ? payload.records : [];
      setHistoryRecords((current) => append ? [...current, ...nextRecords] : nextRecords);
      setHistoryTotal(Number(payload.total) || 0);
      setHistoryNextCursor(payload.nextCursor || '');
      setHistoryError('');
    } catch (error) {
      setHistoryError(error.message || '历史记录读取失败');
      if (!append) setHistoryRecords([]);
    } finally {
      if (append) setHistoryLoadingMore(false);
      else setHistoryLoading(false);
    }
  };

  useEffect(() => {
    void loadHistoryPage('0', false);
    const handleHistoryUpdated = () => { void loadHistoryPage('0', false); };
    window.addEventListener('content-history-updated', handleHistoryUpdated);
    return () => window.removeEventListener('content-history-updated', handleHistoryUpdated);
  }, [historyQuery, historyType, historyChannel]);

  const openHistoryDetail = async (record) => {
    setHistoryContinuationProgress(null);
    setHistoryDetailLoading(true);
    try {
      const response = await fetch(apiPath(`/api/content-history/detail?id=${encodeURIComponent(record.id)}`));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || '历史记录详情读取失败');
      setHistoryDetail(payload);
    } catch (error) {
      setHistoryError(error.message || '历史记录详情读取失败');
    } finally {
      setHistoryDetailLoading(false);
    }
  };

  const continueHistorySearch = async () => {
    const jobId = historyDetail?.record?.jobId;
    if (!jobId || historyContinuationLoading) return;
    const additionalLimit = parsePostSearchLimit(historyContinuationLimit);
    if (!additionalLimit) {
      setHistoryError(`续爬数量请输入 1-${POST_SEARCH_MAX_RESULTS} 之间的整数`);
      return;
    }
    setHistoryContinuationLoading(true);
    setHistoryContinuationProgress({ phase: 'connecting', progress: 1 });
    try {
      const response = await fetch(apiPath(`/api/post-search/${encodeURIComponent(jobId)}/continue`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ additionalLimit }),
      });
      let payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || '续爬历史搜索任务失败');
      if (payload.accepted) {
        setHistoryContinuationProgress(payload.job?.collectionProgress || { phase: 'connecting', progress: 1 });
        const completedJob = await waitForPostSearchTask(jobId, async (runningJobId) => {
          const jobResponse = await fetch(apiPath(`/api/jobs/${encodeURIComponent(runningJobId)}`));
          const jobPayload = await jobResponse.json().catch(() => ({}));
          if (!jobResponse.ok) throw new Error(jobPayload.error?.message || '续爬任务状态读取失败');
          return jobPayload.job;
        }, (job) => {
          setHistoryContinuationProgress(job?.collectionProgress || {
            phase: job?.phase || job?.status || 'running',
            progress: job?.progress || 0,
          });
        });
        if (completedJob?.result && typeof completedJob.result === 'object') {
          payload = { ...completedJob.result, jobId, job: completedJob, added: completedJob.lastAdded || 0 };
        }
      }
      setHistoryDetail((current) => current ? {
        ...current,
        postSearchSnapshot: payload,
        record: {
          ...current.record,
          status: payload.job?.status || current.record.status,
          capturedAt: payload.fetchedAt || current.record.capturedAt,
          updatedAt: payload.job?.updatedAt || current.record.updatedAt,
          sampleCount: Array.isArray(payload.posts) ? payload.posts.length : current.record.sampleCount,
          postSearch: { ...(current.record.postSearch || {}), postCount: Array.isArray(payload.posts) ? payload.posts.length : current.record.postSearch?.postCount },
        },
      } : current);
      setHistoryRecords((current) => current.map((record) => record.jobId === jobId ? {
        ...record,
        status: payload.job?.status || record.status,
        capturedAt: payload.fetchedAt || record.capturedAt,
        updatedAt: payload.job?.updatedAt || record.updatedAt,
        sampleCount: Array.isArray(payload.posts) ? payload.posts.length : record.sampleCount,
        postSearch: { ...(record.postSearch || {}), postCount: Array.isArray(payload.posts) ? payload.posts.length : record.postSearch?.postCount },
      } : record));
      notifyContentHistoryUpdated();
    } catch (continuationError) {
      setHistoryContinuationProgress((current) => ({ ...(current || {}), phase: 'failed', progress: 100 }));
      setHistoryError(continuationError.message || '续爬历史搜索任务失败');
    } finally {
      setHistoryContinuationLoading(false);
    }
  };

  const saveAllHistory = async () => {
    setHistorySaving(true);
    try {
      const response = await fetch(apiPath(`/api/content-history/export?${historyParams('0').toString()}`));
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error?.message || '历史记录保存失败');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `content-history-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setHistoryError(error.message || '历史记录保存失败');
    } finally {
      setHistorySaving(false);
    }
  };

  const selectedCapture = historyDetail?.content || null;
  const selectedAnalysis = historyDetail?.analysis?.analysis || null;
  const historyJob = historyDetail?.job || null;
  const historicalPostSearchSnapshot = historyDetail?.postSearchSnapshot && typeof historyDetail.postSearchSnapshot === 'object'
    ? historyDetail.postSearchSnapshot
    : null;
  const directResult = historicalPostSearchSnapshot
    || (historyJob?.result && typeof historyJob.result === 'object' ? historyJob.result : {});
  const directPosts = Array.isArray(directResult.posts) ? directResult.posts : [];
  const directHotCommentCount = directPosts.reduce((total, post) => total + (Array.isArray(post?.comments) ? Math.min(10, post.comments.length) : 0), 0);
  const directComments = Array.isArray(directResult.comments) ? directResult.comments : [];
  const directFrames = Array.isArray(directResult.video?.frames) ? directResult.video.frames : [];
  const directPost = directResult.post || historyJob?.target?.post || {};
  const directSummaryValue = directResult.summary?.summary || directResult.summary?.overview || directResult.summary;
  const directSummary = typeof directSummaryValue === 'string'
    ? directSummaryValue
    : [directResult.summary?.statement, directResult.summary?.recommendedAction].filter(Boolean).join(' ');
  const rawSamples = Array.isArray(selectedCapture?.content?.visibleSamples) ? selectedCapture.content.visibleSamples : [];
  const normalizedSamples = publicContentSamples(rawSamples);
  const profile = selectedCapture?.profile || historyDetail?.record?.profile || {};
  const analysisSummary = selectedAnalysis?.summary || selectedAnalysis?.overview || selectedAnalysis?.recommendation || '';

  return <section className="content-history-panel" aria-label="内容历史记录">
    <div className="content-history-head">
      <div><small>CONTENT ARCHIVE / ALL HISTORY</small><strong>历史记录</strong><span>跨采集任务查看已落盘的博主、帖子、样本与智能分析，并一次性保存完整快照。</span></div>
      <div className="content-history-head-actions"><div className="content-history-total"><strong>{historyTotal}</strong><small>条已保存</small></div><button type="button" className="content-history-save" onClick={() => void saveAllHistory()} disabled={historySaving}><Download size={13} />{historySaving ? '保存中' : '保存全部'}</button></div>
    </div>
    <div className="content-history-filters">
      <label className="content-history-search"><Search size={14} /><input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="搜索关键词、博主或来源" aria-label="搜索历史记录" /></label>
      <select value={historyType} onChange={(event) => setHistoryType(event.target.value)} aria-label="历史记录类型"><option value="all">全部记录</option><option value="content">采集快照</option><option value="analysis">智能分析</option><option value="job">采集任务</option></select>
      <select value={historyChannel} onChange={(event) => setHistoryChannel(event.target.value)} aria-label="历史记录渠道"><option value="">全部渠道</option><option value="douyin">抖音</option><option value="xiaohongshu">小红书</option><option value="bilibili">B站</option></select>
      <button type="button" className="content-history-refresh" onClick={() => void loadHistoryPage('0', false)} disabled={historyLoading}><RefreshCw className={historyLoading ? 'spin' : ''} size={13} />刷新</button>
    </div>
    {historyError && <div className="content-history-error"><AlertCircle size={14} />{historyError}</div>}
    {historyLoading && <div className="content-history-state"><LoaderCircle className="spin" size={18} />正在读取全部历史记录</div>}
    {!historyLoading && !historyRecords.length && <div className="content-history-state"><History size={18} />暂无符合筛选条件的历史记录</div>}
    {!historyLoading && historyRecords.length > 0 && <div className="content-history-list">{historyRecords.map((record) => <article className="content-history-row" key={record.id}>
      <div className="content-history-row-main content-history-row-main-clickable" role="button" tabIndex={0} onClick={() => void openHistoryDetail(record)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openHistoryDetail(record); } }} aria-label={`打开${record.name || record.query || '历史记录详情'}`}><span className={`content-history-status ${record.status || ''}`} /><div><strong>{record.name || record.query || '未命名采集任务'}</strong><small>{historyRecordTypeLabel(record.recordType, record.jobType)} · {record.channel || record.platform || '未知渠道'} · {record.query || '未设置关键词'}</small></div></div>
      <div className="content-history-row-count"><strong>{record.sampleCount || 0}</strong><small>{record.recordType === 'analysis' ? `${record.findingCount || 0} 条判断` : record.jobType === 'post_search_comments' ? '条热评' : record.jobType === 'post_search_media' ? '张关键帧' : record.jobType === 'post_search' ? '条帖子' : '条内容'}</small></div>
      <time>{formatPostDate(record.capturedAt || record.updatedAt)}</time>
      <div className="content-history-row-actions"><span>{historyRecordStatusLabel(record.status)}</span><button type="button" onClick={() => void openHistoryDetail(record)} disabled={historyDetailLoading}><FileText size={12} />{record.jobType === 'post_search' ? '打开帖子卡片' : '查看详情'}</button></div>
    </article>)}</div>}
    {!historyLoading && historyNextCursor && <button type="button" className="content-history-more" onClick={() => void loadHistoryPage(historyNextCursor, true)} disabled={historyLoadingMore}>{historyLoadingMore ? <LoaderCircle className="spin" size={13} /> : <Layers3 size={13} />}{historyLoadingMore ? '加载中' : `加载更多（已显示 ${historyRecords.length} / ${historyTotal}）`}</button>}
    {historyDetail && <div className="content-history-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryDetail(null); }}>
      <section className="content-history-detail" role="dialog" aria-modal="true" aria-label="历史记录详情">
        <header><div><small>{historyRecordTypeLabel(historyDetail.record?.recordType, historyDetail.record?.jobType)} / HISTORY DETAIL</small><strong>{historyDetail.record?.name || historyDetail.record?.query || '历史记录详情'}</strong><span>{historyDetail.record?.channel || historyDetail.record?.platform || '未知渠道'} · {formatPostDate(historyDetail.record?.capturedAt)}</span></div><button type="button" className="icon-btn" onClick={() => setHistoryDetail(null)} aria-label="关闭历史记录详情"><X size={16} /></button></header>
        <div className="content-history-detail-body">
          {historyDetail.record?.jobType === 'post_search' && <label className="content-history-limit-control"><span>本次续爬数量</span><div className="content-history-limit-editor"><div className="content-history-limit-input"><input type="number" min="1" max={POST_SEARCH_MAX_RESULTS} step="1" value={historyContinuationLimit} onChange={(event) => setHistoryContinuationLimit(event.target.value)} aria-label="本次续爬数量" /><em>条</em></div><PostSearchLimitPresets value={historyContinuationLimit} onChange={setHistoryContinuationLimit} ariaLabel="历史任务续爬数量快捷值" /></div><small>每次在同一历史任务中追加，最多 {POST_SEARCH_MAX_RESULTS} 条；当前累计 {historyDetail.postSearchSnapshot?.posts?.length || historyDetail.record?.sampleCount || 0} 条，累计重复 {historyDetail.postSearchSnapshot?.cumulativeDuplicates ?? historyDetail.postSearchSnapshot?.collectionMeta?.cumulative_duplicates ?? 0} 条</small></label>}
          <div className="content-history-detail-facts"><div><small>博主 / 任务</small><strong>{historyDetail.record?.handle || profile.displayName || historyDetail.record?.jobId || '未提供'}</strong></div><div><small>样本数量</small><strong>{historyDetail.record?.sampleCount || 0}</strong></div><div><small>状态</small><strong>{historyRecordStatusLabel(historyDetail.record?.status)}</strong></div><div><small>关键词</small><strong>{historyDetail.record?.query || '未设置'}</strong></div></div>
          {historyDetail.record?.jobType === 'post_search' && <div className="content-history-continuation"><div><RefreshCw size={14} /><span><strong>同一搜索任务</strong><small>历史快照保留原任务 ID，可在此继续追加帖子</small></span></div><button type="button" onClick={() => void continueHistorySearch()} disabled={historyContinuationLoading}>{historyContinuationLoading ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}{historyContinuationLoading ? '续爬中' : '继续采集更多帖子'}</button></div>}
          {historyDetail.record?.jobType === 'post_search' && historyContinuationProgress && <PostSearchLiveProgress progress={historyContinuationProgress} />}
          {historyDetail.record?.sourceUrl && <a className="content-history-source" href={historyDetail.record.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />打开博主或来源主页</a>}
          {(profile.displayName || profile.bio || profile.followerLabel) && <div className="content-history-profile"><small>PROFILE SNAPSHOT</small><strong>{profile.displayName || historyDetail.record?.name || '博主主页信息'}</strong><p>{[profile.handle, profile.followerLabel, profile.bio].filter(Boolean).join(' · ')}</p></div>}
          {analysisSummary && <div className="content-history-summary"><div><Sparkles size={13} /><small>智能总结</small></div><p>{analysisSummary}</p></div>}
          {historyDetail.record?.jobType?.startsWith('post_search') && historyDetail.record?.postSearch && <div className="content-history-summary"><div><Search size={13} /><small>直接采集任务</small></div><p>{historyDetail.record.jobType === 'post_search' ? `关键词采集 ${historyDetail.record.postSearch.postCount || 0} 条帖子` : historyDetail.record.jobType === 'post_search_comments' ? `热评采集 ${historyDetail.record.postSearch.commentCount || 0} 条` : `视频关键帧采集 ${historyDetail.record.postSearch.frameCount || 0} 张`}</p></div>}
          {directPosts.length > 0 && <div className="content-history-samples content-history-post-results"><div className="content-history-section-title"><strong>当次搜索结果</strong><small>历史快照 · {directPosts.length} 条帖子 · {directHotCommentCount} 条热评</small></div><div className="content-history-post-grid">{directPosts.map((post, index) => <div className="content-history-post-history-item" key={post.id || post.postId || index}><ContentHistoryPostCard post={post} onPreviewImage={setHistoryMediaPreview} /><ContentHistoryPostHotComments post={post} /></div>)}</div></div>}
          {directComments.length > 0 && <div className="content-history-comments"><div className="content-history-section-title"><strong>帖子热评</strong><small>已保存前 {directComments.length} 条</small></div>{directComments.map((comment, index) => <article key={comment.id || comment.commentId || index}><strong>{comment.authorName || comment.userName || '匿名用户'}</strong><p>{comment.text || comment.content || comment.body || '未返回评论内容'}</p><span>{comment.likeCount ?? comment.likes ?? comment.diggCount ?? 0} 赞</span></article>)}</div>}
          {directFrames.length > 0 && <div className="content-history-samples"><div className="content-history-section-title"><strong>视频关键帧</strong><small>{directFrames.length} 张已保存关键帧</small></div><div className="content-history-frame-grid">{directFrames.map((frame, index) => { const frameUrl = videoFrameUrl(frame, historyDetail.record?.channel || 'douyin'); return frameUrl ? <figure key={frame.artifactPath || frame.frameUrl || index}><img src={frameUrl} alt={`视频关键帧 ${index + 1}`} /><figcaption>{videoFrameTime(frame.timestamp ?? frame.time ?? frame.seconds) || `关键帧 ${index + 1}`}</figcaption></figure> : null; })}</div>{videoPlaybackUrl(directPost, directResult.video) && <video controls preload="metadata" src={videoPlaybackUrl(directPost, directResult.video)} />}</div>}
          {normalizedSamples.length > 0 && <div className="content-history-samples"><div className="content-history-section-title"><strong>内容样本</strong><small>{normalizedSamples.length} 条已保存样本</small></div>{normalizedSamples.map((sample, index) => {
            const rawSample = rawSamples[index] || {};
            const videoUrl = contentHistoryVideoUrl(rawSample);
            const imageUrl = sample.coverUrl ? postMediaImageUrl(historyDetail.record?.channel || 'douyin', sample.coverUrl) : '';
            return <article className="content-history-sample" key={sample.id || index}>
              {imageUrl && <img src={imageUrl} alt="内容封面" />}
              <div><small>{sample.contentType || sample.contentFormat || '公开内容'} · {sample.publishedAt || '时间未知'}</small><strong>{sample.title || '未返回标题'}</strong><p>{sample.summary || sample.detailText || '未返回正文摘要'}</p><div className="content-history-sample-facts">{sample.interactionFacts.slice(0, 5).map((fact) => <span key={fact}>{fact}</span>)}{sample.hasVideo && <span>视频内容</span>}</div>{videoUrl && <video controls preload="metadata" poster={imageUrl || undefined} src={videoUrl} />}</div>
            </article>;
          })}</div>}
          {!normalizedSamples.length && !analysisSummary && !directPosts.length && !directComments.length && !directFrames.length && !directSummary && <div className="content-history-state compact"><History size={17} />该记录暂未包含可展开的样本或总结。</div>}
          <details className="content-history-raw"><summary>查看完整历史快照 JSON</summary><pre>{JSON.stringify(historyDetail, null, 2)}</pre></details>
        </div>
      </section>
    </div>}
    {historyMediaPreview && <PostSearchMediaPreview preview={historyMediaPreview} onClose={() => setHistoryMediaPreview(null)} />}
  </section>;
}

function PostSearchWorkbench({ campaign, onCampaignUpdate, onClose, notify, contentModelPreference = 'configured', videoVisionPreference = 'configured' }) {
  const [query, setQuery] = useState('');
  const [searchLimit, setSearchLimit] = useState(String(DEFAULT_POST_SEARCH_LIMIT));
  const [continuationBatchLimit, setContinuationBatchLimit] = useState(String(DEFAULT_POST_SEARCH_CONTINUATION_BATCH));
  const [posts, setPosts] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [sentIds, setSentIds] = useState(() => new Set(
    (Array.isArray(campaign?.outreachMessages) ? campaign.outreachMessages : [])
      .filter((message) => message?.status === 'queued' || message?.status === 'sent')
      .map((message) => message.postId)
      .filter(Boolean),
  ));
  const [sendStates, setSendStates] = useState(() => Object.fromEntries(
    (Array.isArray(campaign?.outreachMessages) ? campaign.outreachMessages : [])
      .filter((message) => message?.status === 'queued' || message?.status === 'sent')
      .filter((message) => message.postId)
      .map((message) => [message.postId, { status: message.status, delivery: message.delivery || 'local_outbox' }]),
  ));
  const [loading, setLoading] = useState(false);
  const [continuationLoading, setContinuationLoading] = useState(false);
  const [continuationProgress, setContinuationProgress] = useState(null);
  const [sendingId, setSendingId] = useState('');
  const [batchSendLoading, setBatchSendLoading] = useState(false);
  const [followStates, setFollowStates] = useState({});
  const [batchFollowLoading, setBatchFollowLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const [meta, setMeta] = useState(null);
  const [mediaByPostId, setMediaByPostId] = useState({});
  const [commentsByPostId, setCommentsByPostId] = useState({});
  const [commentsBatchLoading, setCommentsBatchLoading] = useState(false);
  const [sendConfig, setSendConfig] = useState(null);
  const [selectedPostIds, setSelectedPostIds] = useState(() => new Set());
  const [selectedProfileKeys, setSelectedProfileKeys] = useState(() => new Set());
  const [profileAnalysis, setProfileAnalysis] = useState(null);
  const [mediaPreview, setMediaPreview] = useState(null);
  const [randomInterval, setRandomInterval] = useState({ enabled: false, minSeconds: '1', maxSeconds: '3' });

  const profileCandidates = useMemo(() => {
    const candidates = new Map();
    posts.forEach((post) => {
      if (!post?.authorProfile) return;
      const key = `${post.platform || 'douyin'}:${post.authorProfile}`;
      const current = candidates.get(key) || {
        key,
        id: key,
        channel: post.platform || 'douyin',
        name: post.authorName || '未命名博主',
        sourceUrl: post.authorProfile,
        avatar: post.avatar || '',
        postIds: [],
        postCount: 0,
      };
      if (!current.postIds.includes(post.id)) current.postIds.push(post.id);
      current.postCount = current.postIds.length;
      if (current.name === '未命名博主' && post.authorName) current.name = post.authorName;
      candidates.set(key, current);
    });
    return [...candidates.values()];
  }, [posts]);

  const selectedPosts = useMemo(
    () => posts.filter((post) => selectedPostIds.has(post.id)),
    [posts, selectedPostIds],
  );
  const visibleProfileCandidates = useMemo(() => {
    const selectedIds = new Set(selectedPosts.map((post) => post.id));
    return profileCandidates.filter((profile) => profile.postIds.some((postId) => selectedIds.has(postId)));
  }, [profileCandidates, selectedPosts]);
  const selectedProfiles = useMemo(
    () => visibleProfileCandidates.filter((profile) => selectedProfileKeys.has(profile.key)),
    [selectedProfileKeys, visibleProfileCandidates],
  );
  const profileByPostId = useMemo(
    () => new Map(profileCandidates.flatMap((profile) => profile.postIds.map((postId) => [postId, profile]))),
    [profileCandidates],
  );

  const collectionIntervalPayload = () => {
    const parseSeconds = (value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.min(600, Math.max(0, numeric)) : 0;
    };
    const minSeconds = parseSeconds(randomInterval.minSeconds);
    const maxSeconds = parseSeconds(randomInterval.maxSeconds);
    const lower = Math.min(minSeconds, maxSeconds);
    const upper = Math.max(minSeconds, maxSeconds);
    return {
      minSeconds: randomInterval.enabled ? lower : 0,
      maxSeconds: randomInterval.enabled ? upper : 0,
    };
  };

  const waitForRandomCollectionInterval = async () => {
    const interval = collectionIntervalPayload();
    const minMs = Math.round(interval.minSeconds * 1000);
    const maxMs = Math.round(interval.maxSeconds * 1000);
    if (!maxMs) return;
    const delay = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
    await new Promise((resolve) => setTimeout(resolve, delay));
  };

  useEffect(() => {
    let cancelled = false;
    fetch(apiPath('/api/post-search/send-config'))
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (!cancelled && payload) setSendConfig(payload);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const runSearch = async (event) => {
    event?.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      setError('请输入关键词后开始检索。');
      return;
    }
    const requestedLimit = parsePostSearchLimit(searchLimit);
    if (!requestedLimit) {
      setError(`搜索数量请输入 1-${POST_SEARCH_MAX_RESULTS} 之间的整数`);
      return;
    }
    setLoading(true);
    setError('');
    setContinuationProgress(null);
    setMediaByPostId({});
    setCommentsByPostId({});
    try {
      const response = await fetch(apiPath('/api/post-search'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: trimmed, limit: requestedLimit, randomInterval: collectionIntervalPayload() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || '帖子检索失败。');
      const nextPosts = Array.isArray(payload.posts) ? payload.posts : [];
      setPosts(nextPosts);
      setMeta(payload);
      setSearched(true);
      setSelectedPostIds(new Set());
      setSelectedProfileKeys(new Set());
      setProfileAnalysis(null);
      setCommentsByPostId(Object.fromEntries(nextPosts
        .filter((post) => Array.isArray(post.comments))
        .map((post) => [post.id, {
          status: 'succeeded',
          comments: post.comments.slice(0, 10),
          summary: { source: 'automatic_search_enrichment', limit: 10 },
        }] )));
      setDrafts((current) => Object.fromEntries(nextPosts.map((post) => [
        post.id,
        current[post.id] || defaultPostMessage(post),
      ])));
      notifyContentHistoryUpdated();
    } catch (searchError) {
      setError(searchError.message || '帖子检索失败。');
      setPosts([]);
      setMeta(null);
      setSearched(true);
      notifyContentHistoryUpdated();
    } finally {
      setLoading(false);
    }
  };

  const continueSearch = async () => {
    const jobId = meta?.jobId;
    if (!jobId || loading || continuationLoading) return;
    const additionalLimit = parsePostSearchLimit(continuationBatchLimit);
    if (!additionalLimit) {
      setError(`续爬数量请输入 1-${POST_SEARCH_MAX_RESULTS} 之间的整数`);
      return;
    }
    setContinuationLoading(true);
    setContinuationProgress({ phase: 'connecting', progress: 1 });
    setError('');
    try {
      const response = await fetch(apiPath(`/api/post-search/${encodeURIComponent(jobId)}/continue`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ additionalLimit, randomInterval: collectionIntervalPayload() }),
      });
      let payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || '续爬当前搜索任务失败');
      if (payload.accepted) {
        setContinuationProgress(payload.job?.collectionProgress || { phase: 'connecting', progress: 1 });
        const completedJob = await waitForPostSearchTask(jobId, async (runningJobId) => {
          const jobResponse = await fetch(apiPath(`/api/jobs/${encodeURIComponent(runningJobId)}`));
          const jobPayload = await jobResponse.json().catch(() => ({}));
          if (!jobResponse.ok) throw new Error(jobPayload.error?.message || '续爬任务状态读取失败');
          return jobPayload.job;
        }, (job) => {
          setContinuationProgress(job?.collectionProgress || {
            phase: job?.phase || job?.status || 'running',
            progress: job?.progress || 0,
          });
        });
        if (completedJob?.result && typeof completedJob.result === 'object') {
          payload = { ...completedJob.result, jobId, job: completedJob, added: completedJob.lastAdded || 0 };
        }
      }
      const nextPosts = Array.isArray(payload.posts) ? payload.posts : [];
      setPosts(nextPosts);
      setMeta((current) => ({ ...(current || {}), ...payload, jobId: payload.jobId || current?.jobId || jobId }));
      setCommentsByPostId((current) => Object.fromEntries(nextPosts
        .map((post) => {
          const automatic = Array.isArray(post.comments) ? post.comments.slice(0, 10) : [];
          const prior = current[post.id] || {};
          if (!automatic.length && !prior.comments?.length) return null;
          return [post.id, {
            ...prior,
            status: automatic.length || prior.status === 'succeeded' ? 'succeeded' : prior.status,
            comments: automatic.length ? automatic : prior.comments || [],
            summary: prior.summary || { source: 'automatic_search_enrichment', limit: 10 },
          }];
        })
        .filter(Boolean)));
      setDrafts((current) => Object.fromEntries(nextPosts.map((post) => [
        post.id,
        current[post.id] || defaultPostMessage(post),
      ])));
      setSearched(true);
      notifyContentHistoryUpdated();
      notify(payload.added > 0 ? `同一搜索任务已追加 ${payload.added} 条帖子` : '同一搜索任务已完成续爬，暂无新增帖子');
    } catch (continuationError) {
      setContinuationProgress((current) => ({ ...(current || {}), phase: 'failed', progress: 100 }));
      setError(continuationError.message || '续爬当前搜索任务失败');
    } finally {
      setContinuationLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const videoPosts = posts.filter((post) => post?.hasVideo || post?.contentType === 'video').slice(0, 4);
    if (!videoPosts.length) return () => { cancelled = true; };
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    videoPosts.forEach(async (post) => {
      if (Array.isArray(post.videoFrames) && post.videoFrames.length) {
        setMediaByPostId((current) => ({ ...current, [post.id]: { status: 'succeeded', frames: post.videoFrames, video: { frames: post.videoFrames } } }));
        return;
      }
      setMediaByPostId((current) => ({ ...current, [post.id]: { status: 'loading', frames: [], video: null } }));
      try {
        const response = await fetch(apiPath('/api/post-search/media'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: meta?.query || query.trim(), sourceUrl: meta?.sourceUrl || '', post }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.jobId) throw new Error(payload.error?.message || '视频关键帧任务创建失败。');
        for (let attempt = 0; attempt < 120; attempt += 1) {
          await wait(900);
          const jobResponse = await fetch(apiPath(`/api/jobs/${encodeURIComponent(payload.jobId)}`));
          const jobPayload = await jobResponse.json();
          const job = jobPayload.job;
          if (!job || !['succeeded', 'completed_empty', 'failed'].includes(job.status)) continue;
          const result = job.result || {};
          const frames = Array.isArray(result.video?.frames) ? result.video.frames : [];
          if (!cancelled) setMediaByPostId((current) => ({
            ...current,
            [post.id]: {
              status: job.status,
              frames,
              video: result.video || null,
              limitations: Array.isArray(result.limitations) ? result.limitations : [],
              error: job.error?.message || '',
            },
          }));
          notifyContentHistoryUpdated();
          return;
        }
        throw new Error('视频关键帧任务等待超时。');
      } catch (mediaError) {
        if (!cancelled) setMediaByPostId((current) => ({
          ...current,
          [post.id]: { status: 'failed', frames: [], error: mediaError.message || '视频关键帧读取失败。' },
        }));
      }
    });
    return () => { cancelled = true; };
  }, [posts]);

  const fetchPostComments = async (post, { silent = false } = {}) => {
    setCommentsByPostId((current) => ({
      ...current,
      [post.id]: { ...(current[post.id] || {}), status: 'loading', comments: current[post.id]?.comments || [] },
    }));
    try {
      const response = await fetch(apiPath('/api/post-search/comments'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: meta?.query || query.trim(),
          sourceUrl: meta?.sourceUrl || '',
          post,
          limit: 10,
          randomInterval: collectionIntervalPayload(),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || '热评读取失败。');
      setCommentsByPostId((current) => ({
        ...current,
        [post.id]: {
          status: 'succeeded',
          comments: Array.isArray(payload.comments) ? payload.comments.slice(0, 10) : [],
          summary: payload.summary || null,
          meta: payload,
        },
      }));
      notifyContentHistoryUpdated();
      return true;
    } catch (commentError) {
      setCommentsByPostId((current) => ({
        ...current,
        [post.id]: {
          status: 'failed',
          comments: current[post.id]?.comments || [],
          error: commentError.message || '热评读取失败。',
        },
      }));
      if (!silent) setError(commentError.message || '热评读取失败。');
      return false;
    }
  };

  const fetchAllPostComments = async () => {
    if (!posts.length || commentsBatchLoading) return;
    setCommentsBatchLoading(true);
    setError('');
    let completed = 0;
    for (const post of posts) {
      if (completed > 0) await waitForRandomCollectionInterval();
      await fetchPostComments(post, { silent: true });
      completed += 1;
    }
    setCommentsBatchLoading(false);
    notify(`已完成 ${completed} 个帖子热评读取`);
  };

  const sendMessage = async (post) => {
    const messageBody = String(drafts[post.id] || '').trim();
    if (!messageBody) {
      setError('请先填写站内信内容。');
      return;
    }
    setSendingId(post.id);
    setError('');
    try {
      const response = await fetch(apiPath(`/api/post-search/${encodeURIComponent(post.id)}/send`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          campaignId: campaign?.id || null,
          query: meta?.query || query.trim(),
          sourceUrl: meta?.sourceUrl || '',
          post,
          messageBody,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || '站内信发送失败。');
      setSentIds((current) => new Set([...current, post.id, post.postId]));
      setSendStates((current) => ({
        ...current,
        [post.id]: {
          status: payload.message?.status || 'queued',
          delivery: payload.message?.delivery || payload.delivery?.deliveryLabel || 'local_outbox',
        },
      }));
      if (payload.campaign?.campaign) onCampaignUpdate?.(payload.campaign.campaign);
      if (payload.message?.status === 'sent') {
        notify('消息已发送');
        return;
      }
      if (payload.campaign?.campaign) notify('站内信已加入当前项目发送队列。');
      else notify('站内信已加入发送队列。');
    } catch (sendError) {
      setError(sendError.message || '站内信发送失败。');
    } finally {
      setSendingId('');
    }
  };

  const sendMessageBatchItem = async (post) => {
    const messageBody = String(drafts[post.id] || '').trim();
    if (!messageBody) return { status: 'skipped' };
    try {
      const response = await fetch(apiPath(`/api/post-search/${encodeURIComponent(post.id)}/send`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          campaignId: campaign?.id || null,
          query: meta?.query || query.trim(),
          sourceUrl: meta?.sourceUrl || '',
          post,
          messageBody,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return { status: 'failed', error: payload.error?.message || '站内信发送失败' };
      setSentIds((current) => new Set([...current, post.id, post.postId]));
      setSendStates((current) => ({
        ...current,
        [post.id]: {
          status: payload.message?.status || 'queued',
          delivery: payload.message?.delivery || payload.delivery?.deliveryLabel || 'local_outbox',
        },
      }));
      if (payload.campaign?.campaign) onCampaignUpdate?.(payload.campaign.campaign);
      return { status: 'sent' };
    } catch (sendError) {
      return { status: 'failed', error: sendError.message || '站内信发送失败' };
    }
  };

  const sendSelectedMessages = async () => {
    if (!selectedPosts.length || batchSendLoading) return;
    setBatchSendLoading(true);
    setError('');
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const post of selectedPosts) {
      if (sent + skipped + failed > 0) await waitForRandomCollectionInterval();
      if (sentIds.has(post.id) || sentIds.has(post.postId)) {
        skipped += 1;
        continue;
      }
      const result = await sendMessageBatchItem(post);
      if (result.status === 'sent') sent += 1;
      else if (result.status === 'skipped') skipped += 1;
      else failed += 1;
    }
    setBatchSendLoading(false);
    notify(`批量发送完成：${sent} 成功，${skipped} 跳过，${failed} 失败`);
  };

  const followProfile = async (profile, { silent = false } = {}) => {
    setFollowStates((current) => ({ ...current, [profile.key]: { status: 'sending' } }));
    try {
      const response = await fetch(apiPath('/api/post-search/follow'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          campaignId: campaign?.id || null,
          query: meta?.query || query.trim(),
          profile: {
            channel: profile.channel,
            name: profile.name,
            sourceUrl: profile.sourceUrl,
            avatar: profile.avatar,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || '关注博主失败');
      const status = payload.follow?.status || 'followed';
      setFollowStates((current) => ({
        ...current,
        [profile.key]: { status, follow: payload.follow || null },
      }));
      return status;
    } catch (followError) {
      const message = followError.message || '关注博主失败';
      setFollowStates((current) => ({ ...current, [profile.key]: { status: 'failed', error: message } }));
      if (!silent) setError(message);
      return 'failed';
    }
  };

  const followSelectedProfiles = async () => {
    if (!selectedProfiles.length || batchFollowLoading) return;
    setBatchFollowLoading(true);
    setError('');
    let followed = 0;
    let alreadyFollowing = 0;
    let failed = 0;
    for (const profile of selectedProfiles) {
      if (followed + alreadyFollowing + failed > 0) await waitForRandomCollectionInterval();
      const status = await followProfile(profile, { silent: true });
      if (status === 'followed') followed += 1;
      else if (status === 'already_following') alreadyFollowing += 1;
      else failed += 1;
    }
    setBatchFollowLoading(false);
    notify(`批量关注完成：${followed} 新增，${alreadyFollowing} 已关注，${failed} 失败`);
  };

  const togglePostSelection = (postId) => {
    setSelectedPostIds((current) => {
      const next = new Set(current);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  };

  const toggleProfileSelection = (profileKey) => {
    setSelectedProfileKeys((current) => {
      const next = new Set(current);
      if (next.has(profileKey)) next.delete(profileKey);
      else next.add(profileKey);
      return next;
    });
  };

  const waitForPostSearchJob = async (jobId, readJob) => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const job = await readJob(jobId);
      if (job && terminalStatuses.has(job.status)) return job;
      await wait(900);
    }
    throw new Error('批量博主分析任务等待超时，请在任务中心查看进度');
  };

  const startProfileAnalysis = async () => {
    if (!selectedProfiles.length) {
      setError('请先选择帖子，再选择至少一个对应博主主页');
      return;
    }
    const profilePayload = selectedProfiles.map((profile) => ({
      channel: profile.channel,
      name: profile.name,
      sourceUrl: profile.sourceUrl,
      avatar: profile.avatar,
      postIds: profile.postIds,
    }));
    setError('');
    setProfileAnalysis({
      status: 'collecting',
      profiles: selectedProfiles,
      contentJob: null,
      analysisJob: null,
      captures: [],
      analyses: [],
      error: '',
    });
    try {
      const createResponse = await fetch(apiPath('/api/post-search/profile-analysis'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          campaignId: campaign?.id || null,
          query: meta?.query || query.trim(),
          profiles: profilePayload,
          contentLimit: parsePostSearchLimit(searchLimit) || DEFAULT_POST_SEARCH_LIMIT,
          randomInterval: collectionIntervalPayload(),
          contentModelPreference,
          videoVisionPreference,
        }),
      });
      const createPayload = await createResponse.json().catch(() => ({}));
      if (!createResponse.ok || !createPayload.job?.id) {
        throw new Error(createPayload.error?.message || '博主主页分析任务创建失败');
      }
      const profileTargets = Array.isArray(createPayload.profiles) && createPayload.profiles.length
        ? createPayload.profiles
        : selectedProfiles;
      setProfileAnalysis((current) => ({
        ...current,
        status: 'collecting',
        profiles: profileTargets,
        contentJob: createPayload.job,
        contentJobId: createPayload.job.id,
      }));

      const contentJob = await waitForPostSearchJob(createPayload.job.id, async (jobId) => {
        const response = await fetch(apiPath(`/api/jobs/${encodeURIComponent(jobId)}`));
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error?.message || '博主内容任务读取失败');
        return payload.job;
      });
      const contentResponse = await fetch(apiPath(`/api/jobs/${encodeURIComponent(contentJob.id)}/content`));
      const contentPayload = await contentResponse.json().catch(() => ({}));
      if (!contentResponse.ok) throw new Error(contentPayload.error?.message || '博主公开内容读取失败');
      const captureMap = contentMapFromJob({
        ...(contentPayload.job || {}),
        results: Array.isArray(contentPayload.content) ? contentPayload.content : [],
        contentCaptures: Array.isArray(contentPayload.content) ? contentPayload.content : [],
      });
      const captures = Object.values(captureMap);
      const creatorIds = profileTargets
        .map((profile) => profile.targetId || profile.id)
        .filter((targetId) => targetId && captureMap[targetId]);
      setProfileAnalysis((current) => ({ ...current, contentJob, captures }));
      if (!creatorIds.length) {
        const collectionError = contentJob.error?.message || '所选博主暂未返回可分析的公开内容';
        setProfileAnalysis((current) => ({
          ...current,
          status: contentJob.status === 'failed' ? 'failed' : 'completed_empty',
          contentJob,
          captures,
          error: collectionError,
        }));
        notify('博主主页分析未获得可用公开内容');
        return;
      }

      const analysisResponse = await fetch(apiPath('/api/content-analysis'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          campaignId: campaign?.id || null,
          contentJobId: contentJob.id,
          creatorIds,
          contentModelPreference,
          videoVisionPreference,
        }),
      });
      const analysisPayload = await analysisResponse.json().catch(() => ({}));
      if (!analysisResponse.ok || !analysisPayload.job?.id) {
        throw new Error(analysisPayload.error?.message || '博主主页内容分析任务创建失败');
      }
      const readAnalysisJob = async (jobId) => {
        const response = await fetch(apiPath(`/api/jobs/${encodeURIComponent(jobId)}/content-analysis`));
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error?.message || '博主主页分析结果读取失败');
        return {
          ...(payload.job || {}),
          results: Array.isArray(payload.analyses) ? payload.analyses : [],
        };
      };
      setProfileAnalysis((current) => ({
        ...current,
        status: 'analyzing',
        contentJob,
        analysisJob: analysisPayload.job,
        analysisJobId: analysisPayload.job.id,
        captures,
      }));
      const analysisJob = await waitForPostSearchJob(analysisPayload.job.id, readAnalysisJob);
      const analysisResults = Array.isArray(analysisJob.results) ? analysisJob.results : [];
      setProfileAnalysis((current) => ({
        ...current,
        status: analysisJob.status === 'failed' ? 'failed' : analysisJob.status,
        contentJob,
        analysisJob,
        analyses: analysisResults,
        captures,
        error: analysisJob.error?.message || '',
      }));
      notify(`已完成 ${analysisResults.length} 个博主主页的内容分析`);
    } catch (analysisError) {
      const message = analysisError.message || '博主主页分析失败';
      setError(message);
      setProfileAnalysis((current) => ({
        ...(current || { profiles: selectedProfiles, captures: [], analyses: [] }),
        status: 'failed',
        error: message,
      }));
    }
  };

  const analysisByTargetId = useMemo(
    () => new Map((Array.isArray(profileAnalysis?.analyses) ? profileAnalysis.analyses : [])
      .map((record) => [record.targetId || record.creatorId || record.id, record])),
    [profileAnalysis],
  );
  const profileAnalysisStatusLabel = profileAnalysis?.status === 'collecting'
    ? '正在抓取博主内容'
    : profileAnalysis?.status === 'analyzing'
      ? '正在分析选中主页'
      : ['succeeded', 'partial_success'].includes(profileAnalysis?.status)
        ? '分析完成'
        : profileAnalysis?.status === 'completed_empty'
          ? '暂无可分析内容'
          : profileAnalysis?.status === 'failed'
            ? '任务失败'
            : '等待执行';

  startProfileAnalysis.batchActions = {
    batchSendLoading,
    batchFollowLoading,
    sendSelectedMessages,
    followSelectedProfiles,
    followStates,
  };

  return <section className="post-search-workbench">
    <div className="post-search-heading">
      <div><p>CONTENT SEARCH / DIRECT MESSAGE</p><h1>帖子检索与站内信</h1><span>按关键词获取公开帖子，并在同一张卡片上查看互动数据与发送消息。</span></div>
      <button type="button" className="icon-btn" onClick={onClose} title="返回工作流" aria-label="返回工作流"><X size={17} /></button>
    </div>
    <form className="post-search-form" onSubmit={runSearch}>
      <label className="post-search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入产品、话题或内容关键词" aria-label="帖子搜索关键词" /><button type="button" onClick={() => { setQuery(''); setError(''); }} aria-label="清空关键词"><X size={14} /></button></label>
      <button type="submit" className="post-search-button" disabled={loading}><Search size={15} />{loading ? '检索中' : '开始检索'}</button>
     </form>
     <div className="post-search-count-controls">
       <label><span>本次搜索目标</span><input type="number" min="1" max={POST_SEARCH_MAX_RESULTS} step="1" value={searchLimit} onChange={(event) => setSearchLimit(event.target.value)} aria-label="本次搜索目标数量" /><em>条</em></label>
       <div className="post-search-continuation-setting"><label><span>续爬每批追加</span><input type="number" min="1" max={POST_SEARCH_MAX_RESULTS} step="1" value={continuationBatchLimit} onChange={(event) => setContinuationBatchLimit(event.target.value)} aria-label="续爬每批追加数量" /><em>条</em></label><PostSearchLimitPresets value={continuationBatchLimit} onChange={setContinuationBatchLimit} ariaLabel="续爬每批追加数量快捷值" /></div>
       <small>{meta ? `当前已保存 ${posts.length} 条，目标 ${meta.requestedTotal || searchLimit} 条；本批目标 ${meta.requestedBatchLimit ?? meta.collectionMeta?.requested_batch_limit ?? continuationBatchLimit} 条；本批重复 ${meta.lastBatchDuplicates ?? meta.collectionMeta?.last_batch_duplicates ?? 0} 条，累计重复 ${meta.cumulativeDuplicates ?? meta.collectionMeta?.cumulative_duplicates ?? 0} 条` : `可输入 1-${POST_SEARCH_MAX_RESULTS} 条；续爬每批追加数量可自由设置，沿用同一搜索任务`}</small>
     </div>
     <div className="post-search-pacing">
       <label className="post-search-pacing-toggle">
         <input type="checkbox" checked={randomInterval.enabled} onChange={(event) => setRandomInterval((current) => ({ ...current, enabled: event.target.checked }))} />
         <span><strong>随机间隔采集</strong><small>搜索、热评和主页内容请求之间随机等待</small></span>
       </label>
       <div className="post-search-pacing-fields">
         <label><span>最短</span><input type="number" min="0" max="600" step="0.5" value={randomInterval.minSeconds} onChange={(event) => setRandomInterval((current) => ({ ...current, minSeconds: event.target.value }))} disabled={!randomInterval.enabled} /><em>秒</em></label>
         <span className="post-search-pacing-separator">至</span>
         <label><span>最长</span><input type="number" min="0" max="600" step="0.5" value={randomInterval.maxSeconds} onChange={(event) => setRandomInterval((current) => ({ ...current, maxSeconds: event.target.value }))} disabled={!randomInterval.enabled} /><em>秒</em></label>
       </div>
       <small className="post-search-pacing-status">{randomInterval.enabled ? `每次采集随机等待 ${collectionIntervalPayload().minSeconds} - ${collectionIntervalPayload().maxSeconds} 秒` : '当前关闭，保持连续采集'}</small>
     </div>
     {meta && posts.length > 0 && <PostSearchSelectionPanel posts={posts} selectedPosts={selectedPosts} setSelectedPostIds={setSelectedPostIds} selectedProfileKeys={setSelectedProfileKeys} setSelectedProfileKeys={setSelectedProfileKeys} selectedProfiles={selectedProfiles} visibleProfileCandidates={visibleProfileCandidates} profileAnalysis={profileAnalysis} analysisByTargetId={analysisByTargetId} profileAnalysisStatusLabel={profileAnalysisStatusLabel} toggleProfileSelection={toggleProfileSelection} startProfileAnalysis={startProfileAnalysis} />}
    {sendConfig && <div className="post-search-delivery"><Send size={13} /><span>消息通道</span><strong>{sendConfig.configured ? (sendConfig.deliveryLabel === 'browser_relay' ? '浏览器 Relay' : '接口发送') : '本地队列'}</strong><small>{sendConfig.configured ? sendConfig.deliveryLabel : '待配置服务端接口'}</small></div>}
    {error && <div className="post-search-error"><AlertCircle size={15} />{error}</div>}
    {meta?.jobId && <div className="post-search-continuation"><div><RefreshCw size={14} /><span><strong>同一搜索任务</strong><small>已保存 {posts.length} 条当次结果，本次将追加 {continuationBatchLimit || '自定义'} 条并跳过已采集帖子</small></span></div><button type="button" onClick={() => void continueSearch()} disabled={loading || continuationLoading}>{continuationLoading ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}{continuationLoading ? '续爬中' : '继续采集更多帖子'}</button></div>}
    {meta?.jobId && continuationProgress && <PostSearchLiveProgress progress={continuationProgress} />}
    {meta && <div className="post-search-summary"><div><small>帖子数量</small><strong>{posts.length}</strong><span>当前结果</span></div><div><small>数据来源</small><strong>{postSourceLabel(meta.source)}</strong><span>{meta.collectionMeta?.stop_reason || '已完成请求'}</span></div><div><small>搜索关键词</small><strong>{meta.query}</strong><span>{formatPostDate(meta.fetchedAt)}</span></div><div><small>发送状态</small><strong>{sentIds.size}</strong><span>已加入队列</span></div></div>}
    {meta && posts.length > 0 && <div className="post-search-comment-actions"><div><MessageSquareText size={14} /><span><strong>帖子热评</strong><small>每帖最多读取 10 条公开热评</small></span></div><button type="button" onClick={() => void fetchAllPostComments()} disabled={commentsBatchLoading}><MessageSquareText size={13} />{commentsBatchLoading ? '批量读取中' : '抓取全部前 10 条热评'}</button></div>}
    {loading && <div className="post-search-state"><LoaderCircle className="spin" size={19} />正在读取公开帖子...</div>}
    {!loading && searched && !posts.length && <div className="post-search-state"><Search size={19} />没有找到可展示的帖子，请调整关键词或检查连接器状态。</div>}
    {!loading && posts.length > 0 && <div className="post-search-grid">{posts.map((post) => {
      const delivered = sentIds.has(post.id) || sentIds.has(post.postId);
       const sendState = sendStates[post.id] || sendStates[post.postId] || null;
       const draft = drafts[post.id] || defaultPostMessage(post);
       const selected = selectedPostIds.has(post.id);
       return <article className={`post-search-card ${selected ? 'selected' : ''}`} key={post.id}>
         <PostSearchMedia post={post} mediaState={mediaByPostId[post.id]} onPreviewImage={setMediaPreview} />
         <div className="post-search-card-body">
           <label className="post-search-card-select"><input type="checkbox" checked={selected} onChange={() => togglePostSelection(post.id)} /><span>选择帖子</span><small>{selected ? '已选' : '可加入批量分析'}</small></label>
          <div className="post-recipient-banner"><Users size={12} /><span>收件人：{post.authorName || '当前博主'}</span><small>{sendConfig?.configured ? (sendConfig.deliveryLabel === 'browser_relay' ? '浏览器 Relay' : '接口发送') : '本地队列'}</small></div>
          <div className="post-search-author"><span className="post-author-mark">{(post.authorName || '未').slice(0, 1)}</span><div><strong>{post.authorName}</strong><small>{post.publishedAt ? formatPostDate(post.publishedAt) : post.publishedAtText || '公开内容'}</small></div>{post.contentUrl && <a href={post.contentUrl} target="_blank" rel="noreferrer" title="打开帖子"><ExternalLink size={14} /></a>}</div>
           {post.authorProfile && <a className="post-profile-link" href={post.authorProfile} target="_blank" rel="noreferrer"><Users size={12} />打开博主主页</a>}
           <PostSearchProfileSummary post={post} profile={profileByPostId.get(post.id)} />
           <h2>{post.title}</h2>
          <p className="post-search-body">{post.body || '暂无正文摘要'}</p>
          {post.tags.length > 0 && <div className="post-search-tags">{post.tags.slice(0, 6).map((tag) => <span key={tag}>#{tag.replace(/^#/, '')}</span>)}</div>}
          <div className="post-search-metrics">{postMetricItems(post).map((metric) => <span key={metric.label}><small>{metric.label}</small><strong>{metric.value}</strong></span>)}</div>
          <PostSearchComments post={post} state={commentsByPostId[post.id]} onFetch={() => void fetchPostComments(post)} />
          <div className="post-message-box"><label htmlFor={`message-${post.id}`}>站内信内容</label><textarea id={`message-${post.id}`} value={draft} onChange={(event) => setDrafts((current) => ({ ...current, [post.id]: event.target.value }))} disabled={delivered} /></div>
          <button type="button" className={`post-send-button ${delivered ? 'sent' : ''}`} onClick={() => void sendMessage(post)} disabled={delivered || sendingId === post.id}><Send size={14} />{delivered ? '已加入发送队列' : sendingId === post.id ? '提交中' : '一键发送站内信'}</button>
        </div>
        {sendState && <div className={`post-send-status ${sendState.status}`}><CheckCircle2 size={12} /><span>{sendState.status === 'sent' ? '消息已发送' : '消息已进入本地发送队列'}</span><small>{sendState.delivery}</small></div>}
      </article>;
    })}</div>}
    {mediaPreview && <PostSearchMediaPreview preview={mediaPreview} onClose={() => setMediaPreview(null)} />}
  </section>;
}

function PostSearchSelectionPanel({ posts, selectedPosts, setSelectedPostIds, selectedProfileKeys, setSelectedProfileKeys, selectedProfiles, visibleProfileCandidates, profileAnalysis, analysisByTargetId, profileAnalysisStatusLabel, toggleProfileSelection, startProfileAnalysis }) {
  const batchActions = startProfileAnalysis?.batchActions || {};
  if (!posts.length) return null;
  return <section className="post-search-selection" aria-label="批量选择与博主主页分析">
    <div className="post-search-selection-toolbar">
      <div><Users size={14} /><span><strong>批量选择与博主分析</strong><small>先多选帖子，再从对应博主主页中选择分析对象</small></span></div>
      <div className="post-search-selection-counts"><b>{selectedPosts.length} / {posts.length}</b><span>帖子已选</span><b>{selectedProfiles.length} / {visibleProfileCandidates.length}</b><span>博主已选</span></div>
      <div className="post-search-selection-actions">
        <button type="button" onClick={() => setSelectedPostIds(new Set(posts.map((post) => post.id)))}><Check size={12} />全选帖子</button>
        <button type="button" onClick={() => { setSelectedPostIds(new Set()); setSelectedProfileKeys(new Set()); }} >清空帖子</button>
        <button type="button" onClick={() => setSelectedProfileKeys(new Set(visibleProfileCandidates.map((profile) => profile.key)))} disabled={!visibleProfileCandidates.length}>全选博主</button>
        <button type="button" className="primary" onClick={() => void startProfileAnalysis()} disabled={!selectedProfiles.length || profileAnalysis?.status === 'collecting' || profileAnalysis?.status === 'analyzing'}>{profileAnalysis?.status === 'collecting' || profileAnalysis?.status === 'analyzing' ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}批量分析主页</button>
      </div>
    </div>
    <div className="post-search-batch-actions">
      <span><strong>批量执行</strong><small>按当前勾选的帖子和对应博主逐条执行</small></span>
      <div>
        <button type="button" onClick={() => void batchActions.sendSelectedMessages?.()} disabled={!selectedPosts.length || batchActions.batchSendLoading || batchActions.batchFollowLoading}>
          {batchActions.batchSendLoading ? <LoaderCircle className="spin" size={13} /> : <Send size={13} />}
          {batchActions.batchSendLoading ? '发送中' : '批量发送站内信'}
        </button>
        <button type="button" onClick={() => void batchActions.followSelectedProfiles?.()} disabled={!selectedProfiles.length || batchActions.batchSendLoading || batchActions.batchFollowLoading}>
          {batchActions.batchFollowLoading ? <LoaderCircle className="spin" size={13} /> : <Users size={13} />}
          {batchActions.batchFollowLoading ? '关注中' : '批量点关注'}
        </button>
      </div>
    </div>
    {selectedPosts.length > 0 && <div className="post-search-profile-picker">
      <div className="post-search-profile-picker-head"><div><Users size={13} /><strong>对应博主主页</strong><small>只显示所选帖子关联的去重主页</small></div><span>{visibleProfileCandidates.length} 个主页</span></div>
      {visibleProfileCandidates.length > 0
        ? <div className="post-search-profile-options">{visibleProfileCandidates.map((profile) => <label className={`post-search-profile-option ${selectedProfileKeys.has(profile.key) ? 'selected' : ''}`} key={profile.key}>
          <input type="checkbox" checked={selectedProfileKeys.has(profile.key)} onChange={() => toggleProfileSelection(profile.key)} />
          <span className="post-search-profile-avatar">{(profile.name || '博').slice(0, 1)}</span>
          <span className="post-search-profile-info"><strong>{profile.name}</strong><small>{profile.channel} · {profile.postCount} 条关联帖子</small></span>
          <a href={profile.sourceUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} title="打开博主主页"><ExternalLink size={13} /></a>
        </label>)}</div>
        : <div className="post-search-profile-empty">选中的帖子没有返回可用博主主页链接</div>}
    </div>}
    {profileAnalysis && <section className="post-search-analysis-panel">
      <div className="post-search-analysis-head"><div><Sparkles size={14} /><span><strong>博主主页分析结果</strong><small>{profileAnalysisStatusLabel} · {profileAnalysis.profiles?.length || 0} 个主页</small></span></div><b className={profileAnalysis.status}>{profileAnalysisStatusLabel}</b></div>
      {profileAnalysis.error && <div className="post-search-analysis-error"><AlertCircle size={13} />{profileAnalysis.error}</div>}
      <div className="post-search-analysis-list">{(profileAnalysis.profiles || []).map((profile) => {
        const targetId = profile.targetId || profile.id;
        const record = analysisByTargetId.get(targetId);
        const analysis = record?.analysis || record;
        const capture = (profileAnalysis.captures || []).find((item) => item.targetId === targetId);
        const summary = creatorOverviewRecommendation(analysis);
        const findings = (Array.isArray(analysis?.roles) ? analysis.roles : []).flatMap((role) => Array.isArray(role?.findings) ? role.findings : []).map((finding) => finding?.statement).filter(Boolean).slice(0, 2);
        return <article className="post-search-analysis-item" key={targetId}>
          <div className="post-search-analysis-item-head"><span className="post-search-profile-avatar">{(profile.name || '博').slice(0, 1)}</span><div><strong>{profile.name}</strong><small>{profile.channel} · {contentCaptureSampleCount(capture)} 条公开内容样本</small></div><a href={profile.sourceUrl} target="_blank" rel="noreferrer" title="打开博主主页"><ExternalLink size={12} /></a></div>
          {summary ? <p>{summary}</p> : <p className="muted">{record ? '分析任务已返回，暂未生成可展示的摘要' : profileAnalysis.status === 'collecting' || profileAnalysis.status === 'analyzing' ? '等待该博主的采集与分析结果' : '该博主暂未返回分析记录'}</p>}
          {findings.length > 0 && <ul>{findings.map((finding, index) => <li key={`${targetId}-finding-${index}`}>{finding}</li>)}</ul>}
        </article>;
      })}</div>
    </section>}
  </section>;
}

function postMediaImageUrl(platform, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\/api\//i.test(raw)) return apiPath(raw);
  if (!/^https?:\/\//i.test(raw)) return '';
  return apiPath(`/api/post-search/media/stream?kind=image&platform=${encodeURIComponent(platform || 'douyin')}&url=${encodeURIComponent(raw)}`);
}

function postImageUrls(post) {
  return [...new Set([
    ...(Array.isArray(post?.imageUrls) ? post.imageUrls : []),
    post?.coverUrl,
  ].map((value) => postMediaImageUrl(post?.platform || 'douyin', value)).filter(Boolean))].slice(0, 4);
}

function videoFrameUrl(frame, platform) {
  return postMediaImageUrl(platform || 'douyin', frame?.frameUrl || frame?.url || frame?.imageUrl || '');
}

function videoFrameTime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

function videoPlaybackUrl(post, video) {
  const candidates = [
    video?.playbackUrl,
    video?.videoUrl,
    video?.mediaUrl,
    post?.playbackUrl,
    post?.videoUrl,
  ];
  const localArtifact = candidates.find((value) => /^\/api\/jobs\//i.test(String(value || '')));
  if (localArtifact) return apiPath(String(localArtifact));
  const remoteUrl = candidates.find((value) => /^https?:\/\//i.test(String(value || '')));
  return remoteUrl
    ? apiPath(`/api/post-search/media/stream?platform=${encodeURIComponent(post?.platform || 'douyin')}&url=${encodeURIComponent(String(remoteUrl))}`)
    : '';
}

function PostSearchProfileSummary({ post, profile }) {
  const linkedPostCount = profile?.postCount || 1;
  const metrics = postMetricItems(post).slice(0, 2);
  return <div className="post-search-profile-summary">
    <div className="post-search-profile-summary-main">
      <Users size={12} />
      <div><small>博主个人主页</small><strong>{post.authorName || '未识别账号'}</strong><span>{profile?.channel || post.platform || 'douyin'} · 已关联 {linkedPostCount} 条帖子</span></div>
    </div>
    <div className="post-search-profile-summary-data">{metrics.map((metric) => <span key={metric.label}>{metric.label} <b>{metric.value}</b></span>)}</div>
    {post.authorProfile && <a className="post-profile-link" href={post.authorProfile} target="_blank" rel="noreferrer"><ExternalLink size={11} />原始主页</a>}
  </div>;
}

function PostSearchMedia({ post, mediaState, onPreviewImage }) {
  const images = postImageUrls(post);
  const video = mediaState?.video;
  const playbackUrl = videoPlaybackUrl(post, video);
  const frames = Array.isArray(mediaState?.frames) && mediaState.frames.length
    ? mediaState.frames
    : Array.isArray(post?.videoFrames) ? post.videoFrames : [];
  const transcript = video?.transcript?.text || video?.transcript?.transcript || '';
  const visionSummary = video?.vision?.summary || video?.vision?.caption || '';
  const smartSummary = video?.summary?.summary || visionSummary || '';
  const limitations = [...new Set([
    ...(Array.isArray(video?.limitations) ? video.limitations : []),
    ...(Array.isArray(mediaState?.limitations) ? mediaState.limitations : []),
  ].filter(Boolean))].slice(0, 4);
  const mediaStatus = mediaState?.status || (post?.hasVideo ? 'queued' : 'ready');
  const statusLabel = mediaStatus === 'loading' || mediaStatus === 'queued'
    ? '正在读取'
    : mediaStatus === 'failed' ? '暂不可用' : frames.length ? `${frames.length} 张` : '待返回';
  return <div className="post-search-media">
    <div className={`post-search-image-grid image-count-${Math.min(images.length, 4)}`} onClick={(event) => { const image = event.target.closest('img'); if (image) onPreviewImage?.({ url: image.currentSrc || image.src, title: image.alt || post.title || '帖子图片', kind: 'image' }); }}>
      {images.length > 0
        ? images.map((url, index) => <img key={`${url}-${index}`} src={url} alt={`${post.title || '帖子'} 图片 ${index + 1}`} loading="lazy" />)
        : <div className="post-search-image-empty"><DatabaseZap size={21} /><span>{post?.hasVideo ? '视频封面待返回' : '暂无图片'}</span></div>}
      <span className="post-search-media-badge">{post?.hasVideo ? '视频' : images.length ? `${images.length} 张图文` : '图文'}</span>
    </div>
    {post?.hasVideo && <div className="post-search-keyframes">
      <div className="post-search-keyframes-head"><span><Play size={12} />视频关键帧</span><small>{statusLabel}</small></div>
      {playbackUrl && <div className="post-search-video-player"><div className="post-search-video-player-head"><span><Play size={12} />视频原地播放</span><small>不离开当前页面</small></div><video controls playsInline preload="metadata" poster={images[0] || undefined} src={playbackUrl} /></div>}
      {frames.length > 0
        ? <div className="post-search-keyframe-grid" onClick={(event) => { const image = event.target.closest('img'); if (image) onPreviewImage?.({ url: image.currentSrc || image.src, title: image.alt || '视频关键帧', kind: 'keyframe' }); }}>{frames.map((frame, index) => {
          const frameUrl = videoFrameUrl(frame, post?.platform);
          const timestamp = videoFrameTime(frame?.timeSeconds);
          return <figure className="post-search-keyframe" key={frame?.index ?? `frame-${index}`}>
            {frameUrl ? <img src={frameUrl} alt={`视频关键帧 ${frame?.index ?? index + 1}`} loading="lazy" /> : <div className="post-search-keyframe-missing">关键帧图片待返回</div>}
            <figcaption><span>帧 {frame?.index ?? index + 1}{timestamp ? ` · ${timestamp}` : ''}</span><b className={frameUrl ? 'ready' : ''}>{frameUrl ? '已返回' : '待处理'}</b></figcaption>
            {frame?.ocrText && <p>{frame.ocrText}</p>}
            {frame?.semanticText && <p className="post-search-keyframe-semantic">画面语义：{frame.semanticText}</p>}
          </figure>;
        })}</div>
        : <div className="post-search-keyframe-state">{mediaStatus === 'loading' || mediaStatus === 'queued' ? <><LoaderCircle className="spin" size={13} />正在提取视频关键帧...</> : mediaStatus === 'failed' ? (mediaState?.error || '关键帧暂不可用。') : '视频关键帧尚未返回。'}</div>}
    </div>}
    {post?.hasVideo && video && <div className="post-search-video-analysis">
      <div className="post-search-video-analysis-head"><Sparkles size={12} /><strong>{'\u89c6\u9891\u5206\u6790'}</strong><small>{video.availability?.status || video.status || 'ready'}</small></div>
      {smartSummary && <p><b>{'\u667a\u80fd\u603b\u7ed3'}</b>{smartSummary}</p>}
      {transcript && <p><b>{'\u8bed\u97f3\u8f6c\u5199'}</b>{transcript}</p>}
      {!smartSummary && !transcript && <p className="post-search-video-analysis-muted">{video.vision?.status === 'not_configured' ? '\u89c6\u89c9\u5206\u6790\u6a21\u578b\u5c1a\u672a\u914d\u7f6e' : '\u5206\u6790\u7ed3\u679c\u5c1a\u672a\u8fd4\u56de'}</p>}
      {limitations.length > 0 && <ul>{limitations.map((item) => <li key={item}>{item}</li>)}</ul>}
    </div>}
  </div>;
}

function PostSearchMediaPreview({ preview, onClose }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return <div className="post-search-preview-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="post-search-preview-dialog" role="dialog" aria-modal="true" aria-label={preview.title || '媒体预览'}>
      <div className="post-search-preview-head"><div><small>{preview.kind === 'keyframe' ? 'VIDEO KEYFRAME' : 'IMAGE PREVIEW'}</small><strong>{preview.title || '媒体预览'}</strong></div><button type="button" className="icon-btn" onClick={onClose} aria-label="关闭预览"><X size={17} /></button></div>
      <div className="post-search-preview-content"><img src={preview.url} alt={preview.title || '媒体预览'} /></div>
    </div>
  </div>;
}

function formatCommentMetric(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return number.toLocaleString('zh-CN');
}

function PostSearchComments({ post, state, onFetch }) {
  const comments = Array.isArray(state?.comments) ? state.comments.slice(0, 10) : [];
  const summary = state?.summary || state?.meta?.summary || null;
  const loaded = state?.status === 'succeeded';
  return <section className="post-comments-panel">
    <div className="post-comments-head">
      <div><MessageSquareText size={13} /><strong>前 10 条热评</strong><small>{loaded ? `${comments.length} 条` : '按热度读取'}</small></div>
      <button type="button" className="post-comments-fetch" onClick={onFetch} disabled={state?.status === 'loading'} title={`读取 ${post.authorName || '该帖'} 的前 10 条热评`}>
        {state?.status === 'loading' ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />}
        {state?.status === 'loading' ? '读取中' : loaded ? '重新抓取' : '抓取热评'}
      </button>
    </div>
    {!state && <div className="post-comments-empty">点击抓取后显示该帖公开热评。</div>}
    {state?.status === 'loading' && <div className="post-comments-state"><LoaderCircle className="spin" size={13} />正在读取帖子详情和热评...</div>}
    {state?.status === 'failed' && <div className="post-comments-state failed"><AlertCircle size={13} />{state.error || '热评暂不可用。'}</div>}
    {loaded && comments.length === 0 && <div className="post-comments-empty">当前详情页没有读取到可展示的公开热评。</div>}
    {loaded && summary && <div className="post-comment-summary">
      <div className="post-comment-summary-head"><div><Sparkles size={12} /><span><strong>{'\u667a\u80fd\u603b\u7ed3'}</strong><small>{summary.sourceCommentCount || 0} {'\u6761\u70ed\u8bc4'} · {'\u7f6e\u4fe1\u5ea6'} {Math.round((summary.confidence || 0) * 100)}%</small></span></div><b>{summary.sentiment?.label || '\u5f85\u5224\u65ad'}</b></div>
      <p className="post-comment-summary-statement">{summary.statement}</p>
      {Array.isArray(summary.topics) && summary.topics.length > 0 && <div className="post-comment-topics">{summary.topics.map((topic) => <span key={topic.id}>{topic.label} <b>{topic.count}</b></span>)}</div>}
      {Array.isArray(summary.questions) && summary.questions.length > 0 && <div className="post-comment-summary-block"><small>{'\u9ad8\u9891\u95ee\u9898'}</small><ul>{summary.questions.map((question) => <li key={question.id}>{question.text}</li>)}</ul></div>}
      {summary.recommendedAction && <div className="post-comment-summary-action"><small>{'\u5efa\u8bae\u52a8\u4f5c'}</small><span>{summary.recommendedAction}</span></div>}
    </div>}
    {comments.length > 0 && <ol className="post-comments-list">{comments.map((comment) => <li className="post-comment" key={comment.id || `${comment.rank}-${comment.text}`}>
      <b className="post-comment-rank">{comment.rank}</b>
      <div className="post-comment-main">
        <div className="post-comment-meta"><strong>{comment.authorName || '未知用户'}</strong><span>{comment.publishedAt ? formatPostDate(comment.publishedAt) : comment.publishedAtText || '公开评论'}</span></div>
        <p>{comment.text}</p>
        <div className="post-comment-signals"><span>赞 {formatCommentMetric(comment.likeCount)}</span>{comment.replyCount !== null && <span>回复 {formatCommentMetric(comment.replyCount)}</span>}{comment.isHot && <b>热评</b>}</div>
      </div>
    </li>)}</ol>}
  </section>;
}

function defaultPostMessage(post) {
  const topic = (post.title || post.body || '这条内容').replace(/\s+/g, ' ').slice(0, 36);
  return `你好，${post.authorName || '创作者'}，看到你发布的「${topic}」，想和你聊聊一次内容合作。方便了解一下合作方式吗？`;
}

function postSourceLabel(source) {
  return source === 'official_api' ? '官方接口' : source === 'partner_http' ? '合作接口' : '浏览器 Relay';
}

function formatPostDate(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function postMetricItems(post) {
  const labels = [['likes', '点赞'], ['comments', '评论'], ['shares', '分享'], ['plays', '播放']];
  const metrics = post?.metrics || {};
  labels.push(['collects', '收藏']);
  (Array.isArray(post?.visibleMetrics) ? post.visibleMetrics : []).filter(Boolean).slice(0, 2).forEach((value, index) => {
    const key = `visible_${index}`;
    metrics[key] = value;
    labels.push([key, `可见数据${index + 1}`]);
  });
  return labels.map(([key, label]) => ({ label, value: metrics[key] === undefined ? '—' : countLabel(metrics[key]) }));
}

function StepHeader({ step, currentStep, stage }) {
  return <div className="step-header"><div><p>STEP {String(currentStep).padStart(2, '0')} / 06 · {stage?.caption || step.short}</p><h1>{step.title}</h1><span className="step-detail">{stage?.detail}</span></div><div className={`header-signal ${stage?.state || ''}`}><Zap size={16} /><span><small>EXECUTION STATE</small><strong>{stage?.metric || '准备中'}</strong></span></div></div>;
}

function CampaignCommandCenter({ stages, activeStage, onNavigate, nextAction, workspaceRunning, connectors, candidates, selected, evidence, drafts, onOpenCommandPalette }) {
  const metrics = [
    { label: '连接器', value: connectors, note: '已附着' },
    { label: '候选池', value: candidates, note: '可筛选' },
    { label: '优先对象', value: selected, note: '已选择' },
    { label: '内容证据', value: evidence, note: '条样本' },
    { label: '建联草稿', value: drafts, note: '可审核' },
  ];
  const percentage = Math.round((stages.filter((stage) => stage.done).length / Math.max(stages.length - 1, 1)) * 100);
  return <section className="campaign-command-center" aria-label="战役指挥台">
    <div className="campaign-command-head">
      <div><span className={`campaign-live ${workspaceRunning ? 'live' : ''}`}><i />{workspaceRunning ? '正在同步任务状态' : '任务工作区已就绪'}</span><strong>战役指挥台</strong><p>从任务定义到建联交付的每一步，都保留真实来源、任务状态与当前可执行动作。</p></div>
      <div className="campaign-command-actions"><button className="command-center-btn" onClick={onOpenCommandPalette}><Command size={15} />命令面板 <kbd>Ctrl K</kbd></button><button className="next-stage-btn" onClick={() => onNavigate(nextAction.id)}><span><small>下一动作</small><b>{nextAction.label}</b></span><ArrowUpRight size={17} /></button></div>
    </div>
    <div className="campaign-stage-rail">
      {stages.map((stage) => <button key={stage.id} className={`campaign-stage ${stage.state} ${activeStage === stage.id ? 'selected' : ''}`} onClick={() => onNavigate(stage.id)} disabled={stage.state === 'blocked'}>
        <span className="campaign-stage-index">{stage.done ? <Check size={12} /> : String(stage.id).padStart(2, '0')}</span>
        <span className="campaign-stage-copy"><small>{stage.caption}</small><strong>{stage.label}</strong><em>{stage.metric}</em></span>
      </button>)}
    </div>
    <div className="campaign-metrics">
      {metrics.map((metric) => <div key={metric.label}><small>{metric.label}</small><strong>{metric.value}</strong><span>{metric.note}</span></div>)}
      <div className="campaign-completion"><div><span>交付进度</span><b>{percentage}%</b></div><i><b style={{ width: `${percentage}%` }} /></i></div>
    </div>
  </section>;
}

function CommandPalette({ stages, currentStep, onNavigate, onRefresh, onExport, onClose, canExport }) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const actions = [
    ...stages.map((stage) => ({
      id: `stage-${stage.id}`,
      icon: stage.done ? CheckCircle2 : ListChecks,
      label: `前往：${stage.label}`,
      hint: stage.detail,
      shortcut: stage.id === currentStep ? '当前' : `0${stage.id}`,
      disabled: stage.state === 'blocked',
      run: () => onNavigate(stage.id),
    })),
    { id: 'refresh', icon: RefreshCw, label: '重新检查连接器', hint: '更新浏览器 Relay 与数据源连接状态', shortcut: 'R', run: onRefresh },
    { id: 'export', icon: Download, label: '导出当前任务报告', hint: canExport ? '下载当前证据快照与建联进度' : '完成建联草稿后可导出', shortcut: 'E', disabled: !canExport, run: onExport },
  ].filter((action) => !normalizedQuery || `${action.label} ${action.hint}`.toLowerCase().includes(normalizedQuery));
  return <div className="command-palette-layer" role="presentation" onMouseDown={onClose}>
    <section className="command-palette" role="dialog" aria-modal="true" aria-label="工作区命令面板" onMouseDown={(event) => event.stopPropagation()}>
      <div className="command-search"><Command size={18} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工作区动作" aria-label="搜索工作区动作" /><kbd>ESC</kbd></div>
      <div className="command-palette-label">WORKSPACE ACTIONS</div>
      <div className="command-list">{actions.length ? actions.map((action) => {
        const Icon = action.icon;
        return <button key={action.id} disabled={action.disabled} onClick={action.run}><span className="command-list-icon"><Icon size={16} /></span><span><strong>{action.label}</strong><small>{action.hint}</small></span><kbd>{action.shortcut}</kbd></button>;
      }) : <div className="command-empty"><Search size={17} />没有匹配的工作区动作</div>}</div>
      <footer><span><kbd>↑↓</kbd> 浏览</span><span><kbd>Enter</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span></footer>
    </section>
  </div>;
}

function BriefStep({ brief, setBrief }) {
  const update = (key, value) => setBrief((state) => ({ ...state, [key]: value }));
  return <section className="step-content brief-layout">
    <div className="form-section"><SectionTitle number="01" title="品牌与产品" caption="BRAND CONTEXT" /><div className="form-grid two"><Field label="品牌名称"><input value={brief.brand} onChange={(event) => update('brand', event.target.value)} /></Field><Field label="推广产品"><input value={brief.product} onChange={(event) => update('product', event.target.value)} /></Field></div></div>
    <div className="form-section"><SectionTitle number="02" title="任务目标" caption="CAMPAIGN GOAL" /><Field label="核心目标"><textarea value={brief.objective} onChange={(event) => update('objective', event.target.value)} /></Field><Field label="目标人群"><textarea value={brief.audience} onChange={(event) => update('audience', event.target.value)} /></Field><div className="form-grid two"><Field label="总预算（元）"><div className="input-with-icon"><CircleDollarSign size={16} /><input value={brief.budget} onChange={(event) => update('budget', event.target.value)} /></div></Field><Field label="目标市场"><select value={brief.market} onChange={(event) => update('market', event.target.value)}><option>中国大陆</option><option>东南亚</option><option>北美</option><option>欧洲</option></select></Field></div></div>
    <div className="form-section"><SectionTitle number="03" title="沟通边界" caption="MESSAGE GUARDRAILS" /><div className="form-grid two"><Field label="品牌语气"><input value={brief.tone} onChange={(event) => update('tone', event.target.value)} /></Field><Field label="避免内容"><input value={brief.avoid} onChange={(event) => update('avoid', event.target.value)} /></Field></div></div>
    <aside className="context-panel"><div className="context-top"><Bot size={18} /><span><small>BRIEF AGENT</small><strong>等待真实源数据</strong></span><b>READY</b></div><dl><div><dt>品牌实体</dt><dd>{brief.brand ? 1 : 0}</dd></div><div><dt>任务目标</dt><dd>{brief.objective ? 1 : 0}</dd></div><div><dt>沟通边界</dt><dd>{brief.avoid ? 1 : 0}</dd></div><div><dt>数据来源</dt><dd>待采集</dd></div></dl><p>后续筛选只使用本次任务返回的候选、内容样本和来源链接，不预置演示达人。</p></aside>
  </section>;
}

function ChannelStep({ selected, onChange, connectors, connectionRetention, connectorChecking, recoveringPlatform, onRecheck, onRecover }) {
  const activeChannels = channelOptions.filter((channel) => selected.includes(channel.id));
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  const dualChannelMode = activeChannels.length > 1;
  return <section className="step-content">
    <div className="channel-toolbar"><div><strong>支持渠道</strong><span>抖音、小红书与 B 站 · 每个渠道在运行前均验证真实连接器</span></div><div className="coverage"><span>已附着/已配置</span><strong>{activeChannels.filter((channel) => ['ready', 'relay_connected'].includes(connectors[channel.id]?.status)).length} / {selected.length}</strong></div></div>
    <div className="channel-grid">{channelOptions.map((channel) => {
      const connector = connectors[channel.id];
      return <button key={channel.id} className={`channel-card ${selected.includes(channel.id) ? 'selected' : ''}`} onClick={() => toggle(channel.id)} aria-pressed={selected.includes(channel.id)}>
        <span className="channel-check">{selected.includes(channel.id) && <Check size={14} />}</span><span className="channel-mark" style={{ '--channel': channel.color }}>{channel.mark}</span>
        <span className="channel-name"><strong>{channel.name}</strong><small>{channel.signal}</small></span>
        <span className={`connection-badge ${connector?.status || 'checking'}`}>{connector?.status === 'ready' ? '已配置' : connector?.status === 'relay_connected' ? '已附着待验证' : connector?.status === 'auth_required' ? '待登录/附着' : connector?.status === 'unconfigured' ? '待配置' : connector?.status === 'failed' ? '服务不可用' : '检查中'}</span>
        <span className="channel-adapter">{channel.adapter}<small>{connector?.detail || '正在读取本地连接器状态'}</small>{connector?.action && <em>{connector.action}</em>}</span>
      </button>;
    })}</div>
    <div className="selection-summary"><DatabaseZap size={19} /><div><strong>{dualChannelMode ? '多渠道真实采集已启用' : '平台专属真实采集已启用'}</strong><p>{dualChannelMode ? '候选会按平台账号与来源链接去重；不会将不同渠道的预置数据混入同一任务。' : '当前任务只会调用已启用平台的已连接数据源。'}</p></div><span>{selected.length} / {channelOptions.length} ENABLED</span></div>
    <ConnectionRetentionPanel channels={selected} retention={connectionRetention} connectors={connectors} checking={connectorChecking} recoveringPlatform={recoveringPlatform} onRecheck={onRecheck} onRecover={onRecover} />
    {connectors._error && <ConnectorNotice connector={connectors._error} />}
  </section>;
}

function ConnectionRetentionPanel({ channels, retention, connectors, checking, recoveringPlatform, onRecheck, onRecover }) {
  const loginChannels = channelOptions.filter((channel) => channel.loginUrl && (channels.includes(channel.id) || ['douyin', 'xiaohongshu'].includes(channel.id)));
  const checkedAt = retention?.checkedAt ? new Date(retention.checkedAt) : null;
  const checkedLabel = checkedAt && !Number.isNaN(checkedAt.getTime())
    ? checkedAt.toLocaleString('zh-CN', { hour12: false })
    : '等待首次预检';
  const savedStates = loginChannels.map((channel) => ({
    channel,
    snapshot: retention?.platforms?.[channel.id],
  }));
  const savedCount = savedStates.filter(({ snapshot }) => snapshot?.persisted).length;
  const profileAlias = retention?.profileAlias || 'attached-browser';
  return <div className="connection-retention" aria-live="polite">
    <div className="connection-retention-copy"><span><ShieldCheck size={16} /><strong>浏览器登录态</strong></span><small>Profile {profileAlias} · Cookie / Token 由浏览器加密留存 · 最近预检 {checkedLabel}</small><div className="session-retention-states">{savedStates.map(({ channel, snapshot }) => <span key={channel.id} className={`session-retention-state ${snapshot?.persisted ? 'persisted' : ''}`}><i />{channel.name} {snapshot?.persisted ? `${snapshot.tabCount || 0} TAB · ${snapshot.state === 'ready' ? '已留存' : snapshot.state}` : '待留存'}</span>)}</div></div>
    <div className="connection-retention-actions">
      {loginChannels.map((channel) => <a key={channel.id} className="session-link" href={channel.loginUrl} target="_blank" rel="noreferrer"><Globe2 size={13} />打开 {channel.name}</a>)}
      {loginChannels.map((channel) => <button key={`${channel.id}-recover`} type="button" className="session-recover" onClick={() => void onRecover(channel.id)} disabled={Boolean(recoveringPlatform)} title={`为 ${channel.name} 恢复独立 Relay 端口 ${connectors?.[channel.id]?.relayPort || ''}`}>
        {recoveringPlatform === channel.id ? <LoaderCircle className="spin" size={13} /> : <Settings2 size={13} />}
        {recoveringPlatform === channel.id ? '修复中' : `修复 ${channel.name}`}
      </button>)}
      <button type="button" className="session-recheck" onClick={onRecheck} disabled={checking} title={`已留存 ${savedCount} / ${loginChannels.length}`}>{checking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{checking ? '正在预检' : '重新验证'}</button>
    </div>
  </div>;
}

function CreatorStep({ creators, channels, selected, setSelected, discoveryQuery, setDiscoveryQuery, candidateLimit, setCandidateLimit, candidatePage, onLoadMoreCandidates, priorityBatchLimit, setPriorityBatchLimit, creatorFilter, setCreatorFilter, onDiscover, running, job, connectors, archiveEntries, archiveLoading, onRefreshArchive, onRestoreCampaign, onRestoreCollection, onRestoreEnrichment, onRestoreContent, onRestoreContentAnalysis, onResume, profilesByTargetId, enrichmentJob, enrichmentRunning, enrichmentError, contentByTargetId, contentJob, contentRunning, contentError, contentSampleLimit, setContentSampleLimit, contentJobs, contentAnalysisByTargetId, contentAnalysisJob, contentAnalysisRunning, contentAnalysisError, contentAnalysisSourceJobId, setContentAnalysisSourceJobId, onAnalyzeContent, onEnrich, onCollectContent, audienceByTargetId, audienceLoading, audienceImportingTargetId, audienceError, onImportAudience, onRefreshAudience, creatorPageHref }) {
  const [creatorRenderLimit, setCreatorRenderLimit] = useState(100);
  const [creatorStatusFilter, setCreatorStatusFilter] = useState('all');
  const [creatorSort, setCreatorSort] = useState('default');
  const contentAwareCreators = useMemo(() => creators.map((creator) => (
    creatorWithContentCapture(creator, contentByTargetId[creator.id])
  )), [creators, contentByTargetId]);
  const available = useMemo(() => {
    const filtered = contentAwareCreators.filter((creator) => {
      if (!channels.includes(creator.channel)) return false;
      const profile = profilesByTargetId[creator.id];
      const capture = contentByTargetId[creator.id];
      const hasProfile = Boolean(profile && Object.keys(plainObject(profile)).length) || Boolean(creator.persona);
      const sampleCount = contentCaptureSampleCount(capture) || firstNumericMetric(creator.sampleCount) || 0;
      const hasContent = sampleCount > 0;
      const fullCardComplete = capture?.pipeline?.fullCardComplete === true;
      if (creatorStatusFilter === 'profile' && !hasProfile) return false;
      if (creatorStatusFilter === 'content' && !hasContent) return false;
      if (creatorStatusFilter === 'full' && !fullCardComplete) return false;
      if (creatorStatusFilter === 'pending' && fullCardComplete) return false;
      const searchable = [
        creator.name,
        creator.handle,
        creator.niche,
        creator.platform,
        creator.angle,
        profileValue(profile, ['summary', 'persona', 'positioning', 'audienceSummary', 'contentStyle']),
        profileList(profileValue(profile, ['topics', 'themes', 'contentTags', 'tags', 'keywords'])).join(' '),
      ].map((value) => typeof value === 'object' ? JSON.stringify(value) : String(value || '')).join(' ').toLowerCase();
      return searchable.includes(creatorFilter.toLowerCase());
    });
    if (creatorSort === 'default') return filtered;
    const metric = (creator, key) => {
      const capture = contentByTargetId[creator.id];
      if (key === 'followers') return firstNumericMetric(creator.followers, creator.followerCount, creator.followersLabel) || 0;
      if (key === 'interactions') return firstNumericMetric(creator.interactions, creator.profileLikes, creator.totalLikes, creator.likes) || 0;
      if (key === 'samples') return contentCaptureSampleCount(capture) || firstNumericMetric(creator.sampleCount) || 0;
      return firstNumericMetric(creator.fit, creator.matchScore, creator.score) || 0;
    };
    return [...filtered].sort((left, right) => {
      if (creatorSort === 'name_asc') {
        return String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
      }
      const key = creatorSort === 'followers_desc' ? 'followers'
        : creatorSort === 'interactions_desc' ? 'interactions'
          : creatorSort === 'samples_desc' ? 'samples' : 'fit';
      const delta = metric(right, key) - metric(left, key);
      return delta || String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
  }, [contentAwareCreators, channels, creatorFilter, creatorStatusFilter, creatorSort, profilesByTargetId, contentByTargetId]);
  const channelKey = channels.join('|');
  useEffect(() => {
    setCreatorRenderLimit(100);
  }, [creatorFilter, channelKey, creatorStatusFilter, creatorSort]);
  const displayedCreators = available.slice(0, creatorRenderLimit);
  const displayedCreatorRows = useMemo(() => displayedCreators.map((baseCreator) => {
    const persona = profilesByTargetId[baseCreator.id];
    const capture = contentByTargetId[baseCreator.id];
    const analysisRecord = contentAnalysisByTargetId[baseCreator.id];
    const creator = creatorWithContentCapture(creatorWithPersona(baseCreator, persona), capture);
    const profile = mergeProfileWithContentCapture(persona, capture);
    return {
      creator,
      contentMetrics: creatorContentMetricSummary(creator, profile, analysisRecord),
    };
  }), [displayedCreators, profilesByTargetId, contentByTargetId, contentAnalysisByTargetId]);
  const hasMoreCreators = displayedCreators.length < available.length;
  const selectedVisible = available.filter((creator) => selected.includes(creator.id));
  const selectedProfileCount = selected.filter((id) => Boolean(profilesByTargetId[id])).length;
  const selectedContentCount = selected.filter((id) => Boolean(contentByTargetId[id])).length;
  const discoveryMetrics = plainObject(job?.metrics);
  const requestedCandidates = Number(discoveryMetrics.requestedCandidates || 0);
  const sourceRecords = Number(discoveryMetrics.sourceRecords || 0);
  const queryRoutes = Number(discoveryMetrics.queryRoutes || job?.queryPlan?.length || 0);
  const newUniqueCreators = Number(discoveryMetrics.newUniqueCreators || 0);
  const duplicateAcrossRoutes = Number(discoveryMetrics.duplicateAcrossRoutes || 0);
  const retryableRoutes = Number(discoveryMetrics.retryableRoutes || 0);
  const discoveryTargetScope = plainObject(job?.targetScope);
  const discoveredCandidateTotal = Math.max(
    creators.length,
    Number(candidatePage?.total || 0),
    Number(discoveryTargetScope.totalCandidates || discoveryTargetScope.candidateCount || discoveryTargetScope.total || 0),
    Number(discoveryMetrics.uniqueCreators || discoveryMetrics.newUniqueCreators || 0),
  );
  const availableContentJobs = uniqueJobs(contentJobs || []);
  const activeContentSource = availableContentJobs.find((candidate) => candidate.id === contentAnalysisSourceJobId)
    || availableContentJobs.at(-1)
    || null;
  const toggle = (id) => setSelected((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  const selectVisible = () => setSelected((items) => [...new Set([...items, ...available.map((creator) => creator.id)])]);
  const clearVisible = () => setSelected((items) => items.filter((id) => !available.some((creator) => creator.id === id)));
  const selectPriorityBatch = () => {
    const requestedBatchSize = priorityBatchLimit === 'all' ? available.length : Number(priorityBatchLimit);
    const ranked = [...available]
      .sort((left, right) => ((right.fit || 0) * 1000000 + (right.interactions || 0) + (right.sampleCount || 0)) - ((left.fit || 0) * 1000000 + (left.interactions || 0) + (left.sampleCount || 0)))
      .slice(0, Math.min(requestedBatchSize, available.length))
      .map((creator) => creator.id);
    setSelected((items) => [...new Set([...items, ...ranked])]);
  };
  return <section className="step-content">
    <div className="real-query-bar">
      <div className="search-control"><Search size={17} /><input placeholder="输入产品、赛道、话题或账号名称" value={discoveryQuery} onChange={(event) => setDiscoveryQuery(event.target.value)} /></div>
      <label className="candidate-limit-control"><span>每渠道</span><select value={candidateLimit} onChange={(event) => setCandidateLimit(event.target.value)} disabled={running} aria-label="每个渠道的候选数量"><option value="100">100 位</option><option value="200">200 位</option><option value="500">500 位</option><option value="1000">1000 位</option><option value="2000">2000 位</option><option value="3000">3000 位</option><option value="5000">5000 位</option><option value="10000">10000 位</option><option value="15000">15000 位</option><option value="full">尽可能多（15000）</option></select></label>
      <button className="collect-btn" onClick={onDiscover} disabled={running || !channels.length}>{running ? <LoaderCircle className="spin" size={16} /> : <Radar size={16} />}{running ? '真实采集中' : candidateLimit === 'full' ? '尽可能多采集' : `采集 ${candidateLimit}/渠道`}</button>
    </div>
    <p className="candidate-limit-note">目标按渠道分别执行；尽可能多会依据产品、目标、受众和市场拆成至多 16 条独立公开页面路线，单条完成即写入快照。只有页面确认耗尽才结束该路线；短暂无新增、滚动控制失败或时间预算到达会保留为可续跑。账号按渠道身份去重，候选按 1000 条分页载入。</p>
    <div className="connector-inline">{channels.map((channel) => <ConnectionBadge key={channel} connector={connectors[channel]} />)}</div>
    {job && <CollectionFeedback job={job} />}
    {job && <div className="discovery-coverage" aria-label="候选采集覆盖统计"><span><small>请求目标</small><strong>{requestedCandidates || '—'}</strong></span><span><small>检索路线</small><strong>{queryRoutes || '—'}</strong></span><span><small>公开卡片</small><strong>{sourceRecords || '—'}</strong></span><span><small>本轮新增</small><strong>{newUniqueCreators}</strong></span><span><small>跨路线重复</small><strong>{duplicateAcrossRoutes}</strong></span><span><small>可续跑路线</small><strong>{retryableRoutes}</strong></span></div>}
    {job && <DiscoveryRouteCoverage job={job} />}
    <CollectionArchive entries={archiveEntries} loading={archiveLoading} onRefresh={onRefreshArchive} onRestoreCampaign={onRestoreCampaign} onRestoreCollection={onRestoreCollection} onRestoreEnrichment={onRestoreEnrichment} onRestoreContent={onRestoreContent} onRestoreContentAnalysis={onRestoreContentAnalysis} onResume={onResume} />
    <div className="creator-toolbar"><div className="search-control"><Search size={17} /><input placeholder="筛选已返回的候选、内容方向或画像标签" value={creatorFilter} onChange={(event) => setCreatorFilter(event.target.value)} />{creatorFilter && <button onClick={() => setCreatorFilter('')} aria-label="清空筛选"><X size={14} /></button>}</div><label className="creator-select-control"><span>状态</span><select value={creatorStatusFilter} onChange={(event) => setCreatorStatusFilter(event.target.value)} aria-label="按采集状态筛选"><option value="all">全部候选</option><option value="full">全量卡已完成</option><option value="profile">已回填主页</option><option value="content">已采集作品</option><option value="pending">全量卡待完成</option></select></label><label className="creator-select-control"><span>排序</span><select value={creatorSort} onChange={(event) => setCreatorSort(event.target.value)} aria-label="候选排序方式"><option value="default">默认顺序</option><option value="fit_desc">匹配度高到低</option><option value="followers_desc">粉丝数高到低</option><option value="interactions_desc">互动/获赞高到低</option><option value="samples_desc">公开样本多到少</option><option value="name_asc">名称 A-Z</option></select></label><div className="creator-data-label"><DatabaseZap size={15} />{creators.length ? `${creators.length} 位真实候选` : '尚未载入候选'}</div><div className="selection-count"><span>{selected.length}</span> 位已选</div></div>
    <div className="candidate-bulkbar"><div className="bulk-summary"><span className={`bulk-status ${enrichmentRunning || contentRunning ? 'running' : selectedProfileCount || selectedContentCount ? 'ready' : ''}`} /><div><strong>{available.length} 位当前筛选候选</strong><small>{selected.length ? `${selected.length} 位进入批量操作 · ${selectedProfileCount} 位已回填画像 · ${selectedContentCount} 位已采集内容` : '默认优选 500 位；可按匹配度、互动和样本数批量选取更多候选'}</small></div></div><div className="bulk-actions"><button className="bulk-action" onClick={selectVisible} disabled={!available.length || selectedVisible.length === available.length}><Check size={14} />全选筛选项</button><label className="priority-batch-control"><span>智能优选</span><select value={priorityBatchLimit} onChange={(event) => setPriorityBatchLimit(event.target.value)} aria-label="智能优选候选数量"><option value="200">200 位</option><option value="500">500 位</option><option value="1000">1000 位</option><option value="all">全部</option></select></label><button className="bulk-action" onClick={selectPriorityBatch} disabled={!available.length}><Target size={14} />智能优选</button>{selectedVisible.length > 0 && <button className="bulk-action" onClick={clearVisible}><X size={14} />取消筛选项</button>}<button className="bulk-enrich" onClick={() => onEnrich(selected)} disabled={!selected.length || enrichmentRunning}>{enrichmentRunning ? <LoaderCircle className="spin" size={15} /> : <DatabaseZap size={15} />}{enrichmentRunning ? '采集达人数据中' : selectedProfileCount ? '更新达人数据' : '批量采集达人数据'}</button></div></div>
    <DiscoveryWideQueue discoveryTotal={discoveredCandidateTotal} loadedCandidateCount={creators.length} targetScope={discoveryTargetScope} running={contentRunning} onCollectAll={() => onCollectContent([], { allDiscoveredCandidates: true })} />
    <ContentCollectionPanel creators={contentAwareCreators} selected={selected} contentByTargetId={contentByTargetId} job={contentJob} running={contentRunning} contentSampleLimit={contentSampleLimit} onLimitChange={setContentSampleLimit} onCollect={() => onCollectContent(selected)} />
    <ContentAnalysisScopeQueue sourceJob={activeContentSource} running={contentAnalysisRunning} onAnalyzeAll={() => onAnalyzeContent(activeContentSource?.id, [], { allCapturedCreators: true })} />
    <ContentAnalysisPanel creators={contentAwareCreators} selected={selected} contentJobs={contentJobs} contentAnalysisByTargetId={contentAnalysisByTargetId} job={contentAnalysisJob} running={contentAnalysisRunning} error={contentAnalysisError} sourceJobId={contentAnalysisSourceJobId} onSourceJobChange={setContentAnalysisSourceJobId} onAnalyze={onAnalyzeContent} />
    <CreatorPerformanceList rows={displayedCreatorRows} selected={selected} onToggle={toggle} profilesByTargetId={profilesByTargetId} creatorPageHref={creatorPageHref} contentRunning={contentRunning} onCollectContent={onCollectContent} />
    {enrichmentError && <div className="enrichment-notice"><AlertCircle size={16} /><span><strong>达人数据任务未启动</strong><small>{enrichmentError}；当前仍可查看已采集候选的真实样本层。</small></span></div>}
    {contentError && <div className="enrichment-notice"><AlertCircle size={16} /><span><strong>公开内容任务未启动</strong><small>{contentError}；已回填的内容快照会继续保留。</small></span></div>}
    {available.length > 0 && <div className="creator-list-more"><span>已显示 {displayedCreators.length} / {available.length} 位候选</span>{hasMoreCreators && <div><button type="button" onClick={() => setCreatorRenderLimit((limit) => Math.min(limit + 100, available.length))}>显示更多 100 位</button></div>}</div>}
    {job?.id === candidatePage?.jobId && (candidatePage.total > candidatePage.loaded || candidatePage.error) && <div className="creator-list-more candidate-page-more"><span>{candidatePage.error || `已载入 ${candidatePage.loaded} / ${candidatePage.total} 位任务候选`}</span><div><button type="button" onClick={() => void onLoadMoreCandidates()} disabled={candidatePage.loading || (!candidatePage.nextCursor && !candidatePage.error)}>{candidatePage.loading ? '正在载入' : candidatePage.error ? '重新读取候选' : '继续载入 1000 位'}</button></div></div>}
    {!available.length && <div className="empty"><Search size={24} /><strong>{creators.length ? '没有符合当前筛选的候选' : '尚未采集到候选'}</strong><span>{creators.length ? '调整筛选关键词查看已返回的真实记录' : '输入检索条件并启动真实采集；连接器未就绪时会给出具体操作提示。'}</span></div>}
  </section>;
}

function CreatorPerformanceList({ rows, selected, onToggle, profilesByTargetId, creatorPageHref, contentRunning, onCollectContent }) {
  return <div className="creator-performance-list">
    <div className="creator-performance-head"><span>达人与渠道</span><span>作品表现</span><span>Brief 匹配</span><span>资料 / 选择</span></div>
    {rows.map(({ creator, contentMetrics }) => {
      const displayName = creatorDisplayName(creator) || creator.name;
      const identityDetail = [creator.handle, creator.niche].filter(Boolean).join(' · ');
      const profileReady = Boolean(profilesByTargetId[creator.id]);
      const captureJobId = profileText(contentMetrics.capture?.contentJobId);
      const metricCapturedAt = creator.metricCapturedAt ? new Date(creator.metricCapturedAt) : null;
      const metricCapturedLabel = metricCapturedAt && !Number.isNaN(metricCapturedAt.getTime())
        ? metricCapturedAt.toLocaleString('zh-CN', { hour12: false })
        : '';
      const metricEvidence = contentMetrics.publicProfileSignals?.length > 0
        ? `主页指标来源：${profileText(creator.metricSource, '公开发现卡片')} · 采集时间：${metricCapturedLabel || '来源未返回'}`
        : `主页指标缺失：${Object.entries(plainObject(creator.metricMissingReasons)).filter(([, reason]) => Boolean(reason)).map(([field]) => ({ followers: '粉丝', following: '关注', totalLikes: '获赞', works: '作品数' })[field] || field).join('、') || '当前公开来源未返回粉丝、获赞等数值'}`;
      const inspectHref = creatorPageHref?.(
        creator.id,
        captureJobId ? { contentJobId: captureJobId } : undefined,
      );
      return <div className={`creator-performance-row ${selected.includes(creator.id) ? 'selected' : ''}`} key={creator.id}>
        <div className="creator-identity">
          <Avatar creator={creator} />
          <div className="creator-identity-copy">
            <strong title={creator.name}>{displayName}</strong>
            <small title={identityDetail}>{identityDetail || '账号基础字段待采集'}</small>
            <div className="creator-identity-meta"><ChannelTag platform={creator.platform} /><span className="creator-inline-price">{profileText(creator.priceLabel, '报价待沟通')}</span></div>
            {contentMetrics.publicProfileSignals?.length > 0 && <div className="creator-public-profile-signals" title="公开账号卡片数据，不等于作品均值。">{contentMetrics.publicProfileSignals.map((signal) => <span key={signal.label}>{signal.label} {signal.value}</span>)}</div>}
            <small className={`creator-metric-evidence ${contentMetrics.publicProfileSignals?.length ? 'available' : 'missing'}`} title={metricEvidence}>{metricEvidence}</small>
            {isCreatorProfileUrl(creator.channel, creator.sourceUrl) && <a className="creator-source-link" href={creator.sourceUrl} target="_blank" rel="noopener noreferrer" title={creator.sourceUrl} aria-label={`在新标签页打开 ${creator.name} 的真实平台主页`}><ExternalLink size={12} />打开真实主页</a>}
          </div>
        </div>
          <div className="creator-performance-metrics" aria-label={`${creator.name} 的作品表现`}>
          {contentMetrics.metrics.map((item) => <dl className="creator-performance-metric" key={item.label} title={item.detail}><dt>{item.label}</dt><dd className={item.unavailable ? 'unavailable' : ''}>{item.value}</dd></dl>)}
          <dl className="creator-performance-metric creator-performance-keywords" title={contentMetrics.keywordDetail}><dt>内容关键词</dt><dd>{contentMetrics.keywords.length ? contentMetrics.keywords.map((keyword) => <span key={keyword} title={keyword}>{keyword}</span>) : <span className="unavailable">—</span>}</dd></dl>
          <div className={`creator-performance-origin ${contentMetrics.capture?.state || 'pending'}`}><span title={contentMetrics.capture?.label || '待采集真实作品'}>{contentMetrics.capture?.label || '待采集真实作品'}</span><small title={contentMetrics.origin}>{contentMetrics.origin}</small></div>
        </div>
        <div className="creator-match-cell"><small>Brief 匹配</small><div className="match-score"><i style={{ '--fit': `${creator.fit || 0}%` }} /><strong>{creator.fit ?? '—'}</strong></div></div>
        <div className="creator-row-actions">
          {inspectHref ? <a className={`inspect-kol ${profileReady ? 'enriched' : ''}`} href={inspectHref} aria-label={`查看 ${creator.name} 的独立达人页面`} title={captureJobId ? `打开内容任务 ${captureJobId.slice(0, 8)} 的独立达人页面` : '打开独立达人页面'}><Search size={14} /><span>{profileReady ? '完整资料页' : '详情页'}</span></a> : <button className={`inspect-kol ${profileReady ? 'enriched' : ''}`} type="button" disabled title="保存活动后可打开独立页面"><Search size={14} /><span>详情页</span></button>}
          {onCollectContent && <button className={`creator-content-collect ${contentMetrics.capture?.state || 'pending'}`} type="button" onClick={() => onCollectContent([creator.id])} disabled={contentRunning} title={contentRunning ? '当前内容任务正在运行' : '采集该达人的公开可见作品并生成后续内容解读'}>{contentRunning ? <LoaderCircle className="spin" size={14} /> : <Radar size={14} />}<span>{['captured', 'full'].includes(contentMetrics.capture?.state) ? '刷新作品' : '采集作品'}</span></button>}
          <button className={`select-kol ${selected.includes(creator.id) ? 'selected' : ''}`} onClick={() => onToggle(creator.id)}>{selected.includes(creator.id) ? <><Check size={14} />已选</> : <><Plus size={14} />选择</>}</button>
        </div>
      </div>;
    })}
  </div>;
}

function DiscoveryWideQueue({ discoveryTotal = 0, loadedCandidateCount = 0, targetScope, running, onCollectAll }) {
  const scope = plainObject(targetScope);
  const total = Math.max(
    Number(discoveryTotal) || 0,
    Number(scope.totalCandidates || scope.candidateCount || scope.total || 0),
  );
  const scopeName = profileText(firstPresent(scope.label, scope.mode, scope.kind), 'DISCOVERY-WIDE');
  const canQueue = total > 0;
  return <section className="discovery-wide-queue" aria-label="当前发现任务全量公开内容采集">
    <div><small>{scopeName} / SERVER-SIDE QUEUE</small><strong>{canQueue ? `当前发现任务 ${total} 位候选` : '等待发现任务'}</strong><span>{canQueue ? `已载入 ${loadedCandidateCount} 位；全量操作按发现快照分批入队，不受前端分页和当前勾选范围限制。` : '完成候选发现后，可将该任务的全部候选直接加入公开内容采集队列。'}</span></div>
    <button type="button" onClick={onCollectAll} disabled={!canQueue || running}>{running ? <LoaderCircle className="spin" size={16} /> : <Layers3 size={16} />}{running ? '全量采集中' : '当前任务全部候选'}</button>
  </section>;
}

function ContentCollectionPanel({ creators, selected, contentByTargetId, job, running, contentSampleLimit, onLimitChange, onCollect }) {
  const selectedCreators = selected
    .map((id) => creators.find((creator) => creator.id === id))
    .filter(Boolean);
  const coverage = selectedCreators.map((creator) => {
    const capture = contentByTargetId[creator.id];
    const content = plainObject(capture?.content);
    const samples = publicContentSamples(content.visibleSamples);
    return {
      creator,
      capture,
      capturedSamples: samples.length,
      hasContent: samples.length > 0,
    };
  });
  const jobMetrics = plainObject(job?.metrics);
  const capturedCreators = Math.max(
    coverage.filter((entry) => entry.hasContent).length,
    Number(jobMetrics.profileResolvedCount) || 0,
  );
  const capturedSamples = coverage.reduce((total, entry) => total + entry.capturedSamples, 0);
  const loadedCollectionAggregation = contentCollectionAggregation(coverage.map((entry) => entry.capture).filter(Boolean));
  const collectionAggregation = {
    ...loadedCollectionAggregation,
    captureCount: Math.max(
      loadedCollectionAggregation.captureCount,
      Number(jobMetrics.profileResolvedCount) || 0,
    ),
    enumeratedWorks: Math.max(
      loadedCollectionAggregation.enumeratedWorks,
      Number(jobMetrics.uniqueContentCount) || 0,
    ),
    pageExhaustedCaptures: Math.max(
      loadedCollectionAggregation.pageExhaustedCaptures,
      Number(jobMetrics.catalogCoverageCount) || 0,
    ),
  };
  const targetCardCount = Math.max(Number(jobMetrics.targetCreators) || 0, Number(job?.selectedCreatorCount) || 0, selectedCreators.length);
  const fullCardCount = Math.max(0, Number(jobMetrics.fullCardCoverageCount) || 0);
  const remainingCardCount = Math.max(0, Number(jobMetrics.remainingCardCount) || (targetCardCount - fullCardCount));
  const channelCoverage = channelOptions.map((channel) => {
    const rows = coverage.filter((entry) => entry.creator.channel === channel.id);
    return {
      ...channel,
      creators: rows.length,
      contentCreators: rows.filter((entry) => entry.hasContent).length,
      samples: rows.reduce((total, entry) => total + entry.capturedSamples, 0),
    };
  }).filter((channel) => channel.creators > 0);
  const status = job?.status || 'idle';
  return <section className="content-collection" aria-label="公开内容采集">
    <div className="content-collection-head"><div><small>CONTENT COLLECTOR / PUBLIC VISIBLE</small><strong>公开内容采集</strong><span>保存平台当前实际返回的内容样本、话题、发布时间、互动字段与来源链接。</span></div><div className="content-collection-actions"><label className="content-limit-control"><small>当前公开可见内容上限</small><select value={contentSampleLimit} onChange={(event) => onLimitChange(event.target.value)} disabled={running} aria-label="每位达人当前公开可见内容采集上限"><option value="10000">尽可能完整（页面到底或 10,000 条）</option><option value="3000">3,000 条 / 人</option><option value="1500">1,500 条 / 人</option><option value="1000">1,000 条 / 人</option><option value="500">500 条 / 人</option><option value="120">120 条 / 人</option><option value="48">48 条 / 人</option><option value="24">24 条 / 人</option></select></label><button className="content-collect-action" onClick={onCollect} disabled={!selectedCreators.length || running}>{running ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{running ? '内容采集中' : capturedSamples ? '刷新公开内容' : '采集公开内容'}</button></div></div>
    <div className="content-collection-metrics"><div><small>全量目标</small><strong>{targetCardCount || selectedCreators.length}</strong><span>每张卡都进入主页、目录、详情流程</span></div><div><small>完整卡</small><strong>{fullCardCount}</strong><span>{targetCardCount ? `${fullCardCount} / ${targetCardCount} 张` : '等待创建全量任务'}</span></div><div><small>待完成卡</small><strong>{remainingCardCount}</strong><span>{running ? `当前阶段：${job?.phase === 'profile' ? '主页' : job?.phase === 'catalog_detail' ? '目录与详情逐卡闭环' : job?.phase === 'catalog' ? '作品目录' : job?.phase === 'detail' ? '缺失详情' : '准备中'}` : remainingCardCount ? '保留检查点，可定向续跑' : '全部完成或明确不可见原因'}</span></div><div><small>内容已回填</small><strong>{capturedCreators}</strong><span>{targetCardCount ? `${capturedCreators} / ${targetCardCount} 位达人` : '请选择达人'}</span></div><div><small>已枚举作品</small><strong>{collectionAggregation.enumeratedWorks}</strong><span>{collectionAggregation.captureCount ? '按内容账本/公开样本去重' : '等待采集返回内容账本'}</span></div><div><small>采集覆盖</small><strong>{collectionAggregation.captureCount ? `${collectionAggregation.pageExhaustedCaptures} 已到底` : '待采集'}</strong><span>{collectionAggregation.captureCount ? `已到底 ${collectionAggregation.pageExhaustedCaptures} · 达到请求上限 ${collectionAggregation.requestedLimitReachedCaptures} · 可续跑 ${collectionAggregation.continuationCaptures}${collectionAggregation.terminalStateUnconfirmedCaptures ? ` · 状态待确认 ${collectionAggregation.terminalStateUnconfirmedCaptures}` : ''}` : (job?.id ? `任务 ${job.id.slice(0, 8)} · ${statusLabel(status)}` : `默认尽可能完整 / 人`)}</span></div></div>
    <div className="content-collection-channels">{channelCoverage.length ? channelCoverage.map((channel) => <div key={channel.id}><span className="content-channel-mark" style={{ '--channel': channel.color }}>{channel.mark}</span><div><strong>{channel.name}</strong><small>{channel.contentCreators} 位已回填 · {channel.samples} 条样本</small></div><b>{channel.creators} 位已选</b></div>) : <div className="content-collection-empty"><Layers3 size={16} /><span>先从候选列表选择达人，再启动内容采集。</span></div>}</div>
    <div className="content-collection-note"><ShieldCheck size={15} /><span>“已到底”才表示当前公开页面明确枚举完毕；“达到请求上限”与“可续跑”均不表示完整历史。仅保留页面实际返回的记录，缺失字段保持为空。</span></div>
  </section>;
}

function ContentAnalysisScopeQueue({ sourceJob, running, onAnalyzeAll }) {
  const scope = plainObject(sourceJob?.targetScope);
  const metrics = plainObject(sourceJob?.metrics);
  const sourceActive = isActiveJob(sourceJob);
  const capturedCreatorCount = Math.max(
    Number(scope.capturedCreators || scope.creatorCount || scope.totalCreators || scope.total || 0),
    Number(metrics.capturedCreators || metrics.contentCreators || metrics.creatorCount || metrics.creators || 0),
    Number(sourceJob?.targetCount || 0),
  );
  const scopeName = profileText(firstPresent(scope.label, scope.mode, scope.kind), 'CAPTURED-CREATORS');
  return <section className="content-analysis-wide-queue" aria-label="内容批次全量逐条解读">
    <div><small>{scopeName} / ITEM-BY-ITEM ANALYSIS</small><strong>{sourceJob?.id ? (capturedCreatorCount ? `内容批次 ${capturedCreatorCount} 位已采集达人` : `内容批次 ${sourceJob.id.slice(0, 8)}`) : '选择内容批次'}</strong><span>{sourceActive ? `来源任务正在${sourceJob.phase === 'catalog' ? '采集作品列表' : '采集'}；已落盘数据可查看，任务结束后才能启动逐内容解读。` : sourceJob?.id ? '将该批次的全部已采集达人加入逐内容解读；没有可用公开样本的账号会保留覆盖状态和原因。' : '先选择一个公开内容采集批次，才能创建全量内容理解任务。'}</span></div>
    <button type="button" onClick={onAnalyzeAll} disabled={!sourceJob?.id || sourceActive || running}>{running ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{running ? '全量解读中' : sourceActive ? '等待采集完成' : '本批次全部已采集达人'}</button>
  </section>;
}

function ContentAnalysisPanel({ creators, selected, contentJobs, contentAnalysisByTargetId, job, running, error, sourceJobId, onSourceJobChange, onAnalyze }) {
  const jobs = uniqueJobs(contentJobs || []);
  const activeSourceId = jobs.some((candidate) => candidate.id === sourceJobId)
    ? sourceJobId
    : jobs.at(-1)?.id || '';
  const sourceJob = jobs.find((candidate) => candidate.id === activeSourceId) || null;
  const sourceActive = isActiveJob(sourceJob);
  const captures = contentMapFromJob(sourceJob);
  const selectedCreators = selected
    .map((id) => creators.find((creator) => creator.id === id))
    .filter(Boolean);
  const eligible = selectedCreators.filter((creator) => (
    contentCaptureSampleCount(captures[creator.id]) > 0
  ));
  const analyzed = selectedCreators
    .map((creator) => ({ creator, record: contentAnalysisByTargetId[creator.id] }))
    .filter(({ record }) => Boolean(record?.analysis));
  const agentRuntime = plainObject(job?.agentRuntime);
  const orchestrationByTarget = new Map();
  Object.entries(plainObject(job?.channelResults)).forEach(([key, result]) => {
    const item = plainObject(result);
    const orchestration = plainObject(item.agentOrchestration);
    if (!orchestration.id) return;
    orchestrationByTarget.set(profileText(item.targetId, key), orchestration);
  });
  analyzed.forEach(({ creator, record }) => {
    if (orchestrationByTarget.has(creator.id)) return;
    const orchestration = plainObject(record?.analysis?.orchestration);
    if (orchestration.id) orchestrationByTarget.set(creator.id, orchestration);
  });
  const trackedAgentRuns = [...orchestrationByTarget.values()].flatMap((orchestration) => (
    Array.isArray(orchestration.agents) ? orchestration.agents : []
  ));
  const roleRuntimeById = new Map(contentAnalysisRoleCatalog.map((role) => [role.id, {
    total: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
  }]));
  trackedAgentRuns.forEach((agent) => {
    const summary = roleRuntimeById.get(agent?.id);
    if (!summary) return;
    summary.total += 1;
    if (['completed', 'completed_cached'].includes(agent.status)) summary.completed += 1;
    else if (agent.status === 'running') summary.running += 1;
    else if (['failed', 'fallback'].includes(agent.status)) summary.failed += 1;
    else if (agent.status === 'queued') summary.queued += 1;
  });
  const roleStats = contentAnalysisRoleCatalog.map((role) => {
    const returned = analyzed
      .map(({ record }) => (record.analysis.roles || []).find((candidate) => candidate?.id === role.id))
      .filter(Boolean);
    const findingCount = returned.reduce((total, item) => total + (item.findings?.length || 0), 0);
    const evidenceCount = returned.reduce((total, item) => total + (item.evidence?.length || 0), 0);
    return { ...role, returned, findingCount, evidenceCount, runtime: roleRuntimeById.get(role.id) };
  });
  const batchMultimodal = aggregateMultimodalCoverage(
    analyzed.map(({ record }) => record?.analysis?.multimodal),
  );
  const activeAgentRunCount = trackedAgentRuns.filter((agent) => agent?.status === 'running').length;
  const completedAgentRunCount = trackedAgentRuns.filter((agent) => (
    ['completed', 'completed_cached'].includes(agent?.status)
  )).length;
  const totalFindings = analyzed.reduce((total, { record }) => total + analysisFindingCount(record), 0);
  const sourceSampleCount = eligible.reduce((total, creator) => total + contentCaptureSampleCount(captures[creator.id]), 0);
  const analysisStatus = job?.status || 'idle';
  const jobMetrics = plainObject(job?.metrics);
  const videoProgressByTarget = plainObject(job?.videoProgressByTarget);
  const activeVideoProgresses = Object.values(videoProgressByTarget)
    .map((entry) => plainObject(entry))
    .filter((entry) => Object.keys(entry).length > 0);
  const videoProgress = activeVideoProgresses.at(-1) || plainObject(job?.videoProgress);
  const numberValue = (...values) => {
    const value = firstPresent(...values);
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  };
  const videoTotal = numberValue(
    videoProgress.total,
    videoProgress.totalVideos,
    videoProgress.eligible,
    videoProgress.eligibleVideoSamples,
    videoProgress.eligibleVideoSampleCount,
    videoProgress.totalVideoSamples,
    jobMetrics.eligibleVideoSamples,
    jobMetrics.eligibleVideoSampleCount,
  );
  const videoProcessed = numberValue(
    videoProgress.processed,
    videoProgress.completed,
    videoProgress.processedVideoSamples,
    videoProgress.completedVideoSamples,
    jobMetrics.processedVideoSamples,
    jobMetrics.processedVideoSampleCount,
  );
  const videoTranscribed = numberValue(
    videoProgress.transcribed,
    videoProgress.transcriptCompleted,
    videoProgress.transcribedVideoSamples,
    videoProgress.transcriptCompletedVideoSamples,
    jobMetrics.transcribedVideoSamples,
    jobMetrics.transcribedVideoSampleCount,
  );
  const videoPending = numberValue(
    videoProgress.pending,
    videoProgress.remaining,
    videoProgress.pendingVideoSamples,
    jobMetrics.unprocessedVideoSamples,
    jobMetrics.unprocessedVideoSampleCount,
  );
  const videoActive = numberValue(
    videoProgress.active,
    videoProgress.running,
    videoProgress.inFlight,
  );
  const videoConcurrency = numberValue(
    videoProgress.concurrency,
    videoProgress.workers,
    videoProgress.maxConcurrency,
  );
  const activeCreatorCount = numberValue(
    videoProgress.activeCreators,
    activeVideoProgresses.length || null,
  );
  const reportedVideoProgress = numberValue(
    videoProgress.percent,
    videoProgress.percentage,
    videoProgress.progress,
  );
  const videoProgressPercent = reportedVideoProgress !== null
    ? Math.min(100, reportedVideoProgress)
    : videoTotal && videoProcessed !== null
      ? Math.min(100, Math.round((videoProcessed / videoTotal) * 100))
      : null;
  const hasVideoProgress = activeVideoProgresses.length > 0 || Object.keys(videoProgress).length > 0;
  const hasVideoMetrics = hasVideoProgress || videoTotal !== null || videoProcessed !== null || videoTranscribed !== null;
  const videoProgressNote = profileText(firstPresent(
    videoProgress.label,
    videoProgress.stageLabel,
    videoProgress.stage,
    videoProgress.status,
  ), hasVideoProgress ? '逐视频任务状态' : '本批内容的视频处理汇总');
  return <section className="content-analysis" aria-label="内容理解 Agent 矩阵">
    <div className="content-analysis-head"><div><small>CONTENT INTELLIGENCE / EVIDENCE MATRIX</small><strong>内容理解 Agent 矩阵</strong><span>以已采集的正文、摘要、话题、互动和来源链接为证据输入，不只读取标题。</span></div><div className="content-analysis-actions"><label className="analysis-source-control"><small>内容批次</small><select value={activeSourceId} onChange={(event) => onSourceJobChange(event.target.value)} disabled={running || !jobs.length} aria-label="选择用于内容理解的公开内容任务"><option value="">选择内容任务</option>{jobs.map((candidate) => <option key={candidate.id} value={candidate.id}>任务 {candidate.id.slice(0, 8)} · {candidate.metrics?.visibleContentSamples ?? 0} 条样本</option>)}</select></label><button className="content-analysis-action" onClick={() => onAnalyze(activeSourceId, eligible.map((creator) => creator.id))} disabled={!activeSourceId || !eligible.length || sourceActive || running}>{running ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{running ? '矩阵理解中' : sourceActive ? '等待采集完成' : analyzed.length ? '重新运行矩阵' : '运行内容理解'}</button></div></div>
    <div className="content-analysis-metrics"><div><small>本批内容</small><strong>{sourceSampleCount}</strong><span>{activeSourceId ? `${eligible.length} 位达人有样本` : '选择已完成内容批次'}</span></div><div><small>已返回结论</small><strong>{analyzed.length}</strong><span>{selectedCreators.length ? `${analyzed.length} / ${selectedCreators.length} 位已选达人` : '请选择达人'}</span></div><div><small>可追溯判断</small><strong>{totalFindings}</strong><span>角色级 findings</span></div><div><small>最近任务</small><strong>{job ? statusLabel(analysisStatus) : '待启动'}</strong><span>{job?.id ? `任务 ${job.id.slice(0, 8)}` : '未创建内容理解任务'}</span></div></div>
    {Object.keys(agentRuntime).length > 0 && <div className="codex-agent-runtime" aria-label="Codex 多 Agent 编排状态">
      <div className="codex-agent-runtime-head"><div><small>CODEX MULTI-AGENT / LIVE ORCHESTRATION</small><strong>{agentRuntime.label || 'Codex 多 Agent'}</strong><span>{agentRuntime.configured ? `${agentRuntime.model || '已配置模型'} · 跨达人并发 ${agentRuntime.creatorConcurrency || 1} · 请求并发 ${agentRuntime.requestConcurrency || 1}` : '模型尚未配置；逐内容证据矩阵和视频分析仍会完整保存。'}</span></div><b className={`codex-agent-status ${agentRuntime.configured ? (activeAgentRunCount ? 'running' : 'ready') : 'queued'}`}>{agentRuntime.configured ? activeAgentRunCount ? `${activeAgentRunCount} 个 Agent 运行中` : '工作池待调度' : '证据模式'}</b></div>
      <div className="codex-agent-runtime-metrics"><span><small>专业 Agent</small><strong>{agentRuntime.specialistAgentCount || contentAnalysisRoleCatalog.length}</strong></span><span><small>已完成调用</small><strong>{completedAgentRunCount}</strong></span><span><small>运行中</small><strong>{activeAgentRunCount}</strong></span><span><small>本批编排</small><strong>{orchestrationByTarget.size}</strong></span></div>
    </div>}
    <MultimodalCoverageStrip multimodal={batchMultimodal} label="本批内容分析多模态输入" />
    {hasVideoMetrics && <div className="content-analysis-video-progress" aria-label="逐视频处理进度">
      <div className="content-analysis-video-progress-head"><div><small>VIDEO PIPELINE / LIVE PROGRESS</small><strong>逐视频处理进度</strong><span>{videoProgressNote}</span></div><b>{videoProgressPercent === null ? '—' : `${videoProgressPercent}%`}</b></div>
      {videoProgressPercent !== null && <div className="content-analysis-video-progress-track" aria-hidden="true"><i style={{ width: `${videoProgressPercent}%` }} /></div>}
      <div className="content-analysis-video-progress-metrics"><span><small>已处理视频</small><strong>{videoProcessed === null ? '—' : videoTotal === null ? videoProcessed : `${videoProcessed} / ${videoTotal}`}</strong></span><span><small>已转写视频</small><strong>{videoTranscribed === null ? '—' : videoTotal === null ? videoTranscribed : `${videoTranscribed} / ${videoTotal}`}</strong></span>{videoPending !== null && <span><small>待处理视频</small><strong>{videoPending}</strong></span>}{videoActive !== null && <span><small>处理中</small><strong>{videoActive}</strong></span>}{videoConcurrency !== null && <span><small>本地并发</small><strong>{videoConcurrency}</strong></span>}{activeCreatorCount !== null && activeCreatorCount > 1 && <span><small>并行达人</small><strong>{activeCreatorCount}</strong></span>}</div>
    </div>}
    <div className="content-analysis-roles">{roleStats.map((role) => {
      const Icon = role.icon;
      const hasReturned = role.returned.length > 0;
      const roleMultimodal = aggregateMultimodalCoverage(role.returned.map((item) => item?.multimodal));
      const runtime = role.runtime || { queued: 0, running: 0, failed: 0 };
      const state = runtime.running ? 'running' : runtime.failed ? 'failed' : hasReturned ? 'ready' : '';
      const resultLabel = runtime.running
        ? `${runtime.running} 运行中`
        : runtime.failed
          ? `${runtime.failed} 已回退`
          : hasReturned
            ? `${role.returned.length} 位`
            : runtime.queued
              ? `${runtime.queued} 等待`
              : running
                ? '运行中'
                : '待返回';
      return <article className={`content-analysis-role ${state}`} key={role.id}>
        <div className="content-analysis-role-head"><span><Icon size={15} /></span><div><small>{role.caption}</small><strong>{role.label}</strong></div><b>{resultLabel}</b></div>
        <p>{role.description}</p>
        <MultimodalCoverageStrip multimodal={roleMultimodal} label={`${role.label} 的多模态输入`} compact />
        <footer><span>{role.findingCount} 条判断</span><span>{role.evidenceCount} 条证据</span></footer>
      </article>;
    })}</div>
    <div className="content-analysis-note"><ShieldCheck size={15} /><span>{sourceJob ? sourceActive ? `输入批次 ${sourceJob.id.slice(0, 8)} 正在采集，已保存 ${sourceJob.metrics?.visibleContentSamples ?? 0} 条公开内容；当前可浏览，采集完成后可运行内容理解。` : `输入批次 ${sourceJob.id.slice(0, 8)}：只会使用该任务已保存的公开内容快照。` : '先采集公开内容，再选择包含实际样本的任务。'} {job?.artifactsUrl && <a href={job.artifactsUrl} target="_blank" rel="noreferrer">查看任务产物</a>}</span></div>
    {error && !sourceActive && <div className="content-analysis-error"><AlertCircle size={16} /><span><strong>内容理解任务未启动</strong><small>{error}</small></span></div>}
  </section>;
}

function creatorOverviewRecommendation(analysis) {
  const decision = plainObject(analysis?.decision);
  const synthesis = plainObject(analysis?.synthesis);
  const deepInsights = plainObject(analysis?.deepInsights);
  const outreachRole = (Array.isArray(analysis?.roles) ? analysis.roles : []).find((role) => (
    /outreach|connect|合作|建联/i.test(profileText(role?.id))
  ));
  return profileText(firstPresent(
    decision.recommendation,
    decision.nextAction,
    decision.summary,
    synthesis.recommendation,
    synthesis.summary,
    deepInsights.coreNarrative,
    outreachRole?.summary,
  ));
}

function audienceOverviewSummary(insight) {
  if (!insight) return { value: '未导入', note: '尚无聚合粉丝画像' };
  const standard = [insight.gender, insight.age, insight.cityTier, insight.interests, insight.activeHours]
    .filter((entry) => Array.isArray(entry) && entry.length);
  const extra = Array.isArray(insight.dimensions) ? insight.dimensions.filter((entry) => Array.isArray(entry?.entries) && entry.entries.length) : [];
  const groups = [...standard, ...extra].reduce((total, entry) => total + (Array.isArray(entry) ? entry.length : entry.entries.length), 0);
  const coverage = plainObject(insight.coverage);
  const coverageLabel = percentLabel(firstPresent(coverage.coverageRate, coverage.completeness, coverage.confidence));
  return {
    value: `${standard.length + extra.length} 维`,
    note: `${groups} 个分组${coverageLabel ? ` · 覆盖 ${coverageLabel}` : ''}`,
  };
}

function catalogVideoCardForSample(cards, sample) {
  const sampleIndex = Number(sample?.sampleIndex);
  const sourceUrl = profileText(sample?.sourceUrl);
  return cards.find((card) => (
    (Number.isFinite(sampleIndex) && Number(card?.sampleIndex) === sampleIndex)
    || (sourceUrl && profileText(card?.sourceUrl) === sourceUrl)
  ));
}

function contentProcessingFailureReason({ sample, card, interpretation, record }) {
  const video = plainObject(card ? videoCardRecord(card) : null);
  const structured = plainObject(card?.analysisItem);
  const transcript = plainObject(video.transcript);
  const vision = plainObject(video.vision);
  const analysis = plainObject(record?.analysis);
  return profileText(firstPresent(
    sample?.unavailableReason,
    structured.failureReason,
    structured.failure_reason,
    structured.error?.message,
    structured.error,
    video.failureReason,
    video.failure_reason,
    video.error?.message,
    video.error,
    transcript.failureReason,
    transcript.error?.message,
    transcript.error,
    vision.failureReason,
    vision.error?.message,
    vision.error,
    interpretation?.failureReason,
    interpretation?.failure_reason,
    interpretation?.error?.message,
    interpretation?.error,
    analysis.failureReason,
    analysis.error?.message,
    record?.failureReason,
    record?.error?.message,
  ));
}

function contentCatalogEntry({ sample, record, cards }) {
  const analysis = plainObject(record?.analysis);
  const card = catalogVideoCardForSample(cards, sample);
  const videoRecord = card ? videoCardRecord(card) : null;
  const videoState = card ? videoItemAnalysisState(card, videoRecord) : null;
  const interpretation = contentItemInterpretationForSample(record, sample);
  const evidenceIds = new Set([
    ...evidenceTextList(interpretation?.evidenceIds),
    ...(card?.evidenceIds instanceof Set ? [...card.evidenceIds] : evidenceTextList(card?.evidenceIds)),
  ]);
  const findingCount = (Array.isArray(interpretation?.findings) ? interpretation.findings.length : 0)
    + (Array.isArray(card?.findings) ? card.findings.length : 0);
  const failureReason = contentProcessingFailureReason({ sample, card, interpretation, record });
  const hasInterpretation = evidenceIds.size > 0 || findingCount > 0
    || ['completed', 'derived_from_evidence'].includes(profileText(interpretation?.status));
  let state = { id: 'waiting', label: '待内容解读', tone: 'unavailable' };
  if (videoState?.tone === 'complete') state = { id: 'complete', label: videoState.label, tone: 'complete' };
  else if (videoState?.tone === 'pending') state = { id: 'pending', label: videoState.label, tone: 'pending' };
  else if (videoState?.tone === 'failed') state = { id: 'failed', label: videoState.label, tone: 'failed' };
  else if (/(?:failed|error|unavailable)/i.test(`${sample.collectionStatus} ${sample.analysisStatus} ${sample.videoAnalysisStatus}`) || failureReason) state = { id: 'failed', label: '公开内容处理未完成', tone: 'failed' };
  else if (hasInterpretation) state = { id: 'interpreted', label: '公开内容已解读', tone: 'evidence' };
  else if (Object.keys(analysis).length) state = { id: 'waiting', label: '待关联内容证据', tone: 'unavailable' };
  return {
    sample,
    card,
    interpretation,
    evidenceCount: evidenceIds.size,
    findingCount,
    failureReason,
    state,
  };
}

function contentSampleMultimodalCoverage({ sample, card, interpretation, record }) {
  const analysis = plainObject(record?.analysis);
  const video = plainObject(card ? videoCardRecord(card) : null);
  const transcript = plainObject(video.transcript);
  const vision = plainObject(video.vision);
  const visionResult = plainObject(vision.result);
  const evidenceByKey = new Map();
  const addEvidence = (entry, index) => {
    const item = plainObject(entry);
    if (!Object.keys(item).length) return;
    const key = profileText(item.id, `${item.kind || 'evidence'}:${item.sourceUrl || sample?.sourceUrl || ''}:${index}`);
    if (!evidenceByKey.has(key)) evidenceByKey.set(key, item);
  };
  contentAnalysisEvidenceForSample(analysis, sample).forEach(addEvidence);
  (Array.isArray(card?.evidence) ? card.evidence : []).forEach(addEvidence);
  (Array.isArray(interpretation?.evidence) ? interpretation.evidence : []).forEach(addEvidence);
  const evidence = [...evidenceByKey.values()];
  const evidenceCount = (pattern) => evidence.filter((entry) => pattern.test(profileText(firstPresent(
    entry.kind,
    entry.type,
    entry.modality,
    plainObject(entry.metrics).kind,
  )).toLowerCase())).length;
  const frameCount = Array.isArray(video.frames) ? video.frames.length : 0;
  const textCount = [sample?.title, sample?.summary, sample?.detailText]
    .filter((value) => profileText(value).trim()).length;
  const transcriptText = profileText(firstPresent(
    transcript.text,
    transcript.transcript,
    transcript.content,
    transcript.result?.text,
    transcript.result?.transcript,
  ));
  const transcriptSegments = [transcript.segments, transcript.result?.segments, transcript.items]
    .find(Array.isArray) || [];
  const ocrCount = evidenceCount(/ocr|screen[_-]?text|frame[_-]?text/);
  const audioEvidenceCount = evidenceCount(/audio|asr|transcript|speech/);
  const visionEvidenceCount = evidenceCount(/vision|visual|semantic|scene|frame[_-]?analysis/);
  const externalEvidenceCount = evidenceCount(/external|source|context|web/);
  const audioCount = transcriptText || transcriptSegments.length || Object.keys(transcript).length
    ? Math.max(1, transcriptSegments.length)
    : audioEvidenceCount;
  const visionCount = Object.keys(visionResult).length || profileText(firstPresent(vision.summary, vision.description))
    ? Math.max(1, frameCount)
    : visionEvidenceCount;
  const imageCount = Math.max(Number(sample?.imageCount) || 0, Array.isArray(sample?.imageAssets) ? sample.imageAssets.length : 0, frameCount);
  const videoCount = sample?.hasVideo || isVideoContentSample(sample) || Object.keys(video).length ? 1 : 0;
  const fallback = {
    inputMode: '逐条内容证据',
    modalities: {
      text: { count: textCount, status: textCount ? 'available' : 'unavailable' },
      image: { count: imageCount, status: imageCount ? 'available' : 'unavailable' },
      video: { count: videoCount, status: videoCount ? 'available' : 'unavailable' },
      ocr: { count: ocrCount, status: ocrCount ? 'available' : 'unavailable' },
      audio: { count: audioCount, status: audioCount ? 'available' : 'unavailable' },
      vision: { count: visionCount, status: visionCount ? 'available' : 'unavailable' },
      external: { count: sample?.sourceUrl ? Math.max(1, externalEvidenceCount) : externalEvidenceCount, status: sample?.sourceUrl || externalEvidenceCount ? 'available' : 'unavailable' },
    },
    assets: Array.isArray(sample?.imageAssets)
      ? sample.imageAssets.map((asset) => ({ ...plainObject(asset), modality: 'image' }))
      : [],
  };
  const direct = objectSection(
    sample?.multimodal,
    card?.analysisItem?.multimodal,
    video?.multimodal,
    interpretation?.multimodal,
  );
  return mergeMultimodalCoverage(direct, fallback);
}

function CreatorIntelligenceOverview({ persona, record, audienceInsight }) {
  const analysis = plainObject(record?.analysis);
  const video = plainObject(analysis?.video);
  const cards = buildVideoAnalysisCards(analysis, video, persona.visibleSamples);
  const cardStates = cards.map((card) => videoItemAnalysisState(card, videoCardRecord(card)));
  const completedCount = cardStates.filter((state) => state.tone === 'complete').length;
  const evidenceCount = allAnalysisEvidence(analysis).length;
  const findingCount = analysisFindingCount(record);
  const audience = audienceOverviewSummary(audienceInsight);
  const recommendation = creatorOverviewRecommendation(analysis);
  const analysisState = analysisStatusLabel(firstPresent(analysis?.status, record?.status));
  const quality = persona.qualityFacts.join(' · ') || (persona.deep ? '画像字段已回填' : '当前为发现采样');
  const metrics = [
    { label: '公开内容', value: `${persona.visibleSamples.length} 条`, note: persona.visibleSampleCount > persona.visibleSamples.length ? `已保存 ${persona.visibleSamples.length} / 已返回 ${persona.visibleSampleCount}` : '已保存的公开内容快照' },
    { label: '逐视频解读', value: cards.length ? `${completedCount} / ${cards.length}` : '—', note: cards.length ? `${cards.length - completedCount} 条待深度处理` : '未返回可处理视频' },
    { label: '可追溯证据', value: evidenceCount ? `${evidenceCount} 条` : '—', note: evidenceCount ? '内容、视频与角色判断证据' : '尚未返回证据矩阵' },
    { label: '内容判断', value: findingCount ? `${findingCount} 条` : '—', note: analysis ? analysisState : '尚未运行内容理解' },
    { label: '粉丝画像', value: audience.value, note: audience.note },
    { label: '资料质量', value: persona.deep ? '已回填' : '采样中', note: quality },
  ];
  return <section className="creator-intelligence-overview" aria-label={`${persona.displayName} 的达人智能总览`}>
    <header className="creator-intelligence-head"><div><small>CREATOR INTELLIGENCE / DECISION SURFACE</small><strong>达人智能总览</strong><span>把账号、内容、视频证据与粉丝画像放在同一决策视图中</span></div><a href="#content-catalog"><Layers3 size={14} />查看全部内容<ArrowRight size={13} /></a></header>
    <div className="creator-intelligence-metrics">{metrics.map((metric) => <div key={metric.label}><small>{metric.label}</small><strong>{metric.value}</strong><span>{metric.note}</span></div>)}</div>
    <div className="creator-intelligence-decision"><div><span><Sparkles size={14} />AI 合作判断</span><strong>{analysis ? analysisState : '待内容理解'}</strong></div><p>{recommendation || (analysis ? '当前分析任务未返回可展示的合作判断；下方保留逐条内容、视频证据与角色结论供核对。' : '运行内容理解后，这里会基于逐条内容和可追溯证据显示合作切入判断。')}</p><a href="#video-intelligence"><Play size={13} />逐视频证据</a></div>
  </section>;
}

function collectionCompletionLabel(value, hasCapture = false) {
  const status = profileText(value).trim().toLowerCase();
  const labels = {
    retryable: '可续跑',
    continuation_recommended: '可续跑',
    queued: '等待采集',
    pending: '等待采集',
    running: '正在采集公开内容',
    page_exhausted: '公开页已到底',
    target_reached: '完成本次采集目标',
    sample_limit_reached: '达到本次请求上限',
    completed_without_explicit_stop_reason: '采集完成',
    completed_empty: '未返回可用公开内容',
    partial: '部分回填',
    collected: '已回填',
    succeeded: '采集完成',
    completed: '采集完成',
  };
  return labels[status] || (status ? statusLabel(status) : hasCapture ? '已接收采集结果' : '等待采集');
}

function contentCaptureProgress(capture) {
  const content = plainObject(capture?.content);
  const coverage = objectSection(content.collectionCoverage, content.contentCoverage, content.captureCoverage);
  const ledger = plainObject(content.itemLedger);
  const captured = contentCaptureSampleCount(capture);
  const requested = firstNumericMetric(
    coverage.requestedSampleLimit,
    ledger.requestedSampleLimit,
    content.requestedSampleLimit,
  );
  const phaseLabel = collectionCompletionLabel(firstPresent(
    coverage.completion,
    coverage.status,
    coverage.resumeState,
    ledger.status,
    capture?.contentJobStatus,
    capture?.status,
  ), Boolean(capture));
  return {
    captured,
    requested,
    phaseLabel,
    scopeLabel: requested !== null
      ? `已采集公开样本 ${countLabel(captured)} / 本次请求 ${countLabel(requested)}`
      : `已采集公开样本 ${countLabel(captured)}`,
  };
}

function CreatorCollectionCoverage({ persona, contentCapture, contentAnalysisRecord, audienceInsight }) {
  const content = plainObject(contentCapture?.content);
  const collectionCoverage = plainObject(content.collectionCoverage);
  const itemLedger = plainObject(content.itemLedger);
  const ledgerItems = Array.isArray(itemLedger.items) ? itemLedger.items.map((item) => plainObject(item)) : [];
  const numericMaximum = (...values) => Math.max(0, ...values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0));
  const numericFirst = (...values) => values
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value >= 0) ?? 0;
  const observedSamples = numericFirst(
    collectionCoverage.observedVisibleSampleCount,
    itemLedger.observedVisibleSampleCount,
    content.visibleSampleCount,
    persona.visibleSamples.length,
  );
  const uniqueSamples = numericFirst(
    collectionCoverage.uniquePublicContentCount,
    itemLedger.uniquePublicContentCount,
    content.visibleSampleCount,
    persona.visibleSamples.length,
  );
  const duplicateSamples = numericMaximum(
    collectionCoverage.duplicateVisibleReferenceCount,
    itemLedger.duplicateVisibleReferenceCount,
    ledgerItems.filter((item) => profileText(item.status) === 'duplicate_visible_reference').length,
  );
  const unavailableSamples = numericMaximum(
    collectionCoverage.unavailableContentCount,
    itemLedger.unavailableContentCount,
    ledgerItems.filter((item) => Boolean(item.unavailableReason) || /(?:failed|error|unavailable)/i.test(`${profileText(item.status)} ${profileText(item.analysisStatus)}`)).length,
  );
  const publicVideoCandidates = numericMaximum(
    itemLedger.publicVideoCandidateCount,
    ledgerItems.filter((item) => item.videoCandidate === true).length,
  );
  const analysis = plainObject(contentAnalysisRecord?.analysis);
  const cards = buildVideoAnalysisCards(analysis, plainObject(analysis.video), persona.visibleSamples);
  const cardStates = cards.map((card) => videoItemAnalysisState(card, videoCardRecord(card)));
  const completedVideos = cardStates.filter((state) => state.tone === 'complete').length;
  const failedVideos = cardStates.filter((state) => state.tone === 'failed').length;
  const expectedVideos = Math.max(cards.length, publicVideoCandidates);
  const audience = audienceOverviewSummary(audienceInsight);
  const audienceCoverage = plainObject(audienceInsight?.coverage);
  const audienceCoverageLabel = percentLabel(firstPresent(
    audienceCoverage.coverageRate,
    audienceCoverage.completeness,
    audienceCoverage.confidence,
  ));
  const continuationRecommended = collectionCoverage.continuationRecommended === true || itemLedger.continuationRecommended === true;
  const completion = collectionCompletionLabel(firstPresent(
    collectionCoverage.completion,
    collectionCoverage.status,
    itemLedger.status,
    contentCapture?.status,
  ), Boolean(contentCapture));
  const stopReason = profileText(firstPresent(collectionCoverage.stopReason, content.stopReason));
  const requestedLimit = numericMaximum(
    collectionCoverage.requestedSampleLimit,
    itemLedger.requestedSampleLimit,
    content.requestedSampleLimit,
  );
  const capturedScope = requestedLimit
    ? `已采集公开样本 ${uniqueSamples} / 本次请求 ${requestedLimit}`
    : `已采集公开样本 ${uniqueSamples}`;
  const coverageBlocks = [
    {
      caption: 'PROFILE FIELDS',
      label: '达人画像',
      value: persona.deep ? `${persona.observedFields.length} 项已回填` : '等待画像采集',
      note: persona.deep ? '账号、内容、商业和质量字段已保留来源' : '发现候选仅保留当前可见字段',
    },
    {
      caption: 'PUBLIC CONTENT',
      label: '公开内容覆盖',
      value: contentCapture ? capturedScope : '等待采集',
      note: contentCapture
        ? `采集阶段：${completion}${observedSamples !== uniqueSamples ? ` · 页面观察 ${observedSamples} 条` : ''}${continuationRecommended ? ' · 可继续采集' : ''} · 仅代表本次请求内公开样本，不代表账号总作品数`
        : '按当前公开可见页面返回的内容入库',
      detail: duplicateSamples || unavailableSamples || stopReason
        ? `${duplicateSamples ? `去重 ${duplicateSamples}` : ''}${duplicateSamples && unavailableSamples ? ' · ' : ''}${unavailableSamples ? `不可用 ${unavailableSamples}` : ''}${(duplicateSamples || unavailableSamples) && stopReason ? ' · ' : ''}${stopReason || ''}`
        : '',
    },
    {
      caption: 'VIDEO ITEM ANALYSIS',
      label: '逐视频解读',
      value: expectedVideos ? `${completedVideos} / ${expectedVideos}` : '无可处理视频',
      note: expectedVideos
        ? `${failedVideos ? `${failedVideos} 条未完成 · ` : ''}${analysis ? analysisStatusLabel(firstPresent(analysis.status, contentAnalysisRecord?.status)) : '等待逐条内容理解'}`
        : '视频候选由公开内容账本标记',
      detail: failedVideos || unavailableSamples ? `${failedVideos ? `视频未完成 ${failedVideos}` : ''}${failedVideos && unavailableSamples ? ' · ' : ''}${unavailableSamples ? `内容不可用 ${unavailableSamples}` : ''}` : '',
    },
    {
      caption: 'AUDIENCE PROFILE',
      label: '粉丝画像覆盖',
      value: audience.value,
      note: audienceInsight ? `${audience.note}${audienceCoverageLabel ? ` · 覆盖 ${audienceCoverageLabel}` : ''}` : '尚未导入可展示的受众画像数据',
    },
  ];
  return <section className="creator-collection-coverage" aria-label={`${persona.displayName} 的采集与解读覆盖`}>
    <header className="creator-collection-coverage-head"><div><small>COLLECTION COVERAGE / ITEM LEDGER</small><strong>采集与逐内容解读覆盖</strong><span>统计以当前公开可见内容快照、内容账本和逐条分析结果为准。</span></div><b>{contentCapture ? `采集阶段：${completion}` : '待采集'}</b></header>
    <div className="creator-collection-coverage-grid">{coverageBlocks.map((block) => <div className="creator-collection-coverage-block" key={block.caption}><small>{block.caption}</small><strong>{block.label}</strong><b>{block.value}</b><span>{block.note}</span>{block.detail && <em title={block.detail}>{block.detail}</em>}</div>)}</div>
  </section>;
}

function ContentCatalogPanel({ persona, record, contentPageHref }) {
  const [filter, setFilter] = useState('all');
  const [contentRenderLimit, setContentRenderLimit] = useState(60);
  const analysis = plainObject(record?.analysis);
  const cards = buildVideoAnalysisCards(analysis, plainObject(analysis?.video), persona.visibleSamples);
  const entries = persona.visibleSamples.map((sample) => contentCatalogEntry({ sample, record, cards }));
  if (!entries.length) return null;
  const counts = {
    all: entries.length,
    complete: entries.filter((entry) => entry.state.id === 'complete').length,
    evidence: entries.filter((entry) => entry.evidenceCount > 0 || entry.findingCount > 0 || entry.state.id === 'interpreted').length,
    failed: entries.filter((entry) => entry.state.id === 'failed').length,
    pending: entries.filter((entry) => entry.state.id !== 'complete' && entry.state.id !== 'failed').length,
  };
  const filters = [
    { id: 'all', label: '全部内容' },
    { id: 'complete', label: '深度完成' },
    { id: 'evidence', label: '已有证据' },
    { id: 'failed', label: '未完成/失败' },
    { id: 'pending', label: '待深度处理' },
  ];
  const visibleEntries = entries.filter((entry) => (
    filter === 'all'
      || (filter === 'complete' && entry.state.id === 'complete')
      || (filter === 'evidence' && (entry.evidenceCount > 0 || entry.findingCount > 0 || entry.state.id === 'interpreted'))
      || (filter === 'failed' && entry.state.id === 'failed')
      || (filter === 'pending' && entry.state.id !== 'complete' && entry.state.id !== 'failed')
  ));
  useEffect(() => {
    setContentRenderLimit(60);
  }, [filter, persona.identityKey, entries.length]);
  const displayedEntries = visibleEntries.slice(0, contentRenderLimit);
  const hasMoreEntries = displayedEntries.length < visibleEntries.length;
  const canRenderAllEntries = visibleEntries.length <= 500;
  return <section className="content-catalog" id="content-catalog" aria-label={`${persona.displayName} 的全部内容目录`}>
    <div className="content-catalog-head"><div><small>CONTENT CATALOG / ALL CAPTURED SAMPLES</small><strong>全部内容目录</strong><span>逐条展示已保存的公开内容、互动字段、商业标记和处理状态</span></div><div className="content-catalog-count"><strong>{entries.length}</strong><span>条可见内容</span></div></div>
    <div className="content-catalog-tabs" role="tablist" aria-label="内容处理状态筛选">{filters.map((option) => <button className={filter === option.id ? 'active' : ''} key={option.id} type="button" role="tab" aria-selected={filter === option.id} onClick={() => setFilter(option.id)}>{option.label}<b>{counts[option.id]}</b></button>)}</div>
    <div className="content-catalog-list">{displayedEntries.map((entry) => {
      const { sample, card, interpretation, evidenceCount, findingCount, failureReason, state } = entry;
      const multimodal = contentSampleMultimodalCoverage({ sample, card, interpretation, record });
      const contentFacts = [
        sample.contentFormat || sample.contentType || '公开内容',
        sample.publishedAt,
        sample.durationSeconds !== undefined && sample.durationSeconds !== null && sample.durationSeconds !== '' ? `时长 ${videoDurationLabel(sample.durationSeconds)}` : '',
        sample.imageCount ? `${sample.imageCount} 张图片` : '',
        sample.hasVideo ? '视频内容' : '',
        sample.isPinned === true ? '可见置顶' : '',
      ].filter(Boolean);
      const catalogSummary = contentItemSummaryText(interpretation, sample.summary || sample.detailText || '未返回可展示的公开文案。');
      const tags = [...sample.hashtags, ...sample.commercialMarkers.map((marker) => `商业：${marker}`), ...sample.brandMentions.map((brand) => `品牌：${brand}`), ...sample.publicRiskFlags.map((flag) => `风险：${flag}`)];
      const target = card?.sampleIndex ? `#video-sample-${card.sampleIndex}` : '';
      const detailHref = contentPageHref?.(sample);
      return <article className="content-catalog-row" key={sample.id}>
        <div className="content-catalog-index"><b>{String(sample.sampleIndex).padStart(2, '0')}</b><span>{sample.coverUrl ? <img src={sample.coverUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <Play size={15} />}</span></div>
        <div className="content-catalog-main"><div className="content-catalog-title"><strong>{sample.title || '未返回标题的公开内容'}</strong><span className={`content-catalog-status ${state.tone}`}>{state.label}</span></div><p>{catalogSummary}</p><div className="content-catalog-meta">{contentFacts.map((fact, factIndex) => <span key={`${fact}-${factIndex}`}>{fact}</span>)}{sample.interactionFacts.map((fact, factIndex) => <span className="interaction" key={`${fact}-${factIndex}`}>{fact}</span>)}</div>{tags.length > 0 && <div className="content-catalog-tags">{tags.map((tag, tagIndex) => <span key={`${tag}-${tagIndex}`}>{tag}</span>)}</div>}<MultimodalCoverageStrip multimodal={multimodal} label="本条内容多模态输入" compact /></div>
        <div className="content-catalog-evidence"><small>内容解读</small><strong>{findingCount} 条判断</strong><span>{evidenceCount} 条证据</span>{failureReason && <p className="content-catalog-failure" title={failureReason}>{failureReason}</p>}{detailHref && <a className="content-catalog-detail-link" href={detailHref}><FileText size={13} />完整解读页</a>}{target && <a href={target}><Play size={13} />视频证据</a>}{sample.sourceUrl && <a href={sample.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />原内容</a>}</div>
      </article>;
    })}</div>
    {visibleEntries.length > 0 && <div className="content-catalog-more"><span>已显示 {displayedEntries.length} / {visibleEntries.length} 条内容{!canRenderAllEntries ? ' · 大批量内容按页加载' : ''}</span>{hasMoreEntries && <div><button type="button" onClick={() => setContentRenderLimit((limit) => Math.min(limit + 60, visibleEntries.length))}>显示更多 60 条</button>{canRenderAllEntries && <button type="button" className="secondary" onClick={() => setContentRenderLimit(visibleEntries.length)}>全部显示</button>}</div>}</div>}
    {!visibleEntries.length && <div className="content-catalog-empty">当前筛选下没有内容记录。</div>}
  </section>;
}

function CreatorPersonaPanel({ creator, profile, contentCapture, contentAnalysisRecord, contentAnalysisJob, contentAnalysisRunning, enrichmentJob, enrichmentRunning, contentJob, contentRunning, onClose, onEnrich, onCollectContent, audienceInsight, audienceLoading, audienceImporting, audienceError, onImportAudience, onRefreshAudience, standalone = false, creatorPageHref = '', contentPageHref }) {
  const mergedProfile = mergeProfileWithContentCapture(profile, contentCapture);
  const persona = creatorPersona(creator, mergedProfile);
  const profileCreator = { ...creator, name: persona.displayName, avatar: persona.avatar || creator.avatar };
  const captureProgress = contentCaptureProgress(contentCapture);
  const contentSampleCount = captureProgress.captured;
  const profileState = contentCapture ? `${captureProgress.phaseLabel} · ${captureProgress.scopeLabel}` : persona.deep ? '深度数据已回填' : enrichmentRunning ? '达人数据采集中' : '当前为发现采样';
  const handleAudienceFile = (event) => {
    const [file] = event.target.files || [];
    event.currentTarget.value = '';
    if (file) void onImportAudience(creator, file);
  };
  return <aside className="creator-persona" aria-label={`${persona.displayName} 的达人画像`}>
    <div className="persona-head"><div className="persona-identity"><Avatar creator={profileCreator} /><div><div className="persona-kicker"><span className={`profile-state ${persona.deep ? 'ready' : enrichmentRunning ? 'running' : ''}`} title={profileState}>{profileState}</span><ChannelTag platform={creator.platform} /></div><strong>{persona.displayName}</strong><small>{creator.handle || persona.bio || creator.niche}</small></div></div><div className="persona-head-actions">{creator.sourceUrl && <a className="persona-link" href={creator.sourceUrl} target="_blank" rel="noopener noreferrer" title="打开真实平台主页"><ExternalLink size={15} />主页</a>}{creatorPageHref && !standalone && <a className="persona-link" href={creatorPageHref} title="打开独立达人页面"><FileText size={15} />独立页</a>}{onClose && (standalone ? <a className="persona-link persona-back-link" href={onClose}><ArrowLeft size={15} />返回</a> : <button className="icon-btn" onClick={onClose} aria-label="关闭达人画像" title="关闭达人画像"><X size={16} /></button>)}</div></div>
    <div className="persona-main"><div className="persona-summary"><small>CREATOR PERSONA</small><strong>{persona.summary}</strong>{persona.bio && persona.bio !== persona.summary && <p className="persona-bio">{persona.bio}</p>}<p>{persona.style}</p><div className="persona-tags">{persona.topics.length ? persona.topics.map((topic) => <span key={topic}>{topic}</span>) : <span>待采集内容标签</span>}</div>{persona.accountFacts.length > 0 && <div className="persona-facts">{persona.accountFacts.map((fact) => <span key={fact}>{fact}</span>)}</div>}</div><dl className="persona-stats">{persona.dataPoints.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><div className="persona-audience"><small>数据质量与来源证据</small><strong>{persona.qualityFacts.join(' · ') || (persona.deep ? '已回填主页与内容字段' : '待深度采集')}</strong><p>{persona.evidence}</p><span>{persona.metricEvidence}</span>{persona.observedFields.length > 0 && <div className="persona-observed">{persona.observedFields.map((field) => <span key={field}>{field}</span>)}</div>}{enrichmentJob?.id && <span>任务 {enrichmentJob.id.slice(0, 8)} · {statusLabel(enrichmentJob.status)}</span>}</div></div>
    <CreatorIntelligenceOverview persona={persona} record={contentAnalysisRecord} audienceInsight={audienceInsight} />
    <CreatorCollectionCoverage persona={persona} contentCapture={contentCapture} contentAnalysisRecord={contentAnalysisRecord} audienceInsight={audienceInsight} />
    <ContentCatalogPanel persona={persona} record={contentAnalysisRecord} contentPageHref={contentPageHref} />
    <CreatorDimensionPanel creator={creator} persona={persona} audienceInsight={audienceInsight} />
    <PublicProfileEvidencePanel persona={persona} contentCapture={contentCapture} contentJob={contentJob} contentAnalysisRecord={contentAnalysisRecord} onCollectContent={() => onCollectContent([creator.id])} collecting={contentRunning} contentPageHref={contentPageHref} />
    <ContentAnalysisEvidencePanel creator={creator} record={contentAnalysisRecord} job={contentAnalysisJob} running={contentAnalysisRunning} contentSamples={persona.visibleSamples} contentPageHref={contentPageHref} />
    <AudienceInsightPanel creator={creator} insight={audienceInsight} loading={audienceLoading} importing={audienceImporting} error={audienceError} onImport={handleAudienceFile} onRefresh={onRefreshAudience} />
    <CreatorDataLedger creator={creator} profile={mergedProfile} contentCapture={contentCapture} contentAnalysisRecord={contentAnalysisRecord} audienceInsight={audienceInsight} />
    <div className="persona-footer"><span><Layers3 size={15} />{contentCapture ? `公开内容任务已保存${captureProgress.requested !== null ? `本次请求内 ${contentSampleCount} / ${captureProgress.requested} 条` : ` ${contentSampleCount} 条`}可见样本与来源快照；不代表账号总作品数。` : persona.deep ? '画像字段来自达人数据任务与来源快照。' : '当前仅展示本次发现任务返回的真实账号与内容样本。'}</span><button className="bulk-enrich compact" onClick={() => onEnrich([creator.id])} disabled={enrichmentRunning}>{enrichmentRunning ? <LoaderCircle className="spin" size={15} /> : <DatabaseZap size={15} />}{persona.deep ? '更新数据' : '采集达人数据'}</button></div>
  </aside>;
}

function EntityPageShell({ eyebrow, title, subtitle, creator, backHref, actions, children }) {
  return <div className="entity-page">
    <header className="entity-page-topbar">
      <a className="entity-page-back" href={backHref}><ArrowLeft size={16} />返回工作台</a>
      <div className="entity-page-brand"><span>A</span><div><strong>aftercode</strong><small>DETAIL PAGE</small></div></div>
    </header>
    <main className="entity-page-main">
      <div className="entity-page-crumb"><span>{eyebrow}</span>{creator && <div><ChannelTag platform={creator.platform || creator.channel} /><small>{creator.name || '任务快照'}</small></div>}</div>
      <section className="entity-page-hero">
        <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
        {actions && <div className="entity-page-actions">{actions}</div>}
      </section>
      <div className="entity-page-body">{children}</div>
    </main>
  </div>;
}

function EntityPageLoading({ backHref }) {
  return <EntityPageShell eyebrow="DETAIL SNAPSHOT" title="正在恢复页面快照" subtitle="读取活动、任务版本和已保存的内容证据。" backHref={backHref}>
    <section className="entity-page-state entity-page-loading"><LoaderCircle className="spin" size={20} /><div><strong>正在加载独立页面</strong><p>任务版本会按链接中的标识恢复，不会混入其他活动的数据。</p></div></section>
  </EntityPageShell>;
}

function EntityPageEmpty({ title, detail, backHref }) {
  return <EntityPageShell eyebrow="DETAIL SNAPSHOT" title={title} subtitle="独立页面只展示链接指定的活动与任务快照。" backHref={backHref}>
    <section className="entity-page-state entity-page-empty"><AlertCircle size={20} /><div><strong>{title}</strong><p>{detail}</p><a className="entity-page-action" href={backHref}><ArrowLeft size={14} />返回工作台</a></div></section>
  </EntityPageShell>;
}

function CreatorDetailPage({ creator, profile, contentCapture, contentAnalysisRecord, contentAnalysisJob, contentAnalysisRunning, enrichmentJob, enrichmentRunning, contentJob, contentRunning, audienceInsight, audienceLoading, audienceImporting, audienceError, onImportAudience, onRefreshAudience, onEnrich, onCollectContent, backHref, creatorHref, contentPageHref }) {
  const contentCount = publicContentSamples(contentCapture?.content?.visibleSamples).length;
  const actions = <>
    {creator.sourceUrl && <a className="entity-page-action" href={creator.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />真实主页</a>}
    {contentCount > 0 && <a className="entity-page-action" href="#content-catalog"><Layers3 size={14} />全部内容 {contentCount}</a>}
  </>;
  return <EntityPageShell eyebrow="CREATOR INTELLIGENCE" title={creator.name || '达人画像'} subtitle={`${creator.platform || creator.channel || '渠道'} · 已保存的账号画像、粉丝画像、内容账本与 Agent 解读`} creator={creator} backHref={backHref} actions={actions}>
    <CreatorPersonaPanel
      creator={creator}
      profile={profile}
      contentCapture={contentCapture}
      contentAnalysisRecord={contentAnalysisRecord}
      contentAnalysisJob={contentAnalysisJob}
      contentAnalysisRunning={contentAnalysisRunning}
      enrichmentJob={enrichmentJob}
      enrichmentRunning={enrichmentRunning}
      contentJob={contentJob}
      contentRunning={contentRunning}
      onClose={backHref}
      onEnrich={onEnrich}
      onCollectContent={onCollectContent}
      audienceInsight={audienceInsight}
      audienceLoading={audienceLoading}
      audienceImporting={audienceImporting}
      audienceError={audienceError}
      onImportAudience={onImportAudience}
      onRefreshAudience={onRefreshAudience}
      standalone
      creatorPageHref={creatorHref}
      contentPageHref={contentPageHref}
    />
  </EntityPageShell>;
}

function ContentDetailPage({ creator, profile, contentCapture, contentAnalysisRecord, contentAnalysisJob, contentJob, sample, backHref, creatorHref }) {
  const mergedProfile = mergeProfileWithContentCapture(profile, contentCapture);
  const persona = creatorPersona(creator, mergedProfile);
  const analysis = plainObject(contentAnalysisRecord?.analysis);
  const video = plainObject(analysis?.video);
  const interpretation = contentItemInterpretationForSample(contentAnalysisRecord, sample);
  const intelligentSummary = contentItemSummaryText(interpretation, sample.summary || sample.detailText || '未返回可展示的内容摘要。');
  const cards = buildVideoAnalysisCards(analysis, video, persona.visibleSamples);
  const matchingCard = cards.find((card) => {
    const cardSample = plainObject(card?.sourceSample);
    return (detailContentIdentifier(cardSample) && detailContentIdentifier(cardSample) === detailContentIdentifier(sample))
      || (sample.sourceUrl && profileText(cardSample.sourceUrl) === sample.sourceUrl)
      || Number(firstPresent(cardSample.sampleIndex, card?.sampleIndex)) === Number(sample.sampleIndex);
  });
  const multimodal = contentSampleMultimodalCoverage({ sample, card: matchingCard, interpretation, record: contentAnalysisRecord });
  const facts = [
    sample.contentFormat || sample.contentType || '公开内容',
    sample.publishedAt,
    sample.durationSeconds !== undefined && sample.durationSeconds !== null && sample.durationSeconds !== '' ? `时长 ${videoDurationLabel(sample.durationSeconds)}` : '',
    sample.imageCount ? `${sample.imageCount} 张图片` : '',
    sample.hasVideo ? '视频内容' : '',
    sample.isPinned === true ? '可见置顶' : '',
  ].filter(Boolean);
  const actions = <>
    {creatorHref && <a className="entity-page-action" href={creatorHref}><Users size={14} />达人页面</a>}
    {sample.sourceUrl && <a className="entity-page-action" href={sample.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />原内容</a>}
  </>;
  return <EntityPageShell eyebrow="CONTENT INTERPRETATION" title={sample.title || `内容样本 ${sample.sampleIndex}`} subtitle={`${creator.name || '达人'} · 单条内容独立解读与可追溯证据`} creator={creator} backHref={backHref} actions={actions}>
    <section className="content-detail-overview" aria-label="内容快照总览">
      <div><small>CONTENT SNAPSHOT / ITEM {sample.sampleIndex}</small><strong>{intelligentSummary}</strong></div>
      {facts.length > 0 && <div className="content-detail-facts">{facts.map((fact) => <span key={fact}>{fact}</span>)}</div>}
      <MultimodalCoverageStrip multimodal={multimodal} label="本条内容实际进入分析的多模态输入" />
    </section>
    <ContentSampleInterpretation record={contentAnalysisRecord} sample={sample} contentCapture={contentCapture} standalone />
    {matchingCard && <section className="content-detail-video" id="content-video-evidence"><VideoEvidencePanel video={video} analysis={analysis} contentSamples={[sample]} cards={[matchingCard]} jobId={contentAnalysisJob?.id} showRollup={false} /></section>}
    {sample.hasVideo && !matchingCard && <section className="content-detail-unavailable" id="content-video-evidence"><Play size={17} /><div><strong>该视频尚未返回独立多模态结果</strong><p>本页仍保留正文、互动字段和已关联的 Agent 判断；关键帧、OCR、转写或视觉语义会在对应视频任务完成后写入此页。</p></div></section>}
    {contentJob?.id && <div className="content-detail-artifacts"><FileText size={14} /><span>内容采集任务 {contentJob.id.slice(0, 8)}</span><a href={contentJob.artifactsUrl || `/api/jobs/${encodeURIComponent(contentJob.id)}/artifacts`} target="_blank" rel="noreferrer">查看来源快照</a></div>}
  </EntityPageShell>;
}

function CreatorDimensionPanel({ creator, persona, audienceInsight }) {
  const dimensions = creatorDimensionGroups({ creator, persona, audienceInsight });
  if (!dimensions.length) return null;
  const observedCount = dimensions.filter((dimension) => dimension.observed).length;
  const icons = {
    account: Target,
    identity: Target,
    'account-scale': Users,
    content: Layers3,
    positioning: Gauge,
    'content-format': Layers3,
    cadence: Clock3,
    engagement: Activity,
    'engagement-efficiency': Activity,
    commercial: CircleDollarSign,
    'commercial-evidence': Link2,
    audience: Users,
    'audience-demographics': Users,
    'audience-preferences': Sparkles,
    growth: TrendingUp,
    quality: ShieldCheck,
  };
  return <section className="persona-dimensions" aria-label={`${persona.displayName} 的扩展画像维度`}>
    <div className="persona-dimensions-head"><div><small>EXPANDED CREATOR PROFILE</small><strong>达人画像维度</strong><span>账号、内容、互动、商业、受众、趋势、风险与数据质量字段</span></div><b>{observedCount} / {dimensions.length} 已返回</b></div>
    <div className="persona-dimension-grid">{dimensions.map((dimension) => {
      const Icon = icons[dimension.id] || Gauge;
      return <article className={`persona-dimension-card ${dimension.id} ${dimension.observed ? 'is-observed' : 'is-missing'}`} key={dimension.id}>
        <div className="persona-dimension-title"><span><Icon size={15} /></span><div><small>{dimension.caption}</small><strong>{dimension.title}</strong></div><b className={`persona-dimension-status ${dimension.observed ? 'observed' : 'missing'}`}>{dimension.observed ? '已返回' : '未返回'}</b></div>
        {dimension.facts.length > 0 && <dl className="persona-dimension-facts">{dimension.facts.map((fact) => <div key={`${fact.label}-${fact.value}`}><dt>{fact.label}</dt><dd>{fact.value}</dd>{fact.note && <small>{fact.note}</small>}</div>)}</dl>}
        {dimension.tags.length > 0 && <div className="persona-dimension-tags">{dimension.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
        <p className="persona-dimension-source"><span>来源</span>{dimension.basis}</p>
      </article>;
    })}</div>
  </section>;
}

const CONTENT_EVIDENCE_KIND_LABELS = {
  visible_content_text: '公开文本',
  visible_content_format: '内容形态',
  visible_content_tags: '公开话题',
  visible_content_interactions: '公开互动',
  explicit_commercial_markers: '商业标记',
  explicit_public_risk_flags: '公开风险标记',
  rendered_video_metadata: '视频媒体元数据',
  local_media_probe: '本地媒体探测',
  local_media_cache: '本地媒体缓存',
  sampled_video_frame_ocr: '关键帧 OCR',
  local_video_visual_semantics: '视频画面语义',
  local_video_frame_semantics: '逐帧画面语义',
  local_audio_transcript: '音轨转写',
  local_audio_transcript_segment: '转写时间片段',
  external_video_context: '外部视频上下文',
  external_video_summary: '外部视频摘要',
};

function contentEvidenceKindLabel(kind) {
  return CONTENT_EVIDENCE_KIND_LABELS[profileText(kind)] || profileText(kind, '内容证据');
}

function contentItemAnalysisStatusLabel(status) {
  return {
    completed: '逐条解读完成',
    derived_from_evidence: '已关联现有证据',
    insufficient_visible_fields: '公开字段不足',
    not_linked: '未关联证据',
    waiting_analysis: '待逐条解读',
    stale_source_changed: '内容已更新，需重新解读',
  }[profileText(status)] || '待逐条解读';
}

function allAnalysisEvidence(analysis) {
  const byId = new Map();
  const add = (entry) => {
    const id = profileText(entry?.id);
    if (id && !byId.has(id)) byId.set(id, entry);
  };
  (Array.isArray(analysis?.evidence) ? analysis.evidence : []).forEach(add);
  (Array.isArray(analysis?.roles) ? analysis.roles : []).forEach((role) => {
    (Array.isArray(role?.evidence) ? role.evidence : []).forEach(add);
  });
  return [...byId.values()];
}

function contentAnalysisEvidenceForSample(analysis, sample) {
  const sourceUrl = profileText(sample?.sourceUrl);
  const sampleIndex = Number(sample?.sampleIndex);
  const evidence = allAnalysisEvidence(analysis);
  const sourceMatched = sourceUrl
    ? evidence.filter((entry) => profileText(entry?.sourceUrl) === sourceUrl)
    : [];
  if (sourceMatched.length) return sourceMatched;
  return Number.isFinite(sampleIndex)
    ? evidence.filter((entry) => Number(entry?.sampleIndex) === sampleIndex)
    : [];
}

function contentItemInterpretationForSample(record, sample) {
  const analysis = plainObject(record?.analysis);
  const sampleIndex = Number(sample?.sampleIndex);
  const stored = contentAnalysisItemForSample(analysis, sample);
  const sourceChanged = profileText(analysis?.source?.freshness) === 'stale_source_changed';
  if (stored && !sourceChanged) return stored;

  if (sourceChanged) {
    return {
      id: `sample:${sampleIndex || sample?.id || 'unknown'}`,
      sampleIndex,
      sourceUrl: sample?.sourceUrl || null,
      status: 'stale_source_changed',
      coverage: { observedFields: [], evidenceCount: 0, videoEvidenceCount: 0, findingCount: 0 },
      summary: '内容采集快照已更新。为避免将旧快照的结论误配到当前内容，需重新运行内容解读。',
      activationGuidance: '完成本轮内容解读后，再基于当前条目的证据生成建联切入点。',
      signals: [],
      findings: [],
      limitations: ['当前页面保留最新采集内容；先前分析快照已过期，旧证据不会在此条内容上复用。'],
      evidenceIds: [],
    };
  }

  const evidence = contentAnalysisEvidenceForSample(analysis, sample);
  const evidenceIds = evidence.map((entry) => profileText(entry?.id)).filter(Boolean);
  const evidenceIdSet = new Set(evidenceIds);
  const findings = (Array.isArray(analysis?.roles) ? analysis.roles : []).flatMap((role) => (
    (Array.isArray(role?.findings) ? role.findings : []).map((finding, index) => {
      const findingEvidenceIds = (Array.isArray(finding?.evidenceIds) ? finding.evidenceIds : [])
        .map((id) => profileText(id)).filter(Boolean);
      const matchingEvidenceIds = findingEvidenceIds.filter((id) => evidenceIdSet.has(id));
      if (!matchingEvidenceIds.length) return null;
      return {
        id: `${profileText(role?.id, 'role')}:${profileText(finding?.id, String(index + 1))}`,
        roleId: profileText(role?.id),
        roleLabel: profileText(role?.label, '内容理解 Agent'),
        scope: matchingEvidenceIds.length === findingEvidenceIds.length ? 'sample' : 'cross_sample',
        statement: profileText(finding?.statement),
        metric: finding?.metric,
        evidenceIds: matchingEvidenceIds,
      };
    })
  )).filter(Boolean);
  const evidenceGroups = new Map();
  evidence.forEach((entry) => {
    const kind = profileText(entry?.kind, 'content_evidence');
    const group = evidenceGroups.get(kind) || { id: kind, label: contentEvidenceKindLabel(kind), count: 0, evidenceIds: [] };
    group.count += 1;
    group.evidenceIds.push(profileText(entry?.id));
    evidenceGroups.set(kind, group);
  });
  const signals = [...evidenceGroups.values()].map((group) => ({
    ...group,
    statement: `本条内容已关联 ${group.count} 条${group.label}，可在下方展开核对原始字段与采集依据。`,
  }));
  const hasAnalysis = Boolean(Object.keys(analysis).length);
  return {
    id: `sample:${sampleIndex || sample?.id || 'unknown'}`,
    sampleIndex,
    sourceUrl: sample?.sourceUrl || null,
    status: evidenceIds.length ? 'derived_from_evidence' : hasAnalysis ? 'not_linked' : 'waiting_analysis',
    coverage: {
      observedFields: [],
      evidenceCount: evidenceIds.length,
      videoEvidenceCount: evidenceIds.filter((id) => id.startsWith(`video:sample:${sampleIndex}:`)).length,
      findingCount: findings.length,
    },
    summary: evidenceIds.length
      ? `当前内容已从既有分析批次关联 ${evidenceIds.length} 条可追溯证据和 ${findings.length} 条 Agent 判断。`
      : hasAnalysis
        ? '当前分析批次未找到与该条内容关联的可追溯证据。'
        : '该条内容尚未进入内容理解任务。',
    activationGuidance: evidenceIds.length
      ? '建联时可围绕本条已采集内容的具体表达和证据提问，并由人工确认合作意愿。'
      : '先补齐该条内容的公开文本或多模态证据，再形成针对性建联切入。',
    signals,
    findings,
    limitations: [],
    evidenceIds,
  };
}

function contentItemEvidenceEntries(analysis, item, sample) {
  if (profileText(analysis?.source?.freshness) === 'stale_source_changed') return [];
  const all = allAnalysisEvidence(analysis);
  const byId = new Map(all.map((entry) => [profileText(entry?.id), entry]));
  const explicit = (Array.isArray(item?.evidenceIds) ? item.evidenceIds : [])
    .map((id) => byId.get(profileText(id)))
    .filter(Boolean);
  return explicit.length ? explicit : contentAnalysisEvidenceForSample(analysis, sample);
}

function contentItemMetricLabel(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return profileText(value);
    }
  }
  return profileText(value);
}

function contentSegmentRangeLabel(segment) {
  const start = videoDurationLabel(segment?.startSeconds);
  const end = videoDurationLabel(segment?.endSeconds);
  if (start && end) return start === end ? start : `${start} - ${end}`;
  return start ? `起始 ${start}` : end ? `截至 ${end}` : '';
}

function ContentSegmentationPanel({ item, segments, standalone = false }) {
  const entries = Array.isArray(segments) ? segments : [];
  const declaredCount = contentItemSegmentCount(item, entries);
  const timedSegmentCount = entries.filter((segment) => (
    Number.isFinite(Number(segment?.startSeconds))
    || Number.isFinite(Number(segment?.endSeconds))
    || /timeline|transcript|audio/i.test(profileText(segment?.kind))
  )).length;
  const semanticSegmentCount = Math.max(0, entries.length - timedSegmentCount);
  const orderedEntries = [...entries].sort((left, right) => {
    const leftTimed = Number.isFinite(Number(left?.startSeconds));
    const rightTimed = Number.isFinite(Number(right?.startSeconds));
    if (leftTimed && rightTimed) return Number(left.startSeconds) - Number(right.startSeconds);
    if (leftTimed) return 1;
    if (rightTimed) return -1;
    return 0;
  });
  const kindCounts = new Map();
  entries.forEach((segment) => {
    const kind = profileText(segment?.kind, 'content_segment');
    kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
  });
  const kindSummary = [...kindCounts.entries()]
    .map(([kind, count]) => `${contentSegmentKindLabel(kind)} ${count}`)
    .join(' · ');
  const segmentationSummary = [
    semanticSegmentCount ? `语义片段 ${semanticSegmentCount}` : '',
    timedSegmentCount ? `时间轴片段 ${timedSegmentCount}` : '',
    kindSummary,
  ].filter(Boolean).join(' · ');
  const countLabel = declaredCount > entries.length
    ? `已展示 ${entries.length} / ${declaredCount} 段`
    : `${entries.length} 段`;
  return <details className="content-segmentation" open={standalone}>
    <summary><span><small>CONTENT SEGMENTATION / TRACEABLE</small><strong>内容切分</strong></span><b>{countLabel}</b></summary>
    <div className="content-segmentation-body">
      <div className="content-segmentation-overview"><span>片段类型</span><strong>{segmentationSummary || '当前未返回可展示片段类型'}</strong></div>
      {orderedEntries.length > 0 ? <ol className="content-segment-list">{orderedEntries.map((segment, index) => {
        const timeRange = contentSegmentRangeLabel(segment);
        const statusClass = profileText(segment.status).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'available';
        return <li key={`${segment.id}-${index}`}>
          <header><div><small>{contentSegmentKindLabel(segment.kind)} · 片段 {index + 1}</small>{timeRange && <time>{timeRange}</time>}</div><b className={`content-segment-status ${statusClass}`}>{contentSegmentStatusLabel(segment.status)}</b></header>
          <p>{profileText(segment.text, '该片段未返回可展示文本。')}</p>
          <footer><span>来源字段</span><code>{profileText(segment.sourceField, '未返回')}</code>{segment.sourceUrl && <a href={segment.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} />来源</a>}</footer>
        </li>;
      })}</ol> : <p className="content-segmentation-empty">{declaredCount ? `当前快照标记为 ${declaredCount} 段，但尚未返回每段的文本、时间或来源字段。` : '当前采集/分析结果尚未返回可展示的内容片段。'}</p>}
    </div>
  </details>;
}

function ContentSampleInterpretation({ record, sample, contentCapture, standalone = false }) {
  const analysis = plainObject(record?.analysis);
  const item = contentItemInterpretationForSample(record, sample);
  const evidence = contentItemEvidenceEntries(analysis, item, sample);
  const segments = contentSegmentsForSample({ contentCapture, record, sample, interpretation: item });
  const intelligentSummary = contentItemSummaryText(item, '未返回逐条解读。');
  const signals = Array.isArray(item?.signals) ? item.signals : [];
  const findings = Array.isArray(item?.findings) ? item.findings : [];
  const limitations = Array.isArray(item?.limitations) ? item.limitations.map((value) => profileText(value)).filter(Boolean) : [];
  const fullFields = [
    ['正文', sample.detailText],
    ['时长', sample.durationSeconds === undefined || sample.durationSeconds === null || sample.durationSeconds === '' ? '' : `${sample.durationSeconds} 秒`],
    ['置顶', sample.isPinned === null ? '' : sample.isPinned ? '是' : '否'],
    ['公开话题', sample.hashtags.join(' · ')],
    ['全部互动字段', sample.allInteractionFacts.join(' · ')],
    ['商业标记', sample.commercialMarkers.join(' · ')],
    ['品牌提及', sample.brandMentions.join(' · ')],
    ['公开风险标记', sample.publicRiskFlags.join(' · ')],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  const hasVideoEvidence = evidence.some((entry) => profileText(entry?.id).startsWith(`video:sample:${sample.sampleIndex}:`));
  return <section className="content-item-analysis" aria-label={`内容样本 ${sample.sampleIndex} 的逐条解读`}>
    <div className="content-item-analysis-head"><div><small>ITEM INTERPRETATION / SAMPLE {sample.sampleIndex}</small><strong>逐条内容解读</strong></div><b className={`content-item-analysis-status ${profileText(item?.status)}`}>{contentItemAnalysisStatusLabel(item?.status)}</b></div>
    <div className="content-item-summary-block"><small>INTELLIGENT SUMMARY / ITEM LEVEL</small><p className="content-item-analysis-summary">{intelligentSummary}</p></div>
    <ContentSegmentationPanel item={item} segments={segments} standalone={standalone} />
    {signals.length > 0 && <div className="content-item-analysis-signals">{signals.map((signal, index) => <div key={signal.id || `signal-${index}`}><small>{profileText(signal.label, '证据线索')}</small><strong>{profileText(signal.statement)}</strong>{signal.metric !== undefined && signal.metric !== null && <span>{contentItemMetricLabel(signal.metric)}</span>}</div>)}</div>}
    {item?.activationGuidance && <p className="content-item-analysis-guidance"><Sparkles size={13} />{profileText(item.activationGuidance)}</p>}
    {hasVideoEvidence && <a className="content-item-video-link" href={standalone ? '#content-video-evidence' : `#video-sample-${sample.sampleIndex}`}><Play size={13} />查看本条视频的多模态解读</a>}
    <details className="content-item-analysis-details" open={standalone}><summary>完整关联判断与证据 <span>{findings.length} 条判断 · {evidence.length} 条证据</span></summary>
      {findings.length > 0 ? <ol className="content-item-findings">{findings.map((finding, index) => <li key={finding.id || `finding-${index}`}><div><small>{profileText(finding.roleLabel, '内容理解 Agent')} · {finding.scope === 'cross_sample' ? '跨内容判断' : '本条判断'}</small><strong>{profileText(finding.statement)}</strong></div>{finding.metric !== undefined && finding.metric !== null && <span>{contentItemMetricLabel(finding.metric)}</span>}{finding.evidenceIds?.length ? <small>证据 {finding.evidenceIds.join(' · ')}</small> : null}</li>)}</ol> : <p className="content-item-empty">本条内容尚未被角色结论直接引用；下方仍保留所有可关联的原始证据。</p>}
      {evidence.length > 0 ? <ol className="content-item-evidence-list">{evidence.map((entry, index) => <li key={profileText(entry?.id, `evidence-${index}`)}><div><small>{contentEvidenceKindLabel(entry?.kind)} · {profileText(entry?.id)}</small>{entry?.sourceUrl && <a href={entry.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} />来源</a>}</div>{entry?.excerpt && <p>{profileText(entry.excerpt)}</p>}{Object.keys(plainObject(entry?.metrics)).length > 0 && <span>{contentItemMetricLabel(entry.metrics)}</span>}{entry?.basis && <small>{profileText(entry.basis)}</small>}</li>)}</ol> : <p className="content-item-empty">当前没有可展开的逐条证据。</p>}
      {fullFields.length > 0 && <dl className="content-item-full-fields">{fullFields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{profileText(value)}</dd></div>)}</dl>}
      {limitations.length > 0 && <p className="content-item-limitations">局限：{limitations.join(' · ')}</p>}
    </details>
  </section>;
}

function PublicProfileEvidencePanel({ persona, contentCapture, contentJob, contentAnalysisRecord, onCollectContent, collecting, contentPageHref }) {
  const [expandedContentSampleIds, setExpandedContentSampleIds] = useState(() => new Set());
  useEffect(() => {
    setExpandedContentSampleIds(new Set());
  }, [persona.identityKey]);
  const hasPublicFields = persona.visibleMetrics.length || persona.publicAudienceSignals.length
    || persona.sampleInteractionFacts.length || persona.visibleSamples.length;
  if (!hasPublicFields) return null;
  const storedSampleCount = persona.visibleSamples.length;
  const reportedSampleCount = Number(persona.visibleSampleCount);
  const sampleCountLabel = Number.isFinite(reportedSampleCount) && reportedSampleCount > storedSampleCount
    ? `已保存 ${storedSampleCount} / 已返回 ${reportedSampleCount} 条样本`
    : `已保存 ${storedSampleCount} 条样本`;
  const artifactUrl = contentJob?.id ? `/api/jobs/${encodeURIComponent(contentJob.id)}/artifacts` : '';
  return <section className="public-evidence" aria-label={`${persona.displayName} 的公开数据样本`}>
    <div className="public-evidence-head"><div><small>PUBLIC PROFILE / VISIBLE CONTENT</small><strong>公开资料与内容样本</strong><span>{sampleCountLabel}，完整字段见下方数据账本</span></div><div className="public-evidence-actions">{onCollectContent && <button onClick={onCollectContent} disabled={collecting} title="重新采集该达人公开可见内容">{collecting ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{collecting ? '采集中' : '刷新内容'}</button>}{artifactUrl && <a href={artifactUrl} target="_blank" rel="noreferrer" title="查看本次采集的来源快照"><FileText size={14} />来源快照</a>}</div></div>
    <div className="public-evidence-meta">
      <div><small>PROFILE METRICS</small><strong>主页可见指标</strong><p>{persona.visibleMetrics.length ? persona.visibleMetrics.map((metric) => <span key={metric}>{metric}</span>) : '未返回'}</p></div>
      <div><small>PUBLIC SIGNALS</small><strong>页面可见受众信号</strong><p>{persona.publicAudienceSignals.length ? persona.publicAudienceSignals.map((signal) => <span key={signal}>{signal}</span>) : '未返回'}</p></div>
      <div><small>SAMPLE INTERACTIONS</small><strong>内容样本互动汇总</strong><p>{persona.sampleInteractionFacts.length ? persona.sampleInteractionFacts.map((fact) => <span key={fact}>{fact}</span>) : '未返回'}</p></div>
    </div>
    {persona.visibleSamples.length > 0 && <div className="public-content-list">{persona.visibleSamples.map((sample) => {
      const sampleKey = String(firstPresent(sample.id, sample.sourceUrl, sample.sampleIndex));
      const isExpanded = expandedContentSampleIds.has(sampleKey);
      const detailHref = contentPageHref?.(sample);
      const toggleExpanded = () => setExpandedContentSampleIds((current) => {
        const next = new Set(current);
        if (next.has(sampleKey)) next.delete(sampleKey);
        else next.add(sampleKey);
        return next;
      });
      return <article className="public-content-sample" key={sample.id}>
      <div className="public-content-sample-top"><small>{[sample.contentType, sample.publishedAt].filter(Boolean).join(' · ') || '公开内容样本'}</small>{sample.sourceUrl && <a href={sample.sourceUrl} target="_blank" rel="noreferrer" title="打开真实内容来源"><ExternalLink size={13} />来源</a>}</div>
      <strong>{sample.title || '未返回标题的公开内容'}</strong>{sample.summary && <p>{sample.summary}</p>}
      {(sample.hashtags.length > 0 || sample.interactionFacts.length > 0) && <div className="public-content-facts">{sample.hashtags.map((tag) => <span className="public-content-tag" key={tag}>{tag}</span>)}{sample.interactionFacts.map((fact) => <span key={fact}>{fact}</span>)}</div>}
      <div className="public-content-sample-actions">{detailHref && <a className="public-content-page-link" href={detailHref}><FileText size={13} />独立解读页</a>}<button className="public-content-sample-toggle" type="button" aria-expanded={isExpanded} onClick={toggleExpanded}><ChevronDown size={14} />{isExpanded ? '收起逐条解读' : '展开逐条解读'}</button></div>
      {isExpanded && <ContentSampleInterpretation record={contentAnalysisRecord} sample={sample} contentCapture={contentCapture} />}
    </article>;
    })}</div>}
  </section>;
}

const LEDGER_SENSITIVE_FIELD = /(token|cookie|authorization|password|passwd|secret|api[_-]?key|session)/i;

const LEDGER_FIELD_LABELS = {
  id: '记录 ID',
  creatorId: '达人 ID',
  creatorName: '达人名称',
  discoveryJobId: '发现任务 ID',
  capturedAt: '采集时间',
  sourceUrl: '来源链接',
  sourceUrls: '来源链接',
  visibleSamples: '公开内容样本',
  audienceInsight: '聚合粉丝画像',
  dataScope: '数据范围',
  totalAudience: '受众总量',
  sampleSize: '样本量',
  coverageRate: '覆盖率',
  completeness: '完整度',
  confidence: '置信度',
};

function sanitizeLedgerValue(value, seen = new WeakSet()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => {
    const sanitized = sanitizeLedgerValue(item, seen);
    return sanitized === undefined ? null : sanitized;
  });
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (LEDGER_SENSITIVE_FIELD.test(key)) return [];
    const sanitized = sanitizeLedgerValue(item, seen);
    return sanitized === undefined ? [] : [[key, sanitized]];
  }));
}

function ledgerScalar(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function ledgerTitle(key) {
  return LEDGER_FIELD_LABELS[key]
    || String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
}

function ledgerValueCount(value) {
  if (Array.isArray(value)) return value.reduce((total, item) => total + ledgerValueCount(item), 0) || 1;
  if (value && typeof value === 'object') return Object.values(value).reduce((total, item) => total + ledgerValueCount(item), 0) || 1;
  return 1;
}

function LedgerScalar({ value }) {
  const label = ledgerScalar(value);
  if (/^https?:\/\/\S+$/i.test(label)) return <a href={label} target="_blank" rel="noreferrer">{label}</a>;
  return <span className="ledger-scalar">{label}</span>;
}

function LedgerValue({ value, path }) {
  if (Array.isArray(value)) {
    if (!value.length) return <span className="ledger-empty">[]</span>;
    return <ol className="ledger-array">{value.map((item, index) => <li key={`${path}-${index}`}><span className="ledger-array-index">{index + 1}</span><LedgerValue value={item} path={`${path}-${index}`} /></li>)}</ol>;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return <span className="ledger-empty">&#123;&#125;</span>;
    return <dl className="ledger-object">{entries.map(([key, item]) => {
      const compound = Array.isArray(item) || (item && typeof item === 'object');
      const title = ledgerTitle(key);
      return <div className={`ledger-field ${compound ? 'compound' : ''}`} key={`${path}-${key}`}><dt><strong>{title}</strong>{title !== key && <small>{key}</small>}</dt><dd><LedgerValue value={item} path={`${path}-${key}`} /></dd></div>;
    })}</dl>;
  }
  return <LedgerScalar value={value} />;
}

function CreatorDataLedger({ creator, profile, contentCapture, contentAnalysisRecord, audienceInsight }) {
  const [expandedSections, setExpandedSections] = useState(() => new Set());
  const discoveryRecord = { ...plainObject(creator) };
  delete discoveryRecord.contentCapture;
  delete discoveryRecord.persona;
  const normalizedContentCapture = contentCapture
    ? { ...plainObject(contentCapture), profile: plainObject(profile?.profile) }
    : contentCapture;
  const sections = [
    { id: 'discovery', title: '发现候选记录', caption: 'DISCOVERY RECORD', value: discoveryRecord },
    { id: 'profile', title: '归一化达人画像', caption: 'NORMALIZED PROFILE', value: profile },
    { id: 'content', title: '公开内容采集快照', caption: 'PUBLIC CONTENT CAPTURE', value: normalizedContentCapture },
    { id: 'analysis', title: '内容理解结果', caption: 'CONTENT ANALYSIS', value: contentAnalysisRecord },
    { id: 'audience', title: '聚合粉丝画像', caption: 'AUDIENCE AGGREGATE', value: audienceInsight },
  ].map((section) => {
    const value = sanitizeLedgerValue(section.value);
    const available = Boolean(value && (Array.isArray(value) ? value.length : Object.keys(value).length));
    return { ...section, value, available };
  });
  const snapshot = Object.fromEntries(sections.map((section) => [section.id, section.value]));
  const fieldCount = sections.reduce((total, section) => total + ledgerValueCount(section.value), 0);
  const allExpanded = sections.length > 0 && sections.every((section) => expandedSections.has(section.id));
  const setSectionExpanded = (id, open) => {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const toggleAllSections = () => {
    setExpandedSections(allExpanded ? new Set() : new Set(sections.map((section) => section.id)));
  };
  return <section className="creator-data-ledger" aria-label={`${creator.name} 的完整数据账本`}>
    <header className="creator-data-ledger-head"><div><small>COMPLETE CREATOR RECORD / SAVED DATA</small><strong>完整数据账本</strong><span>完整展示当前任务已保存的账号、内容、分析与聚合粉丝字段；未返回的字段不会伪造。</span></div><div className="creator-ledger-actions"><button className="creator-ledger-toggle" onClick={toggleAllSections} aria-pressed={allExpanded}>{allExpanded ? '收起全部字段' : '展开全部字段'}</button><button className="creator-ledger-export" onClick={() => downloadJsonSnapshot(`${snapshotFileStem(creator.id || creator.name)}-complete-record.json`, snapshot)} title="导出当前达人完整数据 JSON"><Download size={14} />导出 JSON</button></div></header>
    <div className="creator-ledger-summary"><span>{sections.length} 个数据分组</span><span>{fieldCount} 个已保存值</span><span>展开分组可查看所有已保存字段</span></div>
    <div className="creator-ledger-sections">{sections.map((section) => <details className="creator-ledger-section" key={section.id} open={expandedSections.has(section.id)} onToggle={(event) => setSectionExpanded(section.id, event.currentTarget.open)}><summary><span><small>{section.caption}</small><strong>{section.title}</strong></span><b>{section.available ? `${ledgerValueCount(section.value)} 项` : '未返回'}</b></summary><div className="creator-ledger-body">{section.available ? <LedgerValue value={section.value} path={section.id} /> : <p className="creator-ledger-empty">当前任务未返回该分组数据；系统会在采集或导入后原样展示，不以推断值补齐。</p>}</div></details>)}</div>
  </section>;
}

function AnalysisDecisionBrief({ analysis, roles, synthesis, coverage }) {
  const roleDefinitions = new Map(contentAnalysisRoleCatalog.map((role) => [role.id, role]));
  const decision = plainObject(analysis?.decision);
  const decisionQuality = plainObject(decision?.quality);
  const evidenceQuality = plainObject(analysis?.evidenceQuality);
  const normalizeEvidenceIds = (value) => Array.from(new Set((Array.isArray(value) ? value : [])
    .map((id) => profileText(id))
    .filter(Boolean)));
  const observedNumber = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  };
  const returnedRoles = roles.filter((role) => (
    profileText(role?.summary)
    || (Array.isArray(role?.findings) && role.findings.length > 0)
    || (Array.isArray(role?.evidence) && role.evidence.length > 0)
  ));
  const findings = returnedRoles.flatMap((role) => (
    (Array.isArray(role?.findings) ? role.findings : []).map((finding) => ({ role, finding }))
  ));
  const evidenceEntries = [
    ...(Array.isArray(analysis?.evidence) ? analysis.evidence.map((evidence) => ({ role: null, evidence })) : []),
    ...returnedRoles.flatMap((role) => (
      (Array.isArray(role?.evidence) ? role.evidence : []).map((evidence) => ({ role, evidence }))
    )),
  ].filter(({ evidence }) => Boolean(evidence && typeof evidence === 'object'));
  const evidenceById = new Map();
  evidenceEntries.forEach(({ evidence }) => {
    const id = profileText(evidence.id);
    if (id && !evidenceById.has(id)) evidenceById.set(id, evidence);
  });
  const citedIds = normalizeEvidenceIds(synthesis.evidenceIds);
  const citedEvidence = citedIds
    .map((id) => ({ id, evidence: evidenceById.get(id) }))
    .filter(({ evidence }) => Boolean(evidence));
  const displayedCitedEvidence = citedEvidence.slice(0, 4);
  const citedFindingCount = findings.filter(({ finding }) => {
    const findingEvidenceIds = normalizeEvidenceIds(finding?.evidenceIds);
    return findingEvidenceIds.length > 0 && findingEvidenceIds.every((id) => evidenceById.has(id));
  }).length;
  const recommendation = profileText(synthesis.recommendation);
  const summary = profileText(synthesis.summary);
  const confidenceValue = synthesis.confidence !== undefined && synthesis.confidence !== null
    ? synthesis.confidence
    : null;
  const confidence = confidenceValue === null
    ? ''
    : evidenceLevelLabel(confidenceValue, percentLabel(confidenceValue));
  const confidenceConstraint = plainObject(synthesis.confidenceConstraint);
  const confidenceClaimed = firstPresent(confidenceConstraint.claimed, confidenceValue);
  const confidenceCeiling = firstPresent(confidenceConstraint.ceiling, '');
  const confidenceClaimedLabel = confidenceClaimed === undefined || confidenceClaimed === null || confidenceClaimed === ''
    ? ''
    : evidenceLevelLabel(confidenceClaimed, percentLabel(confidenceClaimed));
  const confidenceCeilingLabel = confidenceCeiling === undefined || confidenceCeiling === null || confidenceCeiling === ''
    ? ''
    : evidenceLevelLabel(confidenceCeiling, percentLabel(confidenceCeiling));
  const confidenceConstrained = confidenceConstraint.adjusted === true;
  const hasConfidenceConstraint = Boolean(profileText(confidenceConstraint.method) && confidenceClaimedLabel && confidenceCeilingLabel);
  const limitations = Array.from(new Set([
    ...evidenceTextList(synthesis.limitations),
    ...evidenceTextList(decision.limitations),
  ])).slice(0, 3);
  const visibleSampleCount = observedNumber(firstPresent(coverage.visibleSampleCount, 0)) || 0;
  const coverageSignals = [
    { id: 'text', label: '正文/摘要', observed: observedNumber(coverage.textObservedSampleCount) },
    { id: 'hashtags', label: '话题字段', observed: observedNumber(coverage.hashtagObservedSampleCount) },
    { id: 'interactions', label: '互动字段', observed: observedNumber(coverage.interactionObservedSampleCount) },
    { id: 'source_urls', label: '来源链接', observed: observedNumber(coverage.sourceUrlObservedSampleCount) },
    { id: 'published_at', label: '发布时间', observed: observedNumber(coverage.publishedAtObservedSampleCount) },
  ];
  const reportedCoverageSignals = coverageSignals.filter((signal) => signal.observed !== null);
  const populatedCoverageSignals = reportedCoverageSignals.filter((signal) => signal.observed > 0);
  const coverageMetric = reportedCoverageSignals.length
    ? `${populatedCoverageSignals.length} / ${reportedCoverageSignals.length}`
    : '未返回';
  const incompleteCoverageSignals = visibleSampleCount > 0
    ? reportedCoverageSignals.filter((signal) => signal.observed < visibleSampleCount)
    : [];
  const videoCoverage = plainObject(plainObject(analysis?.video).coverage);
  const processedVideoCount = observedNumber(firstPresent(
    videoCoverage.processedVideoSampleCount,
    videoCoverage.selectedVideoSampleCount,
  )) || 0;
  const semanticVideoCount = observedNumber(videoCoverage.visualSemanticSampleCount) || 0;
  const videoEvidenceNeedsWork = processedVideoCount > 0 && semanticVideoCount < processedVideoCount;
  const evidenceQualityScore = firstPresent(decisionQuality.score, evidenceQuality.score);
  const evidenceQualityLevel = profileText(firstPresent(decisionQuality.level, decisionQuality.status, evidenceQuality.level));
  const evidenceQualityLevelLabel = evidenceLevelLabel(evidenceQualityLevel);
  const qualityLabel = [percentLabel(evidenceQualityScore), evidenceQualityLevelLabel].filter(Boolean).join(' · ') || '未返回';
  const qualityMetricLabels = {
    evidenceCompletenessScore: '证据完整度',
    applicableRoleCount: '适用 Agent',
    completedRoleCount: '完成 Agent',
    findingCount: '结论数',
    citedFindingCount: '已引用结论',
    synthesisCitationCount: '合成引用',
    transcriptSegmentCount: '转写分段',
    timestampedTranscriptSegmentCount: '带时间点分段',
    audioTrackSampleCount: '含音频视频',
    modelRoleCount: '模型角色',
  };
  const qualityMetrics = Object.entries(plainObject(decisionQuality.metrics))
    .map(([id, value]) => {
      if (value === undefined || value === null || value === '' || typeof value === 'object') return null;
      const metricValue = /score$/i.test(id) ? percentLabel(value) : countLabel(value) || profileText(value);
      return { id, label: qualityMetricLabels[id] || id, value: metricValue };
    })
    .filter(Boolean)
    .slice(0, 10);
  const qualityGapLabels = {
    visible_content: '缺少可复核的公开内容样本',
    visible_text: '正文或摘要覆盖不足',
    interactions: '互动字段覆盖不足',
    video_media: '已处理视频尚未取得媒体',
    video_visual_semantics: '视频视觉语义尚不完整',
    video_transcript: '视频音频转写尚不完整',
    video_timeline: '转写缺少时间段锚点',
    cross_content_comparison: '跨内容对比证据尚不足',
  };
  const qualityGaps = evidenceTextList(decisionQuality.gaps)
    .map((gap) => qualityGapLabels[gap] || gap)
    .slice(0, 8);
  const qualityEvidenceIds = normalizeEvidenceIds(decisionQuality.evidenceIds);
  const resolvedQualityEvidenceCount = qualityEvidenceIds.filter((id) => evidenceById.has(id)).length;
  const decisionQualityMethod = profileText(decisionQuality.method);
  const hasQualityAudit = Boolean(
    Object.keys(decisionQuality).length
    || qualityMetrics.length
    || qualityGaps.length
    || qualityEvidenceIds.length
    || hasConfidenceConstraint,
  );
  const decisionDisposition = profileText(decision.disposition);
  const dispositionCopy = {
    ready_for_human_outreach_review: { label: '可进入建联复核', title: '编排首轮建联', detail: '将已连接的证据用于人工审核后的首轮沟通。' },
    human_review_required: { label: '需要人工复核', title: '人工复核后再建联', detail: '先处理审查项，再决定是否发送首轮沟通。' },
    collect_more_evidence: { label: '需补充证据', title: '补齐关键证据', detail: '先完善缺口字段，再输出建联判断。' },
    collect_visible_content: { label: '需采集内容', title: '补齐公开内容样本', detail: '先获取可复核的公开内容样本。' },
  }[decisionDisposition] || { label: '待人工复核', title: '核验后准备建联', detail: '基于可解析的证据完成一次人工复核。' };
  const decisionReady = decisionDisposition
    ? decisionDisposition === 'ready_for_human_outreach_review'
    : Boolean(recommendation && citedEvidence.length > 0 && citedFindingCount > 0);
  const stateTone = decisionReady ? 'ready' : decisionDisposition.startsWith('collect') ? 'collect' : 'review';
  const decisionEvidenceIds = normalizeEvidenceIds(decision.evidenceIds);
  const criticActionPlan = (Array.isArray(decision.actionPlan) ? decision.actionPlan : [])
    .map((action) => ({
      id: profileText(action?.id),
      priority: profileText(action?.priority),
      title: profileText(action?.title),
      detail: profileText(action?.detail),
      evidenceIds: normalizeEvidenceIds(action?.evidenceIds),
    }))
    .filter((action) => action.title || action.detail)
    .slice(0, 4);
  const coverageGapDetail = incompleteCoverageSignals
    .map((signal) => `${signal.label} ${signal.observed}/${visibleSampleCount}`)
    .join(' · ');
  const fallbackActionPlan = [
    {
      id: 'primary-decision',
      priority: 'P1',
      title: dispositionCopy.title,
      detail: recommendation || dispositionCopy.detail,
      evidenceIds: citedIds.length ? citedIds : decisionEvidenceIds,
    },
    ...(coverageGapDetail || videoEvidenceNeedsWork ? [{
      id: 'coverage-gap',
      priority: 'P2',
      title: '补齐决策覆盖缺口',
      detail: [
        coverageGapDetail ? `当前可见覆盖：${coverageGapDetail}。` : '',
        videoEvidenceNeedsWork ? `视频语义证据 ${semanticVideoCount}/${processedVideoCount}。` : '',
      ].filter(Boolean).join(' '),
      evidenceIds: decisionEvidenceIds,
    }] : []),
    ...(limitations.length ? [{
      id: 'review-gate',
      priority: 'P3',
      title: '保留人工复核门槛',
      detail: limitations[0],
      evidenceIds: decisionEvidenceIds,
    }] : []),
  ].slice(0, 4);
  const actionPlan = criticActionPlan.length ? criticActionPlan : fallbackActionPlan;
  const actionPlanSource = criticActionPlan.length ? 'CRITIC ACTION PLAN' : 'EVIDENCE-DERIVED PLAN';
  const actionPriorityLabel = (priority, index) => {
    const normalized = profileText(priority).trim().toUpperCase();
    if (/^P[0-4]$/.test(normalized)) return normalized;
    if (/^[0-4]$/.test(normalized)) return `P${normalized}`;
    if (normalized === 'HIGH') return 'P1';
    if (normalized === 'MEDIUM') return 'P2';
    if (normalized === 'LOW') return 'P3';
    return `P${index + 1}`;
  };
  const synthesisStatus = analysisStatusLabel(synthesis.status || analysis.status);
  return <section className="analysis-decision-brief" aria-label="达人级智能总览与建联决策">
    <div className="analysis-decision-head">
      <div><small>CREATOR-LEVEL INTELLIGENCE / CROSS-CONTENT</small><strong>达人级智能总览与建联决策</strong><span>{synthesisStatus} · 汇总跨内容证据与 Agent 判断；逐视频解读在下方单独呈现</span></div>
      <b className={`analysis-decision-state ${stateTone}`}>{decisionReady ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}{dispositionCopy.label}</b>
    </div>
    <div className="analysis-decision-metrics">
      <div><small>ROLE COVERAGE</small><strong>{returnedRoles.length} / {contentAnalysisRoleCatalog.length}</strong><span>已返回的 Agent 判断</span></div>
      <div><small>EVIDENCE COVERAGE</small><strong>{coverageMetric}</strong><span>{visibleSampleCount} 条样本的字段覆盖</span></div>
      <div><small>TRACEABLE FINDINGS</small><strong>{citedFindingCount} / {findings.length}</strong><span>判断的证据 ID 已解析</span></div>
      <div><small>QUALITY / CONFIDENCE</small><strong>{qualityLabel}</strong><span>{confidence ? `合成置信度 ${confidence}${confidenceConstrained ? '（已按证据收敛）' : ''}` : '未返回合成置信度'}</span></div>
    </div>
    <div className="analysis-decision-grid">
      <article className="analysis-next-action">
        <div><Target size={15} /><small>NEXT OUTREACH / 当前建议</small></div>
        <strong>{recommendation || dispositionCopy.detail}</strong>
        {summary && <p>{summary}</p>}
      </article>
      <article className="analysis-reasoning-trace">
        <div><DatabaseZap size={15} /><small>REASONING TRACE / 决策链</small></div>
        <ol>
          <li><b>01</b><span><strong>输入覆盖</strong><small>{visibleSampleCount} 条公开样本，{coverageMetric === '未返回' ? '未返回字段覆盖' : `${coverageMetric} 个字段已返回信号`}</small></span></li>
          <li><b>02</b><span><strong>角色交叉判断</strong><small>{returnedRoles.length} 个 Agent 返回 {findings.length} 条判断</small></span></li>
          <li><b>03</b><span><strong>引用可追溯性</strong><small>{citedEvidence.length} / {citedIds.length} 个合成引用已解析{decision.method ? ` · ${decision.method}` : ''}</small></span></li>
        </ol>
      </article>
    </div>
    {hasQualityAudit && <section className="analysis-quality-audit" aria-label="证据质量审计">
      <div className="analysis-quality-head"><div><Gauge size={14} /><small>QUALITY AUDIT / 质量可解释性</small></div><span>{decisionQualityMethod || 'evidence grounding'}</span></div>
      <div className="analysis-quality-grid">
        <article className="analysis-quality-block">
          <small>QUALITY GATE / 证据质量</small>
          <strong>{qualityLabel}</strong>
          <span>{evidenceQualityLevelLabel ? `等级：${evidenceQualityLevelLabel}` : '未返回质量等级'}</span>
          {qualityMetrics.length > 0 && <div className="analysis-quality-metrics">{qualityMetrics.map((metric) => <span key={metric.id}><small>{metric.label}</small><b>{metric.value}</b></span>)}</div>}
        </article>
        <article className="analysis-quality-block">
          <small>CONFIDENCE CEILING / 置信度上限</small>
          <strong>{confidence || '未返回'}</strong>
          {hasConfidenceConstraint
            ? <span>{confidenceConstrained ? `已收敛：模型原始 ${confidenceClaimedLabel}，证据上限 ${confidenceCeilingLabel}` : `未收敛：模型 ${confidenceClaimedLabel} 未超过证据上限 ${confidenceCeilingLabel}`}</span>
            : <span>未返回证据上限校准结果</span>}
        </article>
        <article className="analysis-quality-block">
          <small>QUALITY GAPS / 待补证缺口</small>
          <strong>{qualityGaps.length ? `${qualityGaps.length} 项` : '当前无缺口'}</strong>
          <div className="analysis-quality-tags">{qualityGaps.length ? qualityGaps.map((gap) => <span key={gap}>{gap}</span>) : <span className="clear">当前未返回待补证缺口</span>}</div>
        </article>
        <article className="analysis-quality-block">
          <small>QUALITY EVIDENCE / 质量依据</small>
          <strong>{qualityEvidenceIds.length ? `${resolvedQualityEvidenceCount} / ${qualityEvidenceIds.length}` : '未返回'}</strong>
          <span>{qualityEvidenceIds.length ? '已解析的质量证据 ID' : '未返回质量证据 ID'}</span>
          {qualityEvidenceIds.length > 0 && <div className="analysis-quality-evidence">{qualityEvidenceIds.slice(0, 6).map((id) => <code className={evidenceById.has(id) ? 'linked' : ''} key={id}>{id}</code>)}</div>}
        </article>
      </div>
    </section>}
    {actionPlan.length > 0 && <div className="analysis-action-plan">
      <div className="analysis-action-plan-head"><div><Target size={14} /><small>EXECUTION QUEUE / 可执行下一步</small></div><span>{actionPlanSource}</span></div>
      <ol className="analysis-action-list">{actionPlan.map((action, index) => {
        const actionEvidenceIds = action.evidenceIds;
        const resolvedActionEvidence = actionEvidenceIds.filter((id) => evidenceById.has(id)).length;
        const evidenceLabel = actionEvidenceIds.length
          ? `证据 ${resolvedActionEvidence}/${actionEvidenceIds.length} 已连接`
          : '待绑定证据';
        return <li key={action.id || `${action.title}-${index}`}>
          <b>{actionPriorityLabel(action.priority, index)}</b>
          <div><strong>{action.title || dispositionCopy.title}</strong><small>{action.detail || dispositionCopy.detail}</small></div>
          <span className={actionEvidenceIds.length && resolvedActionEvidence === actionEvidenceIds.length ? 'linked' : ''}>{evidenceLabel}</span>
        </li>;
      })}</ol>
    </div>}
    {displayedCitedEvidence.length > 0 && <div className="analysis-decision-evidence">
      <div className="analysis-decision-evidence-head"><div><Link2 size={14} /><small>SUPPORTING EVIDENCE / 合成引用证据</small></div><span>展示 {displayedCitedEvidence.length} / 已解析 {citedEvidence.length}</span></div>
      <div className="analysis-decision-evidence-list">{displayedCitedEvidence.map(({ id, evidence }) => {
        const role = evidenceEntries.find((entry) => profileText(entry.evidence.id) === id && entry.role)?.role;
        const roleLabel = roleDefinitions.get(role?.id)?.label || profileText(role?.label, '采集证据');
        const evidenceLabel = [roleLabel, profileText(evidence.kind, '内容证据'), evidence.sampleIndex !== undefined ? `样本 ${evidence.sampleIndex}` : ''].filter(Boolean).join(' · ');
        const excerpt = profileText(evidence.excerpt, profileText(evidence.basis, id));
        return <article key={id}><div><small>{evidenceLabel}</small>{evidence.sourceUrl && <a href={evidence.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} />来源</a>}</div><p>{excerpt}</p><code>{id}</code></article>;
      })}</div>
    </div>}
    {citedIds.length > citedEvidence.length && <div className="analysis-decision-anchors"><small>未解析的引用锚点</small><span>{citedIds.filter((id) => !evidenceById.has(id)).slice(0, 8).join(' · ')}</span></div>}
    {limitations.length > 0 && <div className="analysis-decision-review"><ShieldCheck size={15} /><div><small>REVIEW GATES / 人工复核项</small><span>{limitations.join(' · ')}</span></div></div>}
  </section>;
}

function DeepContentInsightBlock({ title, caption, icon: Icon, entries, tone = 'default' }) {
  if (!entries.length) return null;
  return <article className={`deep-content-insight ${tone}`}>
    <div className="deep-content-insight-head"><span><Icon size={14} /></span><div><small>{caption}</small><strong>{title}</strong></div><b>{entries.length}</b></div>
    <ul>{entries.map((entry, index) => <li key={`${entry.title}-${index}`}>
      <strong>{entry.title}</strong>
      {entry.detail && <span>{entry.detail}</span>}
      {entry.evidenceIds.length > 0 && <small title={entry.evidenceIds.join(' · ')}>证据 {entry.evidenceIds.slice(0, 3).join(' · ')}{entry.evidenceIds.length > 3 ? ` +${entry.evidenceIds.length - 3}` : ''}</small>}
    </li>)}</ul>
  </article>;
}

function DeepContentInterpretation({ analysis, roles, synthesis }) {
  const roleById = new Map((Array.isArray(roles) ? roles : []).map((role) => [role?.id, role]));
  const insightSource = objectSection(
    synthesis?.deepInsights,
    analysis?.deepInsights,
    synthesis?.deepInterpretation,
    analysis?.deepInterpretation,
    synthesis?.interpretation,
  );
  const insightSignals = objectSection(insightSource.signals, insightSource.dimensions, insightSource.analysis);
  const normalizeEvidenceIds = (value) => Array.from(new Set((Array.isArray(value) ? value : [value])
    .flatMap((entry) => Array.isArray(entry) ? entry : [entry])
    .map((entry) => profileText(entry))
    .filter(Boolean)))
    .slice(0, 8);
  const asInsightEntries = (value, limit = 3) => {
    const entries = Array.isArray(value) ? value : value ? [value] : [];
    return entries.map((entry) => {
      const item = plainObject(entry);
      const title = profileText(firstPresent(
        item.title,
        item.label,
        item.name,
        item.statement,
        item.insight,
        item.pillar,
        item.theme,
        item.trigger,
        item.angle,
        typeof entry === 'string' ? entry : '',
      ));
      const detail = profileText(firstPresent(
        item.detail,
        item.description,
        item.rationale,
        item.explanation,
        item.why,
        item.implication,
        item.example,
        item.summary,
        item.metric,
      ));
      const evidenceIds = normalizeEvidenceIds(firstPresent(
        item.evidenceIds,
        item.evidenceId,
        item.evidence,
        item.sourceIds,
        item.references,
      ));
      return title || detail ? { title: title || detail, detail: title ? detail : '', evidenceIds } : null;
    }).filter(Boolean).slice(0, limit);
  };
  const sourceEntries = (...keys) => keys.flatMap((key) => asInsightEntries(firstPresent(insightSource[key], insightSignals[key]), 3));
  const roleEntries = (roleIds, limit = 3) => roleIds.flatMap((id) => {
    const role = roleById.get(id);
    const findings = Array.isArray(role?.findings) ? role.findings : [];
    const findingEntries = findings.map((finding) => ({
      title: profileText(finding?.statement),
      detail: profileText(firstPresent(finding?.rationale, finding?.detail, finding?.metric)),
      evidenceIds: normalizeEvidenceIds(finding?.evidenceIds),
    })).filter((entry) => entry.title || entry.detail);
    return findingEntries.length ? findingEntries : (profileText(role?.summary) ? [{
      title: profileText(role.summary),
      detail: '',
      evidenceIds: normalizeEvidenceIds(role?.evidence?.map((evidence) => evidence?.id)),
    }] : []);
  }).slice(0, limit);
  const pickEntries = (keys, fallbackRoleIds, limit = 3) => {
    const direct = sourceEntries(...keys);
    return (direct.length ? direct : roleEntries(fallbackRoleIds, limit)).slice(0, limit);
  };
  const narrative = profileText(firstPresent(
    insightSource.coreNarrative,
    insightSource.thesis,
    insightSource.narrative,
    insightSource.contentThesis,
    insightSource.centralTension,
    synthesis?.coreNarrative,
    synthesis?.thesis,
    synthesis?.narrative,
    roleById.get('content_strategist')?.summary,
    synthesis?.summary,
  ));
  const narrativeEvidenceIds = normalizeEvidenceIds(firstPresent(
    insightSource.narrativeEvidenceIds,
    insightSource.coreNarrativeEvidenceIds,
    insightSource.evidenceIds,
    synthesis?.deepInsightEvidenceIds,
  ));
  const pillars = pickEntries(['contentPillars', 'pillars', 'topicClusters', 'themes'], ['content_strategist']);
  const evidenceChain = pickEntries(['evidenceChain', 'narrativeBeats', 'instructionSequence'], ['video_visual', 'video_audio'], 4);
  const expression = pickEntries(['expressionPatterns', 'creativeMechanics', 'storytellingPatterns', 'formatSignals'], ['video_visual', 'video_audio'], 4);
  const audience = pickEntries(['audienceTriggers', 'audienceResonance', 'audienceSignals', 'commentSignals'], ['audience_resonance']);
  const activation = pickEntries(['commercialAngles', 'outreachAngles', 'activationIdeas', 'collaborationConcepts'], ['commercial_fit']);
  const tensions = pickEntries(['counterEvidence', 'openQuestions', 'uncertainties', 'reviewGates', 'risks'], ['brand_safety']);
  const totalInsights = [pillars, evidenceChain, expression, audience, activation, tensions].reduce((total, entries) => total + entries.length, 0);
  const sourceLabel = Object.keys(insightSource).length ? 'DEEP INSIGHTS' : 'ROLE SYNTHESIS';
  if (!narrative && totalInsights === 0) return null;
  return <section className="deep-content-interpretation" aria-label="深度内容解读">
    <div className="deep-content-head">
      <div><small>DEEP CONTENT INTERPRETATION / EVIDENCE-GROUNDED</small><strong>深度内容解读</strong><span>从内容主线、表达机制、受众触发到合作切口，优先保留可回溯的证据锚点。</span></div>
      <b>{sourceLabel}</b>
    </div>
    {narrative && <div className="deep-content-thesis">
      <div><Sparkles size={15} /><small>CORE NARRATIVE / 内容主线</small></div>
      <strong>{narrative}</strong>
      {narrativeEvidenceIds.length > 0 && <span title={narrativeEvidenceIds.join(' · ')}>主线依据 {narrativeEvidenceIds.slice(0, 5).join(' · ')}{narrativeEvidenceIds.length > 5 ? ` +${narrativeEvidenceIds.length - 5}` : ''}</span>}
    </div>}
    <div className="deep-content-grid">
      <DeepContentInsightBlock title="内容支柱" caption="CONTENT PILLARS" icon={Layers3} entries={pillars} />
      <DeepContentInsightBlock title="内容证据链" caption="OBSERVED CONTENT BEATS" icon={Link2} entries={evidenceChain} />
      <DeepContentInsightBlock title="表达机制" caption="CREATIVE MECHANICS" icon={MessageSquareText} entries={expression} />
      <DeepContentInsightBlock title="受众触发" caption="AUDIENCE TRIGGERS" icon={Users} entries={audience} />
      <DeepContentInsightBlock title="合作切口" caption="ACTIVATION ANGLES" icon={CircleDollarSign} entries={activation} tone="activation" />
      <DeepContentInsightBlock title="反证与待证" caption="COUNTER-EVIDENCE / GAPS" icon={ShieldCheck} entries={tensions} tone="review" />
    </div>
  </section>;
}

const VIDEO_ANALYSIS_EVIDENCE_KINDS = new Set([
  'rendered_video_metadata',
  'local_media_probe',
  'local_media_cache',
  'sampled_video_frame_ocr',
  'local_video_visual_semantics',
  'local_video_frame_semantics',
  'local_audio_transcript',
  'local_audio_transcript_segment',
  'external_video_context',
  'external_video_summary',
]);

const VIDEO_ANALYSIS_EVIDENCE_PRIORITY = new Map([
  ['external_video_summary', 0],
  ['local_video_visual_semantics', 1],
  ['local_video_frame_semantics', 2],
  ['local_audio_transcript', 3],
  ['local_audio_transcript_segment', 4],
  ['sampled_video_frame_ocr', 5],
  ['rendered_video_metadata', 6],
  ['local_media_probe', 7],
  ['local_media_cache', 8],
  ['external_video_context', 9],
]);

function videoAnalysisSampleIndex(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function videoAnalysisEvidenceKind(entry) {
  return profileText(entry?.kind).trim().toLowerCase();
}

function videoEvidenceSampleIndex(entry) {
  const metrics = plainObject(entry?.metrics);
  const direct = videoAnalysisSampleIndex(firstPresent(
    entry?.sampleIndex,
    entry?.sample_index,
    metrics.sampleIndex,
    metrics.sample_index,
  ));
  if (direct) return direct;
  const match = profileText(entry?.id).match(/(?:^|:)video:sample:(\d+)(?::|$)/i);
  return match ? videoAnalysisSampleIndex(match[1]) : null;
}

function isVideoAnalysisEvidence(entry) {
  return VIDEO_ANALYSIS_EVIDENCE_KINDS.has(videoAnalysisEvidenceKind(entry))
    || /(?:^|:)video:sample:\d+(?::|$)/i.test(profileText(entry?.id));
}

function videoEvidenceExcerpt(entry) {
  const metrics = plainObject(entry?.metrics);
  return profileText(firstPresent(
    entry?.excerpt,
    entry?.summary,
    entry?.text,
    entry?.basis,
    metrics.summary,
    metrics.text,
    metrics.description,
  ));
}

function videoEvidenceFrameIndex(entry, fallback) {
  const metrics = plainObject(entry?.metrics);
  const direct = videoAnalysisSampleIndex(firstPresent(entry?.frameIndex, entry?.frame_index, metrics.frameIndex, metrics.frame_index));
  if (direct) return direct;
  const match = profileText(entry?.id).match(/:frame:(\d+)(?::|$)/i);
  return match ? videoAnalysisSampleIndex(match[1]) : fallback;
}

function videoEvidenceArtifactPath(entry) {
  const metrics = plainObject(entry?.metrics);
  const artifact = plainObject(entry?.artifact);
  return profileText(firstPresent(entry?.artifactPath, entry?.artifact_path, metrics.artifactPath, metrics.artifact_path, artifact.path));
}

function isVideoContentSample(sample) {
  if (sample?.hasVideo === true) return true;
  const duration = Number(sample?.durationSeconds);
  const contentType = `${profileText(sample?.contentType)} ${profileText(sample?.contentFormat)}`.toLowerCase();
  return (Number.isFinite(duration) && duration > 0)
    || /(video|clip|reel|short|视频|短片|影片)/i.test(contentType);
}

function videoAnalysisScopeLabel(value) {
  const normalized = profileText(value).trim().toLowerCase();
  const labels = {
    all_captured_public_videos: '采集快照中的全部公开视频',
    all_visible_public_videos: '采集快照中的全部公开视频',
    all_eligible_videos: '全部可处理公开视频',
    full_capture: '采集快照中的全部公开视频',
  };
  return labels[normalized] || profileText(value);
}

function buildVideoAnalysisCards(analysis, video, contentSamples = []) {
  const coverage = plainObject(video?.coverage);
  const sourceSamples = (Array.isArray(contentSamples) ? contentSamples : [])
    .filter((sample) => sample && typeof sample === 'object');
  const evidence = allAnalysisEvidence(analysis);
  const evidenceById = new Map(evidence.map((entry) => [profileText(entry?.id), entry]).filter(([id]) => Boolean(id)));
  const sourceByIndex = new Map(sourceSamples
    .map((sample) => [videoAnalysisSampleIndex(sample?.sampleIndex), sample])
    .filter(([sampleIndex]) => Boolean(sampleIndex)));
  const sourceByUrl = new Map(sourceSamples
    .map((sample) => [profileText(sample?.sourceUrl), sample])
    .filter(([sourceUrl]) => Boolean(sourceUrl)));
  const cards = [];
  const addEvidence = (card, entry) => {
    if (!card || !entry) return;
    const id = profileText(entry?.id);
    const fingerprint = id || [
      videoAnalysisEvidenceKind(entry),
      profileText(entry?.sourceUrl),
      videoEvidenceExcerpt(entry),
      videoEvidenceSampleIndex(entry),
    ].join('|');
    if (!fingerprint || card.evidenceKeys.has(fingerprint)) return;
    card.evidenceKeys.add(fingerprint);
    if (id) card.evidenceIds.add(id);
    card.evidence.push(entry);
  };
  const ensureCard = ({ sampleIndex, sourceUrl, sourceSample, videoItem, analysisItem, fallbackKey }) => {
    const normalizedIndex = videoAnalysisSampleIndex(sampleIndex);
    const normalizedUrl = profileText(sourceUrl);
    let card = cards.find((candidate) => (
      (normalizedIndex && candidate.sampleIndex === normalizedIndex)
      || (normalizedUrl && candidate.sourceUrl === normalizedUrl)
      || (fallbackKey && candidate.key === fallbackKey)
    ));
    if (!card) {
      card = {
        key: fallbackKey || (normalizedIndex ? `sample:${normalizedIndex}` : normalizedUrl ? `source:${normalizedUrl}` : `video:${cards.length + 1}`),
        sampleIndex: normalizedIndex,
        sourceUrl: normalizedUrl,
        sourceSample: sourceSample || null,
        video: null,
        analysisItem: null,
        evidence: [],
        evidenceIds: new Set(),
        evidenceKeys: new Set(),
        findings: [],
        findingKeys: new Set(),
      };
      cards.push(card);
    }
    if (!card.sampleIndex && normalizedIndex) card.sampleIndex = normalizedIndex;
    if (!card.sourceUrl && normalizedUrl) card.sourceUrl = normalizedUrl;
    if (sourceSample) card.sourceSample = sourceSample;
    if (analysisItem && Object.keys(plainObject(analysisItem)).length) card.analysisItem = analysisItem;
    if (videoItem && Object.keys(plainObject(videoItem)).length) {
      const previous = plainObject(card.video);
      const incoming = plainObject(videoItem);
      const merged = { ...previous, ...incoming };
      ['frames', 'rendered', 'probe', 'mediaCache', 'transcript', 'vision'].forEach((field) => {
        const incomingValue = incoming[field];
        const incomingEmpty = incomingValue === undefined || incomingValue === null
          || (Array.isArray(incomingValue) && incomingValue.length === 0)
          || (typeof incomingValue === 'object' && !Array.isArray(incomingValue) && Object.keys(plainObject(incomingValue)).length === 0);
        if (incomingEmpty && previous[field] !== undefined) merged[field] = previous[field];
      });
      card.video = merged;
    }
    return card;
  };
  const eligibleVideoCount = Number(coverage.eligibleVideoSampleCount);
  const sourceUniverseIsVideo = Number.isFinite(eligibleVideoCount)
    && eligibleVideoCount > 0
    && sourceSamples.length > 0
    && eligibleVideoCount >= sourceSamples.length;

  sourceSamples
    .filter((sample) => sourceUniverseIsVideo || isVideoContentSample(sample))
    .forEach((sample) => ensureCard({
      sampleIndex: sample.sampleIndex,
      sourceUrl: sample.sourceUrl,
      sourceSample: sample,
    }));

  const videoAnalysis = plainObject(analysis?.videoAnalysis);
  const structuredItems = Array.isArray(videoAnalysis?.items)
    ? videoAnalysis.items
    : Array.isArray(analysis?.videoItems) ? analysis.videoItems : [];
  structuredItems.forEach((entry, index) => {
    const item = plainObject(entry);
    const itemSource = plainObject(item?.source);
    const nestedVideo = objectSection(item?.video, item?.media);
    const videoItem = Object.keys(nestedVideo).length ? nestedVideo : item;
    const sampleIndex = firstPresent(item.sampleIndex, item.sample_index, itemSource.sampleIndex, itemSource.sample_index, videoItem.sampleIndex);
    const sourceUrl = firstPresent(item.sourceUrl, item.source_url, itemSource.sourceUrl, itemSource.source_url, videoItem.sourceUrl);
    ensureCard({
      sampleIndex,
      sourceUrl,
      sourceSample: sourceByIndex.get(videoAnalysisSampleIndex(sampleIndex)) || sourceByUrl.get(profileText(sourceUrl)),
      videoItem,
      analysisItem: item,
      fallbackKey: `video-item:${index + 1}`,
    });
  });

  (Array.isArray(video?.videos) ? video.videos : []).forEach((item, index) => ensureCard({
    sampleIndex: item?.sampleIndex,
    sourceUrl: item?.sourceUrl,
    sourceSample: sourceByIndex.get(videoAnalysisSampleIndex(item?.sampleIndex)) || sourceByUrl.get(profileText(item?.sourceUrl)),
    videoItem: item,
    fallbackKey: `video:${index + 1}`,
  }));

  evidence.filter(isVideoAnalysisEvidence).forEach((entry, index) => ensureCard({
    sampleIndex: videoEvidenceSampleIndex(entry),
    sourceUrl: entry?.sourceUrl,
    sourceSample: sourceByIndex.get(videoEvidenceSampleIndex(entry)) || sourceByUrl.get(profileText(entry?.sourceUrl)),
    fallbackKey: `evidence:${profileText(entry?.id) || index + 1}`,
  }));

  cards.forEach((card) => {
    if (!card.sourceSample) card.sourceSample = sourceByIndex.get(card.sampleIndex) || sourceByUrl.get(card.sourceUrl) || null;
    card.sourceUrl = firstPresent(card.sourceUrl, card.video?.sourceUrl, card.analysisItem?.sourceUrl, card.sourceSample?.sourceUrl, '');
    if (!card.sampleIndex) card.sampleIndex = videoAnalysisSampleIndex(firstPresent(card.video?.sampleIndex, card.analysisItem?.sampleIndex, card.sourceSample?.sampleIndex));
  });

  evidence.forEach((entry) => {
    const sampleIndex = videoEvidenceSampleIndex(entry);
    const sourceUrl = profileText(entry?.sourceUrl);
    const card = cards.find((candidate) => (
      (sampleIndex && candidate.sampleIndex === sampleIndex)
      || (sourceUrl && candidate.sourceUrl === sourceUrl)
    ));
    if (card) addEvidence(card, entry);
  });

  cards.forEach((card) => {
    evidenceTextList(card.analysisItem?.evidenceIds)
      .map((id) => evidenceById.get(id))
      .filter(Boolean)
      .forEach((entry) => addEvidence(card, entry));
  });

  const appendFinding = (card, finding, defaults, index) => {
    const statement = profileText(firstPresent(finding?.statement, finding?.summary, finding?.text, finding?.title));
    const metric = finding?.metric;
    if (!statement && (metric === undefined || metric === null || metric === '')) return;
    const evidenceIds = evidenceTextList(finding?.evidenceIds);
    const key = `${defaults.roleId}:${profileText(finding?.id, String(index + 1))}:${evidenceIds.join(',')}:${statement}`;
    if (card.findingKeys.has(key)) return;
    card.findingKeys.add(key);
    card.findings.push({
      id: profileText(finding?.id, `${defaults.roleId}-${index + 1}`),
      roleId: defaults.roleId,
      roleLabel: defaults.roleLabel,
      scope: defaults.scope,
      statement,
      metric,
      evidenceIds,
    });
  };

  cards.forEach((card) => {
    const item = plainObject(card.analysisItem);
    const itemFindings = Array.isArray(item?.findings)
      ? item.findings
      : Array.isArray(item?.insights) ? item.insights : [];
    itemFindings.forEach((finding, index) => appendFinding(card, finding, {
      roleId: 'video_item',
      roleLabel: '逐视频解读',
      scope: 'single_video',
    }, index));
  });

  const roleDefinitions = new Map(contentAnalysisRoleCatalog.map((role) => [role.id, role]));
  (Array.isArray(analysis?.roles) ? analysis.roles : []).forEach((role) => {
    const roleId = profileText(role?.id, 'content_agent');
    const roleLabel = profileText(firstPresent(role?.label, roleDefinitions.get(roleId)?.label), '内容理解 Agent');
    (Array.isArray(role?.findings) ? role.findings : []).forEach((finding, index) => {
      const evidenceIds = evidenceTextList(finding?.evidenceIds);
      if (!evidenceIds.length) return;
      cards.forEach((card) => {
        const matchedIds = evidenceIds.filter((id) => card.evidenceIds.has(id));
        if (!matchedIds.length) return;
        appendFinding(card, { ...finding, evidenceIds: matchedIds }, {
          roleId,
          roleLabel,
          scope: matchedIds.length === evidenceIds.length ? 'single_video' : 'cross_content',
        }, index);
      });
    });
  });

  return cards
    .map((card) => {
      const videoEvidence = card.evidence
        .filter(isVideoAnalysisEvidence)
        .sort((left, right) => (
          (VIDEO_ANALYSIS_EVIDENCE_PRIORITY.get(videoAnalysisEvidenceKind(left)) ?? 99)
          - (VIDEO_ANALYSIS_EVIDENCE_PRIORITY.get(videoAnalysisEvidenceKind(right)) ?? 99)
        ));
      const visualResult = plainObject(plainObject(card.video).vision?.result);
      const structuredAnalysis = plainObject(card.analysisItem?.analysis);
      const semanticEvidence = videoEvidence.find((entry) => (
        ['external_video_summary', 'local_video_visual_semantics', 'local_video_frame_semantics'].includes(videoAnalysisEvidenceKind(entry))
        && videoEvidenceExcerpt(entry)
      ));
      const sourceEvidence = card.evidence.find((entry) => (
        videoAnalysisEvidenceKind(entry) === 'visible_content_text' && videoEvidenceExcerpt(entry)
      ));
      const summaryCandidates = [
        { text: profileText(firstPresent(card.analysisItem?.summary, structuredAnalysis.summary, card.analysisItem?.contentSummary, card.analysisItem?.analysisSummary)), source: '逐视频 Agent' },
        { text: profileText(visualResult.summary), source: '视频视觉 Agent' },
        { text: semanticEvidence ? videoEvidenceExcerpt(semanticEvidence) : '', source: semanticEvidence ? contentEvidenceKindLabel(videoAnalysisEvidenceKind(semanticEvidence)) : '' },
        { text: profileText(card.findings[0]?.statement), source: profileText(card.findings[0]?.roleLabel) },
        { text: profileText(card.sourceSample?.summary), source: '已采集内容摘要' },
        { text: sourceEvidence ? videoEvidenceExcerpt(sourceEvidence) : '', source: sourceEvidence ? '公开内容证据' : '' },
      ].find((candidate) => candidate.text);
      return {
        ...card,
        videoEvidence,
        sourceTitle: profileText(firstPresent(card.sourceSample?.title, card.analysisItem?.title, card.video?.title)),
        summary: summaryCandidates?.text || '尚未返回该视频的语义摘要；可先核对已采集的公开字段与处理状态。',
        summarySource: summaryCandidates?.source || '待逐视频理解',
      };
    })
    .filter((card) => card.sourceSample || card.video || card.analysisItem || card.videoEvidence.length)
    .sort((left, right) => {
      if (left.sampleIndex && right.sampleIndex) return left.sampleIndex - right.sampleIndex;
      if (left.sampleIndex) return -1;
      if (right.sampleIndex) return 1;
      return left.key.localeCompare(right.key);
    });
}

function videoCardRecord(card) {
  const raw = plainObject(card?.video);
  const structured = plainObject(card?.analysisItem);
  const source = plainObject(structured?.source);
  const structuredFrames = Array.isArray(structured?.frames) && structured.frames.length ? structured.frames : null;
  const rawFrames = Array.isArray(raw?.frames) ? raw.frames : [];
  return {
    ...raw,
    ...structured,
    sampleIndex: firstPresent(structured.sampleIndex, structured.sample_index, raw.sampleIndex, card?.sampleIndex),
    sourceUrl: firstPresent(structured.sourceUrl, structured.source_url, source.sourceUrl, raw.sourceUrl, card?.sourceUrl),
    status: firstPresent(structured.status, raw.status),
    rendered: objectSection(structured.rendered, raw.rendered),
    probe: objectSection(structured.probe, raw.probe),
    mediaCache: objectSection(structured.mediaCache, structured.media_cache, raw.mediaCache),
    transcript: objectSection(structured.transcript, raw.transcript),
    vision: objectSection(structured.vision, raw.vision),
    frames: structuredFrames || rawFrames,
  };
}

function videoCardFrames(item, card) {
  const rawFrames = Array.isArray(item?.frames) ? item.frames : [];
  if (rawFrames.length) return rawFrames;
  const seen = new Set();
  return (Array.isArray(card?.videoEvidence) ? card.videoEvidence : [])
    .filter((entry) => ['sampled_video_frame_ocr', 'local_video_frame_semantics'].includes(videoAnalysisEvidenceKind(entry)))
    .map((entry, index) => {
      const kind = videoAnalysisEvidenceKind(entry);
      const metrics = plainObject(entry?.metrics);
      const frameIndex = videoEvidenceFrameIndex(entry, index + 1);
      const key = `${frameIndex || index + 1}:${videoEvidenceArtifactPath(entry)}:${videoEvidenceExcerpt(entry)}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        index: frameIndex || index + 1,
        timeSeconds: firstPresent(entry?.timeSeconds, entry?.time_seconds, metrics.timeSeconds, metrics.time_seconds),
        artifactPath: videoEvidenceArtifactPath(entry),
        ocrText: kind === 'sampled_video_frame_ocr' ? videoEvidenceExcerpt(entry) : profileText(metrics.ocrText),
        semanticText: kind === 'local_video_frame_semantics' ? videoEvidenceExcerpt(entry) : '',
      };
    })
    .filter(Boolean);
}

function videoCardTranscript(item, card) {
  const transcript = plainObject(item?.transcript);
  const rawSegments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  if (rawSegments.length || profileText(transcript?.text)) return transcript;
  const audioEvidence = (Array.isArray(card?.videoEvidence) ? card.videoEvidence : [])
    .filter((entry) => ['local_audio_transcript', 'local_audio_transcript_segment'].includes(videoAnalysisEvidenceKind(entry)));
  if (!audioEvidence.length) return transcript;
  const segments = audioEvidence
    .filter((entry) => videoAnalysisEvidenceKind(entry) === 'local_audio_transcript_segment')
    .map((entry, index) => {
      const metrics = plainObject(entry?.metrics);
      return {
        index: firstPresent(metrics.index, index + 1),
        startSeconds: firstPresent(entry?.startSeconds, entry?.start_seconds, metrics.startSeconds, metrics.start_seconds, metrics.timeSeconds, metrics.time_seconds),
        endSeconds: firstPresent(entry?.endSeconds, entry?.end_seconds, metrics.endSeconds, metrics.end_seconds),
        text: videoEvidenceExcerpt(entry),
      };
    })
    .filter((segment) => segment.text);
  const fullTranscript = audioEvidence.find((entry) => videoAnalysisEvidenceKind(entry) === 'local_audio_transcript');
  return {
    ...transcript,
    status: 'completed',
    provider: 'historical_evidence',
    text: profileText(fullTranscript ? videoEvidenceExcerpt(fullTranscript) : ''),
    segments,
  };
}

function videoCardMediaState(item, card) {
  const mediaState = videoMediaState(item);
  if (mediaState.tone !== 'unavailable') return mediaState;
  const hasMediaEvidence = (Array.isArray(card?.videoEvidence) ? card.videoEvidence : []).some((entry) => (
    ['rendered_video_metadata', 'local_media_probe', 'local_media_cache', 'sampled_video_frame_ocr'].includes(videoAnalysisEvidenceKind(entry))
  ));
  return hasMediaEvidence ? { label: '媒体证据已归集', tone: 'complete' } : mediaState;
}

function videoItemAnalysisState(card, item) {
  const structured = plainObject(card?.analysisItem);
  const status = profileText(firstPresent(structured.status, structured.analysisStatus, item?.status)).toLowerCase();
  const visualResult = plainObject(plainObject(item?.vision).result);
  const hasSemantic = Boolean(
    profileText(firstPresent(structured.summary, structured.analysisSummary, visualResult.summary))
    || (Array.isArray(card?.findings) && card.findings.length)
    || (Array.isArray(card?.videoEvidence) && card.videoEvidence.some((entry) => (
      ['external_video_summary', 'local_video_visual_semantics', 'local_video_frame_semantics'].includes(videoAnalysisEvidenceKind(entry))
    )))
  );
  if (['completed', 'complete', 'succeeded', 'ready'].includes(status)) return { label: '逐视频多模态解读完成', tone: 'complete' };
  if (status === 'partial') return { label: '逐视频解读部分完成', tone: 'pending' };
  if (status === 'not_selected') return { label: '公开文案已解读，待视频处理', tone: 'pending' };
  if (status === 'not_collected') return { label: '公开文案已解读，待视频采集', tone: 'unavailable' };
  if (status === 'processing_disabled') return { label: '公开文案已解读，视频处理未启用', tone: 'unavailable' };
  if (status === 'processing_record_unavailable' || status === 'processing_incomplete') return { label: '公开文案已解读，视频处理待补齐', tone: 'pending' };
  if (['queued', 'pending', 'running', 'processing'].includes(status)) return { label: '逐视频处理中', tone: 'pending' };
  if (['failed', 'error'].includes(status)) return { label: '逐视频处理未完成', tone: 'failed' };
  if (hasSemantic) return { label: '逐视频解读完成', tone: 'complete' };
  if (Array.isArray(card?.videoEvidence) && card.videoEvidence.length) return { label: '视频证据已归集', tone: 'complete' };
  return { label: '待视频多模态处理', tone: 'unavailable' };
}

function videoEvidenceMetricList(entry) {
  return Object.entries(plainObject(entry?.metrics))
    .map(([label, value]) => `${label}: ${contentItemMetricLabel(value)}`)
    .filter((item) => !item.endsWith(': '));
}

function VideoEvidenceTrace({ entries }) {
  if (!entries.length) return null;
  return <details className="video-analysis-trace">
    <summary><span><Link2 size={13} /><small>VIDEO EVIDENCE TRACE</small></span><b>{entries.length} 条视频级证据</b></summary>
    <ol>{entries.map((entry, index) => {
      const id = profileText(entry?.id);
      const excerpt = videoEvidenceExcerpt(entry);
      const metrics = videoEvidenceMetricList(entry);
      return <li key={id || `${videoAnalysisEvidenceKind(entry)}-${index}`}>
        <div><small>{contentEvidenceKindLabel(videoAnalysisEvidenceKind(entry))}</small>{entry?.sourceUrl && <a href={entry.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} />来源</a>}</div>
        {excerpt && <p>{excerpt}</p>}
        {metrics.length > 0 && <span>{metrics.join(' · ')}</span>}
        {id && <code>{id}</code>}
      </li>;
    })}</ol>
  </details>;
}

function VideoItemIntelligence({ card, state }) {
  const findings = Array.isArray(card?.findings) ? card.findings : [];
  const evidence = Array.isArray(card?.videoEvidence) ? card.videoEvidence : [];
  return <section className="video-item-intelligence" aria-label={`视频样本 ${card?.sampleIndex || '未知'} 的智能解读`}>
    <div className="video-item-intelligence-head"><div><small>VIDEO-LEVEL INTELLIGENCE / TRACEABLE</small><strong>单视频内容结论</strong></div><b className={`video-status ${state.tone}`}>{state.label}</b></div>
    <p className="video-item-summary">{card.summary}</p>
    <div className="video-item-signals"><span><small>摘要来源</small><b>{card.summarySource}</b></span><span><small>角色发现</small><b>{findings.length} 条</b></span><span><small>视频证据</small><b>{evidence.length} 条</b></span></div>
    {findings.length > 0 && <ol className="video-item-findings">{findings.map((finding, index) => <li key={`${finding.roleId}-${finding.id}-${index}`}><div><small>{finding.roleLabel}</small><b>{finding.scope === 'cross_content' ? '跨内容关联' : '单视频判断'}</b></div><strong>{finding.statement}</strong>{finding.metric !== undefined && finding.metric !== null && <span>{contentItemMetricLabel(finding.metric)}</span>}{finding.evidenceIds?.length > 0 && <code>证据 {finding.evidenceIds.join(' · ')}</code>}</li>)}</ol>}
    <VideoEvidenceTrace entries={evidence} />
  </section>;
}

function VideoAnalysisRollup({ rollup, cardCount }) {
  const data = plainObject(rollup);
  const summary = profileText(firstPresent(
    data.summary,
    data.overview,
    data.creatorSummary,
    data.contentSummary,
    data.narrative,
  ));
  const source = profileText(firstPresent(data.provider, data.source, data.model, data.generatedBy));
  const rawFindings = Array.isArray(data.findings)
    ? data.findings
    : Array.isArray(data.highlights)
      ? data.highlights
      : Array.isArray(data.keyFindings)
        ? data.keyFindings
        : [];
  const findings = rawFindings.map((entry, index) => {
    const value = plainObject(entry);
    return {
      id: profileText(firstPresent(value.id, value.key, index + 1)),
      label: profileText(firstPresent(value.label, value.dimension, value.role, value.type), '综合判断'),
      statement: profileText(firstPresent(value.statement, value.summary, value.text, value.value, entry)),
      metric: firstPresent(value.metric, value.score, value.confidence),
    };
  }).filter((entry) => entry.statement);
  const metricSource = Object.keys(plainObject(data.metrics)).length
    ? plainObject(data.metrics)
    : plainObject(data.coverage);
  const metricLabels = {
    eligibleVideoCount: '公开视频',
    selectedVideoCount: '本次处理',
    completedVideoCount: '多模态完成',
    partialVideoCount: '部分完成',
    notSelectedVideoCount: '待视频处理',
    incompleteVideoCount: '待补齐',
    evidenceBackedVideoCount: '视频证据',
    transcriptObservedVideoCount: '已转写',
    visualSemanticVideoCount: '已视觉解读',
    externalSummaryVideoCount: '外部摘要',
    analysisScope: '处理范围',
  };
  const metrics = Object.entries(metricSource)
    .map(([label, value]) => [label, contentItemMetricLabel(value)])
    .filter(([, value]) => value)
    .map(([label, value]) => [metricLabels[label] || label, value]);
  const evidenceIds = evidenceTextList(firstPresent(
    data.evidenceIds,
    data.supportingEvidenceIds,
    data.evidence,
  )).slice(0, 12);
  const status = profileText(data.status);
  const statusTone = ['completed', 'complete', 'succeeded', 'ready'].includes(status)
    ? 'complete'
    : status === 'partial'
      ? 'pending'
      : ['failed', 'error'].includes(status)
        ? 'failed'
        : 'pending';
  if (!summary && !findings.length && !metrics.length && !evidenceIds.length) return null;
  return <section className="video-analysis-rollup" aria-label="视频内容达人级总览">
    <header>
      <div><small>CREATOR-LEVEL VIDEO ROLLUP / CROSS-CONTENT</small><strong>视频内容达人级总览</strong></div>
      <div>{cardCount > 0 && <span>{cardCount} 条逐视频解读</span>}{status && <b className={`video-status ${statusTone}`}>{analysisStatusLabel(status)}</b>}</div>
    </header>
    {summary && <p>{summary}</p>}
    {(source || metrics.length > 0) && <div className="video-rollup-signals">
      {source && <span><small>汇总来源</small><b>{source}</b></span>}
      {metrics.map(([label, value]) => <span key={label}><small>{label}</small><b>{value}</b></span>)}
    </div>}
    {findings.length > 0 && <ol>{findings.map((finding) => <li key={finding.id}><div><small>{finding.label}</small>{finding.metric !== undefined && finding.metric !== null && <b>{contentItemMetricLabel(finding.metric)}</b>}</div><strong>{finding.statement}</strong></li>)}</ol>}
    {evidenceIds.length > 0 && <div className="video-rollup-evidence"><small>汇总证据</small>{evidenceIds.map((id) => <code key={id}>{id}</code>)}</div>}
  </section>;
}

function ContentAnalysisEvidencePanel({ creator, record, job, running, contentSamples = [], contentPageHref }) {
  const analysis = record?.analysis;
  if (!analysis && !job?.id) return null;
  const roles = Array.isArray(analysis?.roles) ? analysis.roles : [];
  const coverage = plainObject(analysis?.coverage);
  const video = plainObject(analysis?.video);
  const videoCards = analysis ? buildVideoAnalysisCards(analysis, video, contentSamples) : [];
  const synthesis = plainObject(analysis?.synthesis);
  const analysisMultimodal = plainObject(analysis?.multimodal);
  const sharedAnalysisMultimodal = analysisMultimodal.sharedAcrossAgents === true || analysisMultimodal.shared_across_agents === true
    ? analysisMultimodal
    : {};
  const synthesisMultimodal = mergeMultimodalCoverage(synthesis?.multimodal, sharedAnalysisMultimodal);
  const orchestration = plainObject(analysis?.orchestration);
  const agentRuns = Array.isArray(orchestration.agents) ? orchestration.agents : [];
  const agentRunById = new Map(agentRuns.map((agent) => [agent?.id, agent]));
  const synthesisRun = plainObject(orchestration.synthesis);
  const artifactUrl = job?.artifactsUrl || (job?.id ? `/api/jobs/${encodeURIComponent(job.id)}/artifacts` : '');
  const coverageItems = [
    ['可见样本', coverage.visibleSampleCount],
    ['正文/摘要', coverage.textObservedSampleCount],
    ['话题字段', coverage.hashtagObservedSampleCount],
    ['互动字段', coverage.interactionObservedSampleCount],
    ['来源链接', coverage.sourceUrlObservedSampleCount],
  ].filter(([, value]) => value !== undefined && value !== null);
  return <section className="content-analysis-evidence" aria-label={`${creator.name} 的内容理解证据`}>
    <div className="content-analysis-evidence-head">
      <div><small>AGENT MATRIX / TRACEABLE EVIDENCE</small><strong>内容理解结论</strong><span>{analysis ? analysisStatusLabel(analysis.status) : running ? '正在等待该达人的角色结果' : '该达人尚未进入内容理解任务'}</span></div>
      {artifactUrl && <a href={artifactUrl} target="_blank" rel="noreferrer" title="查看内容理解任务产物"><FileText size={14} />任务产物</a>}
    </div>
    {analysis ? <>
      <div className="analysis-coverage">{coverageItems.length ? coverageItems.map(([label, value]) => <span key={label}><small>{label}</small><strong>{value}</strong></span>) : <span className="analysis-coverage-empty">未返回覆盖度字段</span>}</div>
      <MultimodalCoverageStrip multimodal={analysisMultimodal} label="该达人内容分析多模态输入" />
      {orchestration.id && <div className="creator-agent-runtime" aria-label="达人 Codex Agent 运行状态">
        <div><small>{orchestration.id === 'codex_multi_agent' ? 'CODEX MULTI-AGENT / CREATOR RUN' : 'MODEL MATRIX / CREATOR RUN'}</small><strong>{orchestration.label || '内容理解 Agent 矩阵'}</strong></div>
        <span className={`creator-agent-runtime-status ${agentRunTone(orchestration.status)}`}>{agentRunStatusLabel(orchestration.status)}</span>
        <div className="creator-agent-runtime-list">{agentRuns.map((agent) => <span className={`creator-agent-run ${agentRunTone(agent?.status)}`} key={agent?.id || agent?.label}><small>{agent?.label || agent?.id}</small><b>{agentRunStatusLabel(agent?.status)}</b></span>)}{synthesisRun.id && <span className={`creator-agent-run ${agentRunTone(synthesisRun.status)}`}><small>{synthesisRun.label || '综合 Agent'}</small><b>{agentRunStatusLabel(synthesisRun.status)}</b></span>}</div>
      </div>}
      <AnalysisDecisionBrief analysis={analysis} roles={roles} synthesis={synthesis} coverage={coverage} />
      <MultimodalCoverageStrip multimodal={synthesisMultimodal} label="综合结论引用的多模态证据" compact />
      <DeepContentInterpretation analysis={analysis} roles={roles} synthesis={synthesis} />
      {(Object.keys(video).length > 0 || videoCards.length > 0) && <VideoEvidencePanel video={video} analysis={analysis} contentSamples={contentSamples} cards={videoCards} jobId={job?.id} contentPageHref={contentPageHref} />}
      <div className="analysis-role-results">{contentAnalysisRoleCatalog.map((definition) => {
        const role = roles.find((candidate) => candidate?.id === definition.id);
        const agentRun = agentRunById.get(definition.id);
        const roleMultimodal = mergeMultimodalCoverage(
          role?.multimodal,
          mergeMultimodalCoverage(agentRun?.multimodal, sharedAnalysisMultimodal),
        );
        const Icon = definition.icon;
        return <article key={definition.id} className={`analysis-role-result ${role ? 'ready' : ''} ${agentRun ? agentRunTone(agentRun.status) : ''}`}>
          <div className="analysis-role-result-head"><span><Icon size={15} /></span><div><small>{definition.caption}</small><strong>{definition.label}</strong></div><b className={agentRun ? `agent-run-status ${agentRunTone(agentRun.status)}` : ''}>{agentRun ? agentRunStatusLabel(agentRun.status) : role ? analysisStatusLabel(role.status) : '未返回'}</b></div>
          {role?.summary && <p>{role.summary}</p>}
          <MultimodalCoverageStrip multimodal={roleMultimodal} label={`${definition.label} 实际输入`} compact />
          {role?.findings?.length ? <ul className="analysis-findings">{role.findings.map((finding, index) => <li key={finding.id || `${definition.id}-${index}`}><strong>{finding.statement}</strong>{finding.metric !== undefined && finding.metric !== null && <span>{profileText(finding.metric)}</span>}{finding.evidenceIds?.length ? <small>证据 {finding.evidenceIds.join(' · ')}</small> : null}</li>)}</ul> : <div className="analysis-role-empty">{role ? '该角色未返回判断。' : '该角色尚未返回结果。'}</div>}
          {role?.evidence?.length ? <div className="analysis-evidence-list">{role.evidence.map((evidence, index) => {
            const metrics = Object.entries(plainObject(evidence.metrics)).map(([label, value]) => `${label}: ${profileText(value)}`).filter((item) => !item.endsWith(': '));
            return <div key={evidence.id || `${definition.id}-e-${index}`}><div><small>{evidence.kind || '内容证据'}</small>{evidence.sourceUrl && <a href={evidence.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} />来源</a>}</div>{evidence.excerpt && <p>{evidence.excerpt}</p>}{metrics.length ? <span>{metrics.join(' · ')}</span> : null}{evidence.basis && <small>{evidence.basis}</small>}</div>;
          })}</div> : null}
        </article>;
      })}</div>
    </> : <div className="analysis-evidence-empty"><Bot size={18} /><div><strong>{running ? '角色 Agent 正在理解内容' : '尚无内容理解结论'}</strong><small>{running ? '完成后会在此展示每个角色的判断、原始证据与覆盖度。' : '在候选列表中选择包含公开内容样本的批次后运行 Agent 矩阵。'}</small></div></div>}
  </section>;
}

function VideoEvidencePanel({ video, analysis, contentSamples, cards: providedCards, jobId, contentPageHref, showRollup = true }) {
  const coverage = plainObject(video?.coverage);
  const videoAnalysis = plainObject(analysis?.videoAnalysis);
  const videoRollup = objectSection(videoAnalysis?.rollup, analysis?.videoRollup);
  const cards = Array.isArray(providedCards) ? providedCards : buildVideoAnalysisCards(analysis, video, contentSamples);
  const [videoRenderLimit, setVideoRenderLimit] = useState(20);
  useEffect(() => {
    setVideoRenderLimit(20);
  }, [jobId, cards.length]);
  const displayedCards = cards.slice(0, videoRenderLimit);
  const hasMoreCards = displayedCards.length < cards.length;
  const cardStates = cards.map((card) => videoItemAnalysisState(card, videoCardRecord(card)));
  const completedCardCount = cardStates.filter((state) => state.tone === 'complete').length;
  const pendingCardCount = cardStates.filter((state) => state.tone === 'pending').length;
  const failedCardCount = cardStates.filter((state) => state.tone === 'failed').length;
  const fallbackAggregateState = videoMediaState(video);
  const aggregateState = cards.length
    ? completedCardCount === cards.length
      ? { label: `逐视频 ${completedCardCount}/${cards.length} 已完成`, tone: 'complete' }
      : pendingCardCount > 0
        ? { label: `逐视频处理中 ${completedCardCount}/${cards.length}`, tone: 'pending' }
        : failedCardCount > 0
          ? { label: `逐视频待复核 ${completedCardCount}/${cards.length}`, tone: 'failed' }
          : { label: `逐视频待处理 ${completedCardCount}/${cards.length}`, tone: 'unavailable' }
    : fallbackAggregateState;
  const observedCount = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  };
  const eligibleVideoCount = observedCount(coverage.eligibleVideoSampleCount);
  const processedVideoCount = observedCount(firstPresent(
    coverage.processedVideoSampleCount,
    coverage.selectedVideoSampleCount,
  ));
  const unprocessedVideoCount = observedCount(firstPresent(
    coverage.unprocessedVideoSampleCount,
    eligibleVideoCount !== null && processedVideoCount !== null ? Math.max(0, eligibleVideoCount - processedVideoCount) : undefined,
  ));
  const processedSampleIndexes = [
    coverage.processedVideoSampleIndexes,
    coverage.processedSampleIndexes,
    coverage.processedIndexes,
    coverage.selectedSampleIndexes,
  ].find((value) => Array.isArray(value)) || [];
  const processedIndexes = processedSampleIndexes
    .map((index) => videoAnalysisSampleIndex(index))
    .filter(Boolean)
    .slice(0, 24);
  const timelineAnchors = evidenceTextList(coverage.timelineAnchors)
    .map((anchor) => videoTimelineAnchorLabel(anchor))
    .filter(Boolean);
  const analysisScope = videoAnalysisScopeLabel(firstPresent(
    coverage.analysisScope,
    videoAnalysis.analysisScope,
    videoAnalysis.scope,
  ));
  const coverageItems = [
    ['可处理视频', eligibleVideoCount],
    ['已处理视频', processedVideoCount],
    ['待处理视频', unprocessedVideoCount],
    ['逐视频卡', cards.length],
    ['已取得媒体', coverage.renderedMediaSampleCount],
    ['已探测媒体', coverage.probedVideoSampleCount],
    ['关键帧', firstPresent(coverage.sampledFrameCount, coverage.keyFrameCount)],
    ['时间线帧', coverage.timelineFrameCount],
    ['OCR 文本帧', coverage.ocrTextFrameCount],
    ['可用转写', coverage.transcriptAvailableSampleCount],
    ['转写分段', coverage.transcriptSegmentCount],
    ['带时间点分段', coverage.timestampedTranscriptSegmentCount],
  ].filter(([, value]) => value !== undefined && value !== null);
  const aggregateLimitations = profileText(video?.limitations);
  return <section className="video-evidence" id="video-intelligence" aria-label="逐视频智能解读与证据">
    <div className="video-evidence-head"><div><small>VIDEO-BY-VIDEO INTELLIGENCE / TRACEABLE</small><strong>逐视频智能解读与证据</strong></div><span className={`video-status ${aggregateState.tone}`}>{aggregateState.label}</span></div>
    {coverageItems.length > 0 && <div className="video-coverage">{coverageItems.map(([label, value]) => <span key={label}><small>{label}</small><strong>{value}</strong></span>)}</div>}
    {(analysisScope || timelineAnchors.length > 0 || processedIndexes.length > 0) && <div className="video-timeline-summary">
      {analysisScope && <span><small>处理范围</small><b>{analysisScope}</b></span>}
      {processedIndexes.length > 0 && <span><small>已处理样本</small><b>{processedIndexes.join('、')}</b></span>}
      {timelineAnchors.length > 0 && <span><small>时间线覆盖</small><b>{timelineAnchors.join(' · ')}</b></span>}
    </div>}
    {cards.length ? <div className="video-evidence-list">{displayedCards.map((card, cardIndex) => {
      const item = videoCardRecord(card);
      const itemState = cardStates[cardIndex] || videoItemAnalysisState(card, item);
      const frames = videoCardFrames(item, card);
      const mediaState = videoCardMediaState(item, card);
      const transcript = videoCardTranscript(item, card);
      const allTranscriptSegments = Array.isArray(transcript?.segments) ? transcript.segments : [];
      const transcriptSegments = allTranscriptSegments
        .map((segment, segmentIndex) => ({
          index: firstPresent(segment?.index, segmentIndex + 1),
          startSeconds: segment?.startSeconds,
          endSeconds: segment?.endSeconds,
          text: profileText(segment?.text),
        }))
        .filter((segment) => segment.text || videoDurationLabel(segment.startSeconds) || videoDurationLabel(segment.endSeconds))
        .slice(0, 20);
      const transcriptSegmentOverflow = Math.max(0, allTranscriptSegments.length - transcriptSegments.length);
      const transcriptState = videoTranscriptState({ ...item, transcript }, mediaState);
      const transcriptProvider = videoTranscriptProviderLabel(transcript?.provider)
        || (profileText(transcript?.provider) === 'historical_evidence' ? '历史转写证据' : '');
      const transcriptArtifactUrl = artifactAssetUrl(jobId, transcript?.artifactPath);
      const hasVision = Object.keys(plainObject(item?.vision)).length > 0;
      const vision = plainObject(item?.vision);
      const visionState = hasVision ? videoVisionState(vision) : null;
      const rendered = plainObject(item?.rendered);
      const probe = plainObject(item?.probe);
      const mediaCache = plainObject(item?.mediaCache);
      const sourceSample = plainObject(card.sourceSample);
      const details = [
        item?.isPinned === true || sourceSample?.isPinned === true ? '可见置顶内容' : '',
        firstPresent(item?.publishedAt, sourceSample?.publishedAt) ? `发布时间 ${profileText(firstPresent(item?.publishedAt, sourceSample?.publishedAt))}` : '',
        Array.isArray(sourceSample?.interactionFacts) && sourceSample.interactionFacts.length ? `公开互动 ${sourceSample.interactionFacts.join(' · ')}` : '',
        videoLocalMediaCacheLabel(mediaCache?.status),
        videoFrameSourceLabel(item?.frameSource),
        videoDurationLabel(firstPresent(rendered.durationSeconds, probe.durationSeconds, sourceSample?.durationSeconds)),
        videoDimensionLabel(firstPresent(rendered.dimensions, probe.width !== undefined && probe.height !== undefined ? { width: probe.width, height: probe.height } : undefined)),
        probe.videoCodec && `视频 ${probe.videoCodec}`,
        probe.hasAudio === true && (probe.audioCodec ? `音频 ${probe.audioCodec}` : '包含音频'),
      ].filter(Boolean);
      const limitations = Array.from(new Set([
        ...evidenceTextList(item?.limitations),
        ...evidenceTextList(card?.analysisItem?.limitations),
      ])).join(' · ');
      const sampleIndex = firstPresent(item?.sampleIndex, card.sampleIndex, cardIndex + 1);
      const sourceUrl = profileText(firstPresent(item?.sourceUrl, card.sourceUrl, sourceSample?.sourceUrl));
      const detailSample = Object.keys(sourceSample).length ? sourceSample : { id: card.contentItemId, contentItemId: card.contentItemId, sampleIndex, sourceUrl };
      const detailHref = contentPageHref?.(detailSample);
      return <article className="video-evidence-card" id={`video-sample-${sampleIndex}`} key={card.key || `sample-${sampleIndex}`}>
        <header><div><small>视频样本 {sampleIndex}{card.sourceTitle ? ` · ${card.sourceTitle}` : ''}</small>{detailHref && <a className="video-detail-link" href={detailHref}><FileText size={12} />独立解读页</a>}{sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} />原始内容</a>}</div><div className="video-status-list"><span className={`video-status ${itemState.tone}`}>{itemState.label}</span><span className={`video-status ${mediaState.tone}`}>{mediaState.label}</span><span className={`video-status ${transcriptState.tone}`}>{transcriptState.label}</span>{visionState && <span className={`video-status ${visionState.tone}`}>{visionState.label}</span>}</div></header>
        <VideoItemIntelligence card={card} state={itemState} />
        {details.length > 0 && <div className="video-evidence-details">{details.map((detail) => <span key={detail}>{detail}</span>)}</div>}
        {frames.length ? <div className="video-keyframe-grid">{frames.map((frame, frameIndex) => {
          const frameUrl = artifactAssetUrl(jobId, frame?.artifactPath);
          const timestamp = videoDurationLabel(frame?.timeSeconds);
          const ocrText = profileText(frame?.ocrText);
          const semanticText = profileText(frame?.semanticText);
          const timelineDetails = [
            videoTimelineAnchorLabel(frame?.timelineAnchor),
            videoSamplingReasonLabel(frame?.samplingReason),
          ].filter(Boolean);
          return <figure className="video-keyframe" key={frame?.index ?? `frame-${frameIndex}`}>
            {frameUrl ? <img src={frameUrl} alt={`视频样本 ${sampleIndex} 的关键帧 ${frame?.index ?? frameIndex + 1}`} loading="lazy" /> : <div className="video-keyframe-missing">关键帧产物未返回</div>}
            <figcaption><span>帧 {frame?.index ?? frameIndex + 1}{timestamp ? ` · ${timestamp}` : ''}</span><b className={ocrText ? 'ready' : ''}>{ocrText ? 'OCR 已识别' : semanticText ? '画面语义已关联' : 'OCR 未返回'}</b></figcaption>{timelineDetails.length > 0 && <small className="video-keyframe-timeline">{timelineDetails.join(' · ')}</small>}{ocrText && <p>{ocrText}</p>}{semanticText && <p className="video-keyframe-semantic">画面语义：{semanticText}</p>}
          </figure>;
        })}</div> : <div className="video-keyframe-empty">{mediaState.tone === 'complete' ? '视频级证据已归集，但未返回可展示关键帧。' : mediaState.label}</div>}
        {hasVision && <VideoVisionResult vision={vision} jobId={jobId} state={visionState} />}
        <div className="video-transcript"><div><MessageSquareText size={14} /><small>TRANSCRIPT / TIMELINE</small>{transcriptProvider && <small>{transcriptProvider}</small>}{transcriptArtifactUrl && <a className="video-transcript-artifact" href={transcriptArtifactUrl} download target="_blank" rel="noreferrer" title="下载完整转写任务产物"><Download size={12} />完整转写</a>}<b className={`video-status ${transcriptState.tone}`}>{transcriptState.label}</b></div>{transcriptSegments.length > 0 ? <><ol className="video-transcript-segments">{transcriptSegments.map((segment, segmentIndex) => {
          const start = videoDurationLabel(segment.startSeconds);
          const end = videoDurationLabel(segment.endSeconds);
          const range = start && end ? `${start} - ${end}` : start || end || '未返回时间点';
          return <li key={`${segment.index}-${segmentIndex}`}><time>{range}</time><span>{segment.text || '该时间段未返回可展示文本'}</span></li>;
        })}</ol>{transcriptSegmentOverflow > 0 && <small className="video-transcript-more">另有 {transcriptSegmentOverflow} 个转写片段保存在任务产物中</small>}</> : profileText(transcript.text) ? <p>{profileText(transcript.text)}</p> : <span>{transcriptState.label}</span>}</div>
        {limitations && <small className="video-limitations">限制：{limitations}</small>}
      </article>;
    })}</div> : <div className="video-evidence-empty"><Play size={17} /><div><strong>{aggregateState.label}</strong><small>{aggregateLimitations || '尚未返回可展示的逐视频处理结果。'}</small></div></div>}
    {cards.length > 0 && <div className="video-evidence-more"><span>已显示 {displayedCards.length} / {cards.length} 条视频</span>{hasMoreCards && <div><button type="button" onClick={() => setVideoRenderLimit((limit) => Math.min(limit + 20, cards.length))}>显示更多 20 条</button><button className="secondary" type="button" onClick={() => setVideoRenderLimit(cards.length)}>全部显示</button></div>}</div>}
    {showRollup && <VideoAnalysisRollup rollup={videoRollup} cardCount={cards.length} />}
    {aggregateLimitations && cards.length > 0 && <small className="video-aggregate-limitations">视频限制：{aggregateLimitations}</small>}
  </section>;
}

function VideoVisionResult({ vision, jobId, state }) {
  const result = plainObject(vision?.result);
  const visualThemes = evidenceTextList(result.visualThemes);
  const sceneTypes = evidenceTextList(result.sceneTypes);
  const onScreenTextSignals = evidenceTextList(result.onScreenTextSignals);
  const productSignals = evidenceTextList(result.productSignals);
  const visibleBrandSignals = evidenceTextList(result.visibleBrandSignals);
  const commercialSignals = evidenceTextList(result.commercialSignals);
  const brandSafetyFlags = evidenceTextList(result.brandSafetyFlags);
  const reviewSignals = Array.isArray(result.reviewSignals) ? result.reviewSignals.map((signal) => {
    const description = profileText(signal?.description);
    if (!description) return '';
    const severity = ({ high: '高优先级', medium: '中优先级', low: '低优先级' })[profileText(signal?.severity).toLowerCase()] || '待复核';
    const frameIndexes = Array.isArray(signal?.frameIndexes)
      ? signal.frameIndexes.filter((index) => Number.isInteger(index) && index > 0).slice(0, 4)
      : [];
    return `${severity}${frameIndexes.length ? ` · 帧 ${frameIndexes.join('、')}` : ''} · ${description}`;
  }).filter(Boolean) : [];
  const legacySafetyFlags = reviewSignals.length ? [] : brandSafetyFlags;
  const observations = Array.isArray(result.frameObservations) ? result.frameObservations : [];
  const analyzedFrameCount = firstPresent(vision?.analyzedFrameCount, observations.length);
  const frameIndexes = evidenceTextList(vision?.frameIndexes);
  const frameIndexLabel = frameIndexes.length ? `帧 ${frameIndexes.slice(0, 8).join('、')}${frameIndexes.length > 8 ? ` 等 ${frameIndexes.length} 帧` : ''}` : '';
  const artifactUrl = artifactAssetUrl(jobId, vision?.artifactPath);
  const limitations = profileText(vision?.limitations);
  const hasSemanticResult = Boolean(
    profileText(result.summary)
    || visualThemes.length
    || sceneTypes.length
    || onScreenTextSignals.length
    || productSignals.length
    || visibleBrandSignals.length
    || commercialSignals.length
    || reviewSignals.length
    || legacySafetyFlags.length
    || observations.length
    || result.confidence !== undefined,
  );
  const modelDetails = [
    vision?.provider && `服务 ${vision.provider}`,
    vision?.model && `模型 ${vision.model}`,
    analyzedFrameCount !== undefined && analyzedFrameCount !== null && `已分析 ${analyzedFrameCount} 帧`,
    frameIndexLabel,
  ].filter(Boolean);
  return <section className={`video-vision ${state?.tone || 'unavailable'}`} aria-label="视频视觉语义">
    <header><div><Play size={14} /><small>VIDEO VISUAL / SEMANTIC</small><strong>视觉语义</strong></div><div>{artifactUrl && <a href={artifactUrl} target="_blank" rel="noreferrer" title="查看视觉语义产物"><FileText size={12} />产物</a>}<span className={`video-status ${state?.tone || 'unavailable'}`}>{state?.label || '未返回视觉语义'}</span></div></header>
    {modelDetails.length > 0 && <div className="video-vision-meta">{modelDetails.map((detail) => <span key={detail}>{detail}</span>)}</div>}
    {hasSemanticResult ? <><div className="video-vision-summary">{result.summary && <p>{result.summary}</p>}{result.confidence !== undefined && <span>置信度：{percentLabel(result.confidence)}</span>}</div><div className="video-vision-signals"><VideoVisionSignal label="视觉主题" values={visualThemes} /><VideoVisionSignal label="场景类型" values={sceneTypes} /><VideoVisionSignal label="画面文本信号" values={onScreenTextSignals} /><VideoVisionSignal label="产品信号" values={productSignals} /><VideoVisionSignal label="可见品牌或标识" values={visibleBrandSignals} /><VideoVisionSignal label="商业合作或带货露出" values={commercialSignals} /><VideoVisionSignal label="需人工复核的画面信号" values={reviewSignals} tone="safety" /><VideoVisionSignal label="兼容风险标记" values={legacySafetyFlags} tone="safety" /></div>{observations.length > 0 && <div className="video-vision-observations"><small>FRAME OBSERVATIONS / 逐帧观察</small>{observations.map((observation, observationIndex) => { const visualSignals = evidenceTextList(observation?.visualSignals); const textSignals = evidenceTextList(observation?.textSignals); const productObservationSignals = evidenceTextList(observation?.productSignals); const description = profileText(observation?.description); if (!description && !visualSignals.length && !textSignals.length && !productObservationSignals.length) return null; return <article key={observation?.frameIndex ?? `observation-${observationIndex}`}><strong>帧 {observation?.frameIndex ?? observationIndex + 1}</strong>{description && <p>{description}</p>}<div>{visualSignals.length > 0 && <VideoVisionSignal label="画面" values={visualSignals} />}{textSignals.length > 0 && <VideoVisionSignal label="画面文本信号" values={textSignals} />}{productObservationSignals.length > 0 && <VideoVisionSignal label="产品" values={productObservationSignals} />}</div></article>; })}</div>}</> : <div className="video-vision-empty"><strong>{state?.label || '未返回视觉语义'}</strong><small>{limitations || '该视频没有可展示的视觉模型结果。'}</small></div>}
    {limitations && hasSemanticResult && <small className="video-vision-limitations">视觉限制：{limitations}</small>}
  </section>;
}

function VideoVisionSignal({ label, values, tone = '' }) {
  if (!values.length) return null;
  return <div className={`video-vision-signal ${tone}`}><small>{label}</small><div>{values.map((value) => <span key={value}>{value}</span>)}</div></div>;
}

function downloadJsonSnapshot(filename, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function snapshotFileStem(value, fallback = 'creator') {
  const stem = String(value || fallback).trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return stem || fallback;
}

function AudienceInsightPanel({ creator, insight, loading, importing, error, onImport, onRefresh }) {
  const sourceLabel = insight?.source?.label || '未导入';
  const sourceScope = insight?.source?.dataScope === 'aggregate' ? '仅聚合数据' : insight?.source?.dataScope || '仅聚合数据';
  const capturedAt = audienceCapturedLabel(insight?.source?.capturedAt || insight?.capturedAt);
  const coverage = insight?.coverage || {};
  const totalAudience = countLabel(profileValue(insight?.profile, ['totalAudience', 'audienceTotal', 'total']));
  const standardDistributions = [
    { title: '性别', caption: 'GENDER', entries: insight?.gender || [], tone: 'red' },
    { title: '年龄', caption: 'AGE', entries: insight?.age || [], tone: 'green' },
    { title: '城市层级', caption: 'CITY TIER', entries: insight?.cityTier || [], tone: 'ink' },
    { title: '兴趣', caption: 'INTERESTS', entries: insight?.interests || [], tone: 'lime' },
    { title: '活跃时段', caption: 'ACTIVE HOURS', entries: insight?.activeHours || [], tone: 'orange' },
  ];
  const distributions = [...standardDistributions, ...(insight?.dimensions || []).map((dimension, index) => ({
    title: dimension.title,
    caption: dimension.caption || 'AGGREGATE DIMENSION',
    entries: dimension.entries || [],
    tone: ['ink', 'lime', 'orange', 'red', 'green'][index % 5],
  }))];
  const totalBuckets = distributions.reduce((total, distribution) => total + distribution.entries.length, 0);
  const reportId = profileText(insight?.evidence?.sourceReportId);
  return <section className="audience-insight" aria-label={`${creator.name} 的粉丝聚合画像`}>
    <div className="audience-insight-head"><div><small>FAN AUDIENCE / AGGREGATE</small><strong>粉丝画像</strong><span>{sourceScope}{capturedAt ? ` · ${capturedAt}` : ''}{insight ? ` · ${distributions.length} 维度 / ${totalBuckets} 分组` : ''}</span></div><div className="audience-actions">{insight && <button className="audience-export" onClick={() => downloadJsonSnapshot(`${snapshotFileStem(creator.id || creator.name)}-audience-aggregate.json`, insight)} title="导出当前粉丝聚合画像 JSON"><Download size={14} />导出 JSON</button>}<button className="icon-btn audience-refresh" onClick={() => void onRefresh()} disabled={loading || importing} aria-label="刷新粉丝画像" title="刷新粉丝画像">{loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button><label className="audience-import"><Upload size={14} />{importing ? '导入中' : '导入 JSON'}<input type="file" accept="application/json,.json" onChange={onImport} disabled={importing} /></label></div></div>
    {insight ? <><div className="audience-meta"><AudienceMetric label="来源" value={sourceLabel} /><AudienceMetric label="样本" value={countLabel(coverage.sampleSize) || totalAudience || '—'} /><AudienceMetric label="覆盖率" value={percentLabel(coverage.coverageRate) || '—'} /><AudienceMetric label="完整度" value={percentLabel(coverage.completeness) || '—'} /><AudienceMetric label="置信度" value={percentLabel(coverage.confidence) || '—'} /><AudienceMetric label="源报告" value={reportId || '—'} /></div><div className="audience-distribution-grid">{distributions.map((distribution) => <AudienceDistribution key={`${distribution.caption}-${distribution.title}`} {...distribution} />)}</div><AudienceProvenance evidence={insight.evidence} /></> : <div className="audience-empty"><Users size={18} /><div><strong>{loading ? '正在同步粉丝画像' : '尚无粉丝画像'}</strong><small>{error || '导入该达人的聚合粉丝画像 JSON。'}</small></div></div>}
  </section>;
}

function AudienceMetric({ label, value }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function AudienceDistribution({ title, caption, entries, tone }) {
  return <section className={`audience-distribution ${tone}`}><div className="audience-distribution-head"><div><small>{caption}</small><strong>{title}</strong></div><span>{entries.length ? `${entries.length} 组` : '—'}</span></div>{entries.length ? <div className="audience-bars">{entries.map((entry) => <div key={`${entry.label}-${entry.percent}`}><span title={entry.label}>{entry.label}</span><i><b style={{ width: `${entry.percent}%` }} /></i><strong>{entry.percentLabel || entry.value || '—'}</strong></div>)}</div> : <p>暂无已导入数据</p>}</section>;
}

function AudienceProvenance({ evidence }) {
  const source = plainObject(evidence);
  const dimensions = Object.entries(plainObject(source.dimensions));
  const warnings = Array.isArray(source.warnings) ? source.warnings.filter(Boolean) : [];
  if (!source.schemaVersion && !source.sourceReportId && !dimensions.length && !warnings.length) return null;
  return <section className="audience-provenance" aria-label="粉丝画像来源与口径">
    <header><div><small>PROVENANCE / COVERAGE</small><strong>来源与口径</strong></div><span>{source.schemaVersion || '聚合数据'}</span></header>
    <div className="audience-provenance-meta">{source.sourceReportId && <span>源报告 {source.sourceReportId}</span>}{dimensions.map(([name, diagnostic]) => <span key={name}>{name} {plainObject(diagnostic).bucketCount ?? 0} 组</span>)}</div>
    {warnings.length > 0 && <p>{warnings.join(' · ')}</p>}
  </section>;
}

function channelResultFor(job, channelId) {
  const matches = Object.values(job?.channelResults || {}).filter((result) => result.platform === channelId);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  const allSucceeded = matches.every((result) => result.status === 'succeeded');
  const allEmpty = matches.every((result) => result.status === 'completed_empty');
  const status = allSucceeded ? 'succeeded'
    : allEmpty ? 'completed_empty'
      : matches.some((result) => result.status === 'waiting_for_connection') ? 'waiting_for_connection'
        : matches.some((result) => result.status === 'waiting_for_configuration') ? 'waiting_for_configuration'
          : matches.some((result) => result.status === 'failed') ? 'failed' : 'partial_success';
  return {
    ...matches[0],
    status,
    records: matches.reduce((total, result) => total + (result.records || 0), 0),
    creators: matches.reduce((total, result) => total + (result.creators || 0), 0),
    sourceUrls: [...new Set(matches.flatMap((result) => result.sourceUrls || []))],
  };
}

function CrawlStep({ job, running, onRun, count, channels, selected, profileConfirmedCount, profileArtifactCount, profileConfirmationComplete }) {
  const activeChannels = channelOptions.filter((channel) => channels.includes(channel.id));
  const progress = job?.progress || 0;
  const events = job?.events || [];
  const status = job?.status || 'idle';
  const stage = status === 'succeeded' || status === 'partial_success' ? 4 : running ? Math.max(1, Math.min(4, Math.ceil(progress / 25))) : 0;
  const sourceRecords = job?.metrics?.sourceRecords ?? 0;
  return <section className="step-content crawl-layout">
    <div className="crawl-main">
      <div className="crawl-command"><div><span className={`pulse-dot ${running ? 'live' : ''}`} /><div><small>AGENT RUN / REAL-ACCOUNT-VERIFY</small><strong>{status === 'idle' ? '任务已就绪' : statusLabel(status)}</strong></div></div><button className="run-btn" onClick={onRun} disabled={running || !count}>{running ? <LoaderCircle className="spin" size={17} /> : status === 'succeeded' || status === 'partial_success' ? <RefreshCw size={17} /> : <Play size={17} />}{running ? '核验中' : status === 'succeeded' || status === 'partial_success' ? '重新核验' : '开始真实核验'}</button></div>
      {profileConfirmationComplete && <div className="compliance"><ShieldCheck size={16} /><span><strong>主页画像已确认</strong><small>{profileConfirmedCount} 位已选达人已完成直接主页确认，已保存 {profileArtifactCount} 份来源快照；可直接进入建联草稿与报告，独立核验仍可按需补跑。</small></span></div>}
      <div className="progress-block"><div><span>真实任务进度</span><strong>{job ? `${progress}%` : '—'}</strong></div><div className="main-progress"><i style={{ width: `${progress}%` }} /></div><small>{job ? `${job.type === 'verify' ? count : 0} 位目标 · ${sourceRecords} 条源记录 · ${statusLabel(status)}` : `${count} 位已选 KOL · 等待启动平台连接器`}</small></div>
      <div className="agent-grid">{agentNodes.map((agent, index) => { const Icon = agent.icon; const active = stage === index + 1 && running; const done = stage > index + 1 || status === 'succeeded' || status === 'partial_success'; return <div className={`agent-node ${active ? 'active' : ''} ${done ? 'done' : ''}`} key={agent.id}><div className="node-icon">{done ? <Check size={17} /> : active ? <LoaderCircle className="spin" size={17} /> : <Icon size={17} />}</div><div><strong>{agent.name}</strong><small>{agent.role}</small></div><span>{done ? 'DONE' : active ? 'RUNNING' : 'WAITING'}</span></div>; })}</div>
      <div className="run-log"><div className="log-title"><span><Activity size={14} />LIVE EXECUTION LOG</span><small>{events.length} EVENTS</small></div><div className="log-lines">{events.length ? events.map((event, index) => <p key={`${event.at}-${index}`}><time>{eventTime(event.at)}</time><i>{event.level === 'success' ? 'SUCCESS' : event.level === 'error' ? 'ERROR' : event.level === 'warn' ? 'ACTION' : 'INFO'}</i><span>{event.message}{event.action ? ` ${event.action}` : ''}</span></p>) : <p className="log-empty">启动后此处只显示连接器返回的真实事件。</p>}</div></div>
    </div>
    <aside className="quality-panel"><SectionTitle number="DATA" title="真实数据快照" caption="SOURCE HEALTH" /><dl className="real-metrics"><div><dt>目标账号</dt><dd>{count}</dd></div><div><dt>源记录</dt><dd>{sourceRecords}</dd></div><div><dt>归一化候选</dt><dd>{job?.metrics?.creators ?? 0}</dd></div><div><dt>任务状态</dt><dd>{statusLabel(status)}</dd></div></dl><div className="source-list"><strong>平台与来源</strong>{activeChannels.map((channel) => { const result = channelResultFor(job, channel.id); return <span key={channel.id}><Globe2 size={14} />{channel.name} · {result?.status ? statusLabel(result.status) : '待运行'}</span>; })}{selected.slice(0, 4).map((creator) => <span key={creator.id}><Link2 size={14} />{creator.name} · {creator.sampleCount} 条已发现样本</span>)}</div>{job?.status === 'waiting_for_connection' && <div className="compliance"><AlertCircle size={16} /><span><strong>需要连接动作</strong><small>{Object.values(job.channelResults || {}).find((item) => item.error?.action)?.error?.action || '查看任务日志中的连接器提示。'}</small></span></div>}<div className="compliance"><ShieldCheck size={16} /><span><strong>任务快照</strong><small>源记录、时间与连接器日志会保存在本机任务目录</small></span></div></aside>
  </section>;
}

function outreachDraftStatusLabel(status) {
  const labels = {
    ready: '证据可用',
    stale: '内容有更新',
    blocked: '等待内容证据',
  };
  return labels[status] || '尚未生成';
}

function outreachReviewStatusLabel(status) {
  const labels = {
    draft: '待审核',
    approved: '已审核',
    sent: '已标记发送',
  };
  return labels[status] || '待审核';
}

function outreachFreshnessLabel(freshness) {
  const labels = {
    current_snapshot: '当前快照一致',
    captured_snapshot: '采集快照',
    stale_source_changed: '内容快照已变化',
    source_capture_unavailable: '未找到当前内容快照',
    input_fingerprint_unavailable: '缺少内容指纹',
  };
  return labels[freshness] || '待校验';
}

function outreachEvidenceTimeAnchor(primary) {
  if (!primary) return '待生成证据锚点';
  const seconds = Number(primary.timeSeconds ?? primary.startSeconds);
  const clip = Number.isFinite(seconds) && seconds >= 0
    ? `视频 ${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
    : '';
  const sample = Number(primary.sampleIndex);
  const position = Number.isFinite(sample) && sample > 0 ? `第 ${sample} 条公开内容` : '公开内容';
  return [position, clip, primary.publishedAt].filter(Boolean).join(' · ');
}

function outreachModalities(manifest) {
  const modalityLabels = { text: '文本', image: '画面', audio: '音频', video: '视频' };
  return Object.entries(manifest?.modalities || {})
    .filter(([, value]) => value && value.status && value.status !== 'not_available')
    .map(([key, value]) => `${modalityLabels[key] || key} ${value.count || 0}`)
    .join(' · ') || '待补齐多模态证据';
}

function summarizeOutreachDrafts(drafts) {
  return (Array.isArray(drafts) ? drafts : []).reduce((summary, draft) => {
    const status = draft?.status || 'unavailable';
    const review = draft?.review?.status || 'draft';
    return {
      ...summary,
      total: summary.total + 1,
      ready: summary.ready + (status === 'ready' ? 1 : 0),
      blocked: summary.blocked + (status === 'blocked' ? 1 : 0),
      stale: summary.stale + (status === 'stale' ? 1 : 0),
      sent: summary.sent + (review === 'sent' ? 1 : 0),
      approved: summary.approved + (review === 'approved' ? 1 : 0),
    };
  }, { total: 0, ready: 0, blocked: 0, stale: 0, sent: 0, approved: 0 });
}

function EvidenceLockedMessageStep({ selected, brief, contentReady, missingContentCreators, onOpenContentFlow, drafts, loading, error, onGenerate, onUpdateDraft, notify }) {
  const [active, setActive] = useState(selected[0]?.id || '');
  const [draftBody, setDraftBody] = useState('');
  const draftsByTargetId = useMemo(() => new Map((drafts || []).map((draft) => [draft.targetId, draft])), [drafts]);
  const draftSummary = useMemo(() => summarizeOutreachDrafts(drafts), [drafts]);
  const creator = selected.find((item) => item.id === active) || selected[0] || null;
  const activeDraft = creator ? draftsByTargetId.get(creator.id) || null : null;
  const primaryEvidence = activeDraft?.evidence?.primary || null;
  const isReady = activeDraft?.status === 'ready' && Boolean(activeDraft?.message?.body);
  const hasChanges = isReady && draftBody.trim() && draftBody !== activeDraft.message.body;
  const missingNames = (missingContentCreators || []).slice(0, 3).map((item) => item.name).join('、');
  const missingSuffix = (missingContentCreators || []).length > 3 ? ` 等 ${missingContentCreators.length} 位` : '';

  useEffect(() => {
    if (!selected.some((item) => item.id === active)) setActive(selected[0]?.id || '');
  }, [selected, active]);

  useEffect(() => {
    setDraftBody(activeDraft?.message?.body || '');
  }, [activeDraft?.id, activeDraft?.message?.body, activeDraft?.updatedAt]);

  const copy = async () => {
    if (!draftBody) return;
    try {
      await navigator.clipboard.writeText(draftBody);
      notify('建联草稿已复制');
    } catch {
      notify('浏览器未允许访问剪贴板');
    }
  };
  const save = async () => {
    if (!creator || !hasChanges) return;
    const saved = await onUpdateDraft(creator.id, { messageBody: draftBody });
    if (saved) notify(`${creator.name} 的草稿已保存`);
  };
  const updateReview = async (reviewStatus) => {
    if (!creator || !isReady) return;
    const saved = await onUpdateDraft(creator.id, { reviewStatus });
    if (saved) notify(`${creator.name} 已${outreachReviewStatusLabel(reviewStatus)}`);
  };

  return <section className="step-content message-layout outreach-workspace">
    <div className="message-queue outreach-queue">
      <div className="queue-head outreach-queue-head">
        <span><strong>建联工作队列</strong><small>{selected.length} 位已选 KOL · {draftSummary.ready} 份证据可用</small></span>
        <button onClick={() => onGenerate({ regenerate: draftSummary.total > 0 })} disabled={loading || !contentReady || !selected.length} title={!contentReady ? '需要先完成每位已选达人的内容采集和理解' : ''}>
          {loading ? <LoaderCircle className="spin" size={15} /> : draftSummary.total ? <RefreshCw size={15} /> : <Sparkles size={15} />}
          {loading ? '生成中' : draftSummary.total ? '刷新草稿' : '批量生成'}
        </button>
      </div>
      <div className="outreach-queue-summary" aria-label="草稿状态摘要">
        <span>可用 <b>{draftSummary.ready}</b></span><span>待补齐 <b>{draftSummary.blocked}</b></span><span>已变化 <b>{draftSummary.stale}</b></span>
      </div>
      {selected.map((item) => {
        const itemDraft = draftsByTargetId.get(item.id);
        const status = itemDraft?.status || 'unavailable';
        return <button className={active === item.id ? 'active' : ''} key={item.id} onClick={() => setActive(item.id)}>
          <Avatar creator={item} />
          <span><strong>{item.name}</strong><small>{item.platform} · {outreachDraftStatusLabel(status)}</small></span>
          <i className={`outreach-status-dot ${status}`} title={outreachDraftStatusLabel(status)} />
        </button>;
      })}
    </div>
    <div className="message-editor outreach-editor">
      {error && <div className="outreach-error"><AlertCircle size={15} /><span>{error}</span></div>}
      {creator && isReady ? <>
        <div className="editor-head">
          <div><small>EVIDENCE-LOCKED OUTREACH DRAFT</small><strong>{creator.name} · 个性化首轮建联</strong></div>
          <div className="editor-actions">
            <button onClick={copy} aria-label="复制建联草稿" title="复制建联草稿"><Clipboard size={15} /></button>
            <button aria-label="打开内容来源" title="打开内容来源" onClick={() => primaryEvidence?.sourceUrl && window.open(primaryEvidence.sourceUrl, '_blank', 'noopener,noreferrer')} disabled={!primaryEvidence?.sourceUrl}><ExternalLink size={15} /></button>
          </div>
        </div>
        <div className="personalization-row"><Sparkles size={15} /><span>开场只引用已保存的内容证据，并关联 <strong>{activeDraft.evidence.ids.length} 个可追溯锚点</strong></span><b>{outreachFreshnessLabel(activeDraft.source.freshness)}</b></div>
        <div className="message-evidence outreach-evidence">
          <div><span>开场依据 · {outreachEvidenceTimeAnchor(primaryEvidence)}</span>{primaryEvidence?.sourceUrl && <a href={primaryEvidence.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />原内容</a>}</div>
          <p>“{primaryEvidence?.excerpt}”</p>
          <small>内容解读：{activeDraft.reasoning.statement}</small>
        </div>
        <textarea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} aria-label={`${creator.name} 的建联消息`} />
        <div className="message-meta outreach-message-meta"><span><ShieldCheck size={14} />证据、来源和快照状态锁定；仅文案与审核状态可编辑</span><span>{draftBody.length} 字</span></div>
        <div className="message-actions outreach-message-actions">
          <button className="secondary-action" onClick={copy}><Clipboard size={15} />复制</button>
          <button className="secondary-action" onClick={save} disabled={!hasChanges || loading}><FileText size={15} />保存草稿</button>
          <button className="secondary-action" onClick={() => void updateReview('approved')} disabled={loading || activeDraft.review.status === 'approved' || activeDraft.review.status === 'sent'}><CheckCircle2 size={15} />{activeDraft.review.status === 'approved' || activeDraft.review.status === 'sent' ? '已审核' : '通过审核'}</button>
          <button className="primary-action" onClick={() => void updateReview('sent')} disabled={loading || activeDraft.review.status === 'sent'}><Send size={15} />{activeDraft.review.status === 'sent' ? '已标记发送' : '标记发送'}</button>
        </div>
      </> : <div className="generate-empty outreach-empty">
        <div className="spark-ring"><WandSparkles size={25} /></div>
        <h3>{contentReady ? activeDraft?.status === 'stale' ? '内容已变化，需要重新理解' : '生成逐达人内容驱动建联草稿' : '先补齐内容采集与内容理解'}</h3>
        <p>{contentReady
          ? activeDraft?.reason?.message || '系统会为每位达人锁定原内容、内容理解结论与当前快照，再生成可审核的首轮建联文案。'
          : `${missingNames || '当前已选达人'}${missingSuffix} 缺少可引用的原内容或内容理解结论，因此不会生成泛化招呼语。`}</p>
        {!contentReady && <button className="secondary-action" onClick={onOpenContentFlow}><Layers3 size={16} />去内容采集与分析</button>}
        <button className="primary-action" onClick={() => onGenerate({ regenerate: Boolean(activeDraft) })} disabled={loading || !contentReady || !selected.length}><Sparkles size={16} />{loading ? '正在生成' : '生成证据锁定草稿'}</button>
      </div>}
    </div>
    <aside className="message-insights outreach-insights">
      <SectionTitle number="AI" title="建联依据" caption="CONTENT TO OUTREACH" />
      <dl>
        <div><dt>品牌语气</dt><dd>{brief.tone || '待补充'}</dd></div>
        <div><dt>草稿状态</dt><dd>{outreachDraftStatusLabel(activeDraft?.status)}</dd></div>
        <div><dt>审核状态</dt><dd>{outreachReviewStatusLabel(activeDraft?.review?.status)}</dd></div>
        <div><dt>内容快照</dt><dd>{outreachFreshnessLabel(activeDraft?.source?.freshness)}</dd></div>
        <div><dt>多模态证据</dt><dd>{outreachModalities(activeDraft?.multimodalManifest)}</dd></div>
        <div><dt>报价字段</dt><dd>{creator?.priceLabel || '未提供'}</dd></div>
      </dl>
      <div className="score-ring"><span><strong>{activeDraft?.evidence?.ids?.length || 0}</strong><small>{primaryEvidence ? '建联证据锚点' : '等待内容锚点'}</small></span></div>
    </aside>
  </section>;
}

function MessageStep({ selected, brief, contentAnalysisByTargetId, contentReady, missingContentCreators, onOpenContentFlow, generated, onGenerate, sent, setSent, notify }) {
  const [active, setActive] = useState(selected[0]?.id);
  const [draft, setDraft] = useState('');
  useEffect(() => { if (!selected.some((item) => item.id === active)) setActive(selected[0]?.id); }, [selected, active]);
  const creator = selected.find((item) => item.id === active) || selected[0];
  const analysisRecord = creator ? contentAnalysisByTargetId?.[creator.id] : null;
  const outreachContext = evidenceBackedOutreachContext(analysisRecord);
  const brandName = brief.brand || '我们团队';
  const productName = brief.product || '这次产品';
  const messageTemplate = creator && outreachContext ? `你好 ${creator.name}，\n\n我们注意到你近期公开内容中提到「${outreachContext.contentExcerpt}」。这类 ${outreachContext.contentKindLabel} 的真实表达，是我们这次希望认真了解的内容方向。\n\n我是 ${brandName} 的阿棠。我们正在筹备「${productName}」的体验合作计划，想先请教你会如何把这类表达放进真实体验内容，也想了解你在内容形式和合作边界上更看重什么。\n\n我们希望邀请你按自己的表达方式完成真实体验，不设置强制脚本。合作预算和排期可以按你的常规方式沟通；若你感兴趣，我可以发完整产品资料与 Brief。\n\n期待你的回复，\n阿棠 · ${brandName}` : '';
  useEffect(() => { setDraft(messageTemplate); }, [messageTemplate]);
  const missingNames = missingContentCreators.slice(0, 3).map((item) => item.name).join('、');
  const missingSuffix = missingContentCreators.length > 3 ? ` 等 ${missingContentCreators.length} 位` : '';
  const markSent = (id) => { setSent((items) => items.includes(id) ? items : [...items, id]); notify(`已记录发给 ${creator.name} 的消息`); };
  const copy = async () => {
    if (!draft) return;
    await navigator.clipboard.writeText(draft);
    notify('个性化消息已复制');
  };
  return <section className="step-content message-layout"><div className="message-queue"><div className="queue-head"><span><strong>消息队列</strong><small>{selected.length} 位已选 KOL</small></span><button onClick={onGenerate} disabled={!contentReady || !selected.length} title={!contentReady ? '需先完成全部已选达人的内容采集与内容理解' : ''}>{generated ? <RefreshCw size={15} /> : <Sparkles size={15} />}{generated ? '重新生成' : '批量生成'}</button></div>{selected.map((item) => <button className={active === item.id ? 'active' : ''} key={item.id} onClick={() => setActive(item.id)}><Avatar creator={item} /><span><strong>{item.name}</strong><small>{item.platform} · {item.sampleCount} 条样本</small></span>{sent.includes(item.id) ? <CheckCircle2 className="sent-icon" size={17} /> : <i />}</button>)}</div>
    <div className="message-editor">{generated && creator && outreachContext ? <><div className="editor-head"><div><small>CONTENT-GROUNDED OUTREACH DRAFT</small><strong>新品体验合作邀请 · {creator.name}</strong></div><div className="editor-actions"><button onClick={copy} aria-label="复制消息"><Clipboard size={15} /></button><button aria-label="打开建联内容来源" onClick={() => outreachContext.contentSourceUrl && window.open(outreachContext.contentSourceUrl, '_blank', 'noopener,noreferrer')} disabled={!outreachContext.contentSourceUrl}><ExternalLink size={15} /></button></div></div><div className="personalization-row"><Sparkles size={15} /><span title={outreachContext.evidenceIds.join(' · ')}>开场已引用 <strong>{outreachContext.contentKindLabel}</strong>，并关联 {outreachContext.evidenceIds.length} 个可追溯证据锚点</span><b>CONTENT LINKED</b></div><div className="message-evidence"><div><span>开场依据 · {outreachContext.contentTimeAnchor}{outreachContext.contentPublishedAt ? ` · ${outreachContext.contentPublishedAt}` : ''}</span><a href={outreachContext.contentSourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />原内容</a></div><p>“{outreachContext.contentExcerpt}”</p><small>内容理解：{outreachContext.statement}</small></div><textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={`${creator.name} 的建联消息`} /><div className="message-meta"><span><ShieldCheck size={14} />使用前请人工复核品牌边界</span><span>{draft.length} 字</span></div><div className="message-actions"><button className="secondary-action" onClick={copy}><Clipboard size={15} />复制</button><button className="primary-action" onClick={() => markSent(creator.id)}><Send size={15} />{sent.includes(creator.id) ? '已标记发送' : '标记为已发送'}</button></div></> : <div className="generate-empty"><div className="spark-ring"><WandSparkles size={25} /></div><h3>{contentReady ? '生成逐人内容驱动的建联草稿' : '先补齐内容采集与内容理解'}</h3><p>{contentReady ? '每位草稿都会先引用一条可打开的原内容，再结合内容理解结论生成沟通切入；不会再按赛道、标题或样本数量兜底。' : `${missingNames || '当前已选达人'}${missingSuffix} 缺少可引用的原内容和内容分析结论，系统不会生成泛化招呼语。`}</p>{!contentReady && <button className="secondary-action" onClick={onOpenContentFlow}><Layers3 size={16} />去内容采集与分析</button>}<button className="primary-action" onClick={onGenerate} disabled={!contentReady || !selected.length}><Sparkles size={16} />开始批量生成</button></div>}</div>
    <aside className="message-insights"><SectionTitle number="AI" title="消息依据" caption="OUTREACH LOGIC" /><dl><div><dt>品牌语气</dt><dd>{brief.tone}</dd></div><div><dt>开场内容</dt><dd>{outreachContext?.contentKindLabel || '待采集'}</dd></div><div><dt>证据状态</dt><dd>{outreachContext ? `${outreachContext.evidenceIds.length} 个已校验锚点` : analysisRecord?.analysis ? '缺少可引用原内容' : '尚未运行内容理解'}</dd></div><div><dt>内容来源</dt><dd>{outreachContext?.contentTimeAnchor || '待采集'}</dd></div><div><dt>报价字段</dt><dd>{creator?.priceLabel || '未提供'}</dd></div></dl><div className="score-ring"><span><strong>{outreachContext?.evidenceIds.length || 0}</strong><small>{outreachContext ? '建联证据锚点' : '缺少内容锚点'}</small></span></div></aside></section>;
}

function ContentAnalysisReportRow({ creator, record }) {
  const analysis = record.analysis;
  const roleCount = (analysis.roles || []).filter((role) => role?.findings?.length || role?.summary).length;
  const deepNarrative = profileText(analysis?.deepInsights?.coreNarrative, profileText(analysis?.deepInsights?.thesis?.statement));
  const firstEvidenceBeat = Array.isArray(analysis?.deepInsights?.evidenceChain) ? analysis.deepInsights.evidenceChain[0] : null;
  const evidenceBeatDetail = profileText(firstEvidenceBeat?.statement);
  return <article>
    <div><strong>{creator.name}</strong><small>{creator.platform} · {analysisStatusLabel(analysis.status)} · {roleCount} 个角色返回 · {analysisFindingCount(record)} 条判断</small></div>
    {deepNarrative && <p>{deepNarrative}</p>}
    {!deepNarrative && analysis.synthesis?.summary && <p>{analysis.synthesis.summary}</p>}
    {evidenceBeatDetail && <span>画面证据：{evidenceBeatDetail}</span>}
    {analysis.synthesis?.limitations && <span>局限：{profileText(analysis.synthesis.limitations)}</span>}
  </article>;
}

function ReportOutreachQueue({ selected, drafts }) {
  const draftSummary = useMemo(() => summarizeOutreachDrafts(drafts), [drafts]);
  const draftsByTargetId = useMemo(() => new Map((drafts || []).map((draft) => [draft.targetId, draft])), [drafts]);
  return <section className="report-outreach">
    <div className="report-analysis-head">
      <div><small>OUTREACH READINESS / EVIDENCE-LOCKED QUEUE</small><strong>建联投放队列</strong><span>{draftSummary.ready} 份可用草稿 · {draftSummary.approved} 份已审核 · {draftSummary.sent} 份已标记发送</span></div>
    </div>
    {selected.length ? <div className="report-outreach-list">{selected.map((creator) => {
      const draft = draftsByTargetId.get(creator.id);
      const primary = draft?.evidence?.primary;
      return <article key={creator.id}>
        <div className="report-outreach-row-head"><div><strong>{creator.name}</strong><small>{creator.platform} · {outreachDraftStatusLabel(draft?.status)} · {outreachReviewStatusLabel(draft?.review?.status)}</small></div><span className={`outreach-status-pill ${draft?.status || 'unavailable'}`}>{outreachDraftStatusLabel(draft?.status)}</span></div>
        {primary ? <><p>{primary.excerpt}</p><span>{outreachEvidenceTimeAnchor(primary)} · {outreachFreshnessLabel(draft?.source?.freshness)}</span>{draft?.reasoning?.statement && <small>{draft.reasoning.statement}</small>}</> : <p>{draft?.reason?.message || '尚未生成内容证据锁定的建联草稿。'}</p>}
      </article>;
    })}</div> : <div className="report-analysis-empty"><WandSparkles size={17} /><span>完成候选选择、内容采集和理解后，这里会显示逐达人的建联准备状态。</span></div>}
  </section>;
}

function ReportStep({ selected, channels, sent, generated, outreachDrafts, onExport, brief, job, verificationJob, enrichmentJob, enrichmentRunCount, profileConfirmedCount, profileArtifactCount, contentJob, contentRunCount, contentArtifactCount, contentSampleCount, contentAnalysisJob, contentAnalysisRunCount, contentAnalysisCreatorCount, contentAnalysisFindingCount, contentAnalysisByTargetId }) {
  const activeChannels = channelOptions.filter((channel) => channels.includes(channel.id));
  const outreachSummary = useMemo(() => summarizeOutreachDrafts(outreachDrafts), [outreachDrafts]);
  const sourceRecords = job?.metrics?.sourceRecords ?? 0;
  const independentlyVerifiedCount = verificationJob?.metrics?.verifiedTargets ?? 0;
  const usesProfileConfirmation = selected.length > 0 && independentlyVerifiedCount < selected.length;
  const confirmationCount = usesProfileConfirmation ? profileConfirmedCount : independentlyVerifiedCount;
  const confirmationLabel = usesProfileConfirmation ? '已确认主页画像' : '已核验账号';
  const confirmationNote = usesProfileConfirmation
    ? `${profileArtifactCount} 份来源快照已保存`
    : outreachSummary.ready ? `${outreachSummary.ready} 份证据锁定草稿可用` : '尚未生成建联草稿';
  const channelMix = activeChannels.map((channel) => {
    const records = channelResultFor(job, channel.id)?.records || 0;
    const allocation = sourceRecords ? Math.round((records / sourceRecords) * 100) : 0;
    return { ...channel, records, allocation };
  });
  const firstAllocation = channelMix[0]?.allocation || 0;
  const donutBackground = channelMix.length === 2 ? `conic-gradient(${channelMix[0].color} 0 ${firstAllocation}%, ${channelMix[1].color} ${firstAllocation}% 100%)` : `conic-gradient(${channelMix[0]?.color || '#d8d5cb'} 0 100%)`;
  const visibleContentSamples = contentSampleCount || selected.reduce((total, item) => total + (item.sampleCount || 0), 0);
  const matrixRows = selected.map((creator) => ({ creator, record: contentAnalysisByTargetId[creator.id] })).filter(({ record }) => Boolean(record?.analysis));
  const matrixRecommendation = matrixRows.map(({ record }) => profileText(record.analysis?.synthesis?.recommendation)).find(Boolean);
  const recommendation = matrixRecommendation || (selected.length ? `优先人工复核 ${selected.slice(0, 3).map((creator) => creator.name).join('、')} 的来源链接与内容样本，再按品牌语气发送首轮建联。` : '先完成真实候选采集与账号核验，再生成可执行的建联队列。');
  return <section className="step-content report-layout">
    <div className="report-hero"><div><p>CAMPAIGN INTELLIGENCE</p><h2>{brief.brand || '未命名'} 建联执行报告</h2><span>候选数据截止 {job?.finishedAt ? new Date(job.finishedAt).toLocaleString('zh-CN') : '尚未完成采集'} · 候选任务 {job?.id || '未创建'} · 核验任务 {verificationJob?.id || '未创建'} · 画像任务 {enrichmentJob?.id || '未创建'}{enrichmentRunCount > 1 ? ` · 合并 ${enrichmentRunCount} 批` : ''} · 内容任务 {contentJob?.id || '未创建'}{contentRunCount > 1 ? ` · 合并 ${contentRunCount} 批` : ''} · 内容快照 {contentArtifactCount || 0} 份 · 理解任务 {contentAnalysisJob?.id || '未创建'}{contentAnalysisRunCount > 1 ? ` · 合并 ${contentAnalysisRunCount} 批` : ''}</span></div><div className="report-score"><span>真实候选源记录</span><strong>{sourceRecords}</strong><small>{statusLabel(job?.status)}</small></div></div>
    <div className="report-kpis"><ReportKpi icon={Users} label="已选 KOL" value={selected.length} note={`${job?.metrics?.creators ?? 0} 位归一化候选`} /><ReportKpi icon={Globe2} label="覆盖渠道" value={activeChannels.length} note={activeChannels.map((channel) => channel.name).join(' · ')} /><ReportKpi icon={Send} label="已标记发送" value={outreachSummary.sent || sent.length} note={`待人工发送 ${Math.max(0, outreachSummary.ready - outreachSummary.sent)}`} /><ReportKpi icon={MessageSquareText} label={confirmationLabel} value={confirmationCount} note={confirmationNote} /></div>
    <div className="report-grid"><div className="report-chart"><div className="panel-heading"><div><small>CREATOR EVIDENCE</small><strong>KOL 内容样本分布</strong></div><span>{visibleContentSamples} 条</span></div><div className="bar-chart">{selected.length ? selected.map((item) => <div key={item.id}><span>{item.name}</span><i><b style={{ width: `${Math.min(100, Math.max(8, (item.sampleCount || 0) * 12))}%` }} /></i><strong>{item.sampleCount || 0} 条</strong></div>) : <div className="report-empty">尚未选择真实候选</div>}</div></div><div className="report-chart"><div className="panel-heading"><div><small>CHANNEL SOURCES</small><strong>实际记录占比</strong></div></div><div className="donut-wrap"><div className="donut" style={{ background: donutBackground }}><span><strong>{sourceRecords}</strong><small>源记录</small></span></div><div className="donut-legend">{channelMix.map((channel) => <div key={channel.id}><i style={{ background: channel.color }} /><span>{channel.name}</span><strong>{channel.records} 条</strong></div>)}</div></div></div></div>
    <section className="report-analysis">
      <div className="report-analysis-head"><div><small>CONTENT INTELLIGENCE / EVIDENCE MATRIX</small><strong>内容理解摘要</strong><span>{contentAnalysisJob ? `${analysisStatusLabel(contentAnalysisJob.status)} · ${contentAnalysisCreatorCount} 位达人 · ${contentAnalysisFindingCount} 条判断` : '尚未运行内容理解任务'}</span></div>{contentAnalysisJob?.id && <a href={contentAnalysisJob.artifactsUrl || `/api/jobs/${contentAnalysisJob.id}/artifacts`} target="_blank" rel="noreferrer"><FileText size={14} />任务产物</a>}</div>
      {matrixRows.length
        ? <div className="report-analysis-list">{matrixRows.map(({ creator, record }) => <ContentAnalysisReportRow key={creator.id} creator={creator} record={record} />)}</div>
        : <div className="report-analysis-empty"><Layers3 size={17} /><span>报告会在内容理解完成后汇总逐人角色结论、可追溯判断和数据覆盖度。</span></div>}
    </section>
    <ReportOutreachQueue selected={selected} drafts={outreachDrafts} />
    <div className="recommendation"><Sparkles size={18} /><div><strong>Agent 建议</strong><p>{recommendation}</p></div><button onClick={onExport}><Download size={15} />导出报告</button></div>
  </section>;
}

function Avatar({ creator }) {
  if (creator.avatar) return <img src={creator.avatar} alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} />;
  return <span className="avatar-placeholder">{(creator.name || '?').slice(0, 1)}</span>;
}
function ConnectorNotice({ connector }) { return <div className="connector-notice"><AlertCircle size={17} /><span><strong>{connector.detail}</strong><small>{connector.action}</small></span></div>; }
function ConnectionBadge({ connector }) { return <span className={`connection-badge inline ${connector?.status || 'checking'}`}><Wifi size={13} />{connector?.status === 'ready' ? '已配置' : connector?.status === 'relay_connected' ? '已附着待验证' : connector?.status === 'auth_required' ? '待登录/附着' : connector?.status === 'unconfigured' ? '待配置' : connector?.status === 'failed' ? '服务不可用' : '检查中'}</span>; }
function CollectionArchive({ entries, loading, onRefresh, onRestoreCampaign, onRestoreCollection, onRestoreEnrichment, onRestoreContent, onRestoreContentAnalysis, onResume }) {
  return <section className="collection-archive">
    <div className="archive-head"><span><History size={16} /><strong>任务档案</strong><small>刷新或本地 API 重启后可恢复候选、来源快照与未完成任务</small></span><button className="icon-btn" onClick={() => void onRefresh()} disabled={loading} aria-label="刷新任务档案" title="刷新任务档案">{loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button></div>
    {entries.length ? <div className="archive-list">{entries.map((entry) => {
      const job = entry.job;
      const campaign = entry.campaign;
      const isVerification = job?.type === 'verify';
      const isEnrichment = ['enrich', 'enrichment', 'profile'].includes(job?.type);
      const isContent = job?.type === 'content';
      const isContentAnalysis = job?.type === 'content_analysis';
      const restoreable = entry.kind === 'campaign' || job?.type === 'discover';
      const resumeable = job && ['interrupted', 'failed', 'waiting_for_connection', 'waiting_for_configuration', 'partial_success'].includes(job.status) && (job.metrics?.pendingWorkItems ?? 1) > 0;
      const title = isVerification
        ? `${campaign?.brief?.brand || job?.query || '未命名项目'} · 账号核验`
        : isEnrichment
          ? `${campaign?.brief?.brand || job?.query || '未命名项目'} · 达人数据采集`
          : isContent
            ? `${campaign?.brief?.brand || job?.query || '未命名项目'} · 公开内容采集`
            : isContentAnalysis
              ? `${campaign?.brief?.brand || job?.query || '未命名项目'} · 内容理解矩阵`
              : campaign?.brief?.brand || job?.query || '未命名项目';
      const jobSummary = isVerification
        ? `${job?.metrics?.verifiedTargets ?? 0} 个已确认账号 · ${job?.metrics?.sourceRecords ?? 0} 条核验记录 · ${statusLabel(job.status)}`
        : isEnrichment
          ? `${job?.metrics?.enrichedTargets ?? job?.metrics?.creators ?? job?.results?.length ?? 0} 份达人画像 · ${job?.metrics?.sourceRecords ?? 0} 条源记录 · ${statusLabel(job.status)}`
          : isContent
            ? `${job?.metrics?.fullCardCoverageCount ?? 0} / ${job?.metrics?.targetCreators ?? job?.selectedCreatorCount ?? 0} 张完整卡 · ${job?.metrics?.visibleContentSamples ?? 0} 条公开样本 · ${statusLabel(job.status)}`
            : isContentAnalysis
              ? `${job?.metrics?.analyzedCreators ?? job?.results?.length ?? 0} 位内容已理解 · ${job?.metrics?.findings ?? 0} 条判断 · ${statusLabel(job.status)}`
              : `${job?.metrics?.creators ?? 0} 位候选 · ${job?.metrics?.sourceRecords ?? 0} 条源记录 · ${statusLabel(job.status)}`;
      const updatedAt = job?.updatedAt || campaign?.updatedAt;
      return <div className="archive-row" key={`${entry.kind}-${entry.id}`}><div className="archive-row-main"><span className={`archive-status ${job?.status || 'draft'}`} /><div><strong>{title}</strong><small>{job ? jobSummary : '项目草稿 · 尚未启动采集'}</small></div></div><time>{updatedAt ? new Date(updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit' }) : '—'}</time><div className="archive-actions">{restoreable && <button onClick={() => entry.kind === 'campaign' ? void onRestoreCampaign(entry.id) : void onRestoreCollection(entry.id)}><History size={14} />恢复</button>}{isEnrichment && <button onClick={() => void onRestoreEnrichment(job.id)}><DatabaseZap size={14} />查看画像</button>}{isContent && <button onClick={() => void onRestoreContent(job.id)}><Layers3 size={14} />查看内容</button>}{isContentAnalysis && <button onClick={() => void onRestoreContentAnalysis(job.id)}><Sparkles size={14} />查看理解</button>}{job && <a href={job.artifactsUrl || `/api/jobs/${job.id}/artifacts`} target="_blank" rel="noreferrer"><FileText size={14} />来源快照</a>}{resumeable && <button className="resume-job" onClick={async () => { if (entry.kind === 'campaign') await onRestoreCampaign(entry.id); else if (job.type === 'discover') await onRestoreCollection(entry.id); else if (isEnrichment) await onRestoreEnrichment(job.id); else if (isContent) await onRestoreContent(job.id); else if (isContentAnalysis) await onRestoreContentAnalysis(job.id); await onResume(job); }}><Play size={13} />续跑</button>}</div></div>;
    })}</div> : <div className="archive-empty"><DatabaseZap size={16} /><span>尚无已保存的采集档案；首次真实采集后会自动出现在这里。</span></div>}
  </section>;
}
function CollectionFeedback({ job }) { const errors = Object.values(job.channelResults || {}).filter((result) => result.error); return <div className={`collection-feedback ${job.status}`}><div><Activity size={16} /><span><strong>{statusLabel(job.status)}</strong><small>任务 {job.id.slice(0, 8)} · {job.metrics?.sourceRecords ?? 0} 条源记录 · {job.metrics?.creators ?? 0} 位候选</small></span></div>{errors.map((result, index) => <p key={`${result.platform}-${result.route?.index ?? result.targetId ?? index}`}><AlertCircle size={14} />{result.label}：{result.error.message}{result.error.action ? ` ${result.error.action}` : ''}</p>)}</div>; }

function discoveryRouteStopLabel(reason) {
  const labels = {
    requested_limit_reached: '达到路线目标',
    page_exhausted: '页面已确认耗尽',
    public_results_settled_retryable: '页面暂时无新增，可续跑',
    scroll_control_failed_retryable: '滚动控制中断，可续跑',
    scroll_budget_exhausted: '滚动预算到达，可续跑',
    collection_deadline_reached: '路线时限到达，可续跑',
    time_budget_exhausted: '时间预算到达，可续跑',
    navigation_timeout: '页面导航超时，可续跑',
    no_new_unique: '暂未获得新账号，可续跑',
    no_new_results: '暂未获得新结果，可续跑',
  };
  const key = String(reason || '').trim().toLowerCase();
  return labels[key] || (key ? key.replace(/_/g, ' ') : '未提供停止原因');
}

function DiscoveryRouteCoverage({ job }) {
  const routes = Object.values(job?.channelResults || {})
    .filter((result) => result?.route)
    .sort((left, right) => String(left.platform || '').localeCompare(String(right.platform || ''))
      || Number(left.route?.index || 0) - Number(right.route?.index || 0));
  if (!routes.length) return null;
  return <section className="discovery-route-coverage" aria-label="公开检索路线覆盖情况">
    <div className="discovery-route-heading"><span>路线覆盖</span><small>每条路线都保留独立停止原因与去重结果</small></div>
    <div className="discovery-route-list">{routes.map((route, index) => <div className="discovery-route-row" key={`${route.platform}-${route.route?.index ?? index}`}>
      <div className="discovery-route-query"><strong>{route.label || `${route.platform} 路线 ${Number(route.route?.index || index) + 1}`}</strong><small>{route.route?.query || '未提供检索词'}</small></div>
      <div className="discovery-route-count"><span>{Number(route.newUniqueCreators || 0)} 新增</span><small>{Number(route.duplicateFromPreviousRoutes || 0)} 跨路线重复</small></div>
      <span className={`discovery-route-status ${route.status || 'queued'}`}>{statusLabel(route.status)}</span>
      <small className="discovery-route-stop">{discoveryRouteStopLabel(route.completionReason)} · 第 {Number(route.attempt || 1)} 次</small>
    </div>)}</div>
  </section>;
}

function SectionTitle({ number, title, caption }) { return <div className="section-title"><span>{number}</span><div><small>{caption}</small><strong>{title}</strong></div></div>; }
function Field({ label, children }) { return <label className="field"><span>{label}</span>{children}</label>; }
function ChannelTag({ platform }) { return <span className={`channel-tag tag-${platform}`}>{platform}</span>; }
function ReportKpi({ icon: Icon, label, value, note }) { return <div className="report-kpi"><span><Icon size={16} />{label}</span><strong>{value}</strong><small>{note}</small></div>; }

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Application root is missing.');

// Vite can re-evaluate this entry during a local hot update. Reusing the root
// keeps the live workspace mounted and avoids a duplicate-root console error.
const applicationRoot = globalThis.__kolforgeApplicationRoot || createRoot(rootElement);
globalThis.__kolforgeApplicationRoot = applicationRoot;
applicationRoot.render(<App />);
