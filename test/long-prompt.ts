import { PostgresRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { db } from '../packages/db/src/index.js';
import { randomUUID } from 'crypto';

async function main() {
  const repo = new PostgresRunRepository();
  const longPrompt = 'A'.repeat(300);
  
  const runId = randomUUID();
  try {
    await repo.saveRun({
      id: runId,
      principalId: 'test-principal',
      principalScopes: [],
      sessionId: 'test-session',
      intent: 'chat',
      state: 'RUNNING',
      modelPolicy: {},
      prompt: longPrompt,
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
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as any);
    
    console.log('SUCCESS');
  } catch (err: any) {
    console.error('ERROR:', err.message);
  } finally {
    await db.destroy();
  }
}

main();
