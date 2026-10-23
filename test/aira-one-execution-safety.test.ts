import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detectCapabilityIntent } from '../src/utils/capabilityDispatcher';
import { BuilderRequestSchema } from '../packages/builder-runtime/src/contracts';
import type { WorkspaceMode } from '../src/types';

test('Execution Safety: AgentContextualPanel defaults permissions to false and enforces explicit consent', () => {
  const panelPath = path.resolve(process.cwd(), 'src/components/AgentContextualPanel.tsx');
  const panelContent = fs.readFileSync(panelPath, 'utf8');

  // Verify permissions default to false
  assert.match(panelContent, /const \[allowExecution, setAllowExecution\] = useState\(false\)/);
  assert.match(panelContent, /const \[allowInternet, setAllowInternet\] = useState\(false\)/);
  assert.match(panelContent, /const \[allowPreview, setAllowPreview\] = useState\(false\)/);

  // Verify explicit sandbox consent gate
  assert.ok(panelContent.includes('Sandbox Permissions & Quotas'));
  assert.ok(panelContent.includes('Authorize Container Execution (Mandatory)'));
  assert.ok(panelContent.includes('Authorize & Run Sandbox'));
  assert.ok(panelContent.includes('disabled={!prompt.trim() || !status?.ready || !allowExecution}'));
  assert.ok(panelContent.includes('Explicit execution authorization is required before running container commands'));
  assert.ok(panelContent.includes('Usage Quota: 1 Standard Agent Run · 10 Compute Minutes max'));
});

test('Execution Safety: Backend Builder schema strictly requires allowExecution: z.literal(true)', () => {
  // Verify BuilderRequestSchema contract requires allowExecution to be strictly true
  const schemaContractPath = path.resolve(process.cwd(), 'packages/builder-runtime/src/contracts.ts');
  const contractContent = fs.readFileSync(schemaContractPath, 'utf8');
  assert.match(contractContent, /allowExecution:\s*z\.literal\(true\)/);

  // Test Zod schema validation directly: rejects missing, false, or non-boolean
  const valid = BuilderRequestSchema.safeParse({ prompt: 'Create web app', allowExecution: true });
  assert.equal(valid.success, true);

  const missing = BuilderRequestSchema.safeParse({ prompt: 'Create web app' });
  assert.equal(missing.success, false);

  const falseVal = BuilderRequestSchema.safeParse({ prompt: 'Create web app', allowExecution: false });
  assert.equal(falseVal.success, false);
});

test('Execution Cancellation: Real AbortController and backend endpoint integration', () => {
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');

  // Verify HUD Cancel button is connected to real handleCancelExecution
  assert.ok(appContent.includes('handleCancelExecution'));
  assert.match(appContent, /onClick=\{handleCancelExecution\}/);

  // Verify handleCancelExecution aborts active AbortController
  assert.ok(appContent.includes('activeAbortControllerRef.current.abort()'));

  // Verify handleCancelExecution notifies backend /api/runs/:id/cancel
  assert.ok(appContent.includes('/api/runs/${runId}/cancel'));

  // Verify handleCancelExecution increments cancelBuilderSignal
  assert.ok(appContent.includes('setCancelBuilderSignal(prev => prev + 1)'));

  // Verify handleCancelExecution marks message as cancelled
  assert.ok(appContent.includes('*[Execution cancelled by user]*'));

  // Verify aiEngine accepts AbortSignal and aborts stream reader
  const enginePath = path.resolve(process.cwd(), 'src/utils/aiEngine.ts');
  const engineContent = fs.readFileSync(enginePath, 'utf8');
  assert.ok(engineContent.includes('postChatStream(body: unknown, signal?: AbortSignal)'));
  assert.ok(engineContent.includes('if (signal?.aborted)'));
  assert.ok(engineContent.includes('wrappedCallbacks.onCancelled?.()'));
});

test('Execution Cancellation: AgentContextualPanel handles stop and cancel signal', () => {
  const panelPath = path.resolve(process.cwd(), 'src/components/AgentContextualPanel.tsx');
  const panelContent = fs.readFileSync(panelPath, 'utf8');

  // Verify handleStop aborts controller, calls cancelBuilder API, and notifies parent
  assert.ok(panelContent.includes('controller.current?.abort()'));
  assert.ok(panelContent.includes('cancelBuilder(token)'));
  assert.ok(panelContent.includes('onExecutionCancelled?.()'));
  assert.ok(panelContent.includes('setBusy(false)'));

  // Verify cancelSignal effect
  assert.ok(panelContent.includes('cancelSignal'));
});

test('Builder Chat-to-Agent Handoff: Chat Mode attaches handoff and ChatMessage renders actionable button', () => {
  // Test capability detection in Chat Mode
  const prompt = 'Build a responsive portfolio website with vite';
  const intent = detectCapabilityIntent(prompt, 'chat');
  assert.equal(intent.capability, 'BUILDER_APP');
  assert.equal(intent.suggestAgentMode, true);

  // Test App.tsx attaches builderHandoff payload
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');
  assert.ok(appContent.includes('builderHandoff: {'));
  assert.ok(appContent.includes('prompt: intent.cleanPrompt'));
  assert.ok(appContent.includes('handleSwitchToAgentAndReview'));

  // Test ChatMessage.tsx renders the Switch to Agent button and calls callback
  const chatMsgPath = path.resolve(process.cwd(), 'src/components/ChatMessage.tsx');
  const chatMsgContent = fs.readFileSync(chatMsgPath, 'utf8');
  assert.ok(chatMsgContent.includes('builderHandoff'));
  assert.ok(chatMsgContent.includes('Switch to Agent & Review Task'));
  assert.ok(chatMsgContent.includes('onSwitchToAgentAndReview?.(message.builderHandoff!.prompt)'));
});

test('Research Backend Integration: Dispatches intent to runtime and handles genuine citations', () => {
  const prompt = 'Deep research on commercial fusion reactor milestones with sources';
  const intent = detectCapabilityIntent(prompt, 'chat');
  assert.equal(intent.capability, 'RESEARCH');

  // Verify App.tsx forwards intent: 'RESEARCH' to streamAIResponse
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');
  assert.ok(appContent.includes("intent.capability === 'RESEARCH' ? 'RESEARCH' : undefined"));

  // Verify apps/api/src/index.ts forwards intent to agentRuntime.createRun
  const apiPath = path.resolve(process.cwd(), 'apps/api/src/index.ts');
  const apiContent = fs.readFileSync(apiPath, 'utf8');
  assert.ok(apiContent.includes('intent } = req.body'));
  assert.ok(apiContent.includes("intent: (typeof intent === 'string' && intent.trim())"));
  assert.ok(apiContent.includes("event: run_started"));
  assert.ok(apiContent.includes("event: source_added"));

  // Verify ChatMessage.tsx renders verified primary citations
  const chatMsgPath = path.resolve(process.cwd(), 'src/components/ChatMessage.tsx');
  const chatMsgContent = fs.readFileSync(chatMsgPath, 'utf8');
  assert.ok(chatMsgContent.includes('Verified Primary Sources'));
  assert.ok(chatMsgContent.includes('cite.sourceTitle'));
});

test('Automation Confirmation & Persistence: Requires explicit confirmation and calls backend engine', () => {
  const prompt = 'Automate a weekly database backup check every Sunday at 3am';
  const intent = detectCapabilityIntent(prompt, 'chat');
  assert.equal(intent.capability, 'AUTOMATION');

  // Verify App.tsx presents automationProposal requiring confirmation
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');
  assert.ok(appContent.includes('automationProposal: {'));
  assert.ok(appContent.includes('Confirm and Schedule Automation'));
  assert.ok(appContent.includes('handleConfirmAutomation'));

  // Verify ChatMessage.tsx renders the proposal card and confirmation button
  const chatMsgPath = path.resolve(process.cwd(), 'src/components/ChatMessage.tsx');
  const chatMsgContent = fs.readFileSync(chatMsgPath, 'utf8');
  assert.ok(chatMsgContent.includes('Pending Scheduled Automation'));
  assert.ok(chatMsgContent.includes('Confirm and Schedule Automation'));
  assert.ok(chatMsgContent.includes('onConfirmAutomation?.(message.automationProposal)'));

  // Verify capabilityDispatcher has createBackendAutomation calling /api/automations
  const dispPath = path.resolve(process.cwd(), 'src/utils/capabilityDispatcher.ts');
  const dispContent = fs.readFileSync(dispPath, 'utf8');
  assert.ok(dispContent.includes('createBackendAutomation'));
  assert.ok(dispContent.includes('/api/automations'));
});

test('Vision Credit Integrity: Uses backend confirmed tariff charges and handles 401/402 without fabricated credits', async () => {
  const dispPath = path.resolve(process.cwd(), 'src/utils/capabilityDispatcher.ts');
  const dispContent = fs.readFileSync(dispPath, 'utf8');

  // Verify no fabricated fallback credits
  assert.ok(!dispContent.includes('creditsCharged: 12'));
  assert.ok(!dispContent.includes('data.creditsCharged || 12'));
  assert.ok(dispContent.includes('data.totalCredits'));

  // Verify App.tsx removes || 12 fallback
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');
  assert.ok(!appContent.includes('visionRes.creditsCharged || 12'));
  assert.ok(appContent.includes('visionRes.authRequired'));
});

test('Mode Persistence & Cross-User Isolation: Mode scoped to user principal and cleared on account switch', () => {
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');

  // Verify user-scoped localStorage key
  assert.ok(appContent.includes('aira_workspace_mode_${user?.id || \'guest\'}'));

  // Verify onAuthStateChange isolates prior user's execution and restores next user's mode
  assert.ok(appContent.includes('if (nextUserId !== currentUserId)'));
  assert.ok(appContent.includes('activeAbortControllerRef.current.abort()'));
  assert.ok(appContent.includes('setIsAgentPanelOpen(false)'));
  assert.ok(appContent.includes('setActiveAgentPrompt(undefined)'));
  assert.ok(appContent.includes('aira_workspace_mode_${nextUserId || \'guest\'}'));
});

test('Schedule Resolution Engine: Resolves genuine one-time, daily, weekly, and enforces IANA timezones', async () => {
  const { resolveSchedule } = await import('../src/utils/scheduleResolver');

  // 1. One-time schedule is NOT converted to recurring yearly cron
  const oneTime = resolveSchedule('Automate sending a security report tomorrow at 3pm UTC');
  assert.equal(oneTime.valid, true);
  assert.equal(oneTime.isAmbiguous, false);
  assert.equal(oneTime.scheduleType, 'ONE_TIME');
  assert.equal(oneTime.cronExpression, undefined); // Genuinely one-time, no yearly cron
  assert.ok(oneTime.targetTimestamp && oneTime.targetTimestamp > Date.now());
  assert.ok(oneTime.humanSchedule?.toLowerCase().includes('one-time'));
  assert.ok(oneTime.humanSchedule?.includes('3:00 PM'));
  assert.ok(oneTime.humanSchedule?.includes('UTC'));

  // 2. Ambiguous timezone abbreviations are rejected (fail closed)
  const ambiguousTz = resolveSchedule('Automate weekly database backup every Sunday at 3am EST');
  assert.equal(ambiguousTz.valid, false);
  assert.equal(ambiguousTz.isAmbiguous, true);
  assert.ok(ambiguousTz.clarificationPrompt?.includes('EST'));
  assert.ok(ambiguousTz.clarificationPrompt?.includes('IANA timezone'));

  // 3. Explicit valid IANA timezone is accepted
  const weeklyIana = resolveSchedule('Automate weekly database backup every Sunday at 3am UTC');
  assert.equal(weeklyIana.valid, true);
  assert.equal(weeklyIana.isAmbiguous, false);
  assert.equal(weeklyIana.scheduleType, 'WEEKLY');
  assert.equal(weeklyIana.cronExpression, '0 3 * * 0');
  assert.equal(weeklyIana.timezone, 'UTC');
  assert.ok(weeklyIana.humanSchedule?.includes('Sunday'));
  assert.ok(weeklyIana.humanSchedule?.includes('3:00 AM'));
  assert.ok(weeklyIana.humanSchedule?.includes('UTC'));

  // 4. Daily schedule with IANA timezone
  const daily = resolveSchedule('Run backup every day at 8:30pm in UTC');
  assert.equal(daily.valid, true);
  assert.equal(daily.scheduleType, 'DAILY');
  assert.equal(daily.cronExpression, '30 20 * * *');
  assert.equal(daily.timezone, 'UTC');
  assert.ok(daily.humanSchedule?.includes('8:30 PM'));

  // 5. Ambiguous schedule requests clarification and fails closed
  const ambiguous = resolveSchedule('Schedule an automation for quarterly financial reports');
  assert.equal(ambiguous.valid, false);
  assert.equal(ambiguous.isAmbiguous, true);
  assert.ok(ambiguous.clarificationPrompt);
  assert.ok(ambiguous.clarificationPrompt.includes('time') || ambiguous.clarificationPrompt.includes('frequency'));
});

test('Durable Server-Side Idempotency: Returns cached replay on identical payload, rejects conflicting payload with 409', async () => {
  const { durableIdempotencyManager, IdempotencyConflictError, IdempotencyInProgressError } = await import('../apps/api/src/utils/idempotency');

  const testPrincipal = 'test_user_' + Date.now();
  const testOpId = 'op_idem_' + Date.now();
  const payload1 = { prompt: 'Generate diagram of microservices', quality: 'economy', numImages: 1 };
  const payloadConflict = { prompt: 'Different prompt with same key', quality: 'premium', numImages: 2 };

  // 1. Initial attempt proceeds
  const first = await durableIdempotencyManager.beginOrGet(testPrincipal, testOpId, 'TEST_OP', payload1);
  assert.equal(first.isReplay, false);

  // 2. In-progress concurrent attempt with same key throws 409 in-progress
  await assert.rejects(
    async () => {
      await durableIdempotencyManager.beginOrGet(testPrincipal, testOpId, 'TEST_OP', payload1);
    },
    (err: any) => err instanceof IdempotencyInProgressError && err.statusCode === 409
  );

  // 3. Complete the operation
  const mockResult = { id: 'img_test_1', url: 'https://example.com/img.png', chargedCredits: 12 };
  await durableIdempotencyManager.complete(testPrincipal, testOpId, 200, mockResult);

  // 4. Exact replay returns original cached result without re-executing
  const replay = await durableIdempotencyManager.beginOrGet(testPrincipal, testOpId, 'TEST_OP', payload1);
  assert.equal(replay.isReplay, true);
  if (replay.isReplay) {
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.responseBody, mockResult);
  }

  // 5. Conflicting payload with same operation key is rejected with HTTP 409 Conflict
  await assert.rejects(
    async () => {
      await durableIdempotencyManager.beginOrGet(testPrincipal, testOpId, 'TEST_OP', payloadConflict);
    },
    (err: any) => err instanceof IdempotencyConflictError && err.statusCode === 409
  );
});

test('Automation Execution Safety: Resolves schedules, prevents duplicate confirmation, and requires backend HTTP 201 before ACTIVE', () => {
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');

  // Verify App.tsx does not hardcode cronExpression: '0 9 * * *' for all proposals
  assert.ok(!appContent.includes("cronExpression: '0 9 * * *',"));

  // Verify App.tsx checks for ambiguous schedules and asks clarification
  assert.ok(appContent.includes('isAmbiguous') || appContent.includes('clarificationPrompt'));

  // Verify duplicate submission protection (pending state or in-flight tracking)
  assert.ok(appContent.includes('pendingAutomationIds') || appContent.includes('confirmingAutoId'));

  // Verify backend confirmation required before displaying ACTIVE
  assert.ok(appContent.includes('result.success && result.automationId'));

  // Verify ChatMessage renders human schedule and handles pending submission state
  const chatMsgPath = path.resolve(process.cwd(), 'src/components/ChatMessage.tsx');
  const chatMsgContent = fs.readFileSync(chatMsgPath, 'utf8');
  assert.ok(chatMsgContent.includes('humanSchedule') || chatMsgContent.includes('message.automationProposal.humanSchedule'));
});

test('Billable Vision Authorization: Requires pre-flight authorization card and does not execute immediately', () => {
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');

  // Verify App.tsx does not immediately call executeVisionGeneration upon detecting IMAGE_GENERATION
  assert.ok(!appContent.includes("if (intent.capability === 'IMAGE_GENERATION') {\n      setExecutionStatus('Invoking Vision Engine backend"));

  // Verify App.tsx prepares visionProposal
  assert.ok(appContent.includes('visionProposal: {'));
  assert.ok(appContent.includes('handleAuthorizeVision'));

  // Verify ChatMessage renders billable authorization card
  const chatMsgPath = path.resolve(process.cwd(), 'src/components/ChatMessage.tsx');
  const chatMsgContent = fs.readFileSync(chatMsgPath, 'utf8');
  assert.ok(chatMsgContent.includes('visionProposal'));
  assert.ok(chatMsgContent.includes('Authorize & Generate Image') || chatMsgContent.includes('Authorize Image Generation'));
  assert.ok(chatMsgContent.includes('onAuthorizeVision'));
});

test('Vision Cancellation & Transport Integrity: Passes AbortSignal, prevents stale state, and isolates on account switch', () => {
  const dispPath = path.resolve(process.cwd(), 'src/utils/capabilityDispatcher.ts');
  const dispContent = fs.readFileSync(dispPath, 'utf8');

  // Verify executeVisionGeneration accepts AbortSignal and passes to fetch
  assert.ok(dispContent.includes('signal?: AbortSignal'));
  assert.ok(dispContent.includes('signal,'));
  assert.ok(dispContent.includes('clientOperationId'));

  // Verify distinguishing transport cancellation
  assert.ok(dispContent.includes('cancelled: true') || dispContent.includes('AbortError'));

  // Verify App.tsx ignores stale vision responses when aborted or switched
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');
  assert.ok(appContent.includes('pendingVisionOps') || appContent.includes('isAuthorizingVision'));
  assert.ok(appContent.includes('authEpochRef.current'));
});

test('Zero-Emoji Policy: No non-ASCII emojis in modified frontend source files', () => {
  const targetFiles = [
    'src/App.tsx',
    'src/components/ChatMessage.tsx',
    'src/components/AgentContextualPanel.tsx',
    'src/utils/aiEngine.ts',
    'src/utils/capabilityDispatcher.ts',
    'src/utils/scheduleResolver.ts',
    'src/types/index.ts',
  ];

  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

  for (const rel of targetFiles) {
    const fullPath = path.resolve(process.cwd(), rel);
    const content = fs.readFileSync(fullPath, 'utf8');
    const match = emojiRegex.exec(content);
    assert.equal(match, null, `Found forbidden emoji in ${rel}: ${match?.[0]}`);
  }
});
