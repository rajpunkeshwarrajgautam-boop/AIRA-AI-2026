import assert from 'node:assert/strict';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { planMissionStep, permittedMissionTools } from '../packages/agent-runtime/src/mission-planner.js';
import { ModelRouter, type ModelAdapter } from '../packages/model-router/src/index.js';
import { ToolGateway, ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ToolDefinitionSchema, type Run, type DurableToolCall } from '../packages/contracts/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { BrainV2KnowledgeEngine } from '../packages/knowledge/src/index.js';
import { closeDb } from '../packages/db/src/index.js';

// In-memory repository and scripted model boundary fixtures exercise the real
// runtime/gateway. These are regression evidence, not live provider certification.
async function fixture(decisions: unknown[], maxSteps = 10, cancelDuringTool = false) {
  const runs = new Map<string, Run>();
  const calls = new Map<string, DurableToolCall>();
  let planningCalls = 0;
  const adapter: ModelAdapter = {
    complete: async messages => {
      planningCalls++;
      assert.ok(messages[0].content.includes('"expression"'), 'model receives required calculator schema');
      assert.ok(!messages[0].content.includes('repo_git_status'), 'ungranted repository tools are absent');
      return { text: JSON.stringify(decisions.shift()), model: 'fixture', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
    stream: async (messages, _policy, chunk) => {
      assert.ok(messages.every(message => ['system', 'user', 'assistant', 'tool'].includes(message.role)));
      chunk({ text: 'Fixture synthesis; final status is determined by execution evidence.' });
      return { text: '', model: 'fixture', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    }
  };
  const modelRouter = Object.assign(new ModelRouter(), { getAdapter: () => adapter });
  const runRepo = {
    saveRun: async (run: Run) => { runs.set(run.id, structuredClone(run)); },
    getRun: async (id: string) => { const run = runs.get(id); return run && structuredClone(run); },
    searchRunsForPrincipal: async () => [],
    appendRunEvent: async (event: unknown) => event
  };
  const gateway = new ToolGateway({
    saveToolCall: async call => { calls.set(call.id, call); },
    getToolCall: async id => calls.get(id),
    getToolCallByIdempotencyKey: async () => undefined,
    listToolCallsForRun: async () => [...calls.values()],
    listToolCallsForPrincipal: async () => [...calls.values()],
    updateToolCallStatus: async (id, lifecycleState, output, error) => { Object.assign(calls.get(id)!, { lifecycleState, output, error }); }
  });
  gateway.registerTool({
    definition: ToolDefinitionSchema.parse({ id: 'fixture_failure', name: 'fixture_failure', description: 'Owned failure fixture', parameters: {}, source: 'native', permissionLevel: 'READ', executionRuntime: 'LOCAL' }),
    execute: async () => { throw new Error('FIXTURE_EXECUTION_FAILURE'); }
  });
  if (cancelDuringTool) {
    gateway.registerTool({ definition: gateway.getTool('calculator')!.definition, execute: async () => {
      for (const run of runs.values()) if (run.state === 'WAITING_FOR_TOOL') run.state = 'CANCELLED';
      return { result: 4 };
    } });
  }
  const approval = { isToolCallApproved: async () => true };
  const router = { route: async () => ({ intent: 'AGENT_MISSION', confidence: 1, reason: 'Fixture route', executionTarget: 'AGENT_PLANNER', sideEffectLevel: 'READ', approvalRequired: false, capabilities: [], metadata: {} }) };
  const runtime = new AgentRuntime(modelRouter, new ToolRegistry(), approval as ApprovalKernel,
    { search: async () => [] } as unknown as BrainV2KnowledgeEngine, runRepo as never,
    process.cwd(), undefined, router as never, undefined, undefined, undefined, gateway);
  const created = await runtime.createRun({ prompt: 'Calculate 2+2 then 3*10.', intent: 'AGENT_MISSION' }, { userId: 'fixture-owner', sessionId: 'fixture-session', scopes: [] });
  created.maxSteps = maxSteps;
  await runRepo.saveRun(created);
  await runtime.startRun(created.id);
  return { run: (await runtime.getRun(created.id))!, planningCalls, gateway, adapter };
}

try {
  const valid = await fixture([
    { kind: 'tool', name: 'calculator', arguments: { expression: '2+2' } },
    { kind: 'tool', name: 'calculator', arguments: { expression: '3*10' } },
    { kind: 'finish', summary: '4 and 30 verified' }
  ]);
  assert.equal(valid.run.state, 'COMPLETED');
  assert.deepEqual(valid.run.toolResults.map(result => result.output.result), [4, 30]);
  assert.deepEqual(valid.run.toolsUsed, ['calculator', 'calculator']);
  assert.equal(valid.run.toolResults[0].toolCallId, valid.run.toolCalls[0].id);

  const recovered = await fixture([
    { kind: 'tool', name: 'calculator', arguments: {} },
    { kind: 'tool', name: 'calculator', arguments: { expression: '2+2' } },
    { kind: 'finish', summary: 'Corrected calculator input verified' }
  ]);
  assert.equal(recovered.run.toolResults[0].errorCode, 'TOOL_INPUT_INVALID');
  assert.equal(recovered.run.state, 'COMPLETED');
  assert.equal(recovered.run.toolResults[1].output.result, 4);

  const failed = await fixture([{ kind: 'tool', name: 'calculator', arguments: {} }, { kind: 'finish', summary: 'Unsupported success claim' }]);
  assert.equal(failed.run.state, 'FAILED');
  assert.match(failed.run.error!, /ALL_TOOLS_FAILED/);
  assert.match(failed.run.content, /Execution outcome: FAILED/);

  const partial = await fixture([
    { kind: 'tool', name: 'calculator', arguments: { expression: '2+2' } },
    { kind: 'tool', name: 'fixture_failure', arguments: {} },
    { kind: 'finish', summary: 'Only first step succeeds' }
  ]);
  assert.equal(partial.run.state, 'FAILED');
  assert.match(partial.run.error!, /PARTIAL_FAILURE/);
  assert.equal(partial.run.toolResults[0].output.result, 4);

  const budget = await fixture([{ kind: 'tool', name: 'calculator', arguments: {} }, { kind: 'tool', name: 'calculator', arguments: {} }], 1);
  assert.equal(budget.run.state, 'FAILED');
  assert.match(budget.run.error!, /STEP_BUDGET_EXHAUSTED/);
  assert.equal(budget.run.toolCalls.length, 1);

  const unauthorized = await fixture([{ kind: 'tool', name: 'repo_git_status', arguments: {} }, { kind: 'tool', name: 'repo_git_status', arguments: {} }]);
  assert.equal(unauthorized.run.state, 'FAILED');
  assert.match(unauthorized.run.error!, /PLAN_INVALID/);
  assert.equal(unauthorized.run.toolCalls.length, 0);
  const denied = await valid.gateway.execute({ toolName: 'repo_git_status', arguments: {}, context: { runId: valid.run.id, principal: { userId: 'fixture-owner', sessionId: 'fixture-session', scopes: [] } } });
  assert.equal(denied.errorCode, 'TOOL_PERMISSION_DENIED');
  assert.ok(!permittedMissionTools(valid.gateway.listDefinitions(), []).some(def => def.name === 'repo_git_status'));

  const cancelled = await fixture([{ kind: 'tool', name: 'calculator', arguments: { expression: '2+2' } }], 10, true);
  assert.equal(cancelled.run.state, 'CANCELLED');
  assert.equal(cancelled.planningCalls, 1);

  let malformedCalls = 0;
  const malformedAdapter = { ...valid.adapter, complete: async () => {
    malformedCalls++;
    return { text: 'invalid JSON', model: 'fixture', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  } };
  await assert.rejects(planMissionStep(valid.run, valid.gateway.listDefinitions(), malformedAdapter), /PLAN_INVALID/);
  assert.equal(malformedCalls, 2);
  console.log('PASS: mission schemas, real calculator execution, argument recovery, failure/partial outcomes, scope denial, budgets and cancellation (fixtures)');
} finally { await closeDb(); }
