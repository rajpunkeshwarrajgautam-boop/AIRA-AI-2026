# AIRA AI 2026 — M2-A PRODUCTION WORKER HOSTING DECISION PACKAGE
## Infrastructure Evaluation, Cost Modeling, Security Controls & Architecture Recommendation

**Document Version:** 1.0.0-PROD-HOSTING  
**Date:** 2026-10-27  
**Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Dedicated Worktree:** `C:\Users\WORKSTATION\AIRA-AI-2026-M2A-DURABLE-EXECUTION`  
**Target Environment:** Production (`AIRA_ENV=production`)  
**Database Target:** Production Neon (`old-sky-50952395`, Endpoint: `ep-withered-art-b36ox90b.us-east-2.aws.neon.tech`)  
**Production URL:** `https://aira-ai-2026.vercel.app/`  
**Current Status:** **PROPOSAL ONLY — ZERO INFRASTRUCTURE PROVISIONED — AWAITING OWNER DECISION**

---

## 1. Executive Summary & Core Hosting Requirements

The AIRA M2-A Durable Specialist Execution subsystem decouples long-running, CPU/IO-intensive specialist agents (e.g., Mathematics, Research, Code Analysis) from ephemeral Vercel Serverless HTTP request lifecycles.

To run the background `SpecialistWorkerHost` reliably in production, the hosting platform must meet strict non-negotiable operational and security requirements:

1. **Always-On Long-Running Process**: Cannot be terminated by serverless 15-second or 60-second timeouts.
2. **Private Network Egress to Neon**: Low-latency TLS 1.3 connectivity to AWS `us-east-2` (Neon's host region).
3. **Strict Secrets Hygiene**: Secure injection of `DATABASE_URL` without exposing secrets in logs or container inspect.
4. **Isolated Memory & Concurrency**: Dedicated resources capable of enforcing 512 MB Node.js V8 heap constraint and handling concurrency=2–4 without OOM crashes.
5. **Fail-Closed Rolling Restarts**: Process termination signal (`SIGTERM`) must cleanly drain in-flight tasks and release/persist leases before shutdown.
6. **Zero Inbound Public Attack Surface**: The worker polls tasks outward from Neon via `SELECT ... FOR UPDATE SKIP LOCKED`. **Zero open inbound HTTP ports are required in production.**

---

## 2. Comprehensive Provider Evaluation Matrix

We evaluated four industry-standard production hosting options for Node.js container workloads:

| Dimension | Option 1: AWS ECS Fargate | Option 2: Fly.io | Option 3: Railway (Pro) | Option 4: Dedicated VPS (Hetzner / DO) |
| :--- | :--- | :--- | :--- | :--- |
| **Compute Architecture** | Managed serverless containers | MicroVMs (Firecracker) | Managed container PaaS | KVM Virtual Machine |
| **Reliability / SLA** | 99.99% (AWS standard) | 99.9% | 99.9% | 99.9% (provider hardware) |
| **Operational Overhead** | Low (Serverless, no OS patching) | Very Low | Minimal (Zero-ops PaaS) | High (Manual OS/Docker maintenance) |
| **Deployment Controls** | Task revisions, native rollbacks, IAM gates | Fly CLI, rolling updates | Git-push / Webhook promotion | Manual Docker Compose / SSH scripts |
| **Secret Management** | AWS Secrets Manager / SSM Parameter Store | Encrypted Fly Secrets | Encrypted Environment Variables | Local `.env` / Docker secrets (manual) |
| **Network Isolation** | AWS VPC private subnet (No public IP) | Private WireGuard 6PN | Isolated container network | Host firewall (UFW / iptables) |
| **Regional Co-Location** | AWS `us-east-2` (Ohio) — **<2ms to Neon** | `ord` (Chicago) / `iad` (Virginia) (~15-25ms) | `us-east4` (~10-20ms) | Varies (e.g., Ashburn ~15ms, Germany ~100ms) |
| **PostgreSQL Stability** | Maximum (Same AWS backbone as Neon) | High | High | Depends on public ISP transit |
| **Graceful Shutdown** | Configurable `stopTimeout` (up to 120s) | Configurable `kill_signal` & timeout | Configurable shutdown timeout | Controlled via `docker stop -t 30` |
| **Horizontal Scaling** | Auto-scaling based on queue depth / CPU | Fly autoscaling | Manual or metric-based scaling | Manual replica provisioning |
| **Logging & Observability** | Amazon CloudWatch Logs + Insights | Fly logs + Grafana Loki integration | Native dashboard + Log drains | Local journald / Promtail to external |

---

## 3. Financial Scenarios & Cost Breakdown

All cost estimates reflect published official 2026 pricing for North America regions.

### Baseline Container Specification:
- **CPU:** 0.5 vCPU
- **Memory:** 1.0 GB RAM
- **Node.js Memory Ceiling:** `--max-old-space-size=512`
- **Concurrency:** 2 concurrent specialist tasks per replica

### Scenario Cost Matrix (USD / Month):

| Hosting Provider | 1 Worker Replica | 2 Worker Replicas | 4 Worker Replicas | Additional Costs (Logging / Egress) |
| :--- | :---: | :---: | :---: | :--- |
| **AWS ECS Fargate (`us-east-2`)** | **$18.25** | **$36.50** | **$73.00** | CloudWatch Logs (~$2.50/mo), NAT Gateway if used ($32/mo) or free with public egress |
| **Railway (Pro Tier)** | **$12.00** | **$19.00** | **$33.00** | $5.00/mo platform fee included, egress 100 GB included |
| **Fly.io (`shared-cpu-1x`, 1GB)** | **$5.70** | **$11.40** | **$22.80** | Dedicated IPv4 not required (outbound only), egress 100 GB included |
| **Dedicated VPS (DigitalOcean Droplet)**| **$6.00** | **$12.00** | **$24.00** | Basic 1 vCPU / 1 GB Droplet, backups +$1.20/mo |

*Note on AWS NAT Gateway: To run Fargate tasks in a private subnet without public IP while reaching Neon over the internet, an AWS NAT Gateway costs ~$32.85/mo. Alternatively, assigning a public IP to the Fargate task inside a public subnet with a Security Group that blocks ALL inbound traffic (0.0.0.0/0 inbound DENIED) achieves identical network security at $0.00 network surcharge.*

---

## 4. Architectural Recommendation

### Primary Recommendation: **AWS ECS Fargate (`us-east-2`)**
**Rationale:**
1. **Network Co-Location with Neon**: Neon PostgreSQL production (`ep-withered-art-b36ox90b`) is hosted in AWS `us-east-2` (Ohio). Hosting the worker on AWS ECS Fargate in `us-east-2` eliminates cross-cloud egress costs and provides sub-2ms query latency, crucial for frequent lease renewal heartbeats and task state persistence.
2. **Enterprise Security & Zero Inbound Exposure**: Fargate security groups allow strictly blocking all ingress ports while permitting outbound HTTPS (443) and PostgreSQL (5432) to Neon.
3. **Deterministic Deployment & Rollback**: ECS Task Definition versions provide exact immutable SHA image tracking, automatic rollback on health probe failure, and native integration with GitHub Actions CI.

### Alternative (Fast-Start / Budget) Option: **Railway (Pro)**
**Rationale:**
- If the owner prefers minimal cloud console setup, Railway offers 1-click Dockerfile deployments with isolated container environments, built-in encrypted secrets, and low monthly cost ($12.00/mo).

---

## 5. Minimum Production Container Configuration

```dockerfile
# apps/specialist-worker/Dockerfile
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV AIRA_ENV=production
ENV AIRA_PRODUCTION_WORKER_ENABLED=false
ENV NODE_OPTIONS="--max-old-space-size=512"

# Security: Run as unprivileged non-root user
USER node

# Health check probe against local worker process
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "dist/index.js"]
```

---

## 6. Decision & Human Authorization Boundaries

The repository owner (`rajpunkeshwarrajgautam-boop`) must select and approve the target provider before any infrastructure provisioning or credential allocation occurs:

- [ ] **Option A: AWS ECS Fargate (`us-east-2`)** — ~$18.25/mo per replica (Recommended)
- [ ] **Option B: Railway (Pro)** — ~$12.00/mo per replica
- [ ] **Option C: Fly.io** — ~$5.70/mo per replica
- [ ] **Option D: Dedicated VPS** — ~$6.00/mo per replica

**NO INFRASTRUCTURE HAS BEEN PROVISIONED. NO CHARGES HAVE BEEN INCURRED.**
