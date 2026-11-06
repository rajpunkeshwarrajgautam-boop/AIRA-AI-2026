import { createHash, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { BrowserView, ComputerFileEntry, ComputerStatus } from './index.js';
import type { BrowserActionResult, ComputerProvider, TerminalExecutionResult } from './provider.js';

interface ExecResult { stdout: string; stderr: string; }
type DockerExecutor = (args: string[], timeoutMs?: number) => Promise<ExecResult>;
type RunnerFetcher = typeof fetch;

export interface DockerComputerProviderOptions {
  image?: string;
  terminalEnabled?: boolean;
  allowedPrograms?: string[];
  runnerSecret?: string;
  execute?: DockerExecutor;
  fetcher?: RunnerFetcher;
}

function shortHash(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}
function normalizeProgram(program: string): string {
  return path.basename(program).toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
}
function defaultExecute(args: string[], timeoutMs = 30_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error(String(stderr || error.message).trim() || 'Docker command failed.') as Error & { code?: string | number };
        wrapped.code = (error as NodeJS.ErrnoException).code;
        reject(wrapped);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export class DockerComputerProvider implements ComputerProvider {
  readonly kind = 'docker' as const;
  readonly enabled = true;
  readonly terminalEnabled: boolean;
  readonly allowedPrograms: string[];
  readonly image: string;
  private readonly secret: string;
  private readonly executeDocker: DockerExecutor;
  private readonly fetcher: RunnerFetcher;

  constructor(options: DockerComputerProviderOptions = {}) {
    this.image = options.image || process.env.AIRA_COMPUTER_DOCKER_IMAGE || 'aira-computer:local';
    this.terminalEnabled = options.terminalEnabled ?? process.env.AIRA_COMPUTER_TERMINAL_ENABLED !== 'false';
    const configured = options.allowedPrograms || process.env.AIRA_COMPUTER_PROGRAMS?.split(',').map(v => v.trim()).filter(Boolean) || ['node', 'npm', 'npx', 'python3', 'git'];
    this.allowedPrograms = Array.from(new Set(configured.map(normalizeProgram))).sort();
    this.secret = options.runnerSecret || process.env.AIRA_COMPUTER_RUNNER_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'aira-dev-runner-secret');
    if (!this.secret) throw new Error('AIRA_COMPUTER_RUNNER_SECRET is required for the Docker computer provider in production.');
    this.executeDocker = options.execute || defaultExecute;
    this.fetcher = options.fetcher || fetch;
  }

  ownerKey(ownerId: string): string { return shortHash(ownerId); }
  botKey(ownerId: string, botId: string): string { return shortHash(`${ownerId}\0${botId}`, 32); }
  containerName(ownerId: string): string { return `aira-computer-${this.ownerKey(ownerId)}`; }
  volumeName(ownerId: string): string { return `aira-computer-data-${this.ownerKey(ownerId)}`; }
  runnerToken(ownerId: string): string { return createHmac('sha256', this.secret).update(ownerId).digest('hex'); }

  private async inspectRunning(ownerId: string): Promise<boolean | undefined> {
    try {
      const result = await this.executeDocker(['inspect', '-f', '{{.State.Running}}', this.containerName(ownerId)], 10_000);
      return result.stdout.trim() === 'true';
    } catch (err) {
      const text = (err as Error).message.toLowerCase();
      if (text.includes('no such object') || text.includes('no such container')) return undefined;
      if ((err as Error & { code?: string }).code === 'ENOENT') throw new Error('Docker CLI is not installed or not available to the AIRA API host.');
      throw err;
    }
  }

  private async createContainer(ownerId: string): Promise<void> {
    const name = this.containerName(ownerId);
    const volume = this.volumeName(ownerId);
    const args = [
      'run', '-d', '--name', name,
      '--label', 'aira.computer=true', '--label', `aira.owner=${this.ownerKey(ownerId)}`,
      '--memory', process.env.AIRA_COMPUTER_MEMORY || '2g', '--cpus', process.env.AIRA_COMPUTER_CPUS || '2', '--pids-limit', process.env.AIRA_COMPUTER_PIDS || '256',
      '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL', '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=268435456', '--tmpfs', '/home/pwuser/.cache:rw,nosuid,size=134217728',
      '--mount', `type=volume,source=${volume},target=/data`,
      '--publish', '127.0.0.1::7777',
      '--env', `AIRA_RUNNER_TOKEN=${this.runnerToken(ownerId)}`,
      '--env', `AIRA_COMPUTER_PROGRAMS=${this.allowedPrograms.join(',')}`,
      this.image
    ];
    try { await this.executeDocker(args, 60_000); }
    catch (err) {
      throw new Error(`Could not create isolated computer container. Build ${this.image} first with: docker build -t ${this.image} docker/aira-computer. ${(err as Error).message}`);
    }
  }

  private async ensureContainer(ownerId: string): Promise<void> {
    const running = await this.inspectRunning(ownerId);
    if (running === undefined) await this.createContainer(ownerId);
    else if (!running) await this.executeDocker(['start', this.containerName(ownerId)], 30_000);
    await this.waitHealthy(ownerId);
  }

  private async runnerAddress(ownerId: string): Promise<string> {
    const result = await this.executeDocker(['port', this.containerName(ownerId), '7777/tcp'], 10_000);
    const line = result.stdout.split(/\r?\n/).map(v => v.trim()).find(Boolean);
    if (!line) throw new Error('Docker computer runner does not expose its control port.');
    const match = line.match(/(?:127\.0\.0\.1|0\.0\.0\.0|::1|\[::\]):(\d+)$/);
    if (!match) throw new Error('Docker computer runner port mapping is invalid.');
    return `http://127.0.0.1:${match[1]}`;
  }

  private async request<T>(ownerId: string, route: string, init: RequestInit = {}): Promise<T> {
    const address = await this.runnerAddress(ownerId);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.runnerToken(ownerId)}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    const response = await this.fetcher(address + route, { ...init, headers, signal: AbortSignal.timeout(35_000) });
    const body = await response.json().catch(() => ({ error: `Runner returned HTTP ${response.status}.` })) as any;
    if (!response.ok) throw new Error(body.error || `Runner returned HTTP ${response.status}.`);
    return body as T;
  }

  private async waitHealthy(ownerId: string): Promise<void> {
    let last = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await this.request(ownerId, '/health'); return; }
      catch (err) { last = (err as Error).message; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    throw new Error(`Isolated computer runner did not become healthy. ${last}`);
  }

  async status(ownerId: string, _botId: string): Promise<ComputerStatus> {
    const running = await this.inspectRunning(ownerId);
    if (!running) return {
      enabled: true, state: 'STOPPED', workspaceReady: running !== undefined,
      browser: { state: 'STOPPED' }, terminal: { enabled: this.terminalEnabled, allowedPrograms: this.allowedPrograms }
    };
    try {
      const runner = await this.request<any>(ownerId, '/status');
      return {
        enabled: true, state: runner.browser?.state === 'RUNNING' ? 'RUNNING' : 'STOPPED', workspaceReady: true,
        browser: runner.browser || { state: 'STOPPED' }, terminal: { enabled: this.terminalEnabled, allowedPrograms: this.allowedPrograms }
      };
    } catch (err) {
      return { enabled: true, state: 'ERROR', workspaceReady: true, browser: { state: 'STOPPED' }, terminal: { enabled: this.terminalEnabled, allowedPrograms: this.allowedPrograms }, lastError: (err as Error).message };
    }
  }

  async start(ownerId: string, botId: string): Promise<ComputerStatus> {
    await this.ensureContainer(ownerId);
    await this.request(ownerId, '/browser/start', { method: 'POST', body: '{}' });
    return this.status(ownerId, botId);
  }

  async stop(ownerId: string, botId: string): Promise<ComputerStatus> {
    const running = await this.inspectRunning(ownerId);
    if (running) await this.request(ownerId, '/browser/stop', { method: 'POST', body: '{}' }).catch(() => undefined);
    return this.status(ownerId, botId);
  }

  async suspend(ownerId: string): Promise<void> {
    if (await this.inspectRunning(ownerId)) await this.executeDocker(['stop', '--time', '10', this.containerName(ownerId)], 20_000);
  }

  async terminate(ownerId: string): Promise<void> {
    if (await this.inspectRunning(ownerId) !== undefined) await this.executeDocker(['rm', '-f', this.containerName(ownerId)], 20_000);
  }

  private body(ownerId: string, botId: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ botKey: this.botKey(ownerId, botId), ...extra });
  }

  async open(ownerId: string, botId: string, url: string): Promise<BrowserView> {
    await this.ensureContainer(ownerId);
    return this.request(ownerId, '/browser/open', { method: 'POST', body: this.body(ownerId, botId, { url }) });
  }
  async click(ownerId: string, botId: string, selector: string): Promise<BrowserActionResult> {
    await this.ensureContainer(ownerId);
    return this.request(ownerId, '/browser/click', { method: 'POST', body: this.body(ownerId, botId, { selector }) });
  }
  async type(ownerId: string, botId: string, selector: string, text: string, submit = false): Promise<BrowserActionResult> {
    await this.ensureContainer(ownerId);
    return this.request(ownerId, '/browser/type', { method: 'POST', body: this.body(ownerId, botId, { selector, text, submit }) });
  }
  async scroll(ownerId: string, botId: string, deltaY: number): Promise<BrowserActionResult> {
    await this.ensureContainer(ownerId);
    return this.request(ownerId, '/browser/scroll', { method: 'POST', body: this.body(ownerId, botId, { deltaY }) });
  }
  async waitFor(ownerId: string, botId: string, selector: string, timeoutMs = 5000): Promise<BrowserActionResult> {
    await this.ensureContainer(ownerId);
    return this.request(ownerId, '/browser/wait', { method: 'POST', body: this.body(ownerId, botId, { selector, timeoutMs }) });
  }
  async screenshot(ownerId: string, botId: string): Promise<BrowserActionResult> {
    await this.ensureContainer(ownerId);
    return this.request(ownerId, '/browser/screenshot', { method: 'POST', body: this.body(ownerId, botId) });
  }

  async listFiles(ownerId: string, botId: string): Promise<ComputerFileEntry[]> {
    await this.ensureContainer(ownerId);
    return this.request(ownerId, `/files?botKey=${encodeURIComponent(this.botKey(ownerId, botId))}`);
  }
  async readText(ownerId: string, botId: string, relativePath: string): Promise<{ path: string; content: string; sizeBytes: number }> {
    await this.ensureContainer(ownerId);
    return this.request(ownerId, `/file?botKey=${encodeURIComponent(this.botKey(ownerId, botId))}&path=${encodeURIComponent(relativePath)}`);
  }
  async writeText(ownerId: string, botId: string, relativePath: string, content: string): Promise<{ path: string; sizeBytes: number }> {
    await this.ensureContainer(ownerId);
    return this.request(ownerId, '/file', { method: 'PUT', body: this.body(ownerId, botId, { path: relativePath, content }) });
  }
  async terminal(ownerId: string, botId: string, program: string, args: string[] = [], timeoutMs = 20_000): Promise<TerminalExecutionResult> {
    if (!this.terminalEnabled) throw new Error('Computer terminal is disabled on this host.');
    await this.ensureContainer(ownerId);
    return this.request(ownerId, '/terminal', { method: 'POST', body: this.body(ownerId, botId, { program, args, timeoutMs }) });
  }
}
