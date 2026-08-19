import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkReleaseVersion } from './check-release-version.mjs';

test('发布标签必须与项目版本严格一致', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-version-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packagePath = path.join(root, 'package.json');
  await fs.writeFile(packagePath, JSON.stringify({ version: '1.2.3' }));

  assert.deepEqual(
    await checkReleaseVersion('v1.2.3', packagePath),
    { tag: 'v1.2.3', version: '1.2.3', packagePath },
  );
  await assert.rejects(() => checkReleaseVersion('v1.2.4', packagePath), /不一致/);
  await assert.rejects(() => checkReleaseVersion('latest', packagePath), /格式不正确/);
});
