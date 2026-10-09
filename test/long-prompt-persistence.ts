import { PostgresRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { db } from '../packages/db/src/index.js';
import { randomUUID } from 'crypto';

async function testPromptLength(sizeBytes: number) {
  const repo = new PostgresRunRepository();
  const longPrompt = 'A'.repeat(sizeBytes);
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
    
    const retrieved = await repo.getRun(runId);
    
    if (!retrieved) {
      throw new Error(`Run ${runId} not found after save`);
    }
    
    if (retrieved.prompt.length !== longPrompt.length) {
      throw new Error(`Length mismatch: saved ${longPrompt.length}, retrieved ${retrieved.prompt.length}`);
    }
    
    console.log(`SUCCESS: ${sizeBytes / 1024} KB prompt stored and retrieved without truncation.`);
  } catch (err: any) {
    console.error(`ERROR for ${sizeBytes / 1024} KB prompt:`, err.message);
    throw err;
  }
}

async function main() {
  try {
    console.log('Testing 1 KB prompt...');
    await testPromptLength(1024);
    
    console.log('Testing 10 KB prompt...');
    await testPromptLength(10 * 1024);
    
    console.log('All tests passed.');
  } finally {
    await db.destroy();
  }
}

main();
