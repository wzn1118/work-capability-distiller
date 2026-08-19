import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyseParsedSession, parseCodexSessionFile } from './lib/session-forensics.mjs';
import { compileConversationTargets } from './lib/compilers/compiler-facade.mjs';
import { migrateIRBundle } from './lib/ir/migrations.mjs';

test('golden corpus compiles one Capability IR into three target contracts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-golden-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.resolve('session-forensics/fixtures/golden/basic-codex.jsonl');
  const parsed = await parseCodexSessionFile(source);
  const analysis = analyseParsedSession(parsed, { includeEvidence: true });
  const result = compileConversationTargets({ parsed, analysis });
  assert.equal(result.schemaVersion, 'conversation-compiler-result/v1');
  assert.equal(result.summary.capabilityCount >= 1, true);
  assert.equal(result.summary.targetKinds.length, 3);
  assert.equal(result.targets.length, result.summary.capabilityCount * 3);
  assert.ok(result.targets.some((item) => item.target === 'skill' && item.files.includes('skill/SKILL.md')));
  assert.ok(result.targets.some((item) => item.target === 'mcp' && item.tool?.inputSchema));
  assert.ok(result.targets.some((item) => item.target === 'agent-ui' && item.viewModel?.steps.length));
  assert.ok(result.ir.trace.events.some((event) => event.kind === 'tool_call'));
  assert.ok(result.ir.trace.events.some((event) => event.kind === 'tool_result'));
});

test('migration facade upgrades a legacy event bundle and keeps stable fingerprints', () => {
  const legacy = {
    trace: { sessionId: 'legacy-001', events: [{ kind: 'message', actor: 'user', payload: { text: 'hello' } }] },
    capabilities: [{ id: 'legacy-cap', title: 'Legacy capability', summary: 'Migrated capability', steps: [{ instruction: 'run', evidenceRefs: ['legacy-1'] }], provenance: { sourceSessions: ['legacy-001'] } }],
  };
  const first = migrateIRBundle(legacy);
  const second = migrateIRBundle(legacy);
  assert.equal(first.value.schemaVersion, 'conversation-ir-bundle/v1');
  assert.ok(first.changes.includes('legacy-trace -> trace-ir/v1'));
  assert.equal(first.value.trace.fingerprint, second.value.trace.fingerprint);
  assert.equal(first.value.capabilities[0].fingerprint, second.value.capabilities[0].fingerprint);
});
