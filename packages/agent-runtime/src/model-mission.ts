import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ModelPolicy, ToolDefinition } from '../../contracts/src/index.js';
import type { ModelRouter } from '../../model-router/src/index.js';
import type { MissionStep } from './mission-plan.js';
import { hasMutationIntent } from './git-policy.js';

/**
 * V2: The model can propose a plan, but it cannot register tools, grant scopes,
 * authorize writes or choose execution policy. This phase admits only read-only
 * tools whose outputs have independent observable verification.
 */
const ToolNameSchema = z.enum([
  'file_system_list', 'file_system_read', 'repo_git_status', 'repo_git_log',
  'browser_session_inspect'
]);
const SpecialistSchema = z.enum(['repository', 'files', 'research', 'verification']);
const StepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  purpose: z.string().min(5).max(300),
  toolName: ToolNameSchema,
  arguments: z.record(z.string(), z.unknown()),
  dependsOn: z.array(z.string()).max(5),
  specialist: SpecialistSchema
}).strict();

export const ModelMissionPlanSchema = z.object({
  version: z.literal(2),
  objective: z.string().min(1).max(10000),
  steps: z.array(StepSchema).min(1).max(6)
}).strict();

export type ModelMissionPlan = z.infer<typeof ModelMissionPlanSchema>;
export interface ModelMissionProgress {
  version: 2;
  plan: ModelMissionPlan;
  dispatched: number;
  verified: string[];
  currentCallId: string;
  planSignature: string;
}
export type AnyMissionProgress = ModelMissionProgress | import('./mission-plan.js').DurableMissionProgress;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}
function signature(prompt: string, plan: ModelMissionPlan, key: string): string {
  return createHmac('sha256', key).update(prompt).update('\0').update(canonical(plan)).digest('hex');
}
export function signModelMission(prompt: string, plan: ModelMissionPlan, key: string): string {
  if (key.length < 32) throw new Error('MODEL_MISSION_SIGNING_KEY_NOT_READY');
  return signature(prompt, plan, key);
}

/**
 * This is a capability-specific policy gate, independent from model instructions.
 * Every executable step must be read-only and grounded in the original request.
 * There are no arbitrary shell, browser-write, file-write or delegation actions.
 */
export function validateModelMission(
  prompt: string,
  untrustedPlan: unknown,
  definitions: ToolDefinition[],
  allowedScopes: string[] = []
): ModelMissionPlan {
  if (hasMutationIntent(prompt)) throw new Error('MODEL_MISSION_WRITE_NOT_CERTIFIED');
  const plan = ModelMissionPlanSchema.parse(untrustedPlan);
  if (plan.objective !== prompt) throw new Error('MODEL_MISSION_OBJECTIVE_MISMATCH');

  const available = new Map(definitions
    .filter(def => def.availability === 'READY' && def.permissionLevel === 'READ' &&
      (def.sideEffectLevel === 'READ' || def.sideEffectLevel === 'NONE'))
    .map(def => [def.name, def]));
  const prior = new Set<string>();
  const used = new Set<string>();
  for (const step of plan.steps) {
    if (used.has(step.id)) throw new Error('MODEL_MISSION_DUPLICATE_STEP');
    used.add(step.id);
    const tool = available.get(step.toolName);
    if (!tool) throw new Error('MODEL_MISSION_TOOL_NOT_AUTHORIZED');
    if (!tool.permissionScopes.every(scope => allowedScopes.includes(scope) || allowedScopes.includes('*'))) {
      throw new Error('MODEL_MISSION_SCOPE_DENIED');
    }
    if (!step.dependsOn.every(id => prior.has(id)) ||
      (prior.size > 0 && !step.dependsOn.includes(plan.steps[prior.size - 1].id))) {
      throw new Error('MODEL_MISSION_DEPENDENCY_INVALID');
    }
    if (prior.size === 0 && step.dependsOn.length !== 0) throw new Error('MODEL_MISSION_DEPENDENCY_INVALID');
    if (step.toolName === 'file_system_read') {
      const name = step.arguments.filePath;
      if (typeof name !== 'string' || name.length > 200 || name.startsWith('/') ||
          name.includes('..') || /^[A-Za-z]:/.test(name) || name.includes('\0') ||
          !prompt.replace(/\\/g, '/').includes(name.replace(/\\/g, '/'))) {
        throw new Error('MODEL_MISSION_FILE_TARGET_NOT_IN_REQUEST');
      }
      if (Object.keys(step.arguments).length !== 1) throw new Error('MODEL_MISSION_UNEXPECTED_ARGUMENT');
    } else if (step.toolName === 'file_system_list') {
      if (!/\b(files?|folders?|directory|workspace|repository|repo|project|codebase)\b/i.test(prompt) ||
          step.arguments.path !== '.' || Object.keys(step.arguments).length !== 1) {
        throw new Error('MODEL_MISSION_UNGROUNDED_DIRECTORY');
      }
    } else if (step.toolName === 'repo_git_log') {
      if (!/\b(git|repo|repository|commits?|history|codebase)\b/i.test(prompt) ||
          !Number.isInteger(step.arguments.count) || Number(step.arguments.count) < 1 ||
          Number(step.arguments.count) > 20 || Object.keys(step.arguments).length !== 1) {
        throw new Error('MODEL_MISSION_GIT_LOG_INVALID');
      }
    } else if (step.toolName === 'repo_git_status') {
      if (!/\b(git|repo|repository|codebase|branch|commit|status|revision)\b/i.test(prompt) ||
          Object.keys(step.arguments).length !== 0) {
        throw new Error('MODEL_MISSION_GIT_STATUS_INVALID');
      }
    }
    else if (step.toolName === 'browser_session_inspect') {
      const sessionId=step.arguments.sessionId;
      if(typeof sessionId!=='string' ||
        !/^bs_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId) ||
        Object.keys(step.arguments).length!==1 ||
        !prompt.includes(sessionId) ||
        !/\b(browser|session|page|tab)\b/i.test(prompt)) {
        throw new Error('MODEL_MISSION_BROWSER_SESSION_NOT_GROUNDED');
      }
    }
    const expectedSpecialist = step.toolName === 'browser_session_inspect'
      ? 'research' : step.toolName.startsWith('repo_') ? 'repository' : 'files';
    if (step.specialist !== expectedSpecialist) throw new Error('MODEL_MISSION_SPECIALIST_MISMATCH');
    prior.add(step.id);
  }
  return plan;
}

export function validateStoredModelMission(
  prompt: string,
  progress: ModelMissionProgress,
  key: string,
  definitions: ToolDefinition[],
  allowedScopes: string[]
): boolean {
  try {
    if (progress?.version !== 2 || !Number.isInteger(progress.dispatched) ||
      progress.dispatched < 1 || progress.dispatched > progress.plan?.steps?.length ||
      typeof progress.currentCallId !== 'string' || !progress.currentCallId ||
      !Array.isArray(progress.verified) || progress.verified.length > progress.dispatched ||
      !/^[0-9a-f]{64}$/.test(progress.planSignature || '') || key.length < 32) return false;
    const parsed = validateModelMission(prompt, progress.plan, definitions, allowedScopes);
    const wanted = Buffer.from(signature(prompt, parsed, key), 'hex');
    const actual = Buffer.from(progress.planSignature, 'hex');
    return actual.length === wanted.length && timingSafeEqual(actual, wanted) &&
      progress.verified.every((id, i) => parsed.steps[i]?.id === id);
  } catch {
    return false;
  }
}

export async function compileModelMission(
  prompt: string,
  router: ModelRouter,
  policy: ModelPolicy,
  definitions: ToolDefinition[],
  scopes: string[],
  signingKey: string
): Promise<{plan: ModelMissionPlan; planSignature: string}> {
  if (signingKey.length < 32) throw new Error('MODEL_MISSION_SIGNING_KEY_NOT_READY');
  const visible = definitions.filter(def =>
    ['file_system_list', 'file_system_read', 'repo_git_status', 'repo_git_log',
      'browser_session_inspect'].includes(def.name) &&
    def.permissionLevel === 'READ' && def.availability === 'READY' &&
    (def.sideEffectLevel === 'READ' || def.sideEffectLevel === 'NONE') &&
    def.permissionScopes.every(scope => scopes.includes(scope) || scopes.includes('*'))
  );
  if (!visible.length) throw new Error('MODEL_MISSION_NO_AUTHORIZED_TOOLS');
  if (hasMutationIntent(prompt)) throw new Error('MODEL_MISSION_WRITE_NOT_CERTIFIED');
  const adapter = router.getAdapter(policy);
  if (adapter.provider === 'mock') throw new Error('MODEL_MISSION_LIVE_PROVIDER_REQUIRED');
  const response = await adapter.complete([
    { role: 'system', content:
      'Plan a bounded read-only task as one STRICT JSON object, no markdown. Schema: ' +
      '{"version":2,"objective":"exact user request","steps":[{"id":"step_1","purpose":"clear purpose",' +
      '"toolName":"tool name","arguments":{},"dependsOn":[],"specialist":"files or repository or research"}]}. ' +
      'For every later step dependsOn must include immediately previous step ID. ' +
      'Only use listed authorized real tools. No writes, shells, uploads, invented targets, or fake steps. ' +
      'Read files ONLY when file path is explicitly present in the user request. ' +
      'For browser_session_inspect, use only the exact bs_UUID session ID explicitly in the request, and only for read-only observation; specialist must be research. ' +
      'If the objective cannot be achieved with the available tools return {"error":"unsupported"}.' },
    { role: 'system', content: 'Authorized tool definitions: ' + JSON.stringify(visible.map(d => ({
      name: d.name, description: d.description, parameters: d.parameters
    }))) },
    { role: 'user', content: prompt }
  ], { ...policy, temperature: 0, maxTokens: Math.min(policy.maxTokens, 2000) });
  let json: unknown;
  try { json = JSON.parse(response.text.trim()); }
  catch { throw new Error('MODEL_MISSION_INVALID_JSON'); }
  const plan = validateModelMission(prompt, json, visible, scopes);
  return { plan, planSignature: signature(prompt, plan, signingKey) };
}
