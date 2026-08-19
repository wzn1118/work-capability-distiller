import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPortableWorkbench } from './lib/portable-workbench.mjs';

const pathExists = async (target) => fs.access(target).then(() => true, () => false);

async function waitForMissing(target, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await pathExists(target)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !await pathExists(target);
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`便携工作台提前退出，退出码：${child.exitCode}`);
    try { const response = await fetch(url); if (response.ok) return response; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('便携工作台启动超时');
}

async function runInstaller(scriptPath, installRoot) {
  return new Promise((resolve, reject) => {
    const packageRoot = path.dirname(scriptPath);
    const child = spawn(path.join(packageRoot, 'runtime', 'node.exe'), [path.join(packageRoot, 'portable-installer.mjs')], {
      cwd: path.dirname(scriptPath),
      windowsHide: true,
      env: { ...process.env, WORKBENCH_INSTALL_ROOT: installRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('Windows 换机安装包可解压、自检并启动完整主工作台', async (t) => {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    t.skip('当前测试只验证 Windows x64 换机包');
    return;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-portable-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const result = await buildPortableWorkbench({ outputRoot: path.join(tempRoot, 'build'), now: new Date('2026-08-17T01:02:03.000Z') });

  for (const relativePath of [
    'runtime/node.exe', 'session-forensics/ui-server.mjs', 'session-forensics/ui/index.html',
    'install-and-start.cmd', 'portable-installer.mjs', 'portable-self-check.mjs', 'start-workbench.cmd', 'uninstall.cmd',
    '安装并启动.cmd', '直接启动.cmd', '检查安装包.cmd', '使用说明.html', 'version.json',
  ]) assert.equal(await pathExists(path.join(result.packageDir, relativePath)), true, `缺少 ${relativePath}`);
  assert.ok((await fs.stat(result.zipPath)).size > 1_000_000, 'ZIP 体积异常');
  assert.equal(await pathExists(result.setupPath), true, '缺少单文件安装器');
  assert.ok((await fs.stat(result.setupPath)).size > 10_000_000, '单文件安装器体积异常');
  assert.equal(await pathExists(result.manifestPath), true, '缺少发布哈希清单');
  const releaseManifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
  assert.equal(releaseManifest.packageKey, result.packageKey);
  assert.deepEqual(releaseManifest.files.map((file) => file.name).sort(), [path.basename(result.setupPath), path.basename(result.zipPath)].sort());
  for (const file of releaseManifest.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.equal(file.bytes, (await fs.stat(path.join(path.dirname(result.zipPath), file.name))).size);
  }

  const metadata = JSON.parse(await fs.readFile(path.join(result.packageDir, 'version.json'), 'utf8'));
  const workspacePackage = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
  assert.equal(metadata.schemaVersion, 2);
  assert.equal(metadata.productVersion, workspacePackage.version);
  assert.equal(metadata.dataPolicy.includesBrowserAuthentication, false);
  assert.equal(metadata.dataPolicy.includesApiKeys, false);
  assert.equal(metadata.dataPolicy.includesConversations, false);
  assert.equal(metadata.dataPolicy.includesProjectFiles, false);
  assert.equal(metadata.dataPolicy.includesGeneratedOutputs, false);
  assert.equal(metadata.selfCheckEntrypoint, '检查安装包.cmd');
  assert.equal(metadata.repairEntrypoint, '修复安装.cmd');
  assert.equal(metadata.rollbackEntrypoint, '回滚上一版本.cmd');
  assert.equal(metadata.setupFileName, path.basename(result.setupPath));
  assert.equal(metadata.singleFileInstaller, 'IExpress setup.exe');

  const installer = await fs.readFile(path.join(result.packageDir, 'install-and-start.cmd'), 'utf8');
  const selfCheck = await fs.readFile(path.join(result.packageDir, 'portable-self-check.mjs'), 'utf8');
  const guide = await fs.readFile(path.join(result.packageDir, '使用说明.html'), 'utf8');
  assert.match(installer, /正在复制并检查新版本/);
  assert.match(installer, /创建开始菜单和桌面入口/);
  assert.match(installer, /start-workbench\.cmd/);
  assert.match(selfCheck, /安装包自检通过/);
  assert.match(guide, /换电脑继续使用/);
  assert.match(guide, /不包含旧电脑的聊天记录/);
  assert.match(guide, /浏览器登录状态/);

  const installRoot = path.join(tempRoot, 'installed-workbench');
  const firstInstall = await runInstaller(path.join(result.packageDir, 'install-and-start.cmd'), installRoot);
  assert.equal(firstInstall.code, 0, firstInstall.stderr || firstInstall.stdout);
  await fs.mkdir(path.join(installRoot, 'output'), { recursive: true });
  await fs.writeFile(path.join(installRoot, 'output', 'upgrade-sentinel.txt'), 'keep-output', 'utf8');
  const secondInstall = await runInstaller(path.join(result.packageDir, 'install-and-start.cmd'), installRoot);
  assert.equal(secondInstall.code, 0, secondInstall.stderr || secondInstall.stdout);
  assert.equal(await fs.readFile(path.join(installRoot, 'output', 'upgrade-sentinel.txt'), 'utf8'), 'keep-output');
  assert.equal(await pathExists(`${installRoot}.previous\\runtime\\node.exe`), true, '缺少上一版本备份');
  assert.equal(await pathExists(path.join(installRoot, 'installed-version.json')), true);
  assert.equal(await pathExists(path.join(installRoot, 'repair-install.cmd')), true);
  assert.equal(await pathExists(path.join(installRoot, 'rollback-previous.cmd')), true);

  const selfCheckRun = await new Promise((resolve, reject) => {
    const child = spawn(path.join(result.packageDir, 'runtime', 'node.exe'), [path.join(result.packageDir, 'portable-self-check.mjs')], { cwd: result.packageDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(selfCheckRun.code, 0, selfCheckRun.stderr);
  assert.match(selfCheckRun.stdout, /安装包自检通过/);

  const extractedRoot = path.join(tempRoot, 'extracted');
  await fs.mkdir(extractedRoot, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn('tar.exe', ['-xf', result.zipPath, '-C', extractedRoot], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`解压失败：${stderr}`)));
  });
  const portableRoot = path.join(extractedRoot, result.packageKey);
  const extractedSelfCheck = await new Promise((resolve, reject) => {
    const child = spawn(path.join(portableRoot, 'runtime', 'node.exe'), [path.join(portableRoot, 'portable-self-check.mjs')], { cwd: portableRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject); child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(extractedSelfCheck.code, 0, extractedSelfCheck.stderr);

  const port = await findFreePort();
  const launcher = spawn(path.join(portableRoot, 'runtime', 'node.exe'), [path.join(portableRoot, 'portable-launcher.mjs')], {
    cwd: portableRoot,
    windowsHide: true,
    env: { ...process.env, WORKBENCH_NO_BROWSER: '1', WORKBENCH_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (launcher.exitCode === null) launcher.kill(); });
  const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`, launcher);
  assert.equal((await health.json()).ok, true);
  const runState = JSON.parse(await fs.readFile(path.join(portableRoot, 'run-state.json'), 'utf8'));
  assert.equal(runState.root, portableRoot);
  assert.equal(runState.port, port);
  assert.equal(Number.isInteger(runState.childPid), true);
  const homepage = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
  assert.match(homepage, /零代码工作能力蒸馏器/);
  launcher.kill();
  await new Promise((resolve) => launcher.once('exit', resolve));
  const statePath = path.join(portableRoot, 'run-state.json');
  if (await pathExists(statePath)) {
    const staleState = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(staleState.root, portableRoot);
    await fs.rm(statePath, { force: true });
  }
  assert.equal(await waitForMissing(statePath), true);
});
