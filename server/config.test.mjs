import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

function readConfigured302Adapter(env) {
  const configUrl = pathToFileURL(path.join(process.cwd(), 'server', 'config.mjs')).href;
  const script = [
    `import { config } from ${JSON.stringify(configUrl)};`,
    'const adapter = config.analysis.video.toolchain.videoSummary302;',
    'console.log(JSON.stringify({',
    '  enabled: adapter.enabled,',
    '  command: adapter.command,',
    '  args: adapter.args,',
    '  missingConfiguration: adapter.missingConfiguration,',
    '  apiUrl: adapter.env.KOLFORGE_302_VIDEO_SUMMARY_API_URL,',
    '  hasApiKey: Boolean(adapter.env.KOLFORGE_302_VIDEO_SUMMARY_API_KEY),',
    '  model: adapter.env.KOLFORGE_302_VIDEO_SUMMARY_MODEL,',
    '  collection: {',
    '    maxDiscoveryCandidatesPerChannel: config.collection.maxDiscoveryCandidatesPerChannel,',
    '    maxDiscoveryQueryVariants: config.collection.maxDiscoveryQueryVariants,',
    '    browserRelayCollectionTimeoutMs: config.collection.browserRelayCollectionTimeoutMs,',
    '    maxContentSamplesPerCreator: config.collection.maxContentSamplesPerCreator,',
    '    defaultContentSamplesPerCreator: config.collection.defaultContentSamplesPerCreator,',
    '    contentCollectionConcurrency: config.collection.contentCollectionConcurrency,',
    '    randomIntervalMinMs: config.collection.randomIntervalMinMs,',
    '    randomIntervalMaxMs: config.collection.randomIntervalMaxMs,',
    '  },',
    '  video: {',
    '    concurrency: config.analysis.video.concurrency,',
    '    creatorConcurrency: config.analysis.video.creatorConcurrency,',
    '    browserRecordingFallback: config.analysis.video.browserRecordingFallback,',
    '  },',
    '  contentAnalysis: {',
    '    orchestration: config.analysis.content.orchestration,',
    '    remoteConcurrency: config.analysis.content.remoteConcurrency,',
    '    requestConcurrency: config.analysis.content.requestConcurrency,',
    '  },',
    '  relay: {',
    '    preflightCacheMs: config.relay.preflightCacheMs,',
    '  },',
    '  douyinSearchUrlTemplate: config.platforms.douyin.searchUrlTemplate,',
    '  douyinRelayPort: config.platforms.douyin.relayPort,',
    '  douyinMessageRelayPort: config.outreach.douyin.relayPort,',
    '}));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
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
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Config probe exited with ${code}.`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

test('302 summary adapter injects parsed runtime settings into its child environment', async () => {
  const adapter = await readConfigured302Adapter({
    KOLFORGE_302_VIDEO_SUMMARY_ENABLED: 'true',
    KOLFORGE_302_VIDEO_SUMMARY_API_KEY: 'fixture-302-key',
    KOLFORGE_302_VIDEO_SUMMARY_API_URL: 'http://127.0.0.1:45678',
    KOLFORGE_302_VIDEO_SUMMARY_MODEL: 'fixture-model',
  });

  assert.equal(adapter.enabled, true);
  assert.equal(adapter.hasApiKey, true);
  assert.equal(adapter.apiUrl, 'http://127.0.0.1:45678');
  assert.equal(adapter.model, 'fixture-model');
  assert.equal(adapter.missingConfiguration.length, 0);
  assert.match(adapter.command, /node(?:\.exe)?$/i);
  assert.equal(adapter.args.length, 1);
  assert.match(adapter.args[0], /summarize_video_302\.mjs$/i);
});

test('302 summary adapter remains disabled with an explicit missing credential', async () => {
  const adapter = await readConfigured302Adapter({
    KOLFORGE_302_VIDEO_SUMMARY_ENABLED: 'true',
    KOLFORGE_302_VIDEO_SUMMARY_API_KEY: '',
  });

  assert.equal(adapter.enabled, false);
  assert.deepEqual(adapter.missingConfiguration, ['api_key']);
});

test('collection capacity defaults to a 15000-candidate discovery batch and a bounded route plan', async () => {
  const defaults = await readConfigured302Adapter({
    KOLFORGE_MAX_CONTENT_SAMPLES_PER_CREATOR: '',
    KOLFORGE_DEFAULT_CONTENT_SAMPLES_PER_CREATOR: '',
  });
  const adapter = await readConfigured302Adapter({
    KOLFORGE_MAX_DISCOVERY_PER_CHANNEL: '10000',
    KOLFORGE_DISCOVERY_QUERY_VARIANTS: '10',
    KOLFORGE_BROWSER_RELAY_COLLECTION_TIMEOUT_MS: '1800000',
    KOLFORGE_MAX_CONTENT_SAMPLES_PER_CREATOR: '1000',
    KOLFORGE_DEFAULT_CONTENT_SAMPLES_PER_CREATOR: '1000',
    KOLFORGE_COLLECTION_RANDOM_INTERVAL_MIN_MS: '1200',
    KOLFORGE_COLLECTION_RANDOM_INTERVAL_MAX_MS: '5000',
  });

  assert.equal(defaults.collection.maxContentSamplesPerCreator, 10000);
  assert.equal(defaults.collection.defaultContentSamplesPerCreator, 10000);
  assert.equal(defaults.douyinSearchUrlTemplate, 'https://www.douyin.com/search/{query}?type=user');
  assert.equal(defaults.collection.maxDiscoveryCandidatesPerChannel, 15000);
  assert.equal(defaults.collection.maxDiscoveryQueryVariants, 16);
  assert.equal(defaults.collection.browserRelayCollectionTimeoutMs, 1800000);
  assert.equal(defaults.collection.randomIntervalMinMs, 0);
  assert.equal(defaults.collection.randomIntervalMaxMs, 0);
  assert.equal(adapter.collection.maxDiscoveryCandidatesPerChannel, 10000);
  assert.equal(adapter.collection.maxDiscoveryQueryVariants, 10);
  assert.equal(adapter.collection.browserRelayCollectionTimeoutMs, 1800000);
  assert.equal(adapter.collection.maxContentSamplesPerCreator, 1000);
  assert.equal(adapter.collection.defaultContentSamplesPerCreator, 1000);
  assert.equal(adapter.collection.randomIntervalMinMs, 1200);
  assert.equal(adapter.collection.randomIntervalMaxMs, 5000);
});

test('Douyin Relay stays fixed at 18801 even when environment ports are overridden', async () => {
  const configured = await readConfigured302Adapter({
    BROWSER_RELAY_PORT: '17777',
    DOUYIN_RELAY_PORT: '19999',
    DOUYIN_MESSAGE_RELAY_PORT: '19998',
  });

  assert.equal(configured.douyinRelayPort, 18801);
  assert.equal(configured.douyinMessageRelayPort, 18801);
});

test('random collection interval configuration is ordered and capped at ten minutes', async () => {
  const configured = await readConfigured302Adapter({
    KOLFORGE_COLLECTION_RANDOM_INTERVAL_MIN_MS: '900000',
    KOLFORGE_COLLECTION_RANDOM_INTERVAL_MAX_MS: '1000',
  });

  assert.equal(configured.collection.randomIntervalMinMs, 1000);
  assert.equal(configured.collection.randomIntervalMaxMs, 600000);
});

test('collection capacity clamps visible content sample limits to 1..10000', async () => {
  const lowerBound = await readConfigured302Adapter({
    KOLFORGE_MAX_CONTENT_SAMPLES_PER_CREATOR: '0',
    KOLFORGE_DEFAULT_CONTENT_SAMPLES_PER_CREATOR: '0',
  });
  const upperBound = await readConfigured302Adapter({
    KOLFORGE_MAX_CONTENT_SAMPLES_PER_CREATOR: '10001',
    KOLFORGE_DEFAULT_CONTENT_SAMPLES_PER_CREATOR: '10001',
  });

  assert.equal(lowerBound.collection.maxContentSamplesPerCreator, 1);
  assert.equal(lowerBound.collection.defaultContentSamplesPerCreator, 1);
  assert.equal(upperBound.collection.maxContentSamplesPerCreator, 10000);
  assert.equal(upperBound.collection.defaultContentSamplesPerCreator, 10000);
});

test('content collection uses two bounded creator workers by default', async () => {
  const defaults = await readConfigured302Adapter({
    KOLFORGE_CONTENT_COLLECTION_CONCURRENCY: '',
  });
  const lowerBound = await readConfigured302Adapter({
    KOLFORGE_CONTENT_COLLECTION_CONCURRENCY: '0',
  });
  const upperBound = await readConfigured302Adapter({
    KOLFORGE_CONTENT_COLLECTION_CONCURRENCY: '9',
  });

  assert.equal(defaults.collection.contentCollectionConcurrency, 2);
  assert.equal(lowerBound.collection.contentCollectionConcurrency, 1);
  assert.equal(upperBound.collection.contentCollectionConcurrency, 4);
});

test('video processing defaults to two local workers and bounds the explicit override', async () => {
  const defaults = await readConfigured302Adapter({
    KOLFORGE_VIDEO_ANALYSIS_CONCURRENCY: '',
    KOLFORGE_VIDEO_CREATOR_CONCURRENCY: '',
    KOLFORGE_VIDEO_BROWSER_RECORDING_FALLBACK: '',
  });
  const lowerBound = await readConfigured302Adapter({
    KOLFORGE_VIDEO_ANALYSIS_CONCURRENCY: '0',
    KOLFORGE_VIDEO_CREATOR_CONCURRENCY: '0',
  });
  const upperBound = await readConfigured302Adapter({
    KOLFORGE_VIDEO_ANALYSIS_CONCURRENCY: '9',
    KOLFORGE_VIDEO_CREATOR_CONCURRENCY: '9',
    KOLFORGE_VIDEO_BROWSER_RECORDING_FALLBACK: 'true',
  });

  assert.equal(defaults.video.concurrency, 2);
  assert.equal(defaults.video.creatorConcurrency, 2);
  assert.equal(defaults.video.browserRecordingFallback, false);
  assert.equal(lowerBound.video.concurrency, 1);
  assert.equal(lowerBound.video.creatorConcurrency, 1);
  assert.equal(upperBound.video.concurrency, 4);
  assert.equal(upperBound.video.creatorConcurrency, 4);
  assert.equal(upperBound.video.browserRecordingFallback, true);
});

test('content analysis defaults to Codex orchestration and bounds remote concurrency', async () => {
  const defaults = await readConfigured302Adapter({
    KOLFORGE_CONTENT_ANALYSIS_ORCHESTRATION: '',
    KOLFORGE_CONTENT_ANALYSIS_REMOTE_CONCURRENCY: '',
    KOLFORGE_CONTENT_ANALYSIS_REQUEST_CONCURRENCY: '',
  });
  const lowerBound = await readConfigured302Adapter({
    KOLFORGE_CONTENT_ANALYSIS_ORCHESTRATION: 'unsupported',
    KOLFORGE_CONTENT_ANALYSIS_REMOTE_CONCURRENCY: '0',
    KOLFORGE_CONTENT_ANALYSIS_REQUEST_CONCURRENCY: '0',
  });
  const upperBound = await readConfigured302Adapter({
    KOLFORGE_CONTENT_ANALYSIS_ORCHESTRATION: 'evidence_matrix',
    KOLFORGE_CONTENT_ANALYSIS_REMOTE_CONCURRENCY: '99',
    KOLFORGE_CONTENT_ANALYSIS_REQUEST_CONCURRENCY: '99',
  });

  assert.deepEqual(defaults.contentAnalysis, {
    orchestration: 'codex_multi_agent',
    remoteConcurrency: 2,
    requestConcurrency: 6,
  });
  assert.deepEqual(lowerBound.contentAnalysis, {
    orchestration: 'codex_multi_agent',
    remoteConcurrency: 1,
    requestConcurrency: 1,
  });
  assert.deepEqual(upperBound.contentAnalysis, {
    orchestration: 'evidence_matrix',
    remoteConcurrency: 8,
    requestConcurrency: 16,
  });
});

test('relay preflight cache defaults to two minutes and remains bounded', async () => {
  const defaults = await readConfigured302Adapter({
    KOLFORGE_RELAY_PREFLIGHT_CACHE_MS: '',
  });
  const disabled = await readConfigured302Adapter({
    KOLFORGE_RELAY_PREFLIGHT_CACHE_MS: '-1',
  });
  const upperBound = await readConfigured302Adapter({
    KOLFORGE_RELAY_PREFLIGHT_CACHE_MS: '999999',
  });

  assert.equal(defaults.relay.preflightCacheMs, 120000);
  assert.equal(disabled.relay.preflightCacheMs, 0);
  assert.equal(upperBound.relay.preflightCacheMs, 300000);
});
