import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FORENSICS_ROOT = path.resolve(MODULE_DIR, '..');
const WORKSPACE_ROOT = path.resolve(SESSION_FORENSICS_ROOT, '..');

export const PORTABLE_WORKBENCH_OUTPUT_ROOT = path.join(WORKSPACE_ROOT, 'output', 'main-workbench-distributions');

function timestampKey(date = new Date()) {
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

async function pathExists(filePath) {
  try { await fsp.access(filePath); return true; } catch { return false; }
}

async function copyRuntime(runtimeDir) {
  await fsp.mkdir(runtimeDir, { recursive: true });
  const runtimeTarget = path.join(runtimeDir, process.platform === 'win32' ? 'node.exe' : 'node');
  await fsp.copyFile(process.execPath, runtimeTarget);
  if (process.platform !== 'win32') await fsp.chmod(runtimeTarget, 0o755);
  for (const entry of await fsp.readdir(path.dirname(process.execPath), { withFileTypes: true })) {
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.dll') {
      await fsp.copyFile(path.join(path.dirname(process.execPath), entry.name), path.join(runtimeDir, entry.name));
    }
  }
  return runtimeTarget;
}

async function copyWorkbenchSource(packageDir) {
  const targetRoot = path.join(packageDir, 'session-forensics');
  await fsp.mkdir(targetRoot, { recursive: true });
  await fsp.copyFile(path.join(SESSION_FORENSICS_ROOT, 'ui-server.mjs'), path.join(targetRoot, 'ui-server.mjs'));
  for (const directory of ['lib', 'templates', 'ui']) {
    await fsp.cp(path.join(SESSION_FORENSICS_ROOT, directory), path.join(targetRoot, directory), { recursive: true, force: true });
  }
}

function selfCheckSource() {
  return `import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const metadataPath = path.join(ROOT, 'version.json');
const required = [
  'runtime/node.exe',
  'session-forensics/ui-server.mjs',
  'session-forensics/ui/index.html',
  'session-forensics/ui/app.js',
  'session-forensics/ui/styles.css',
  'portable-launcher.mjs',
  'portable-installer.mjs',
  'start-workbench.cmd',
  'version.json',
];

const missing = [];
for (const relativePath of required) {
  try { await fsp.access(path.join(ROOT, relativePath)); }
  catch { missing.push(relativePath); }
}

let metadata;
try { metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8')); }
catch (error) {
  console.error('无法读取版本信息：' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

const policy = metadata?.dataPolicy || {};
const privateDataIncluded = ['includesConversations', 'includesProjectFiles', 'includesGeneratedOutputs', 'includesBrowserAuthentication', 'includesApiKeys']
  .filter((key) => policy[key] !== false);

if (missing.length || privateDataIncluded.length) {
  console.error('安装包自检未通过。');
  if (missing.length) console.error('缺少必要文件：' + missing.join('、'));
  if (privateDataIncluded.length) console.error('隐私清单异常：' + privateDataIncluded.join('、'));
  process.exitCode = 1;
} else {
  console.log('安装包自检通过：运行环境、主界面、启动器和隐私清单完整。');
  console.log('新电脑上的会话、项目、浏览器登录态和模型配置会在本机重新发现或连接。');
}
`;
}

function launcherSource() {
  return `import fsp from 'node:fs/promises';
 import { spawn } from 'node:child_process';
 import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

 const ROOT = path.dirname(fileURLToPath(import.meta.url));
 const RUNTIME = path.join(ROOT, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
 const SERVER = path.join(ROOT, 'session-forensics', 'ui-server.mjs');
 const RUN_STATE = path.join(ROOT, 'run-state.json');

function canListen(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function choosePort() {
  const requested = Number(process.env.WORKBENCH_PORT || 0);
  if (Number.isInteger(requested) && requested > 0 && requested < 65536 && await canListen(requested)) return requested;
  for (let port = 8960; port <= 8999; port += 1) if (await canListen(port)) return port;
  throw new Error('没有找到可用的本机端口，请关闭一个正在运行的工作台后重试。');
}

async function waitUntilReady(url, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('主工作台服务提前退出，请查看窗口中的错误信息。');
    try { const response = await fetch(url + 'api/health'); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('主工作台启动超时，请检查安全软件是否阻止本机服务。');
}

 function openBrowser(url) {
  if (process.env.WORKBENCH_NO_BROWSER === '1') return;
  const opener = spawn('cmd.exe', ['/d', '/s', '/c', 'start "" "' + url + '"'], { detached: true, windowsHide: true, stdio: 'ignore' });
  opener.unref();
 }

 async function writeRunState(state) {
   try { await fsp.writeFile(RUN_STATE, JSON.stringify(state, null, 2) + '\\n', 'utf8'); } catch {}
 }

 async function clearRunState() {
   try {
     const current = JSON.parse(await fsp.readFile(RUN_STATE, 'utf8'));
     if (Number(current?.launcherPid) === process.pid) await fsp.rm(RUN_STATE, { force: true });
   } catch {}
 }

const port = await choosePort();
const url = 'http://127.0.0.1:' + port + '/';
 const child = spawn(RUNTIME, [SERVER], {
  cwd: ROOT,
  env: { ...process.env, CODEX_SESSION_FORENSICS_HOST: '127.0.0.1', CODEX_SESSION_FORENSICS_PORT: String(port) },
  stdio: 'inherit',
   windowsHide: false,
 });
 await writeRunState({ schemaVersion: 1, launcherPid: process.pid, childPid: child.pid, root: ROOT, port, url, startedAt: new Date().toISOString() });

try {
  await waitUntilReady(url, child);
  console.log('');
  console.log('零代码工作能力蒸馏器已启动：' + url);
  console.log('关闭此窗口会停止工作台。');
  openBrowser(url);
} catch (error) {
  child.kill();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

 for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
 await new Promise((resolve) => child.once('exit', resolve));
 await clearRunState();
 `;
}

function directStartScript() {
  return `@echo off\r
chcp 65001 >nul\r
title 零代码工作能力蒸馏器\r
cd /d "%~dp0"\r
"%~dp0runtime\\node.exe" "%~dp0portable-launcher.mjs"\r
if errorlevel 1 (\r
  echo.\r
  echo 启动失败，请保留窗口中的错误信息。\r
  pause\r
)\r
`;
}

function selfCheckScript() {
  return `@echo off\r
chcp 65001 >nul\r
title 零代码工作能力蒸馏器 - 安装包自检\r
cd /d "%~dp0"\r
"%~dp0runtime\\node.exe" "%~dp0portable-self-check.mjs"\r
if errorlevel 1 pause\r
`;
}

function uninstallScript() {
  return `@echo off\r
chcp 65001 >nul\r
title 卸载零代码工作能力蒸馏器\r
echo 将删除当前安装目录，不会删除用户另行保存的能力包 ZIP。\r
choice /M "确认卸载"\r
if errorlevel 2 exit /b 0\r
cd /d "%TEMP%"\r
start "" cmd /c timeout /t 2 /nobreak ^>nul ^& rmdir /s /q "%~dp0"\r
`;
}

function installerSource() {
  return `import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const target = process.env.WORKBENCH_INSTALL_ROOT || path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || ROOT, 'WorkCapabilityDistiller');
const staging = target + '.next';
const backup = target + '.previous';

 async function exists(file) { try { await fsp.access(file); return true; } catch { return false; } }
 async function renameWithRetry(source, destination, attempts = 12) {
   let lastError;
   for (let attempt = 0; attempt < attempts; attempt += 1) {
     try { await fsp.rename(source, destination); return; } catch (error) {
       lastError = error;
       if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt === attempts - 1) throw error;
       await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
     }
   }
   throw lastError;
 }
 async function alive(pid) { if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
 async function stopPreviousWorkbench() {
   const statePath = path.join(target, 'run-state.json');
   let state;
   try { state = JSON.parse(await fsp.readFile(statePath, 'utf8')); } catch { return; }
   if (path.resolve(String(state?.root || '')) !== path.resolve(target)) return;
   const pids = [...new Set([Number(state.childPid), Number(state.launcherPid)])].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
   for (const pid of pids) { try { process.kill(pid); } catch {} }
   const deadline = Date.now() + 5000;
   while (Date.now() < deadline && pids.some((pid) => alive(pid))) await new Promise((resolve) => setTimeout(resolve, 100));
   if (pids.some((pid) => alive(pid))) throw new Error('检测到旧版工作台仍在运行，请关闭旧工作台后重试。');
 }
async function runSelfCheck(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'runtime', 'node.exe'), [path.join(root, 'portable-self-check.mjs')], { cwd: root, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code === 0));
  });
}

 await fsp.rm(staging, { recursive: true, force: true });
 await stopPreviousWorkbench();
 await fsp.cp(ROOT, staging, {
  recursive: true,
  force: true,
  filter(source) {
    const relative = path.relative(ROOT, source);
    return relative !== 'output' && !relative.startsWith('output' + path.sep);
  },
});
if (await exists(path.join(target, 'output'))) await fsp.cp(path.join(target, 'output'), path.join(staging, 'output'), { recursive: true, force: true });
if (!await runSelfCheck(staging)) {
  await fsp.rm(staging, { recursive: true, force: true });
  throw new Error('新版本自检失败，当前安装保持不变。');
}
await fsp.rm(backup, { recursive: true, force: true });
if (await exists(target)) await renameWithRetry(target, backup);
try {
  await renameWithRetry(staging, target);
} catch (error) {
  if (await exists(backup) && !await exists(target)) await renameWithRetry(backup, target);
  throw error;
}
await fsp.copyFile(path.join(target, 'version.json'), path.join(target, 'installed-version.json'));
console.log('安装目录：' + target);
console.log('上一版本：' + backup);
`;
}

function installScript() {
  return `@echo off\r
chcp 65001 >nul\r
setlocal EnableExtensions\r
title 安装或升级零代码工作能力蒸馏器\r
if /I "%~1"=="--automated-test" set "WORKBENCH_SKIP_START=1"\r
if /I "%~1"=="--automated-test" set "WORKBENCH_SKIP_SHORTCUTS=1"\r
if "%WORKBENCH_INSTALL_ROOT%"=="" (set "TARGET=%LOCALAPPDATA%\\WorkCapabilityDistiller") else (set "TARGET=%WORKBENCH_INSTALL_ROOT%")\r
set "STARTMENU=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\零代码工作能力蒸馏器"\r
echo [1/5] 正在检查安装包完整性...\r
"%~dp0runtime\\node.exe" "%~dp0portable-self-check.mjs"\r
if errorlevel 1 (echo 安装包检查失败。& pause& exit /b 1)\r
echo [2/5] 正在复制并检查新版本...\r
"%~dp0runtime\\node.exe" "%~dp0portable-installer.mjs"\r
if errorlevel 1 (echo 版本切换失败，当前安装保持不变。& pause& exit /b 1)\r
echo [3/5] 正在创建开始菜单和桌面入口...\r
if not "%WORKBENCH_SKIP_SHORTCUTS%"=="1" (\r
  if not exist "%STARTMENU%" mkdir "%STARTMENU%"\r
  copy /y "%TARGET%\\start-workbench.cmd" "%STARTMENU%\\启动工作台.cmd" >nul\r
  copy /y "%TARGET%\\使用说明.html" "%STARTMENU%\\使用说明.html" >nul\r
  copy /y "%TARGET%\\修复安装.cmd" "%STARTMENU%\\修复安装.cmd" >nul\r
  copy /y "%TARGET%\\回滚上一版本.cmd" "%STARTMENU%\\回滚上一版本.cmd" >nul\r
  copy /y "%TARGET%\\uninstall.cmd" "%STARTMENU%\\卸载.cmd" >nul\r
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\零代码工作能力蒸馏器.lnk'); $s.TargetPath='%TARGET%\\start-workbench.cmd'; $s.WorkingDirectory='%TARGET%'; $s.Save()"\r
)\r
echo [4/5] 安装状态已保存。\r
if "%WORKBENCH_SKIP_START%"=="1" (echo 已完成安装验证，未启动工作台。& endlocal& exit /b 0)\r
echo [5/5] 正在启动主工作台...\r
start "零代码工作能力蒸馏器" "%TARGET%\\start-workbench.cmd"\r
echo 安装完成。\r
endlocal\r
`;
}

function repairScript() {
  return `@echo off\r
chcp 65001 >nul\r
setlocal\r
title 修复零代码工作能力蒸馏器\r
cd /d "%~dp0"\r
echo 正在检查当前安装...\r
"%~dp0runtime\\node.exe" "%~dp0portable-self-check.mjs"\r
if errorlevel 1 (\r
  echo 当前安装文件不完整。请运行新版本安装器，安装器会保留上一版本并完成替换。\r
  pause\r
  exit /b 1\r
)\r
echo 当前安装完整，正在重新创建桌面入口...\r
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\零代码工作能力蒸馏器.lnk'); $s.TargetPath='%~dp0start-workbench.cmd'; $s.WorkingDirectory='%~dp0'; $s.Save()"\r
echo 修复完成。\r
endlocal\r
`;
}

function rollbackScript() {
  return `@echo off\r
chcp 65001 >nul\r
setlocal\r
title 回滚零代码工作能力蒸馏器上一版本\r
set "TARGET=%~dp0"\r
set "TARGET=%TARGET:~0,-1%"\r
set "BACKUP=%TARGET%.previous"\r
set "FAILED=%TARGET%.failed-rollback"\r
if not exist "%BACKUP%\\runtime\\node.exe" (echo 没有可回滚的上一版本。& pause& exit /b 1)\r
choice /M "确认回滚到上一版本"\r
if errorlevel 2 exit /b 0\r
if exist "%FAILED%" rmdir /s /q "%FAILED%"\r
move "%TARGET%" "%FAILED%" >nul\r
move "%BACKUP%" "%TARGET%" >nul\r
if not exist "%TARGET%\\runtime\\node.exe" (echo 回滚失败，请检查目录是否被正在运行的工作台占用。& pause& exit /b 1)\r
echo 已回滚到上一版本，失败版本保留在：%FAILED%\r
start "零代码工作能力蒸馏器" "%TARGET%\\start-workbench.cmd"\r
endlocal\r
`;
}

function scriptWrapper(target) {
  return `@echo off\r
call "%~dp0${target}"\r
`;
}

function usageHtml(metadata) {
  const createdAt = new Date(metadata.createdAt).toLocaleString('zh-CN', { hour12: false });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>换机安装说明</title><style>
:root{font-family:"Microsoft YaHei UI","Segoe UI",sans-serif;color:#173a34;background:#f3f7f5}body{margin:0}.shell{max-width:980px;margin:auto;padding:40px 24px 64px}.eyebrow{color:#087f70;font-weight:800;font-size:13px}h1{font-size:36px;margin:8px 0 12px}h2{font-size:22px;margin:0 0 12px}p,li{line-height:1.8}.lead{font-size:17px;color:#49635d}.steps,.grid{display:grid;gap:12px}.steps{grid-template-columns:repeat(3,1fr);margin:28px 0}.card{background:#fff;border:1px solid #cddbd6;border-radius:6px;padding:20px}.step{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#087f70;color:#fff;font-weight:800}.grid{grid-template-columns:1fr 1fr}.notice{border-left:4px solid #c94040;background:#fff;padding:16px 18px;margin-top:20px}code{background:#e8f1ed;padding:2px 5px;border-radius:3px}@media(max-width:720px){h1{font-size:28px}.steps,.grid{grid-template-columns:1fr}}</style></head><body><main class="shell">
<span class="eyebrow">换电脑继续使用</span><h1>零代码工作能力蒸馏器</h1>
<p class="lead">这是包含内置运行环境的 Windows x64 换机安装包。新电脑无需预装 Node.js 或 Git，双击安装后即可自动打开主工作台。</p>
<section class="steps"><div class="card"><span class="step">1</span><h2>复制并解压</h2><p>把 ZIP 完整复制到新电脑并解压到普通文件夹。</p></div><div class="card"><span class="step">2</span><h2>双击安装</h2><p>运行 <strong>安装并启动.cmd</strong>。程序会检查文件、复制到当前用户目录并创建桌面入口。</p></div><div class="card"><span class="step">3</span><h2>开始使用</h2><p>浏览器会自动打开主工作台。选择新电脑上的会话或连接网页聊天即可。</p></div></section>
<section class="grid"><div class="card"><h2>包内已有功能</h2><ul><li>自动发现本机 Codex 会话并显示标题</li><li>多选会话、按内容搜索并识别项目</li><li>读取项目文件、Git、产物和验证证据</li><li>生成 P0-P3 建议、Skill、MCP 和独立 Agent</li><li>连接网页聊天并更新本机持久化列表</li></ul></div><div class="card"><h2>换机后需要重新连接</h2><ul><li>会话列表来自新电脑本机，不复制旧电脑聊天记录</li><li>项目文件需要在新电脑存在或重新选择</li><li>网页聊天使用新电脑的浏览器登录状态</li><li>已有能力包可单独复制 ZIP 后在工作台导入</li></ul></div></section>
<div class="notice"><strong>维护入口</strong><p>安装目录中的 <strong>检查安装包.cmd</strong> 可执行完整性检查，<strong>修复安装.cmd</strong> 可重新创建桌面入口，<strong>回滚上一版本.cmd</strong> 可在升级后恢复到上一版本。安装包不包含旧电脑的聊天记录、项目文件、生成产物、Cookie、令牌、模型密钥或浏览器登录信息。</p></div>
<p>构建时间：${createdAt}；内置运行环境：Node.js ${metadata.nodeVersion}；目标平台：Windows x64。</p></main></body></html>`;
}

async function directorySize(directory) {
  let size = 0;
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) size += await directorySize(entryPath);
    else if (entry.isFile()) size += (await fsp.stat(entryPath)).size;
  }
  return size;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(await fsp.readFile(filePath));
  return hash.digest('hex');
}

function runArchive(outputRoot, packageKey, zipPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar.exe', ['-a', '-c', '-f', zipPath, '-C', outputRoot, packageKey], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`压缩换机安装包失败（退出码 ${code}）：${stderr.trim()}`)));
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], ...options });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stderr }));
  });
}

async function buildSetupExecutable({ zipPath, outputPath }) {
  if (process.platform !== 'win32' || !await pathExists('C:\\Windows\\System32\\iexpress.exe')) return null;
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'work-capability-setup-'));
  const stagedZip = path.join(staging, 'payload.zip');
  const stagedBootstrap = path.join(staging, 'bootstrap.cmd');
  const stagedSed = path.join(staging, 'package.sed');
  const stagedSetup = path.join(staging, 'setup.exe');
  const bootstrap = `@echo off\r\nsetlocal\r\nset "DEST=%TEMP%\\WorkCapabilityDistillerSetup-%RANDOM%"\r\nmkdir "%DEST%" >nul 2>nul\r\ntar.exe -xf "%~dp0payload.zip" -C "%DEST%"\r\nif errorlevel 1 (echo 安装包解压失败。& pause& exit /b 1)\r\nfor /d %%D in ("%DEST%\\work-capability-distiller-*") do set "PAYLOAD=%%~fD"\r\nif not defined PAYLOAD (echo 找不到安装内容。& pause& exit /b 1)\r\ncall "%PAYLOAD%\\安装并启动.cmd"\r\nendlocal\r\n`;
  const winPath = (value) => value.replaceAll('/', '\\');
  const sed = `[Version]\nClass=IEXPRESS\nSEDVersion=3\n[Options]\nPackagePurpose=InstallApp\nShowInstallProgramWindow=1\nHideExtractAnimation=1\nUseLongFileName=1\nInsideCompressed=1\nRebootMode=N\nTargetName=${winPath(stagedSetup)}\nFriendlyName=WorkCapabilityDistiller\nAppLaunched=bootstrap.cmd\nPostInstallCmd=<None>\nSourceFiles=SourceFiles\n[SourceFiles]\nSourceFiles0=${winPath(staging)}\n[SourceFiles0]\n%FILE0%=\n%FILE1%=\n[Strings]\nFILE0="payload.zip"\nFILE1="bootstrap.cmd"\n`;
  try {
    await fsp.copyFile(zipPath, stagedZip);
    await fsp.writeFile(stagedBootstrap, bootstrap, 'utf8');
    await fsp.writeFile(stagedSed, sed, 'ascii');
    await runProcess('iexpress.exe', ['/N', '/Q', stagedSed]);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !await pathExists(stagedSetup)) await new Promise((resolve) => setTimeout(resolve, 500));
    if (!await pathExists(stagedSetup)) throw new Error('IExpress 未生成单文件安装器。');
    await fsp.copyFile(stagedSetup, outputPath);
    return outputPath;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

export async function buildPortableWorkbench({ outputRoot = PORTABLE_WORKBENCH_OUTPUT_ROOT, now = new Date() } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前换机安装包面向 Windows x64，请在 Windows x64 工作台中生成。');
  const createdAt = now.toISOString();
  const packageKey = `work-capability-distiller-windows-x64-${timestampKey(now)}`;
  const resolvedOutputRoot = path.resolve(outputRoot);
  const packageDir = path.join(resolvedOutputRoot, packageKey);
  const zipPath = path.join(resolvedOutputRoot, `${packageKey}.zip`);
  const setupPath = path.join(resolvedOutputRoot, `${packageKey}-setup.exe`);
  const manifestPath = path.join(resolvedOutputRoot, `${packageKey}-manifest.json`);
  await fsp.mkdir(resolvedOutputRoot, { recursive: true });
  await fsp.rm(packageDir, { recursive: true, force: true });
  await fsp.rm(zipPath, { force: true });
  await fsp.rm(setupPath, { force: true });
  await fsp.rm(manifestPath, { force: true });
  await fsp.mkdir(packageDir, { recursive: true });

  await copyWorkbenchSource(packageDir);
  await copyRuntime(path.join(packageDir, 'runtime'));

  const metadata = {
    schemaVersion: 2,
    productName: '零代码工作能力蒸馏器',
    packageKey,
    createdAt,
    platform: 'win32',
    arch: 'x64',
    nodeVersion: process.version,
    entrypoint: '安装并启动.cmd',
    portableEntrypoint: '直接启动.cmd',
    selfCheckEntrypoint: '检查安装包.cmd',
    repairEntrypoint: '修复安装.cmd',
    rollbackEntrypoint: '回滚上一版本.cmd',
    zipFileName: path.basename(zipPath),
    setupFileName: path.basename(setupPath),
    singleFileInstaller: 'IExpress setup.exe',
    compatibilityEntrypoints: { installer: 'install-and-start.cmd', portable: 'start-workbench.cmd' },
    dataPolicy: {
      includesConversations: false,
      includesProjectFiles: false,
      includesGeneratedOutputs: false,
      includesBrowserAuthentication: false,
      includesApiKeys: false,
    },
  };

  await Promise.all([
    fsp.writeFile(path.join(packageDir, 'portable-launcher.mjs'), launcherSource(), 'utf8'),
    fsp.writeFile(path.join(packageDir, 'portable-installer.mjs'), installerSource(), 'utf8'),
    fsp.writeFile(path.join(packageDir, 'portable-self-check.mjs'), selfCheckSource(), 'utf8'),
    fsp.writeFile(path.join(packageDir, 'install-and-start.cmd'), installScript(), 'utf8'),
    fsp.writeFile(path.join(packageDir, 'start-workbench.cmd'), directStartScript(), 'utf8'),
    fsp.writeFile(path.join(packageDir, 'uninstall.cmd'), uninstallScript(), 'utf8'),
    fsp.writeFile(path.join(packageDir, 'repair-install.cmd'), repairScript(), 'utf8'),
    fsp.writeFile(path.join(packageDir, 'rollback-previous.cmd'), rollbackScript(), 'utf8'),
    fsp.writeFile(path.join(packageDir, '安装并启动.cmd'), scriptWrapper('install-and-start.cmd'), 'utf8'),
    fsp.writeFile(path.join(packageDir, '直接启动.cmd'), scriptWrapper('start-workbench.cmd'), 'utf8'),
    fsp.writeFile(path.join(packageDir, '检查安装包.cmd'), selfCheckScript(), 'utf8'),
    fsp.writeFile(path.join(packageDir, '修复安装.cmd'), scriptWrapper('repair-install.cmd'), 'utf8'),
    fsp.writeFile(path.join(packageDir, '回滚上一版本.cmd'), scriptWrapper('rollback-previous.cmd'), 'utf8'),
    fsp.writeFile(path.join(packageDir, '使用说明.html'), usageHtml(metadata), 'utf8'),
    fsp.writeFile(path.join(packageDir, 'version.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8'),
  ]);

  for (const forbiddenPath of [path.join(packageDir, 'output'), path.join(packageDir, '.env')]) {
    if (await pathExists(forbiddenPath)) throw new Error(`换机安装包包含不应迁移的数据：${forbiddenPath}`);
  }

  const unpackedBytes = await directorySize(packageDir);
  await runArchive(resolvedOutputRoot, packageKey, zipPath);
  const generatedSetupPath = await buildSetupExecutable({ zipPath, outputPath: setupPath });
  const releaseFiles = [zipPath, generatedSetupPath].filter(Boolean);
  const releaseManifest = {
    schemaVersion: 1,
    packageKey,
    generatedAt: new Date().toISOString(),
    files: await Promise.all(releaseFiles.map(async (filePath) => ({
      name: path.basename(filePath),
      bytes: (await fsp.stat(filePath)).size,
      sha256: await sha256File(filePath),
    }))),
  };
  await fsp.writeFile(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf8');
  return {
    ...metadata,
    packageDir,
    zipPath,
    setupPath: generatedSetupPath,
    manifestPath,
    fileName: path.basename(zipPath),
    setupFileName: generatedSetupPath ? path.basename(generatedSetupPath) : null,
    unpackedBytes,
    archiveBytes: (await fsp.stat(zipPath)).size,
    setupBytes: generatedSetupPath ? (await fsp.stat(generatedSetupPath)).size : null,
    manifestBytes: (await fsp.stat(manifestPath)).size,
  };
}
