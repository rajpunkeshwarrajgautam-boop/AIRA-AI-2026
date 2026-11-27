# AIRA-AI-2026 Release Governance & Production Baseline State

## Status: GENUI LOCAL ASSURANCE COMPLETE (EXTERNAL ACCEPTANCE BLOCKED)

- **Repository**: `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`
- **Certified Production Reference SHA**: `f429d90a1f4322a0d362956fb9e55a38cb3b5508`
- **Commercial Candidate PR #215 Baseline**: `fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568` (STRICT HOLD)
- **Active GenUI Feature Branch**: `feat/aira-genui-phase1-foundation`
- **GenUI Assurance Verdict**: `GENUI_LOCAL_RELEASE_ASSURANCE_COMPLETE_EXTERNAL_ACCEPTANCE_BLOCKED`
- **Candidate Commit (Phase 5 + Assurance)**: `112a0f6bdf08cc624770589e61554920c7a9f69b` (+ local remediations)
- **Production URL**: `https://aira-ai-2026.vercel.app`
- **Default Branch**: `main`

### Governance & CI Gates Configuration
- **Branch Head Auto-Deletion**: `deleteBranchOnMerge: true` (ACTIVE)
- **Vulnerability Alerts**: ENABLED (`/vulnerability-alerts`)
- **Automated Security Fixes**: ENABLED (`/automated-security-fixes`)
- **Workflow Permissions**: Default `read`, `can_approve_pull_request_reviews: false` (SECURE)
- **Local Pre-Push Guard**: Installed at `.git/hooks/pre-push`
- **GitHub Ruleset**: `AIRA Production Protection` (ID `25079946`) on `refs/heads/prod-release`
- **Database Migrations Added by GenUI**: **0** (Existing schema tables reused)
- **GenUI Test Suite Pass Rate**: **86/86 (100% PASS across 8 suites)**
- **Release Auth Unit Tests**: **52/52 PASS**
- **Production Release Status**: **STRICT HOLD** (Requires staging verification and owner attestation)
- **Discovered Reliable CI Checks**:
  - `Fast CI` (Workflow: `CI`, Job: `fast`, Duration: ~1m15s, Status: PASS)
  - `Main / PR certification` (Workflow: `CI`, Job: `certify`, Duration: ~2m45s, Status: PASS)
  - `Vercel` (Preview Deployment Integration, Status: PASS)
  - `Vercel Preview Comments` (Status: PASS)
- **Test PR Verification**:
  - Test Branch: `chore/verify-main-protection`
  - Test PR: #24 (`https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/24`)
  - Fast CI: PASS (1m17s)
  - Main / PR Certification: PASS (2m43s)
  - Vercel Preview: PASS
  - Mergeability: MERGEABLE (Owner not locked out)
  - Lifecycle: Closed cleanly, remote branch deleted, zero changes merged to `main`
- **Release Workflow Compatibility**: 100% aligned with `/aira-release-certification`
- **Evidence Collector**: VERIFIED PASS
- **Reality Checker**: VERIFIED PASS
- **Production Baseline Untouched**: YES (`main` at `4bba366d482c82a566abfb5e6d45ef333f53601b`)
