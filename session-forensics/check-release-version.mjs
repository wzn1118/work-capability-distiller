import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(MODULE_DIR, '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export async function checkReleaseVersion(inputTag, packagePath = path.join(WORKSPACE_ROOT, 'package.json')) {
  const tag = String(inputTag || '').trim();
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`发布标签格式不正确：${tag || '(空)'}。应使用 vX.Y.Z。`);
  }
  const packageMetadata = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const version = String(packageMetadata.version || '').trim();
  if (!SEMVER.test(version)) throw new Error(`package.json 版本格式不正确：${version || '(空)'}`);
  if (tag !== `v${version}`) throw new Error(`发布标签 ${tag} 与 package.json 版本 ${version} 不一致。`);
  return { tag, version, packagePath: path.resolve(packagePath) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const result = await checkReleaseVersion(process.argv[2] || process.env.GITHUB_REF_NAME);
    process.stdout.write(`发布版本一致：${result.tag}\n`);
  } catch (error) {
    process.stderr.write(`发布版本检查失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
