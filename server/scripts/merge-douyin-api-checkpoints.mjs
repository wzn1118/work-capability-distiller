#!/usr/bin/env node

import path from 'node:path';
import {
  DEFAULT_DATA_DIR,
  mergeCheckpointDataset,
} from './douyin-api-checkpoint-lib.mjs';

function usage() {
  return [
    'Usage: node server/scripts/merge-douyin-api-checkpoints.mjs [options]',
    '',
    'Options:',
    `  --data-dir <path>    Checkpoint/source directory (default: ${DEFAULT_DATA_DIR})`,
    '  --output-dir <path>  Destination directory (default: same as --data-dir)',
    '  --dry-run            Validate and build in memory without writing files',
    '  --summary-only       Print only aggregate result fields',
    '  --help               Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    dataDir: DEFAULT_DATA_DIR,
    outputDir: '',
    dryRun: false,
    summaryOnly: false,
  };
  const valueAfter = (index, option) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a path`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--data-dir') options.dataDir = valueAfter(index++, arg);
    else if (arg === '--output-dir') options.outputDir = valueAfter(index++, arg);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--summary-only') options.summaryOnly = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.dataDir) throw new Error('--data-dir requires a path');
  options.dataDir = path.resolve(options.dataDir);
  options.outputDir = path.resolve(options.outputDir || options.dataDir);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await mergeCheckpointDataset(options);
  const printable = options.summaryOnly
    ? {
      dry_run: result.dry_run,
      data_dir: result.data_dir,
      output_dir: result.output_dir,
      audit_summary: result.audit_summary,
      merge_summary: result.merge_summary,
      job_path: result.job_path,
    }
    : result;
  console.log(JSON.stringify(printable, null, 2));
  if (result.write_failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
