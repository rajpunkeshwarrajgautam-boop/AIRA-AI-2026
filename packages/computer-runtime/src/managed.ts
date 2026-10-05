import { ComputerRuntime as LocalComputerProvider, type BrowserView, type ComputerFileEntry, type ComputerStatus } from './index.js';
import { DockerComputerProvider } from './docker.js';
import { ComputerLeaseManager, type ComputerLease, type LeaseAcquisition } from './lease.js';
import type { BrowserActionResult, ComputerProvider, ComputerProviderKind, TerminalExecutionResult } from './provider.js';
import type { Run, ToolCall, ToolDefinition, ToolResult } from '../../contracts/src/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { DurableComputerLeaseManager } from './durable.js';
import { computerActions } from './actions.js';
import { currentComputerAction, withComputerAction } from './action-context.js';
import { executionLeaseFor } from '../../agent-runtime/src/repositories.js';
import type { DurableComputerLease } from './distributed.js';

export interface ManagedComputerStatus extends ComputerStatus {
  provider: { kind: ComputerProviderKind; isolation: 'host-process' | 'docker-container' };
  lease?: Omit<ComputerLease, 'token' | 'ownerId'>;
  humanControl: boolean;
}

export interface ComputerEvent {
  sequence: number;
  type: 'computer.started' | 'computer.stopped' | 'browser.opened' | 'browser.acted' | 'file.read' | 'file.written' | 'terminal.executed' | 'control.taken' | 'control.released' | 'lease.blocked';
  timestamp: number;
  ownerId: string;
  botId: string;
  data: Record<string, unknown>;
}

const MAX_EVENTS = 500;
function toolResult(call: ToolCall, startedAt: number, output: unknown, error?: string): ToolResult {
  return { toolCallId: call.id, output: error ? null : output, error, isError: Boolean(error), durationMs: Date.now() - startedAt, timestamp: Date.now() };
}

export class ManagedComputerRuntime {
  private readonly eventsByOwner = new Map<string, ComputerEvent[]>();
  private readonly sequenceByOwner = new Map<string, number>();

  constructor(readonly provider: ComputerProvider, readonly leases: ComputerLeaseManager | DurableComputerLeaseManager = new DurableComputerLeaseManager()) {}

  get coordinator() { return this.leases instanceof DurableComputerLeaseManager ? this.leases.coordinator : undefined; }

  async withHuman<T>(ownerId: string, botId: string, token: string, key: string, execute: () => T): Promise<Awaited<T>> {
    const lease = await this.leases.assertHuman(ownerId, token);
    if (lease.botId !== botId) throw new Error('COMPUTER_LEASE_LOST');
    const actionId = createHash('sha256').update(ownerId + '\0' + botId + '\0' + key).digest('hex');
    return await withComputerAction({ lease: lease as DurableComputerLease, actionId }, execute);
  }

  private async operate<T>(ownerId: string, botId: string, operation: string, args: unknown, execute: () => Promise<T>): Promise<T> {
    if (!this.coordinator) return execute();
    let context = currentComputerAction();
    const temporary = !context;
    if (!context) {
      const lease = await this.coordinator.acquireComputerLease({
        ownerId, botId, holderId: 'control:' + randomUUID(), mode: 'BOT', ttlMs: 180000
      });
      context = { lease, actionId: createHash('sha256').update(randomUUID()).digest('hex') };
    }
    try { return await withComputerAction(context, () => computerActions.execute(ownerId, botId, this.providerKind, operation, args, execute)); }
    finally { if (temporary) await this.coordinator.releaseComputerLease(ownerId, context.lease.token, context.lease.fence).catch(() => false); }
  }

  async reconcileState(ownerId: string, state: 'RUNNING' | 'STOPPED' | 'SUSPENDED') {
    await this.operate(ownerId, '__reconciler__', 'lifecycle.' + state, {}, async () => {
      if (state === 'RUNNING') {
        const result = await this.provider.start(ownerId, '__reconciler__');
        if (result.state !== 'RUNNING') throw new Error(result.lastError || 'Computer did not reach RUNNING.');
        return result;
      }
      if (state === 'SUSPENDED' && this.provider instanceof DockerComputerProvider) {
        await this.provider.suspend(ownerId);
        return;
      }
      const result = await this.provider.stop(ownerId, '__reconciler__');
      if (result.state !== 'STOPPED') throw new Error(result.lastError || 'Computer did not reach STOPPED.');
      return result;
    });
  }

  get enabled(): boolean { return this.provider.enabled; }
  get terminalEnabled(): boolean { return this.provider.terminalEnabled; }
  get allowedPrograms(): string[] { return this.provider.allowedPrograms; }
  get providerKind(): ComputerProviderKind { return this.provider.kind || 'local'; }

  toolDefinitions(): ToolDefinition[] {
    if (!this.enabled) return [];
    const definitions: ToolDefinition[] = [
      { id: 'tool_browser_open', name: 'browser_open', source: 'local-runner', executionRuntime: 'LOCAL', permissionLevel: 'READ', idempotencyClass: 'SAFE_READ', description: 'Open a public HTTP(S) page in the persistent computer browser.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
      { id: 'tool_file_read', name: 'file_read', source: 'local-runner', executionRuntime: 'LOCAL', permissionLevel: 'READ', idempotencyClass: 'SAFE_READ', description: 'Read a UTF-8 file from the bot workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { id: 'tool_file_write', name: 'file_write', source: 'local-runner', executionRuntime: 'LOCAL', permissionLevel: 'WRITE', idempotencyClass: 'IDEMPOTENT_WRITE', description: 'Write a UTF-8 file to the bot workspace.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }
    ];
    if (this.provider.click) definitions.push({ id: 'tool_browser_click', name: 'browser_click', source: 'local-runner', executionRuntime: 'LOCAL', permissionLevel: 'WRITE', idempotencyClass: 'NON_IDEMPOTENT', description: 'Click the first element matching a CSS selector in the persistent browser.', parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } });
    if (this.provider.type) definitions.push({ id: 'tool_browser_type', name: 'browser_type', source: 'local-runner', executionRuntime: 'LOCAL', permissionLevel: 'WRITE', idempotencyClass: 'NON_IDEMPOTENT', description: 'Fill the first element matching a CSS selector. Can optionally press Enter.', parameters: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['selector', 'text'] } });
    if (this.provider.scroll) definitions.push({ id: 'tool_browser_scroll', name: 'browser_scroll', source: 'local-runner', executionRuntime: 'LOCAL', permissionLevel: 'READ', idempotencyClass: 'SAFE_READ', description: 'Scroll the current browser viewport vertically.', parameters: { type: 'object', properties: { deltaY: { type: 'number' } }, required: ['deltaY'] } });
    if (this.provider.waitFor) definitions.push({ id: 'tool_browser_wait', name: 'browser_wait', source: 'local-runner', executionRuntime: 'LOCAL', permissionLevel: 'READ', idempotencyClass: 'SAFE_READ', description: 'Wait for a CSS selector to become visible in the current page.', parameters: { type: 'object', properties: { selector: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['selector'] } });
    if (this.terminalEnabled) definitions.push({ id: 'tool_terminal_exec', name: 'terminal_exec', source: 'local-runner', executionRuntime: 'LOCAL', permissionLevel: 'DESTRUCTIVE', idempotencyClass: 'NON_IDEMPOTENT', description: `Execute one allowlisted program directly in the bot workspace: ${this.allowedPrograms.join(', ')}.`, parameters: { type: 'object', properties: { program: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'number' } }, required: ['program'] } });
    return definitions;
  }

  getDefinition(name: string): ToolDefinition | undefined { return this.toolDefinitions().find(definition => definition.name === name); }

  private async emit(ownerId: string, botId: string, type: ComputerEvent['type'], data: Record<string, unknown> = {}) {
    if (this.coordinator) return this.coordinator.appendComputerEvent(ownerId, botId, type, data);
    const sequence = (this.sequenceByOwner.get(ownerId) || 0) + 1;
    this.sequenceByOwner.set(ownerId, sequence);
    const event: ComputerEvent = { sequence, type, timestamp: Date.now(), ownerId, botId, data };
    const events = [...(this.eventsByOwner.get(ownerId) || []), event].slice(-MAX_EVENTS);
    this.eventsByOwner.set(ownerId, events);
    return event;
  }

  async events(ownerId: string, botId: string, after = 0) {
    if (this.coordinator) return this.coordinator.computerEvents(ownerId, botId, after);
    return (this.eventsByOwner.get(ownerId) || []).filter(event => event.botId === botId && event.sequence > after);
  }

  async status(ownerId: string, botId: string): Promise<ManagedComputerStatus> {
    const base = await this.provider.status(ownerId, botId);
    const lease = await this.leases.current(ownerId);
    return {
      ...base,
      provider: { kind: this.providerKind, isolation: this.providerKind === 'docker' ? 'docker-container' : 'host-process' },
      lease: lease ? { botId: lease.botId, holderId: lease.holderId, mode: lease.mode, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt } : undefined,
      humanControl: lease?.mode === 'HUMAN'
    };
  }

  async start(ownerId: string, botId: string): Promise<ManagedComputerStatus> {
    const result = await this.operate(ownerId, botId, 'computer.started', {}, async () => {
      const generation = await this.coordinator?.setComputerDesiredState(ownerId, this.providerKind, 'RUNNING');
      const result = await this.provider.start(ownerId, botId);
      if (generation) await this.coordinator!.recordComputerObservation(ownerId, generation, result.state === 'RUNNING' ? 'RUNNING' : 'ERROR', undefined, result.lastError);
      return result;
    });
    await this.emit(ownerId, botId, 'computer.started', { state: result.state, provider: this.providerKind }); return this.status(ownerId, botId);
  }
  async stop(ownerId: string, botId: string): Promise<ManagedComputerStatus> {
    const result = await this.operate(ownerId, botId, 'computer.stopped', {}, async () => {
      const generation = await this.coordinator?.setComputerDesiredState(ownerId, this.providerKind, 'STOPPED');
      const result = await this.provider.stop(ownerId, botId);
      if (generation) await this.coordinator!.recordComputerObservation(ownerId, generation, result.state === 'STOPPED' ? 'STOPPED' : 'ERROR', undefined, result.lastError);
      return result;
    });
    await this.emit(ownerId, botId, 'computer.stopped', { state: result.state }); return this.status(ownerId, botId);
  }
  async suspend(ownerId: string, botId: string): Promise<ManagedComputerStatus> {
    await this.operate(ownerId, botId, 'computer.suspended', {}, async () => {
      const generation = await this.coordinator?.setComputerDesiredState(ownerId, this.providerKind, 'SUSPENDED');
      if (this.provider instanceof DockerComputerProvider) await this.provider.suspend(ownerId); else await this.provider.stop(ownerId, botId);
      if (generation) await this.coordinator!.recordComputerObservation(ownerId, generation, 'SUSPENDED');
    });
    await this.emit(ownerId, botId, 'computer.stopped', { suspended: true }); return this.status(ownerId, botId);
  }

  async takeover(ownerId: string, botId: string, sessionId: string): Promise<LeaseAcquisition> {
    const acquisition = await this.leases.takeover(ownerId, botId, sessionId);
    await this.emit(ownerId, botId, 'control.taken', { holderId: acquisition.lease.holderId, preemptedHolderId: acquisition.preempted?.holderId });
    return acquisition;
  }
  async releaseHuman(ownerId: string, botId: string, token: string): Promise<ComputerLease | undefined> {
    const current = await this.leases.current(ownerId);
    if (current?.botId !== botId || current.mode !== 'HUMAN') return undefined;
    const released = await this.leases.release(ownerId, token);
    if (released) await this.emit(ownerId, botId, 'control.released', { holderId: released.holderId });
    return released;
  }
  async assertHuman(ownerId: string, token: string): Promise<ComputerLease> { return this.leases.assertHuman(ownerId, token); }
  async releaseRun(ownerId: string, runId: string) { return this.leases.releaseRun(ownerId, runId); }

  async open(ownerId: string, botId: string, url: string): Promise<BrowserView> { const value = await this.operate(ownerId, botId, 'browser.opened', { url }, () => this.provider.open(ownerId, botId, url)); await this.emit(ownerId, botId, 'browser.opened', { url: value.url, title: value.title }); return value; }
  async click(ownerId: string, botId: string, selector: string): Promise<BrowserActionResult> { if (!this.provider.click) throw new Error('This computer provider does not support interactive browser clicks.'); const value = await this.operate(ownerId, botId, 'browser.click', { selector }, () => this.provider.click!(ownerId, botId, selector)); await this.emit(ownerId, botId, 'browser.acted', { action: 'click', selector, url: value.url }); return value; }
  async type(ownerId: string, botId: string, selector: string, text: string, submit = false): Promise<BrowserActionResult> { if (!this.provider.type) throw new Error('This computer provider does not support browser typing.'); const value = await this.operate(ownerId, botId, 'browser.type', { selector, text, submit }, () => this.provider.type!(ownerId, botId, selector, text, submit)); await this.emit(ownerId, botId, 'browser.acted', { action: 'type', selector, submit, url: value.url }); return value; }
  async scroll(ownerId: string, botId: string, deltaY: number): Promise<BrowserActionResult> { if (!this.provider.scroll) throw new Error('This computer provider does not support browser scrolling.'); const value = await this.operate(ownerId, botId, 'browser.scroll', { deltaY }, () => this.provider.scroll!(ownerId, botId, deltaY)); await this.emit(ownerId, botId, 'browser.acted', { action: 'scroll', deltaY, url: value.url }); return value; }
  async waitFor(ownerId: string, botId: string, selector: string, timeoutMs = 5000): Promise<BrowserActionResult> { if (!this.provider.waitFor) throw new Error('This computer provider does not support browser waits.'); const value = await this.operate(ownerId, botId, 'browser.wait', { selector, timeoutMs }, () => this.provider.waitFor!(ownerId, botId, selector, timeoutMs)); await this.emit(ownerId, botId, 'browser.acted', { action: 'wait', selector, url: value.url }); return value; }
  async screenshot(ownerId: string, botId: string): Promise<BrowserActionResult> { if (!this.provider.screenshot) throw new Error('This computer provider does not support browser screenshots.'); const value = await this.operate(ownerId, botId, 'browser.screenshot', {}, () => this.provider.screenshot!(ownerId, botId)); await this.emit(ownerId, botId, 'browser.acted', { action: 'screenshot', url: value.url }); return value; }
  async listFiles(ownerId: string, botId: string): Promise<ComputerFileEntry[]> { return this.provider.listFiles(ownerId, botId); }
  async readText(ownerId: string, botId: string, relativePath: string) { const value = await this.provider.readText(ownerId, botId, relativePath); await this.emit(ownerId, botId, 'file.read', { path: relativePath, sizeBytes: value.sizeBytes }); return value; }
  async writeText(ownerId: string, botId: string, relativePath: string, content: string) { const value = await this.operate(ownerId, botId, 'file.written', { relativePath, content }, () => this.provider.writeText(ownerId, botId, relativePath, content)); await this.emit(ownerId, botId, 'file.written', { path: relativePath, sizeBytes: value.sizeBytes }); return value; }
  async terminal(ownerId: string, botId: string, program: string, args: string[] = [], timeoutMs = 20_000): Promise<TerminalExecutionResult> { const value = await this.operate(ownerId, botId, 'terminal.executed', { program, args, timeoutMs }, () => this.provider.terminal(ownerId, botId, program, args, timeoutMs)); await this.emit(ownerId, botId, 'terminal.executed', { program: value.program, exitCode: value.exitCode }); return value; }

  async execute(run: Run, call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now();
    if (!run.agentId) return toolResult(call, startedAt, null, 'Computer tools require a bot-owned run.');
    const botId = run.agentId;
    let lease: ComputerLease;
    try { lease = await this.leases.acquireBot(run.principalId, run.agentId, run.id); }
    catch (err) {
      const code = (err as Error).message;
      await this.emit(run.principalId, run.agentId, 'lease.blocked', { runId: run.id, code });
      return toolResult(call, startedAt, null, code);
    }
    try {
      return await withComputerAction({
        lease: lease as DurableComputerLease,
        actionId: createHash('sha256').update(run.principalId + '\0' + run.id + '\0' + call.id).digest('hex'),
        runId: run.id, execution: executionLeaseFor(run.id)
      }, async () => { switch (call.name) {
        case 'browser_open': return toolResult(call, startedAt, await this.open(run.principalId, botId, String(call.arguments.url || '')));
        case 'browser_click': return toolResult(call, startedAt, await this.click(run.principalId, botId, String(call.arguments.selector || '')));
        case 'browser_type': return toolResult(call, startedAt, await this.type(run.principalId, botId, String(call.arguments.selector || ''), String(call.arguments.text ?? ''), call.arguments.submit === true));
        case 'browser_scroll': return toolResult(call, startedAt, await this.scroll(run.principalId, botId, Number(call.arguments.deltaY) || 0));
        case 'browser_wait': return toolResult(call, startedAt, await this.waitFor(run.principalId, botId, String(call.arguments.selector || ''), Number(call.arguments.timeoutMs) || 5000));
        case 'file_read': return toolResult(call, startedAt, await this.readText(run.principalId, botId, String(call.arguments.path || '')));
        case 'file_write': return toolResult(call, startedAt, await this.writeText(run.principalId, botId, String(call.arguments.path || ''), String(call.arguments.content ?? '')));
        case 'terminal_exec': return toolResult(call, startedAt, await this.terminal(run.principalId, botId, String(call.arguments.program || ''), Array.isArray(call.arguments.args) ? call.arguments.args.map(String) : [], Number(call.arguments.timeoutMs) || 20_000));
        default: return toolResult(call, startedAt, null, `Computer tool "${call.name}" is not registered.`);
      } });
    } catch (err) { return toolResult(call, startedAt, null, (err as Error).message); }
  }
}

function createProvider(): ComputerProvider {
  const requested = (process.env.AIRA_COMPUTER_PROVIDER || 'local').toLowerCase();
  if (process.env.NODE_ENV === 'production' && requested === 'local') throw new Error('Distributed production computer execution requires the Docker runner provider.');
  if (requested === 'docker') return new DockerComputerProvider();
  if (requested !== 'local') throw new Error(`Unknown AIRA_COMPUTER_PROVIDER: ${requested}`);
  return new LocalComputerProvider();
}

export const computerRuntime = new ManagedComputerRuntime(createProvider());
