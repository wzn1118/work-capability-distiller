import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ConnectorError,
  buildBilibiliSearchUrl,
  buildDouyinSearchUrl,
  createRelayPreflightCache,
  readCollectorMetadata,
} from './connectors.mjs';

test('relay preflight cache only reuses a recent successful relay check', () => {
  let now = 10_000;
  const cache = createRelayPreflightCache({ ttlMs: 1_000, now: () => now });
  const ready = { status: 'relay_connected', sessionState: 'authenticated', platformTabs: 1 };

  cache.remember('douyin', ready);
  assert.deepEqual(cache.get('douyin'), ready);

  now += 1_001;
  assert.equal(cache.get('douyin'), null);

  cache.remember('douyin', { status: 'auth_required' });
  assert.equal(cache.get('douyin'), null);

  cache.remember('douyin', ready);
  cache.invalidate('douyin');
  assert.equal(cache.get('douyin'), null);
});

test('buildDouyinSearchUrl mirrors the relay collector query encoding', () => {
  assert.equal(
    buildDouyinSearchUrl('https://www.douyin.com/search/{query}?keyword={query}', '护肤 & serum!'),
    'https://www.douyin.com/search/%E6%8A%A4%E8%82%A4%20%26%20serum%21?keyword=%E6%8A%A4%E8%82%A4%20%26%20serum%21',
  );
});

test('buildBilibiliSearchUrl mirrors the relay collector query encoding', () => {
  assert.equal(
    buildBilibiliSearchUrl('https://search.bilibili.com/upuser?keyword={query}', 'review & skin!'),
    'https://search.bilibili.com/upuser?keyword=review%20%26%20skin%21',
  );
});

test('readCollectorMetadata returns a relay summary and permits a missing verify status file', async (t) => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-connectors-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const summary = {
    requested_limit: 120,
    returned_creators: 120,
    stop_reason: 'target_reached',
    source_search_url: 'https://www.douyin.com/search/%E6%8A%A4%E8%82%A4?type=general',
  };
  await fs.writeFile(path.join(outputDir, 'douyin_collection_status.json'), JSON.stringify(summary), 'utf8');

  assert.deepEqual(await readCollectorMetadata({
    outputDir,
    metadataFile: 'douyin_collection_status.json',
    platformLabel: 'Douyin',
    required: true,
  }), summary);
  assert.deepEqual(await readCollectorMetadata({
    outputDir,
    metadataFile: 'douyin_collection_status.json',
    platformLabel: 'Douyin',
  }), summary);
  assert.equal(await readCollectorMetadata({
    outputDir,
    metadataFile: 'missing-profile-status.json',
    platformLabel: 'Douyin',
  }), null);
  await assert.rejects(
    readCollectorMetadata({
      outputDir,
      metadataFile: 'missing-discovery-status.json',
      platformLabel: 'Douyin',
      required: true,
    }),
    (error) => error instanceof ConnectorError && error.code === 'COLLECTOR_METADATA_MISSING',
  );
});
