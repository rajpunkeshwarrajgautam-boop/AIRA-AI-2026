import { SpecialistRole } from '../../../contracts/src/index.js';

/**
 * Server-owned durable worker tool policy. Task payloads may narrow this list,
 * but can never expand it. Adding a tool requires an intentional policy change
 * here as well as registration with ToolGateway.
 */
export const DURABLE_SPECIALIST_TOOL_ALLOWLIST: Readonly<Record<SpecialistRole, readonly string[]>> = Object.freeze({
  analyst: Object.freeze(['calculator']),
  verifier: Object.freeze([]),
  researcher: Object.freeze([]),
  planner: Object.freeze([]),
  coder: Object.freeze([]),
  browser: Object.freeze([]),
  document: Object.freeze([]),
  automation: Object.freeze([]),
  synthesizer: Object.freeze([])
});

export interface ToolScopeValidation {
  valid: boolean;
  requested: string[];
  error?: string;
}

export function validateDurableToolScopes(role: SpecialistRole, requested: unknown): ToolScopeValidation {
  if (!Array.isArray(requested) || requested.some((tool) => typeof tool !== 'string' || tool.trim() !== tool || tool.length === 0)) {
    return { valid: false, requested: [], error: 'Durable tool allowlist must be an array of non-empty canonical tool names.' };
  }

  const normalized = [...new Set(requested as string[])];
  const serverAllowed = DURABLE_SPECIALIST_TOOL_ALLOWLIST[role] || [];
  const unauthorized = normalized.filter((tool) => !serverAllowed.includes(tool));
  if (unauthorized.length > 0) {
    return {
      valid: false,
      requested: normalized,
      error: `Role "${role}" is not authorized for durable tool(s): ${unauthorized.join(', ')}.`
    };
  }
  return { valid: true, requested: normalized };
}
