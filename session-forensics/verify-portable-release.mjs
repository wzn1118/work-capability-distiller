import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256File = async (filePath) => {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(Buffer.from(chunk));
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
};

async function resolveManifestPath(inputPath) {
  if (inputPath) return path.resolve(inputPath);
  const outputRoot = path.resolve('output', 'main-workbench-distributions');
  const entries = await fs.readdir(outputRoot, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('-manifest.json')) continue;
    const filePath = path.join(outputRoot, entry.name);
    manifests.push({ filePath, mtime: (await fs.stat(filePath)).mtimeMs });
  }
  manifests.sort((left, right) => right.mtime - left.mtime);
  if (!manifests[0]) throw new Error(`找不到发布清单：${outputRoot}`);
  return manifests[0].filePath;
}

export async function verifyPortableRelease(inputPath) {
  const manifestPath = await resolveManifestPath(inputPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1) throw new Error(`发布清单版本不受支持：${manifest.schemaVersion}`);
  if (typeof manifest.packageKey !== 'string' || !manifest.packageKey) throw new Error('发布清单缺少 packageKey。');
  if (!Array.isArray(manifest.files) || manifest.files.length < 2) throw new Error('发布清单至少需要 EXE 和 ZIP 两个文件。');

  const seen = new Set();
  const actualFiles = [];
  for (const entry of manifest.files) {
    if (!entry || typeof entry.name !== 'string' || path.basename(entry.name) !== entry.name) {
      throw new Error(`发布清单包含非法文件名：${entry?.name ?? '(空)'}`);
    }
    if (seen.has(entry.name)) throw new Error(`发布清单包含重复文件：${entry.name}`);
    seen.add(entry.name);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1) throw new Error(`文件大小无效：${entry.name}`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`SHA-256 无效：${entry.name}`);
    const filePath = path.join(path.dirname(manifestPath), entry.name);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`发布文件不是普通文件：${entry.name}`);
    if (stat.size !== entry.bytes) throw new Error(`文件大小与清单不一致：${entry.name}（清单 ${entry.bytes}，实际 ${stat.size}）`);
    const actualSha256 = await sha256File(filePath);
    if (actualSha256 !== entry.sha256) throw new Error(`SHA-256 与清单不一致：${entry.name}`);
    actualFiles.push({ name: entry.name, bytes: stat.size, sha256: actualSha256 });
  }

  if (!actualFiles.some((file) => file.name.toLowerCase().endsWith('-setup.exe'))) {
    throw new Error('发布清单缺少 Windows 单文件安装器（*-setup.exe）。');
  }
  if (!actualFiles.some((file) => file.name.toLowerCase().endsWith('.zip'))) {
    throw new Error('发布清单缺少 ZIP 备用包（*.zip）。');
  }
  return { manifestPath, packageKey: manifest.packageKey, files: actualFiles };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const result = await verifyPortableRelease(process.argv[2]);
    process.stdout.write(`发布物校验通过：${result.packageKey}\n`);
    for (const file of result.files) process.stdout.write(`- ${file.name} | ${file.bytes} bytes | ${file.sha256}\n`);
  } catch (error) {
    process.stderr.write(`发布物校验失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
