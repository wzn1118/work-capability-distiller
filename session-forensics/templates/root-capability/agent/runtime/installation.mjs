import path from 'node:path';
import process from 'node:process';

function nodeMajor() {
  return Number(String(process.versions.node || '0').split('.')[0]) || 0;
}

function launchFiles(platform) {
  if (platform === 'win32') {
    return {
      oneClickInstall: 'install-and-start.cmd',
      directLaunch: 'launch.cmd',
      manual: '双击 launch.cmd 即可启动，不需要 npm install。',
    };
  }
  return {
    oneClickInstall: 'install-and-start.sh',
    directLaunch: 'launch.sh',
    manual: '在终端运行 sh launch.sh，不需要 npm install。',
  };
}

export function inspectInstallation(agentRoot, stateRoot) {
  const platform = process.platform;
  const ready = nodeMajor() >= 18;
  return {
    distribution: '可解压即用的独立能力包',
    ready,
    node: {
      version: process.version,
      minimum: '18.0.0',
      ready,
    },
    dependencies: {
      thirdPartyPackages: 0,
      installCommand: '无需 npm install',
    },
    state: {
      mode: '按当前系统用户独立保存',
      persistent: true,
      packageDirectoryReadOnlySupported: true,
      locationHint: path.basename(stateRoot),
    },
    launch: launchFiles(platform),
    platform,
    agentRoot: path.basename(agentRoot),
  };
}
