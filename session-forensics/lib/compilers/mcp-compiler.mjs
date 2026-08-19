import { targetManifest } from './shared-runtime.mjs';

export function compileMcpTarget(capability) {
  const manifest = targetManifest(capability, 'mcp', ['mcp/server.mjs', 'mcp/tool-schema.json']);
  return {
    ...manifest,
    tool: {
      name: capability.id,
      description: capability.summary,
      inputSchema: capability.inputSchema,
      outputSchema: capability.outputSchema,
      acceptance: capability.acceptance,
      security: capability.security,
    },
  };
}
