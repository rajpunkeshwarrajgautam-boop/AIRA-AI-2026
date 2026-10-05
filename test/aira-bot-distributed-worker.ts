import { db, closeDb } from '../packages/db/src/index.js';
import { DistributedRuntimeCoordinator } from '../packages/computer-runtime/src/distributed.js';

// Separate OS process, database pool and deliberately skewed application clock.
Date.now = () => Number(process.env.AIRA_TEST_CLOCK || 0);
const coordinator = new DistributedRuntimeCoordinator(db);
process.on('message', async (message: { id: number; action: string; key: string; holder: string }) => {
  try {
    let value: unknown;
    switch (message.action) {
      case 'lease':
      case 'crash-lease':
        value = await coordinator.acquireComputerLease({
          ownerId: message.key, botId: 'bot', holderId: message.holder,
          mode: 'BOT', ttlMs: message.action === 'crash-lease' ? 750 : 60000
        });
        break;
      case 'scheduler':
        value = await coordinator.acquireSchedulerLease(message.key, message.holder, 60000);
        break;
      case 'desired':
        value = await coordinator.setComputerDesiredState(message.key, 'docker', 'RUNNING');
        break;
      case 'event':
        value = await coordinator.appendComputerEvent(message.key, 'bot', 'worker.event', { holder: message.holder });
        break;
      case 'crash-reconcile': {
        const row = await db('aira_computer_instances').where({ owner_id: message.key }).first();
        await coordinator.reconcileComputer(message.key, Number(row.generation), async () => {
          process.send?.({ id: message.id, value: { started: true } });
          await new Promise<void>(() => {});
        });
        return;
      }
      case 'outbox':
        value = await coordinator.claimOutbox(message.holder, 1);
        break;
      default: throw new Error('UNKNOWN_TEST_ACTION');
    }
    process.send?.({ id: message.id, value });
  } catch (error) { process.send?.({ id: message.id, error: (error as Error).message }); }
});
process.on('disconnect', () => { void closeDb().finally(() => process.exit(0)); });
process.send?.({ ready: true });
