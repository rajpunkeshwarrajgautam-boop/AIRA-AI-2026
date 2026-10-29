import { createHash } from 'node:crypto';
import { ApprovalRequest, ApprovalDecision, PermissionLevel } from '../../contracts/src/index.js';
import { db } from '../../db/src/index.js';

export interface ApprovalGrant {
  scope: 'SESSION' | 'ALWAYS';
  principalId: string;
  runId: string;
  tool: string;
  riskCeiling: PermissionLevel;
  workspaceId: string;
}

export interface AtomicApprovalResolution {
  request: ApprovalRequest;
  applied: boolean;
  grantHandled: boolean;
}

export type ApprovalResumptionState =
  | 'APPROVED_UNCLAIMED'
  | 'CLAIMED_NOT_DISPATCHED'
  | 'DISPATCHED_UNKNOWN'
  | 'COMPLETED_WITH_RESULT'
  | 'CANCELLED_REVOKED'
  | 'RECOVERABLY_FAILED';

interface ApprovalResumptionEventBase {
  id: string;
  approvalId: string;
  runId: string;
  principalId: string;
  workspaceId?: string;
  decision: ApprovalDecision;
  state: ApprovalResumptionState;
  attempts: number;
  fencingToken: number;
}

export type ApprovalResumptionEvent = ApprovalResumptionEventBase & (
  | { targetType: 'RUN'; workflowRunId?: never; workflowStepId?: never }
  | { targetType: 'WORKFLOW'; workflowRunId: string; workflowStepId: string }
);

export type ApprovalGrantRequest = Pick<ApprovalGrant, 'scope' | 'riskCeiling'>;

export type ApprovalResolutionTarget =
  | { type: 'RUN' }
  | { type: 'WORKFLOW'; workflowRunId: string; workflowStepId: string };

export interface OneTimeAuthorizationBinding {
  requestId: string;
  principalId: string;
  workspaceId: string;
  runId: string;
  toolCallId: string;
  toolId: string;
  toolName: string;
  permissionLevel: PermissionLevel;
  toolDefinitionVersion: number;
  toolPolicyFingerprint: string;
  arguments: unknown;
  claimId: string;
}

export interface ApprovalRepository {
  saveRequest(request: ApprovalRequest): Promise<void>;
  getRequest(id: string): Promise<ApprovalRequest | undefined>;
  getPendingForRun(runId: string): Promise<ApprovalRequest[]>;
  resolveRequest(id: string, decision: ApprovalDecision, resolvedBy: string): Promise<void>;
  resolvePendingRequest?(
    id: string,
    decision: ApprovalDecision,
    resolvedBy: string,
    grant?: ApprovalGrantRequest,
    issueOnceAuthorization?: boolean,
    target?: ApprovalResolutionTarget
  ): Promise<AtomicApprovalResolution>;
  claimOnceAuthorization?(binding: OneTimeAuthorizationBinding): Promise<boolean>;
  markOnceAuthorizationDispatched?(binding: OneTimeAuthorizationBinding): Promise<boolean>;
  finishOnceAuthorization?(requestId: string, claimId: string, outcome: 'COMPLETED' | 'FAILED'): Promise<boolean>;
  claimApprovalResumption?(owner: string, leaseMs: number, approvalId?: string): Promise<ApprovalResumptionEvent | undefined>;
  applyApprovalResumption?(event: ApprovalResumptionEvent, owner: string): Promise<boolean>;
  completeApprovalResumption?(eventId: string, result: unknown): Promise<boolean>;
  failApprovalResumption?(event: ApprovalResumptionEvent, owner: string, error: string): Promise<boolean>;
}

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  READ: 1,
  WRITE: 2,
  FINANCIAL: 3,
  DESTRUCTIVE: 4
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

async function hasActiveWorkspaceAuthority(
  queryable: any,
  principalId: string,
  workspaceId: string
): Promise<boolean> {
  if (!principalId || !workspaceId) return false;
  const authority = await queryable('principal_workspace_authorities')
    .where({ principal_id: principalId, workspace_id: workspaceId, state: 'ACTIVE' })
    .whereNull('revoked_at')
    .forUpdate()
    .first('principal_id');
  return Boolean(authority);
}

function stableGrantId(grant: ApprovalGrant): string {
  const scopeId = grant.scope === 'SESSION' ? grant.runId : 'all';
  const digest = createHash('sha256')
    .update(JSON.stringify([grant.scope, grant.principalId, grant.workspaceId, scopeId, grant.tool]))
    .digest('hex');
  return `gr_${digest}`;
}

function mapApprovalRow(row: any): ApprovalRequest {
  return {
    id: row.id,
    runId: row.run_id,
    toolCall: {
      id: row.tool_call_id,
      toolId: row.tool_id || row.tool_call_tool_id || `tool_${row.tool}`,
      name: row.tool,
      arguments: typeof row.arguments === 'string' ? JSON.parse(row.arguments) : row.arguments,
      timestamp: Number(row.started_at)
    },
    risk: row.risk || (row.permission_level === 'DESTRUCTIVE' ? 'critical' : row.permission_level === 'FINANCIAL' ? 'high' : 'medium'),
    title: `Authorize Action: ${row.tool}`,
    reason: row.reason || '',
    sanitizedPreview: typeof row.arguments === 'string' ? JSON.parse(row.arguments) : (row.arguments || {}),
    requestedAt: Number(row.created_at),
    workspaceId: row.run_workspace_id || row.workspace_id || undefined,
    permissionLevel: row.permission_level || undefined,
    toolDefinitionVersion: row.tool_definition_version ? Number(row.tool_definition_version) : undefined,
    toolPolicyFingerprint: row.tool_policy_fingerprint || undefined,
    decision: row.status === 'PENDING' ? undefined : row.status as ApprovalDecision,
    resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined,
    resolvedBy: row.resolved_by || undefined
  };
}

export class PostgresApprovalRepository implements ApprovalRepository {
  async saveRequest(request: ApprovalRequest): Promise<void> {
    await db.transaction(async (trx) => {
      const existingRun = await trx('runs').where({ id: request.runId }).first();
      if (!existingRun) throw new Error('Approval requires an existing authenticated parent run.');
      if (!existingRun.workspace_id || request.workspaceId !== existingRun.workspace_id) {
        throw new Error('Approval requires a workspace matching the authoritative parent run.');
      }
      if (!await hasActiveWorkspaceAuthority(trx, existingRun.principal_id, existingRun.workspace_id)) {
        throw new Error('Approval requires active workspace authority for the authenticated run owner.');
      }

      await trx('tool_calls').insert({
        id: request.toolCall.id,
        run_id: request.runId,
        tool: request.toolCall.name,
        tool_id: request.toolCall.toolId,
        permission: request.permissionLevel || 'READ',
        arguments: JSON.stringify(request.toolCall.arguments),
        status: 'PENDING',
        started_at: request.toolCall.timestamp || request.requestedAt
      }).onConflict('id').ignore();

      const toolCall = await trx('tool_calls').where({ id: request.toolCall.id }).first();
      const persistedArguments = typeof toolCall?.arguments === 'string'
        ? JSON.parse(toolCall.arguments)
        : toolCall?.arguments;
      if (
        !toolCall || toolCall.run_id !== request.runId || toolCall.tool !== request.toolCall.name ||
        (toolCall.tool_id && request.toolCall.toolId && toolCall.tool_id !== request.toolCall.toolId) ||
        fingerprint(persistedArguments) !== fingerprint(request.toolCall.arguments) ||
        (toolCall.permission && toolCall.permission !== (request.permissionLevel || 'READ'))
      ) {
        throw new Error('Approval tool-call identity conflicts with the persisted tool call.');
      }

      await trx('approvals').insert({
        id: request.id,
        run_id: request.runId,
        tool_call_id: request.toolCall.id,
        status: 'PENDING',
        permission_level: request.permissionLevel || 'READ',
        risk: request.risk,
        tool_definition_version: request.toolDefinitionVersion || null,
        tool_policy_fingerprint: request.toolPolicyFingerprint || null,
        argument_fingerprint: fingerprint(request.toolCall.arguments),
        once_state: 'NONE',
        reason: request.reason,
        created_at: request.requestedAt
      }).onConflict('id').ignore();

      const approval = await trx('approvals').where({ id: request.id }).first();
      if (
        !approval || approval.run_id !== request.runId || approval.tool_call_id !== request.toolCall.id ||
        approval.status !== 'PENDING' ||
        approval.permission_level !== (request.permissionLevel || 'READ') ||
        (Number(approval.tool_definition_version) || undefined) !== request.toolDefinitionVersion ||
        (approval.tool_policy_fingerprint || undefined) !== request.toolPolicyFingerprint ||
        approval.argument_fingerprint !== fingerprint(request.toolCall.arguments)
      ) {
        throw new Error('Approval request identity conflicts with an existing approval.');
      }
    });
  }

  async getRequest(id: string): Promise<ApprovalRequest | undefined> {
    const row = await db('approvals')
      .join('tool_calls', 'approvals.tool_call_id', 'tool_calls.id')
      .join('runs', 'approvals.run_id', 'runs.id')
      .where('approvals.id', id)
      .select('approvals.*', 'tool_calls.tool', 'tool_calls.tool_id', 'tool_calls.arguments', 'tool_calls.started_at', 'runs.workspace_id as run_workspace_id')
      .first();
    return row ? mapApprovalRow(row) : undefined;
  }

  async getPendingForRun(runId: string): Promise<ApprovalRequest[]> {
    const rows = await db('approvals')
      .join('tool_calls', 'approvals.tool_call_id', 'tool_calls.id')
      .join('runs', 'approvals.run_id', 'runs.id')
      .where('approvals.run_id', runId)
      .andWhere('approvals.status', 'PENDING')
      .select('approvals.*', 'tool_calls.tool', 'tool_calls.tool_id', 'tool_calls.arguments', 'tool_calls.started_at', 'runs.workspace_id as run_workspace_id');
    return rows.map(mapApprovalRow);
  }

  async resolveRequest(id: string, decision: ApprovalDecision, resolvedBy: string): Promise<void> {
    const rows = await db('approvals')
      .where({ id, status: 'PENDING' })
      .update({ status: decision, resolved_at: Date.now(), resolved_by: resolvedBy });
    if (rows !== 1) throw new Error('Approval is missing or has already been resolved.');
  }

  async resolvePendingRequest(
    id: string,
    decision: ApprovalDecision,
    resolvedBy: string,
    grant?: ApprovalGrantRequest,
    issueOnceAuthorization = false,
    target: ApprovalResolutionTarget = { type: 'RUN' }
  ): Promise<AtomicApprovalResolution> {
    return db.transaction(async (trx) => {
      const row = await trx('approvals')
        .join('tool_calls', 'approvals.tool_call_id', 'tool_calls.id')
        .join('runs', 'approvals.run_id', 'runs.id')
        .where('approvals.id', id)
        .select(
          'approvals.*',
          'tool_calls.tool',
          'tool_calls.tool_id',
          'tool_calls.arguments',
          'tool_calls.permission',
          'tool_calls.principal_id as tool_call_principal_id',
          'tool_calls.started_at',
          'runs.principal_id',
          'runs.workspace_id'
        )
        .forUpdate('approvals', 'tool_calls')
        .first();

      if (!row) throw new Error('Approval request not found.');
      if (row.principal_id !== resolvedBy) throw new Error('Approval resolver is not the run owner.');
      if (!row.workspace_id) throw new Error('Approval decision requires an authoritative parent-run workspace.');
      if (!await hasActiveWorkspaceAuthority(trx, row.principal_id, row.workspace_id)) {
        throw new Error('Approval decision requires active workspace authority for the authenticated run owner.');
      }
      if (row.tool_call_principal_id && row.tool_call_principal_id !== resolvedBy) {
        throw new Error('Approval tool-call principal does not match the run owner.');
      }

      if (row.status !== 'PENDING') {
        if (row.status === decision && row.resolved_by === resolvedBy) {
          return { request: mapApprovalRow(row), applied: false, grantHandled: true };
        }
        throw new Error('Approval request was already resolved with a different decision or resolver.');
      }

      const resolvedAt = Date.now();
      const affected = await trx('approvals')
        .where({ id, status: 'PENDING', run_id: row.run_id, tool_call_id: row.tool_call_id })
        .update({
          status: decision,
          resolved_at: resolvedAt,
          resolved_by: resolvedBy,
          ...(decision === 'ALLOW_ONCE' && issueOnceAuthorization ? { once_state: 'AVAILABLE' } : {})
        });
      if (affected !== 1) throw new Error('Approval decision lost a concurrent compare-and-set race.');

      if (grant && (decision === 'ALLOW_SESSION' || decision === 'ALLOW_ALWAYS_FOR_TOOL')) {
        if (!row.workspace_id) throw new Error('Reusable approval grants require an authoritative workspace.');
        const expectedScope = decision === 'ALLOW_SESSION' ? 'SESSION' : 'ALWAYS';
        if (grant.scope !== expectedScope) {
          throw new Error('Approval grant scope does not match the persisted decision.');
        }
        if (grant.riskCeiling !== row.permission_level) {
          throw new Error('Approval grant risk ceiling does not match the persisted request.');
        }
        const persistedGrant: ApprovalGrant = {
          ...grant,
          principalId: resolvedBy,
          runId: grant.scope === 'SESSION' ? row.run_id : '',
          tool: row.tool,
          workspaceId: row.workspace_id
        };
        const grantId = stableGrantId(persistedGrant);
        await trx('session_grants').insert({
          id: grantId,
          principal_id: persistedGrant.principalId,
          session_id: grant.scope === 'SESSION' ? persistedGrant.runId : null,
          workspace_id: row.workspace_id || null,
          tool: persistedGrant.tool,
          permission: grant.scope,
          risk_ceiling: grant.riskCeiling,
          granted_at: resolvedAt
        }).onConflict('id').ignore();
      }

      // Workflow authority comes only from persisted workflow/run/step identity.
      // Tool-call names and IDs are not sufficient to classify an intent.
      const workflowRows = await trx('workflow_runs').where({ run_id: row.run_id }).forUpdate();
      let workflow: any;
      let workflowStepId: string | undefined;
      if (target.type === 'WORKFLOW') {
        if (workflowRows.length !== 1) throw new Error('Approval target does not resolve to exactly one persisted workflow run.');
        workflow = workflowRows[0];
        workflowStepId = target.workflowStepId;
        if (
          workflow.id !== target.workflowRunId || workflow.principal_id !== resolvedBy ||
          workflow.state !== 'WAITING_FOR_APPROVAL' || workflow.pending_approval_step_id !== workflowStepId ||
          row.tool_call_id !== `call_step_${workflowStepId}`
        ) throw new Error('Workflow approval target does not match the authenticated pending workflow step.');
      } else if (workflowRows.length !== 0) {
        throw new Error('A workflow-linked run cannot be resolved through the generic run approval path.');
      }
      const targetType = target.type;
      const run = await trx('runs').where({ id: row.run_id }).forUpdate().first();
      const pendingApproval = typeof run?.pending_approval === 'string'
        ? JSON.parse(run.pending_approval)
        : run?.pending_approval;
      const pendingToolCall = pendingApproval?.toolCall;
      const persistedToolArguments = typeof row.arguments === 'string' ? JSON.parse(row.arguments) : row.arguments;
      if (
        !run || run.principal_id !== resolvedBy ||
        (run.workspace_id || undefined) !== (row.workspace_id || undefined) ||
        ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(run.state || run.status)) ||
        pendingApproval?.id !== id || pendingApproval?.runId !== row.run_id ||
        pendingToolCall?.id !== row.tool_call_id || pendingToolCall?.name !== row.tool ||
        (row.tool_id && pendingToolCall?.toolId !== row.tool_id) ||
        fingerprint(pendingToolCall?.arguments) !== fingerprint(persistedToolArguments) ||
        row.argument_fingerprint !== fingerprint(persistedToolArguments) ||
        (row.permission && row.permission !== row.permission_level)
      ) {
        throw new Error('Approval resumption target is stale, cancelled, or has mismatched identity.');
      }
      if (targetType === 'WORKFLOW') {
        const steps = await trx('workflow_steps')
          .where({ workflow_run_id: workflow.id, step_id: workflowStepId })
          .forUpdate();
        if (steps.length !== 1 || steps[0].state !== 'WAITING_FOR_APPROVAL') {
          throw new Error('The authoritative workflow step is missing, ambiguous, or no longer waiting for approval.');
        }
      }
      if (String(run.state || run.status) !== 'WAITING_FOR_APPROVAL') {
        throw new Error('Run is no longer waiting for this approval.');
      }

      await trx('approval_resumption_outbox').insert({
        id: `approval-resume:${id}`,
        approval_id: id,
        run_id: row.run_id,
        principal_id: resolvedBy,
        workspace_id: row.workspace_id || null,
        decision,
        target_type: targetType,
        workflow_run_id: target.type === 'WORKFLOW' ? target.workflowRunId : null,
        workflow_step_id: workflowStepId || null,
        state: 'APPROVED_UNCLAIMED',
        attempts: 0,
        fencing_token: 0,
        created_at: resolvedAt,
        updated_at: resolvedAt
      });

      return {
        request: mapApprovalRow({ ...row, status: decision, resolved_at: resolvedAt, resolved_by: resolvedBy }),
        applied: true,
        grantHandled: true
      };
    });
  }

  async claimApprovalResumption(owner: string, leaseMs: number, approvalId?: string): Promise<ApprovalResumptionEvent | undefined> {
    return db.transaction(async (trx) => {
      const now = Date.now();
      const row = await trx('approval_resumption_outbox')
        .where((query) => query
          .where((eligible) => eligible
            .whereIn('state', ['APPROVED_UNCLAIMED', 'RECOVERABLY_FAILED'])
            .andWhere((ready) => ready.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now)))
          .orWhere((expired) => expired.where('state', 'CLAIMED_NOT_DISPATCHED').andWhere('lease_until', '<=', now)))
        .modify((query) => { if (approvalId) query.where('approval_id', approvalId); })
        .orderBy('created_at', 'asc')
        .forUpdate()
        .skipLocked()
        .first();
      if (!row) return undefined;
      const validRunTarget = row.target_type === 'RUN' && !row.workflow_run_id && !row.workflow_step_id;
      const validWorkflowTarget = row.target_type === 'WORKFLOW' && Boolean(row.workflow_run_id) && Boolean(row.workflow_step_id);
      if (!validRunTarget && !validWorkflowTarget) {
        await trx('approval_resumption_outbox').where({ id: row.id }).update({
          state: 'CANCELLED_REVOKED',
          last_error: 'Resumption intent has an invalid or incomplete authoritative target.',
          claimed_by: null, lease_until: null, updated_at: now, completed_at: now
        });
        return undefined;
      }
      const fencingToken = Number(row.fencing_token || 0) + 1;
      await trx('approval_resumption_outbox').where({ id: row.id }).update({
        state: 'CLAIMED_NOT_DISPATCHED',
        attempts: Number(row.attempts || 0) + 1,
        fencing_token: fencingToken,
        claimed_by: owner,
        lease_until: now + leaseMs,
        next_attempt_at: null,
        updated_at: now
      });
      const eventBase = {
        id: row.id,
        approvalId: row.approval_id,
        runId: row.run_id,
        principalId: row.principal_id,
        workspaceId: row.workspace_id || undefined,
        decision: row.decision as ApprovalDecision,
        state: 'CLAIMED_NOT_DISPATCHED' as const,
        attempts: Number(row.attempts || 0) + 1,
        fencingToken
      };
      return validWorkflowTarget
        ? { ...eventBase, targetType: 'WORKFLOW' as const, workflowRunId: row.workflow_run_id, workflowStepId: row.workflow_step_id }
        : { ...eventBase, targetType: 'RUN' as const };
    });
  }

  async applyApprovalResumption(event: ApprovalResumptionEvent, owner: string): Promise<boolean> {
    return db.transaction(async (trx) => {
      const now = Date.now();
      const runRecoveryOwner = `${owner}:${event.id}:${event.fencingToken}`;
      const outbox = await trx('approval_resumption_outbox').where({ id: event.id }).forUpdate().first();
      if (
        !outbox || outbox.state !== 'CLAIMED_NOT_DISPATCHED' || outbox.claimed_by !== owner ||
        Number(outbox.fencing_token) !== event.fencingToken || Number(outbox.lease_until) <= now ||
        outbox.approval_id !== event.approvalId || outbox.run_id !== event.runId ||
        outbox.principal_id !== event.principalId || (outbox.workspace_id || undefined) !== event.workspaceId ||
        outbox.decision !== event.decision || outbox.target_type !== event.targetType ||
        (outbox.workflow_run_id || undefined) !== event.workflowRunId ||
        (outbox.workflow_step_id || undefined) !== event.workflowStepId
      ) return false;

      const approval = await trx('approvals').where({ id: event.approvalId }).forUpdate().first();
      const toolCall = approval
        ? await trx('tool_calls').where({ id: approval.tool_call_id, run_id: event.runId }).forUpdate().first()
        : undefined;
      const workflowRows = await trx('workflow_runs').where({ run_id: event.runId }).forUpdate();
      const workflow = workflowRows.length === 1 ? workflowRows[0] : undefined;
      const run = await trx('runs').where({ id: event.runId }).forUpdate().first();
      const activeWorkspaceAuthority = Boolean(run && await hasActiveWorkspaceAuthority(trx, event.principalId, event.workspaceId || ''));
      if (
        !approval || approval.status !== event.decision || approval.resolved_by !== event.principalId ||
        !activeWorkspaceAuthority ||
        approval.run_id !== event.runId || !toolCall || !run ||
        run.principal_id !== event.principalId || (run.workspace_id || undefined) !== event.workspaceId ||
        (toolCall.principal_id && toolCall.principal_id !== event.principalId) ||
        (event.targetType === 'WORKFLOW'
          ? workflowRows.length !== 1 || workflow?.id !== event.workflowRunId ||
            workflow.principal_id !== event.principalId || workflow.state !== 'WAITING_FOR_APPROVAL' ||
            workflow.pending_approval_step_id !== event.workflowStepId ||
            toolCall.id !== `call_step_${event.workflowStepId}`
          : workflowRows.length !== 0) ||
        ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(run.state || run.status))
      ) {
        await trx('approval_resumption_outbox').where({ id: event.id }).update({
          state: 'CANCELLED_REVOKED', last_error: 'Authorization or target is stale, revoked, cancelled, or identity-mismatched.',
          claimed_by: null, lease_until: null, updated_at: now, completed_at: now
        });
        return false;
      }

      const pendingApproval = typeof run.pending_approval === 'string'
        ? JSON.parse(run.pending_approval)
        : run.pending_approval;
      const pendingToolCall = pendingApproval?.toolCall;
      const persistedToolArguments = typeof toolCall?.arguments === 'string'
        ? JSON.parse(toolCall.arguments)
        : toolCall?.arguments;
      if (
        pendingApproval?.id !== event.approvalId || pendingApproval?.runId !== event.runId ||
        pendingToolCall?.id !== approval?.tool_call_id || pendingToolCall?.name !== toolCall?.tool ||
        (toolCall?.tool_id && pendingToolCall?.toolId !== toolCall.tool_id) ||
        fingerprint(pendingToolCall?.arguments) !== fingerprint(persistedToolArguments) ||
        approval?.argument_fingerprint !== fingerprint(persistedToolArguments) ||
        (toolCall?.permission && toolCall.permission !== approval?.permission_level) ||
        (approval?.tool_definition_version && Number(pendingApproval?.toolDefinitionVersion) !== Number(approval.tool_definition_version)) ||
        (approval?.tool_policy_fingerprint && pendingApproval?.toolPolicyFingerprint !== approval.tool_policy_fingerprint)
      ) {
        await trx('approval_resumption_outbox').where({ id: event.id }).update({
          state: 'CANCELLED_REVOKED', last_error: 'Pending approval or tool-call identity no longer matches.',
          claimed_by: null, lease_until: null, updated_at: now, completed_at: now
        });
        return false;
      }
      if (event.targetType === 'RUN' && String(run.state || run.status) !== 'WAITING_FOR_APPROVAL') {
        await trx('approval_resumption_outbox').where({ id: event.id }).update({
          state: 'CANCELLED_REVOKED', last_error: 'Run is no longer waiting for this approval.',
          claimed_by: null, lease_until: null, updated_at: now, completed_at: now
        });
        return false;
      }

      if (
        event.targetType === 'RUN' && event.decision === 'ALLOW_ONCE' &&
        (approval.once_state !== 'AVAILABLE' || approval.once_claim_id != null)
      ) {
        await trx('approval_resumption_outbox').where({ id: event.id }).update({
          state: 'CANCELLED_REVOKED', last_error: 'One-time authorization is not available for this pending dispatch.',
          claimed_by: null, lease_until: null, updated_at: now, completed_at: now
        });
        return false;
      }
      if (event.targetType === 'RUN' && (event.decision === 'ALLOW_SESSION' || event.decision === 'ALLOW_ALWAYS_FOR_TOOL')) {
        const grantScope = event.decision === 'ALLOW_SESSION' ? 'SESSION' : 'ALWAYS';
        const grantQuery = trx('session_grants').where({
          principal_id: event.principalId,
          workspace_id: event.workspaceId,
          tool: toolCall.tool,
          permission: grantScope
        });
        if (grantScope === 'SESSION') grantQuery.andWhere({ session_id: event.runId });
        else grantQuery.whereNull('session_id');
        const persistedGrant = await grantQuery.forUpdate().first();
        const availableCeiling = persistedGrant ? PERMISSION_RANK[persistedGrant.risk_ceiling as PermissionLevel] : undefined;
        const requiredCeiling = PERMISSION_RANK[approval.permission_level as PermissionLevel];
        if (!persistedGrant || !availableCeiling || !requiredCeiling || availableCeiling < requiredCeiling) {
          await trx('approval_resumption_outbox').where({ id: event.id }).update({
            state: 'CANCELLED_REVOKED', last_error: 'Reusable authorization was revoked or no longer meets the risk ceiling.',
            claimed_by: null, lease_until: null, updated_at: now, completed_at: now
          });
          return false;
        }
      }

      const rejected = event.decision === 'REJECT';
      const resolvedPendingApproval = {
        ...pendingApproval,
        decision: event.decision,
        resolvedAt: Number(approval.resolved_at),
        resolvedBy: approval.resolved_by
      };
      if (event.targetType === 'WORKFLOW') {
        if (
          !workflow || workflow.principal_id !== event.principalId ||
          workflow.state !== 'WAITING_FOR_APPROVAL' || workflow.pending_approval_step_id !== event.workflowStepId
        ) {
          await trx('approval_resumption_outbox').where({ id: event.id }).update({
            state: 'CANCELLED_REVOKED', last_error: 'Workflow approval target is no longer pending.',
            claimed_by: null, lease_until: null, updated_at: now, completed_at: now
          });
          return false;
        }
        const steps = await trx('workflow_steps')
          .where({ workflow_run_id: workflow.id, step_id: event.workflowStepId })
          .forUpdate();
        if (steps.length !== 1 || steps[0].state !== 'WAITING_FOR_APPROVAL') {
          await trx('approval_resumption_outbox').where({ id: event.id }).update({
            state: 'CANCELLED_REVOKED', last_error: 'Workflow step is missing, ambiguous, or no longer waiting for this approval.',
            claimed_by: null, lease_until: null, updated_at: now, completed_at: now
          });
          return false;
        }
        const step = steps[0];
        const stepStates = typeof workflow.step_states === 'string' ? JSON.parse(workflow.step_states) : workflow.step_states;
        stepStates[event.workflowStepId!] = rejected ? 'FAILED' : 'READY';
        await trx('workflow_runs').where({ id: workflow.id, state: 'WAITING_FOR_APPROVAL' }).update({
          state: rejected ? 'FAILED' : 'RUNNING', step_states: JSON.stringify(stepStates),
          pending_approval_step_id: null,
          error: rejected ? `Approval rejected for step "${event.workflowStepId}".` : null,
          updated_at: now, completed_at: rejected ? now : null
        });
        await trx('workflow_steps').where({ id: step.id }).update({
          state: rejected ? 'FAILED' : 'READY',
          error: rejected ? 'Approval rejected by user' : null,
          completed_at: rejected ? now : null
        });
      }

      await trx('runs').where({ id: event.runId }).update({
        state: rejected ? 'FAILED' : 'RUNNING',
        status: rejected ? 'FAILED' : 'RUNNING',
        execution_checkpoint: event.targetType === 'WORKFLOW'
          ? (rejected ? 'COMPLETED' : 'WORKFLOW_RUNNING')
          : (rejected ? 'COMPLETED' : 'TOOL_APPROVED'),
        pending_approval: JSON.stringify(resolvedPendingApproval),
        error: rejected ? 'User rejected required tool approval.' : null,
        completed_at: rejected ? now : null,
        recovery_owner: rejected ? null : runRecoveryOwner,
        recovery_claimed_at: rejected ? null : now,
        recovery_lease_until: rejected ? null : now + 30_000,
        updatedAt: now
      });

      await trx('approval_resumption_outbox').where({ id: event.id }).update({
        state: 'DISPATCHED_UNKNOWN',
        result: JSON.stringify({ dispatch: 'unknown', decision: event.decision }),
        claimed_by: null, lease_until: null, last_error: null, updated_at: now
      });
      return true;
    });
  }

  async completeApprovalResumption(eventId: string, result: unknown): Promise<boolean> {
    const now = Date.now();
    const updated = await db('approval_resumption_outbox').where({ id: eventId, state: 'DISPATCHED_UNKNOWN' }).update({
      state: 'COMPLETED_WITH_RESULT', result: JSON.stringify(result), updated_at: now, completed_at: now
    });
    return updated === 1;
  }

  async failApprovalResumption(event: ApprovalResumptionEvent, owner: string, error: string): Promise<boolean> {
    if (event.state !== 'CLAIMED_NOT_DISPATCHED') return false;
    const now = Date.now();
    const query = db('approval_resumption_outbox').where({
      id: event.id,
      approval_id: event.approvalId,
      run_id: event.runId,
      principal_id: event.principalId,
      decision: event.decision,
      target_type: event.targetType,
      state: 'CLAIMED_NOT_DISPATCHED',
      claimed_by: owner,
      fencing_token: event.fencingToken
    }).andWhere('lease_until', '>', now);
    if (event.workspaceId) query.andWhere('workspace_id', event.workspaceId);
    else query.whereNull('workspace_id');
    if (event.targetType === 'WORKFLOW') {
      query.andWhere({ workflow_run_id: event.workflowRunId, workflow_step_id: event.workflowStepId });
    } else {
      query.whereNull('workflow_run_id').whereNull('workflow_step_id');
    }
    const updated = await query.update({
      state: 'RECOVERABLY_FAILED', last_error: error.slice(0, 4000),
      claimed_by: null, lease_until: null, next_attempt_at: now + Math.min(60_000, 1_000 * 2 ** Math.min(event.attempts, 6)),
      updated_at: now
    });
    return updated === 1;
  }

  async claimOnceAuthorization(binding: OneTimeAuthorizationBinding): Promise<boolean> {
    return db.transaction(async (trx) => {
      // Match applyApprovalResumption's lock order: outbox, approval/tool call,
      // then run. A joined FOR UPDATE here could lock rows in planner order and
      // deadlock with a worker holding the outbox while validating the approval.
      const outbox = await trx('approval_resumption_outbox')
        .where({ approval_id: binding.requestId }).forUpdate().first();
      if (
        !outbox || outbox.state !== 'DISPATCHED_UNKNOWN' || outbox.target_type !== 'RUN' ||
        outbox.decision !== 'ALLOW_ONCE' || outbox.run_id !== binding.runId ||
        outbox.principal_id !== binding.principalId || outbox.workspace_id !== binding.workspaceId
      ) return false;

      const row = await trx('approvals')
        .join('tool_calls', 'approvals.tool_call_id', 'tool_calls.id')
        .where('approvals.id', binding.requestId)
        .select(
          'approvals.*', 'tool_calls.tool', 'tool_calls.tool_id', 'tool_calls.arguments',
          'tool_calls.permission', 'tool_calls.principal_id as tool_call_principal_id'
        )
        .forUpdate('approvals', 'tool_calls')
        .first();
      const run = await trx('runs').where({ id: binding.runId })
        .select('id', 'principal_id', 'workspace_id', 'state', 'status', 'pending_approval')
        .forUpdate().first();
      if (!row || !run) return false;
      const activeWorkspaceAuthority = await hasActiveWorkspaceAuthority(trx, binding.principalId, binding.workspaceId);
      const pendingApproval = typeof run.pending_approval === 'string'
        ? JSON.parse(run.pending_approval)
        : run.pending_approval;
      const pendingToolCall = pendingApproval?.toolCall;
      const persistedArguments = typeof row.arguments === 'string' ? JSON.parse(row.arguments) : row.arguments;
      const now = Date.now();
      if (
        !activeWorkspaceAuthority ||
        row.status !== 'ALLOW_ONCE' || row.resolved_by !== binding.principalId ||
        run.principal_id !== binding.principalId || run.state !== 'RUNNING' ||
        !run.workspace_id || run.workspace_id !== binding.workspaceId ||
        row.run_id !== binding.runId || row.tool_call_id !== binding.toolCallId || row.tool_id !== binding.toolId ||
        (row.tool_call_principal_id && row.tool_call_principal_id !== binding.principalId) ||
        row.tool !== binding.toolName || row.permission !== binding.permissionLevel ||
        row.permission_level !== binding.permissionLevel ||
        Number(row.tool_definition_version) !== binding.toolDefinitionVersion ||
        row.tool_policy_fingerprint !== binding.toolPolicyFingerprint ||
        row.argument_fingerprint !== fingerprint(binding.arguments) ||
        fingerprint(persistedArguments) !== fingerprint(binding.arguments) ||
        pendingApproval?.id !== binding.requestId || pendingApproval?.runId !== binding.runId ||
        pendingToolCall?.id !== binding.toolCallId || pendingToolCall?.name !== binding.toolName ||
        pendingToolCall?.toolId !== binding.toolId ||
        fingerprint(pendingToolCall?.arguments) !== fingerprint(binding.arguments) ||
        Number(pendingApproval?.toolDefinitionVersion) !== binding.toolDefinitionVersion ||
        pendingApproval?.toolPolicyFingerprint !== binding.toolPolicyFingerprint
      ) return false;

      // A stale pre-dispatch claimant can be safely reclaimed because the
      // gateway cannot invoke the adapter until its claim nonce is transitioned
      // to DISPATCHED. The new nonce fences the old process from dispatching.
      if (row.once_state === 'CLAIMED' && Number(row.once_claim_expires_at) <= now) {
        await trx('approvals')
          .where({ id: binding.requestId, status: 'ALLOW_ONCE', once_state: 'CLAIMED', once_claim_id: row.once_claim_id })
          .update({ once_state: 'AVAILABLE', once_claim_id: null, once_claimed_at: null, once_claim_expires_at: null });
        row.once_state = 'AVAILABLE';
        row.once_claim_id = null;
      }

      // A crash after DISPATCHED has an unknowable external outcome. Mark it
      // uncertain, but never make the authorization reusable.
      if (row.once_state === 'DISPATCHED' && Number(row.once_dispatched_at) + 600_000 <= now) {
        await trx('approvals')
          .where({ id: binding.requestId, status: 'ALLOW_ONCE', once_state: 'DISPATCHED' })
          .update({ once_state: 'UNCERTAIN', once_completed_at: now });
        return false;
      }

      if (row.once_state !== 'AVAILABLE' || row.once_claim_id) return false;
      const affected = await trx('approvals')
        .where({ id: binding.requestId, status: 'ALLOW_ONCE', once_state: 'AVAILABLE' })
        .whereNull('once_claim_id')
        .update({
          once_state: 'CLAIMED',
          once_claim_id: binding.claimId,
          once_claimed_at: now,
          once_claim_expires_at: now + 30_000
        });
      return affected === 1;
    });
  }

  async markOnceAuthorizationDispatched(binding: OneTimeAuthorizationBinding): Promise<boolean> {
    return db.transaction(async (trx) => {
      // Revalidate the entire binding at the last transactional boundary before
      // the adapter is invoked; the claim and dispatch are separate transactions.
      const outbox = await trx('approval_resumption_outbox')
        .where({ approval_id: binding.requestId }).forUpdate().first();
      if (
        !outbox || outbox.state !== 'DISPATCHED_UNKNOWN' || outbox.target_type !== 'RUN' ||
        outbox.decision !== 'ALLOW_ONCE' || outbox.run_id !== binding.runId ||
        outbox.principal_id !== binding.principalId || outbox.workspace_id !== binding.workspaceId
      ) return false;

      const row = await trx('approvals')
        .join('tool_calls', 'approvals.tool_call_id', 'tool_calls.id')
        .where('approvals.id', binding.requestId)
        .select(
          'approvals.*', 'tool_calls.tool', 'tool_calls.tool_id', 'tool_calls.arguments',
          'tool_calls.permission', 'tool_calls.principal_id as tool_call_principal_id'
        )
        .forUpdate('approvals', 'tool_calls')
        .first();
      const run = await trx('runs').where({ id: binding.runId })
        .select('id', 'principal_id', 'workspace_id', 'state', 'status', 'pending_approval')
        .forUpdate().first();
      if (!row || !run) return false;
      const activeWorkspaceAuthority = await hasActiveWorkspaceAuthority(trx, binding.principalId, binding.workspaceId);
      const now = Date.now();
      const pendingApproval = typeof run.pending_approval === 'string'
        ? JSON.parse(run.pending_approval)
        : run.pending_approval;
      const pendingToolCall = pendingApproval?.toolCall;
      const persistedArguments = typeof row.arguments === 'string' ? JSON.parse(row.arguments) : row.arguments;
      if (
        !activeWorkspaceAuthority ||
        row.status !== 'ALLOW_ONCE' || row.once_state !== 'CLAIMED' || row.once_claim_id !== binding.claimId ||
        Number(row.once_claim_expires_at) <= now || run.state !== 'RUNNING' ||
        row.resolved_by !== binding.principalId || run.principal_id !== binding.principalId ||
        run.id !== binding.runId || !run.workspace_id || run.workspace_id !== binding.workspaceId ||
        row.run_id !== binding.runId || row.tool_call_id !== binding.toolCallId || row.tool_id !== binding.toolId ||
        (row.tool_call_principal_id && row.tool_call_principal_id !== binding.principalId) ||
        row.tool !== binding.toolName || row.permission !== binding.permissionLevel ||
        row.permission_level !== binding.permissionLevel ||
        Number(row.tool_definition_version) !== binding.toolDefinitionVersion ||
        row.tool_policy_fingerprint !== binding.toolPolicyFingerprint ||
        row.argument_fingerprint !== fingerprint(binding.arguments) ||
        fingerprint(persistedArguments) !== fingerprint(binding.arguments) ||
        pendingApproval?.id !== binding.requestId || pendingApproval?.runId !== binding.runId ||
        pendingToolCall?.id !== binding.toolCallId || pendingToolCall?.name !== binding.toolName ||
        pendingToolCall?.toolId !== binding.toolId ||
        fingerprint(pendingToolCall?.arguments) !== fingerprint(binding.arguments) ||
        Number(pendingApproval?.toolDefinitionVersion) !== binding.toolDefinitionVersion ||
        pendingApproval?.toolPolicyFingerprint !== binding.toolPolicyFingerprint
      ) return false;

      const affected = await trx('approvals')
        .where({ id: binding.requestId, status: 'ALLOW_ONCE', once_state: 'CLAIMED', once_claim_id: binding.claimId })
        .andWhere('once_claim_expires_at', '>', now)
        .update({ once_state: 'DISPATCHED', once_dispatched_at: now, once_claim_expires_at: null });
      return affected === 1;
    });
  }

  async finishOnceAuthorization(
    requestId: string,
    claimId: string,
    outcome: 'COMPLETED' | 'FAILED'
  ): Promise<boolean> {
    const affected = await db('approvals')
      .where({ id: requestId, status: 'ALLOW_ONCE', once_state: 'DISPATCHED', once_claim_id: claimId })
      .update({ once_state: outcome, once_completed_at: Date.now() });
    return affected === 1;
  }
}

export interface SessionGrantRepository {
  grantSession(runId: string, tool: string, principalId: string, riskCeiling?: PermissionLevel): Promise<void>;
  grantAlways(tool: string, principalId: string, riskCeiling: PermissionLevel, runId: string, expectedWorkspaceId: string): Promise<void>;
  hasSessionGrant(runId: string, tool: string, principalId: string, requiredPermission?: PermissionLevel): Promise<boolean>;
  hasAlwaysGrant(tool: string, principalId: string, requiredPermission?: PermissionLevel, runId?: string): Promise<boolean>;
  clearSession(runId: string): Promise<void>;
}

export class PostgresSessionGrantRepository implements SessionGrantRepository {
  async grantSession(runId: string, tool: string, principalId: string, riskCeiling: PermissionLevel = 'READ'): Promise<void> {
    await db.transaction(async (trx) => {
      const run = await trx('runs').where({ id: runId, principal_id: principalId })
        .select('workspace_id', 'state', 'status').forUpdate().first();
      if (!run?.workspace_id || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(run.state || run.status))) {
        throw new Error('Session grant requires an active run with an authoritative workspace.');
      }
      if (!await hasActiveWorkspaceAuthority(trx, principalId, run.workspace_id)) {
        throw new Error('Session grant requires active workspace authority.');
      }
      const grant: ApprovalGrant = { scope: 'SESSION', principalId, runId, tool, riskCeiling, workspaceId: run.workspace_id };
      await trx('session_grants').insert({
        id: stableGrantId(grant), principal_id: principalId, session_id: runId, workspace_id: run.workspace_id,
        tool, permission: 'SESSION', risk_ceiling: riskCeiling, granted_at: Date.now()
      }).onConflict('id').ignore();
    });
  }

  async grantAlways(
    tool: string,
    principalId: string,
    riskCeiling: PermissionLevel,
    runId: string,
    expectedWorkspaceId: string
  ): Promise<void> {
    if (!runId || !expectedWorkspaceId) throw new Error('Always grant requires an authenticated parent run and workspace.');
    await db.transaction(async (trx) => {
      const run = await trx('runs').where({ id: runId, principal_id: principalId })
        .select('workspace_id', 'state', 'status').forUpdate().first();
      if (
        !run?.workspace_id || run.workspace_id !== expectedWorkspaceId ||
        ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(run.state || run.status))
      ) throw new Error('Always grant parent run does not validate the expected workspace and owner.');
      if (!await hasActiveWorkspaceAuthority(trx, principalId, run.workspace_id)) {
        throw new Error('Always grant requires active workspace authority.');
      }
      const workspaceId = run.workspace_id;
      const grant: ApprovalGrant = { scope: 'ALWAYS', principalId, runId: '', tool, riskCeiling, workspaceId };
      await trx('session_grants').insert({
        id: stableGrantId(grant), principal_id: principalId, workspace_id: workspaceId, tool,
        permission: 'ALWAYS', risk_ceiling: riskCeiling, granted_at: Date.now()
      }).onConflict('id').ignore();
    });
  }

  async hasSessionGrant(runId: string, tool: string, principalId: string, requiredPermission: PermissionLevel = 'READ'): Promise<boolean> {
    const run = await db('runs').where({ id: runId, principal_id: principalId }).select('workspace_id', 'state', 'status').first();
    if (!run?.workspace_id || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(run.state || run.status))) return false;
    if (!await hasActiveWorkspaceAuthority(db, principalId, run.workspace_id)) return false;
    const rows = await db('session_grants').where({
      principal_id: principalId, session_id: runId, workspace_id: run.workspace_id, tool, permission: 'SESSION'
    }).select('risk_ceiling');
    return rows.some((row: any) => PERMISSION_RANK[row.risk_ceiling as PermissionLevel] >= PERMISSION_RANK[requiredPermission]);
  }

  async hasAlwaysGrant(
    tool: string,
    principalId: string,
    requiredPermission: PermissionLevel = 'READ',
    runId?: string
  ): Promise<boolean> {
    if (!runId) return false;
    const run = await db('runs').where({ id: runId, principal_id: principalId }).select('workspace_id', 'state', 'status').first();
    if (!run?.workspace_id || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(run.state || run.status))) return false;
    if (!await hasActiveWorkspaceAuthority(db, principalId, run.workspace_id)) return false;
    const rows = await db('session_grants').where({
      principal_id: principalId, workspace_id: run.workspace_id, tool, permission: 'ALWAYS'
    }).select('risk_ceiling');
    return rows.some((row: any) => PERMISSION_RANK[row.risk_ceiling as PermissionLevel] >= PERMISSION_RANK[requiredPermission]);
  }

  async clearSession(runId: string): Promise<void> {
    await db('session_grants').where({ session_id: runId, permission: 'SESSION' }).delete();
  }
}
