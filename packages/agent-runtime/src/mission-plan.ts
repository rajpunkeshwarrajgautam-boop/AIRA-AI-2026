import type { ToolResult } from '../../contracts/src/index.js';
import { isDeepStrictEqual } from 'node:util';
import { hasMutationIntent } from './git-policy.js';

export type MissionToolName = 'file_system_list' | 'file_system_read' |
  'repo_git_status' | 'repo_git_log' | 'browser_session_inspect';

export interface MissionStep {
  id: string;
  purpose: string;
  toolName: MissionToolName;
  arguments: Record<string, unknown>;
}

export interface MissionPlan {
  version: 1;
  objective: string;
  steps: MissionStep[];
}

export interface DurableMissionProgress {
  version: 1;
  plan: MissionPlan;
  /** Number of steps that have been dispatched, not necessarily verified. */
  dispatched: number;
  verified: string[];
  currentCallId: string;
}

function step(id: string, purpose: string, toolName: MissionToolName, args: Record<string, unknown>): MissionStep {
  return { id, purpose, toolName, arguments: args };
}

/**
 * Compile only tasks that the real runtime has enough tools to complete.
 * Never turn a generic "build an app" objective into a fake 3-step read-only mission.
 * This compiler is intentionally bounded; a general model planner may propose
 * broader plans later, but those plans must still pass an execution policy gate.
 */
export function compileSupportedMission(prompt: string): MissionPlan | null {
  const text = prompt.trim();
  if (!text || hasMutationIntent(text)) return null;

  const workspaceAudit =
    /\b(?:inspect|list)\s+(?:the\s+)?workspace\s+files\b/i.test(text) &&
    /\b(?:git|repo)\s+status\b/i.test(text) &&
    /\b(?:repo|repository|commit)\s+history\b/i.test(text);
  if (workspaceAudit) {
    return {
      version: 1, objective: text, steps: [
        step('workspace', 'Inspect the actual workspace directory', 'file_system_list', { path: '.' }),
        step('status', 'Inspect the actual repository status', 'repo_git_status', {}),
        step('history', 'Inspect actual repository commits', 'repo_git_log', { count: 5 })
      ]
    };
  }

  const compareFiles = /\b(?:compare|contrast|differences?|both|each|between)\b/i.test(text) &&
    /\b(?:read|inspect|analy[sz]e|compare|review|summarize)\b/i.test(text);
  if (compareFiles) {
    const paths = Array.from(text.matchAll(/(?:^|[\s,(])((?:[a-zA-Z0-9_.-]+[\/\\])*[a-zA-Z0-9_.-]+\.(?:tsx?|jsx?|json|md|ya?ml|html?|css|scss|py|go|rs|sql|txt|csv))(?=$|[\s,;:)])/gi))
      .map(match => match[1].replace(/\\/g, '/'))
      .filter(filePath => !filePath.startsWith('/') && !filePath.includes('..'));
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.length >= 2 && uniquePaths.length <= 6) {
      return {
        version: 1, objective: text,
        steps: uniquePaths.map((filePath, index) =>
          step('file_' + (index + 1), 'Read explicit file ' + filePath, 'file_system_read', { filePath }))
      };
    }
  }

  const inspectGit = /\b(?:git|repo)\s+status\b/i.test(text) &&
    /\b(?:git\s+log|recent\s+commits?|latest\s+commits?|repository\s+history|repo\s+history)\b/i.test(text);
  if (inspectGit) {
    return {
      version: 1, objective: text,
      steps: [
        step('status', 'Inspect current git status', 'repo_git_status', {}),
        step('history', 'Inspect latest commits', 'repo_git_log', { count: 5 })
      ]
    };
  }

  return null;
}

/** Check observable tool output, not just a tool returning an empty success envelope. */
export function verifyMissionEvidence(
  missionStep: MissionStep,
  result?: ToolResult
): { verified: boolean; reason: string } {
  if (!result || result.isError || result.error) {
    return { verified: false, reason: String(result?.error || 'Missing or failed tool result') };
  }
  const output = result.output as any;
  if (missionStep.toolName === 'browser_session_inspect') {
    if (output && output.sessionId === missionStep.arguments.sessionId &&
      output.operation === 'inspect' && output.workerVerified === true &&
      typeof output.url === 'string' && /^https?:\/\//.test(output.url) &&
      typeof output.title === 'string' && typeof output.heading === 'string' &&
      typeof output.text === 'string') {
      return { verified: true, reason: 'Browser observation received; independent readback is still required' };
    }
    return { verified: false, reason: 'Browser evidence missing or for wrong session' };
  }
  if (missionStep.toolName === 'file_system_list') {
    if (output && Array.isArray(output.entries) && typeof output.directory === 'string') {
      return { verified: true, reason: 'Directory listing received' };
    }
    return { verified: false, reason: 'Directory listing lacks verifiable entries' };
  }
  if (missionStep.toolName === 'file_system_read') {
    if (output && output.filePath === missionStep.arguments.filePath &&
        typeof output.content === 'string' && typeof output.sizeBytes === 'number') {
      return { verified: true, reason: 'Requested file content received' };
    }
    return { verified: false, reason: 'File read lacks content or matches a different file' };
  }
  if (missionStep.toolName === 'repo_git_status') {
    if (output && typeof output.branch === 'string' &&
        typeof output.headSha === 'string' && output.headSha !== 'unknown' &&
        Array.isArray(output.modified) && Array.isArray(output.untracked)) {
      return { verified: true, reason: 'Git status and revision inspected' };
    }
    return { verified: false, reason: 'Git status lacks a verified revision' };
  }
  if (missionStep.toolName === 'repo_git_log') {
    if (Array.isArray(output) && output.length > 0 &&
        output.every(entry => typeof entry.sha === 'string' && entry.sha &&
          typeof entry.message === 'string')) {
      return { verified: true, reason: 'Repository commit history received' };
    }
    return { verified: false, reason: 'No verifiable repository history returned' };
  }
  return { verified: false, reason: 'Unsupported mission verification type' };
}

/**
 * Cross-check persisted plan against the original prompt before any continuation.
 * The client may send context; it must never be allowed to inject executable steps.
 */
export function validateDurableMission(prompt: string, progress: DurableMissionProgress): boolean {
  const expected = compileSupportedMission(prompt);
  if (!expected || progress?.version !== 1 || progress?.plan?.version !== 1 ||
      !Number.isInteger(progress.dispatched) || progress.dispatched < 1 ||
      progress.dispatched > expected.steps.length || !Array.isArray(progress.verified) ||
      typeof progress.currentCallId !== 'string') return false;

  return isDeepStrictEqual(progress.plan, expected) &&
    progress.verified.length <= progress.dispatched &&
    progress.verified.every((id, index) => id === expected.steps[index].id);
}
