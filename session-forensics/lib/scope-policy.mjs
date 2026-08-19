export const CONTEXT_MODES = Object.freeze({
  CONVERSATION_ONLY: 'conversation-only',
  PROJECT_RELEVANT: 'project-relevant',
  PROJECT_FULL: 'project-full',
  WORKSPACE_RELEVANT: 'workspace-relevant',
});

export const PROJECT_SCOPES = Object.freeze({
  SESSIONS_ONLY: 'sessions-only',
  PROJECT: 'project',
  WORKSPACE: 'workspace',
});

const CONTEXT_MODE_SET = new Set(Object.values(CONTEXT_MODES));
const PROJECT_SCOPE_SET = new Set(Object.values(PROJECT_SCOPES));

export function normalizeContextMode(value, { projectScope = '', projectConfirmed = false } = {}) {
  const requested = String(value || '').trim();
  if (CONTEXT_MODE_SET.has(requested)) return requested;
  if (!projectConfirmed) return CONTEXT_MODES.CONVERSATION_ONLY;
  if (projectScope === PROJECT_SCOPES.WORKSPACE) return CONTEXT_MODES.WORKSPACE_RELEVANT;
  if (projectScope === PROJECT_SCOPES.PROJECT) return CONTEXT_MODES.PROJECT_RELEVANT;
  return CONTEXT_MODES.CONVERSATION_ONLY;
}

export function normalizeProjectScope(value, { contextMode = '', workspaceSelected = false, projectConfirmed = false } = {}) {
  const requested = String(value || '').trim();
  if (PROJECT_SCOPE_SET.has(requested)) {
    if (requested === PROJECT_SCOPES.WORKSPACE && !workspaceSelected && !projectConfirmed) return PROJECT_SCOPES.SESSIONS_ONLY;
    if (requested !== PROJECT_SCOPES.SESSIONS_ONLY && !projectConfirmed) return PROJECT_SCOPES.SESSIONS_ONLY;
    return requested;
  }
  if (contextMode === CONTEXT_MODES.WORKSPACE_RELEVANT && workspaceSelected && projectConfirmed) return PROJECT_SCOPES.WORKSPACE;
  if ((contextMode === CONTEXT_MODES.PROJECT_RELEVANT || contextMode === CONTEXT_MODES.PROJECT_FULL) && projectConfirmed) return PROJECT_SCOPES.PROJECT;
  return PROJECT_SCOPES.SESSIONS_ONLY;
}

export function normalizeScopePolicy(selection = {}) {
  const projectContext = selection.projectContext && typeof selection.projectContext === 'object'
    ? selection.projectContext
    : {};
  const workspace = selection.workspaceSelection && typeof selection.workspaceSelection === 'object'
    ? selection.workspaceSelection
    : {};
  const explicitProjectScope = ['project', 'workspace'].includes(String(selection.projectScope || '').trim())
    && (Boolean(selection.projectPath) || (Array.isArray(workspace.workspaceIds) && workspace.workspaceIds.length > 0));
  const projectConfirmed = projectContext.confirmed === true || selection.projectConfirmed === true || explicitProjectScope;
  const workspaceSelected = Array.isArray(workspace.workspaceIds) && workspace.workspaceIds.length > 0;
  const projectScope = normalizeProjectScope(selection.projectScope, {
    contextMode: projectContext.mode,
    workspaceSelected,
    projectConfirmed,
  });
  const contextMode = normalizeContextMode(selection.contextMode || projectContext.mode, {
    projectScope,
    projectConfirmed,
  });
  const enabled = contextMode !== CONTEXT_MODES.CONVERSATION_ONLY && projectConfirmed;
  return {
    contextMode: enabled ? contextMode : CONTEXT_MODES.CONVERSATION_ONLY,
    projectScope: enabled ? projectScope : PROJECT_SCOPES.SESSIONS_ONLY,
    projectConfirmed: enabled,
    projectContext: {
      enabled,
      mode: enabled ? contextMode : 'none',
      confirmed: enabled,
      relevancePolicy: enabled ? (projectContext.relevancePolicy || 'evidence-ranked') : 'disabled',
      maxFiles: Number.isFinite(Number(projectContext.maxFiles)) ? Math.max(1, Math.min(500, Number(projectContext.maxFiles))) : 120,
      maxBytes: Number.isFinite(Number(projectContext.maxBytes)) ? Math.max(1024 * 1024, Math.min(200 * 1024 * 1024, Number(projectContext.maxBytes))) : 30 * 1024 * 1024,
    },
  };
}

export function isConversationOnly(selection = {}) {
  return normalizeScopePolicy(selection).contextMode === CONTEXT_MODES.CONVERSATION_ONLY;
}
