# Canonical production domain cutover verification

This document is a non-executable smoke-test change for [issue #154](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/issues/154).

- Vercel project: `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`
- Git-tracked production branch: `prod-release`
- Canonical domain: `https://aira-ai-2026.vercel.app`
- Baseline production commit before this test: `2c3654263facb3f20ed394899632158ac8f38508`
- Baseline deployment: `dpl_4mHm6GqZdoFwTaxN1xh5icHv7YDq`
- Change scope: documentation only, without database migrations, auth, application logic, infrastructure resources, or billing changes.

On 2026-11-08, the Vercel Production environment showed the correct `prod-release` tracking pattern but **Auto-assign Custom Production Domains: Disabled**. The production auto-assignment setting was enabled, and the dashboard subsequently showed **Enabled** with the checkbox checked. The historical event that disabled the setting has not been independently established; a rollback is a possibility, not a proven cause.

This GitHub PR is a controlled regression test of that setting. After protected merge and Vercel's GitHub-triggered production build reaches READY, verify **without calling any manual promote or alias-assignment API** that:

1. The Vercel production deployment is built from the exact merged commit on `prod-release`.
2. The canonical domain's assigned deployment ID moves from the baseline to that new deployment.
3. `/api/version` on the canonical domain reports the exact merge SHA and `/api/health` is healthy.
4. The homepage renders, and no unexpected database, auth, staging, or billing changes occurred.

Store the actual deployment ID, SHA, alias evidence, and pass/fail verdict in issue #154. If the alias does not move automatically, leave that issue open and freeze subsequent releases while preserving the last healthy production deployment.
