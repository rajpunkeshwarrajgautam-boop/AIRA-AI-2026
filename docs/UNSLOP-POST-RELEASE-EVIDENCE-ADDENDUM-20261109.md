# AIRA UNSLOP — Post-Release Evidence Reconciliation (2026-11-09)

**Outcome:** PR #159 is merged and its production deployment is operational. **Evidence assurance:** the existing staging and independent security artifacts are historical; they do not, on their own, certify the final candidate SHA. This document resolves the misleading documentary status without silently reattributing previous tests.

## Release coordinates (independently observed)

| Boundary | Observed evidence | Result |
| --- | --- | --- |
| [PR #159](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/159) | Final parent `4e40e7e1c2a11b998bbb61cfca75e2086abdef27`; merged to `prod-release` as `6acd066a8352799109d151f79b6a808cee9ccd09` at 2026-11-09T14:34:29Z | MERGED |
| [Candidate preview](https://vercel.com/rajpunkeshwarrajgautam-boops-projects/aira-ai-2026/5qgkDi5E1r76hASNUqiTLJcgZbrX) | `dpl_5qgkDi5E1r76hASNUqiTLJcgZbrX`, READY, bound to final parent SHA `4e40e7e...` | PREVIEW IDENTITY VERIFIED |
| [Production deployment](https://vercel.com/rajpunkeshwarrajgautam-boops-projects/aira-ai-2026/A5aLSh6oVXiffoBFQdqdkEE6K78z) | `dpl_A5aLSh6oVXiffoBFQdqdkEE6K78z`, READY; canonical alias `aira-ai-2026.vercel.app` points to it | LIVE |
| [Production version](https://aira-ai-2026.vercel.app/api/version) | `status: ok`, `environment: production`, exact merge SHA `6acd066a...` | PASS |
| [Production health](https://aira-ai-2026.vercel.app/api/health) | `HEALTHY`, `READY`, all 12 reported subsystems ONLINE, `productionMockFallback: DISABLED` | PASS |
| [Post-merge CI](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/42636014405) | Fast CI, Semantic Search CI and Main / PR certification succeeded. **Deployed staging acceptance job SKIPPED** because its trigger was not met | REQUIRED CHECKS GREEN; STAGING NOT REPEATED |
| Previous Vercel deployment | `dpl_5bi31V9TvLDsNV7wVckZ59AZpqmz` (commit `bb14406a32f82eba8a2ae22736a80406bb129f44`) remains READY | ROLLBACK ARTIFACT AVAILABLE |

All observations above concern release coordinates or public service health; they do not independently reproduce account-isolation tests.

## Historical artifacts — provenance preserved

1. `artifacts/staging-acceptance/LIVE_DUAL_ACCOUNT_ISOLATION_LEDGER.json` contains 12 PASS gates **against SHA `0dc2036976254f5a17e9af028b07db9a3cae3688` and preview `dpl_6M1dgwUwtPu7DpPHatKAuQBV4ziW`**. Its pre-redaction Git blob SHA was `b948c26a656e0ed0c273a6b2309c4c224c2bf463`. The records remain historical and retain their actual test SHA and deployment ID. They must not be labeled a final-parent `4e40e7...` run.
2. `artifacts/security/SECURITY_SCAN_REPORT.json` was also produced for SHA `0dc2036976...` on that older preview; its pre-annotation Git blob SHA was `0bb687a1830654b88e4672449e80874e033b158d`. The report's security findings and local test results are not rewritten, and its original `CERTIFIED` verdict is qualified as **candidate-scoped**.
3. `docs/UNSLOP-RELEASE-CERTIFICATION-20261108.md` records pre-release assessments, including a then-valid **NO GO**. The header now distinguishes that historical assessment from the later operational deployment.

The operator's final release narrative describes an additional **12/12 acceptance run** and security approval for `4e40e7...`, but the two committed JSON artifacts above do **not** contain that run. Those exact-candidate outcomes are **not independently substantiated by these repository files**. Retain or attach the raw final-candidate runner logs, authenticated principal evidence (sanitized), timestamps, preview identity, CI/check-run links, and independently produced security assessment before marking the evidence chain fully sealed. Do not fabricate or bulk-edit historical `candidateSha` fields.

## Identity and session disclosure review

The historical acceptance JSON embedded staging-account names, email addresses, principal IDs and session identifiers. In this correction, those values are redacted from the **current file content**, while gate outcomes, timestamps, preview coordinates, and status observations remain. The Git history retains earlier blobs; content redaction **is not historical erasure**. Treat historical staging sessions as potentially exposed until the owning staging system confirms expiration or revocation. Review whether any identifiers function as authentication credentials; do not publish tokens, cookies or test-account emails in future evidence. No session revocation, key rotation, secret update, auth setting or production data mutation is performed here.

## Precise certification boundary

- **Confirmed:** PR merge, exact live production SHA, Vercel deployment and alias, service health, required post-merge CI and available rollback artifact.
- **Historically recorded:** 12/12 staging gates and independent security tests on older SHA `0dc203...`.
- **Not reverified in this documentation correction:** two-account OAuth isolation and complete independent SAST/security assessment against final parent `4e40e7...`. The post-merge staging workflow is **SKIPPED**, not **PASS**.
- **Operational decision:** no rollback indicated by these checks; keep production monitoring active. Do not treat a service health probe as proof of every security property.

To close the remaining evidence-chain gap, attach immutable exact-SHA logs and a fresh independent scan to a subsequent append-only certification addendum, after validating deployed preview identity and the safety of staging account credentials. Changes affecting code require their own exact-head CI and review. Do not relabel the previous ledgers.

This addendum changes documentation and redacts published evidence only. It does not change application code, database schema, Vercel configuration, GitHub rulesets, or production deployment state.
