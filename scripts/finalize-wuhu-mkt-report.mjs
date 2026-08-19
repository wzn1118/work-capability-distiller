import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\Users\\10847\\Documents\\MKT大师';
const OUT = path.join(ROOT, 'output', 'wuhu-mkt-audience-analysis-20260814');
const files = {
  analysis: path.join(OUT, 'wuhu-mkt-audience-analysis.json'),
  audience: path.join(OUT, 'wuhu-mkt-pseudonymous-audience-segments.csv'),
  html: path.join(OUT, '三国杀WUHU联盟卡宝粉丝与受众MKT全量洞察报告.html'),
  methods: path.join(OUT, 'MKT指标口径与复算说明.md'),
  browser: path.join(OUT, 'browser-verification.json'),
  desktop: path.join(OUT, 'verification-desktop.png'),
  mobile: path.join(OUT, 'verification-mobile.png'),
  compact: path.join(OUT, 'verification-compact.png'),
  verification: path.join(OUT, 'verification.json'),
  manifest: path.join(OUT, 'artifact-manifest.json'),
};

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fileInfo(file, role) {
  const stat = fs.statSync(file);
  return { role, file, bytes: stat.size, sha256: sha256(file) };
}

function parseCsvLine(line) {
  const result = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      result.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  result.push(value);
  return result;
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

const data = JSON.parse(fs.readFileSync(files.analysis, 'utf8'));
const browser = JSON.parse(fs.readFileSync(files.browser, 'utf8'));
const html = fs.readFileSync(files.html, 'utf8');
const methods = fs.readFileSync(files.methods, 'utf8');
const csvText = fs.readFileSync(files.audience, 'utf8').replace(/^\uFEFF/, '');
const csvLines = csvText.trimEnd().split(/\r?\n/);
const header = parseCsvLine(csvLines[0]);
const rows = csvLines.slice(1).map(parseCsvLine);
const expectedHeader = [
  '匿名受众ID', '活跃层', '评论数', '有文本评论数', '评论视频数', '活跃天数', '活跃跨度天',
  '根评论数', '有文本根评论数', '回复数', '二级及以上回复数', '作者回复根评数', '跨视频复访代理',
  '观察7日回访', '观察30日回访', '卡宝人格', '角色IP', '表字昵称', '萌化情感', '关系共创',
  '严格玩家语境', '奖励仪式', '纯to签', '周边兴趣', '严格购买意向', '评论获赞',
];
const forbiddenIdentityHeaders = new Set([
  '评论用户', '评论用户URL', '用户昵称', '用户主页', '评论正文', '原始文本', '手机号', '邮箱',
]);
const tierUsers = data.audienceAsset.activityTiers.reduce((sum, item) => sum + item.users, 0);
const tierComments = data.audienceAsset.activityTiers.reduce((sum, item) => sum + item.comments, 0);
const ids = rows.map((row) => row[0]);
const nonIdCells = rows.flatMap((row) => row.slice(1));
const sourceHashChecks = data.integrity.sourceHashes.map((item) => ({
  file: item.file,
  expectedBytes: item.bytes,
  actualBytes: fs.statSync(item.file).size,
  expectedSha256: item.sha256,
  actualSha256: sha256(item.file),
  passed: fs.statSync(item.file).size === item.bytes && sha256(item.file) === item.sha256,
}));

const checks = [
  ['source_hashes_match_analysis_snapshot', sourceHashChecks.every((item) => item.passed)],
  ['comment_join_is_complete', data.integrity.rawComments === 16796 && data.integrity.rawComments === data.integrity.codedComments && data.integrity.rawComments === data.integrity.joinedComments && data.integrity.missingCoded === 0 && data.integrity.extraCoded === 0],
  ['coverage_totals_reconcile', data.coverage.capturedComments === data.coverage.audienceComments + data.coverage.authorComments && data.coverage.capturedComments === 16796 && data.coverage.declaredComments === 17021],
  ['video_and_metadata_counts_reconcile', data.integrity.videos === 107 && data.integrity.metadataRecords === 107 && data.integrity.invalidMetadataFiles === 0],
  ['audience_tiers_reconcile', tierUsers === data.coverage.audienceUsers && tierComments === data.coverage.audienceComments],
  ['purchase_path_reconciles', data.commerce.purchasePath.firstTouch + data.commerce.purchasePath.nurtured === data.commerce.purchaseUsers && data.commerce.purchaseUsers === 153 && data.commerce.purchaseComments === 169],
  ['purchase_signals_are_explicitly_non_nested', data.commerce.purchaseMerchandiseOverlapUsers === 146 && data.commerce.purchaseOutsideMerchandiseUsers === 7 && data.commerce.purchaseMerchandiseOverlapUsers + data.commerce.purchaseOutsideMerchandiseUsers === data.commerce.purchaseUsers],
  ['strict_context_is_audience_only', data.groundedEvidence.audienceStrictKnowledgeMetric.comments === 2306 && data.groundedEvidence.audienceStrictKnowledgeMetric.users === 1262 && Math.abs(data.groundedEvidence.audienceStrictKnowledgeMetric.shareOfAudienceText - (2306 / 13320)) < 1e-12],
  ['role_demand_excludes_tosign', data.roleMarket.definitions.spontaneousDemand.includes('排除to签奖励仪式') && data.roleMarket.dictionaryCharacters === 47],
  ['audience_csv_header_is_exact', JSON.stringify(header) === JSON.stringify(expectedHeader)],
  ['audience_csv_rows_match_users', rows.length === data.coverage.audienceUsers],
  ['audience_csv_column_counts_are_valid', rows.every((row) => row.length === header.length)],
  ['audience_ids_are_pseudonymous', ids.every((id) => /^aud_[0-9a-f]{16}$/.test(id)) && new Set(ids).size === ids.length],
  ['audience_csv_has_no_identity_columns', !header.some((name) => forbiddenIdentityHeaders.has(name))],
  ['audience_csv_has_no_contact_strings', !nonIdCells.some((value) => /https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?86[- ]?)?1[3-9]\d{9}/i.test(value))],
  ['browser_verification_passed', browser.passed === true && browser.viewports.length === 3 && browser.viewports.every((item) => item.passed)],
  ['screenshots_exist', fs.statSync(files.desktop).size > 10000 && fs.statSync(files.mobile).size > 10000 && fs.statSync(files.compact).size > 10000],
  ['html_has_expected_structure', countMatches(html, /<section\b[^>]*\bid=/g) === 9 && countMatches(html, /<table\b/g) === 6 && countMatches(html, /<svg\b/g) === 2],
  ['html_is_offline', !/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/i.test(html)],
  ['html_has_no_runtime_placeholders', !/\b(?:undefined|NaN|Infinity)\b|�|锟斤拷/.test(html)],
  ['html_contains_mkt_decisions', ['粉丝画像', '行为部落', '角色供给', '商业信号', '12条视频'].every((term) => html.includes(term))],
  ['html_labels_observations_without_causal_overclaim', !['驱动获客', '增长引擎', '显著高于', '显著低于', '购买意向提升'].some((term) => html.includes(term))],
  ['html_shows_non_nested_commerce_signals', html.includes('不是连续转化漏斗') && html.includes('146') && html.includes('另有 7 位')],
  ['html_shows_complete_month_series', countMatches(html, /class="return-cell/g) === 8 && html.includes('2—3月无观察评论')],
  ['methods_hashes_match', methods.includes(sha256(files.analysis)) && methods.includes(sha256(files.audience))],
];

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name);
const verification = {
  generatedAt: new Date().toISOString(),
  reportType: data.reportType,
  status: failed.length === 0 ? 'passed' : 'failed',
  checks: Object.fromEntries(checks),
  failed,
  sourceHashChecks,
  browserSummary: browser.viewports.map((item) => ({
    viewport: item.viewport,
    documentWidth: item.measurements.documentWidth,
    documentHeight: item.measurements.documentHeight,
    horizontalOverflow: item.measurements.bodyHorizontalOverflow,
    consoleErrors: item.consoleErrors.length,
    pageErrors: item.pageErrors.length,
    passed: item.passed,
  })),
  privacySummary: {
    rows: rows.length,
    columns: header.length,
    uniquePseudonymousIds: new Set(ids).size,
    identityColumns: header.filter((name) => forbiddenIdentityHeaders.has(name)),
  },
};
fs.writeFileSync(files.verification, JSON.stringify(verification, null, 2), 'utf8');

const artifacts = [
  fileInfo(files.html, 'default_report'),
  fileInfo(files.methods, 'metric_definitions'),
  fileInfo(files.analysis, 'reproducible_analysis_layer'),
  fileInfo(files.audience, 'pseudonymous_audience_segments'),
  fileInfo(files.browser, 'browser_test_results'),
  fileInfo(files.desktop, 'desktop_render_evidence'),
  fileInfo(files.mobile, 'mobile_render_evidence'),
  fileInfo(files.compact, 'compact_320px_render_evidence'),
  fileInfo(files.verification, 'delivery_verification'),
  fileInfo(path.join(ROOT, 'scripts', 'analyze-wuhu-mkt-audience.mjs'), 'analysis_source'),
  fileInfo(path.join(ROOT, 'scripts', 'generate-wuhu-mkt-audience-report.mjs'), 'report_generator_source'),
  fileInfo(path.join(ROOT, 'scripts', 'verify-wuhu-mkt-report.py'), 'browser_verifier_source'),
  fileInfo(path.join(ROOT, 'scripts', 'finalize-wuhu-mkt-report.mjs'), 'delivery_verifier_source'),
];
const manifest = {
  generatedAt: new Date().toISOString(),
  defaultArtifact: files.html,
  sources: data.integrity.sourceHashes,
  artifacts,
  verificationStatus: verification.status,
};
fs.writeFileSync(files.manifest, JSON.stringify(manifest, null, 2), 'utf8');

console.log(JSON.stringify({
  verification: files.verification,
  manifest: files.manifest,
  status: verification.status,
  checks: checks.length,
  failed,
  artifacts: artifacts.length,
}, null, 2));
if (failed.length) process.exitCode = 1;
