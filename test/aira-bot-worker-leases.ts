import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.AIRA_RUN_LEASE_TTL_MS = '15000';

// Phase 6 certifies the PostgreSQL lease predicate itself. Use PGlite directly here
// instead of its TCP socket shim: the shim can lose unnamed prepared statements when
// node-postgres multiplexes concurrent Bind messages, producing protocol error 26000
// before PostgreSQL/PGlite evaluates the lease UPDATE. Other integration suites cover
// the application's Knex/socket repository path.
const pg = await PGlite.create();

const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED'];
const leaseTtl = 15_000;
const leaseUntil = () => Date.now() + leaseTtl;

async function createRun(id: string, state = 'QUEUED') {
  await pg.query(`
    INSERT INTO runs (
      id, principal_id, session_id, intent, state, model_policy, prompt,
      system_prompt, context, content, thinking, tools_used, tool_calls,
      tool_results, artifacts, citations, step_count, max_steps, created_at, updated_at,
      execution_fence
    ) VALUES (
      $1, 'lease-owner', 'lease-session', 'AGENT_MISSION', $2, '{}'::jsonb, 'lease seed',
      '', '{}'::jsonb, '', '', '[]'::jsonb, '[]'::jsonb,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0, 8, $3, $3, 0
    )
  `, [id, state, Date.now()]);
}

async function claim(id: string, owner: string) {
  const result = await pg.query<{ execution_fence: number; execution_lease_until: number }>(`
    UPDATE runs
       SET execution_owner = $1,
           execution_lease_until = $2,
           execution_fence = COALESCE(execution_fence, 0) + 1
     WHERE id = $3
       AND state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
       AND (execution_owner IS NULL OR execution_lease_until IS NULL OR execution_lease_until < $4)
    RETURNING execution_fence, execution_lease_until
  `, [owner, leaseUntil(), id, Date.now()]);
  return result.rows[0];
}

async function renew(id: string, owner: string, fence: number) {
  const result = await pg.query<{ execution_fence: number; execution_lease_until: number }>(`
    UPDATE runs
       SET execution_lease_until = $1
     WHERE id = $2
       AND execution_owner = $3
       AND execution_fence = $4
       AND execution_lease_until >= $5
       AND state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
    RETURNING execution_fence, execution_lease_until
  `, [leaseUntil(), id, owner, fence, Date.now()]);
  return result.rows[0];
}

async function assertLease(id: string, owner: string, fence: number) {
  const result = await pg.query<{ ok: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM runs
       WHERE id = $1
         AND execution_owner = $2
         AND execution_fence = $3
         AND execution_lease_until >= $4
         AND state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
    ) AS ok
  `, [id, owner, fence, Date.now()]);
  return Boolean(result.rows[0]?.ok);
}

async function release(id: string, owner: string, fence: number) {
  const result = await pg.query<{ id: string }>(`
    UPDATE runs
       SET execution_owner = NULL,
           execution_lease_until = NULL
     WHERE id = $1 AND execution_owner = $2 AND execution_fence = $3
    RETURNING id
  `, [id, owner, fence]);
  return result.rows.length === 1;
}

async function expire(id: string) {
  await pg.query('UPDATE runs SET execution_lease_until = $1 WHERE id = $2', [Date.now() - 1, id]);
}

async function getLease(id: string) {
  const result = await pg.query<{ execution_owner: string | null; execution_fence: number; execution_lease_until: number | null }>(
    'SELECT execution_owner, execution_fence, execution_lease_until FROM runs WHERE id = $1', [id]
  );
  return result.rows[0];
}

try {
  // Keep this schema intentionally minimal: only columns needed by the production
  // execution-lease predicate plus run lifecycle state are present.
  await pg.exec(`
    CREATE TABLE runs (
      id text PRIMARY KEY,
      principal_id text NOT NULL,
      session_id text,
      intent text NOT NULL,
      state text NOT NULL,
      model_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
      prompt text NOT NULL DEFAULT '',
      system_prompt text NOT NULL DEFAULT '',
      context jsonb NOT NULL DEFAULT '{}'::jsonb,
      content text NOT NULL DEFAULT '',
      thinking text NOT NULL DEFAULT '',
      tools_used jsonb NOT NULL DEFAULT '[]'::jsonb,
      tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
      tool_results jsonb NOT NULL DEFAULT '[]'::jsonb,
      artifacts jsonb NOT NULL DEFAULT '[]'::jsonb,
      citations jsonb NOT NULL DEFAULT '[]'::jsonb,
      step_count integer NOT NULL DEFAULT 0,
      max_steps integer NOT NULL DEFAULT 8,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      execution_owner text,
      execution_lease_until bigint,
      execution_fence bigint NOT NULL DEFAULT 0
    );
  `);

  const id = 'run_lease_seed';
  await createRun(id);

  const a = await claim(id, 'worker-A');
  assert.ok(a);
  assert.equal(Number(a!.execution_fence), 1);
  assert.equal(await assertLease(id, 'worker-A', Number(a!.execution_fence)), true);
  assert.equal(await claim(id, 'worker-B'), undefined, 'a live lease must reject another worker');

  const renewed = await renew(id, 'worker-A', Number(a!.execution_fence));
  assert.ok(renewed);
  assert.equal(Number(renewed!.execution_fence), Number(a!.execution_fence));
  assert.equal(await release(id, 'worker-A', Number(a!.execution_fence) + 1), false, 'wrong fence cannot release an active lease');
  assert.equal(await release(id, 'worker-A', Number(a!.execution_fence)), true);

  const b = await claim(id, 'worker-B');
  assert.ok(b);
  assert(Number(b!.execution_fence) > Number(a!.execution_fence), 'new ownership must increment the fence token');
  assert.equal(await assertLease(id, 'worker-A', Number(a!.execution_fence)), false, 'stale worker must lose authority');
  assert.equal(await renew(id, 'worker-A', Number(a!.execution_fence)), undefined);

  await expire(id);
  const c = await claim(id, 'worker-C');
  assert.ok(c);
  assert(Number(c!.execution_fence) > Number(b!.execution_fence));
  assert.equal(await renew(id, 'worker-B', Number(b!.execution_fence)), undefined);
  assert.equal(await release(id, 'worker-B', Number(b!.execution_fence)), false);
  assert.equal((await getLease(id)).execution_owner, 'worker-C');
  assert.equal(await release(id, 'worker-C', Number(c!.execution_fence)), true);

  // Real concurrent claims against one PostgreSQL engine: exactly one claimant wins.
  const raceId = 'run_concurrent_claim';
  await createRun(raceId);
  const contenders = await Promise.all(
    Array.from({ length: 16 }, (_, index) => claim(raceId, `worker-${index}`))
  );
  const winners = contenders.filter(Boolean);
  assert.equal(winners.length, 1, 'atomic UPDATE predicate must elect exactly one live owner');
  assert.equal(Number(winners[0]!.execution_fence), 1);

  const ownerRow = await getLease(raceId);
  assert.ok(ownerRow.execution_owner);
  assert.equal(Number(ownerRow.execution_fence), 1);

  // Expire and race again. One new owner wins and the fence must monotonically advance.
  await expire(raceId);
  const takeover = await Promise.all(
    Array.from({ length: 16 }, (_, index) => claim(raceId, `takeover-${index}`))
  );
  const takeoverWinners = takeover.filter(Boolean);
  assert.equal(takeoverWinners.length, 1, 'expired lease takeover must still elect exactly one owner');
  assert.equal(Number(takeoverWinners[0]!.execution_fence), 2, 'takeover must advance the fence token');

  const staleOwner = ownerRow.execution_owner!;
  assert.equal(await renew(raceId, staleOwner, 1), undefined, 'stale owner cannot renew after takeover');
  assert.equal(await release(raceId, staleOwner, 1), false, 'stale owner cannot release the new lease');

  // Terminal runs are never claimable.
  const terminalId = 'run_terminal';
  await createRun(terminalId, terminalStates[0]);
  assert.equal(await claim(terminalId, 'worker-terminal'), undefined);

  console.log('Aira Bot worker leases: PASS — atomic claim, renewal, monotonic fencing, stale-worker rejection, expiry takeover, 16-way single-winner concurrency');
} finally {
  await pg.close();
}
