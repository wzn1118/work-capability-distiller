import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadConversationSources } from './lib/conversation-evidence-sources.mjs';
import { discoverRelatedProject } from './lib/project-discovery.mjs';
import { analyseProjectEvidence } from './lib/project-evidence.mjs';
import { buildProjectKnowledgeV4, compareProjectSnapshots } from './lib/project-knowledge-v4.mjs';
import { packageConversationV2, previewConversationCapabilityV2, verifyConversationPackageV2 } from './lib/root-capability-packager.mjs';

const execFileAsync = promisify(execFile);
const SESSION_ONE = '33333333-4444-7555-8666-777777777777';
const SESSION_TWO = '44444444-5555-7666-8777-888888888888';

async function runGit(root, args) {
  await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
}

async function writeSession(filePath, sessionId, title, rows, cwd = 'C:/fixture-project') {
  const baseTime = sessionId === SESSION_ONE ? '2026-08-16T09:00:00.000Z' : '2026-08-16T11:00:00.000Z';
  const records = [
    { type: 'session_meta', payload: { session_id: sessionId, title, cwd } },
    ...rows.map((record, index) => ({
      timestamp: record.timestamp || new Date(Date.parse(baseTime) + index * 60_000).toISOString(),
      ...record,
    })),
  ];
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

async function multiSourceFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-multi-source-project-'));
  const sessions = path.join(root, 'sessions');
  const project = path.join(root, 'project');
  await fs.mkdir(sessions, { recursive: true });
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(path.join(project, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(project, 'output'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'fixture-project', type: 'module' }, null, 2), 'utf8');
  await fs.writeFile(path.join(project, 'AGENTS.md'), '# Project rules\n\nUse focused changes and verify them.\n', 'utf8');
  await fs.writeFile(path.join(project, 'src', 'helper.mjs'), 'export const evidence = "baseline";\n', 'utf8');
  await fs.writeFile(path.join(project, 'src', 'app.mjs'), 'import { evidence } from "./helper.mjs";\nexport const answer = 1;\nexport { evidence };\n', 'utf8');
  await fs.writeFile(path.join(project, 'scripts', 'generate-report.mjs'), 'import fs from "node:fs";\nconst [, , input, output] = process.argv;\nfs.writeFileSync(output, `# Generated from ${input}\\n`);\n', 'utf8');
  await runGit(project, ['init']);
  await runGit(project, ['config', 'user.email', 'fixture@example.test']);
  await runGit(project, ['config', 'user.name', 'Fixture']);
  await runGit(project, ['add', '.']);
  await runGit(project, ['commit', '-m', 'initial']);
  await fs.writeFile(path.join(project, 'src', 'helper.mjs'), 'export const evidence = "merged sessions";\n', 'utf8');
  await fs.writeFile(path.join(project, 'src', 'app.mjs'), 'import { evidence } from "./helper.mjs";\nexport const answer = 2;\nexport { evidence };\n', 'utf8');
  await fs.writeFile(path.join(project, 'src', 'late-linked.mjs'), 'export const lateEvidence = true;\n', 'utf8');
  await fs.writeFile(path.join(project, 'output', 'report.md'), '# Generated report\n\n@generated from merged evidence\n', 'utf8');
  await runGit(project, ['add', 'src/app.mjs']);

  const sourceOne = path.join(sessions, `rollout-${SESSION_ONE}.jsonl`);
  const sourceTwo = path.join(sessions, `rollout-${SESSION_TWO}.jsonl`);
  await writeSession(sourceOne, SESSION_ONE, '改造项目证据蒸馏器', [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '读取 src/app.mjs，理解项目规则后修改实现，并保留 Git 原始版本和差异。' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'functions.apply_patch', call_id: 'patch-1', arguments: '*** Begin Patch\n*** Update File: src/app.mjs\n*** End Patch' } },
    { type: 'fileChange', payload: { changes: [{ path: 'src/app.mjs', action: 'modified' }, { path: 'src/helper.mjs', action: 'modified' }, { path: 'src/late-linked.mjs', action: 'added' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已修改 src/app.mjs，并会在交付物中保留原始版本和差异。' }] } },
  ], project);
  await writeSession(sourceTwo, SESSION_TWO, '生成项目证据报告与能力包', [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '基于上一次改动生成 output/report.md，并把两条会话蒸馏为可安装能力包。' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'functions.exec_command', call_id: 'exec-2', arguments: JSON.stringify({ cmd: 'node scripts/generate-report.mjs src/app.mjs output/report.md && node --test' }) } },
    { type: 'fileChange', payload: { changes: [{ path: 'output/report.md', action: 'added' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已生成报告；能力包应展示两个会话标题和项目证据。' }] } },
  ], project);
  return { root, project, sourceOne, sourceTwo };
}

async function multiProjectFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cross-project-'));
  const sessions = path.join(root, 'sessions');
  const analyticsProject = path.join(root, 'comment-insight');
  const presentationProject = path.join(root, 'presentation-builder');
  await fs.mkdir(sessions, { recursive: true });
  await fs.mkdir(path.join(analyticsProject, 'src'), { recursive: true });
  await fs.mkdir(path.join(presentationProject, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(analyticsProject, 'package.json'), JSON.stringify({ name: 'comment-insight', type: 'module' }, null, 2), 'utf8');
  await fs.writeFile(path.join(analyticsProject, 'src', 'analyse.mjs'), 'export const analyse = (rows) => rows.length;\n', 'utf8');
  await fs.writeFile(path.join(presentationProject, 'pyproject.toml'), '[project]\nname = "presentation-builder"\nversion = "1.0.0"\n', 'utf8');
  await fs.writeFile(path.join(presentationProject, 'scripts', 'build.py'), 'print("build presentation")\n', 'utf8');

  const sourceOne = path.join(sessions, `rollout-${SESSION_ONE}.jsonl`);
  const sourceTwo = path.join(sessions, `rollout-${SESSION_TWO}.jsonl`);
  await writeSession(sourceOne, SESSION_ONE, '评论数据洞察项目', [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '读取 src/analyse.mjs，完善评论主题与受众洞察。' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'functions.apply_patch', call_id: 'analytics-patch', arguments: '*** Begin Patch\n*** Update File: src/analyse.mjs\n*** End Patch' } },
    { type: 'fileChange', payload: { changes: [{ path: 'src/analyse.mjs', action: 'modified' }] } },
  ], analyticsProject);
  await writeSession(sourceTwo, SESSION_TWO, '演示文稿生成项目', [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '运行 scripts/build.py，生成并验证演示文稿。' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'functions.exec_command', call_id: 'presentation-command', arguments: JSON.stringify({ cmd: 'python scripts/build.py' }) } },
    { type: 'fileChange', payload: { changes: [{ path: 'scripts/build.py', action: 'modified' }] } },
  ], presentationProject);
  return { root, analyticsProject, presentationProject, sourceOne, sourceTwo };
}

test('merges selected sessions and captures project baseline, diffs, and generated artifacts', async (t) => {
  const fixture = await multiSourceFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const loaded = await loadConversationSources({ sourcePaths: [fixture.sourceOne, fixture.sourceTwo], redact: false });
  assert.equal(loaded.sourceSet.mode, 'multi-session');
  assert.equal(loaded.sourceSet.sessionCount, 2);
  assert.equal(loaded.sourceSet.authority[0].sessionId, SESSION_TWO);
  assert.equal(loaded.sourceSet.sessions[1].authorityRank, 1);
  assert.equal(loaded.sourceSet.sessions[0].title, '改造项目证据蒸馏器');
  assert.equal(loaded.sourceSet.sessions[1].title, '生成项目证据报告与能力包');
  assert.deepEqual(loaded.analysis.episodes.map((episode) => episode.request), [
    '读取 src/app.mjs，理解项目规则后修改实现，并保留 Git 原始版本和差异。',
    '基于上一次改动生成 output/report.md，并把两条会话蒸馏为可安装能力包。',
  ]);
  assert.ok(loaded.sourceSet.sessions.every((item) => item.normalisedEventCount > 0));
  assert.ok(loaded.analysis.codeArtifacts.fileChanges.every((item) => item.sourceSessionId));

  const evidence = await analyseProjectEvidence({
    projectPath: fixture.project,
    relatedFiles: loaded.analysis.codeArtifacts.fileChanges,
    redact: false,
  });
  assert.equal(evidence.project.isGit, true);
  assert.ok(evidence.modifiedFiles.find((item) => item.path === 'src/app.mjs')?.diffExcerpt);
  assert.ok(evidence.modifiedFiles.some((item) => item.path === 'src/app.mjs' && item.original && item.diffExcerpt));
  const currentApp = await fs.readFile(path.join(fixture.project, 'src', 'app.mjs'));
  const appFile = evidence.files.find((item) => item.path === 'src/app.mjs');
  const originalApp = evidence.modifiedFiles.find((item) => item.path === 'src/app.mjs')?.original;
  assert.equal(appFile.contentSha256, createHash('sha256').update(currentApp).digest('hex'));
  assert.equal(appFile.contentStatus, '全文已读取并生成展示摘录');
  assert.ok(originalApp.gitObjectId);
  assert.ok(originalApp.sha256);
  assert.ok(originalApp.bytes > 0);
  assert.equal(originalApp.revision, evidence.git.headRevision);
  assert.ok(evidence.generatedFiles.some((item) => item.path === 'output/report.md'));
  assert.ok(evidence.conversationLinks.some((item) => item.path === 'src/app.mjs'));
  assert.equal(evidence.summary.modifiedFiles, evidence.modifiedFiles.length);
  assert.equal(evidence.summary.generatedFiles, evidence.generatedFiles.length);

  const capped = await analyseProjectEvidence({
    projectPath: fixture.project,
    relatedFiles: loaded.analysis.codeArtifacts.fileChanges,
    redact: false,
    maxFiles: 2,
  });
  assert.equal(capped.scan.truncated, true);
  assert.ok(capped.files.some((item) => item.path === 'src/late-linked.mjs'));
  assert.ok(capped.files.find((item) => item.path === 'src/late-linked.mjs')?.observedInConversation);
  assert.ok(capped.scan.priorityFiles >= 3);
});

test('automatically discovers the related project from selected session evidence', async (t) => {
  const fixture = await multiSourceFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const preview = await previewConversationCapabilityV2({
    sourcePaths: [fixture.sourceOne, fixture.sourceTwo],
    projectScope: 'project',
    contextMode: 'project-relevant',
    projectConfirmed: true,
    redact: false,
  });
  assert.equal(preview.projectDiscovery.mode, '自动发现');
  assert.equal(preview.projectDiscovery.confidence, '高');
  assert.equal(await fs.realpath(preview.projectDiscovery.selectedPath), await fs.realpath(fixture.project));
  assert.equal(await fs.realpath(preview.projectEvidence.project.root), await fs.realpath(fixture.project));
  assert.equal(preview.projectEvidence.summary.discoveryMode, '自动发现');
  assert.deepEqual(preview.extraction.stages.map((stage) => stage.request), [
    '读取 src/app.mjs，理解项目规则后修改实现，并保留 Git 原始版本和差异。',
    '基于上一次改动生成 output/report.md，并把两条会话蒸馏为可安装能力包。',
  ]);
  assert.ok(preview.projectEvidence.modifiedFiles.some((item) => item.path === 'src/app.mjs'));
  assert.ok(preview.projectEvidence.generatedFiles.some((item) => item.path === 'output/report.md'));
});

test('keeps an explicit single-session distillation separate from the related project and workspace', async (t) => {
  const fixture = await multiSourceFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const preview = await previewConversationCapabilityV2({
    sourcePath: fixture.sourceOne,
    projectPath: fixture.project,
    projectScope: 'sessions-only',
    redact: false,
  });
  assert.equal(preview.sourceSet.mode, 'whole-session');
  assert.equal(preview.sourceSet.sessionCount, 1);
  assert.equal(preview.projectDiscovery.mode, 'sessions-only');
  assert.equal(preview.projectDiscovery.selectedPath, null);
  assert.equal(preview.projectEvidence, null);
  assert.equal(preview.projectPortfolio.projects.length, 0);
  assert.equal(preview.projectPortfolio.sessionAssignments.length, 0);
  assert.equal(preview.projectDiscovery.unassignedSessions[0].sessionId, SESSION_ONE);

  const generated = await packageConversationV2({
    sourcePath: fixture.sourceOne,
    projectPath: fixture.project,
    projectScope: 'sessions-only',
    packageId: 'sessions-only-isolation',
    outputRoot: path.join(fixture.root, 'packages'),
    redact: false,
  });
  const projectPortfolio = JSON.parse(await fs.readFile(path.join(generated.package.root, 'project-portfolio.json'), 'utf8'));
  const evidenceManifest = JSON.parse(await fs.readFile(path.join(generated.package.root, 'evidence-manifest.json'), 'utf8'));
  assert.equal(projectPortfolio.projects.length, 0);
  assert.equal(projectPortfolio.sessionAssignments.length, 0);
  assert.equal(evidenceManifest.project.mode, 'sessions-only');
  assert.equal(preview.projectDiscovery.recommendedMode, '仅按选中会话蒸馏');
});

test('assigns selected conversations to different projects and preserves the split in every deliverable', async (t) => {
  const fixture = await multiProjectFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const preview = await previewConversationCapabilityV2({
    sourcePaths: [fixture.sourceOne, fixture.sourceTwo],
    projectScope: 'project',
    contextMode: 'project-relevant',
    projectConfirmed: true,
    redact: false,
  });
  assert.equal(preview.projectDiscovery.mode, '自动发现多个项目');
  assert.equal(preview.projectDiscovery.crossProject, true);
  assert.equal(preview.projectDiscovery.projects.length, 2);
  assert.equal(preview.projectPortfolio.crossProject, true);
  assert.equal(preview.projectPortfolio.projects.length, 2);
  assert.equal(preview.projectPortfolio.sessionAssignments.length, 2);
  const analyticsAssignment = preview.projectPortfolio.sessionAssignments.find((item) => item.sessionId === SESSION_ONE);
  const presentationAssignment = preview.projectPortfolio.sessionAssignments.find((item) => item.sessionId === SESSION_TWO);
  assert.equal(await fs.realpath(analyticsAssignment.projectRoot), await fs.realpath(fixture.analyticsProject));
  assert.equal(await fs.realpath(presentationAssignment.projectRoot), await fs.realpath(fixture.presentationProject));
  assert.equal(analyticsAssignment.projectName, 'comment-insight');
  assert.equal(presentationAssignment.projectName, 'presentation-builder');
  assert.ok(preview.projectPortfolio.projects.every((project) => project.evidenceSummary?.scannedFiles >= 1));

  const result = await packageConversationV2({
    sourcePaths: [fixture.sourceOne, fixture.sourceTwo],
    projectScope: 'project',
    contextMode: 'project-relevant',
    projectConfirmed: true,
    packageId: 'cross-project-portfolio',
    outputRoot: path.join(fixture.root, 'packages'),
    redact: false,
  });
  const generated = result.package;
  const portfolio = JSON.parse(await fs.readFile(path.join(generated.root, 'project-portfolio.json'), 'utf8'));
  const portfolioMarkdown = await fs.readFile(path.join(generated.root, 'project-portfolio.md'), 'utf8');
  const agentUi = await fs.readFile(path.join(generated.delivery.agent.root, 'ui', 'app.js'), 'utf8');
  const agentStyles = await fs.readFile(path.join(generated.delivery.agent.root, 'ui', 'styles.css'), 'utf8');
  const agentEvidence = await fs.readFile(path.join(generated.delivery.agent.root, 'runtime', 'evidence.mjs'), 'utf8');
  const mcpServer = await fs.readFile(generated.delivery.mcp.server, 'utf8');
  assert.equal(portfolio.crossProject, true);
  assert.deepEqual(new Set(portfolio.projects.map((item) => item.name)), new Set(['comment-insight', 'presentation-builder']));
  assert.match(portfolioMarkdown, /按项目分组保留文件、Git、工具调用和生成产物证据/);
  await assert.doesNotReject(fs.stat(path.join(generated.delivery.skill.root, 'references', 'project-portfolio.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.delivery.agent.root, 'project-portfolio.json')));
  assert.match(agentUi, /每条会话属于哪个项目/);
  assert.match(agentStyles, /\.agent-project-assignments > article/);
  assert.match(agentEvidence, /get_project_portfolio/);
  assert.match(mcpServer, /get_project_portfolio/);
  const verification = await verifyConversationPackageV2(generated.root);
  assert.equal(verification.ok, true, JSON.stringify(verification.failures));
});

test('keeps an explicit project folder above automatic candidates and reports missing evidence', async (t) => {
  const fixture = await multiSourceFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const manual = await discoverRelatedProject({
    projectPath: fixture.project,
    sources: [{ title: '错误候选', parsed: { sessionMeta: { cwd: fixture.sessions } } }],
  });
  assert.equal(manual.mode, '人工指定');
  assert.equal(await fs.realpath(manual.selectedPath), await fs.realpath(fixture.project));

  const noProjectRoot = path.join(fixture.root, 'plain-session');
  await fs.mkdir(noProjectRoot, { recursive: true });
  const noProjectSource = path.join(noProjectRoot, 'rollout-no-project.jsonl');
  await writeSession(noProjectSource, '55555555-6666-7777-8888-999999999999', '没有项目证据', [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '只总结这句话，不涉及任何本地文件。' }] } },
  ], noProjectRoot);
  const preview = await previewConversationCapabilityV2({ sourcePath: noProjectSource, projectScope: 'project', contextMode: 'project-relevant', projectConfirmed: true, redact: false });
  assert.equal(preview.projectDiscovery.mode, '未发现');
  assert.equal(preview.projectDiscovery.selectedPath, null);
  assert.equal(preview.projectEvidence, null);
});

test('packages multi-session and project evidence into every requested deliverable', async (t) => {
  const fixture = await multiSourceFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = await packageConversationV2({
    sourcePaths: [fixture.sourceOne, fixture.sourceTwo],
    projectScope: 'project',
    contextMode: 'project-relevant',
    projectConfirmed: true,
    packageId: 'multi-project-evidence',
    outputRoot: path.join(fixture.root, 'packages'),
    redact: false,
  });
  const generated = result.package;
  const manifest = JSON.parse(await fs.readFile(generated.manifest, 'utf8'));
  assert.equal(manifest.knowledgeSchemaVersion, '4.1.0');
  assert.equal(generated.selection.mode, 'multi-session');
  assert.equal(generated.selection.sessionCount, 2);
  assert.ok(generated.sourceSet.sessions.every((item) => item.title));
  assert.equal(generated.projectEvidenceSummary.name, 'project');
  assert.equal(generated.projectDiscovery.mode, '自动发现');
  assert.equal(generated.projectEvidenceSummary.discoveryMode, '自动发现');
  await assert.doesNotReject(fs.stat(path.join(generated.root, 'source-sessions.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.root, 'project-discovery.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.root, 'project-discovery.md')));
  await assert.doesNotReject(fs.stat(path.join(generated.root, 'project-portfolio.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.root, 'project-portfolio.md')));
  await assert.doesNotReject(fs.stat(path.join(generated.root, 'project-evidence.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.root, 'project-evidence.md')));
  await assert.doesNotReject(fs.stat(path.join(generated.root, 'project-understanding.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.root, 'project-understanding.md')));
  const knowledgeArtifacts = ['project-knowledge-v4.json', 'project-knowledge-v4.md', 'semantic-stages.json', 'evidence-ledger.ndjson', 'project-model.json', 'project-graph.json', 'file-versions.ndjson', 'artifact-lineage.json', 'cross-session-timeline.ndjson', 'file-change-matrix.json', 'dependency-impact.json', 'artifact-reproducibility.json', 'project-snapshot.json', 'open-evidence-questions.json', 'decision-conflicts.json', 'coverage.json', 'active-read-log.ndjson'];
  for (const artifact of knowledgeArtifacts) {
    await assert.doesNotReject(fs.stat(path.join(generated.root, artifact)));
  }
  for (const artifact of knowledgeArtifacts) {
    await assert.doesNotReject(fs.stat(path.join(generated.delivery.skill.root, 'references', artifact)));
    await assert.doesNotReject(fs.stat(path.join(generated.delivery.agent.root, artifact)));
  }
  await assert.doesNotReject(fs.stat(path.join(generated.delivery.skill.root, 'references', 'source-sessions.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.delivery.skill.root, 'references', 'project-portfolio.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.delivery.skill.root, 'references', 'project-understanding.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.delivery.skill.root, 'references', 'project-knowledge-v4.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.delivery.agent.root, 'source-sessions.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.delivery.agent.root, 'project-portfolio.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.delivery.agent.root, 'project-evidence.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.delivery.agent.root, 'project-understanding.json')));
  await assert.doesNotReject(fs.stat(path.join(generated.delivery.agent.root, 'project-understanding.md')));
  await assert.doesNotReject(fs.stat(path.join(generated.delivery.agent.root, 'project-knowledge-v4.json')));
  const readme = await fs.readFile(generated.delivery.guide, 'utf8');
  const profile = await fs.readFile(generated.delivery.agent.aiProfile, 'utf8');
  const runtime = await fs.readFile(path.join(generated.delivery.agent.root, 'runtime', 'evidence.mjs'), 'utf8');
  const extraction = JSON.parse(await fs.readFile(path.join(generated.root, 'conversation-extraction.json'), 'utf8'));
  const projectMarkdown = await fs.readFile(path.join(generated.root, 'project-evidence.md'), 'utf8');
  const discoveryMarkdown = await fs.readFile(path.join(generated.root, 'project-discovery.md'), 'utf8');
  const understanding = JSON.parse(await fs.readFile(path.join(generated.root, 'project-understanding.json'), 'utf8'));
  const understandingMarkdown = await fs.readFile(path.join(generated.root, 'project-understanding.md'), 'utf8');
  const projectKnowledgeV4 = JSON.parse(await fs.readFile(path.join(generated.root, 'project-knowledge-v4.json'), 'utf8'));
  const projectKnowledgeMarkdown = await fs.readFile(path.join(generated.root, 'project-knowledge-v4.md'), 'utf8');
  const evidenceLedger = (await fs.readFile(path.join(generated.root, 'evidence-ledger.ndjson'), 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const fileVersions = (await fs.readFile(path.join(generated.root, 'file-versions.ndjson'), 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const agentUi = await fs.readFile(path.join(generated.delivery.agent.root, 'ui', 'app.js'), 'utf8');
  const agentHtml = await fs.readFile(path.join(generated.delivery.agent.root, 'ui', 'index.html'), 'utf8');
  const agentStyles = await fs.readFile(path.join(generated.delivery.agent.root, 'ui', 'styles.css'), 'utf8');
  assert.match(readme, /改造项目证据蒸馏器/);
  assert.match(readme, /生成项目证据报告与能力包/);
  assert.match(readme, /Git/);
  assert.match(profile, /project-evidence/);
  assert.match(runtime, /get_source_sessions/);
  assert.match(runtime, /get_project_portfolio/);
  assert.match(runtime, /get_project_evidence/);
  assert.match(runtime, /get_project_understanding/);
  assert.match(runtime, /get_project_knowledge_v4/);
  assert.equal(extraction.sourceAuthority[0].sessionId, SESSION_TWO);
  assert.ok(extraction.requirementEvolution.some((item) => item.authorityRank === 1));
  assert.match(projectMarkdown, /取证选择规则/);
  assert.match(projectMarkdown, /项目选择方式：自动发现/);
  assert.match(discoveryMarkdown, /项目自动发现/);
  assert.match(discoveryMarkdown, /最终目录/);
  assert.equal(understanding.project.name, 'project');
  assert.equal(understanding.scope.sourceSessions, 2);
  assert.ok(understanding.evidenceGraph.nodes.length > 0);
  assert.ok(understanding.evidenceGraph.edges.length > 0);
  const appEvolution = understanding.fileEvolution.find((item) => item.path === 'src/app.mjs');
  assert.ok(appEvolution?.current.available);
  assert.ok(appEvolution?.original.available);
  assert.ok(appEvolution?.diff.available);
  assert.ok(appEvolution?.conversationEvidence.some((item) => item.sessionId === SESSION_ONE));
  const reportEvolution = understanding.fileEvolution.find((item) => item.path === 'output/report.md');
  assert.ok(reportEvolution?.conversationEvidence.some((item) => item.sessionId === SESSION_TWO));
  assert.ok(!understanding.activeReadPlan.some((item) => item.path === 'src/app.mjs'), '已完整读取的文件不应重复进入待读取计划');
  assert.match(understandingMarkdown, /项目深度理解/);
  assert.match(understandingMarkdown, /文件演化与证据/);
  assert.equal(projectKnowledgeV4.schemaVersion, '4.1.0');
  assert.equal(projectKnowledgeV4.summary.sessions, 2);
  assert.ok(projectKnowledgeV4.semanticStages.length >= 2);
  assert.ok(projectKnowledgeV4.semanticStages.every((item) => item.title.startsWith('P') && item.occurrences.length > 0 && item.evidenceIds.length > 0));
  assert.ok(evidenceLedger.some((item) => item.kind === '当前文件内容'));
  assert.ok(evidenceLedger.some((item) => item.kind === 'Git 原始版本'));
  assert.ok(fileVersions.some((item) => item.path === 'src/app.mjs' && item.kind === 'Git 原始版本'));
  assert.ok(fileVersions.some((item) => item.path === 'src/app.mjs' && item.kind === '当前工作区版本'));
  assert.ok(projectKnowledgeV4.artifactLineage.some((item) => item.path === 'output/report.md'));
  assert.ok(projectKnowledgeV4.crossSessionTimeline.some((item) => item.sessionId === SESSION_ONE));
  assert.ok(projectKnowledgeV4.crossSessionTimeline.some((item) => item.sessionId === SESSION_TWO));
  assert.ok(projectKnowledgeV4.fileChangeMatrix.some((item) => item.path === 'src/app.mjs' && item.baseline?.sha256 && item.current?.sha256));
  const helperImpact = projectKnowledgeV4.dependencyImpact.changedFiles.find((item) => item.path === 'src/helper.mjs');
  assert.ok(helperImpact?.directDependents.includes('src/app.mjs'));
  const reportRecipe = projectKnowledgeV4.artifactReproducibility.find((item) => item.path === 'output/report.md');
  assert.equal(reportRecipe?.reproducibility.readyToReplay, true, JSON.stringify({
    reportRecipe,
    stages: extraction.stages.map((stage) => ({ index: stage.index, title: stage.title, commands: stage.commands })),
  }, null, 2));
  assert.ok(reportRecipe.inputs.includes('src/app.mjs'));
  assert.ok(!reportRecipe.inputs.includes('output/report.md'));
  assert.ok(projectKnowledgeV4.projectSnapshot.fingerprint);
  assert.ok(projectKnowledgeV4.projectSnapshot.files.some((item) => item.path === 'src/app.mjs' && item.sha256));
  assert.ok(projectKnowledgeV4.activeReadLog.some((item) => item.target === 'src/app.mjs' && item.status === '已完成'));
  assert.match(projectKnowledgeMarkdown, /多会话项目级蒸馏知识包 V4\.1/);
  assert.match(projectKnowledgeMarkdown, /生成产物血缘/);
  assert.match(agentUi, /来源优先级/);
  assert.match(agentUi, /项目深度理解/);
  assert.match(agentUi, /renderProjectKnowledgeV4/);
  assert.match(agentHtml, /项目知识/);
  assert.match(agentHtml, /语义阶段与实际目标/);
  assert.match(agentStyles, /\.knowledge-table-wrap \{ width: 100%; min-width: 0; max-width: 100%;/);
  assert.match(agentStyles, /\.knowledge-decision-list article \{ min-width: 0; max-width: 100%;/);
  assert.match(agentStyles, /\.knowledge-section code \{ overflow-wrap: anywhere; word-break: break-word; \}/);
  assert.match(agentStyles, /\.page-heading \{ display: grid; gap: 12px; margin-bottom: 16px; \}/);
  assert.match(agentStyles, /\.page-heading > \.secondary-button \{ width: auto; max-width: 100%;/);
  const agentEvidence = await import(pathToFileURL(path.join(generated.delivery.agent.root, 'runtime', 'evidence.mjs')).href);
  const agentUnderstanding = await agentEvidence.getProjectUnderstanding(generated.delivery.agent.root, { group: '全部', maxItems: 50 });
  assert.equal(agentUnderstanding.available, true);
  assert.ok(agentUnderstanding.content.fileEvolution.some((item) => item.path === 'src/app.mjs'));
  assert.ok(agentUnderstanding.content.generatedArtifactLineage.some((item) => item.path === 'output/report.md'));
  const agentKnowledge = await agentEvidence.getProjectKnowledgeV4(generated.delivery.agent.root, { group: '全部', maxItems: 5000 });
  assert.equal(agentKnowledge.available, true);
  assert.equal(agentKnowledge.content.summary.sessions, 2);
  assert.ok(agentKnowledge.content.semanticStages.items.length >= 2);
  assert.ok(agentKnowledge.content.fileVersions.items.some((item) => item.path === 'src/app.mjs'));
  assert.ok(agentKnowledge.content.fileChangeMatrix.items.some((item) => item.path === 'src/app.mjs'));
  assert.ok(agentKnowledge.content.dependencyImpact.changedFiles.some((item) => item.path === 'src/helper.mjs'));
  assert.ok(agentKnowledge.content.artifactReproducibility.items.some((item) => item.path === 'output/report.md'));
  const verification = await verifyConversationPackageV2(generated.root);
  assert.equal(verification.ok, true, JSON.stringify(verification.failures));
});

test('compares project snapshots for incremental rereads', () => {
  const previous = { fingerprint: 'old', files: [{ path: 'src/a.mjs', sha256: 'aaa', bytes: 10 }, { path: 'src/removed.mjs', sha256: 'bbb', bytes: 20 }] };
  const current = { fingerprint: 'new', files: [{ path: 'src/a.mjs', sha256: 'ccc', bytes: 11 }, { path: 'src/added.mjs', sha256: 'ddd', bytes: 5 }] };
  const comparison = compareProjectSnapshots(previous, current);
  assert.equal(comparison.changed, true);
  assert.deepEqual(comparison.modified.map((item) => item.path), ['src/a.mjs']);
  assert.deepEqual(comparison.added, ['src/added.mjs']);
  assert.deepEqual(comparison.removed, ['src/removed.mjs']);
});

test('consolidates identical semantic stages while retaining every source trace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-semantic-stage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceOne = path.join(root, `rollout-${SESSION_ONE}.jsonl`);
  const sourceTwo = path.join(root, `rollout-${SESSION_TWO}.jsonl`);
  const request = '读取 src/app.mjs，理解项目规则后修改实现，并保留 Git 原始版本和差异。';
  await writeSession(sourceOne, SESSION_ONE, '项目证据修改', [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: request }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'functions.apply_patch', call_id: 'patch-duplicate', arguments: '*** Begin Patch\n*** Update File: src/app.mjs\n*** End Patch' } },
  ]);
  await writeSession(sourceTwo, SESSION_TWO, '项目证据复核', [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: request }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'functions.exec_command', call_id: 'verify-duplicate', arguments: JSON.stringify({ cmd: 'node --test' }) } },
  ]);
  const result = await packageConversationV2({
    sourcePaths: [sourceOne, sourceTwo],
    packageId: 'semantic-stage-fixture',
    outputRoot: path.join(root, 'packages'),
    redact: false,
  });
  const extraction = JSON.parse(await fs.readFile(path.join(result.package.root, 'conversation-extraction.json'), 'utf8'));
  const blueprint = JSON.parse(await fs.readFile(path.join(result.package.root, 'agent', 'ui', 'capability-ui.json'), 'utf8'));
  assert.equal(extraction.stages.length, 1);
  assert.deepEqual(extraction.stages[0].originalStageIndexes, [1, 2]);
  assert.equal(extraction.stages[0].mergedStageCount, 2);
  assert.equal(extraction.stages[0].toolCalls.length, 2);
  assert.deepEqual(blueprint.specializations[0].originalStageIndexes, [1, 2]);
  assert.match(blueprint.specializations[0].evidence, /已合并重复原始阶段/);
});

test('decodes escaped Chinese text and paths before building project knowledge', () => {
  const knowledge = buildProjectKnowledgeV4({
    extraction: {
      stages: [{
        index: 1,
        title: '读取 MKT\\u5927\\u5e08 项目',
        request: '理解 MKT\\u5927\\u5e08 的当前实现。',
        sourceSessions: [SESSION_ONE],
        fileChanges: [{ path: 'C:\\workspace\\MKT\\u5927\\u5e08\\src\\app.mjs', action: '读取' }],
        toolCalls: [],
        commands: [],
        messages: [],
        outcome: {},
      }],
      corrections: [],
    },
    sourceSet: {
      sessionCount: 1,
      sessions: [{ sessionId: SESSION_ONE, title: '中文路径会话', authorityRank: 1 }],
    },
  });
  assert.equal(knowledge.semanticStages[0].title, 'P1｜读取 MKT大师 项目');
  assert.equal(knowledge.semanticStages[0].purpose, '理解 MKT大师 的当前实现。');
  assert.deepEqual(knowledge.semanticStages[0].files, ['C:/workspace/MKT大师/src/app.mjs']);
});
