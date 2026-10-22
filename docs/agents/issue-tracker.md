# Issue Tracker: GitHub Issues — AIRA AI 2026

Issues and specifications for this repository live in GitHub Issues. Use the authenticated `gh` CLI for all operations.

## Repository Target
- **Repository**: `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`
- **CLI**: `gh` (authenticated via active GitHub CLI session)
- **Tracking Milestone**: `AIRA-COMMERCIAL-V1`
  > **Note**: Verify that the milestone exists before assigning issues to it (`gh api repos/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/milestones`). Do NOT create milestones automatically.

## Standard Issue Operations

- **Create an issue**:
  ```bash
  gh issue create --title "<title>" --body "<body>" --label "<label>"
  ```
  *(Use heredocs or multi-line strings for structured issue bodies.)*
- **Read an issue**:
  ```bash
  gh issue view <number> --json number,title,body,labels,comments
  ```
- **List open issues**:
  ```bash
  gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'
  ```
  *(Filter with `--label` and `--state` as needed.)*
- **Comment on an issue**:
  ```bash
  gh issue comment <number> --body "..."
  ```
- **Apply / remove labels**:
  ```bash
  gh issue edit <number> --add-label "<label>"
  gh issue edit <number> --remove-label "<label>"
  ```
- **Close an issue**:
  ```bash
  gh issue close <number> --comment "..."
  ```
- **Issue Hierarchy / Task Linking**:
  Link related tasks by specifying `Part of #<parent>` at the top of the child issue body or by referencing child issues in a markdown checklist within the parent issue body.

## Pull Requests as a Triage Surface

**PRs as a request surface: NO.**

External PRs are not treated as open request queues. GitHub shares a unified number space across issues and pull requests; if a reference `#<number>` is ambiguous, inspect via `gh pr view <number>` first and fall back to `gh issue view <number>`.

## Skill Directives

- **When a skill says "publish to the issue tracker"**: Create a GitHub issue using `gh issue create`.
- **When a skill says "fetch the relevant ticket"**: Read the issue using `gh issue view <number>`.
- **Verification Rule**: Follow `verification-before-completion` (`C:\Users\WORKSTATION\.gemini\config\plugins\superpowers\skills\verification-before-completion\SKILL.md`). Never declare an issue resolved without running fresh verification commands and capturing concrete evidence.
