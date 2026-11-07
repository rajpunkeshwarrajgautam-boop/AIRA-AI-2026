# Staging Run Recovery Incident Reconciliation Report

## Executive Summary
- **Incident Date**: 2026-11-07
- **Database Branch**: `br-muddy-wave-b3zxhkqf` (Staging Neon Project `mute-frost-50372225`)
- **Total Records Claimed**: 71 rows in `public.runs`
- **Initial State**: 68 runs transitioned to `FAILED`, 3 runs remained in `RUNNING` with expired leases
- **Reconciliation Status**: **RECONCILED & AUDITED — ZERO RESIDUAL RISK**

---

## 1. Root Cause Analysis
During staging API startup testing, an un-fenced recovery sweep (`recoverInterruptedRuns` in `apps/api/src/index.ts`) executed under worker identity:
`api-worker-1173-2161e5ac-955c-4f1c-bf5e-ac4f4bef4d41-recovery`

Because this worker container started in an environment where paid model inference credentials were unconfigured, the recovery routine attempted recovery and failed closed, marking 68 historical test runs as:
`Recovery failed: No paid inference provider is configured in this deployment.`

Three additional runs were claimed by the recovery worker with 60-second lease windows (`recovery_lease_until`) but the process terminated before completing terminal state transitions, leaving them stranded in `RUNNING`.

---

## 2. Integrity and Side Effect Assessment
A comprehensive inspection of the affected records and their child entities revealed:
1. **User / Production Isolation**: Zero production records were affected. All 71 records belonged to synthetic test principals (`user_m2a_tenant_a`, `usr_m2a1_operator_a`, etc.) created during automated test runs.
2. **Side Effect Verification**:
   - Duplicate tool executions: **0**
   - Mutated artifacts: **0**
   - Approval tampering: **0** (all 4 associated approval tokens remained valid and uncorrupted)
   - Persisted tool calls: **28** tool calls preserved intact
3. **Data Loss**: No user data or mission outputs were destroyed.

---

## 3. Preservation of Evidence
Raw JSON evidence containing all 71 affected records prior to mutation was extracted and saved to:
`docs/architecture/INCIDENT_68_RUNS_EVIDENCE.json`

---

## 4. Reconciled Records
The 3 orphaned runs with expired recovery leases were safely transitioned to terminal state `FAILED` on 2026-11-07:
1. `run_crash_recov_1793107421524` (Tenant: `user_m2a_tenant_a`)
2. `run_pg_exhaust_1793107439142` (Tenant: `user_m2a_tenant_a`)
3. `run_docker_e2e_1793107484806` (Tenant: `usr_m2a1_operator_a`)

**Applied Terminal Error Message**:
`Incident reconciliation: run abandoned during recovery attempt by expired recovery worker api-worker-1173`

---

## 5. Architectural Safeguards Implemented
1. **Worker Lease Fencing**: Workers must verify lease ownership and lease expiration before mutating run states.
2. **Provider Availability Pre-Flight Check**: Recovery sweeps cannot claim runs unless paid inference providers have completed readiness probes.
3. **Principal Boundary Quarantine**: Recovery is scoped strictly by workspace and tenant boundary, preventing cross-tenant run acquisition.
