const PLATFORM_TARGETS = Object.freeze({
  xiaohongshu: {
    rootUrl: 'https://www.xiaohongshu.com/explore',
    host: /(^|\.)xiaohongshu\.com$/i,
    priority: [/\/search_result/i, /\/explore\/?(?:[?#]|$)/i, /\/user\/profile/i, /\/explore\//i],
  },
  douyin: {
    rootUrl: 'https://www.douyin.com/',
    host: /(^|\.)douyin\.com$/i,
    priority: [/\/search/i, /\/user\//i, /\/video\//i],
  },
  bilibili: {
    rootUrl: 'https://www.bilibili.com/',
    host: /(^|\.)bilibili\.com$/i,
    priority: [/\/video\//i, /\/space\.bilibili\.com/i, /\/search/i],
  },
});

export function platformTargetConfig(platformId) {
  return PLATFORM_TARGETS[platformId] || null;
}

export function isPlatformTarget(target, platformId) {
  const config = platformTargetConfig(platformId);
  if (!config) return false;
  try {
    return config.host.test(new URL(String(target?.url || '')).hostname);
  } catch {
    return false;
  }
}

export function relayTargetSummary(targets, platformId) {
  const list = Array.isArray(targets) ? targets : [];
  const pages = list.filter((target) => String(target?.type || 'page') === 'page');
  const platformPages = pages.filter((target) => isPlatformTarget(target, platformId));
  const securityPages = platformPages.filter(isSecurityRestrictionTarget);
  const pressureReasons = [];

  if (list.length >= 9) pressureReasons.push('target_count');
  if (platformPages.length >= 3) pressureReasons.push('duplicate_target_pages');
  if (securityPages.length) pressureReasons.push('security_restriction');
  if (!platformPages.length) pressureReasons.push('missing_platform_page');

  return {
    platformId,
    targetCount: list.length,
    pageCount: pages.length,
    platformTabs: platformPages.length,
    platformPages: platformPages.length,
    unrelatedPages: pages.length - platformPages.length,
    iframeCount: list.filter((target) => target?.type === 'iframe').length,
    workerCount: list.filter((target) => /worker$/i.test(String(target?.type || ''))).length,
    securityPages: securityPages.length,
    pressure: pressureReasons.length ? 'high' : 'normal',
    pressureReasons,
    recoveryRecommended: pressureReasons.length > 0,
  };
}

export function planRelayRecovery(targets, platformId) {
  const list = Array.isArray(targets) ? targets : [];
  const summary = relayTargetSummary(list, platformId);
  const pages = list.filter((target) => String(target?.type || 'page') === 'page');
  const platformPages = pages.filter((target) => isPlatformTarget(target, platformId));
  const keeper = [...platformPages].sort((left, right) => targetPriority(left, platformId) - targetPriority(right, platformId))[0] || null;
  const replaceWithFreshPage = summary.recoveryRecommended || !keeper;
  const closeTargets = replaceWithFreshPage
    ? platformPages
    : platformPages.filter((target) => String(target?.id || '') !== String(keeper?.id || ''));

  return {
    summary,
    replaceWithFreshPage,
    keeper,
    closeTargets: closeTargets.filter((target) => String(target?.id || '').trim()),
  };
}

function targetPriority(target, platformId) {
  const config = platformTargetConfig(platformId);
  const url = String(target?.url || '');
  const index = config?.priority.findIndex((pattern) => pattern.test(url)) ?? -1;
  return index >= 0 ? index : 10;
}

function isSecurityRestrictionTarget(target) {
  const text = `${target?.title || ''} ${target?.url || ''}`.toLowerCase();
  return text.includes('/website-login/error')
    || text.includes('error_code=300013')
    || text.includes('access_denied');
}
