import { PostgresRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { db } from '../packages/db/src/index.js';
import { randomUUID } from 'crypto';
import * as fs from 'fs';

async function main() {
  const repo = new PostgresRunRepository();
  
  // Create a long document dynamically (e.g. read package-lock.json which is long)
  const packageLock = fs.readFileSync('./package-lock.json', 'utf8');
  
  // Construct the scenario prompt
  const longPrompt = packageLock + '\n\nKeep all this but remove the word ChatGPT from it.';
  
  const runId = randomUUID();
  try {
    console.log(`Testing scenario with prompt length: ${longPrompt.length} chars`);
    
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
    
    console.log('SUCCESS: Scenario prompt stored and retrieved without truncation.');
  } catch (err: any) {
    console.error('ERROR in scenario test:', err.message);
    throw err;
  } finally {
    await db.destroy();
  }
}

main();
