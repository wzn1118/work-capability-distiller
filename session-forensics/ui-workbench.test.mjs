import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('主页明确显示会话范围并区分是否已确认项目上下文', () => {
  const html = read('ui/index.html');
  const app = read('ui/app.js');
  const packager = read('lib/root-capability-packager.mjs');
  const evidence = read('lib/project-evidence.mjs');
  assert.match(html, /id="scope-summary"/);
  assert.match(html, /id="scope-summary-title"/);
  assert.match(app, /contextMode/);
  assert.match(app, /projectConfirmed/);
  assert.match(app, /renderScopeSummary/);
  assert.match(packager, /contextMode: analysis\.scopePolicy/);
  assert.match(packager, /relevanceOnly: true/);
  assert.match(evidence, /relevantFilesSelected/);
  assert.match(evidence, /relevantFilesExcluded/);
});

test('项目上下文必须由用户在主页面明确选择，单会话结果不展示项目背景', () => {
  const html = read('ui/index.html');
  const app = read('ui/app.js');
  const styles = read('ui/styles.css');
  assert.match(html, /id="enable-project-context"/);
  assert.match(html, /id="disable-project-context"/);
  assert.match(app, /chooseProjectPath/);
  assert.match(app, /clearProjectContext/);
  assert.match(app, /packageUsesProjectContext/);
  assert.match(app, /project-scope-empty/);
  assert.match(app, /仅已选会话（未读取项目文件、Git 或项目知识）/);
  assert.match(styles, /\.project-context-control/);
  assert.match(styles, /\.project-scope-empty/);
});

test('项目模式会在开始蒸馏前展示本次纳入和排除的文件清单', () => {
  const html = read('ui/index.html');
  const app = read('ui/app.js');
  const server = read('ui-server.mjs');
  const styles = read('ui/styles.css');
  assert.match(html, /id="project-context-preview"/);
  assert.match(html, /id="project-context-preview-selected"/);
  assert.match(html, /id="project-context-preview-excluded"/);
  assert.match(app, /function renderProjectContextPreview\(/);
  assert.match(app, /function previewProjectContext\(/);
  assert.match(app, /contextPreviewKey/);
  assert.match(app, /\/api\/v2\/project-context\/preview/);
  assert.match(app, /await previewProjectContext\(readySelection\)/);
  assert.match(server, /\/api\/v2\/project-context\/preview/);
  assert.match(server, /relevantFilesSelected/);
  assert.match(server, /relevantFilesExcluded/);
  assert.match(styles, /\.project-context-preview/);
  assert.match(styles, /\.project-context-preview-columns/);
});

test('能力包结果页提供单页工作区和可读面板', () => {
  const html = read('ui/index.html');
  for (const marker of [
    'package-workbench',
    'package-navigation',
    'data-package-view="overview"',
    'data-package-view="capability"',
    'data-package-view="priorities"',
    'data-package-view="project"',
    'data-package-view="evidence"',
    'data-package-view="agent"',
    'package-document-reader',
    'package-agent-stage',
    'package-glance',
    'package-state',
    'package-capability-expertise',
    'child-page-bar',
    'child-page-primary',
    'primary-action-hint',
    'standalone-reader',
  ]) assert.match(html, new RegExp(marker.replace(/["']/g, '\\$&')));
  assert.match(html, /id="analyze" class="primary" disabled/);
  assert.match(html, /id="package" class="secondary package-action" disabled/);
  assert.match(html, /id="web-chat-setup-panel"[^>]*hidden/);
});

test('主页提供按工作区全选、会话例外调整和完整范围提示', () => {
  const html = read('ui/index.html');
  const app = read('ui/app.js');
  const server = read('ui-server.mjs');
  for (const marker of [
    'workspace-picker',
    'workspace-catalog',
    'select-visible-workspaces',
    'session-detail-picker',
    'select-all-sessions',
    'session-selection-mode',
  ]) assert.match(html, new RegExp(marker));
  assert.match(app, /selectedWorkspaceIds/);
  assert.match(app, /excludedWorkspaceSourceKeys/);
  assert.match(app, /selectionMode/);
  assert.match(app, /projectScope/);
  assert.match(app, /setSelectionMode\('sessions'\)/);
  assert.match(app, /setSelectionMode\('workspace'\)/);
  assert.match(app, /\#select-all-sessions/);
  assert.match(app, /仅处理所选会话/);
  assert.match(app, /selectionMode === 'workspace'/);
  assert.match(app, /\/api\/v2\/workspaces/);
  assert.match(app, /\/api\/v2\/workspace-selection\/preview/);
  assert.match(server, /createWorkspaceSelection/);
  assert.match(server, /workspace-all-with-exceptions|workspaceSelection/);
  assert.match(server, /projectScope/);
  assert.match(server, /projectDiscovery\?\.mode === 'sessions-only'/);
  assert.match(server, /workspaceSelectionMode === 'workspace'/);
});

test('主工作台提供一次点击的浏览器伴侣准备流程', () => {
  const html = read('ui/index.html');
  const app = read('ui/app.js');
  const server = read('ui-server.mjs');
  const bridge = read('templates/root-capability/agent/runtime/chatgpt-web-link.mjs');
  const companion = read('templates/root-capability/agent/chatgpt-companion/background.js');
  assert.match(html, /id="web-chat-setup-start"/);
  assert.match(html, /自动准备浏览器伴侣/);
  assert.match(html, /加载已解压的扩展程序/);
  assert.match(app, /\/api\/web-chat\/companion\/setup/);
  assert.match(app, /startWebChatSetupPolling/);
  assert.match(server, /\/companion\/open-extensions/);
  assert.match(server, /\/companion\/setup/);
  assert.match(bridge, /openBrowserExtensions/);
  assert.match(bridge, /setupCompanion/);
  assert.match(companion, /discoverLocalWorkbench/);
  assert.match(companion, /BRIDGE_PATHS/);
});

test('网页端会话与本机 Codex 会话使用独立列表和独立接口字段', () => {
  const html = read('ui/index.html');
  const app = read('ui/app.js');
  const server = read('ui-server.mjs');
  assert.match(html, /id="session-catalog"/);
  assert.match(html, /id="web-chat-imported-list"/);
  assert.match(html, /网页端会话列表/);
  assert.match(html, /与本机 Codex 分开/);
  assert.match(app, /importedSources:\s*\[\]/);
  assert.match(app, /function renderWebChatImportedSources\(\)/);
  assert.match(app, /data-web-source-key/);
  assert.match(app, /select-visible-web-sessions/);
  assert.match(app, /clear-web-session-selection/);
  assert.match(app, /本机 Codex 会话/);
  assert.match(server, /codexSources/);
  assert.match(server, /webChatSources/);
});

test('会话搜索覆盖本机和网页端完整内容并展示命中上下文', () => {
  const html = read('ui/index.html');
  const app = read('ui/app.js');
  const server = read('ui-server.mjs');
  const styles = read('ui/styles.css');
  assert.match(html, /id="session-search-status"/);
  assert.match(html, /id="session-search-results"/);
  assert.match(html, /id="session-search-kind"/);
  assert.match(html, /id="session-search-hit-list"/);
  assert.match(html, /id="clear-session-search"/);
  assert.match(app, /\/api\/v2\/session-search/);
  assert.match(app, /application\/json/);
  assert.match(app, /getReader\(\)/);
  assert.match(app, /function runSessionContentSearch\(/);
  assert.match(app, /function renderSessionSearchPanel\(/);
  assert.match(app, /data-session-search-source/);
  assert.match(app, /命中.*会话内容/);
  assert.match(app, /ChatGPT 用户消息、助手回复、工具调用和图片附件/);
  assert.match(server, /searchSessionSourcesContent/);
  assert.match(server, /scope === 'local'/);
  assert.match(server, /scope === 'web'/);
  assert.match(server, /application\/x-ndjson/);
  assert.match(server, /type: 'progress'/);
  assert.match(server, /SESSION_SEARCH_DISK_CACHE_TTL_MS/);
  assert.match(server, /persistentCache/);
  assert.match(server, /shouldStop: \(\) => clientGone \|\| response\.destroyed/);
  assert.match(styles, /\.session-search-hit/);
  assert.match(styles, /\.session-search-result-row/);
  assert.match(styles, /\.session-search-status\[data-state="loading"\]/);
});

test('网页端全量任务在服务重启后可以从持久化目录恢复', () => {
  const app = read('ui/app.js');
  const server = read('ui-server.mjs');
  assert.match(server, /\/api\/v2\/chatgpt\/edge\/resume/);
  assert.match(server, /持久化目录，没有需要继续读取/);
  assert.match(server, /reconciliation\.records/);
  assert.match(app, /\/api\/v2\/chatgpt\/edge\/resume/);
  assert.match(app, /持久化目录恢复读取任务/);
  assert.match(app, /let jobId = window\.localStorage\.getItem\(CHATGPT_BATCH_JOB_STORAGE_KEY\)/);
});

test('前端说明入口不再依赖跳转到原始 Markdown，并支持精确能力包启动', () => {
  const app = read('ui/app.js');
  assert.match(app, /async function api\(path, options = \{\}\)/);
  assert.match(app, /data-package-document/);
  assert.match(app, /openPackageDocument\(/);
  assert.match(app, /\/api\/v2\/packages\/.*\/agent\/start/);
  assert.match(app, /\/api\/v2\/packages\/.*\/agent\/status/);
  assert.match(app, /function openStoredPackage\(packageKey, \{ view = 'overview'/);
  assert.match(app, /function packagePageUrl\(packageKey, view = 'overview'/);
  assert.match(app, /function packagePageAnchor\(packageKey, view, text/);
  assert.match(app, /function openStandaloneReader\(link, title = '内容阅读'/);
  assert.match(app, /configureChildPageShell\(initialPackageKey\)/);
  assert.match(app, /packagePageAnchor\(item\.packageKey, 'overview', '打开能力包子页面'/);
  assert.match(app, /document\.body\.dataset\.packagePage = view/);
  assert.match(app, /child-page-primary/);
  assert.match(app, /开始使用 Agent/);
  assert.match(app, /function renderActionAvailability\(\)/);
  assert.match(app, /setupPanelOpen/);
  assert.match(app, /bindPackageDocumentButtons\(\$\('#artifact-links'\)\)/);
  assert.match(app, /mountAgentInterface\(url\)/);
  assert.match(app, /classList\.add\('package-focus'\)/);
  assert.match(app, /else if \(initialPackageKey\) \{/);
  assert.doesNotMatch(app, /loadPackageLibrary\(\)\.then\([\s\S]*?openStoredPackage/);
});

test('服务端提供能力包启动预检、状态、日志和停止接口', () => {
  const server = read('ui-server.mjs');
  for (const marker of [
    '/api/v2/packages/{packageId}/agent/preflight',
    '/api/v2/packages/{packageId}/agent/status',
    '/api/v2/packages/{packageId}/agent/start',
    '/api/v2/packages/{packageId}/agent/stop',
    'preflightStoredPackageAgent',
    'getStoredPackageAgentStatus',
    'launchStoredPackageAgent',
    'stopStoredPackageAgent',
    'appendAgentLog',
  ]) assert.match(server, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(server, /async function storedPackageListItem\(item\)/);
  assert.match(server, /return await storedPackageListItem\(item\)/);
  assert.doesNotMatch(server, /const payload = await storedPackageResult\(item\.packageKey\)/);
});

test('工作区样式限制横向溢出，并在窄屏下切换为单列导航', () => {
  const styles = read('ui/styles.css');
  assert.match(styles, /\.package-workbench/);
  assert.match(styles, /overflow-x:\s*hidden/);
  assert.match(styles, /@media\s*\(max-width:\s*1000px\)/);
  assert.match(styles, /@media\s*\(max-width:\s*620px\)/);
  assert.match(styles, /body\.package-focus \.workspace\s*\{\s*order:\s*-1/);
  assert.match(styles, /body\[data-page-mode="package"\] \.control-panel/);
  assert.match(styles, /body\[data-page-mode="reader"\] \.control-panel/);
  assert.match(styles, /\.child-page-primary/);
  assert.match(styles, /较窄正文和明确的页面层级/);
  assert.match(styles, /body\[data-package-page="agent"\]/);
  assert.match(styles, /body\[data-package-page="priorities"\]/);
  assert.match(styles, /独立能力包控制舱/);
  assert.match(styles, /\.package-glance/);
  assert.match(styles, /\.package-state\[data-state="verified"\]/);
  assert.match(styles, /\.package-capability-expertise/);
  assert.match(styles, /\.document-reading-guide/);
  const agentStyles = read('templates/root-capability/agent/ui/styles.css');
  assert.match(agentStyles, /@media\s*\(max-width:\s*720px\)[\s\S]*?body\s*\{\s*min-width:\s*0/);
});

test('网页端会话列表保留真实标题、内容和网页入口', () => {
  const html = read('ui/index.html');
  const app = read('ui/app.js');
  const server = read('ui-server.mjs');
  const companion = read('templates/root-capability/agent/chatgpt-companion/content.js');
  const bridge = read('templates/root-capability/agent/runtime/chatgpt-web-link.mjs');
  assert.match(html, /读取全部真实会话列表/);
  assert.match(app, /loadWebChatHistoryAutomatically/);
  assert.match(app, /web-chat-history-open/);
  assert.match(app, /web-chat-imported-open/);
  assert.match(app, /messageCount/);
  assert.match(app, /userPreview/);
  assert.match(server, /readPersistedWebChatDetails/);
  assert.match(server, /hasRealConversation/);
  assert.match(server, /if \(!webChatDetails\?\.hasRealConversation\) return \[\];/);
  assert.match(companion, /usableConversationTitle/);
  assert.match(companion, /firstUserMessage/);
  assert.match(companion, /loadAllHistoryLinks/);
  assert.match(companion, /function expandHistorySections/);
  assert.match(companion, /expandedSections/);
  assert.match(companion, /scrollRounds/);
  assert.match(companion, /captureHistoryLinks/);
  assert.match(companion, /await historyIndex\(\)/);
  assert.match(companion, /target\.set\(url\.href/);
  assert.match(bridge, /value\.conversations\.map/);
  assert.match(bridge, /scan: value\?\.scan/);
  assert.doesNotMatch(bridge, /value\.conversations\.slice\(0,\s*300\)/);
});

test('网页历史目录持久化保存，并按会话编号更新当前聊天', () => {
  const app = read('ui/app.js');
  const server = read('ui-server.mjs');
  assert.match(app, /\/api\/web-chat\/history\/import/);
  assert.match(app, /已保存到持久化列表/);
  assert.match(app, /更新同一条记录/);
  assert.match(app, /已保存会话标题；打开这条聊天并读取当前聊天后，会更新为完整内容/);
  assert.match(server, /async function importWebChatHistoryJob/);
  assert.match(server, /\/history\/import/);
  assert.match(server, /function webChatConversationId/);
  assert.match(server, /async function findPersistedWebChatSource/);
  assert.match(server, /conversation_id: conversationId/);
  assert.match(server, /content_hash: contentHash/);
  assert.match(server, /type: 'web_event'/);
  assert.match(server, /type: 'web_asset'/);
  assert.match(server, /type: 'web_node'/);
  assert.match(server, /raw_payload_hash/);
  assert.match(server, /eventCount/);
  assert.match(server, /assetCount/);
  assert.match(server, /updateMode: existing \? 'updated' : 'created'/);
  assert.match(server, /sourcePath = existingPath \|\| path\.join/);
});

test('ChatGPT 全量接入同时提供官方导出、Edge 批量读取与来源对账', () => {
  const html = read('ui/index.html');
  const app = read('ui/app.js');
  const server = read('ui-server.mjs');
  const bridge = read('templates/root-capability/agent/runtime/chatgpt-web-link.mjs');
  const companion = read('templates/root-capability/agent/chatgpt-companion/content.js');
  assert.match(html, /id="chatgpt-import-trigger"/);
  assert.match(html, /id="chatgpt-capture-all"/);
  assert.match(html, /id="chatgpt-coverage-grid"/);
  assert.match(app, /importChatGPTExportFile/);
  assert.match(app, /captureAllChatGPTConversations/);
  assert.match(app, /CHATGPT_BATCH_JOB_STORAGE_KEY/);
  assert.match(app, /resumeChatGPTBatchJob/);
  assert.match(app, /startChatGPTCoveragePolling/);
  assert.match(app, /9_600/);
  assert.match(app, /\/api\/v2\/chatgpt\/import\/export/);
  assert.match(app, /\/api\/v2\/chatgpt\/edge\/capture-all/);
  assert.match(server, /\/api\/v2\/chatgpt\/coverage/);
  assert.match(server, /\/api\/v2\/chatgpt\/conversations/);
  assert.match(server, /conversations\/\{conversationId\}\/events/);
  assert.match(server, /conversations\/\{conversationId\}\/assets/);
  assert.match(server, /conversations\/\{conversationId\}\/branches/);
  assert.match(server, /conversations\/\{conversationId\}\/raw/);
  assert.match(server, /events\|assets\|branches\|raw/);
  assert.match(server, /readPersistedWebChatRows/);
  assert.match(server, /updatedAt: meta\.source_updated_at/);
  assert.match(server, /importWebChatBatchJob/);
  assert.match(server, /stableLocalSessionId/);
  assert.match(server, /importKind: 'chatgpt-export'/);
  assert.match(server, /registeredCount/);
  assert.match(app, /originLabel/);
  assert.match(bridge, /capture-all/);
  assert.match(bridge, /function progress\(/);
  assert.match(companion, /rawPayload/);
  assert.match(companion, /eventType/);
  assert.match(companion, /assets/);
  assert.match(companion, /MAX_HISTORY_SCROLL_ROUNDS = 800/);
  assert.doesNotMatch(companion, /\}\.slice\(-500\)\.map/);
  assert.doesNotMatch(bridge, /value\.messages\.slice\(-500\)/);
});

test('ChatGPT 首次全量读取展示进度，并支持检查点暂停、续读和失败重试', () => {
  const html = read('ui/index.html');
  const app = read('ui/app.js');
  const server = read('ui-server.mjs');
  const sync = read('lib/chatgpt-incremental-sync.mjs');
  const bridge = read('templates/root-capability/agent/runtime/chatgpt-web-link.mjs');
  for (const marker of [
    'chatgpt-sync-progress',
    'chatgpt-sync-track-value',
    'chatgpt-sync-pause',
    'chatgpt-sync-resume',
    'chatgpt-sync-cancel',
    'chatgpt-sync-retry-failed',
  ]) assert.match(html, new RegExp(marker));
  assert.match(app, /function renderChatGPTSyncProgress\(/);
  assert.match(app, /function controlChatGPTSync\(/);
  assert.match(app, /function retryFailedChatGPTSync\(/);
  assert.match(app, /formatSyncEta/);
  assert.match(app, /formatSyncCheckpoint/);
  assert.match(app, /\/api\/v2\/chatgpt\/sync\//);
  assert.match(server, /\/api\/v2\/chatgpt\/sync\/\{runId\}\/retry-failed/);
  assert.match(server, /syncRunRetryMatch/);
  assert.match(server, /runs: runs\.slice\(0, 20\)/);
  assert.match(app, /const recoverableRuns = \(payload\?\.incremental\?\.active \|\| \[\]\)\.filter/);
  assert.match(app, /rightCheckpoint - leftCheckpoint \|\| Number\(right\?\.remainingCount/);
  assert.match(app, /localStorage\.setItem\(CHATGPT_BATCH_JOB_STORAGE_KEY, recoverableId\)/);
  assert.match(sync, /chatgpt-incremental-sync-v3/);
  assert.match(sync, /targetIds/);
  assert.match(sync, /failedIds/);
  assert.match(bridge, /function pauseJob\(/);
  assert.match(bridge, /function resumeJob\(/);
  assert.match(bridge, /function cancelJob\(/);
  assert.match(bridge, /etaSeconds/);
});

test('主蒸馏台使用三视图侧栏，主屏互斥显示并将辅助功能移出主流程', () => {
  const html = read('ui/index.html');
  const app = read('ui/app.js');
  const styles = read('ui/styles.css');
  const server = read('ui-server.mjs');
  for (const view of ['local', 'web', 'results']) {
    assert.match(html, new RegExp(`data-workbench-nav="${view}"`));
  }
  assert.match(html, /class="workbench-sidebar"/);
  assert.match(html, /本机对话/);
  assert.match(html, /网页端对话/);
  assert.match(html, />结果</);
  assert.match(html, /id="workbench-tools-dialog"/);
  assert.match(html, /id="open-workbench-tools"/);
  assert.match(html, /id="package-library-search"/);
  assert.match(html, /id="package-library-count"/);
  assert.match(html, /id="package-library-target"/);
  assert.match(html, /id="package-library-time"/);
  assert.match(html, /id="package-library-sort"/);
  assert.match(html, /id="result-overview-strip"/);
  assert.match(html, /id="result-overview-primary"/);
  assert.ok(html.indexOf('id="portable-workbench"') > html.indexOf('</main>'), '换机安装包必须位于主工作台外的辅助对话框');
  assert.match(app, /function setWorkbenchView\(/);
  assert.match(app, /function renderWorkbenchNavigation\(/);
  assert.match(app, /function setViewAccessibility\(/);
  assert.match(app, /window\.history\.pushState/);
  assert.match(app, /window\.addEventListener\('popstate'/);
  assert.match(app, /workbenchNavigation\.addEventListener\('keydown'/);
  assert.match(app, /state\.packageLibrary\.length/);
  assert.match(app, /packageLibraryLoaded/);
  assert.match(app, /列表异常/);
  assert.match(app, /function packageSearchText\(/);
  assert.match(app, /function renderResultOverview\(/);
  assert.match(app, /function packageReleaseInfo\(/);
  assert.match(app, /dataset\.resultOverviewAction/);
  assert.match(app, /function packageMatchesFilters\(/);
  assert.match(app, /data-package-details-toggle/);
  assert.match(app, /\/api\/packages\?limit=100&offset=/);
  assert.match(app, /while \(offset !== null\)/);
  assert.match(app, /setWorkbenchView\('results'/);
  assert.match(styles, /body\[data-workbench-view="local"\] \.web-intake-only/);
  assert.match(styles, /body\[data-workbench-view="web"\] \.local-intake-only/);
  assert.match(styles, /body\[data-workbench-view="results"\] \.control-panel/);
  assert.match(styles, /\.workbench-tools-dialog::backdrop/);
  assert.match(styles, /\.package-library-tools/);
  assert.match(styles, /\.package-library-filterbar/);
  assert.match(styles, /\.recent-package-details\[hidden\]/);
  assert.match(styles, /\/\* Product surface: evidence studio \*\//);
  assert.match(styles, /--studio-ink: #102d29/);
  assert.match(styles, /body\[data-workbench-view="web"\] \.control-panel > \.panel-heading::before/);
  assert.match(styles, /body\[data-workbench-view="results"\] \.results-view-heading::before/);
  assert.match(styles, /\.session-search-results/);
  assert.match(styles, /\/\* Results view: decision board rather than an artifact dump\. \*\//);
  assert.match(styles, /\.result-overview-strip/);
  assert.match(styles, /\.result-overview-strip\[hidden\] \{ display: none; \}/);
  assert.match(styles, /counter-reset: package-catalog/);
  assert.match(server, /async function listStoredPackagesPage\(/);
  assert.match(server, /nextOffset/);
  assert.match(server, /url\.searchParams\.get\('offset'\)/);
});
