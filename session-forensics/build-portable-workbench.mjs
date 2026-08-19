import { buildPortableWorkbench } from './lib/portable-workbench.mjs';

const result = await buildPortableWorkbench();
process.stdout.write(`换机安装包已生成：\n${result.zipPath}\n`);
