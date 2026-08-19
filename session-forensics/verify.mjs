#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function hashFile(filePath) {
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

async function main() {
  const out = readOption(process.argv.slice(2), '--out');
  if (!out) throw new Error('用法：node session-forensics/verify.mjs --out <报告目录>');
  const outputDir = path.resolve(out);
  const manifestPath = path.join(outputDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const checks = [];
  for (const [name, artifact] of Object.entries(manifest.artifacts ?? {})) {
    const exists = fs.existsSync(artifact.path);
    const bytes = exists ? (await fsp.stat(artifact.path)).size : null;
    const sha256 = exists ? await hashFile(artifact.path) : null;
    checks.push({ name, exists, bytesMatches: bytes === artifact.bytes, hashMatches: sha256 === artifact.sha256 });
  }
  const analysisPath = manifest.artifacts?.analysis?.path;
  const reportPath = manifest.artifacts?.markdown?.path;
  const analysis = analysisPath && fs.existsSync(analysisPath) ? JSON.parse(await fsp.readFile(analysisPath, 'utf8')) : null;
  const report = reportPath && fs.existsSync(reportPath) ? await fsp.readFile(reportPath, 'utf8') : '';
  checks.push({ name: '分析数据结构', exists: Boolean(analysis?.source && analysis?.toolCatalog && analysis?.triggerLogic && analysis?.presentation), bytesMatches: true, hashMatches: true });
  checks.push({ name: '中文报告章节', exists: /# 会话全量取证报告/.test(report) && /## 外层编排工具目录/.test(report) && /## 嵌套实际调用工具目录/.test(report) && /## 请求标题、内容与执行过程/.test(report) && /\*\*用户请求内容\*\*/.test(report) && /\*\*助手回应内容\*\*/.test(report) && /## 推导出的技能蓝图/.test(report), bytesMatches: true, hashMatches: true });
  const passed = checks.every((check) => check.exists && check.bytesMatches && check.hashMatches);
  process.stdout.write(`${JSON.stringify({ passed, outputDir, checks }, null, 2)}\n`);
  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`会话全量取证校验：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
