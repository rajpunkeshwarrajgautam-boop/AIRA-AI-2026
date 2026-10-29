import { Knex } from 'knex';

/** Durable, fenced resumption intent created in the approval-decision transaction. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('approval_resumption_outbox', (table) => {
    table.string('id', 255).primary();
    table.string('approval_id', 255).notNullable().unique().references('id').inTable('approvals').onDelete('RESTRICT');
    table.string('run_id', 255).notNullable().references('id').inTable('runs').onDelete('RESTRICT');
    table.string('principal_id', 255).notNullable();
    table.string('workspace_id', 255);
    table.string('decision', 32).notNullable();
    table.string('target_type', 16).notNullable();
    table.string('workflow_step_id', 255);
    table.string('state', 32).notNullable().defaultTo('APPROVED_UNCLAIMED');
    table.integer('attempts').notNullable().defaultTo(0);
    table.bigInteger('fencing_token').notNullable().defaultTo(0);
    table.string('claimed_by', 255);
    table.bigInteger('lease_until');
    table.bigInteger('next_attempt_at');
    table.text('last_error');
    table.jsonb('result');
    table.bigInteger('created_at').notNullable();
    table.bigInteger('updated_at').notNullable();
    table.bigInteger('completed_at');

    table.index(['state', 'lease_until', 'next_attempt_at', 'created_at'], 'idx_approval_resumption_claim');
    table.index(['run_id', 'state'], 'idx_approval_resumption_run_state');
    table.check("decision in ('ALLOW_ONCE', 'ALLOW_SESSION', 'ALLOW_ALWAYS_FOR_TOOL', 'REJECT')", [], 'approval_resumption_decision_check');
    table.check("target_type in ('RUN', 'WORKFLOW')", [], 'approval_resumption_target_check');
    table.check("state in ('APPROVED_UNCLAIMED', 'CLAIMED_NOT_DISPATCHED', 'DISPATCHED_UNKNOWN', 'COMPLETED_WITH_RESULT', 'CANCELLED_REVOKED', 'RECOVERABLY_FAILED')", [], 'approval_resumption_state_check');
  });

  // Recover decisions committed by earlier releases whose run still records this
  // exact pending approval. Terminal/stale approvals are deliberately excluded.
  await knex.raw(`
    INSERT INTO approval_resumption_outbox (
      id, approval_id, run_id, principal_id, workspace_id, decision, target_type,
      workflow_step_id, state, attempts, fencing_token, created_at, updated_at
    )
    SELECT
      'approval-resume:' || a.id, a.id, a.run_id, r.principal_id, r.workspace_id, a.status,
      CASE WHEN left(tc.id, 10) = 'call_step_' THEN 'WORKFLOW' ELSE 'RUN' END,
      CASE WHEN left(tc.id, 10) = 'call_step_' THEN substring(tc.id from 11) ELSE NULL END,
      'APPROVED_UNCLAIMED', 0, 0, COALESCE(a.resolved_at, a.created_at),
      floor(extract(epoch from clock_timestamp()) * 1000)::bigint
    FROM approvals a
    JOIN tool_calls tc ON tc.id = a.tool_call_id
    JOIN runs r ON r.id = a.run_id
    LEFT JOIN workflow_runs wr ON wr.run_id = a.run_id
    WHERE a.status IN ('ALLOW_ONCE', 'ALLOW_SESSION', 'ALLOW_ALWAYS_FOR_TOOL', 'REJECT')
      AND a.resolved_by = r.principal_id
      AND a.argument_fingerprint IS NOT NULL
      AND r.state = 'WAITING_FOR_APPROVAL'
      AND r.pending_approval->>'id' = a.id
      AND r.pending_approval->>'runId' = a.run_id
      AND r.pending_approval->'toolCall'->>'id' = tc.id
      AND r.pending_approval->'toolCall'->>'name' = tc.tool
      AND r.pending_approval->'toolCall'->'arguments' = tc.arguments
      AND (tc.tool_id IS NULL OR r.pending_approval->'toolCall'->>'toolId' = tc.tool_id)
      AND (tc.permission IS NULL OR tc.permission = a.permission_level)
      AND (tc.principal_id IS NULL OR tc.principal_id = r.principal_id)
      AND (a.tool_definition_version IS NULL OR r.pending_approval->>'toolDefinitionVersion' = a.tool_definition_version::text)
      AND (a.tool_policy_fingerprint IS NULL OR r.pending_approval->>'toolPolicyFingerprint' = a.tool_policy_fingerprint)
      AND (
        (left(tc.id, 10) <> 'call_step_') OR
        (
          wr.state = 'WAITING_FOR_APPROVAL'
          AND wr.pending_approval_step_id = substring(tc.id from 11)
          AND EXISTS (
            SELECT 1 FROM workflow_steps ws
            WHERE ws.workflow_run_id = wr.id
              AND ws.step_id = substring(tc.id from 11)
              AND ws.state = 'WAITING_FOR_APPROVAL'
          )
        )
      )
    ON CONFLICT (approval_id) DO NOTHING
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('approval_resumption_outbox');
}
