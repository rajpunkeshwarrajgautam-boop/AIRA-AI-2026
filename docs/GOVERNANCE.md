# AIRA-AI-2026 — Release Governance & Branch Policy

## 1. Branch Strategy
- `main`: Protected production branch. Represents certified deployable baseline.
- `fix/*`, `feat/*`, `chore/*`: Isolated task branches. All changes must be proposed via pull request.

## 2. CI Quality Gates
Every pull request targeting `main` must execute and pass:
1. `Fast CI`:
   - Lint & typecheck
   - Build
   - Database migrations
   - Runtime verification
   - Model provider routing certification
   - High-risk credential scanning
2. `Main / PR certification`:
   - Integration certification
   - Recovery certification
   - Identity & session certification
   - Browser session bridge certification
   - Startup certification
   - E2E Playwright suite

## 3. Deployment Lifecycle
- Pull Requests trigger isolated Vercel Preview deployments.
- Merges to `main` trigger automated Vercel Production deployment to `https://aira-ai-2026.vercel.app`.
- Head branches are automatically deleted upon merge (`deleteBranchOnMerge: true`).
