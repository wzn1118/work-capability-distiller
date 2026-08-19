import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowLeft, CheckCircle2, Clock3, Database, Download,
  ChevronDown, ChevronLeft, ChevronRight, ListChecks, LoaderCircle, MessageSquareText, Pause, Play,
  RefreshCw, ShieldCheck, Square, Users, Zap,
} from 'lucide-react';
import { apiPath, artifactHref, requestJson } from './api.js';

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
}

function statusLabel(status) {
  const labels = {
    queued: '等待执行', cataloging: '目录采集', collecting: '采集中', exporting: '生成归档',
    complete: '已完成', public_api_complete_with_gap: '公开接口计数差额',
    waiting_for_connection: '等待浏览器连接', paused: '已暂停', cancelled: '已取消', export_failed: '导出待处理',
  };
  return labels[status] || status || '等待执行';
}

function statusTone(status) {
  if (['complete'].includes(status)) return 'success';
  if (['public_api_complete_with_gap', 'waiting_for_connection', 'export_failed'].includes(status)) return 'warning';
  if (['cancelled'].includes(status)) return 'muted';
  return 'live';
}

function progressPercent(completed, total, done = false) {
  const safeTotal = Number(total || 0);
  if (done && safeTotal === 0) return 100;
  if (!safeTotal) return 0;
  return Math.min(100, Math.round((Number(completed || 0) / safeTotal) * 100));
}

function eventMessage(event) {
  const labels = {
    job_created: '任务已创建', profile_resolving: '正在按名称搜索账号主页',
    browser_starting: '正在检查并启动抖音专用浏览器', browser_ready: '抖音专用浏览器已连接',
    profile_resolved: '账号主页已匹配', catalog_started: '正在枚举主页作品',
    catalog_complete: '主页作品目录已完成', catalog_imported: '公开主页目录已接入', collector_started: '评论采集器已启动',
    collector_waiting: '正在等待可执行的评论分页', page_committed: '评论分页已写入 checkpoint',
    task_retry: '当前分页将自动重试', task_retry_exhausted: '当前分页重试次数已耗尽',
    connection_required: '等待抖音浏览器会话连接', connection_recovering: '连接异常，系统将自动续跑',
    connection_recovered: '连接已恢复，评论采集继续', endpoint_session_reused: '已从现有标签页恢复评论接口',
    endpoint_seed_rotated: '当前作品未触发评论接口，正在自动换一条作品',
    adaptive_lanes: '并发通道已自动调整',
    concurrency_updated: '并发设置已更新', paused: '任务已暂停', resumed: '任务已续跑',
    video_materialized: '该视频评论已可实时查看', video_materialization_failed: '评论已采集，展示文件稍后自动重试',
    cancelled: '任务已取消', export_started: '正在生成 Excel 归档',
    export_failed: 'Excel 归档生成失败', job_complete: '任务已完成',
    job_failed: '任务执行失败', policy_failed: '无媒体下载审计未通过',
  };
  return labels[event?.type] || event?.message || event?.type || '任务状态已更新';
}

function StatusPill({ status }) {
  return <span className={`douyin-status ${statusTone(status)}`}><i />{statusLabel(status)}</span>;
}

function Metric({ label, value, detail, icon: Icon }) {
  return <div className="douyin-metric">
    <div><span>{label}</span><strong>{value}</strong></div>
    {Icon ? <Icon size={17} aria-hidden="true" /> : null}
    {detail ? <small>{detail}</small> : null}
  </div>;
}

function ActionButton({ children, icon: Icon, title, className = '', ...props }) {
  return <button type="button" className={`douyin-action ${className}`} title={title || (typeof children === 'string' ? children : '')} {...props}>
    {Icon ? <Icon size={15} aria-hidden="true" /> : null}{children}
  </button>;
}

export function DouyinCommentWorkspace({ onBack }) {
  const [jobs, setJobs] = useState([]);
  const [activeJobId, setActiveJobId] = useState('');
  const [activeJob, setActiveJob] = useState(null);
  const [videos, setVideos] = useState([]);
  const [videoPage, setVideoPage] = useState({ offset: 0, limit: 250, total: 0 });
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [comments, setComments] = useState([]);
  const [commentsTotal, setCommentsTotal] = useState(0);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [artifacts, setArtifacts] = useState([]);
  const [events, setEvents] = useState([]);
  const [browserHealth, setBrowserHealth] = useState({ status: 'checking' });
  const [profileInput, setProfileInput] = useState('');
  const [draftMaxLanes, setDraftMaxLanes] = useState(8);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [streamState, setStreamState] = useState('idle');
  const [lastEventAt, setLastEventAt] = useState('');
  const eventSequence = useRef(0);
  const refreshTimer = useRef(null);
  const videoOffsetRef = useRef(0);

  const loadJobs = useCallback(async () => {
    const payload = await requestJson('/api/douyin-comment-jobs');
    const nextJobs = payload.jobs || [];
    setJobs(nextJobs);
    setActiveJobId((current) => current || nextJobs[0]?.id || '');
    return nextJobs;
  }, []);

  const loadBrowserHealth = useCallback(async () => {
    const payload = await requestJson('/api/douyin-comment-jobs/health').catch(() => ({ status: 'offline' }));
    setBrowserHealth(payload);
    return payload;
  }, []);

  const loadActiveJob = useCallback(async (jobId = activeJobId) => {
    if (!jobId) return;
    const videoOffset = videoOffsetRef.current;
    const [detail, videoPayload, artifactPayload] = await Promise.all([
      requestJson(`/api/douyin-comment-jobs/${encodeURIComponent(jobId)}`),
      requestJson(`/api/douyin-comment-jobs/${encodeURIComponent(jobId)}/videos?offset=${videoOffset}&limit=250`).catch(() => ({ rows: [], total: 0, offset: videoOffset, limit: 250 })),
      requestJson(`/api/douyin-comment-jobs/${encodeURIComponent(jobId)}/artifacts`).catch(() => ({ artifacts: [] })),
    ]);
    setActiveJob(detail.job);
    setVideos(videoPayload.rows || []);
    setVideoPage({
      offset: Number(videoPayload.offset || 0),
      limit: Number(videoPayload.limit || 250),
      total: Number(videoPayload.total || 0),
    });
    setArtifacts(artifactPayload.artifacts || detail.job?.artifacts || []);
  }, [activeJobId]);

  useEffect(() => {
    void Promise.all([loadJobs(), loadBrowserHealth()]).catch((error) => setNotice({ tone: 'warning', text: error.message }));
  }, [loadBrowserHealth, loadJobs]);

  useEffect(() => {
    const timer = window.setInterval(() => { void loadBrowserHealth(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [loadBrowserHealth]);

  useEffect(() => {
    if (!activeJobId) {
      setActiveJob(null);
      setVideos([]);
      setArtifacts([]);
      setStreamState('idle');
      setLastEventAt('');
      return undefined;
    }
    eventSequence.current = 0;
    videoOffsetRef.current = 0;
    setEvents([]);
    setSelectedVideo(null);
    setComments([]);
    setCommentsTotal(0);
    setStreamState('connecting');
    setLastEventAt('');
    void loadActiveJob(activeJobId).catch((error) => setNotice({ tone: 'warning', text: error.message }));
    const source = new EventSource(apiPath(`/api/douyin-comment-jobs/${encodeURIComponent(activeJobId)}/events?after=0`));
    const scheduleRefresh = () => {
      if (refreshTimer.current) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        void Promise.all([loadJobs(), loadActiveJob(activeJobId)]).catch(() => {});
      }, 400);
    };
    const handleEvent = (message) => {
      try {
        const record = JSON.parse(message.data);
        eventSequence.current = Math.max(eventSequence.current, Number(record.sequence || 0));
        setEvents((current) => [record, ...current].slice(0, 36));
        setLastEventAt(record.at || new Date().toISOString());
        if (record.progress) {
          setActiveJob((current) => current ? { ...current, progress: { ...current.progress, ...record.progress } } : current);
        }
        scheduleRefresh();
      } catch {
        // A malformed progress record should not stop the durable task refresh.
      }
    };
    source.onmessage = handleEvent;
    source.onopen = () => setStreamState('live');
    [
      'job_created', 'browser_starting', 'browser_ready', 'profile_resolving', 'profile_resolved', 'catalog_started',
      'catalog_complete', 'catalog_imported', 'collector_started', 'collector_waiting', 'page_committed',
      'task_retry', 'task_retry_exhausted', 'connection_required', 'connection_recovering',
      'connection_recovered', 'endpoint_seed_rotated', 'endpoint_session_reused',
      'adaptive_lanes', 'concurrency_updated', 'video_materialized', 'video_materialization_failed', 'paused', 'resumed', 'cancelled',
      'export_started', 'export_failed', 'job_complete', 'job_failed', 'policy_failed',
    ].forEach((type) => source.addEventListener(type, handleEvent));
    const poll = window.setInterval(() => {
      void Promise.all([loadJobs(), loadActiveJob(activeJobId)]).catch(() => {});
    }, 3_000);
    source.onerror = () => setStreamState('reconnecting');
    return () => {
      source.close();
      window.clearInterval(poll);
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [activeJobId, loadActiveJob, loadJobs]);

  const loadVideoComments = useCallback(async (video, { offset = 0, append = false } = {}) => {
    if (!video || !activeJobId) return;
    setCommentsLoading(true);
    if (!append) setSelectedVideo(video);
    try {
      const payload = await requestJson(`/api/douyin-comment-jobs/${encodeURIComponent(activeJobId)}/comments?videoId=${encodeURIComponent(video.videoId)}&offset=${offset}&limit=250`);
      setCommentsTotal(Number(payload.total || 0));
      setComments((current) => {
        if (!append) return payload.rows || [];
        const byId = new Map(current.map((comment) => [comment.comment_id, comment]));
        for (const comment of payload.rows || []) byId.set(comment.comment_id, comment);
        return [...byId.values()];
      });
    } finally {
      setCommentsLoading(false);
    }
  }, [activeJobId]);

  const changeVideoPage = useCallback(async (direction) => {
    const nextOffset = Math.max(0, Math.min(
      Math.max(0, videoPage.total - 1),
      videoPage.offset + (direction * videoPage.limit),
    ));
    videoOffsetRef.current = nextOffset;
    setSelectedVideo(null);
    setComments([]);
    setCommentsTotal(0);
    await loadActiveJob(activeJobId);
  }, [activeJobId, loadActiveJob, videoPage]);

  const startCollection = async (event) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const payload = await requestJson('/api/douyin-comment-jobs', {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          profileInput,
          concurrency: { mode: 'adaptive', maxLanes: draftMaxLanes },
          autoResume: true,
          downloadMedia: false,
        }),
      });
      setActiveJobId(payload.job.id);
      await loadJobs();
      setNotice({ tone: 'success', text: payload.reused ? '已打开已有任务。' : '采集任务已创建。' });
    } catch (error) {
      setNotice({ tone: 'warning', text: [error.message, error.action].filter(Boolean).join(' ') });
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action, body) => {
    if (!activeJobId) return;
    setBusy(true);
    setNotice(null);
    try {
      const payload = await requestJson(`/api/douyin-comment-jobs/${encodeURIComponent(activeJobId)}/${action}`, {
        method: 'POST', body: body ? JSON.stringify(body) : undefined,
      });
      if (payload.job) setActiveJob(payload.job);
      await Promise.all([loadJobs(), loadActiveJob(activeJobId)]);
      setNotice({ tone: 'success', text: action === 'export' ? '归档已重新生成。' : '任务设置已更新。' });
    } catch (error) {
      setNotice({ tone: 'warning', text: [error.message, error.action].filter(Boolean).join(' ') });
    } finally {
      setBusy(false);
    }
  };

  const activeProgress = activeJob?.progress || {};
  const laneValue = activeJob?.runtime?.effectiveLanes || activeJob?.effectiveLanes || 0;
  const selectedVideoTitle = selectedVideo?.videoTitle || selectedVideo?.videoId || '';
  const isActive = ['queued', 'cataloging', 'collecting', 'exporting'].includes(activeJob?.status);
  const canResume = ['paused', 'waiting_for_connection', 'export_failed'].includes(activeJob?.status);
  const xlsx = artifacts.find((name) => name.endsWith('.xlsx'));
  const browserSessionStatus = browserHealth.status === 'online'
    ? (activeJob?.status === 'waiting_for_connection' ? 'CHECK' : 'ONLINE')
    : browserHealth.status === 'checking' ? 'CHECK' : 'OFFLINE';
  const browserSessionDetail = browserHealth.status === 'online'
    ? 'CDP 18801 · 连接可用'
    : browserHealth.status === 'checking' ? '正在检测 CDP 18801'
      : 'CDP 18801 · 未连接';
  const nextAutoResumeText = activeJob?.nextAutoResumeAt
    ? new Date(activeJob.nextAutoResumeAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '';
  const checkpointRestoring = Boolean(activeJob?.runtime?.checkpointRestoring || activeJob?.taskSummary?.restoring);
  const coverage = useMemo(() => {
    const rendered = Number(activeJob?.catalog?.publicRenderedTotal || activeProgress.videosTotal || 0);
    const declared = Number(activeJob?.catalog?.declaredTotal || rendered);
    return declared ? `${formatNumber(rendered)} / ${formatNumber(declared)}` : '0 / 0';
  }, [activeJob?.catalog, activeProgress.videosTotal]);
  const progressStages = useMemo(() => {
    const catalogDone = String(activeJob?.catalog?.status || activeProgress.catalogStatus || '').startsWith('complete');
    const catalogGap = Number(activeJob?.catalog?.declaredGap || 0);
    const rootsComplete = Number(activeProgress.rootTasksComplete || 0);
    const rootsTotal = Number(activeProgress.rootTasksTotal || activeProgress.videosTotal || 0);
    const repliesComplete = Number(activeProgress.replyTasksComplete || 0);
    const repliesTotal = Number(activeProgress.replyTasksTotal || 0);
    const exported = ['complete', 'public_api_complete_with_gap'].includes(activeJob?.status) && Boolean(xlsx);
    return [
      { label: '账号主页', detail: activeJob?.profileName || activeJob?.expectedCreatorName || '等待输入', value: activeJob?.profileUrl ? 100 : 0 },
      { label: '作品目录', detail: catalogDone ? `${formatNumber(activeProgress.videosTotal)} 个公开条目${catalogGap ? ` · 声明缺口 ${formatNumber(catalogGap)}` : ''}` : '正在枚举公开作品', value: catalogDone ? 100 : 0 },
      { label: '根评论', detail: `${formatNumber(rootsComplete)} / ${formatNumber(rootsTotal)}`, value: progressPercent(rootsComplete, rootsTotal) },
      { label: '回复线程', detail: `${formatNumber(repliesComplete)} / ${formatNumber(repliesTotal)}`, value: progressPercent(repliesComplete, repliesTotal, catalogDone && repliesTotal === 0) },
      { label: 'Excel 归档', detail: exported ? '可下载' : activeJob?.status === 'exporting' ? '生成中' : '等待评论完成', value: exported ? 100 : activeJob?.status === 'exporting' ? 50 : 0 },
    ];
  }, [activeJob, activeProgress, xlsx]);

  return <div className="douyin-comments-app">
    <aside className="douyin-side">
      <div className="douyin-brand"><span>M</span><div><strong>MKT 大师</strong><small>COMMENT OPERATIONS</small></div></div>
      <nav aria-label="采集模块">
        <button type="button" onClick={onBack}><ArrowLeft size={16} />KOL 工作流</button>
        <button type="button" className="active"><MessageSquareText size={16} />抖音主页评论</button>
      </nav>
      <section className="douyin-side-status">
        <span><Activity size={14} />浏览器会话</span>
        <strong>{browserSessionStatus}</strong>
        <small>{browserSessionDetail}</small>
      </section>
      <section className="douyin-job-list" aria-label="采集任务">
        <div className="douyin-section-head"><span>任务记录</span><button type="button" title="刷新任务" onClick={() => void loadJobs()}><RefreshCw size={14} /></button></div>
        <div className="douyin-job-scroll">
          {jobs.length ? jobs.map((job) => <button key={job.id} type="button" onClick={() => setActiveJobId(job.id)} className={job.id === activeJobId ? 'selected' : ''}>
            <span>{job.label || job.expectedCreatorName || job.profileName || '抖音评论任务'}</span><small>{statusLabel(job.status)}</small>
          </button>) : <p>暂无任务</p>}
        </div>
      </section>
    </aside>

    <main className="douyin-main">
      <header className="douyin-topbar">
        <div><small>DOUYIN PROFILE / COMMENTS</small><h1>主页评论采集</h1></div>
        <div className="douyin-top-actions">
          {activeJob ? <StatusPill status={activeJob.status} /> : null}
          <ActionButton icon={RefreshCw} title="刷新任务与浏览器连接状态" onClick={() => void Promise.all([loadJobs(), loadActiveJob(), loadBrowserHealth()])} disabled={busy}>刷新</ActionButton>
          {xlsx && activeJobId ? <a className="douyin-download" href={artifactHref(activeJobId, xlsx)}><Download size={15} />Excel</a> : null}
        </div>
      </header>

      <div className="douyin-content">
        <section className="douyin-launch-band" aria-labelledby="douyin-launch-title">
          <div className="douyin-band-heading"><div><small>新建采集</small><h2 id="douyin-launch-title">抖音创作者主页</h2></div><span><ShieldCheck size={15} />不下载视频或图片媒体</span></div>
          <form className="douyin-launch-form douyin-launch-simple" onSubmit={startCollection}>
            <label className="douyin-field"><span>主页名称或链接</span><input required value={profileInput} onChange={(event) => setProfileInput(event.target.value)} placeholder="账号名称 或 https://www.douyin.com/user/..." /></label>
            <fieldset className="douyin-lanes"><legend>并发</legend><div>{[4, 8, 10].map((lanes) => <button type="button" key={lanes} className={draftMaxLanes === lanes ? 'selected' : ''} title={`${lanes} 个自适应采集标签页`} onClick={() => setDraftMaxLanes(lanes)}>{lanes}</button>)}</div></fieldset>
            <ActionButton type="submit" icon={busy ? LoaderCircle : Play} className="primary" disabled={busy}>{busy ? '处理中' : '一键采集全部评论'}</ActionButton>
          </form>
        </section>

        {notice ? <div className={`douyin-notice ${notice.tone}`}><span>{notice.text}</span><button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">×</button></div> : null}

        <section className="douyin-live-progress" aria-label="实时采集进度">
          <div className="douyin-live-head">
            <div><span className={`douyin-live-dot ${streamState}`} />实时进度</div>
            <small>{streamState === 'live' ? '事件流已连接' : streamState === 'reconnecting' ? '事件流重连中，轮询仍在运行' : streamState === 'connecting' ? '正在连接事件流' : '选择或创建任务后开始'}{lastEventAt ? ` · 更新 ${new Date(lastEventAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}</small>
          </div>
          <div className="douyin-stage-grid">
            {progressStages.map((stage) => <div className="douyin-stage" key={stage.label}>
              <div><span>{stage.label}</span><strong>{stage.value}%</strong></div>
              <div className="douyin-stage-track"><i style={{ width: `${stage.value}%` }} /></div>
              <small title={stage.detail}>{stage.detail}</small>
            </div>)}
          </div>
        </section>

        <section className="douyin-metrics-band" aria-label="采集指标">
          <Metric label="作品目录" value={coverage} detail="已枚举 / 主页条目" icon={ListChecks} />
          <Metric label="已写评论" value={formatNumber(activeProgress.commentsCaptured)} detail="根评论与回复" icon={MessageSquareText} />
          <Metric label="回复线程" value={`${formatNumber(activeProgress.replyTasksComplete)} / ${formatNumber(activeProgress.replyTasksTotal)}`} detail="已穷尽 / 已发现" icon={Users} />
          <Metric label="有效并发" value={laneValue || '-'} detail={activeJob?.concurrency?.mode === 'fixed' ? '固定标签页' : '自适应标签页'} icon={Zap} />
          <Metric label="续跑状态" value={checkpointRestoring ? 'RESTORE' : activeJob?.autoResume ? 'ON' : 'OFF'} detail={checkpointRestoring ? '后台恢复断点索引，进度仍可查看' : nextAutoResumeText ? `下次重试 ${nextAutoResumeText}` : '异常与进程重启后自动恢复'} icon={Clock3} />
        </section>

        {activeJob ? <section className="douyin-control-band" aria-label="当前任务操作">
          <div><div className="douyin-section-head"><span>当前任务</span><small>{activeJob.label || activeJob.expectedCreatorName || activeJob.profileName || activeJob.profileUrl}</small></div><div className="douyin-control-copy"><StatusPill status={activeJob.status} />{checkpointRestoring ? <p><Database size={14} />正在后台恢复评论断点索引</p> : activeJob.lastError?.message ? <p><AlertTriangle size={14} />{activeJob.lastError.message}</p> : <p><Database size={14} />页级 checkpoint 已保存在本机任务目录</p>}{activeJob.status === 'waiting_for_connection' && nextAutoResumeText ? <p><Clock3 size={14} />系统将于 {nextAutoResumeText} 自动续跑</p> : null}</div></div>
          <div className="douyin-control-actions">
            <div className="douyin-live-lanes" aria-label="并发上限"><Zap size={14} />{[4, 8, 10].map((lanes) => <button type="button" key={lanes} className={Number(activeJob.concurrency?.maxLanes) === lanes ? 'selected' : ''} title={`切换为 ${lanes} 个自适应采集标签页`} onClick={() => void runAction('concurrency', { mode: 'adaptive', maxLanes: lanes })} disabled={busy}>{lanes}</button>)}</div>
            {isActive ? <ActionButton icon={Pause} onClick={() => void runAction('pause')} disabled={busy}>暂停</ActionButton> : null}
            {canResume ? <ActionButton icon={Play} className="primary" onClick={() => void runAction('resume')} disabled={busy}>续跑</ActionButton> : null}
            <ActionButton icon={Square} className="danger" onClick={() => void runAction('cancel')} disabled={busy || ['complete', 'public_api_complete_with_gap', 'cancelled'].includes(activeJob.status)}>取消</ActionButton>
          </div>
        </section> : null}

        <section className="douyin-table-band" aria-labelledby="douyin-video-table-title">
          <div className="douyin-section-head"><div><span id="douyin-video-table-title">视频与评论归属</span><small>{videos.length ? `${formatNumber(videoPage.offset + 1)}-${formatNumber(videoPage.offset + videos.length)} / ${formatNumber(videoPage.total)}` : '目录完成后显示'}</small></div><div className="douyin-table-pager"><span>点击行查看评论</span><button type="button" aria-label="上一页视频" title="上一页" disabled={videoPage.offset <= 0} onClick={() => void changeVideoPage(-1)}><ChevronLeft size={14} /></button><button type="button" aria-label="下一页视频" title="下一页" disabled={videoPage.offset + videos.length >= videoPage.total} onClick={() => void changeVideoPage(1)}><ChevronRight size={14} /></button></div></div>
          <div className="douyin-table-scroll"><table><thead><tr><th>内容</th><th>状态</th><th>评论</th><th>回复线程</th><th>根页游标</th></tr></thead><tbody>
            {videos.length ? videos.map((video) => <tr key={video.videoId} tabIndex="0" className={selectedVideo?.videoId === video.videoId ? 'selected' : ''} onClick={() => void loadVideoComments(video)} onKeyDown={(event) => { if (event.key === 'Enter') void loadVideoComments(video); }}>
              <td><strong>{video.videoTitle || video.videoId}</strong><a href={video.videoUrl} target="_blank" rel="noreferrer">{video.videoId}</a></td><td><StatusPill status={video.status} /></td><td>{formatNumber(video.commentsCaptured)}{video.declaredComments ? <small> / {formatNumber(video.declaredComments)}</small> : null}</td><td>{video.replyThreadsComplete} / {video.replyThreadsTotal}</td><td>{formatNumber(video.rootCursor)}</td>
            </tr>) : <tr><td colSpan="5" className="douyin-empty">尚未写入目录数据</td></tr>}
          </tbody></table></div>
        </section>

        <section className="douyin-detail-grid">
          <section className="douyin-comments-band" aria-labelledby="douyin-comments-title">
            <div className="douyin-section-head"><div><span id="douyin-comments-title">评论关系</span><small>{selectedVideoTitle || '选择一个视频'}</small></div><span>{selectedVideo ? `${formatNumber(comments.length)} / ${formatNumber(commentsTotal)}` : ''}</span></div>
            <div className="douyin-comments-scroll">{comments.length ? comments.map((comment) => <article key={comment.comment_id}>
              <div>{comment.comment_user_url ? <a className="douyin-comment-user" href={comment.comment_user_url} target="_blank" rel="noreferrer">{comment.comment_user || '匿名用户'}</a> : <strong>{comment.comment_user || '匿名用户'}</strong>}<small>{comment.comment_time || ''}{comment.comment_location ? ` · ${comment.comment_location}` : ''}</small></div><p>{comment.comment_content || '(空内容)'}</p><footer><span>{comment.relation_type === 'reply_to_reply' ? '回复评论' : comment.is_reply ? '回复根评论' : '根评论'}</span><span>赞 {formatNumber(comment.comment_likes)}</span>{comment.parent_comment_id ? <span>父评论 {comment.parent_comment_id}</span> : null}</footer>
            </article>) : <p className="douyin-empty">{commentsLoading ? '正在读取评论' : '选择已完成的视频查看评论、用户、点赞、时间与父子关系。'}</p>}{selectedVideo && comments.length < commentsTotal ? <div className="douyin-comments-more"><ActionButton icon={commentsLoading ? LoaderCircle : ChevronDown} onClick={() => void loadVideoComments(selectedVideo, { offset: comments.length, append: true })} disabled={commentsLoading}>{commentsLoading ? '读取中' : '加载更多'}</ActionButton></div> : null}</div>
          </section>
          <section className="douyin-events-band" aria-labelledby="douyin-events-title">
            <div className="douyin-section-head"><div><span id="douyin-events-title">采集事件</span><small>断点与异常记录</small></div></div>
            <div className="douyin-events-scroll">{events.length ? events.map((event) => <div key={event.sequence}><time>{event.at ? new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</time><span className={event.severity || 'info'}>{eventMessage(event)}</span></div>) : <p className="douyin-empty">任务事件会在这里出现。</p>}</div>
          </section>
        </section>
      </div>
    </main>
  </div>;
}
