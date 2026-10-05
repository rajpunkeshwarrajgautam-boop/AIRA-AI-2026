import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const pg = await PGlite.create();
const now = 1_800_000_000_000;

try {
  await pg.exec(`
    CREATE TABLE aira_computer_leases (owner_id text PRIMARY KEY, bot_id text NOT NULL, holder_id text NOT NULL, mode text NOT NULL, token text NOT NULL UNIQUE, fence bigint NOT NULL DEFAULT 1, acquired_at bigint NOT NULL, lease_until bigint NOT NULL, updated_at bigint NOT NULL);
    CREATE TABLE aira_computer_event_sequences (owner_id text PRIMARY KEY, sequence bigint NOT NULL DEFAULT 0);
    CREATE TABLE aira_computer_events (owner_id text NOT NULL, sequence bigint NOT NULL, bot_id text NOT NULL, type text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at bigint NOT NULL, PRIMARY KEY(owner_id, sequence));
    CREATE TABLE aira_runtime_outbox (id text PRIMARY KEY, topic text NOT NULL, aggregate_id text NOT NULL, dedupe_key text NOT NULL UNIQUE, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'PENDING', attempts integer NOT NULL DEFAULT 0, available_at bigint NOT NULL, claimed_by text, claim_until bigint, created_at bigint NOT NULL, published_at bigint, last_error text);
    CREATE TABLE aira_scheduler_leases (name text PRIMARY KEY, holder_id text NOT NULL, fence bigint NOT NULL DEFAULT 1, lease_until bigint NOT NULL, updated_at bigint NOT NULL);
    CREATE TABLE aira_runtime_instances (instance_id text PRIMARY KEY, role text NOT NULL, version text NOT NULL, started_at bigint NOT NULL, heartbeat_at bigint NOT NULL, metadata jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE aira_computer_instances (owner_id text PRIMARY KEY, provider text NOT NULL, desired_state text NOT NULL DEFAULT 'STOPPED', observed_state text NOT NULL DEFAULT 'STOPPED', provider_ref text, generation bigint NOT NULL DEFAULT 0, observed_generation bigint NOT NULL DEFAULT 0, last_reconciled_at bigint, last_error text, updated_at bigint NOT NULL);
  `);

  // Distributed computer lease: one live owner, human preemption, monotonically increasing fence.
  await pg.query(`INSERT INTO aira_computer_leases VALUES ($1,$2,$3,$4,$5,1,$6,$7,$6)`, ['owner','bot-a','run:r1','BOT','tok-a',now,now+60_000]);
  const live = await pg.query(`SELECT * FROM aira_computer_leases WHERE owner_id=$1 AND lease_until>$2`, ['owner', now]);
  assert.equal(live.rows.length, 1);
  const blocked = await pg.query(`UPDATE aira_computer_leases SET holder_id=$1 WHERE owner_id=$2 AND (lease_until <= $3 OR holder_id=$1) RETURNING *`, ['run:r2','owner',now]);
  assert.equal(blocked.rows.length, 0, 'second bot cannot steal a live distributed lease');
  const takeover = await pg.query(`UPDATE aira_computer_leases SET holder_id='human:s1', mode='HUMAN', token='tok-human', fence=fence+1, lease_until=$2, updated_at=$1 WHERE owner_id='owner' AND mode='BOT' RETURNING fence`, [now, now+300_000]);
  assert.equal(Number((takeover.rows[0] as any).fence), 2);
  const staleRelease = await pg.query(`DELETE FROM aira_computer_leases WHERE owner_id='owner' AND token='tok-a' AND fence=1 RETURNING owner_id`);
  assert.equal(staleRelease.rows.length, 0, 'stale token/fence cannot release takeover lease');

  // Durable event cursor survives process boundaries and is owner-global/monotonic.
  for (const [bot, type] of [['bot-a','browser.opened'], ['bot-b','file.written'], ['bot-a','control.taken']] as const) {
    const seq = await pg.query(`INSERT INTO aira_computer_event_sequences(owner_id,sequence) VALUES('owner',1) ON CONFLICT(owner_id) DO UPDATE SET sequence=aira_computer_event_sequences.sequence+1 RETURNING sequence`);
    await pg.query(`INSERT INTO aira_computer_events(owner_id,sequence,bot_id,type,data,created_at) VALUES('owner',$1,$2,$3,'{}',$4)`, [(seq.rows[0] as any).sequence,bot,type,now]);
  }
  const replay = await pg.query(`SELECT sequence,type FROM aira_computer_events WHERE owner_id='owner' AND bot_id='bot-a' AND sequence>1 ORDER BY sequence`);
  assert.deepEqual(replay.rows.map((r:any) => [Number(r.sequence), r.type]), [[3,'control.taken']]);

  // Transactional-outbox contract: dedupe, claim expiry and eventual publish.
  await pg.query(`INSERT INTO aira_runtime_outbox VALUES('o1','computer.reconciled','owner','gen:1','{}','PENDING',0,$1,NULL,NULL,$1,NULL,NULL)`, [now]);
  await pg.query(`INSERT INTO aira_runtime_outbox VALUES('o2','computer.reconciled','owner','gen:1','{}','PENDING',0,$1,NULL,NULL,$1,NULL,NULL) ON CONFLICT(dedupe_key) DO NOTHING`, [now]);
  assert.equal(Number((await pg.query(`SELECT count(*)::int AS c FROM aira_runtime_outbox`)).rows[0]!.c), 1);
  await pg.query(`UPDATE aira_runtime_outbox SET status='CLAIMED',claimed_by='worker-a',claim_until=$1,attempts=attempts+1 WHERE id='o1'`, [now+30_000]);
  assert.equal((await pg.query(`SELECT status FROM aira_runtime_outbox WHERE id='o1'`)).rows[0]!.status, 'CLAIMED');
  await pg.query(`UPDATE aira_runtime_outbox SET claimed_by='worker-b',claim_until=$1,attempts=attempts+1 WHERE id='o1' AND claim_until <= $2 RETURNING id`, [now+70_000, now+40_000]);
  assert.equal((await pg.query(`SELECT claimed_by FROM aira_runtime_outbox WHERE id='o1'`)).rows[0]!.claimed_by, 'worker-b');
  await pg.query(`UPDATE aira_runtime_outbox SET status='PUBLISHED',published_at=$1,claimed_by=NULL,claim_until=NULL WHERE id='o1' AND claimed_by='worker-b'`, [now+41_000]);

  // Scheduler leadership: live leader blocks peers; expired leader can be fenced out.
  await pg.query(`INSERT INTO aira_scheduler_leases VALUES('routines','node-a',1,$1,$2)`, [now+45_000, now]);
  const peer = await pg.query(`UPDATE aira_scheduler_leases SET holder_id='node-b',fence=fence+1,lease_until=$1 WHERE name='routines' AND lease_until <= $2 RETURNING fence`, [now+90_000, now]);
  assert.equal(peer.rows.length, 0);
  const failover = await pg.query(`UPDATE aira_scheduler_leases SET holder_id='node-b',fence=fence+1,lease_until=$1 WHERE name='routines' AND lease_until <= $2 RETURNING fence`, [now+100_000, now+46_000]);
  assert.equal(Number((failover.rows[0] as any).fence), 2);

  // Desired/observed generation model makes container lifecycle restart-safe.
  await pg.query(`INSERT INTO aira_computer_instances(owner_id,provider,desired_state,observed_state,generation,observed_generation,updated_at) VALUES('owner','docker','RUNNING','UNKNOWN',1,0,$1)`, [now]);
  let backlog = await pg.query(`SELECT * FROM aira_computer_instances WHERE generation>observed_generation OR desired_state<>observed_state`);
  assert.equal(backlog.rows.length, 1);
  await pg.query(`UPDATE aira_computer_instances SET observed_state='RUNNING',observed_generation=1,last_reconciled_at=$1 WHERE owner_id='owner' AND generation>=1 AND observed_generation<=1`, [now+1]);
  backlog = await pg.query(`SELECT * FROM aira_computer_instances WHERE generation>observed_generation OR desired_state<>observed_state`);
  assert.equal(backlog.rows.length, 0);
  await pg.query(`UPDATE aira_computer_instances SET desired_state='SUSPENDED',generation=2,updated_at=$1 WHERE owner_id='owner'`, [now+2]);
  assert.equal((await pg.query(`SELECT count(*)::int AS c FROM aira_computer_instances WHERE generation>observed_generation OR desired_state<>observed_state`)).rows[0]!.c, 1);

  // Readiness inputs: heartbeat freshness, leader visibility, reconciliation backlog, outbox depth.
  await pg.query(`INSERT INTO aira_runtime_instances VALUES('node-a','aira-bot-api','phase7',$1,$2,'{}')`, [now, now]);
  const stale = await pg.query(`SELECT count(*)::int AS c FROM aira_runtime_instances WHERE heartbeat_at < $1`, [now-90_000]);
  assert.equal(Number(stale.rows[0]!.c), 0);
  const leader = await pg.query(`SELECT count(*)::int AS c FROM aira_scheduler_leases WHERE lease_until > $1`, [now+46_000]);
  assert.equal(Number(leader.rows[0]!.c), 1);

  console.log('Aira Bot distributed runtime: PASS — durable fenced computer leases, replayable events, outbox dedupe/reclaim, scheduler failover, lifecycle generations, readiness inputs');
} finally {
  await pg.close();
}
