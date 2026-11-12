import { isDeepStrictEqual } from 'node:util';
import type { ToolCall, ToolResult } from '../../contracts/src/index.js';
import { FileSystemAdapter } from '../../tool-runtime/src/adapters/file-adapter.js';
import { RepositoryAdapter } from '../../tool-runtime/src/adapters/repo-adapter.js';
import { verifyMissionEvidence, type MissionStep } from './mission-plan.js';

export type OutcomeStatus = 'COMPLETED_VERIFIED' | 'FAILED_VERIFICATION';

export interface OutcomeEvidence {
  stepId: string;
  toolName: string;
  toolCallId: string;
  checkedAt: number;
  verified: boolean;
  reason: string;
}
export interface VerifiedOutcome {
  status: OutcomeStatus;
  checkedAt: number;
  evidence: OutcomeEvidence[];
}

/**
 * Independent outcome verification: the planner's claims and the original tool
 * result are insufficient. Reobserve the same filesystem and git state through
 * independent readback adapters, failing on mismatches or missing operations.
 * This does not certify external mutations or browser submissions.
 */
export async function verifyFinalMissionOutcome(
  steps: readonly MissionStep[],
  calls: readonly ToolCall[],
  results: readonly ToolResult[],
  workspaceRoot: string
): Promise<VerifiedOutcome> {
  const evidence: OutcomeEvidence[] = [];
  const files = new FileSystemAdapter(workspaceRoot);
  const repo = new RepositoryAdapter(workspaceRoot);
  if (steps.length < 1 || steps.length !== calls.length || steps.length !== results.length) {
    return {
      status: 'FAILED_VERIFICATION', checkedAt: Date.now(), evidence: [{
        stepId: 'mission', toolName: 'mission', toolCallId: '',
        checkedAt: Date.now(), verified: false,
        reason: 'The number of actual tool calls and results does not match the mission plan'
      }]
    };
  }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i], call = calls[i], result = results[i];
    const checkedAt = Date.now();
    const correctCall = step.toolName === call.name &&
      isDeepStrictEqual(step.arguments, call.arguments) &&
      Boolean(result && result.toolCallId);
    const verifiedEnvelope = correctCall && verifyMissionEvidence(step, result).verified;
    let reason = correctCall ? 'Independent readback matched' : 'Wrong tool, arguments, or missing call result';
    let verified = false;
    if (verifiedEnvelope) {
      try {
        const output = result.output as any;
        switch (step.toolName) {
          case 'file_system_read': {
            const actual = await files.read(String(step.arguments.filePath));
            verified = output.filePath === actual.filePath &&
              output.content === actual.content && output.sizeBytes === actual.sizeBytes &&
              output.truncated === actual.truncated;
            break;
          }
          case 'file_system_list': {
            const actual = await files.list(String(step.arguments.path || '.'));
            verified = output.directory === actual.directory &&
              isDeepStrictEqual(
                [...output.entries].sort((a: any, b: any) => a.name.localeCompare(b.name)),
                [...actual.entries].sort((a, b) => a.name.localeCompare(b.name))
              );
            break;
          }
          case 'repo_git_status': {
            const actual = await repo.getStatus();
            verified = actual.headSha !== 'unknown' && output.headSha === actual.headSha &&
              output.branch === actual.branch && isDeepStrictEqual(output.modified, actual.modified) &&
              isDeepStrictEqual(output.untracked, actual.untracked);
            break;
          }
          case 'repo_git_log': {
            const actual = await repo.getLog(Number(step.arguments.count || 5));
            verified = actual.length > 0 && isDeepStrictEqual(output, actual);
            break;
          }
          default:
            reason = 'No independent verifier for this tool';
        }
        if (!verified && !reason.startsWith('No independent')) {
          reason = 'Independent readback does not match the recorded tool result';
        }
      } catch (err: any) {
        reason = 'Independent readback failed: ' + String(err?.message || err);
      }
    } else if (correctCall) {
      reason = verifyMissionEvidence(step, result).reason;
    }
    evidence.push({ stepId: step.id, toolName: step.toolName, toolCallId: call.id, checkedAt, verified, reason });
    if (!verified) break;
  }
  return {
    status: evidence.length === steps.length && evidence.every(item => item.verified)
      ? 'COMPLETED_VERIFIED' : 'FAILED_VERIFICATION',
    checkedAt: Date.now(), evidence
  };
}
