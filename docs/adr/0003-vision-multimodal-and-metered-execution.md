# ADR 0003: Vision, Multimodal Operations and Metered Tool Execution

## Status
Accepted

## Context
AIRA AI 2026 includes AIRA Vision (Understand, Generate, Edit), AIRA Research, AIRA Agents, and AIRA Builder.
These operations incur significant variable compute costs and must be accurately metered against customer credit wallets:
- Vision Understand: OCR, diagram inspection, image question answering.
- Vision Generate: 1 or 2 images, 1:1, 3:4, 16:9, Standard / High quality.
- Vision Edit: inpainting, adjustments, style transformations.
- Builder Sandbox: container creation, file edits, compilation, preview duration.
- Agents: multi-step tool calls, LLM iterations, execution budget enforcement.

## Decisions
1. **Pre-Flight Tariff Check & Pre-Authorization**:
   Every multimodal and builder operation checks the user's available credits against the design tariff.
   Provisional Tariffs:
   - Vision Economy Standard: 12 credits / image
   - Vision Economy High: 24 credits / image
   - Vision Premium Standard: 100 credits / image
   - Vision Premium High: 125 credits / image
   - Vision Economy Edit: 40 credits
   - Vision Economy High Edit: 80 credits
   - Vision Premium Edit: 130 credits
   - Vision Advanced Premium Edit: 250 credits
   - Builder Sandbox: 10 credits / minute active compute
2. **Deterministic Two-Phase Reservation**:
   Max estimated cost is reserved before calling external providers (e.g. Fal.ai / Replicate / OpenAI). Upon completion or partial error, only actual executed work is settled, and any remaining reservation is immediately released.
3. **Execution Caps and Hard Limits**:
   Agents and Builder runs enforce strict step count limits and wall-clock timeouts to eliminate runaway credit consumption.

## Consequences
- Protects users and Virexa AI Ventures from unbounded provider expenses.
- Provides real-time receipts and transparent ledger accounting.
