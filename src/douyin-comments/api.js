function localApiOriginFromQuery() {
  if (typeof window === 'undefined') return '';
  const rawOrigin = new URLSearchParams(window.location.search).get('api');
  if (!rawOrigin) return '';
  try {
    const origin = new URL(rawOrigin);
    const loopback = origin.hostname === '127.0.0.1' || origin.hostname === 'localhost';
    if (origin.protocol !== 'http:' || !loopback || origin.pathname !== '/' || origin.search || origin.hash) return '';
    return origin.origin;
  } catch {
    return '';
  }
}

const localApiOrigin = localApiOriginFromQuery();

export const apiPath = (value) => localApiOrigin ? `${localApiOrigin}${value}` : value;

export async function requestJson(path, options = {}) {
  const response = await fetch(apiPath(path), {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `HTTP ${response.status}`);
    error.code = payload?.error?.code || 'HTTP_ERROR';
    error.action = payload?.error?.action || '';
    throw error;
  }
  return payload;
}

export function artifactHref(jobId, fileName) {
  return apiPath(`/api/douyin-comment-jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(fileName)}`);
}
