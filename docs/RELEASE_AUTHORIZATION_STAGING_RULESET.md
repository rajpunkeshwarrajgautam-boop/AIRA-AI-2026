# AIRA AI 2026 — Release Authorization Staging Ruleset Specification

## Purpose
This document specifies the exact configuration payload and migration procedure to add `release/go-live-authorized` as a mandatory required status check to GitHub Pro Ruleset `AIRA Production Protection` (ID: `25079946`).

> [!IMPORTANT]
> Under repository release safety rules, automated agents **must not modify or mutate the live production ruleset (ID: 25079946)** without explicit owner approval.
> This specification is prepared for owner review and configuration.

---

## 1. Current Live Ruleset State (Verified 2026-10-14)

- **Ruleset ID**: `25079946`
- **Name**: `AIRA Production Protection`
- **Target Branch**: `refs/heads/prod-release`
- **Enforcement**: `active`
- **Bypass Actors**: `[]` (`can_bypass: "never"`)
- **Active Required Status Checks**:
  1. `Fast CI` (integration_id: `15368` - GitHub Actions)
  2. `Semantic Search CI` (integration_id: `15368` - GitHub Actions)
  3. `Main / PR certification` (integration_id: `15368` - GitHub Actions)

---

## 2. Proposed Target Ruleset Configuration

Adding `release/go-live-authorized` to `required_status_checks`:

```json
{
  "name": "AIRA Production Protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/prod-release"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "required_reviewers": [],
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "require_extra_approval_for_unattributed_changes": true,
        "allowed_merge_methods": ["merge", "squash", "rebase"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "Fast CI" },
          { "context": "Semantic Search CI" },
          { "context": "Main / PR certification" },
          { "context": "release/go-live-authorized" }
        ]
      }
    }
  ]
}
```

---

## 3. How the Technical Gate Functions

1. **Before Owner Authorization**:
   - The developer opens a PR targeting `prod-release` (e.g. PR #64).
   - Fast CI, Semantic Search CI, and Main / PR certification run and pass.
   - **GitHub Blocks Merge**: GitHub displays `Required status check "release/go-live-authorized" has not been reported` with the Merge button disabled.
   - Neither the developer nor any automated agent can merge the PR.

2. **Owner Issues Authorization**:
   - Repository owner (`rajpunkeshwarrajgautam-boop`) navigates to **Actions** $\rightarrow$ **Release Authorization Attestation (No Deployment)**.
   - Clicks **Run workflow** with inputs:
     * `pr_number`: `64`
     * `candidate_sha`: `<exact_40_char_head_sha>`
     * `approval_phrase`: `GO LIVE <exact_40_char_head_sha>`
   - The workflow executes under the owner's identity:
     * Asserts inputs and PR state.
     * Posts GitHub commit status `release/go-live-authorized` (`state: success`) on the candidate commit SHA.
   - GitHub detects the status check passes $\rightarrow$ Merge button unlocks.

3. **Protection Against Code Mutation**:
   - If any new commit is pushed to the PR branch, GitHub updates `head.sha`.
   - The new commit does NOT have the `release/go-live-authorized` status.
   - The Merge button immediately re-locks until fresh authorization is dispatched for the new SHA.

---

## 4. Owner Activation Command (When Authorized)

When the repository owner decides to activate `release/go-live-authorized` on ruleset `25079946`:

```bash
gh api --method PUT repos/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/rulesets/25079946 \
  --input - << 'EOF'
{
  "name": "AIRA Production Protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/prod-release"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "required_reviewers": [],
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "require_extra_approval_for_unattributed_changes": true,
        "allowed_merge_methods": ["merge", "squash", "rebase"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "Fast CI" },
          { "context": "Semantic Search CI" },
          { "context": "Main / PR certification" },
          { "context": "release/go-live-authorized" }
        ]
      }
    }
  ]
}
EOF
```

---

## 5. Rollback Procedure

If the check needs to be removed from required status checks:

```bash
gh api --method PUT repos/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/rulesets/25079946 \
  --input - << 'EOF'
{
  "name": "AIRA Production Protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/prod-release"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "required_reviewers": [],
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "require_extra_approval_for_unattributed_changes": true,
        "allowed_merge_methods": ["merge", "squash", "rebase"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "Fast CI" },
          { "context": "Semantic Search CI" },
          { "context": "Main / PR certification" }
        ]
      }
    }
  ]
}
EOF
```
