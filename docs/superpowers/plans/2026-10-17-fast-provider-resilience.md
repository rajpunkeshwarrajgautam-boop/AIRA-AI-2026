# Fast Provider Resilience & Tail-Latency Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate upstream AI inference tail latency on AIRA Fast chat via latency-aware provider routing, circuit breaking, first-token deadlines, truthful fallback, and hedged request evaluation.

**Architecture:** A resilient routing layer inside `packages/model-router` that tracks rolling provider health, manages CLOSED/OPEN/HALF_OPEN circuit breaker state machines, enforces strict first-content-token deadlines without counting thinking/SSE metadata, executes truthful fallback or controlled hedging before visible tokens stream, and preserves truthful model provenance.

**Tech Stack:** TypeScript, Node.js 24, Express, Vitest/Node test runner, Vercel Serverless, Groq / NVIDIA NIM APIs.

**Spec:** `# AIRA AI 2026 — P1.6 FAST PROVIDER RESILIENCE & TAIL-LATENCY REMEDIATION`

## Global Constraints
- Baseline commit: `origin/prod-release` `1ba53bca4ff3c9a86e508a537541f19a16612053`.
- Production Safety: Code changes on branch `fix/p1-6-fast-provider-resilience-20261017`, Preview deployment, provider benchmarks, tests, PR, and CI authorized. Zero production mutations.
- True browser P50 TTFT <= 2,000 ms; preferred P95 <= 3,000 ms.
- Success rate >= 99%. Quality score floor >= 7.5 / 10.
- NVIDIA Nemotron 120B remains AIRA Deep and must NEVER be used as a slow fallback for Fast mode.
- Provenance must be 100% truthful: `requestedProvider`, `requestedModel`, `executedProvider`, `executedModel`, `fallbackOccurred`, `fallbackReason`, `modelIdentityVerified`.
- Pre-first-token database queries must remain exactly 1 (no regression to P1.5).

---

### Task 1: Provider Health Tracker & Circuit Breaker Engine
**Files:**
- Create: `packages/model-router/src/health-tracker.ts`
- Test: `test/p1-6-provider-health-circuit-breaker.test.ts`

**Interfaces:**
- Produces: `ProviderHealthTracker`, `CircuitBreakerState` (`'CLOSED' | 'OPEN' | 'HALF_OPEN'`), `ProviderTelemetry`, `recordSuccess(provider, model, ttftMs)`, `recordFailure(provider, model, error, statusCode)`, `getCircuitState(provider, model)`, `isAvailable(provider, model)`.

- [ ] **Step 1: Write failing test for ProviderHealthTracker & Circuit Breaker**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement ProviderHealthTracker with sliding window statistics and exponential backoff cooldown**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit changes**

---

### Task 2: Latency-Aware Provider Selection Policy & Quality Floor
**Files:**
- Create: `packages/model-router/src/routing-policy.ts`
- Test: `test/p1-6-routing-policy.test.ts`

**Interfaces:**
- Produces: `LatencyAwareRoutingPolicy`, `CandidateModelConfig`, `selectFastExecutionPlan(healthTracker, options)`.
- Rejects models that return empty responses (`openai/gpt-oss-20b`) or have severe rate limits when degraded.
- Enforces quality floor (>= 7.5 / 10) and prevents NVIDIA Nemotron 120B slow fallback.

- [ ] **Step 1: Write failing test for LatencyAwareRoutingPolicy**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement LatencyAwareRoutingPolicy with deterministic ranking and fallback selection**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit changes**

---

### Task 3: First-Token Content Deadline & Truthful Fallback Engine
**Files:**
- Create: `packages/model-router/src/resilient-adapter.ts`
- Modify: `packages/model-router/src/index.ts`
- Test: `test/p1-6-first-token-deadline-fallback.test.ts`

**Interfaces:**
- Produces: `ResilientModelAdapter`, `executeWithFallback(...)`, strict discrimination between content tokens vs thinking/headers/keepalive deltas, abort signal propagation.
- Guarantees: No provider switching once visible content has started (`requestStickiness`). Truthful provenance returned on fallback.

- [ ] **Step 1: Write failing test for first-token deadline and fallback before content**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement ResilientModelAdapter with content token detection and truthful fallback**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit changes**

---

### Task 4: Controlled Hedged-Request Experiment Engine
**Files:**
- Modify: `packages/model-router/src/resilient-adapter.ts`
- Test: `test/p1-6-hedged-requests.test.ts`

**Interfaces:**
- Evaluates: Launching secondary request after hedge delay (e.g. 1200ms) if primary has emitted no content tokens.
- Guarantees: First valid stream wins; loser is immediately cancelled via `AbortController`; only 1 stream emits to client; truthful provenance reflects winner and hedged status.

- [ ] **Step 1: Write failing test for Hedged-Request Engine**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement Hedged-Request execution with cancellation of losing attempt**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit changes**

---

### Task 5: Integration with AgentRuntime, API Telemetry, and Multi-Turn Consistency
**Files:**
- Modify: `packages/agent-runtime/src/index.ts`
- Modify: `apps/api/src/index.ts`
- Test: `test/p1-6-multi-turn-consistency.test.ts`

**Interfaces:**
- Exposes: Selection reason, circuit breaker state, hedge telemetry in SSE `latency_metrics` and logs.
- Verifies: Multi-turn context (turn 1 context, turn 2 recall, turn 3 technical follow-up) preserved across primary and fallback scenarios.
- Verifies: Zero database regressions (pre-first-token DB queries = 1, DB acquire P95 = 0 ms).

- [ ] **Step 1: Write failing test for multi-turn consistency across fallback scenarios**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Wire ResilientModelAdapter into AgentRuntime and API streaming handler**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit changes**

---

### Task 6: Preview Deployment, Multi-Batch Variance Testing, and Reporting
**Files:**
- Create: `scripts/benchmark-preview-p1-6-suite.ts`
- Create: `P1_6_PROVIDER_BASELINE.md`
- Create: `P1_6_PROVIDER_BENCHMARK.json`
- Create: `P1_6_PROVIDER_ROUTING_POLICY.md`
- Create: `P1_6_PROVIDER_RESILIENCE_REPORT.md`

- [ ] **Step 1: Deploy P1.6 branch to Vercel Preview**
- [ ] **Step 2: Execute at least 50 Fast requests across Batches A, B, and C against live Preview**
- [ ] **Step 3: Measure true browser TTFT, provider TTFT, fallback rate, 429 rate, quality, and database metrics**
- [ ] **Step 4: Generate all 4 required reports with exact empirical evidence**
- [ ] **Step 5: Run full CI test suite and verify 100% green pass**
- [ ] **Step 6: Open GitHub PR using Matt Pocock PR template without merging**
