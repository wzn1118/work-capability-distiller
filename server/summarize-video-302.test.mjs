import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function runBridge(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/scripts/summarize_video_302.mjs', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('302 bridge fetches subtitles and normalizes a structured OpenAI-compatible completion', async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      language: request.headers.lang,
      body: raw,
    });
    if (request.method === 'GET' && request.url?.startsWith('/302/transcript?')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        success: true,
        detail: {
          contentText: 'Fixture subtitle text.',
          subtitlesArray: [{ index: 1, startTime: 0, end: 1.5, text: 'Fixture subtitle text.' }],
        },
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const completion = JSON.parse(raw);
      assert.equal(completion.model, 'fixture-302-model');
      assert.equal(completion.response_format.type, 'json_object');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: 'Structured fixture summary.',
              keypoints: ['Opening hook', 'Product demonstration'],
              mindmap: { label: 'Fixture video', children: [{ label: 'Demo', children: [] }] },
            }),
          },
        }],
      }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'not found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-302-bridge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputPath = path.join(root, 'input.json');
  const outputPath = path.join(root, 'output.json');
  await fs.writeFile(inputPath, JSON.stringify({
    sourceUrl: 'https://www.douyin.com/video/fixture?private=1',
    transcript: '',
    transcriptSegments: [],
    ocrText: 'Fixture OCR text.',
  }), 'utf8');

  const port = server.address().port;
  const result = await runBridge(['--input', inputPath, '--output', outputPath], {
    KOLFORGE_302_VIDEO_SUMMARY_API_URL: `http://127.0.0.1:${port}`,
    KOLFORGE_302_VIDEO_SUMMARY_API_KEY: 'fixture-302-key',
    KOLFORGE_302_VIDEO_SUMMARY_MODEL: 'fixture-302-model',
    KOLFORGE_302_VIDEO_SUMMARY_LANGUAGE: 'zh',
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'GET');
  assert.match(requests[0].path, /^\/302\/transcript\?url=/);
  assert.equal(requests[0].authorization, 'Bearer fixture-302-key');
  assert.equal(requests[0].language, 'zh');
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].authorization, 'Bearer fixture-302-key');

  const output = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  assert.equal(output.provider, '302_video_summary');
  assert.equal(output.sourceUrl, 'https://www.douyin.com/video/fixture');
  assert.equal(output.transcript.text, 'Fixture subtitle text.');
  assert.deepEqual(output.transcript.segments, [{
    index: 1,
    startSeconds: 0,
    endSeconds: 1.5,
    text: 'Fixture subtitle text.',
  }]);
  assert.equal(output.summary, 'Structured fixture summary.');
  assert.deepEqual(output.keypoints, ['Opening hook', 'Product demonstration']);
  assert.deepEqual(output.mindmap, {
    label: 'Fixture video',
    children: [{ label: 'Demo', children: [] }],
  });
  assert.equal(output.metadata.transcriptProvider, '302_transcript_api');
});
