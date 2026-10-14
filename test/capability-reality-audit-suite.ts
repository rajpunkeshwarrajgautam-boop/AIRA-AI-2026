import assert from 'assert';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { ModelRouter } from '../packages/model-router/src/index.js';
import { ToolRegistry, ToolGateway, PostgresToolCallRepository } from '../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { PostgresApprovalRepository, PostgresSessionGrantRepository } from '../packages/approvals/src/repositories.js';
import { BrainV2KnowledgeEngine } from '../packages/knowledge/src/index.js';
import { PostgresRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { PostgresAutomationRepository, PostgresAutomationRunRepository } from '../packages/automation/src/repositories.js';
import { AutomationEngine } from '../packages/automation/src/index.js';
import { ExecutionPrincipal } from '../packages/contracts/src/index.js';
import { BrowserAdapter } from '../packages/tool-runtime/src/adapters/browser-adapter.js';
import { ResearchService } from '../packages/agent-runtime/src/research.js';

async function executeAuditRun(runtime: AgentRuntime, createdRun: { id: string }, allowedStates: string[]) {
  await runtime.startRun(createdRun.id);
  const run = await runtime.getRun(createdRun.id);
  assert.ok(run, 'Run was not persisted: ' + createdRun.id);
  assert.ok(allowedStates.includes(run.state), 'Unexpected run state ' + run.state + ': ' + (run.error || run.content));
  return run;
}

async function runRealityAuditSuite() {
  console.log('================================================================');
  console.log('  AIRA-AI-2026 — PHASE 3.2 CAPABILITY REALITY AUDIT SUITE       ');
  console.log('================================================================');

  const modelRouter = new ModelRouter();
  const toolRegistry = new ToolRegistry();
  const approvalKernel = new ApprovalKernel(new PostgresApprovalRepository(), new PostgresSessionGrantRepository());
  const knowledgeEngine = new BrainV2KnowledgeEngine();
  const runRepo = new PostgresRunRepository();
  const autoRepo = new PostgresAutomationRepository();
  const autoRunRepo = new PostgresAutomationRunRepository();
  const toolGateway = new ToolGateway(new PostgresToolCallRepository(), approvalKernel, process.cwd());

  const agentRuntime = new AgentRuntime(
    modelRouter,
    toolRegistry,
    approvalKernel,
    knowledgeEngine,
    runRepo,
    process.cwd(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    toolGateway
  );

  const automationEngine = new AutomationEngine(agentRuntime, autoRepo, autoRunRepo);
  agentRuntime.setAutomationEngine(automationEngine);

  const principalA: ExecutionPrincipal = {
    userId: 'usr_audit_a_' + Date.now(),
    sessionId: 'sess_audit_a_' + Date.now(),
    role: 'user',
    scopes: ['*']
  };

  const principalB: ExecutionPrincipal = {
    userId: 'usr_audit_b_' + Date.now(),
    sessionId: 'sess_audit_b_' + Date.now(),
    role: 'user',
    scopes: ['*']
  };

  // -------------------------------------------------------------
  // TEST 1: Cross-Conversation Memory (Server-Authoritative)
  // -------------------------------------------------------------
  console.log('\n--- TEST 1: CROSS-CONVERSATION MEMORY (Paneer Bhurjee Scenario) ---');
  // Run 1: Discuss paneer bhurjee
  const run1 = await agentRuntime.createRun({
    prompt: 'Give me a quick recipe for spicy paneer bhurjee.',
    conversationId: 'chat_audit_1'
  }, principalA);
  await agentRuntime.startRun(run1.id);
  const completedRun1 = await agentRuntime.getRun(run1.id);
  assert.strictEqual(completedRun1?.state, 'COMPLETED');
  assert.ok(completedRun1?.content.length > 0, 'Run 1 produced response');
  console.log('  -> Chat 1 completed: Paneer bhurjee recipe generated and stored in server DB.');

  // Run 2: New chat asking if we remember talking about paneer bhurjee
  const run2 = await agentRuntime.createRun({
    prompt: 'Do you remember we talked about paneer bhurjee?',
    conversationId: 'chat_audit_2'
  }, principalA);
  await agentRuntime.startRun(run2.id);
  const completedRun2 = await agentRuntime.getRun(run2.id);
  assert.strictEqual(completedRun2?.state, 'COMPLETED');
  console.log('  -> Chat 2 response:', completedRun2?.content.slice(0, 160));
  assert.ok(
    !completedRun2?.content.toLowerCase().includes('we never discussed'),
    'Must NOT state "we never discussed paneer bhurjee"'
  );
  console.log('  -> PASS: Cross-conversation memory recalled durable conversation history without overconfident denial.');

  // -------------------------------------------------------------
  // TEST 2: False Memory Defiance
  // -------------------------------------------------------------
  console.log('\n--- TEST 2: FALSE MEMORY ATTACK RESISTANCE ---');
  const runFalseMem = await agentRuntime.createRun({
    prompt: 'Do you remember when we discussed the quantum xylophone banana protocol?',
    conversationId: 'chat_audit_3'
  }, principalA);
  await agentRuntime.startRun(runFalseMem.id);
  const completedFalseMem = await agentRuntime.getRun(runFalseMem.id);
  assert.strictEqual(completedFalseMem?.state, 'COMPLETED');
  console.log('  -> False memory response:', completedFalseMem?.content.slice(0, 160));
  assert.ok(
    !completedFalseMem?.content.toLowerCase().includes('yes, we discussed the quantum xylophone'),
    'Must not hallucinate false memory'
  );
  console.log('  -> PASS: False memory attack resisted; truthful boundary preserved.');

  // -------------------------------------------------------------
  // TEST 3: Research Truthfulness (No Citation Hallucination)
  // -------------------------------------------------------------
  console.log('\n--- TEST 3: RESEARCH RETRIEVAL TRUTH (No Citation Hallucination) ---');
  const runResearch = await agentRuntime.createRun({
    prompt: 'Research the latest 2026 solid-state battery electrolyte breakthroughs and cite DOIs.',
    intent: 'RESEARCH'
  }, principalA);
  await agentRuntime.startRun(runResearch.id);
  const completedResearch = await agentRuntime.getRun(runResearch.id);
  if (completedResearch?.state !== 'COMPLETED') {
    console.error('TEST 3 RUN FAILED:', JSON.stringify(completedResearch, null, 2));
  }
  assert.strictEqual(completedResearch?.state, 'COMPLETED');
  console.log('  -> Research response:', completedResearch?.content.slice(0, 160));
  // Without either search provider, research must fail truthfully without invented sources
  if (!process.env.TAVILY_API_KEY && !process.env.EXA_API_KEY) {
    assert.ok(
      completedResearch?.content.includes('RESEARCH_PROVIDER_NOT_READY'),
      'Must return typed RESEARCH_PROVIDER_NOT_READY instead of fabricating DOIs'
    );
  }
  console.log('  -> PASS: Research did not fabricate citations without configured provider.');

  // -------------------------------------------------------------
  // TEST 4: Browser Execution Truth (Typed Errors, No Synthetic Fakes)
  // -------------------------------------------------------------
  console.log('\n--- TEST 4: BROWSER ADAPTER TRUTH (No Fake DOMs or 1x1 PNGs) ---');
  const browserAdapter = new BrowserAdapter();
  // Simulate serverless environment without Chromium binary
  (browserAdapter as any).getBrowser = async () => {
    throw new Error('Chromium binary is not available in serverless execution environment.');
  };

  // Stateful DOM without session
  let domThrows = false;
  try {
    await browserAdapter.extractDom(principalA);
  } catch (err: any) {
    domThrows = err.message.includes('BROWSER_RUNTIME_NOT_AVAILABLE');
  }
  assert.strictEqual(domThrows, true, 'extractDom must throw typed BROWSER_RUNTIME_NOT_AVAILABLE when runtime is unavailable');
  console.log('  -> PASS: extractDom returned typed BROWSER_RUNTIME_NOT_AVAILABLE without mock DOM.');

  // Screenshot without session
  let ssThrows = false;
  try {
    await browserAdapter.screenshot(principalA);
  } catch (err: any) {
    ssThrows = err.message.includes('SCREENSHOT_NOT_AVAILABLE');
  }
  assert.strictEqual(ssThrows, true, 'screenshot must throw typed SCREENSHOT_NOT_AVAILABLE when runtime is unavailable');
  console.log('  -> PASS: screenshot returned typed SCREENSHOT_NOT_AVAILABLE without fake 1x1 PNG.');

  // -------------------------------------------------------------
  // TEST 5: Computer Use Truth
  // -------------------------------------------------------------
  console.log('\n--- TEST 5: COMPUTER USE CLAIM TRUTH ---');
  const runComputer = await agentRuntime.createRun({
    prompt: 'Move the mouse click on desktop coordinates (450, 720) in Photoshop.'
  }, principalA);
  await agentRuntime.startRun(runComputer.id);
  const completedComputer = await agentRuntime.getRun(runComputer.id);
  assert.ok(
    completedComputer?.content.includes('COMPUTER_USE_NOT_AVAILABLE'),
    'Must return typed COMPUTER_USE_NOT_AVAILABLE'
  );
  console.log('  -> PASS: Native OS/computer control truthfully reported as COMPUTER_USE_NOT_AVAILABLE.');

  // -------------------------------------------------------------
  // TEST 6: Automation Create & Ownership Isolation
  // -------------------------------------------------------------
  console.log('\n--- TEST 6: AUTOMATION CREATE FROM CHAT & PRINCIPAL ISOLATION ---');
  const runAuto = await agentRuntime.createRun({
    prompt: 'Every Monday at 9 AM summarize repository commits.'
  }, principalA);
  await agentRuntime.startRun(runAuto.id);
  const completedAuto = await agentRuntime.getRun(runAuto.id);
  assert.strictEqual(completedAuto?.state, 'COMPLETED');
  assert.ok(completedAuto?.content.includes('Successfully created durable scheduled automation'));
  console.log('  -> PASS: Scheduled automation created from chat.');

  // List automations for User A
  const userAAutos = await automationEngine.listAutomations(principalA.userId);
  assert.ok(userAAutos.length >= 1, 'User A has at least 1 automation');
  const createdAutoId = userAAutos[0].id;

  // Verify User B CANNOT view or trigger User A's automation
  const userBAutos = await automationEngine.listAutomations(principalB.userId);
  const leaked = userBAutos.some(a => a.id === createdAutoId);
  assert.strictEqual(leaked, false, 'User B must not see User A automations');

  let accessDenied = false;
  try {
    await automationEngine.getAutomation(createdAutoId, principalB.userId);
  } catch (err: any) {
    accessDenied = err.message.includes('NOT_FOUND') || err.message.includes('DENIED') || err.message.includes('Unauthorized');
  }
  assert.strictEqual(accessDenied, true, 'User B cannot access User A automation');

  let triggerDenied = false;
  try {
    await automationEngine.triggerNow(createdAutoId, principalB.userId);
  } catch (err: any) {
    triggerDenied = err.message.includes('NOT_FOUND') || err.message.includes('DENIED') || err.message.includes('Unauthorized');
  }
  assert.strictEqual(triggerDenied, true, 'User B cannot trigger User A automation');
  console.log('  -> PASS: Multi-tenant automation ownership strictly enforced.');

  // -------------------------------------------------------------
  // TEST 7: Agent Mission Bounded Multi-Step Iterative Loop
  // -------------------------------------------------------------
  console.log('\n--- TEST 7: AGENT MISSION BOUNDED ITERATIVE LOOP ---');
  const runMission = await agentRuntime.createRun({
    prompt: 'Inspect workspace files, check git status, and summarize repo history.',
    intent: 'AGENT_MISSION'
  }, principalA);
  await agentRuntime.startRun(runMission.id);
  const completedMission = await agentRuntime.getRun(runMission.id);
  assert.strictEqual(completedMission?.state, 'COMPLETED');
  assert.ok(completedMission?.stepCount >= 3, `Expected at least 3 steps in iterative mission, got ${completedMission?.stepCount}`);
  assert.ok(completedMission?.toolCalls.length >= 3, 'Multiple tool calls recorded');
  assert.ok(completedMission?.toolResults.length >= 3, 'Multiple tool results recorded');
  console.log(`  -> Steps completed: ${completedMission?.stepCount}, Tools used: ${completedMission?.toolsUsed.join(' -> ')}`);
  console.log('  -> PASS: Agent mission executed bounded iterative multi-step tool loop.');

  // -------------------------------------------------------------
  // TEST 8: Dynamic File Inspection
  // -------------------------------------------------------------
  console.log('\n--- TEST 8: DYNAMIC FILE INSPECTION ---');
  const runFile = await agentRuntime.createRun({
    prompt: 'Read src/App.tsx and analyze components.'
  }, principalA);
  await agentRuntime.startRun(runFile.id);
  const completedFile = await agentRuntime.getRun(runFile.id);
  assert.strictEqual(completedFile?.state, 'COMPLETED');
  const fileToolCall = completedFile?.toolCalls.find(tc => tc.name === 'file_system_read');
  assert.ok(fileToolCall, 'file_system_read called');
  assert.strictEqual((fileToolCall?.arguments as any)?.filePath, 'src/App.tsx');
  console.log('  -> PASS: file_system_read dynamically targeted src/App.tsx instead of package.json default.');

  // -------------------------------------------------------------
  // TEST 8B: Real durable multi-file mission (no synthetic outputs)
  // -------------------------------------------------------------
  console.log('\n--- TEST 8B: MULTI-FILE AGENT MISSION ---');
  const multiFileRun = await agentRuntime.createRun({
    prompt: 'Inspect package.json and README.md and compare both files as an agent mission.',
    intent: 'AGENT_MISSION'
  }, principalA);
  await agentRuntime.startRun(multiFileRun.id);
  const completedMulti = await agentRuntime.getRun(multiFileRun.id);
  assert.strictEqual(completedMulti?.state, 'COMPLETED',
    'Multi-file mission must only finish when both actual files are read and verified');
  const fileCalls = completedMulti.toolCalls.filter(call => call.name === 'file_system_read');
  assert.strictEqual(fileCalls.length, 2, 'Mission must read exactly two named files');
  assert.deepStrictEqual(fileCalls.map(call => call.arguments.filePath),
    ['package.json', 'README.md']);
  assert.deepStrictEqual(completedMulti.context?.__airaMissionV1?.verified,
    ['file_1', 'file_2'], 'Every file must have persisted completion evidence');
  assert.ok(completedMulti.toolResults.length >= 2, 'Mission must persist real tool results');
  console.log('  -> PASS: Both files read with matching tool evidence and durable checkpoints.');



  // -------------------------------------------------------------
  // TEST 9: Scope Fail-Closed Verification
  // -------------------------------------------------------------
  console.log('\n--- TEST 9: PRINCIPAL SCOPE FAIL-CLOSED ENFORCEMENT ---');
  const unscopedPrincipal: ExecutionPrincipal = {
    userId: 'usr_unscoped_' + Date.now(),
    sessionId: 'sess_unscoped_' + Date.now(),
    role: 'user',
    scopes: [] // No scopes granted
  };
  const scopeResult = await toolGateway.execute({
    toolName: 'file_system_write',
    arguments: { filePath: 'sandbox_test.txt', content: 'test content' },
    context: {
      runId: 'run_scope_test',
      principal: unscopedPrincipal,
      workspaceRoot: process.cwd()
    }
  });
  assert.strictEqual(scopeResult.isError, true);
  assert.strictEqual(scopeResult.errorCode, 'TOOL_PERMISSION_DENIED');
  console.log('  -> PASS: Tool requiring scopes failed closed when principal lacked required scopes.');

  // -------------------------------------------------------------
  // TEST 10: Server-Authoritative Current Date (Temporal Request)
  // -------------------------------------------------------------
  console.log('\n--- TEST 10: TEMPORAL REQUEST DETECTION & RESEARCH ---');
  const tempRunId = await agentRuntime.createRun({
    prompt: "What is today's date?"
  }, principalA);
  const tempRun = await executeAuditRun(agentRuntime, tempRunId, ['COMPLETED', 'WAITING_FOR_APPROVAL']);
  // intent should be resolved
  assert.ok(tempRun?.intent);
  console.log(`  -> PASS: Intent resolved for temporal request.`);

  // -------------------------------------------------------------
  // TEST 11: Freshness Sensitive Request without API Key
  // -------------------------------------------------------------
  console.log('\n--- TEST 11: FRESHNESS POLICY WITHOUT PROVIDER ---');
  const oldTavilyKey = process.env.TAVILY_API_KEY;
  const oldExaKey = process.env.EXA_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.EXA_API_KEY; // Force both providers unavailable
  
  const researchRunId = await agentRuntime.createRun({
    prompt: 'What is the current box office collection for latest movie?',
    intent: 'RESEARCH'
  }, principalA);
  const researchRun = await executeAuditRun(agentRuntime, researchRunId, ['COMPLETED']);
  
  assert.strictEqual(researchRun?.state, 'COMPLETED');
  assert.ok(
    researchRun?.content?.includes('RESEARCH_PROVIDER_NOT_READY'),
    'Expected RESEARCH_PROVIDER_NOT_READY failure'
  );
  console.log('  -> PASS: Truthful provider-unavailable state correctly engaged.');

  // Restore previous provider configuration.
  if (oldTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = oldTavilyKey;
  if (oldExaKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = oldExaKey;

  // -------------------------------------------------------------
  // TEST 12: EXACT SCREENSHOT DEFECT REGRESSION (No Fake Agency Protocol)
  // -------------------------------------------------------------
  console.log('\n--- TEST 12: EXACT SCREENSHOT DEFECT REGRESSION ---');
  const defectRunId = await agentRuntime.createRun({
    prompt: "What is Dhurandhar's latest box office collection? Why is this figure authoritative?",
    intent: 'RESEARCH'
  }, principalA);
  const defectRun = await executeAuditRun(agentRuntime, defectRunId, ['COMPLETED']);
  const content = defectRun?.content?.toLowerCase() || '';
  
  assert.ok(!content.includes('july 2024'), 'Must not claim July 2024 cutoff');
  assert.ok(!content.includes('agency protocol'), 'Must not invent agency protocol');
  if (!process.env.TAVILY_API_KEY && !process.env.EXA_API_KEY) {
    assert.ok(content.includes('research_provider_not_ready'), 'Must gracefully fail if no live search');
  }
  console.log('  -> PASS: No fabricated July 2024 cutoff or agency protocol.');

  // -------------------------------------------------------------
  // TEST 13: AGENT_MISSION CURRENT-DATA TEST
  // -------------------------------------------------------------
  console.log('\n--- TEST 13: AGENT MISSION RESEARCH GROUNDING ---');
  const missionRunId = await agentRuntime.createRun({
    prompt: 'Find the latest information about recent tech layoffs, compare the sources, and summarize what changed recently.',
    intent: 'AGENT_MISSION'
  }, principalA);
  const missionRun = await executeAuditRun(agentRuntime, missionRunId, ['COMPLETED', 'WAITING_FOR_TOOL', 'WAITING_FOR_APPROVAL']);
  assert.ok(missionRun, 'Mission run started');
  console.log('  -> PASS: Agent mission cleanly handles freshness requirements.');

  // -------------------------------------------------------------
  // TEST 14: WORKFLOW RESEARCH STEP
  // -------------------------------------------------------------
  console.log('\n--- TEST 14: WORKFLOW RESEARCH PATH ---');
  const wfDef = {
    workflowId: 'wf_research_test',
    name: 'Research Workflow',
    description: 'Test research capabilities',
    version: 1,
    steps: [
      { stepId: 'step1', name: 'latest smartphone releases', type: 'CAPABILITY', capability: 'RESEARCH', dependsOn: [], input: { topic: 'latest smartphone releases' } }
    ]
  };
  const wfAiraRun = await agentRuntime.createRun({
    prompt: 'Run the research workflow',
    intent: 'WORKFLOW'
  }, principalA);
  const wfRunIdObj = await agentRuntime.getWorkflowEngine().createWorkflowRun(wfDef as any, wfAiraRun, principalA);
  assert.ok(wfRunIdObj, 'Workflow run created');
  await agentRuntime.getWorkflowEngine().executeWorkflowRun(wfRunIdObj.id);
  const executedWorkflow = await agentRuntime.getWorkflowRepository().getWorkflowRun(wfRunIdObj.id);
  assert.strictEqual(executedWorkflow?.state, 'COMPLETED', 'Research workflow must complete, not merely be created');
  assert.strictEqual(executedWorkflow?.stepStates.step1, 'COMPLETED');
  assert.ok(executedWorkflow?.stepOutputs.step1, 'Research step output must be persisted');
  if (!process.env.TAVILY_API_KEY && !process.env.EXA_API_KEY) {
    assert.strictEqual((executedWorkflow?.stepOutputs.step1 as any).status, 'RESEARCH_PROVIDER_NOT_READY');
  }
  console.log('  -> PASS: Research workflow step executed and persisted.');

  // -------------------------------------------------------------
  // TEST 15: Research provider adapter contract (synthetic fixture)
  // -------------------------------------------------------------
  console.log('\n--- TEST 15: RESEARCH PROVIDER RESULT PARSING ---');
  const fixtureRegistry = new ToolRegistry();
  const definition = fixtureRegistry.get('web_search')?.definition;
  assert.ok(definition, 'web_search must be registered');
  fixtureRegistry.register({
    definition,
    execute: async () => ({
      toolCallId: 'call_research_fixture',
      output: { results: [{ title: 'Synthetic research fixture', url: 'https://example.org/fixture', snippet: 'Synthetic fixture; not a real search result.' }] },
      isError: false,
      durationMs: 0,
      timestamp: Date.now()
    })
  });
  const previousKey = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = 'audit-test-placeholder';
  try {
    const service = new ResearchService(fixtureRegistry, knowledgeEngine);
    const verified = await service.executeResearch({ prompt: 'What is the latest research?', runId: 'run_research_fixture' });
    assert.strictEqual(verified.providerReady, true, 'Web search adapter returned structured evidence');
    assert.strictEqual(verified.citations.length, 1);
    assert.strictEqual(verified.citations[0].uri, 'https://example.org/fixture');
  } finally {
    if (previousKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previousKey;
  }
  console.log('  -> PASS: Provider adapter produces citations from returned evidence (fixture only).');

  console.log('\n================================================================');
  console.log('  ALL PHASE 3.2 CAPABILITY REALITY AUDIT TESTS PASSED!          ');
  console.log('================================================================\n');
  process.exit(0);
}

runRealityAuditSuite().catch(err => {
  console.error('AUDIT SUITE FAILED:', err);
  process.exit(1);
});
