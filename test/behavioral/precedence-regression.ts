import assert from 'node:assert';
import { CapabilityRegistry } from '../../packages/agent-runtime/src/registry.js';
import { ServerIntentRouter } from '../../packages/agent-runtime/src/router.js';
import { ExecutionPrincipal } from '../../packages/contracts/src/index.js';

async function testPrecedence() {
  console.log('=== PRECEDENCE REGRESSION TEST ===');
  const registry = new CapabilityRegistry();
  const router = new ServerIntentRouter(registry);

  const principal: ExecutionPrincipal = {
    userId: 'usr_test_audit',
    sessionId: 'sess_test_precedence',
    roles: ['member']
  };

  const testCases: Array<{
    prompt: string;
    expectedIntent: string;
    expectedTarget: string;
    description: string;
  }> = [
    {
      prompt: "Schedule a daily check of NVIDIA's current share price.",
      expectedIntent: 'AUTOMATION_CREATE',
      expectedTarget: 'AUTOMATION_ENGINE',
      description: 'Automation create must take precedence over freshness'
    },
    {
      prompt: "Create an automation to summarize the latest AI news every morning.",
      expectedIntent: 'AUTOMATION_CREATE',
      expectedTarget: 'AUTOMATION_ENGINE',
      description: 'Automation create must take precedence over latest news freshness'
    },
    {
      prompt: "Run my workflow to research today's market developments and publish a report.",
      expectedIntent: 'WORKFLOW',
      expectedTarget: 'WORKFLOW_ENGINE',
      description: 'Workflow execution must take precedence over freshness'
    },
    {
      prompt: "Investigate the latest failing deployment and fix the affected source code.",
      expectedIntent: 'AGENT_MISSION',
      expectedTarget: 'AGENT_PLANNER',
      description: 'Agent mission must take precedence over latest deployment inquiry'
    },
    {
      prompt: "Open a website and find today's published exchange rate.",
      expectedIntent: 'TOOL_ACTION',
      expectedTarget: 'TOOL_PIPELINE',
      description: 'Tool action must take precedence over today rate freshness'
    },
    {
      prompt: "What is the current share price of NVIDIA?",
      expectedIntent: 'RESEARCH',
      expectedTarget: 'RESEARCH_SYNTHESIS',
      description: 'Pure current data query must route to RESEARCH'
    },
    {
      prompt: "Explain how the latest stock exchange regulations work.",
      expectedIntent: 'ANSWER',
      expectedTarget: 'CHAT_STREAM',
      description: 'Explanation of regulations must route to ANSWER'
    },
    {
      prompt: "Delete the scheduled market report automation.",
      expectedIntent: 'TOOL_ACTION',
      expectedTarget: 'TOOL_PIPELINE',
      description: 'Delete automation command must route to TOOL_ACTION'
    },
    {
      prompt: "Compare the latest AI models using reliable sources.",
      expectedIntent: 'RESEARCH',
      expectedTarget: 'RESEARCH_SYNTHESIS',
      description: 'Model comparison with sources must route to RESEARCH'
    },
    {
      prompt: "Inspect the current Git branch and summarize recent commits.",
      expectedIntent: 'TOOL_ACTION',
      expectedTarget: 'TOOL_PIPELINE',
      description: 'Git inspection must route to TOOL_ACTION'
    }
  ];

  let failures = 0;
  for (const tc of testCases) {
    const res = await router.route({
      prompt: tc.prompt,
      principal
    });

    const passed = res.intent === tc.expectedIntent && res.executionTarget === tc.expectedTarget;
    if (!passed) {
      failures++;
      console.error(`FAIL: "${tc.prompt}"`);
      console.error(`  Expected: ${tc.expectedIntent} (${tc.expectedTarget})`);
      console.error(`  Got:      ${res.intent} (${res.executionTarget})`);
    } else {
      console.log(`PASS: "${tc.prompt}" -> ${res.intent} (${res.executionTarget})`);
    }
  }

  if (failures > 0) {
    console.error(`\nTotal failures: ${failures}/${testCases.length}`);
    process.exit(1);
  } else {
    console.log(`\nAll ${testCases.length} precedence tests passed!`);
  }
}

testPrecedence().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
