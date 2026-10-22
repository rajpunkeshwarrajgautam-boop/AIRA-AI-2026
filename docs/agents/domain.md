# Domain Documentation Configuration — AIRA AI 2026

How engineering skills consume this repository's domain documentation when exploring the codebase, implementing features, or writing tests.

## Domain Documentation Layout
- **Mode**: single-context
- **Glossary Path**: `GLOSSARY.md` (at repo root)
- **ADR Directory**: `docs/adr/`

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-commercial-billing-and-credit-ledger-architecture.md
│   ├── 0002-payment-gateway-webhook-and-gst-model.md
│   └── 0003-vision-multimodal-and-metered-execution.md
└── src/
```

## Consumer Rules

1. **Before Exploring, Read These**:
   - `GLOSSARY.md` at the repo root.
   - `docs/adr/`: Read ADRs touching the area under modification (e.g. commercial billing, credit ledger, payment webhooks, metered execution).
2. **Use the Glossary's Vocabulary**:
   - When output names a domain concept (in an issue title, PR description, refactor proposal, hypothesis, or test name), use terms as defined in `GLOSSARY.md` (e.g. plans, entitlements, credits, accounts, gateways).
   - Do not drift to synonyms the glossary explicitly avoids.
   - If a required concept is not in the glossary, flag it as a domain gap rather than inventing unsanctioned terminology.
3. **Flag ADR Conflicts Explicitly**:
   - If any proposal or implementation contradicts an existing ADR, surface it explicitly with justification rather than silently overriding (e.g. `*Contradicts ADR-0001, but proposed because...*`).
4. **Semantics Protection**:
   - No feature or pull request may alter established domain semantics without an updated ADR and corresponding glossary update.
