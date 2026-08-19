import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyPortableRelease } from './verify-portable-release.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('发布物校验器拒绝错误哈希，并接受完整清单', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const exe = Buffer.from('setup');
  const zip = Buffer.from('zip');
  await fs.writeFile(path.join(root, 'work-capability-distiller-windows-x64-test-setup.exe'), exe);
  await fs.writeFile(path.join(root, 'work-capability-distiller-windows-x64-test.zip'), zip);
  const manifestPath = path.join(root, 'work-capability-distiller-windows-x64-test-manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    packageKey: 'work-capability-distiller-windows-x64-test',
    files: [
      { name: 'work-capability-distiller-windows-x64-test-setup.exe', bytes: exe.length, sha256: sha256(exe) },
      { name: 'work-capability-distiller-windows-x64-test.zip', bytes: zip.length, sha256: sha256(zip) },
    ],
  }));

  const result = await verifyPortableRelease(manifestPath);
  assert.equal(result.files.length, 2);
  await fs.writeFile(manifestPath, (await fs.readFile(manifestPath, 'utf8')).replace(sha256(zip), '0'.repeat(64)));
  await assert.rejects(() => verifyPortableRelease(manifestPath), /SHA-256 与清单不一致/);
});
