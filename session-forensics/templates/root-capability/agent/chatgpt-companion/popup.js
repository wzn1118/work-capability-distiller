const deploymentReloadRequested = new URLSearchParams(location.search).get('reload') === '1';

if (deploymentReloadRequested) {
  document.body.innerHTML = '<main><h1>正在更新网页聊天记录伴侣</h1><p id="state" role="status">正在重新加载扩展，现有网页登录状态不会改变。</p></main>';
  chrome.storage.local.get(['deploymentReloadAt'], (stored) => {
    const lastReloadAt = Number(stored.deploymentReloadAt || 0);
    if (Date.now() - lastReloadAt < 10_000) {
      document.querySelector('#state').textContent = '扩展已经重新加载，可以关闭此页。';
      return;
    }
    chrome.storage.local.set({ deploymentReloadAt: Date.now() }, () => chrome.runtime.reload());
  });
} else {
const $ = (selector) => document.querySelector(selector);
let discoveredBridgePath = '';

async function message(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (!response?.ok) throw new Error(response?.error || '浏览器伴侣操作失败。');
  return response;
}

function setState(text, type = '') {
  $('#state').textContent = text;
  $('#state').className = type;
}

async function refresh() {
  try {
    const state = await message({ type: 'companion:state' });
    $('#agent-url').value = state.agentUrl || $('#agent-url').value;
    if (state.preferredPlatform) $('#platform').value = state.preferredPlatform;
    const current = state.pagePlatformName ? `当前网页：${state.pagePlatformName}。` : '';
    if (state.connected) {
      setState(`已连接。${current}请回到独立 Agent 主工作台读取对话。`, 'success');
      return;
    }
    if (state.token) {
      setState('连接暂时中断，正在自动重新查找当前工作台...', '');
      const repaired = await autoPair({ silent: true });
      if (!repaired) setState(`连接暂时中断。${state.lastError || '请确认独立 Agent 仍在运行。'}`);
      return;
    }
    setState('正在自动查找当前工作台...', '');
    await autoPair({ silent: true });
  } catch (error) {
    setState(error.message, 'error');
  }
}

async function autoPair({ silent = false } = {}) {
  const button = $('#auto-pair');
  if (button) button.disabled = true;
  try {
    const found = await message({ type: 'companion:discover' });
    discoveredBridgePath = found.bridgePath || '';
    $('#agent-url').value = found.agentUrl || $('#agent-url').value;
    $('#pairing-code').value = found.pairingCode || '';
    if (found.platform) $('#platform').value = found.platform;
    const result = await message({ type: 'companion:auto-pair', platform: $('#platform').value });
    discoveredBridgePath = result.bridgePath || discoveredBridgePath;
    setState('已自动连接当前工作台。请回到工作台选择平台并读取聊天。', 'success');
    return result;
  } catch (error) {
    setState(silent ? '尚未找到当前工作台。请保持工作台页面打开后再点“自动发现并连接”。' : error.message, silent ? '' : 'error');
    if (!silent) throw error;
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

$('#pair').addEventListener('click', async () => {
  $('#pair').disabled = true;
  try {
    await message({ type: 'companion:pair', agentUrl: $('#agent-url').value, bridgePath: discoveredBridgePath, pairingCode: $('#pairing-code').value, platform: $('#platform').value });
    setState('配对成功。请回到独立 Agent 主工作台点击对应平台按钮读取。', 'success');
  } catch (error) { setState(error.message, 'error'); }
  finally { $('#pair').disabled = false; }
});
$('#auto-pair').addEventListener('click', () => autoPair());
$('#open-platform').addEventListener('click', () => message({ type: 'companion:open-platform', platform: $('#platform').value }).catch((error) => setState(error.message, 'error')));
$('#disconnect').addEventListener('click', async () => { await message({ type: 'companion:disconnect' }); setState('已断开连接。'); });
void refresh();
}
