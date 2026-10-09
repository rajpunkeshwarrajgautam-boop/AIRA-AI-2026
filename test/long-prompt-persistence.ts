import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { db, runMigrations, closeDb } from '../packages/db/src/index.js';

async function main() {
  await runMigrations();
  const repo = new PostgresRunRepository();

  for (const chars of [300, 1024, 10_240]) {
    const id = `long_prompt_ci_${randomUUID()}`;
    const prompt = 'A'.repeat(chars);
    const now = Date.now();
    try {
      await repo.saveRun({
        id,
        principalId: 'ci-long-prompt-test',
        principalScopes: [],
        sessionId: 'ci-session',
        intent: 'chat',
        state: 'RUNNING',
        modelPolicy: {},
        prompt,
        systemPrompt: '',
        content: '',
        thinking: '',
        toolsUsed: [],
        toolCalls: [],
        toolResults: [],
        artifacts: [],
        citations: [],
        stepCount: 0,
        maxSteps: 10,
        createdAt: now,
        updatedAt: now
      } as any);
      const stored = await repo.getRun(id);
      assert.equal(stored?.prompt, prompt, `${chars}-character prompt must round trip without truncation`);
    } finally {
      await db('runs').where({ id }).delete();
    }
  }
  console.log('PASS: 300, 1024 and 10240-character prompts persist without truncation');
}

main()
  .finally(() => closeDb())
  .catch(error => { console.error('LONG-PROMPT DURABILITY CERTIFICATION FAILED', error); process.exitCode = 1; });
