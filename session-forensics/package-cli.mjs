import fsp from 'node:fs/promises';
import process from 'node:process';
import { packageConversation } from './lib/conversation-packager.mjs';

function usage() {
  return `用法：\n  node session-forensics/package-cli.mjs (--thread <UUID> | --source <JSON/JSONL>) [选项]\n\n选项：\n  --package-id <id>     能力包标识，仅小写字母、数字和短横线\n  --package-name <名称> 能力包显示名称\n  --target <目标>       可重复指定：skill、mcp、agent；默认全部生成\n  --root <目录>         能力包输出根目录\n  --held-out <JSON>     未参与蒸馏的新任务验收结果文件\n  --no-evidence         不保留工具参数与结果摘录\n  --keep-secrets        不进行疑似凭据脱敏\n  --help                显示本帮助\n`;
}

function parseArguments(argv) {
  const options = { targets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--no-evidence') options.includeEvidence = false;
    else if (token === '--keep-secrets') options.redact = false;
    else if (['--thread', '--source', '--package-id', '--package-name', '--root', '--target', '--held-out'].includes(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} 缺少参数。`);
      index += 1;
      if (token === '--thread') options.threadId = value;
      if (token === '--source') options.sourcePath = value;
      if (token === '--package-id') options.packageId = value;
      if (token === '--package-name') options.packageName = value;
      if (token === '--root') options.outputRoot = value;
      if (token === '--target') options.targets.push(value);
      if (token === '--held-out') options.heldOutPath = value;
    } else {
      throw new Error(`未识别的参数：${token}`);
    }
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
  } else {
    if (!options.threadId && !options.sourcePath) throw new Error('必须提供 --thread 或 --source。');
    const result = await packageConversation({
      ...options,
      heldOutCandidate: options.heldOutPath ? JSON.parse(await fsp.readFile(options.heldOutPath, 'utf8')) : null,
      targets: options.targets.length ? options.targets : undefined,
      includeEvidence: options.includeEvidence !== false,
      redact: options.redact !== false,
    });
    process.stdout.write(`${JSON.stringify({
      package: result.package,
      verification: result.verification,
    }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`能力包生成失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
