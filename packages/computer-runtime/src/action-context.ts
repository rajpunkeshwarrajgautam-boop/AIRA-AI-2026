import { AsyncLocalStorage } from 'node:async_hooks';
import type { DurableComputerLease } from './distributed.js';
import type { RunExecutionLease } from '../../agent-runtime/src/repositories.js';

export interface ComputerActionContext {
  lease: DurableComputerLease;
  actionId: string;
  runId?: string;
  execution?: RunExecutionLease;
}
const actions = new AsyncLocalStorage<ComputerActionContext>();
export const currentComputerAction = () => actions.getStore();
export function withComputerAction<T>(context: ComputerActionContext, execute: () => T): T {
  return actions.run(context, execute);
}
