# AIRA Agent Runtime V2 — Integration Status (14 October 2026)

## Protected integration baseline

This work is draft PR #69, stacked on PR #68 (durable missions) and PR #67
(truthful tool execution). Protected `prod-release`, production databases and
domains are not deployment targets of this work. This document does not assert
that any of these draft PRs is merged.

## Reuse decisions

| Component | Source | Decision |
|---|---|---|
| Core run/event/checkpoint store | `packages/agent-runtime/src/index.ts`, `repositories.ts` | **Reuse** authoritative state and approval policy; do not create a competing store |
| Model routing | `packages/model-router/src/index.ts` | **Reuse** real provider adapter, reject mock provider for model plans |
| ToolGateway | `packages/tool-runtime/src/gateway.ts` | **Reuse** permission, registered tool and principal-scope checks |
| Deterministic missions | `mission-plan.ts` from PR #68 | **Preserve** existing verified behavior |
| Aira Bot Docker computers | PRs #3–6, `packages/computer-runtime` | **Experimental: inspect, harden and certify** with supported Docker host, profiles and per-owner fencing before integration; not merged |
| Aira Bot delegation/skills | PRs #4–6, `packages/aira-bot` | **Experimental: evaluate** owner-scoped child provenance, cycle protection and isolation; not merged |
| Application builder container runner | PRs #42–45, `packages/app-builder` | **Experimental: evaluate** container lifecycle, durable queue, immutable artifacts and storage; no live-host acceptance or merge |
| Verified principal | PR #65 (unmerged) | **Required dependency** for persistent per-owner workspaces, browser profiles and child delegations |
| Release control | PR #64 (unmerged) | **Honor policy**: no production GO LIVE without explicit exact-SHA approval |

## Implemented on this branch

- `model-mission.ts`: strict JSON/Zod parsing of model-proposed read-only plans,
  deterministic validation of actual available tools/scopes/targets, ordered
  dependencies, bounded six-step maximum and signed stored-plan provenance.
- `index.ts`: behind `AIRA_MODEL_MISSIONS_ENABLED=true`, create the model
  plan through an actually configured provider. Check HMAC, principal scopes
  and exact current tool call **before dispatch** and again after execution.
  The existing run repository persists progression, events and recovery state.
- `independent-outcome.ts`: independent filesystem/git readback before mission
  completion. Missing steps, changed files and forged outputs cause failure.
- `file-adapter.ts`: reject sibling-directory containment escapes and symlink
  traversal in addition to lexical path checks.
- `test/agent-v2-security.test.ts`: explicit negative tests for forged plans,
  missing scopes, unauthorized mutations, path traversal and false success.

## Required environment and release gates

Model planning is **disabled by default**. To enable for an isolated staging
environment after review, configure:

- `AIRA_MODEL_MISSIONS_ENABLED=true`
- `AIRA_AGENT_PLAN_SIGNING_KEY`: stable secret at least 32 characters; must be
  identical on all workers and preserved for crash recovery
- One real supported model provider key via existing ModelRouter config
- Verified principal and appropriate `files.read` / `repo.read` scopes
- A protected, owner-isolated workspace and durable PostgreSQL state

Do not put signing keys in repository, browser, client bundle, job logs, or PR.

The current allowed planner tools are restricted to read-only file listings,
explicitly named file reads, git status and git history. This is intentionally
**not** a general-purpose mutation runtime and does not mean browser, Docker,
Aira Bot or hosted build-worker integration has passed.

## Incomplete acceptance and hard blockers

- **Model planning**: code integrated; live model-provider acceptance pending
  staging provider and signing secret.
- **Isolated writes**: not integrated; external Docker-capable host,
  signed worker identity, per-owner workspaces, approval fencing and live
  build/test acceptance required. DO NOT run user code in the Vercel function.
- **Persistent browser**: existing separate implementation not merged;
  must certify real Chromium sessions, profile lifecycle, non-idempotent form
  actions, human takeover, restart recovery and per-account isolation.
- **Specialist delegation**: existing separate Bot implementation not merged;
  must integrate parent/child run records with verified principal, delegated
  scope intersection, cycle/depth limits, cancellation and result evidence.
- **Outcome verification**: read-only filesystem/Git independent postconditions
  implemented, but deployments, external browser actions, documents, writes
  and research claims need different independent verifiers.
- **End-to-end AG-01 to AG-20**: do not mark live scenarios PASS based only
  on simulated unit tests. Collect exact execution proof when connected
  provider, browsers and workers are available.

## Branch integration and release sequence

1. Review and certify PR #67 and PR #68, preserving their exact merge order.
2. Certify PR #69 against its exact HEAD, inspect dynamic planning policy
   and readback false-success tests.
3. Integrate vetted worker/browser/delegation components in separate reviewable
   stacked PRs from existing branches. Avoid wholesale blind merges.
4. Deploy only isolated staging workers and credentials once authorized.
5. Run independent real model, Docker, browser, identity and mutation tests.
6. Obtain a fresh owner GO LIVE authorization for the **exact candidate SHA**.
7. Only after all mandatory security, CI and live acceptance gates can
   the protected `prod-release` branch be considered for merge.
