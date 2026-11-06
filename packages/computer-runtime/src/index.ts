import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { Run, ToolCall, ToolDefinition, ToolResult } from '../../contracts/src/index.js';

export type ComputerLifecycle = 'DISABLED' | 'STOPPED' | 'RUNNING' | 'ERROR';

export interface ComputerFileEntry {
  path: string;
  type: 'file' | 'directory';
  sizeBytes: number;
  updatedAt: number;
}

export interface BrowserView {
  url: string;
  title: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  screenshotPath: string;
}

export interface ComputerStatus {
  enabled: boolean;
  state: ComputerLifecycle;
  workspaceReady: boolean;
  browser: { state: 'STOPPED' | 'RUNNING'; url?: string; title?: string; lastScreenshotPath?: string };
  terminal: { enabled: boolean; allowedPrograms: string[] };
  lastError?: string;
}

interface SessionRecord {
  context: BrowserContext;
  page: Page;
  lastView?: BrowserView;
}

export interface ComputerRuntimeOptions {
  enabled?: boolean;
  terminalEnabled?: boolean;
  root?: string;
  allowedPrograms?: string[];
}

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TERMINAL_BYTES = 128 * 1024;
const MAX_FILES = 200;
const DEFAULT_PROGRAMS = ['node', 'npm', 'npx', 'python', 'python3', 'git'];

function envEnabled(name: string, devDefault: boolean): boolean {
  const raw = process.env[name];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return process.env.NODE_ENV === 'production' ? false : devDefault;
}

function normalizedProgram(program: string): string {
  return path.basename(program).toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
}

function isPrivateIp(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) || a >= 224;
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') || lower.startsWith('ff') || lower.startsWith('2001:db8')) return true;
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? isPrivateIp(mapped) : false;
  }
  return true;
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Browser URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Browser only allows http and https URLs.');
  if (url.username || url.password) throw new Error('Browser URLs cannot contain credentials.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Loopback browser navigation is blocked.');
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Private or reserved network targets are blocked.');
  } else {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(entry => isPrivateIp(entry.address))) throw new Error('Private or reserved network targets are blocked.');
  }
  return url;
}

function toolResult(call: ToolCall, startedAt: number, output: unknown, error?: string): ToolResult {
  return {
    toolCallId: call.id,
    output: error ? null : output,
    error,
    isError: Boolean(error),
    durationMs: Date.now() - startedAt,
    timestamp: Date.now()
  };
}

export class ComputerRuntime {
  readonly enabled: boolean;
  readonly terminalEnabled: boolean;
  readonly root: string;
  readonly allowedPrograms: string[];
  private sessions = new Map<string, SessionRecord>();
  private errors = new Map<string, string>();

  constructor(options: ComputerRuntimeOptions = {}) {
    this.enabled = options.enabled ?? envEnabled('AIRA_COMPUTER_ENABLED', true);
    this.terminalEnabled = options.terminalEnabled ?? envEnabled('AIRA_COMPUTER_TERMINAL_ENABLED', true);
    this.root = path.resolve(options.root || process.env.AIRA_COMPUTER_ROOT || path.join(process.cwd(), '.aira-computers'));
    const configured = options.allowedPrograms || process.env.AIRA_COMPUTER_PROGRAMS?.split(',').map(v => v.trim()).filter(Boolean) || DEFAULT_PROGRAMS;
    this.allowedPrograms = Array.from(new Set(configured.map(normalizedProgram))).sort();
  }

  toolDefinitions(): ToolDefinition[] {
    if (!this.enabled) return [];
    const definitions: ToolDefinition[] = [
      {
        id: 'tool_browser_open', name: 'browser_open', source: 'local-runner', executionRuntime: 'LOCAL', permissionLevel: 'READ', idempotencyClass: 'SAFE_READ',
        description: 'Open a public HTTP(S) page in the bot persistent browser and return visible text, links, title, URL, and a workspace screenshot path.',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
      },
      {
        id: 'tool_file_read', name: 'file_read', source: 'local-runner', executionRuntime: 'LOCAL', permissionLevel: 'READ', idempotencyClass: 'SAFE_READ',
        description: 'Read a UTF-8 file from this bot persistent workspace. Symlinks and paths outside the workspace are rejected.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
      },
      {
        id: 'tool_file_write', name: 'file_write', source: 'local-runner', executionRuntime: 'LOCAL', permissionLevel: 'WRITE', idempotencyClass: 'IDEMPOTENT_WRITE',
        description: 'Write a UTF-8 file inside this bot persistent workspace. Parent directories are created without following symlinks.',
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
      }
    ];
    if (this.terminalEnabled) definitions.push({
      id: 'tool_terminal_exec', name: 'terminal_exec', source: 'local-runner', executionRuntime: 'LOCAL', permissionLevel: 'DESTRUCTIVE', idempotencyClass: 'NON_IDEMPOTENT',
      description: `Execute one approved program directly in the bot workspace without a command shell. Allowed programs: ${this.allowedPrograms.join(', ')}.`,
      parameters: { type: 'object', properties: { program: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'number' } }, required: ['program'] }
    });
    return definitions;
  }

  getDefinition(name: string): ToolDefinition | undefined {
    return this.toolDefinitions().find(definition => definition.name === name);
  }

  workspaceFor(ownerId: string, botId: string): string {
    const key = createHash('sha256').update(`${ownerId}\0${botId}`).digest('hex').slice(0, 28);
    return path.join(this.root, key);
  }

  private async ensureWorkspace(ownerId: string, botId: string): Promise<string> {
    if (!this.enabled) throw new Error('Computer runtime is disabled on this host.');
    const root = this.workspaceFor(ownerId, botId);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return root;
  }

  private async safeTarget(root: string, relativePath: string, forWrite = false): Promise<string> {
    const clean = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!clean || clean.includes('\0') || path.posix.isAbsolute(clean) || clean.split('/').some(part => part === '..' || part === '')) throw new Error('Workspace path is invalid.');
    const target = path.resolve(root, ...clean.split('/'));
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Workspace path escapes the bot workspace.');
    const parts = clean.split('/');
    let cursor = root;
    for (const part of parts.slice(0, -1)) {
      cursor = path.join(cursor, part);
      try {
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink()) throw new Error('Symlink traversal is not allowed in bot workspaces.');
        if (!stat.isDirectory()) throw new Error('Workspace parent path is not a directory.');
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
        if (!forWrite) throw new Error('Workspace path does not exist.');
        await fs.mkdir(cursor, { mode: 0o700 });
      }
    }
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error('Symlink access is not allowed in bot workspaces.');
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      if (!forWrite) throw new Error('Workspace file does not exist.');
    }
    return target;
  }

  async status(ownerId: string, botId: string): Promise<ComputerStatus> {
    if (!this.enabled) return { enabled: false, state: 'DISABLED', workspaceReady: false, browser: { state: 'STOPPED' }, terminal: { enabled: false, allowedPrograms: [] } };
    const root = this.workspaceFor(ownerId, botId);
    const key = root;
    const session = this.sessions.get(key);
    let workspaceReady = false;
    try { workspaceReady = (await fs.stat(root)).isDirectory(); } catch { /* workspace is created lazily */ }
    return {
      enabled: true,
      state: session ? 'RUNNING' : this.errors.has(key) ? 'ERROR' : 'STOPPED',
      workspaceReady,
      browser: { state: session ? 'RUNNING' : 'STOPPED', url: session?.lastView?.url, title: session?.lastView?.title, lastScreenshotPath: session?.lastView?.screenshotPath },
      terminal: { enabled: this.terminalEnabled, allowedPrograms: this.allowedPrograms },
      lastError: this.errors.get(key)
    };
  }

  async start(ownerId: string, botId: string): Promise<ComputerStatus> {
    const root = await this.ensureWorkspace(ownerId, botId);
    if (this.sessions.has(root)) return this.status(ownerId, botId);
    try {
      const { chromium } = await import('playwright');
      const profileDir = path.join(root, '.browser');
      await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
      const context = await chromium.launchPersistentContext(profileDir, { headless: true, viewport: { width: 1365, height: 768 } });
      await context.route('**/*', async route => {
        const requestUrl = route.request().url();
        if (!/^https?:/i.test(requestUrl)) return route.continue();
        try { await assertPublicUrl(requestUrl); return route.continue(); }
        catch { return route.abort('blockedbyclient'); }
      });
      const page = context.pages()[0] || await context.newPage();
      this.sessions.set(root, { context, page });
      this.errors.delete(root);
    } catch (err) {
      this.errors.set(root, (err as Error).message);
      throw new Error(`Computer browser could not start: ${(err as Error).message}`);
    }
    return this.status(ownerId, botId);
  }

  async stop(ownerId: string, botId: string): Promise<ComputerStatus> {
    const root = this.workspaceFor(ownerId, botId);
    const session = this.sessions.get(root);
    if (session) {
      this.sessions.delete(root);
      await session.context.close().catch(() => undefined);
    }
    this.errors.delete(root);
    return this.status(ownerId, botId);
  }

  async open(ownerId: string, botId: string, rawUrl: string): Promise<BrowserView> {
    const url = await assertPublicUrl(rawUrl);
    const root = await this.ensureWorkspace(ownerId, botId);
    if (!this.sessions.has(root)) await this.start(ownerId, botId);
    const session = this.sessions.get(root)!;
    await session.page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    const [title, text, links] = await Promise.all([
      session.page.title(),
      session.page.locator('body').innerText({ timeout: 5_000 }).catch(() => ''),
      session.page.locator('a[href]').evaluateAll(nodes => nodes.slice(0, 40).map(node => ({ text: (node.textContent || '').trim().slice(0, 160), href: (node as HTMLAnchorElement).href }))).catch(() => [])
    ]);
    const screenshots = path.join(root, 'screenshots');
    await fs.mkdir(screenshots, { recursive: true, mode: 0o700 });
    const screenshotPath = path.join('screenshots', 'latest.png').replace(/\\/g, '/');
    await session.page.screenshot({ path: path.join(root, screenshotPath), fullPage: false });
    const view: BrowserView = { url: session.page.url(), title: title.slice(0, 500), text: text.slice(0, MAX_TEXT_BYTES), links: links.filter(link => /^https?:/i.test(link.href)).slice(0, 30), screenshotPath };
    session.lastView = view;
    return view;
  }

  async listFiles(ownerId: string, botId: string): Promise<ComputerFileEntry[]> {
    const root = await this.ensureWorkspace(ownerId, botId);
    const output: ComputerFileEntry[] = [];
    const walk = async (dir: string, prefix = ''): Promise<void> => {
      if (output.length >= MAX_FILES) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name === '.browser') continue;
        if (output.length >= MAX_FILES) break;
        const absolute = path.join(dir, entry.name);
        const relative = path.posix.join(prefix, entry.name);
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) continue;
        output.push({ path: relative, type: stat.isDirectory() ? 'directory' : 'file', sizeBytes: stat.size, updatedAt: stat.mtimeMs });
        if (stat.isDirectory()) await walk(absolute, relative);
      }
    };
    await walk(root);
    return output;
  }

  async readText(ownerId: string, botId: string, relativePath: string): Promise<{ path: string; content: string; sizeBytes: number }> {
    const root = await this.ensureWorkspace(ownerId, botId);
    const target = await this.safeTarget(root, relativePath, false);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('Workspace path is not a file.');
    if (stat.size > MAX_TEXT_BYTES) throw new Error(`Workspace file exceeds ${MAX_TEXT_BYTES} byte read limit.`);
    return { path: relativePath, content: await fs.readFile(target, 'utf8'), sizeBytes: stat.size };
  }

  async writeText(ownerId: string, botId: string, relativePath: string, content: string): Promise<{ path: string; sizeBytes: number }> {
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) throw new Error(`Workspace write exceeds ${MAX_TEXT_BYTES} byte limit.`);
    const root = await this.ensureWorkspace(ownerId, botId);
    const target = await this.safeTarget(root, relativePath, true);
    await fs.writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
    return { path: relativePath, sizeBytes: Buffer.byteLength(content, 'utf8') };
  }

  async terminal(ownerId: string, botId: string, program: string, args: string[] = [], timeoutMs = 20_000): Promise<{ program: string; args: string[]; exitCode: number; stdout: string; stderr: string; truncated: boolean }> {
    if (!this.terminalEnabled) throw new Error('Computer terminal is disabled on this host.');
    const normalized = normalizedProgram(program);
    if (!this.allowedPrograms.includes(normalized)) throw new Error(`Program "${program}" is not in the terminal allowlist.`);
    if (args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 4096)) throw new Error('Terminal arguments exceed bounded limits.');
    const root = await this.ensureWorkspace(ownerId, botId);
    const boundedTimeout = Math.max(100, Math.min(Number(timeoutMs) || 20_000, 30_000));
    return new Promise((resolve, reject) => {
      execFile(program, args, {
        cwd: root,
        timeout: boundedTimeout,
        maxBuffer: MAX_TERMINAL_BYTES,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          TMP: process.env.TMP,
          TEMP: process.env.TEMP,
          SystemRoot: process.env.SystemRoot
        }
      }, (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(`Program "${program}" is not installed on this computer runtime.`));
        const stdoutText = String(stdout || '');
        const stderrText = String(stderr || '');
        resolve({ program: normalized, args, exitCode: Number((error as any)?.code ?? 0), stdout: stdoutText.slice(0, MAX_TERMINAL_BYTES), stderr: stderrText.slice(0, 32 * 1024), truncated: stdoutText.length >= MAX_TERMINAL_BYTES });
      });
    });
  }

  async execute(run: Run, call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now();
    if (!run.agentId) return toolResult(call, startedAt, null, 'Computer tools require a bot-owned run.');
    try {
      switch (call.name) {
        case 'browser_open': return toolResult(call, startedAt, await this.open(run.principalId, run.agentId, String(call.arguments.url || '')));
        case 'file_read': return toolResult(call, startedAt, await this.readText(run.principalId, run.agentId, String(call.arguments.path || '')));
        case 'file_write': return toolResult(call, startedAt, await this.writeText(run.principalId, run.agentId, String(call.arguments.path || ''), String(call.arguments.content ?? '')));
        case 'terminal_exec': return toolResult(call, startedAt, await this.terminal(run.principalId, run.agentId, String(call.arguments.program || ''), Array.isArray(call.arguments.args) ? call.arguments.args.map(String) : [], Number(call.arguments.timeoutMs) || 20_000));
        default: return toolResult(call, startedAt, null, `Computer tool "${call.name}" is not registered.`);
      }
    } catch (err) { return toolResult(call, startedAt, null, (err as Error).message); }
  }
}

export const computerRuntime = new ComputerRuntime();
