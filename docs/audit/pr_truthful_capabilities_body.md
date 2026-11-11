## Architectural Summary & Truthful Capabilities Alignment

### 1. Objective & Scope
This pull request brings AIRA AI 2026's user-facing interface, documentation, settings, and model routing into strict alignment with its genuine production capabilities. Every selectable model, setting, plan benefit, tutorial instruction, and discovery card now directly corresponds to verified runtime behavior.

### 2. Key Changes Across Tracks

#### Track 1: Historical PR #163 Audit Superseded Notice
- Updated PR #163 description with an official `SUPERSEDED STATUS (2026-11-12)` notice confirming that the pre-merge Draft/NO GO warnings were resolved prior to deployment `562e75d40b2bed8bfc8fc03fe88dfa9f475b1213`, preserving all historical evidence intact.

#### Track 2: Authenticated Onboarding & Welcome Screen Lifecycle
- User onboarding state is strictly account-scoped (`aira_onboarding_<userId>`).
- Returning users who completed or skipped onboarding enter directly without modal reactivation on browser refresh.
- Account switching cleanly triggers onboarding only for accounts that have never completed it.
- Added a dedicated "Restart Tutorial" button in the Settings General & Personalization panel.

#### Track 3: Truthful Capabilities Tutorial & Walkthrough
- Replaced all unverified provider and model claims (Claude 3.5 Haiku, Claude 3.5 Sonnet, GPT-4o Mini, DeepSeek R1, 64k token budgets) with verified production infrastructure:
  - Ultra-low latency Groq LPU inference with Google Gemini failover
  - NVIDIA Nemotron 70B for high-fidelity code and multi-step reasoning
  - Real 128K token context window
  - Calibrated 8,192 token reasoning budgets

#### Track 4: Model Architecture & Selection Realignment
- Aligned `Model Selector → Model Registry → Entitlement Guard → Router → Provider → Executed Model → Response`:
  - `aira-auto`: Intelligent router directing tasks to Groq LPU or NVIDIA Nemotron 70B based on query complexity.
  - `aira-fast`: Ultra-low latency Groq LPU inference.
  - `aira-pro`: High-fidelity engineering and multi-step reasoning on NVIDIA Nemotron 70B.
  - `aira-deep`: Deliberate deep-research and architectural reasoning mode with extended thinking tokens on NVIDIA Nemotron 70B.
  - `nvidia/llama-3.1-nemotron-70b-instruct`: Direct NVIDIA NIM flagship 70B model.
- Preserved backward compatibility in `packages/contracts/src/model-registry.ts` and `src/utils/storage.ts`: legacy IDs (`claude-3-7-sonnet`, `claude-3-5-sonnet`, `claude-3-5-haiku`, `claude-3-opus`, `405b`) automatically normalize to canonical models.

#### Track 5: Settings Functional Integrity Audit
- **Response Style**: Implemented `composeSystemPrompt` injecting specific directives for `normal`, `concise`, `explanatory`, `academic`, and `code-first` into the system prompt.
- **User Bio & Personalization**: Profile bio is automatically attached to user prompts under bounded context.
- **Custom Instructions**: User custom instructions are appended after bio context.
- **Extended Thinking**: Calibrated slider to enforce genuine backend bounds [1,024 to 8,192 tokens].
- **Agent Memory Count**: Replaced hardcoded `memoryCount = 0` with live reactive subscription via `useSyncExternalStore(agentMemory.subscribe, agentMemory.getSnapshot)`.
- **Automatic Privacy Scrubbing**: Replaced cosmetic toggle with an `Enforced Safeguard` badge and shield icon.
- **Appearance & Accessibility**: Confirmed all 8 theme presets, font scaling, contrast, and reduced motion.

#### Track 6: Subscription Tier Truthfulness
- Verified 4-tier matrix: Guest, Free, Plus, Pro with disabled sandbox checkout.
- Fixed misleading "(Aira Pro Workspace)" label in Settings to dynamically display the user's active tier workspace (e.g. `Free Workspace`, `Plus Workspace`, `Pro Workspace`).

#### Track 7: Sparkles Icon De-duplication
- Replaced `<Sparkles>` in Model Selector header with `<Gauge>` and mapped Auto badge glyph to `Gauge`.
- Replaced `<Sparkles>` on Settings "My Plan & Usage" tab and shortcut button with `<CreditCard>`.

#### Track 8: Documentation & Discovery Card Truthfulness
- Synchronized `HelpCenterModal.tsx`, `ReleaseNotesModal.tsx`, `LegalViewerModal.tsx`, and `featureDiscovery.ts` with truthful runtime providers and capabilities.

### 3. Verification & Evidence
- `test/truthful-capabilities-model-architecture.test.ts`: **8/8 PASS**
- `test/model-router-provider-routing.ts`: **PASS**
- `test/contracts-entitlements.test.ts`: **21/21 PASS**
- `test/unified-intelligence-architecture.test.ts`: **6/6 PASS**
- `test/adversarial-tier5.test.ts`: **30/30 PASS**
- `test/e2e/entitlements/runner.ts`: **285/285 PASS**
- `npm run typecheck:client` (`tsc -b`): **PASS (0 errors)**
- `npm run typecheck:server`: **PASS (0 errors)**
- `npx vite build`: **PASS (built in 12.8s)**
- `npm run lint` (`oxlint`): **PASS (0 errors)**

### 4. Operational Guardrails
- Zero production database schema migrations (locked at 31 migrations).
- Zero database mutations.
- Zero payment gateway activations.
- Pure code-only capability alignment.
