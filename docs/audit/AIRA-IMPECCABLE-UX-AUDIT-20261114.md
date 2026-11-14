# AIRA Impeccable UI/UX audit — release candidate

**Audit baseline:** `prod-release` at `4e8fd26c40e5aa56ac71de944af032dcac31c953` (2026-11-14).  
**Reference:** [pbakaus/impeccable](https://github.com/pbakaus/impeccable), especially `audit`, `critique`, `polish`, `adapt`, `harden`, `typeset` and `layout`.  
**Intent:** Improve production UX without changing the AIRA product identity, quotas, authentication, endpoints, themes, or stored data.  
**Evidence convention:** **Source** means inspected React/CSS, not a reproduced live visual defect. **DOM** means the connected browser's accessible text/markup. Screenshots in past repository acceptance runs are historical and do **not** independently verify this candidate. Any remaining live interaction must be verified on deployed staging, not assumed from static code.

## Site map and section inventory

AIRA is a workspace application, not a public multi-page marketing site. Several of these are panes, dialogs, or feature-flagged surfaces rather than URL paths. No standalone marketing hero/feature/footer page is established by the inspected source. The global 'footer' equivalents are the sidebar plan/account/theme area and the composer disclosure.

| Surface / sections inspected | Source component | Coverage and conclusion |
|---|---|---|
| Global app shell, header (mode, model, bookmarks, sharing), content, composer, guest/verified state | `src/App.tsx` | Source; **P1** icon-only header actions had no explicit name → **fixed** |
| Sidebar brand, new chat, projects, search, bookmarked/recent chat groups, plan, account, theme | `src/components/Sidebar.tsx` | Source + production DOM; **P1** click-only conversation rows → **fixed**; search label → **fixed** |
| Greeting hero, AIRA mark, supporting copy, continue chat | `GreetingScreen.tsx` | Source; hierarchy and reduced-motion guard present; visual checks pending |
| Chat messages, reasoning, citations, attachment results | `ChatMessage.tsx`, `ThinkingBlock.tsx` | Source inventory; audit loading/overflow/long message in browser |
| Composer: mode/model, attachments, typing, style menu, send, disclosure | `ChatInput.tsx` | Source; **P1** missing accessible textarea, attachment and send labels → **fixed** |
| Model selection: dropdown/listbox, plan locks, provider titles | `ModelSelector.tsx` | Source; listbox role present; keyboard focus & lock messaging require browser acceptance |
| Chat search, command palette, conversation actions | `ConversationSearchOverlay.tsx`, `CommandPalette.tsx`, `ConversationActionsDropdown.tsx` | Source; audit keyboard roving, active state and empty results in staging |
| Projects: list/empty, create, document entry, select, delete | `ProjectsModal.tsx` | Source; **P1** placeholder-only labels & dialog heading → **fixed** |
| Agents: list, create, mission launch, errors, empty state | `AgentsView.tsx` | Source; review state transitions and icon semantics in entitled account |
| Automations: list, scheduler, toggle, history, empty state | `AutomationsView.tsx` | Source; review recurrence display, label density and disabled states |
| Library: sources, memories, graph, search, ingest, source details | `LibraryView.tsx` | Source; **P2** high density of 9–11px labels; validate at 200% zoom |
| Memory vault, sync and controls | `MemoryVaultModal.tsx` | Source; validate empty and error states, ownership and confirmation language |
| Artifact Studio: tabs, code, preview, versions, save, runtime errors | `ArtifactStudio.tsx` | Source; **P2** tiny controls / panel density; validate mobile/keyboard behavior |
| Unified workspace: artifact, execution graph, diagnostics, layout split | `UnifiedWorkspace.tsx`, `AgentExecutionGraph.tsx`, `AdaptiveStudioEmptyState.tsx` | Source; validate responsive panes and overflow in staging |
| Builder workspace: task, diagnostics, preview, files, download | `BuilderWorkspace.tsx`, `WorkspaceFileExplorer.tsx` | Source; validate status and file tree keyboard nav |
| Vision Studio: prompts, image generation, results | `VisionStudioModal.tsx` | Source; validate upload/error/result and unavailable plan |
| Motion Studio: scene timeline, playback, aspect ratio, results | `MotionStudioModal.tsx` | Source; transport controls already have names; visual/playback validation pending |
| Asset viewer: image/SVG/audio, zoom, scrubber and download | `MultiModalAssetViewer.tsx` | Source; scrubber named; validate keyboard and overflow behavior |
| Settings tabs: General/Appearance, Plan/Usage, Reasoning, Memory, Personalization, Artifacts, Account/Privacy | `SettingsModal.tsx` | Source; dialog trap and responsive tab layouts pre-existing; verify transitions & disabled/error states |
| Billing Center: overview, usage, top-up, account security | `AccountBillingModal.tsx` | Source; **P1** dialog/tab semantics, focus and narrow-screen overflow → **fixed** |
| Plan selection: currency, Free/Plus/Pro cards, checkout messaging | `PricingModal.tsx` | Source; **P1** dialog semantics and tall-screen overflow → **fixed** |
| Login: OAuth providers, sign-up, password reset, recovery/error | `AuthModal.tsx` | Source; keyboard/e-mail form E2E with legitimate sessions still pending |
| Onboarding: intro, modes, projects, plans, completion | `OnboardingWalkthrough.tsx` | Source; test skip/back/resume and mobile height |
| Upgrade/entitlement errors | `UpgradeModal.tsx` | Source; verify plan gate copy agrees with server contract |
| Account menu, plan, theme, logout, legal/help links | `AccountMenuDropdown.tsx` | Source; keyboard navigation and session consistency pending |
| Help Center: topic list, search and troubleshooting | `HelpCenterModal.tsx` | Source; heading and dialog roles present |
| Privacy Center: account, data, export, deletion warnings | `PrivacyCenterModal.tsx` | Source; confirm warnings before irreversible actions |
| Release Notes, Download Apps, Keyboard Shortcuts, Report Bug | `ReleaseNotesModal.tsx`, `DownloadAppsModal.tsx`, `KeyboardShortcutsModal.tsx`, `ReportBugModal.tsx` | Source; accessible modal shells present; text clarity and device acceptance pending |

## Confirmed findings → Impeccable guidance → implementation

### P1: Conversation navigation must be keyboard operable

**Source defect:** `Sidebar.tsx` used a clickable `motion.div` wrapping a rename input and an actions dropdown. The row had no native Tab/Enter/Space activation, and adding a `role="button"` to a wrapper would nest interactive descendants.

**Impeccable:** `audit` / `harden` — use a **native button for the selection action**, a separate input during rename, and an independent options button.

**Implemented:**
```tsx
<button
  type="button"
  aria-current={activeChatId === c.id ? 'page' : undefined}
  aria-label={`Open conversation: ${c.title}`}
  onClick={() => handleSelectChatMobile(c.id)}
  className="flex min-h-10 min-w-0 flex-1 items-center rounded-md px-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-claude-terracotta"
>
  <MessageSquareText aria-hidden="true" />
  <span className="min-w-0 flex-1 truncate">{c.title}</span>
</button>
```
**Acceptance:** Tab to conversation, Enter/Space opens it, Tab reaches action menu independently, rename Enter/Escape still work, active row remains marked.

### P1: Controls must have accessible names

**Source defect:** Composer textarea, attach button, send button, sidebar search field, and app header share/bookmark icons depended on placeholder/tooltip/visual icon.

**Impeccable:** `clarify` / `audit` — provide explicit accessible names and state-aware labels.

**Implemented:**
```tsx
<textarea aria-label="Message Aira" placeholder={placeholder} />
<button aria-label="Attach documents or images" />
<button aria-label={isLoading ? 'Aira is responding' : 'Send message'} />
<input aria-label="Search workspace conversations" />
<button aria-label={sharedCopied ? 'Conversation link copied' : 'Share conversation'} />
```
**Acceptance:** Screen reader identifies actions without placeholder; icon touch and focus controls retain existing click behavior.

### P1: Billing, pricing and project dialogs need accessible structure and safe scrolling

**Source defect:** Billing Center had no `role="dialog"`, `aria-modal`, tab semantics, or keyboard focus containment. Pricing/Projects lacked labeled dialog structure; several project fields were placeholder-only.

**Impeccable:** `adapt` / `audit` / `harden` — semantic modal, associated heading, Escape, focus containment and return, and viewport-relative overflow.

**Implemented:**
```tsx
<motion.div
  role="dialog"
  aria-modal="true"
  aria-labelledby="aira-account-billing-title"
  tabIndex={-1}
  ref={billingDialogRef}
  className="max-h-[90dvh] overflow-hidden ..."
/>
<div role="tablist" aria-label="Billing sections" className="flex overflow-x-auto ..." />
<div id="aira-billing-panel" role="tabpanel" aria-label="Billing details" />
```
**Acceptance:** Open with keyboard, tab within dialog, Escape closes, focus returns to opener, no horizontal clipping at 390px / 200% zoom.

### P2: Focus/motion, icon density and content rhythm across specialized workspaces

**Source findings:** `ArtifactStudio`, `UnifiedWorkspace`, `LibraryView`, `AgentsView` and `AutomationsView` use recurring 9–11px utility-label classes; theme-specific contrast and small action targets need visual measurements. Do **not** globally increase all font sizes or rewrite the design tokens: compact code/metadata displays are intentional, but interactive controls require robust names, focus, touch targets and overflow.

**Impeccable:** `typeset` / `layout` / `adapt`; follow the existing AIRA warm terracotta / cream / dark charcoal palette, serif display type, and 16px composer card.

**Deferred code direction (verify per component before applying):**
```tsx
<button
  type="button"
  aria-label="Refresh data"
  className="min-h-10 min-w-10 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2"
>
  <RefreshCw aria-hidden="true" className="h-4 w-4" />
</button>
```
Use `motion-reduce:transition-none` on elements with decorative transitions, and test the site's existing reduced-motion setting rather than layering global overrides.

### P2: Account/pricing state and empty/error paths must be truthful

**Source findings:** Billing and pricing already distinguish sandbox checkout and verified balances. Help, onboarding, privacy, library and agent surfaces contain several separate empty/error/upgrade states. Correctness, entitlement identity and truthful amounts take precedence over visual decoration.

**Impeccable:** `clarify` / `harden` / `onboard`.

**Deferred code direction (requires authenticated acceptance):**
```tsx
{error ? <p role="alert">{error}</p>
 : loading ? <p role="status">Checking account access…</p>
 : <VerifiedUsageSummary summary={summary} />}
```
Do not invent `VerifiedUsageSummary`; this pseudocode describes the control-flow standard, not an existing AIRA component. Use the current actual components and authoritative plan model.

## Priority action checklist

- [x] Establish current production baseline and preserve `DESIGN.md`/theme identity.
- [x] Inventory the application shell, chat/Agent, projects, library, studios and account/support dialogs.
- [x] Implement native conversation selection and accessible names for primary controls.
- [x] Improve modal headings, billing tab semantics, keyboard focus/scrolling and project-field labels.
- [x] Add focused source-level regression tests to Fast CI.
- [ ] **Mandatory:** PASS candidate TypeScript/build, regression, PostgreSQL, security and Edge CI.
- [ ] **Mandatory:** Check candidate at desktop 1440×900, mobile 390×844, light/dark, 200% zoom and reduced motion; capture screenshots.
- [ ] **Mandatory:** Verify real authenticated modes/plan gates without modifying subscription or account data.
- [ ] **Mandatory:** Test keyboard-only navigation through Sidebar, composer, Billing, Pricing, Projects; validate focus return and nested overlays.
- [ ] **Mandatory:** Integrate only after CI, and verify exact deployed `staging` SHA, responsive UI and absence of new console errors.
- [ ] **Release boundary:** No direct production edits, no forced merge, no DB migration, no claims of full visual coverage without browser evidence.

## Evidence limits

A connected browser tab provided **read-only DOM/text**, not a controllable DevTools session. No live computed-style extraction or authenticated automated click-through of every view was possible in this chat. Source inspection and historical screenshots are **not** substitutes for visual proof. This audit therefore records code-backed defects and implementation, plus the specific remaining browser acceptance required before calling the entire site visually certified. The changes do not alter paid entitlements, generation providers or backend authentication.
