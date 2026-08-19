#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { analyseSessionSource, DEFAULT_OUTPUT_ROOT } from './lib/session-forensics.mjs';

function usage() {
  return `会话全量取证\n\n用法：\n  node session-forensics/cli.mjs --thread-id UUID [选项]\n  node session-forensics/cli.mjs --source transcript.jsonl [选项]\n\n选项：\n  --thread-id UUID        按编号定位本机 JSONL 会话。\n  --source PATH           解析指定的 JSON 或 JSONL 会话文件。\n  --root PATH             指定会话搜索根目录，可重复传入。\n  --out PATH              指定报告目录；默认位于 output/session-forensics/<会话编号>。\n  --include-evidence      在 analysis.json 中保留长度受限的工具参数和结果摘录。\n  --no-redact             关闭内置敏感信息遮盖，仅用于本机复核。\n  --help                  显示本帮助。\n\n输出文件：\n  analysis.json、report.md、report.html、normalized-events.ndjson、manifest.json\n`;
}

function parseArguments(argv) {
  const options = { roots: [], includeEvidence: false, redact: true };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--thread-id') { options.threadId = value; index += 1; }
    else if (token === '--source') { options.sourcePath = value; index += 1; }
    else if (token === '--root') { options.roots.push(value); index += 1; }
    else if (token === '--out') { options.outputDir = value; index += 1; }
    else if (token === '--include-evidence') options.includeEvidence = true;
    else if (token === '--no-redact') options.redact = false;
    else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`未识别的选项：${token}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.threadId && !options.sourcePath) {
    throw new Error('请提供 --thread-id 或 --source。\n\n' + usage());
  }
  const result = await analyseSessionSource(options);
  const output = {
    sessionId: result.analysis.source.sessionId,
    source: result.analysis.source.path,
    outputDir: result.artifacts.outputDir,
    artifacts: result.artifacts.paths,
    summary: result.analysis.summary,
    reusableCapabilities: result.analysis.reusableCapabilities.map(({ name, confidence, score }) => ({ name, confidence, score })),
    defaultOutputRoot: path.relative(process.cwd(), DEFAULT_OUTPUT_ROOT) || DEFAULT_OUTPUT_ROOT,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`会话全量取证：${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
