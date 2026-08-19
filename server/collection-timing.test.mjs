import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRandomIntervalController,
  normalizeRandomInterval,
  randomIntervalMs,
} from './collection-timing.mjs';

test('normalizes random collection intervals into a bounded ordered range', () => {
  assert.deepEqual(normalizeRandomInterval({ minMs: 5_000, maxMs: 1_000 }), { minMs: 1_000, maxMs: 5_000 });
  assert.deepEqual(normalizeRandomInterval({ minMs: -1, maxMs: 99_999_999 }), { minMs: 0, maxMs: 600_000 });
  assert.deepEqual(normalizeRandomInterval(null), { minMs: 0, maxMs: 0 });
});

test('samples an inclusive random interval and records waits', async () => {
  assert.equal(randomIntervalMs({ minMs: 1_000, maxMs: 2_000 }, () => 0), 1_000);
  assert.equal(randomIntervalMs({ minMs: 1_000, maxMs: 2_000 }, () => 0.999999), 2_000);
  const waits = [];
  const controller = createRandomIntervalController(
    { minMs: 100, maxMs: 200 },
    { random: () => 0.5, sleep: async (milliseconds) => waits.push(milliseconds) },
  );
  assert.equal(await controller.wait(), 150);
  assert.deepEqual(waits, [150]);
  assert.deepEqual(controller.snapshot(), {
    minMs: 100,
    maxMs: 200,
    waitCount: 1,
    totalWaitMs: 150,
    lastWaitMs: 150,
  });
});
