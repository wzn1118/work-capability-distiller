import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireExternalVideoEvidence,
  enrichExternalVideoEvidence,
  normalizeExternalSummary,
  normalizeExternalTranscript,
} from './tool-adapters.mjs';

async function writeScript(filePath, lines) {
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

test('external transcript and summary normalizers retain bounded structured content', () => {
  const transcript = normalizeExternalTranscript({
    sentences: [{ start: 0, end: 1.25, text: '  First observed sentence. ' }],
  });
  const summary = normalizeExternalSummary({
    overview: 'Structured external overview.',
    highlights: ['Opening hook', 'Product demonstration'],
    outline: { name: 'Video', nodes: [{ title: 'Demo', nodes: [] }] },
  });

  assert.equal(transcript.text, 'First observed sentence.');
  assert.deepEqual(transcript.segments, [{
    index: 1,
    startSeconds: 0,
    endSeconds: 1.25,
    text: 'First observed sentence.',
  }]);
  assert.equal(summary.summary, 'Structured external overview.');
  assert.deepEqual(summary.keypoints, ['Opening hook', 'Product demonstration']);
  assert.deepEqual(summary.mindmap, { label: 'Video', children: [{ label: 'Demo', children: [] }] });
});

test('external adapters normalize downloader, Bilibili, and summary bridge output', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-tool-adapters-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vbdScript = path.join(root, 'video-batch-download-fixture.mjs');
  const bilicliScript = path.join(root, 'bilicli-fixture.mjs');
  const vcaScript = path.join(root, 'video-copy-analyzer-fixture.mjs');
  const summaryScript = path.join(root, 'summary-fixture.mjs');

  await writeScript(vbdScript, [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "const inputPath = args[args.indexOf('--input') + 1];",
    "const output = args[args.indexOf('--output') + 1];",
    "const source = (await fs.readFile(inputPath, 'utf8')).trim();",
    "if (source !== 'https://v26-web.douyinvod.com/video/tos/cn/fixture/?token=keep-me&mime_type=video_mp4') process.exit(17);",
    "await fs.mkdir(path.join(output, 'items'), { recursive: true });",
    "await fs.writeFile(path.join(output, 'items', 'clip.mp4'), 'fixture media', 'utf8');",
    "await fs.writeFile(path.join(output, 'items', 'item.json'), JSON.stringify({ video_file: 'items/clip.mp4', transcript: { segments: [{ start: 0, end: 2, text: 'fixture transcript' }] } }), 'utf8');",
    "await fs.writeFile(path.join(output, 'download-summary.json'), JSON.stringify({ results: [{ canonical_url: source, jsonPath: 'items/item.json' }] }), 'utf8');",
  ]);
  await writeScript(bilicliScript, [
    "console.log(JSON.stringify({ asr: { text: 'Bili transcript', segments: [{ start: 0, end: 2, text: 'Bili transcript' }] }, comments: { summary: 'Observed public comments' }, danmaku: { summary: 'Observed public danmaku' }, ocr: { text: 'Observed OCR' } }));",
  ]);
  await writeScript(vcaScript, [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "const [mediaPath, output] = process.argv.slice(2);",
    "if (!mediaPath || !output || !(await fs.stat(mediaPath)).isFile()) process.exit(17);",
    "await fs.mkdir(output, { recursive: true });",
    "await fs.writeFile(path.join(output, 'fixture.srt'), '1\\n00:00:00,000 --> 00:00:02,000\\nLocal media transcript\\n', 'utf8');",
  ]);
  await writeScript(summaryScript, [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "const inputPath = args[args.indexOf('--input') + 1];",
    "const outputPath = args[args.indexOf('--output') + 1];",
    "const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));",
    "if (input.sourceUrl !== 'https://www.bilibili.com/video/BV1fixture') process.exit(17);",
    "await fs.mkdir(path.dirname(outputPath), { recursive: true });",
    "await fs.writeFile(outputPath, JSON.stringify({ summary: 'Bridge summary', keypoints: ['Hook', 'Demo'], mindmap: { label: 'Video', children: [{ label: 'Demo', children: [] }] } }), 'utf8');",
  ]);

  const download = await acquireExternalVideoEvidence({
    platform: 'douyin',
    sourceUrl: 'https://www.douyin.com/video/fixture?token=private',
    mediaUrl: 'https://v26-web.douyinvod.com/video/tos/cn/fixture/?token=keep-me&mime_type=video_mp4',
    // The sidecar has its own cwd, so relative job paths must be made
    // absolute before we pass input/output files to that subprocess.
    videoDirectory: path.relative(process.cwd(), path.join(root, 'video', 'sample-01')),
    artifactRootDirectory: root,
    toolchain: {
      videoBatchDownload: {
        enabled: true,
        command: process.execPath,
        args: [vbdScript],
        cwd: root,
        timeoutMs: 10_000,
      },
    },
  });

  assert.equal(download.providers[0].status, 'completed');
  assert.equal(download.transcript.provider, 'video_batch_download');
  assert.equal(download.transcript.text, 'fixture transcript');
  assert.equal(await fs.stat(download.mediaPath).then((stat) => stat.isFile()), true);

  const localMediaPath = path.join(root, 'fixture.mp4');
  await fs.writeFile(localMediaPath, 'fixture media', 'utf8');
  const vca = await enrichExternalVideoEvidence({
    sourceUrl: 'https://www.bilibili.com/video/BV1fixture',
    mediaPath: path.relative(process.cwd(), localMediaPath),
    transcript: null,
    ocrText: '',
    videoDirectory: path.relative(process.cwd(), path.join(root, 'video', 'sample-vca')),
    artifactRootDirectory: root,
    toolchain: {
      videoCopyAnalyzer: {
        enabled: true,
        command: process.execPath,
        args: [vcaScript],
        cwd: root,
        timeoutMs: 10_000,
      },
    },
  });

  assert.equal(vca.providers[0].provider, 'video_copy_analyzer');
  assert.equal(vca.providers[0].status, 'completed');
  assert.equal(vca.transcript.text, 'Local media transcript');

  const bilicli = await acquireExternalVideoEvidence({
    platform: 'bilibili',
    sourceUrl: 'https://www.bilibili.com/video/BV1fixture?private=1',
    videoDirectory: path.join(root, 'video', 'sample-02'),
    artifactRootDirectory: root,
    includeVideoBatchDownload: false,
    toolchain: {
      bilicli: {
        enabled: true,
        command: process.execPath,
        args: [bilicliScript],
        cwd: root,
        timeoutMs: 10_000,
      },
    },
  });

  assert.equal(bilicli.providers[0].provider, 'bilicli');
  assert.equal(bilicli.providers[0].status, 'completed');
  assert.equal(bilicli.transcript.text, 'Bili transcript');
  assert.equal(bilicli.providers[0].signals.comments, 'Observed public comments');

  const enhancement = await enrichExternalVideoEvidence({
    sourceUrl: 'https://www.bilibili.com/video/BV1fixture?private=1',
    mediaPath: '',
    transcript: bilicli.transcript,
    ocrText: 'Observed OCR',
    videoDirectory: path.join(root, 'video', 'sample-02'),
    artifactRootDirectory: root,
    toolchain: {
      videoSummary: {
        enabled: true,
        command: process.execPath,
        args: [summaryScript],
        cwd: root,
        timeoutMs: 10_000,
      },
    },
  });

  assert.equal(enhancement.providers[0].provider, 'video_summary_bridge');
  assert.equal(enhancement.providers[0].status, 'completed');
  assert.equal(enhancement.summary.summary, 'Bridge summary');
  assert.deepEqual(enhancement.summary.keypoints, ['Hook', 'Demo']);
});

test('302 summary provider receives injected credentials and supplies subtitle evidence before local fallback', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-302-adapter-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bridgeScript = path.join(root, '302-summary-fixture.mjs');
  const localFallbackScript = path.join(root, 'local-summary-fixture.mjs');
  await writeScript(bridgeScript, [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "if (process.env.KOLFORGE_302_VIDEO_SUMMARY_API_KEY !== 'fixture-key') process.exit(19);",
    "if (process.env.KOLFORGE_302_VIDEO_SUMMARY_API_URL !== 'http://127.0.0.1:45678') process.exit(20);",
    "const args = process.argv.slice(2);",
    "const input = JSON.parse(await fs.readFile(args[args.indexOf('--input') + 1], 'utf8'));",
    "if (input.sourceUrl !== 'https://www.xiaohongshu.com/explore/fixture') process.exit(21);",
    "const outputPath = args[args.indexOf('--output') + 1];",
    "await fs.mkdir(path.dirname(outputPath), { recursive: true });",
    "await fs.writeFile(outputPath, JSON.stringify({ summary: '302 fixture summary', keypoints: ['Fixture point'], mindmap: { label: 'Fixture', children: [] }, transcript: { text: '302 subtitle evidence', segments: [{ startTime: 0, end: 1, text: '302 subtitle evidence' }] } }), 'utf8');",
  ]);
  await writeScript(localFallbackScript, ['process.exit(22);']);

  const enhancement = await enrichExternalVideoEvidence({
    sourceUrl: 'https://www.xiaohongshu.com/explore/fixture?private=1',
    mediaPath: '',
    transcript: null,
    ocrText: '',
    videoDirectory: path.join(root, 'video', 'sample'),
    artifactRootDirectory: root,
    toolchain: {
      videoSummary302: {
        enabled: true,
        command: process.execPath,
        args: [bridgeScript],
        cwd: root,
        timeoutMs: 10_000,
        env: {
          KOLFORGE_302_VIDEO_SUMMARY_API_KEY: 'fixture-key',
          KOLFORGE_302_VIDEO_SUMMARY_API_URL: 'http://127.0.0.1:45678',
        },
      },
      videoSummary: {
        enabled: true,
        command: process.execPath,
        args: [localFallbackScript],
        cwd: root,
        timeoutMs: 10_000,
      },
    },
  });

  assert.equal(enhancement.providers.length, 1);
  assert.equal(enhancement.providers[0].provider, '302_video_summary');
  assert.equal(enhancement.providers[0].status, 'completed');
  assert.equal(enhancement.summary.provider, '302_video_summary');
  assert.equal(enhancement.summary.summary, '302 fixture summary');
  assert.equal(enhancement.transcript.provider, '302_video_summary');
  assert.equal(enhancement.transcript.text, '302 subtitle evidence');
});
