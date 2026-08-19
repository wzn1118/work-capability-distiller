import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, stableStringify } from '../ir/trace-ir.mjs';

export const ISOLATED_AGENT_VALIDATION_SCHEMA_VERSION = 'isolated-agent-validation/v2';

let cachedValidation = null;

async function removeWithRetry(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await fsp.rm(target, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
    }
  }
}

async function runIsolatedAgentValidation(runtimeTemplateRoot) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'capability-agent-isolation-'));
  const runtimeRoot = path.join(root, 'runtime');
  const workspaceRoot = path.join(root, 'workspace');
  const stateRoot = path.join(root, 'state');
  const checks = {};
  try {
    await fsp.cp(runtimeTemplateRoot, runtimeRoot, { recursive: true });
    await fsp.mkdir(workspaceRoot, { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, 'AGENTS.md'), '# 隔离验收规则\n先读取，再修改，最后验证并恢复。\n', 'utf8');
    await fsp.writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'isolated-agent-canary', scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    const config = await import(pathToFileURL(path.join(runtimeRoot, 'config.mjs')).href);
    const workspace = await import(pathToFileURL(path.join(runtimeRoot, 'workspace.mjs')).href);
    await config.updateWorkspaceConfig({ root: workspaceRoot, allowWrite: true, allowDelete: true, allowCommand: true, commandTimeoutMs: 10000 });
    const run = { id: 'isolated-canary', changeJournal: [], checkpoints: [], commands: [], verification: [] };
    const inspected = await workspace.executeWorkspaceTool(stateRoot, run, 'inspect_project', {});
    checks.readProject = inspected?.projectMarkers?.includes('package.json') === true;
    const written = await workspace.executeWorkspaceTool(stateRoot, run, 'write_file', { path: 'canary/result.txt', content: '隔离执行成功', reason: 'G9 隔离验收' });
    checks.writeFile = (await fsp.readFile(path.join(workspaceRoot, 'canary', 'result.txt'), 'utf8')) === '隔离执行成功';
    const command = await workspace.executeWorkspaceTool(stateRoot, run, 'execute_command', { command: 'node -e "const fs=require(\'fs\');process.stdout.write(fs.readFileSync(\'canary/result.txt\',\'utf8\'))"' });
    checks.executeCommand = command.exitCode === 0 && command.stdout.includes('隔离执行成功');
    const verification = await workspace.executeWorkspaceTool(stateRoot, run, 'run_verification', { commands: ['node -e "const fs=require(\'fs\');process.exit(fs.readFileSync(\'canary/result.txt\',\'utf8\')===\'隔离执行成功\'?0:1)"'] });
    checks.verifyResult = verification.passed === true;
    const checkpointId = written?.change?.checkpointId;
    checks.checkpointCreated = Boolean(checkpointId);
    if (checkpointId) await workspace.restoreCheckpoint(stateRoot, checkpointId, run);
    checks.restoreCheckpoint = await fsp.stat(path.join(workspaceRoot, 'canary', 'result.txt')).then(() => false).catch(() => true);
    const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    const result = {
      schemaVersion: ISOLATED_AGENT_VALIDATION_SCHEMA_VERSION,
      status: failedChecks.length ? 'fail' : 'pass',
      reason: failedChecks.length
        ? `独立 Agent 隔离验收未满足：${failedChecks.join('、')}。`
        : '独立 Agent 已在临时隔离工作区完成项目读取、文件写入、命令执行、结果验证和检查点恢复。',
      checks,
      failedChecks,
      trace: {
        changeCount: run.changeJournal.length,
        checkpointCount: run.checkpoints.length,
        commandCount: run.commands.length,
        verificationCount: run.verification.length,
      },
    };
    return { ...result, fingerprint: sha256(stableStringify(result)) };
  } catch (error) {
    return {
      schemaVersion: ISOLATED_AGENT_VALIDATION_SCHEMA_VERSION,
      status: 'fail',
      reason: `独立 Agent 隔离验收异常：${error.message}`,
      checks,
      failedChecks: ['runtimeException'],
    };
  } finally {
    await removeWithRetry(root).catch(() => {});
  }
}

export function validateAgentRuntimeInIsolation(runtimeTemplateRoot, { force = false } = {}) {
  if (!force && cachedValidation) return cachedValidation;
  const promise = runIsolatedAgentValidation(runtimeTemplateRoot);
  if (!force) cachedValidation = promise;
  return promise;
}
