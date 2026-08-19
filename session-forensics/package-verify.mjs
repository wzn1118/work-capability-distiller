import process from 'node:process';
import { verifyConversationPackage } from './lib/conversation-packager.mjs';

const packageRoot = process.argv[2];
if (!packageRoot || packageRoot === '--help' || packageRoot === '-h') {
  process.stderr.write('用法：node session-forensics/package-verify.mjs <能力包目录>\n');
  process.exitCode = 1;
} else {
  try {
    const result = await verifyConversationPackage(packageRoot);
    if (!result.ok) {
      process.stderr.write(`能力包校验失败：${JSON.stringify(result.failures)}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`能力包校验通过：${result.checkedArtifacts} 个文件，完整会话选择锚点有效。\n`);
    }
  } catch (error) {
    process.stderr.write(`能力包校验失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
