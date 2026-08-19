export const MAX_RANDOM_INTERVAL_MS = 10 * 60 * 1_000;

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampMilliseconds(value, maximum = MAX_RANDOM_INTERVAL_MS) {
  const parsed = finiteNumber(value);
  if (parsed === null) return 0;
  return Math.max(0, Math.min(Math.round(parsed), maximum));
}

export function normalizeRandomInterval(input, {
  defaultMinMs = 0,
  defaultMaxMs = defaultMinMs,
  maximumMs = MAX_RANDOM_INTERVAL_MS,
} = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const minMs = clampMilliseconds(source.minMs ?? defaultMinMs, maximumMs);
  const maxMs = clampMilliseconds(source.maxMs ?? defaultMaxMs, maximumMs);
  return {
    minMs: Math.min(minMs, maxMs),
    maxMs: Math.max(minMs, maxMs),
  };
}

export function randomIntervalMs(input, random = Math.random) {
  const range = normalizeRandomInterval(input);
  if (range.maxMs <= range.minMs) return range.minMs;
  const sample = Math.max(0, Math.min(0.999999999, Number(random()) || 0));
  return range.minMs + Math.floor(sample * (range.maxMs - range.minMs + 1));
}

export function createRandomIntervalController(input, { random = Math.random, sleep } = {}) {
  const range = normalizeRandomInterval(input);
  const wait = typeof sleep === 'function'
    ? sleep
    : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  let waitCount = 0;
  let totalWaitMs = 0;
  let lastWaitMs = 0;

  return {
    range,
    get enabled() {
      return range.maxMs > 0;
    },
    snapshot() {
      return {
        minMs: range.minMs,
        maxMs: range.maxMs,
        waitCount,
        totalWaitMs,
        lastWaitMs,
      };
    },
    async wait() {
      const milliseconds = randomIntervalMs(range, random);
      if (milliseconds <= 0) return 0;
      await wait(milliseconds);
      waitCount += 1;
      totalWaitMs += milliseconds;
      lastWaitMs = milliseconds;
      return milliseconds;
    },
  };
}
