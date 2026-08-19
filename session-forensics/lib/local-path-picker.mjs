import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PICKER_KINDS = {
  directory: {
    title: '选择项目文件夹',
    windowsScript: [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = '选择项目文件夹'",
      '$dialog.ShowNewFolderButton = $false',
      '$result = $dialog.ShowDialog()',
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { ConvertTo-Json -InputObject @($dialog.SelectedPath) -Compress } else { '[]' }",
    ].join('; '),
    macScript: 'try\nset selectedFolder to choose folder with prompt "选择项目文件夹"\nreturn POSIX path of selectedFolder\non error number -128\nreturn ""\nend try',
    linuxArgs: ['--file-selection', '--directory', '--title=选择项目文件夹'],
  },
  sessionDirectory: {
    title: '选择会话文件夹',
    windowsScript: [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = '选择包含 JSON、JSONL 或 TXT 会话文件的文件夹'",
      '$dialog.ShowNewFolderButton = $false',
      '$result = $dialog.ShowDialog()',
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { ConvertTo-Json -InputObject @($dialog.SelectedPath) -Compress } else { '[]' }",
    ].join('; '),
    macScript: 'try\nset selectedFolder to choose folder with prompt "选择包含 JSON、JSONL 或 TXT 会话文件的文件夹"\nreturn POSIX path of selectedFolder\non error number -128\nreturn ""\nend try',
    linuxArgs: ['--file-selection', '--directory', '--title=选择会话文件夹'],
  },
  sessionFiles: {
    title: '选择会话文件',
    windowsScript: [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      '$dialog.Multiselect = $true',
      "$dialog.Title = '选择 JSON、JSONL 或 TXT 会话文件'",
      "$dialog.Filter = '会话文件 (*.json;*.jsonl;*.txt)|*.json;*.jsonl;*.txt|所有文件 (*.*)|*.*'",
      '$result = $dialog.ShowDialog()',
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { ConvertTo-Json -InputObject @($dialog.FileNames) -Compress } else { '[]' }",
    ].join('; '),
    macScript: 'try\nset selectedFiles to choose file with prompt "选择 JSON、JSONL 或 TXT 会话文件" with multiple selections allowed\nset outputText to ""\nrepeat with selectedFile in selectedFiles\nset outputText to outputText & POSIX path of selectedFile & linefeed\nend repeat\nreturn outputText\non error number -128\nreturn ""\nend try',
    linuxArgs: ['--file-selection', '--multiple', '--separator=\n', '--title=选择 JSON、JSONL 或 TXT 会话文件', '--file-filter=会话文件 | *.json *.jsonl *.txt'],
  },
};

function normalisePaths(value) {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw
    .map((item) => String(item || '').replace(/\r?\n$/, '').trim())
    .filter(Boolean))];
}

function parseWindowsOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  try {
    return normalisePaths(JSON.parse(text));
  } catch {
    return normalisePaths(text.split(/\r?\n/));
  }
}

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function selectWindows(config) {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-STA',
    '-EncodedCommand',
    encodedPowerShell(config.windowsScript),
  ], { windowsHide: true, timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 });
  return parseWindowsOutput(stdout);
}

async function selectMac(config) {
  const { stdout } = await execFileAsync('osascript', ['-e', config.macScript], { timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 });
  return normalisePaths(String(stdout || '').split(/\r?\n/));
}

async function selectLinux(config) {
  const { stdout } = await execFileAsync('zenity', config.linuxArgs, { timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 });
  return normalisePaths(String(stdout || '').split(/\r?\n/));
}

export function availablePathPickerKinds() {
  return Object.keys(PICKER_KINDS);
}

export async function selectLocalPaths(kind) {
  const config = PICKER_KINDS[kind];
  if (!config) throw new Error('选择类型无效。');
  try {
    if (process.platform === 'win32') return await selectWindows(config);
    if (process.platform === 'darwin') return await selectMac(config);
    return await selectLinux(config);
  } catch (error) {
    if (error?.code === 1 || error?.code === 130) return [];
    const platformName = process.platform === 'linux' ? '请安装 zenity 后重试。' : '请检查本机系统文件选择器后重试。';
    throw new Error(`无法打开本机${config.title}窗口，${platformName}`);
  }
}
