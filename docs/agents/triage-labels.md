# Triage Labels Vocabulary — AIRA AI 2026

The engineering skills speak in terms of five canonical triage roles. This file maps those roles to the existing label strings verified in `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`.

## Label Mapping

| Label in mattpocock/skills | Label in our tracker | Meaning & Domain Scope |
| :--- | :--- | :--- |
| `needs-triage` | `needs-triage` | Newly submitted issue or regression needing specialist classification |
| `needs-info` | `needs-info` | Awaiting reporter feedback, external provider response, or merchant KYC clarification |
| `ready-for-agent` | `ready-for-agent` | Fully specified implementation task ready for autonomous agent execution |
| `ready-for-human` | `ready-for-human` | Action requiring explicit human maintainer attention or implementation |
| `wontfix` | `wontfix` | Out-of-scope or will not be actioned |

## Critical Release & Authority Guard

> [!CAUTION]
> The `ready-for-human` label indicates human task assignment or maintainer consultation.
> It must **NEVER** be interpreted as authorization to merge PR #96, activate staging maintenance, deploy, or modify Production.
> Production release and staging maintenance operations strictly require an explicit human `GO LIVE` instruction with exact commit SHA and Neon branch/endpoint targets per `AGENTS.md`.

## Management Rules

1. All five labels already exist on GitHub. Do not create, rename, delete, or modify repository labels.
2. When an engineering skill mentions a triage role (e.g. "apply the AFK-ready triage label"), use the corresponding string from the table above.
