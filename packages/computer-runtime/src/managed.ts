import { ComputerRuntime as LocalComputerProvider, type BrowserView, type ComputerFileEntry, type ComputerStatus } from './index.js';
import { DockerComputerProvider } from './docker.js';
import { ComputerLeaseManager, type ComputerLease, type ComputerLeaseView, type LeaseAcquisition } from './lease.js';
import { ComputerEventRepository, type ComputerEvent, type ComputerEventType } from './events.js';
import { ComputerInstanceRepository } from './lifecycle.js';
import type { BrowserActionResult, ComputerProvider, ComputerProviderKind, TerminalExecutionResult } from './provider.js';
import type { Run, ToolCall, ToolDefinition, ToolResult } from '../../contracts/src/index.js';

export interface ManagedComputerStatus extends ComputerStatus {
  provider: { kind: ComputerProviderKind; isolation: 'host-process' | 'docker-container' };
  lease?: Omit<ComputerLeaseView, 'ownerId'>;
  humanControl: boolean;
}

export interface ManagedComputerHealth {
  ok: boolean;
  provider: { kind: ComputerProviderKind; ok: boolean; detail: string };
  lifecycle: { tracked: number; unhealthy: number };
}

function toolResult(call: ToolCall, startedAt: number, output: unknown, error?: string): ToolResult {
  return { toolCallId: call.id, output: error ? null : output, error, isError: Boolean(error), durationMs: Date.now() - startedAt, timestamp: Date.now() };
}

export class ManagedComputerRuntime {
  constructor(
    readonly provider: ComputerProvider,
    readonly leases = new ComputerLeaseManager(),
    readonly eventRepository = new ComputerEventRepository(),
    readonly instances = new ComputerInstanceRepository()
  ) {}

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

  private emit(ownerId: string, botId: string, type: ComputerEventType, data: Record<string, unknown> = {}): Promise<ComputerEvent> {
    return this.eventRepository.append(ownerId, botId, type, data);
  }

  events(ownerId: string, botId: string, after = 0): Promise<ComputerEvent[]> {
    return this.eventRepository.list(ownerId, botId, after);
  }

  private resourceName(ownerId: string): string | undefined {
    return this.provider.resourceName?.(ownerId);
  }

  private async markActive(ownerId: string): Promise<void> {
    if (this.providerKind !== 'docker') return;
    await this.instances.setDesired(ownerId, this.providerKind, 'ACTIVE', this.resourceName(ownerId));
  }

  private async markProviderError(ownerId: string, error: unknown): Promise<void> {
    if (this.providerKind !== 'docker') return;
    await this.instances.observe(ownerId, 'ERROR', (error as Error).message).catch(() => undefined);
  }

  async status(ownerId: string, botId: string): Promise<ManagedComputerStatus> {
    const base = await this.provider.status(ownerId, botId);
    const lease = await this.leases.current(ownerId);
    return {
      ...base,
      provider: { kind: this.providerKind, isolation: this.providerKind === 'docker' ? 'docker-container' : 'host-process' },
      lease: lease ? { botId: lease.botId, holderId: lease.holderId, mode: lease.mode, fence: lease.fence, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt } : undefined,
      humanControl: lease?.mode === 'HUMAN'
    };
  }

  async start(ownerId: string, botId: string): Promise<ManagedComputerStatus> {
    await this.markActive(ownerId);
    try {
      const result = await this.provider.start(ownerId, botId);
      if (this.providerKind === 'docker') await this.instances.observe(ownerId, 'RUNNING');
      await this.emit(ownerId, botId, 'computer.started', { state: result.state, provider: this.providerKind });
      return this.status(ownerId, botId);
    } catch (error) { await this.markProviderError(ownerId, error); throw error; }
  }

  async stop(ownerId: string, botId: string): Promise<ManagedComputerStatus> {
    try {
      const result = await this.provider.stop(ownerId, botId);
      if (this.providerKind === 'docker') await this.instances.observe(ownerId, 'RUNNING');
      await this.emit(ownerId, botId, 'computer.stopped', { state: result.state, browserOnly: this.providerKind === 'docker' });
      return this.status(ownerId, botId);
    } catch (error) { await this.markProviderError(ownerId, error); throw error; }
  }

  async suspend(ownerId: string, botId: string): Promise<ManagedComputerStatus> {
    if (this.providerKind === 'docker') await this.instances.setDesired(ownerId, this.providerKind, 'SUSPENDED', this.resourceName(ownerId));
    try {
      if (this.provider instanceof DockerComputerProvider) await this.provider.suspend(ownerId); else await this.provider.stop(ownerId, botId);
      if (this.providerKind === 'docker') await this.instances.observe(ownerId, 'STOPPED');
      await this.emit(ownerId, botId, 'computer.stopped', { suspended: true });
      return this.status(ownerId, botId);
    } catch (error) { await this.markProviderError(ownerId, error); throw error; }
  }

  async takeover(ownerId: string, botId: string, sessionId: string): Promise<LeaseAcquisition> {
    const acquisition = await this.leases.takeover(ownerId, botId, sessionId);
    await this.emit(ownerId, botId, 'control.taken', { holderId: acquisition.lease.holderId, fence: acquisition.lease.fence, preemptedHolderId: acquisition.preempted?.holderId });
    return acquisition;
  }

  async releaseHuman(ownerId: string, botId: string, token: string): Promise<ComputerLeaseView | undefined> {
    const released = await this.leases.release(ownerId, token);
    if (released) await this.emit(ownerId, botId, 'control.released', { holderId: released.holderId, fence: released.fence });
    return released;
  }

  assertHuman(ownerId: string, token: string): Promise<ComputerLease> { return this.leases.assertHuman(ownerId, token); }
  async releaseRun(ownerId: string, runId: string): Promise<void> { await this.leases.releaseRun(ownerId, runId); }

  async open(ownerId: string, botId: string, url: string): Promise<BrowserView> {
    await this.markActive(ownerId);
    try { const value = await this.provider.open(ownerId, botId, url); if (this.providerKind === 'docker') await this.instances.observe(ownerId, 'RUNNING'); await this.emit(ownerId, botId, 'browser.opened', { url: value.url, title: value.title }); return value; }
    catch (error) { await this.markProviderError(ownerId, error); throw error; }
  }
  async click(ownerId: string, botId: string, selector: string): Promise<BrowserActionResult> {
    if (!this.provider.click) throw new Error('This computer provider does not support interactive browser clicks.');
    await this.markActive(ownerId);
    try { const value = await this.provider.click(ownerId, botId, selector); if (this.providerKind === 'docker') await this.instances.observe(ownerId, 'RUNNING'); await this.emit(ownerId, botId, 'browser.acted', { action: 'click', selector, url: value.url }); return value; }
    catch (error) { await this.markProviderError(ownerId, error); throw error; }
  }
  async type(ownerId: string, botId: string, selector: string, text: string, submit = false): Promise<BrowserActionResult> {
    if (!this.provider.type) throw new Error('This computer provider does not support browser typing.');
    await this.markActive(ownerId);
    try { const value = await this.provider.type(ownerId, botId, selector, text, submit); if (this.providerKind === 'docker') await this.instances.observe(ownerId, 'RUNNING'); await this.emit(ownerId, botId, 'browser.acted', { action: 'type', selector, submit, url: value.url }); return value; }
    catch (error) { await this.markProviderError(ownerId, error); throw error; }
  }
  async scroll(ownerId: string, botId: string, deltaY: number): Promise<BrowserActionResult> {
    if (!this.provider.scroll) throw new Error('This computer provider does not support browser scrolling.');
    await this.markActive(ownerId);
    try { const value = await this.provider.scroll(ownerId, botId, deltaY); if (this.providerKind === 'docker') await this.instances.observe(ownerId, 'RUNNING'); await this.emit(ownerId, botId, 'browser.acted', { action: 'scroll', deltaY, url: value.url }); return value; }
    catch (error) { await this.markProviderError(ownerId, error); throw error; }
  }
  async waitFor(ownerId: string, botId: string, selector: string, timeoutMs = 5000): Promise<BrowserActionResult> {
    if (!this.provider.waitFor) throw new Error('This computer provider does not support browser waits.');
    await this.markActive(ownerId);
    try { const value = await this.provider.waitFor(ownerId, botId, selector, timeoutMs); if (this.providerKind === 'docker') await this.instances.observe(ownerId, 'RUNNING'); await this.emit(ownerId, botId, 'browser.acted', { action: 'wait', selector, url: value.url }); return value; }
    catch (error) { await this.markProviderError(ownerId, error); throw error; }
  }
  async screenshot(ownerId: string, botId: string): Promise<BrowserActionResult> {
    if (!this.provider.screenshot) throw new Error('This computer provider does not support browser screenshots.');
    await this.markActive(ownerId);
    try { const value = await this.provider.screenshot(ownerId, botId); if (this.providerKind === 'docker') await this.instances.observe(ownerId, 'RUNNING'); await this.emit(ownerId, botId, 'browser.acted', { action: 'screenshot', url: value.url }); return value; }
    catch (error) { await this.markProviderError(ownerId, error); throw error; }
  }
  async listFiles(ownerId: string, botId: string): Promise<ComputerFileEntry[]> {
    await this.markActive(ownerId);
    try { const value = await this.provider.listFiles(ownerId, botId); if (this.providerKind === 'docker') await this.instances.observe(ownerId, 'RUNNING'); return value; }
    catch (error) { await this.markProviderError(ownerId, error); throw error; }
  }
  async readText(ownerId: string, botId: string, relativePath: string) {
    await this.markActive(ownerId);
    try { const value = await this.provider.readText(ownerId, botId, relativePath); if (this.providerKind === 'docker') await this.instances.observe(ownerId, 'RUNNING'); await this.emit(ownerId, botId, 'file.read', { path: relativePath, sizeBytes: value.sizeBytes }); return value; }
    catch (error) { await this.markProviderError(ownerId, error); throw error; }
  }
  async writeText(ownerId: string, botId: string, relativePath: string, content: string) {
    await this.markActive(ownerId);
    try { const value = await this.provider.writeText(ownerId, botId, relativePath, content); if (this.providerKind === 'docker') await this.instances.observe(ownerId, 'RUNNING'); await this.emit(ownerId, botId, 'file.written', { path: relativePath, sizeBytes: value.sizeBytes }); return value; }
    catch (error) { await this.markProviderError(ownerId, error); throw error; }
  }
  async terminal(ownerId: string, botId: string, program: string, args: string[] = [], timeoutMs = 20_000): Promise<TerminalExecutionResult> {
    await this.markActive(ownerId);
    try { const value = await this.provider.terminal(ownerId, botId, program, args, timeoutMs); if (this.providerKind === 'docker') await this.instances.observe(ownerId, 'RUNNING'); await this.emit(ownerId, botId, 'terminal.executed', { program: value.program, exitCode: value.exitCode }); return value; }
    catch (error) { await this.markProviderError(ownerId, error); throw error; }
  }

  async reconcileAll(): Promise<{ checked: number; recovered: number; failed: number }> {
    if (this.providerKind !== 'docker') return { checked: 0, recovered: 0, failed: 0 };
    const records = await this.instances.list(this.providerKind);
    let recovered = 0;
    let failed = 0;
    for (const record of records) {
      if (!this.provider.reconcile) { failed++; await this.instances.observe(record.ownerId, 'ERROR', 'Computer provider does not implement reconciliation.'); continue; }
      const result = await this.provider.reconcile(record.ownerId, record.desiredState);
      await this.instances.observe(record.ownerId, result.observedState, result.error);
      if (result.recovered) recovered++;
      if (result.observedState === 'ERROR') failed++;
    }
    return { checked: records.length, recovered, failed };
  }

  async health(): Promise<ManagedComputerHealth> {
    const providerHealth = this.provider.health ? await this.provider.health() : { ok: true, detail: `${this.providerKind} provider is available.` };
    const tracked = this.providerKind === 'docker' ? (await this.instances.list(this.providerKind)).length : 0;
    const unhealthy = this.providerKind === 'docker' ? (await this.instances.unhealthy(this.providerKind)).length : 0;
    return { ok: providerHealth.ok && unhealthy === 0, provider: { kind: this.providerKind, ok: providerHealth.ok, detail: providerHealth.detail }, lifecycle: { tracked, unhealthy } };
  }

  async execute(run: Run, call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now();
    if (!run.agentId) return toolResult(call, startedAt, null, 'Computer tools require a bot-owned run.');
    try { await this.leases.acquireBot(run.principalId, run.agentId, run.id); }
    catch (err) {
      const code = (err as Error).message;
      await this.emit(run.principalId, run.agentId, 'lease.blocked', { runId: run.id, code }).catch(() => undefined);
      return toolResult(call, startedAt, null, code);
    }
    try {
      switch (call.name) {
        case 'browser_open': return toolResult(call, startedAt, await this.open(run.principalId, run.agentId, String(call.arguments.url || '')));
        case 'browser_click': return toolResult(call, startedAt, await this.click(run.principalId, run.agentId, String(call.arguments.selector || '')));
        case 'browser_type': return toolResult(call, startedAt, await this.type(run.principalId, run.agentId, String(call.arguments.selector || ''), String(call.arguments.text ?? ''), call.arguments.submit === true));
        case 'browser_scroll': return toolResult(call, startedAt, await this.scroll(run.principalId, run.agentId, Number(call.arguments.deltaY) || 0));
        case 'browser_wait': return toolResult(call, startedAt, await this.waitFor(run.principalId, run.agentId, String(call.arguments.selector || ''), Number(call.arguments.timeoutMs) || 5000));
        case 'file_read': return toolResult(call, startedAt, await this.readText(run.principalId, run.agentId, String(call.arguments.path || '')));
        case 'file_write': return toolResult(call, startedAt, await this.writeText(run.principalId, run.agentId, String(call.arguments.path || ''), String(call.arguments.content ?? '')));
        case 'terminal_exec': return toolResult(call, startedAt, await this.terminal(run.principalId, run.agentId, String(call.arguments.program || ''), Array.isArray(call.arguments.args) ? call.arguments.args.map(String) : [], Number(call.arguments.timeoutMs) || 20_000));
        default: return toolResult(call, startedAt, null, `Computer tool "${call.name}" is not registered.`);
      }
    } catch (err) { return toolResult(call, startedAt, null, (err as Error).message); }
  }
}

function createProvider(): ComputerProvider {
  const requested = (process.env.AIRA_COMPUTER_PROVIDER || 'local').toLowerCase();
  if (requested === 'docker') return new DockerComputerProvider();
  if (requested !== 'local') throw new Error(`Unknown AIRA_COMPUTER_PROVIDER: ${requested}`);
  return new LocalComputerProvider();
}

export const computerRuntime = new ManagedComputerRuntime(createProvider());
