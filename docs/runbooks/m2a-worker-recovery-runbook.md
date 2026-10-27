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
> or queries that indiscriminately expire leases across workers:
> `UPDATE specialist_tasks SET lease_expires_at = 0 WHERE state IN ('CLAIMED', 'RUNNING');`
> are **STRICTLY PROHIBITED** in all environments.

### Systemic Hazards of Blanket or Careless Updates:
1. **Zero Tenant Isolation**: Indiscriminately fails or evicts tasks across all tenants, workspaces, and users simultaneously.
2. **Premature Eviction of Active Healthy Leases**: Forcibly expiring leases while workers are legitimately computing causes dual-execution split-brain races and corrupts in-flight results.
3. **Fencing Token Violation**: Bypasses the monotonically increasing `fencing_token` and transactional locks (`FOR UPDATE`), destroying concurrency guarantees.
4. **Audit Trail Corruption**: Mutates `specialist_tasks` directly without emitting corresponding state events to `specialist_task_events`, destroying compliance auditability and mischaracterizing previous states (e.g. recording `CLAIMED` tasks as `RUNNING`).
5. **Irreversible Data Loss**: Permanently aborts recoverable tasks that could otherwise be cleanly claimed and resumed by replacement workers.

---

## 3. Safe, Tenant-Scoped, Lease-Aware Recovery Runbook

### Section 3.1: Primary & Recommended Architecture: Natural Lease Expiration (Zero Manual DB Surgery)

> [!NOTE]
> In AIRA, all specialist tasks operate under short-lived leases (default: 15,000 ms) with frequent heartbeats (default: 3,000 ms).
> **Prefer natural lease expiration and the existing atomic reclamation mechanism.**

When a worker container crashes, exits, or loses network connectivity:
1. **Wait $\le 15$ seconds for natural lease expiration.**
   Within 15 seconds, the task's lease naturally expires (`lease_expires_at < NOW()`).
2. **Automated Atomic Reclamation by Worker Fleet**:
   Active replacement workers continuously run `reclaimExpiredLeases()` in their polling cycle:
   - Queries expired tasks using transactional locking (`FOR UPDATE SKIP LOCKED`).
   - Monotonically increments `fencing_token`.
   - Transitions recoverable tasks to `RETRY_WAIT` (or `TIMED_OUT` if retries exhausted).
   - Inserts compliant audit events in `specialist_task_events`.
   - The task is immediately eligible for claim by healthy specialist workers.
3. **No manual SQL is required for standard worker failure.** Operators should first monitor via the Read-Only Diagnostic Assessment before attempting any database operations.

---

### Section 3.2: Mandatory Precondition for Manual / Forced Recovery

> [!CAUTION]
> **Do not forcibly expire an active lease solely because an operator supplied its worker ID.**
> If the worker process is still alive and holding an active lease (`lease_expires_at > NOW()`), forcibly expiring its lease or aborting its task will cause catastrophic split-brain dual execution.

Before executing ANY manual forced recovery:
1. **Independently verify worker termination**:
   - Docker: Verify container status is `exited` or `dead`:
     ```bash
     docker inspect -f '{{.State.Status}}' <container-id>
     ```
   - Kubernetes: Verify pod is `Failed`, `Terminated`, or deleted:
     ```bash
     kubectl get pod <pod-name> -n aira
     ```
   - Linux host: Verify process is terminated:
     ```bash
     kill -0 <pid>
     ```
2. If the container or process is still running, **terminate it first** (`docker kill`, `kubectl delete pod`, `kill -9`) before executing recovery.
3. Wait for the lease to naturally expire. If break-glass immediate action is required, use the safe transactional procedures below.

---

### Section 3.3: Step 1: Diagnostic Assessment (Read-Only)

Before altering any database state, inspect active tasks and leases for the affected tenant and run/task:

```sql
-- Replace :target_principal_id and :target_run_id with actual identifiers
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
  AND (run_id = :target_run_id OR id = :target_task_id)
  AND state IN ('CLAIMED', 'RUNNING')
ORDER BY created_at ASC;
```

---

### Section 3.4: Step 2: Safe Option A — Transactional Break-Glass Lease Reclamation Preparation

If worker termination is independently verified and the operator must clear the lease for immediate pickup by replacement workers (without aborting the task):

> [!IMPORTANT]
> **Option A Constraints**:
> - Requires explicit tenant identity (`principal_id = :target_principal_id`).
> - Requires explicit run or task identity (`(run_id = :target_run_id OR id = :target_task_id)`).
> - Requires explicit crashed worker identity (`lease_owner = :crashed_worker_id`).
> - Enforces lease expiration check (`lease_expires_at <= NOW()` or `NULL`). Does NOT expire active healthy leases.
> - Monotonically increments `fencing_token` to fence out late-arriving writes from the crashed worker.
> - Emits `TASK_LEASE_RECLAIMED` audit event recording previous task state and operator identity.

```sql
-- Atomically verify expired lease and crashed worker, bump fencing token, and clear lease for immediate reclamation
WITH target_tasks AS (
  SELECT id, run_id, fencing_token, state, attempt_count
  FROM specialist_tasks
  WHERE principal_id = :target_principal_id
    AND (run_id = :target_run_id OR id = :target_task_id)
    AND lease_owner = :crashed_worker_id
    AND state IN ('CLAIMED', 'RUNNING')
    AND (
      lease_expires_at IS NULL 
      OR lease_expires_at <= (EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  FOR UPDATE
),
updated AS (
  UPDATE specialist_tasks st
  SET lease_owner = NULL,
      lease_expires_at = 0,
      fencing_token = st.fencing_token + 1,
      updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
  FROM target_tasks tt
  WHERE st.id = tt.id AND st.fencing_token = tt.fencing_token
  RETURNING st.id, st.run_id, tt.state AS from_state, st.fencing_token
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
  'evt_recov_a_' || (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint || '_' || substr(md5(random()::text), 1, 6),
  u.id,
  u.run_id,
  'TASK_LEASE_RECLAIMED',
  u.from_state,
  u.from_state,
  u.fencing_token,
  'operator_runbook',
  jsonb_build_object(
    'action', 'LEASE_RESET_FOR_RECLAMATION',
    'previous_lease_owner', :crashed_worker_id::text,
    'operator_id', :operator_id::text,
    'verified_worker_termination', true
  ),
  (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM updated u;
```

---

### Section 3.5: Step 3: Safe Option B — Operator-Initiated Controlled Abort

If an operator must permanently abort a stalled, poison-pill, or unrecoverable execution for a specific tenant:

> [!IMPORTANT]
> **Option B Constraints**:
> - Requires explicit tenant identity (`principal_id = :target_principal_id`).
> - Requires explicit run or task identity (`(run_id = :target_run_id OR id = :target_task_id)`).
> - Requires explicit crashed worker identity (`lease_owner = :crashed_worker_id`).
> - Enforces lease expiration check (`lease_expires_at <= NOW()` or `NULL`). Does NOT abort active healthy leases.
> - Preserves actual previous task state (`from_state = u.from_state`), correctly capturing whether the task was in `CLAIMED` or `RUNNING` state in `specialist_task_events`.
> - Atomically updates task state to `FAILED`, outcome to `FAILED`, and increments `fencing_token`.

```sql
-- Atomically verify lease expiration and worker identity, increment fencing token, and emit accurate audit event
WITH target_tasks AS (
  SELECT id, run_id, fencing_token, state, attempt_count
  FROM specialist_tasks
  WHERE principal_id = :target_principal_id
    AND (run_id = :target_run_id OR id = :target_task_id)
    AND lease_owner = :crashed_worker_id
    AND state IN ('CLAIMED', 'RUNNING')
    AND (
      lease_expires_at IS NULL 
      OR lease_expires_at <= (EXTRACT(EPOCH FROM NOW()) * 1000)
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
        'message', 'Task safely aborted by operator runbook following verified worker failure and lease expiration',
        'retryable', false,
        'operator_id', :operator_id::text,
        'crashed_worker_id', :crashed_worker_id::text
      ),
      completed_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
      updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
  FROM target_tasks tt
  WHERE st.id = tt.id AND st.fencing_token = tt.fencing_token
  RETURNING st.id, st.run_id, tt.state AS from_state, st.fencing_token
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
  'evt_recov_b_' || (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint || '_' || substr(md5(random()::text), 1, 6),
  u.id,
  u.run_id,
  'TASK_STATE_FAILED',
  u.from_state,
  'FAILED',
  u.fencing_token,
  'operator_runbook',
  jsonb_build_object(
    'reason', 'Operator-initiated tenant-scoped recovery runbook',
    'operator_id', :operator_id::text,
    'crashed_worker_id', :crashed_worker_id::text,
    'previous_state', u.from_state
  ),
  (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM updated u;
```

---

## 4. Verification Check

After executing Option A or Option B, verify the final state and event log:

```sql
-- 1. Inspect updated task state
SELECT id, state, outcome, fencing_token, lease_owner, error_details
FROM specialist_tasks
WHERE principal_id = :target_principal_id
  AND (run_id = :target_run_id OR id = :target_task_id);

-- 2. Inspect corresponding audit events
SELECT id, task_id, run_id, event_type, from_state, to_state, fencing_token, worker_id, payload, to_timestamp(created_at / 1000) AS created_at_utc
FROM specialist_task_events
WHERE task_id = :target_task_id
ORDER BY created_at DESC
LIMIT 5;
```
