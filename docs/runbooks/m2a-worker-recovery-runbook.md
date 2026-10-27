# AIRA AI 2026 — Milestone 2A Worker Operational Runbook: Rollback & Safe Recovery

## 1. Git Rollback Procedure

When rolling back a deployed worker commit on a feature or staging branch:

### A. Non-Merge (Regular) Commits
> [!CAUTION]
> Never use `git revert -m <message> <commit-sha>`.
> In Git, `-m` is the `--mainline` option reserved exclusively for merge commits (e.g. `git revert -m 1 <merge-commit>`).
> Passing a commit message to `-m` fails with:
> `error: option 'mainline' expects a number greater than zero`.

To revert a standard commit cleanly:
```bash
# 1. Ensure clean working tree on the target branch
git checkout feat/aira-m2a-durable-specialist-execution-20261027
git status

# 2. Revert the commit without interactive prompt
git revert --no-edit <commit-sha>

# 3. Optional: Customize the revert message if required by policy
git commit --amend -m "revert(agent-runtime): rollback commit <commit-sha> due to incident <id>"

# 4. Push to remote feature branch
git push origin feat/aira-m2a-durable-specialist-execution-20261027
```

### B. Merge Commits (e.g. PR Merges)
Only for merge commits that join two branches:
```bash
# Revert mainline parent (parent 1 is typically the target branch)
git revert -m 1 <merge-commit-sha> --no-edit
git push origin <branch>
```

---

## 2. Why Blanket SQL Recovery Updates are Prohibited

> [!WARNING]
> Blanket SQL queries such as:
> `UPDATE specialist_tasks SET state = 'FAILED' WHERE state IN ('CLAIMED', 'RUNNING');`
> are **STRICTLY PROHIBITED** in production and staging environments.

### Systemic Hazards of Blanket Updates:
1. **Zero Tenant Isolation**: Indiscriminately fails tasks across all tenants, workspaces, and users simultaneously.
2. **Lease Ignorance**: Prematurely aborts tasks currently being actively and legitimately processed by living workers whose leases are active (`lease_expires_at > NOW()`).
3. **Fencing Token Violation**: Bypasses the monotonically increasing `fencing_token` and transactional locks (`FOR UPDATE`), causing split-brain race conditions with surviving workers.
4. **Audit Trail Corruption**: Mutates `specialist_tasks` directly without emitting corresponding `TASK_STATE_FAILED` events to `specialist_task_events`, destroying compliance auditability.
5. **Irreversible Data Loss**: Permanently aborts recoverable tasks that could otherwise be cleanly claimed and resumed by replacement workers.

---

## 3. Safe, Tenant-Scoped, Lease-Aware Recovery Runbook

All database recovery operations must be:
- Strictly scoped to a specific tenant (`principal_id`) and mission/run (`run_id`).
- Aware of lease state (`lease_expires_at < NOW()` or matching a verified dead `lease_owner`).
- Fencing-safe (verifying and incrementing `fencing_token`).
- Audited (inserting corresponding records into `specialist_task_events`).

### Step 1: Diagnostic Assessment (Read-Only)
Before altering any database state, inspect active tasks and leases for the affected tenant:

```sql
-- Replace :target_principal_id with the tenant user ID (e.g. 'usr_tenant_123')
SELECT 
    id AS task_id,
    run_id,
    principal_id,
    role,
    state,
    fencing_token,
    lease_owner,
    to_timestamp(lease_expires_at / 1000) AS lease_expires_at_utc,
    to_timestamp(heartbeat_at / 1000) AS last_heartbeat_utc,
    CASE 
        WHEN lease_expires_at IS NULL THEN 'EXPIRED'
        WHEN lease_expires_at < (EXTRACT(EPOCH FROM NOW()) * 1000) THEN 'EXPIRED'
        ELSE 'ACTIVE'
    END AS lease_status,
    attempt_count,
    max_retries
FROM specialist_tasks
WHERE principal_id = :target_principal_id
  AND state IN ('CLAIMED', 'RUNNING')
ORDER BY created_at ASC;
```

---

### Step 2: Safe Option A — Non-Destructive Lease Expiration (Recommended)
If a worker container has crashed or was killed, **do NOT abort the tasks**. Instead, safely expire their leases so that replacement workers can reclaim them via atomic `SELECT FOR UPDATE` and finish them without data loss:

```sql
-- Safely expire leases only for the specific tenant and specific crashed worker
UPDATE specialist_tasks
SET lease_expires_at = 0,
    updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE principal_id = :target_principal_id
  AND lease_owner = :crashed_worker_id
  AND state IN ('CLAIMED', 'RUNNING')
  AND lease_expires_at > (EXTRACT(EPOCH FROM NOW()) * 1000);
```

**Outcome**: The replacement worker's `reclaimExpiredLeases()` loop will discover the tasks, reclaim them with an incremented fencing token, and resume execution cleanly.

---

### Step 3: Safe Option B — Operator-Initiated Controlled Abort
If an operator must permanently abort a stalled or runaway execution for a specific tenant:

```sql
-- Atomically verify lease expiration, increment fencing token, and emit audit event
WITH target_tasks AS (
  SELECT id, run_id, fencing_token, attempt_count
  FROM specialist_tasks
  WHERE principal_id = :target_principal_id
    AND (run_id = :target_run_id OR id = :target_task_id)
    AND state IN ('CLAIMED', 'RUNNING')
    AND (
      lease_expires_at < (EXTRACT(EPOCH FROM NOW()) * 1000) 
      OR lease_owner = :crashed_worker_id
    )
  FOR UPDATE
),
updated AS (
  UPDATE specialist_tasks st
  SET state = 'FAILED',
      outcome = 'FAILED',
      fencing_token = st.fencing_token + 1,
      error_details = jsonb_build_object(
        'code', 'OPERATOR_LEASE_RECOVERY_ABORT',
        'message', 'Task safely aborted by operator runbook following verified worker failure',
        'retryable', false,
        'operator_id', :operator_id
      ),
      completed_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
      updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
  FROM target_tasks tt
  WHERE st.id = tt.id AND st.fencing_token = tt.fencing_token
  RETURNING st.id, st.run_id, st.fencing_token
)
INSERT INTO specialist_task_events (
  id, 
  task_id, 
  run_id, 
  event_type, 
  from_state, 
  to_state, 
  fencing_token, 
  worker_id, 
  payload, 
  created_at
)
SELECT 
  'evt_recov_' || (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint || '_' || substr(md5(random()::text), 1, 6),
  u.id,
  u.run_id,
  'TASK_STATE_FAILED',
  'RUNNING',
  'FAILED',
  u.fencing_token,
  'operator_runbook',
  jsonb_build_object(
    'reason', 'Operator-initiated tenant-scoped recovery runbook',
    'operator_id', :operator_id
  ),
  (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM updated u;
```

---

## 4. Verification Check
After executing Option A or Option B, verify the final state:

```sql
SELECT id, state, outcome, fencing_token, lease_owner, error_details
FROM specialist_tasks
WHERE principal_id = :target_principal_id
  AND (run_id = :target_run_id OR id = :target_task_id);
```
