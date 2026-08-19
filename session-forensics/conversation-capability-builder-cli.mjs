import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConversationCapabilityBuilder } from './lib/conversation-capability-builder.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const outputRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'output', 'conversation-capability-builder');
const result = await buildConversationCapabilityBuilder({ outputRoot });
process.stdout.write(`独立对话转能力包应用已创建：\n目录：${result.root}\nZIP：${result.archive}\nWindows 安装：${result.launch.installWindows}\n直接启动：${result.launch.windows}\n`);
