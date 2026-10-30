import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type { ExecutionPrincipal } from '../../packages/contracts/src/index.js';
import { db } from '../../packages/db/src/index.js';
import { PostgresWorkspaceAuthorityRepository } from '../../packages/agent-runtime/src/workspace-authority.js';

let disposableDatabaseVerified: Promise<void> | undefined;
let verifiedDatabaseContract: string | undefined;

async function verifyDisposableDatabase(forceIdentityCheck = false): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || process.env.CI_DISPOSABLE_DATABASE !== 'true' ||
      !process.env.DATABASE_URL || process.env.DATABASE_URL !== process.env.ISOLATED_TEST_DATABASE_URL) {
    throw new Error('PostgreSQL execution fixtures require the matching identity-verified disposable database contract.');
  }
  const contract = [
    process.env.DATABASE_URL, process.env.CI_EXPECTED_DATABASE_USER,
    process.env.CI_EXPECTED_DATABASE_NAME, process.env.CI_EXPECTED_POSTGRES_ADDRESSES
  ].join('\u0000');
  if (forceIdentityCheck || contract !== verifiedDatabaseContract) {
    verifiedDatabaseContract = contract;
    disposableDatabaseVerified = Promise.resolve().then(() => {
      execFileSync(process.execPath, ['scripts/ci/assert-disposable-postgres.mjs'], { stdio: 'inherit' });
    });
  }
  await disposableDatabaseVerified;
}

export interface PostgresExecutionFixtureOptions {
  principalPrefix: string;
  sessionPrefix?: string;
  /** Shared only when a suite needs multiple principals with the same run tag. */
  tag?: string;
  roles?: string[];
  scopes?: string[];
  /** Deliberate fixed identity is reserved for negative/legacy certification cases. */
  principalId?: string;
  sessionId?: string;
  authorityRepository?: PostgresWorkspaceAuthorityRepository;
  /** Permit externally generated random run IDs while still refusing existing rows. */
  requireTaggedRunIds?: boolean;
}

export interface ParentRunFixtureOptions {
  prompt?: string;
  state?: string;
  status?: string;
  executionCheckpoint?: string;
}

/**
 * Positive PostgreSQL fixture: an authenticated principal with resolver-backed
 * personal authority and parent runs whose persisted owner/workspace/session are
 * checked before the caller dispatches any protected tool.
 */
export async function createPostgresExecutionFixture(options: PostgresExecutionFixtureOptions) {
  await verifyDisposableDatabase();
  const tag = options.tag || randomUUID();
  const principalId = options.principalId || `${options.principalPrefix}_${tag}`;
  const sessionId = options.sessionId || `${options.sessionPrefix || 'sess_' + options.principalPrefix}_${tag}`;
  const authorityRepository = options.authorityRepository || new PostgresWorkspaceAuthorityRepository();
  const priorAuthority = await db('principal_workspace_authorities').where({ principal_id: principalId }).first();
  let resolvedWorkspaceId: string | undefined;
  try {
    const workspaceId = await authorityRepository.resolveWorkspace(principalId);
    resolvedWorkspaceId = workspaceId;
    const ownsAuthorityRow = !priorAuthority;
    assert.equal(await authorityRepository.isWorkspaceActive(principalId, workspaceId), true,
      'Fixture principal must have active resolver-backed personal workspace authority.');

    const principal: ExecutionPrincipal = {
      userId: principalId,
      sessionId,
      workspaceId,
      ...(options.roles ? { roles: options.roles } : {}),
      ...(options.scopes ? { scopes: options.scopes } : {})
    };
    const createdRunIds = new Set<string>();
    const existingGrantIds = new Set<string>(
      (await db('session_grants').where({ principal_id: principalId, workspace_id: workspaceId }).select('id'))
        .map((row: { id: string }) => String(row.id))
    );

    async function createParentRun(runId: string, runOptions: ParentRunFixtureOptions = {}): Promise<void> {
      await verifyDisposableDatabase();
      if (options.requireTaggedRunIds !== false) {
        assert.ok(runId.includes(tag), 'Fixture run IDs must carry this fixture’s unique tag.');
      }
      assert.equal(await authorityRepository.isWorkspaceActive(principalId, workspaceId), true,
        'Parent runs may only be created while the fixture authority is active.');
      const existing = await db('runs').where({ id: runId }).first();
      if (existing) {
        throw new Error(`Refusing to reuse an existing parent run in a positive fixture: ${runId}`);
      }
      const now = Date.now();
      await db('runs').insert({
        id: runId,
        principal_id: principalId,
        workspace_id: workspaceId,
        session_id: sessionId,
        prompt: runOptions.prompt || 'Identity-verified disposable execution fixture.',
        status: runOptions.status || runOptions.state || 'RUNNING',
        state: runOptions.state || runOptions.status || 'RUNNING',
        execution_checkpoint: runOptions.executionCheckpoint || null,
        createdAt: now,
        updatedAt: now,
        toolsUsed: '[]',
        toolCalls: '[]',
        toolResults: '[]'
      });
      const persisted = await db('runs').where({ id: runId }).first();
      assert.equal(persisted?.principal_id, principalId, 'Persisted run owner must match the authenticated fixture principal.');
      assert.equal(persisted?.workspace_id, workspaceId, 'Persisted run workspace must match active personal authority.');
      assert.equal(persisted?.session_id, sessionId, 'Persisted run session must match the authenticated fixture principal.');
      createdRunIds.add(runId);
    }

    async function trackParentRun(runId: string): Promise<void> {
      await verifyDisposableDatabase();
      assert.equal(await authorityRepository.isWorkspaceActive(principalId, workspaceId), true,
        'Tracked parent runs require active fixture authority.');
      const persisted = await db('runs').where({ id: runId }).first();
      assert.equal(persisted?.principal_id, principalId, 'Tracked run owner must match the fixture principal.');
      assert.equal(persisted?.workspace_id, workspaceId, 'Tracked run workspace must match fixture authority.');
      assert.equal(persisted?.session_id, sessionId, 'Tracked run session must match the fixture session.');
      createdRunIds.add(runId);
    }

    async function cleanup(): Promise<void> {
      await verifyDisposableDatabase(true);
      if (createdRunIds.size) {
        const runIds = [...createdRunIds];
        // Delete only rows owned by these runs; the outbox intentionally RESTRICTs run deletion.
        await db('approval_resumption_outbox').whereIn('run_id', runIds).del();
        await db('run_events').whereIn('run_id', runIds).del();
        const newGrantIds = (await db('session_grants')
          .where({ principal_id: principalId, workspace_id: workspaceId }).select('id'))
          .map((row: { id: string }) => String(row.id))
          .filter((id: string) => !existingGrantIds.has(id));
        if (newGrantIds.length) await db('session_grants').whereIn('id', newGrantIds).del();
        await db('runs').whereIn('id', runIds)
          .andWhere({ principal_id: principalId, workspace_id: workspaceId, session_id: sessionId }).del();
      }
      if (ownsAuthorityRow) {
        await db('principal_workspace_authorities').where({ principal_id: principalId, workspace_id: workspaceId }).del();
      }
    }

    return { tag, principal, authorityRepository, createParentRun, trackParentRun, cleanup };
  } catch (error) {
    if (!priorAuthority && resolvedWorkspaceId) {
      await verifyDisposableDatabase(true);
      await db('principal_workspace_authorities')
        .where({ principal_id: principalId, workspace_id: resolvedWorkspaceId })
        .del()
        .catch(() => undefined);
    }
    throw error;
  }
}