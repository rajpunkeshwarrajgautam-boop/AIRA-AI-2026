# Domain Documentation Configuration — AIRA AI 2026

## Domain Documentation Layout
- **Mode**: single-context
- **Glossary Path**: `GLOSSARY.md` (at repo root)
- **ADR Directory**: `docs/adr/`

## Consumer Rules
1. Every engineering skill touching domain entities (plans, entitlements, credits, accounts, gateways) must read `GLOSSARY.md` before implementation or test naming.
2. Architecture Decision Records under `docs/adr/` govern transactional accounting, webhook signature validation, credit reservations, and distributed capacity.
3. No feature may alter established domain semantics without an updated ADR and glossary entry.
