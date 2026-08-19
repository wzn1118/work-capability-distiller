#!/usr/bin/env node

import path from 'node:path';
import {
  DEFAULT_DATA_DIR,
  inspectCheckpointDataset,
} from './douyin-api-checkpoint-lib.mjs';

function usage() {
  return [
    'Usage: node server/scripts/audit-douyin-api-checkpoints.mjs [options]',
    '',
    'Options:',
    `  --data-dir <path>  Checkpoint directory (default: ${DEFAULT_DATA_DIR})`,
    '  --summary-only     Print only aggregate coverage and integrity counts',
    '  --help             Show this help',
    '',
    'This command is read-only and writes its JSON report to stdout.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { dataDir: DEFAULT_DATA_DIR, summaryOnly: false };
  const valueAfter = (index, option) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a path`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--data-dir') options.dataDir = valueAfter(index++, arg);
    else if (arg === '--summary-only') options.summaryOnly = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.dataDir) throw new Error('--data-dir requires a path');
  options.dataDir = path.resolve(options.dataDir);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { audit } = await inspectCheckpointDataset(options.dataDir);
  console.log(JSON.stringify(options.summaryOnly ? audit.summary : audit, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
