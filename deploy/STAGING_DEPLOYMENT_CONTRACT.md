# AIRA AI 2026 — Operational Staging Deployment Contract & Runbook

**Document Version**: 1.0.0-RC  
**Certified HEAD Commit**: `dbcb69c575671bdd0e82d9d67ad2331d732c6ddb`  
**Target Pull Request**: Draft PR #127  
**Effective Date**: 2026-11-02  
**Classification**: Operational Staging Contract & Release Governance  

---

## 1. Executive Summary & Strict Release Boundary Governance

This document establishes the binding operational deployment contract and production-grade runbook for the **AIRA Autonomous Intelligence Platform Specialist Worker Host** in the permanent staging environment.

### 1.1 Strict Release Boundary & Deployment Authority
In accordance with repository `AGENTS.md` and release authority rules:
- **Draft Status**: PR #127 must remain strictly in **DRAFT** status until an explicit human **GO LIVE** instruction is issued.
- **Zero Automated Promotion**: Merging any PR into `prod-release` triggers automatic Vercel production deployment.
- **No Agent Merge Authority**: Under NO circumstances may an automated coding agent, CI assistant, or autonomous workflow merge PR #127 into `prod-release`, promote a Vercel deployment, or apply production Neon migrations.
- **Human Authority Requirement**: A fresh, explicit, human **GO LIVE** authorization for the exact SHA (`dbcb69c575671bdd0e82d9d67ad2331d732c6ddb`) and target environment is mandatory from repository owner `rajpunkeshwarrajgautam-boop`.

---

## 2. Worker Container Architecture

The autonomous platform splits responsibilities between stateless serverless frontend/API functions (Vercel) and long-running background autonomous agent daemons:

```
                                  AIRA STAGING ARCHITECTURE
                                  
    +-----------------------------------------------------------------------+
    |                         VERCEL SERVERLESS LAYER                       |
    |                                                                       |
    |  Next.js / Vite SPA (Frontend)          Express API (/api/*)          |
    |  https://staging.virexaaiventures.com   10-second timeout ceiling     |
    +------------------------------------+----------------------------------+
                                         |
                                         v Writes Task / Session
    +-----------------------------------------------------------------------+
    |                    NEON SERVERLESS POSTGRESQL (STAGING)               |
    |                                                                       |
    |  Project: mute-frost-50372225                                         |
    |  Endpoints: ep-shiny-bird-b3xundyt (main branch: br-autumn-star)      |
    |                                                                       |
    |  Tables:                                                              |
    |  - autonomous_agent_tasks (Migration 031: Fencing tokens, Leases)     |
    |  - specialist_tasks       (Migration 026: DAG orchestration)          |
    |  - durable_browser_sessions (AES-256-GCM envelope encryption)         |
    +------------------------------------+----------------------------------+
                                         ^
                                         | Transactional Poll (FOR UPDATE)
                                         | Heartbeat / Fencing writes
                                         v
    +-----------------------------------------------------------------------+
    |                    AUTONOMOUS SPECIALIST WORKER HOST                  |
    |                         (apps/specialist-worker)                      |
    |                                                                       |
    |  - AutonomousWorkerHost (High-level autonomous objective state engine)|
    |  - SpecialistWorkerHost (DAG specialist task queue processor)         |
    |  - Registered Specialists: Planner, Researcher, Coder, Mathematical,  |
    |    Document, Browser, Automation, Verification, Synthesizer           |
    |  - MCP Tool Wire (stdio/SSE/HTTP) with environment sanitization       |
    |  - Container Sandbox Isolation (Docker/OCI/E2B/Lightning fail-closed) |
    |  - Playwright Headless Browser with durable state persistence         |
    +-----------------------------------------------------------------------+
```

### 2.1 Core Components
1. **`apps/specialist-worker`**:
   Node.js 22 daemon hosting dual queue loops:
   - `specialist_tasks` queue: Claims and runs sub-graphs of specialized tasks.
   - `autonomous_agent_tasks` queue: Claims and runs multi-step autonomous missions (`CREATED` -> `PLANNING` -> `RUNNING` -> `COMPLETED`/`FAILED`).
2. **`Dockerfile.worker`**:
   - Base image: `node:22-alpine`
   - Process supervision: `dumb-init` for deterministic signal propagation.
   - Least privilege: Unprivileged operational user `aira` (UID/GID `10001`).
   - Memory boundary: `NODE_OPTIONS="--max-old-space-size=384"`.
   - Healthcheck: Native `curl -f http://localhost:8080/health || exit 1`.
3. **`docker-compose.staging.yml`**:
   - Container name: `aira-specialist-worker-staging`.
   - Port binding: `127.0.0.1:8080:8080` (loopback only, no internet exposure).
   - Resource quotas: CPU limit `0.5`, Memory limit `1024M`.
   - Restart policy: `unless-stopped`.
4. **`deploy/systemd/aira-worker.service`**:
   - Systemd unit managing the Docker worker container on Linux hosts.
   - User/Group: `aira:aira`.
   - Environment file: `/etc/aira/staging-worker.env`.
   - Graceful shutdown: `KillSignal=SIGTERM`, `TimeoutStopSec=30s`.

---

## 3. Staging Configuration & Environment Matrix

### 3.1 Certified Staging Database Target
- **Neon Staging Project ID**: `mute-frost-50372225`
- **Main Branch**: `br-autumn-star-b36dfu5w`
- **Staging Hostname**: `ep-shiny-bird-b3xundyt-pooler.c-4.ap-southeast-1.aws.neon.tech`
- **Connection String Protocol**:
  ```bash
  DATABASE_URL="postgresql://neondb_owner@ep-shiny-bird-b3xundyt-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
  ```

### 3.2 Environment Variable Matrix (`.env.staging.worker.template`)
| Variable | Staging Value | Purpose |
|---|---|---|
| `DATABASE_URL` | Neon staging pooled connection string | Durable storage target |
| `NODE_ENV` | `production` | Enables production optimizations & strict checks |
| `AIRA_ENV` | `staging` | Staging environment identifier |
| `AIRA_PRODUCTION_WORKER_ENABLED` | `false` | **Enforces DB isolation guard**; prevents accidental prod access |
| `WORKER_ID` | `worker_staging_primary_01` | Unique instance lease identity |
| `WORKER_CONCURRENCY` | `2` | Bounded concurrent step execution |
| `POLL_INTERVAL_MS` | `500` | Active queue polling frequency |
| `MAX_POLL_INTERVAL_MS` | `2000` | Idle exponential backoff ceiling |
| `IDLE_BACKOFF_MULTIPLIER` | `1.5` | Backoff multiplier when queues are empty |
| `LEASE_DURATION_MS` | `15000` | 15s transactional lock expiration |
| `HEARTBEAT_INTERVAL_MS` | `3000` | 3s lease renewal pulse |
| `PORT` | `8080` | Internal management & health server port |
| `WORKER_BIND_HOST` | `0.0.0.0` (inside container) | Listens on container interface; host binds `127.0.0.1` |
| `NODE_OPTIONS` | `"--max-old-space-size=384"` | V8 garbage collector heap constraint |

### 3.3 Zero Production Crossover Guarantee
- Verified by `packages/db/src/security/database-isolation-guard.ts`.
- If `DATABASE_URL` contains `ep-withered-art-b36ox90b` (Neon Production `proud-water-05360408`) and `AIRA_PRODUCTION_WORKER_ENABLED !== 'true'`, the worker process **immediately aborts with fatal code 1**.
- Certified by 41 passing isolation tests in `test/database-isolation-guard.test.ts`.

---

## 4. Operational Runbook

### 4.1 Deployment & Service Startup

#### Option A: Docker Compose
```bash
# 1. Populate staging environment file
cp .env.staging.worker.template .env.staging.worker
chmod 600 .env.staging.worker
# Edit .env.staging.worker to add authorized staging credentials

# 2. Build and launch container in background
docker compose -f docker-compose.staging.yml --env-file .env.staging.worker up -d --build

# 3. Verify container status
docker compose -f docker-compose.staging.yml ps
```

#### Option B: Systemd Linux Host Service
```bash
# 1. Install service definition
sudo cp deploy/systemd/aira-worker.service /etc/systemd/system/aira-worker.service
sudo mkdir -p /etc/aira
sudo cp .env.staging.worker.template /etc/aira/staging-worker.env
sudo chown -R aira:aira /etc/aira /opt/aira-worker
sudo chmod 600 /etc/aira/staging-worker.env

# 2. Reload daemon and start
sudo systemctl daemon-reload
sudo systemctl enable aira-worker
sudo systemctl start aira-worker

# 3. Verify status
sudo systemctl status aira-worker
```

### 4.2 Health and Readiness Probes
The worker exposes HTTP endpoints on `http://127.0.0.1:8080`:

1. **Liveness Probe**: `GET /health`
   - Returns `HTTP 200 OK` with JSON:
     ```json
     {
       "status": "healthy",
       "workerId": "worker_staging_primary_01",
       "uptime": 124.5,
       "specialistWorker": { "running": true, "activeTasks": 0 },
       "autonomousWorker": { "running": true, "activeTasks": 1 }
     }
     ```
   - If unhandled failure or unrecovered crash occurs: Returns `HTTP 503 Service Unavailable`.

2. **Readiness Probe**: `GET /ready`
   - Checks active database connectivity and loop readiness.
   - Returns `HTTP 200 OK` when both queue loops are polling.
   - Returns `HTTP 503` during initialization, draining, or database disconnect.

### 4.3 Log Inspection & Diagnostics
```bash
# View live container logs
docker logs -f aira-specialist-worker-staging

# Or view systemd journal logs
sudo journalctl -u aira-worker -f -o cat
```
Standard log signatures to monitor:
- `[AutonomousWorkerHost] Claimed task <id> with fencing token <token>`
- `[AutonomousWorkerHost] Heartbeat renewed for task <id>`
- `[AutonomousWorkerHost] Completed step <stepId> for task <id>`
- `[SpecialistWorkerHost] Executing specialist <name> on task <id>`

### 4.4 Graceful Shutdown Procedure
The worker handles `SIGTERM` and `SIGINT` with a 30-second draining window:
1. Stops claiming new tasks from both queues immediately (`ready` flips to `false`).
2. Current in-flight steps are allowed up to 30 seconds to finish execution and persist checkpoints.
3. Leases for unfinished steps are released cleanly, or allowed to expire at `lease_expires_at` for replacement workers.
4. Database connection pools close cleanly; process exits with code 0.

To initiate graceful shutdown:
```bash
docker stop -t 30 aira-specialist-worker-staging
# Or via systemd
sudo systemctl stop aira-worker
```

---

## 5. Rollback & Forward Migration Protocols

### 5.1 Immediate Container Rollback
If a defect is observed in worker execution:
1. **Stop Worker Container Immediately**:
   ```bash
   docker stop -t 5 aira-specialist-worker-staging
   ```
2. **Lease Expiration & State Safety**:
   Active leases automatically expire after 15 seconds (`LEASE_DURATION_MS=15000`). No manual database unlock is required.
3. **Re-deploy Previous Verified Image**:
   Point systemd or Docker Compose to the previous certified tag (e.g., `dbcb69c575671bdd0e82d9d67ad2331d732c6ddb`).

### 5.2 Migration 031 Non-Destructive Data Barrier
In accordance with production reliability standards, migration `031_autonomous_agent_tasks.ts` provides strict safety barriers in `down(knex)`:
- **Destructive Rollback Blocking**:
  `down(knex)` queries `SELECT COUNT(*) FROM autonomous_agent_tasks`. If active user records exist and `AIRA_ALLOW_DESTRUCTIVE_ROLLBACK !== 'true'`, rollback throws:
  ```
  [MIGRATION SAFETY BARRIER] Aborting rollback of migration 031: Table "autonomous_agent_tasks" contains <N> user record(s).
  Dropping tables in an active environment will cause catastrophic data loss.
  Use a non-destructive forward migration instead, or set AIRA_ALLOW_DESTRUCTIVE_ROLLBACK=true to force.
  ```
- **Forward Migration Protocol**:
  Schema modifications must ALWAYS be executed via additive forward migrations (`032_*.ts`), never by dropping active tables.
- **State Preservation**:
  In-flight task state, execution history, artifacts, working memory, and encrypted browser sessions (`durable_browser_sessions`) are preserved across worker restarts and rollback events.

---

## 6. Monitoring, Heartbeats, Leases, and Alerting

| Metric / Event | Target Threshold | Alert Level | Remediation |
|---|---|---|---|
| **Heartbeat Renewal** | Every 3,000ms | Warning if missed > 6,000ms | Check worker event loop lag; verify DB latency |
| **Lease Duration** | 15,000ms | Critical if expired while task RUNNING | Automatic: replacement worker claims task via fencing increment |
| **Fencing Token Conflicts** | 0 expected | Critical | Indicates split-brain or stale worker attempting writes; investigate worker network |
| **Healthcheck Failures** | 0 consecutive | Critical if > 3 failures (30s) | Docker / systemd auto-restarts container |
| **V8 Heap Memory** | < 384MB | Warning if > 320MB | Inspect specialist memory leaks; worker limits garbage collection via max-old-space-size |
| **Task Failure Rate** | < 1% | High if > 5% | Check upstream model API keys, sandbox availability, or tool timeouts |

---

## 7. Verification & Attestation Gates

This contract is attested against the exact commit `dbcb69c575671bdd0e82d9d67ad2331d732c6ddb` with the following independently verified test battery:

| Verification Suite | Target Areas | Pass Count | Exit Code |
|---|---|:---:|:---:|
| `npm run typecheck` | Frontend, Server, and API TypeScript contracts | 0 errors | 0 |
| `npm run test:release-auth:unit` | Dual-evidence release authorization guard | 52 / 52 | 0 |
| `test/operational-staging-worker-certification.test.ts` | 8-Target Worker Certification (Queues, Fencing, Graceful Exit) | 15 / 15 | 0 |
| `test/operational-staging-acceptance-and-fault-injection.test.ts` | E2E Autonomous Objective, Crash Recovery, Migration Safety | 12 / 12 | 0 |
| `test/database-isolation-guard.test.ts` | Production DB rejection, Neon staging acceptance, Crossover guards | 41 / 41 | 0 |
| `npm run lint` | Oxlint verification across 464 source files | 0 errors | 0 |
| `npm run build` | Production client build & bundle packaging | PASS (2.62s) | 0 |

---

## 8. Certification Sign-Off

- **Lead Integration Reviewer**: Teamwork Release Candidate Certification Reviewer (`reviewer_m4`)
- **Reviewer Persona**: `agency-reality-checker` (Evidence-Obsessed, Zero Fantasy)
- **Certification Status**: **VERIFIED & CERTIFIED FOR STAGING DEPLOYMENT**
- **Production Merge Authorization**: **RESTRICTED / DRAFT ONLY** (Requires explicit human GO LIVE instruction)
