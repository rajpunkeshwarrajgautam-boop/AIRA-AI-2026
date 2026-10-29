import { Knex } from 'knex';

/**
 * Bind workflow resumption intents to persisted workflow-run identity. Migration
 * 028 used a tool-call ID prefix as a classification hint; this correction
 * repairs only still-undispatched intents from the authoritative workflow/run/
 * step records and terminally cancels ambiguous or stale workflow intents.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('approval_resumption_outbox', 'workflow_run_id'))) {
    await knex.schema.alterTable('approval_resumption_outbox', (table) => {
      table.string('workflow_run_id').references('id').inTable('workflow_runs').onDelete('RESTRICT');
    });
  }

  const now = Date.now();
  await knex.raw(`
    WITH valid_workflow_targets AS (
      SELECT o.id AS outbox_id, wr.id AS workflow_run_id, wr.pending_approval_step_id AS step_id
      FROM approval_resumption_outbox o
      JOIN approvals a ON a.id = o.approval_id
      JOIN tool_calls tc ON tc.id = a.tool_call_id AND tc.run_id = o.run_id
      JOIN runs r ON r.id = o.run_id
      JOIN workflow_runs wr
        ON wr.run_id = o.run_id
       AND wr.principal_id = o.principal_id
       AND wr.state = 'WAITING_FOR_APPROVAL'
       AND wr.pending_approval_step_id IS NOT NULL
      JOIN workflow_steps ws
        ON ws.workflow_run_id = wr.id
       AND ws.step_id = wr.pending_approval_step_id
       AND ws.state = 'WAITING_FOR_APPROVAL'
      WHERE o.state IN ('APPROVED_UNCLAIMED', 'CLAIMED_NOT_DISPATCHED', 'RECOVERABLY_FAILED')
        AND o.principal_id = r.principal_id
        AND r.workspace_id IS NOT NULL
        AND o.workspace_id IS NOT DISTINCT FROM r.workspace_id
        AND (SELECT count(*) FROM workflow_runs candidate WHERE candidate.run_id = o.run_id) = 1
        AND (SELECT count(*) FROM workflow_steps pending_step
             WHERE pending_step.workflow_run_id = wr.id
               AND pending_step.step_id = wr.pending_approval_step_id) = 1
        AND a.status = o.decision
        AND a.resolved_by = o.principal_id
        AND r.state = 'WAITING_FOR_APPROVAL'
        AND r.pending_approval->>'id' = a.id
        AND r.pending_approval->>'runId' = o.run_id
        AND r.pending_approval->'toolCall'->>'id' = tc.id
        AND tc.id = 'call_step_' || wr.pending_approval_step_id
        AND r.pending_approval->'toolCall'->>'name' = tc.tool
        AND r.pending_approval->'toolCall'->'arguments' = tc.arguments
        AND (tc.tool_id IS NULL OR r.pending_approval->'toolCall'->>'toolId' = tc.tool_id)
        AND (tc.principal_id IS NULL OR tc.principal_id = r.principal_id)
        AND (tc.permission IS NULL OR tc.permission = a.permission_level)
        AND a.argument_fingerprint IS NOT NULL
        AND (a.tool_definition_version IS NULL OR r.pending_approval->>'toolDefinitionVersion' = a.tool_definition_version::text)
        AND (a.tool_policy_fingerprint IS NULL OR r.pending_approval->>'toolPolicyFingerprint' = a.tool_policy_fingerprint)
    )
    UPDATE approval_resumption_outbox o
    SET target_type = 'WORKFLOW',
        workflow_run_id = v.workflow_run_id,
        workflow_step_id = v.step_id,
        state = 'APPROVED_UNCLAIMED',
        fencing_token = o.fencing_token + 1,
        claimed_by = NULL,
        lease_until = NULL,
        next_attempt_at = NULL,
        last_error = NULL,
        updated_at = ?
    FROM valid_workflow_targets v
    WHERE o.id = v.outbox_id
      AND (
        o.target_type IS DISTINCT FROM 'WORKFLOW' OR
        o.workflow_run_id IS DISTINCT FROM v.workflow_run_id OR
        o.workflow_step_id IS DISTINCT FROM v.step_id
      )
  `, [now]);

  const cancelledAt = Date.now();
  await knex('approval_resumption_outbox')
    .whereIn('state', ['APPROVED_UNCLAIMED', 'CLAIMED_NOT_DISPATCHED', 'RECOVERABLY_FAILED'])
    .andWhere((query) => query
      .where('target_type', 'WORKFLOW')
      .orWhereExists(function () {
        this.select(knex.raw('1')).from('workflow_runs').whereRaw('workflow_runs.run_id = approval_resumption_outbox.run_id');
      }))
    .whereNull('workflow_run_id')
    .update({
      state: 'CANCELLED_REVOKED',
      last_error: 'Workflow intent could not be bound to one authoritative pending workflow step.',
      claimed_by: null,
      lease_until: null,
      next_attempt_at: null,
      updated_at: cancelledAt,
      completed_at: cancelledAt
    });
}

export async function down(_knex: Knex): Promise<void> {
  throw new Error('Migration 029 is an irreversible authorization-target correction; do not roll it back.');
}
