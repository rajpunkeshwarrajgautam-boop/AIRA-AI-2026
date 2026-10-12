import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { AgentRuntime } from '../../packages/agent-runtime/src/index.js';
import { ModelRouter } from '../../packages/model-router/src/index.js';
import { ToolRegistry } from '../../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../../packages/approvals/src/index.js';
import { PostgresApprovalRepository, PostgresSessionGrantRepository } from '../../packages/approvals/src/repositories.js';
import { BrainV2KnowledgeEngine } from '../../packages/knowledge/src/index.js';
import { PostgresRunRepository } from '../../packages/agent-runtime/src/repositories.js';
import { ExecutionPrincipal } from '../../packages/contracts/src/index.js';
import { db } from '../../packages/db/src/index.js';

describe('AIRA Behavioral Intelligence — End-to-End Clarification Delivery', () => {
  const modelRouter = new ModelRouter();
  const toolRegistry = new ToolRegistry();
  const approvalKernel = new ApprovalKernel(new PostgresApprovalRepository(), new PostgresSessionGrantRepository());
  const knowledgeEngine = new BrainV2KnowledgeEngine();
  const runRepo = new PostgresRunRepository();

  const runtime = new AgentRuntime(
    modelRouter,
    toolRegistry,
    approvalKernel,
    knowledgeEngine,
    runRepo,
    process.cwd()
  );

  const userA: ExecutionPrincipal = {
    userId: 'usr_alice_123',
    sessionId: 'sess_alice_456',
    roles: ['member']
  };

  const userB: ExecutionPrincipal = {
    userId: 'usr_bob_789',
    sessionId: 'sess_bob_101',
    roles: ['member']
  };

  after(async () => {
    try {
      await db.destroy();
    } catch {
      // Ignore if already destroyed
    }
  });

  async function executePrompt(prompt: string, principal: ExecutionPrincipal, history?: Array<{ role: string; content: string }>) {
    const run = await runtime.createRun({
      prompt,
      context: history ? { history } : undefined
    }, principal);

    const deltas: string[] = [];
    const eventStream = runtime.getEventStream(run.id);

    return new Promise<{ runId: string; content: string; deltas: string[]; completed: boolean }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for run ${run.id}`));
      }, 5000);

      eventStream.on('event', (evt: any) => {
        if (evt.type === 'content.delta') {
          deltas.push(evt.data.delta);
        } else if (evt.type === 'run.completed') {
          clearTimeout(timeout);
          runtime.getRun(run.id).then(finalRun => {
            resolve({
              runId: run.id,
              content: finalRun?.content || '',
              deltas,
              completed: true
            });
          }).catch(reject);
        } else if (evt.type === 'run.failed') {
          clearTimeout(timeout);
          reject(new Error(`Run failed: ${evt.data?.error}`));
        }
      });

      runtime.startRun(run.id).catch(reject);
    });
  }

  it('delivers clarification stream for ambiguous share price without fabricating entity', async () => {
    const res = await executePrompt('What is the current share price?', userA);
    assert.ok(res.completed, 'Must complete');
    assert.ok(res.deltas.length > 0, 'Must emit streaming delta');
    assert.ok(
      res.content.toLowerCase().includes('company') || res.content.toLowerCase().includes('ticker'),
      `Must ask for company or ticker symbol. Got: "${res.content}"`
    );
  });

  it('delivers clarification stream for ambiguous weather without fabricating location', async () => {
    const res = await executePrompt('What is the weather today?', userA);
    assert.ok(res.completed, 'Must complete');
    assert.ok(res.deltas.length > 0, 'Must emit streaming delta');
    assert.ok(
      res.content.toLowerCase().includes('city') || res.content.toLowerCase().includes('location'),
      `Must ask for city or location. Got: "${res.content}"`
    );
  });

  it('delivers clarification stream for ambiguous box office without fabricating movie', async () => {
    const res = await executePrompt('What is the latest box office collection?', userA);
    assert.ok(res.completed, 'Must complete');
    assert.ok(res.deltas.length > 0, 'Must emit streaming delta');
    assert.ok(
      res.content.toLowerCase().includes('movie') || res.content.toLowerCase().includes('rankings'),
      `Must ask for movie or rankings. Got: "${res.content}"`
    );
  });

  it('demands clarification on unresolvable pronoun referent', async () => {
    const res = await executePrompt('What is its current share price?', userA);
    assert.ok(res.completed, 'Must complete');
    assert.ok(
      res.content.toLowerCase().includes('company') || res.content.toLowerCase().includes('ticker'),
      `Must ask for clarification on missing pronoun referent. Got: "${res.content}"`
    );
  });

  it('resolves referent when mentioned in conversation history without clarification', async () => {
    const historyWithNvidia = [
      { role: 'user', content: 'Tell me about NVIDIA GPU lineup.' },
      { role: 'assistant', content: 'NVIDIA manufactures high performance GPUs like the H100.' }
    ];
    const decision = await runtime.getRouter().route({
      prompt: 'What is its current share price?',
      conversationHistory: historyWithNvidia,
      principal: userA
    });
    assert.strictEqual(decision.intent, 'RESEARCH', 'Must resolve to RESEARCH when entity is known');
    assert.strictEqual(decision.metadata?.isFreshnessRequired, true);
  });

  it('guarantees cross-user context isolation without referent leakage', async () => {
    const resUserB = await executePrompt('What is its current share price?', userB);
    assert.ok(
      resUserB.content.toLowerCase().includes('company') || resUserB.content.toLowerCase().includes('ticker'),
      'User B must demand clarification and NOT inherit User A history'
    );
  });
});
