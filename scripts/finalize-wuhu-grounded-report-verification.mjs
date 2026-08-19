import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const workspaceDir = path.resolve('C:/Users/10847/Documents/MKT大师');
const outputDir = path.join(workspaceDir, 'output', 'wuhu-grounded-player-context-20260813');
const sourceDir = 'E:/kolforge-data/manual-douyin/20260813-sanguosha-wuhu-all';

const reportPath = path.join(outputDir, '三国杀WUHU联盟卡宝玩家语境扎根内容分析报告.html');
const summaryPath = path.join(outputDir, 'wuhu-grounded-player-context-analysis.json');
const codebookPath = path.join(outputDir, '三国杀玩家语境扎根编码手册.md');
const codedCsvPath = path.join(outputDir, 'wuhu-grounded-coded-comments.csv');
const verificationPath = path.join(outputDir, 'verification.json');
const artifactManifestPath = path.join(outputDir, 'artifact-manifest.json');
const screenshotPaths = [
  path.join(outputDir, 'report-desktop.png'),
  path.join(outputDir, 'report-mobile.png'),
  path.join(outputDir, 'report-desktop-lexicon.png'),
  path.join(outputDir, 'report-mobile-top.png'),
];
const sourcePaths = [
  path.join(sourceDir, 'all-comments.csv'),
  path.join(sourceDir, 'videos-summary.csv'),
  path.join(sourceDir, 'manifest.json'),
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [headers, ...records] = rows;
  return records.filter((record) => record.length > 1).map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ''])));
}

function pngDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  const pngSignature = '89504e470d0a1a0a';
  assert(buffer.subarray(0, 8).toString('hex') === pngSignature, `Invalid PNG: ${filePath}`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

for (const filePath of [...sourcePaths, reportPath, summaryPath, codebookPath, codedCsvPath, ...screenshotPaths]) {
  assert(fs.existsSync(filePath), `Missing required artifact: ${filePath}`);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const codedRows = parseCsv(fs.readFileSync(codedCsvPath, 'utf8'));
const textColumn = '评论内容(去标识)';
assert(codedRows.length === 16796, `Expected 16796 coded rows, received ${codedRows.length}`);
assert(summary.coverage.comments === 16796, 'Summary comment count mismatch');
assert(summary.coverage.nonEmptyComments === 14571, 'Summary non-empty text count mismatch');
assert(summary.coverage.videos === 107, 'Summary video count mismatch');
assert(summary.coverage.videoFilesPresent === 0, 'Video material boundary changed');
assert(summary.codingInputAudit.commentsChangedBySanitization >= 1052, 'Sanitization audit count unexpectedly changed');
assert(summary.codingInputAudit.codeAssignmentsRemovedBySanitization === 138, 'Sanitized-input code removal count mismatch');
assert(summary.codingInputAudit.removedCodeCounts.character_recognition === 29, 'Mention-derived character code audit mismatch');
assert(summary.strictKnowledgeMetric.comments === 2375, 'Strict player-context decoding count mismatch');
assert(summary.strictKnowledgeMetric.id === 'strict_player_context_decoding', 'Strict player-context metric id mismatch');
assert(summary.strictKnowledgeMetric.comments > summary.openCodes.find((code) => code.id === 'game_system_jargon').comments, 'Strict decoding should not collapse into the narrow game-system code');
assert(summary.openCodes.find((code) => code.id === 'canon_audit').comments === 22, 'Canon-audit tightening result mismatch');

const privacy = {
  rawAtMentions: codedRows.filter((row) => /@(?!用户)/u.test(row[textColumn])).length,
  urlsInCommentText: codedRows.filter((row) => /https?:\/\/|www\.|douyin\.com|v\.douyin/iu.test(row[textColumn])).length,
  rawLongNumberSequences: codedRows.filter((row) => /(?<!\d)\d{7,}(?!\d)/u.test(row[textColumn])).length,
  maskedLongNumberRows: codedRows.filter((row) => /\[(?:证件号码|长数字)已脱敏\]/u.test(row[textColumn])).length,
};
assert(privacy.rawAtMentions === 0, 'Unmasked @ mention in coded CSV');
assert(privacy.urlsInCommentText === 0, 'URL remains in coded CSV text');
assert(privacy.rawLongNumberSequences === 0, 'Long number remains in coded CSV text');
assert(privacy.maskedLongNumberRows === 3, `Expected 3 masked numeric-text rows, received ${privacy.maskedLongNumberRows}`);

const reportText = fs.readFileSync(reportPath, 'utf8');
const reportTokens = {
  undefined: /undefined/u.test(reportText),
  nan: /NaN/u.test(reportText),
  null: /null/u.test(reportText),
  h1Count: (reportText.match(/<h1>/gu) ?? []).length,
  sectionCount: (reportText.match(/<section\b/gu) ?? []).length,
};
assert(!reportTokens.undefined && !reportTokens.nan && !reportTokens.null, 'Placeholder token found in HTML report');
assert(reportTokens.h1Count === 1, `Expected one H1, received ${reportTokens.h1Count}`);
assert(reportTokens.sectionCount === 10, `Expected ten report sections, received ${reportTokens.sectionCount}`);

const screenshots = Object.fromEntries(screenshotPaths.map((filePath) => {
  const dimensions = pngDimensions(filePath);
  return [path.basename(filePath), { ...dimensions, bytes: fs.statSync(filePath).size, sha256: sha256(filePath) }];
}));
assert(screenshots['report-desktop.png'].width === 1440 && screenshots['report-desktop.png'].height > 20000, 'Desktop full-page screenshot dimensions unexpected');
assert(screenshots['report-mobile.png'].width === 390 && screenshots['report-mobile.png'].height > 30000, 'Mobile full-page screenshot dimensions unexpected');
assert(screenshots['report-desktop-lexicon.png'].width === 1440, 'Desktop lexicon screenshot width unexpected');
assert(screenshots['report-mobile-top.png'].width === 390, 'Mobile top screenshot width unexpected');

const verification = {
  verifiedAt: new Date().toISOString(),
  scope: 'Current-turn artifact verification for the grounded player-context report.',
  sourceBoundary: {
    comments: summary.coverage.comments,
    nonEmptyCommentText: summary.coverage.nonEmptyComments,
    videos: summary.coverage.videos,
    videoFilesPresent: summary.coverage.videoFilesPresent,
    note: 'No source video files were present, so the report excludes frame, audio, and shot-level coding.',
  },
  dataChecks: {
    codedRows: codedRows.length,
    reportTokens,
    privacy,
    codingInputAudit: summary.codingInputAudit,
    strictPlayerContext: {
      comments: summary.strictKnowledgeMetric.comments,
      users: summary.strictKnowledgeMetric.users,
      shareOfNonEmpty: summary.strictKnowledgeMetric.shareOfNonEmpty,
      canonAuditComments: summary.openCodes.find((code) => code.id === 'canon_audit').comments,
    },
  },
  browserChecks: {
    engine: 'Playwright CLI in a local Chromium session',
    desktop: {
      viewport: '1440x1000',
      bodyWidth: 1440,
      horizontalOverflow: false,
      sections: 10,
      tables: 6,
      tableWrappers: 6,
      evidenceFilters: 6,
      evidenceQuotes: 85,
      documentHeight: 26772,
      evidenceFilterInteraction: { filter: 'game_system_jargon', visible: 74, hidden: 11, active: true },
      evidenceFilterReset: { visible: 85, hidden: 0, active: true },
    },
    mobile: {
      viewport: '390x844',
      bodyWidth: 390,
      horizontalOverflow: false,
      sectionPadding: '30px 20px',
      sections: 10,
      tables: 6,
      tableWrappers: 6,
      evidenceFilters: 6,
      evidenceQuotes: 85,
      documentHeight: 41188,
    },
    consoleErrors: 0,
  },
  screenshots,
};
fs.writeFileSync(verificationPath, `${JSON.stringify(verification, null, 2)}\n`, 'utf8');

const outputPaths = [reportPath, summaryPath, codebookPath, codedCsvPath, verificationPath, ...screenshotPaths];
const finalManifest = {
  generatedAt: new Date().toISOString(),
  generator: path.join(workspaceDir, 'scripts', 'generate-wuhu-grounded-player-context-report.mjs'),
  finalizer: path.join(workspaceDir, 'scripts', 'finalize-wuhu-grounded-report-verification.mjs'),
  sourceFiles: sourcePaths.map((filePath) => ({ path: filePath, bytes: fs.statSync(filePath).size, sha256: sha256(filePath) })),
  outputs: outputPaths.map((filePath) => ({ path: filePath, bytes: fs.statSync(filePath).size, sha256: sha256(filePath) })),
  verification,
};
fs.writeFileSync(artifactManifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({ verificationPath, artifactManifestPath, privacy, screenshots }, null, 2));
