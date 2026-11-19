import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { InMemoryAgentRepository } from '../packages/agent-runtime/src/repositories.js';
import type { AgentDefinition } from '../packages/agent-runtime/src/types.js';

describe('Remediation F7: Saved-Agent Quota Concurrency & Atomic Limits', () => {
  function makeAgentDef(principalId: string, name: string): AgentDefinition {
    return {
      id: `agent_${crypto.randomUUID().slice(0, 8)}`,
      principalId,
      name,
      description: 'Test agent for quota concurrency',
      instructions: 'You are a test agent.',
      modelPolicy: { model: 'mock-deterministic' },
      tools: [],
      memoryScopes: ['workspace'],
      approvalPolicy: 'autonomous',
      maxSteps: 5,
      timeoutMs: 30000
    };
  }

  it('strictly limits concurrent creation bursts to exact plan limit without over-allocation', async () => {
    const repo = new InMemoryAgentRepository();
    const principalId = 'usr_quota_concurrent_test';
    const quotaLimit = 3;
    const concurrentRequests = 20;

    // Fire 20 simultaneous creation requests at the exact same millisecond
    const creationPromises = Array.from({ length: concurrentRequests }, (_, i) =>
      repo.createAgentWithQuota(makeAgentDef(principalId, `Concurrent Agent ${i + 1}`), principalId, quotaLimit)
    );

    const results = await Promise.allSettled(creationPromises);

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    assert.equal(succeeded.length, quotaLimit, `Exactly ${quotaLimit} requests must succeed`);
    assert.equal(failed.length, concurrentRequests - quotaLimit, `Exactly ${concurrentRequests - quotaLimit} requests must be rejected`);

    for (const rej of failed) {
      if (rej.status === 'rejected') {
        assert.equal((rej.reason as any).name, 'AgentLimitExceededError');
        assert.match((rej.reason as any).message, /Maximum agent limit \(3\) reached/);
      }
    }

    // Verify stored count in repository
    const storedAgents = await repo.listAgents(principalId);
    assert.equal(storedAgents.length, quotaLimit, `Total stored agents must be strictly ${quotaLimit}`);
  });

  it('isolates concurrency serialization per principal without blocking independent accounts', async () => {
    const repo = new InMemoryAgentRepository();
    const principalA = 'usr_principal_alpha';
    const principalB = 'usr_principal_beta';
    const quotaLimit = 2;

    const batchA = Array.from({ length: 5 }, (_, i) =>
      repo.createAgentWithQuota(makeAgentDef(principalA, `Agent A-${i}`), principalA, quotaLimit)
    );
    const batchB = Array.from({ length: 5 }, (_, i) =>
      repo.createAgentWithQuota(makeAgentDef(principalB, `Agent B-${i}`), principalB, quotaLimit)
    );

    const [resultsA, resultsB] = await Promise.all([
      Promise.allSettled(batchA),
      Promise.allSettled(batchB)
    ]);

    const succeededA = resultsA.filter(r => r.status === 'fulfilled');
    const succeededB = resultsB.filter(r => r.status === 'fulfilled');

    assert.equal(succeededA.length, quotaLimit, 'Principal A must have exactly 2 creations succeed');
    assert.equal(succeededB.length, quotaLimit, 'Principal B must have exactly 2 creations succeed');

    const storedA = await repo.listAgents(principalA);
    const storedB = await repo.listAgents(principalB);

    assert.equal(storedA.length, quotaLimit);
    assert.equal(storedB.length, quotaLimit);
  });

  it('allows new agent creation after deleting an existing agent', async () => {
    const repo = new InMemoryAgentRepository();
    const principalId = 'usr_delete_recycle_test';
    const quotaLimit = 2;

    const agent1 = makeAgentDef(principalId, 'Agent 1');
    const agent2 = makeAgentDef(principalId, 'Agent 2');
    const agent3 = makeAgentDef(principalId, 'Agent 3');

    await repo.createAgentWithQuota(agent1, principalId, quotaLimit);
    await repo.createAgentWithQuota(agent2, principalId, quotaLimit);

    // 3rd attempt must fail
    await assert.rejects(
      repo.createAgentWithQuota(agent3, principalId, quotaLimit),
      /Maximum agent limit \(2\) reached/
    );

    // Delete agent 1
    const deleted = await repo.deleteAgent(agent1.id, principalId);
    assert.equal(deleted, true);

    // 3rd attempt now succeeds
    await assert.doesNotReject(
      repo.createAgentWithQuota(agent3, principalId, quotaLimit)
    );

    const remaining = await repo.listAgents(principalId);
    assert.equal(remaining.length, quotaLimit);
    assert.ok(remaining.some(a => a.id === agent3.id));
    assert.ok(!remaining.some(a => a.id === agent1.id));
  });
});
