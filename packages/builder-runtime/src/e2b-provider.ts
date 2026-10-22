import type { Sandbox } from 'e2b';
import { MAX_DOWNLOAD_BYTES, WORKSPACE } from './contracts.js';
import { safeRelativePath } from './security.js';
import type {
  SandboxCommandOptions,
  SandboxCommandResult,
  SandboxCreateOptions,
  SandboxFile,
  SandboxPreview,
  SandboxProvider,
  SandboxReconnectOptions,
  SandboxWorkspace
} from './provider-types.js';

const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = 'e2b';
  private instances = new Map<string, Sandbox>();

  isConfigured(): boolean {
    return Boolean(process.env.E2B_API_KEY?.trim());
  }

  private async getSandbox(workspace: SandboxWorkspace): Promise<Sandbox> {
    const existing = this.instances.get(workspace.id) || (workspace.raw as Sandbox);
    if (existing) return existing;
    const { Sandbox } = await import('e2b');
    const sb = await Sandbox.connect(workspace.id, { apiKey: process.env.E2B_API_KEY });
    this.instances.set(workspace.id, sb);
    return sb;
  }

  private async checked(sb: Sandbox, value: string, allowRoot = false, signal?: AbortSignal): Promise<string> {
    const relative = safeRelativePath(value, allowRoot);
    const script = `import pathlib,sys\nr=pathlib.Path(${JSON.stringify(WORKSPACE)}).resolve()\np=(r/sys.argv[1]).resolve()\nassert p==r or r in p.parents, 'Path escapes workspace through a symlink'\nprint(str(p))`;
    const result = await sb.commands.run(`python3 -c ${quote(script)} ${quote(relative)}`, { timeoutMs: 5000, signal });
    if (result.exitCode !== 0) throw new Error('Workspace path validation failed.');
    const resolved = result.stdout.trim();
    if (!(resolved === WORKSPACE || resolved.startsWith(WORKSPACE + '/'))) throw new Error('Invalid resolved workspace path.');
    return resolved;
  }

  async createWorkspace(options: SandboxCreateOptions): Promise<SandboxWorkspace> {
    if (!this.isConfigured()) {
      throw new Error('E2B Sandbox is not configured. Set E2B_API_KEY.');
    }

    const { Sandbox } = await import('e2b');
    const sandbox = await Sandbox.create({
      apiKey: process.env.E2B_API_KEY,
      template: process.env.AIRA_BUILDER_TEMPLATE || 'base',
      timeoutMs: options.timeoutMs,
      allowInternetAccess: options.allowInternet,
      network: {
        allowPublicTraffic: options.allowPreview,
        ...(options.allowInternet
          ? {
              denyOut: ['0.0.0.0/0'],
              allowOut: (process.env.AIRA_BUILDER_EGRESS_ALLOWLIST || 'registry.npmjs.org,pypi.org,files.pythonhosted.org')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
            }
          : {})
      },
      signal: options.signal,
      metadata: { application: 'aira-builder-beta' }
    });

    try {
      await sandbox.commands.run(`mkdir -p ${WORKSPACE}`, { timeoutMs: 5000, signal: options.signal });
      this.instances.set(sandbox.sandboxId, sandbox);
      return {
        id: sandbox.sandboxId,
        provider: this.name,
        createdAt: Date.now(),
        expiresAt: Date.now() + options.timeoutMs,
        status: 'running',
        raw: sandbox
      };
    } catch (error) {
      await sandbox.kill().catch(() => {});
      throw error;
    }
  }

  async reconnectWorkspace(workspaceId: string, options?: SandboxReconnectOptions): Promise<SandboxWorkspace> {
    if (!this.isConfigured()) {
      throw new Error('E2B Sandbox is not configured. Set E2B_API_KEY.');
    }
    const { Sandbox } = await import('e2b');
    const sandbox = await Sandbox.connect(workspaceId, { apiKey: process.env.E2B_API_KEY, signal: options?.signal });
    this.instances.set(sandbox.sandboxId, sandbox);
    return {
      id: sandbox.sandboxId,
      provider: this.name,
      status: 'running',
      raw: sandbox
    };
  }

  async writeFile(workspace: SandboxWorkspace, path: string, contents: Uint8Array | string): Promise<{ path: string; bytesWritten: number }> {
    const sb = await this.getSandbox(workspace);
    const file = await this.checked(sb, path, false);
    const contentStr = typeof contents === 'string' ? contents : Buffer.from(contents).toString('utf8');
    await sb.files.makeDir(file.slice(0, file.lastIndexOf('/')));
    await sb.files.write(file, contentStr);
    return { path, bytesWritten: Buffer.byteLength(contentStr) };
  }

  async readFile(workspace: SandboxWorkspace, path: string): Promise<Uint8Array> {
    const sb = await this.getSandbox(workspace);
    const file = await this.checked(sb, path, false);
    const info = await sb.files.getInfo(file);
    if (info.size > MAX_DOWNLOAD_BYTES || info.type !== 'file') throw new Error('File is too large or is not a regular file (3 MiB maximum).');
    const data = await sb.files.read(file, { format: 'bytes' });
    if (data.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('File exceeds download limit.');
    return data;
  }

  async listFiles(workspace: SandboxWorkspace, path = '.'): Promise<SandboxFile[]> {
    const sb = await this.getSandbox(workspace);
    const dir = await this.checked(sb, path, true);
    const entries = await sb.files.list(dir);
    return entries.slice(0, 100).map(e => ({ name: e.name, type: String(e.type || 'file') }));
  }

  async runCommand(workspace: SandboxWorkspace, command: string, options?: SandboxCommandOptions): Promise<SandboxCommandResult> {
    const sb = await this.getSandbox(workspace);
    const start = Date.now();
    try {
      const r = await sb.commands.run(command, {
        cwd: options?.cwd || WORKSPACE,
        timeoutMs: options?.timeoutMs ?? 15000,
        signal: options?.signal,
        background: options?.detached
      });
      return {
        exitCode: r.exitCode ?? 0,
        stdout: (r.stdout || '').slice(0, 16000),
        stderr: (r.stderr || '').slice(0, 8000),
        durationMs: Date.now() - start,
        provider: this.name
      };
    } catch (error: any) {
      if (typeof error.exitCode === 'number') {
        return {
          exitCode: error.exitCode,
          stdout: String(error.stdout || '').slice(0, 16000),
          stderr: String(error.stderr || error.message).slice(0, 8000),
          durationMs: Date.now() - start,
          provider: this.name
        };
      }
      throw error;
    }
  }

  async startPreview(workspace: SandboxWorkspace, port = 3000, command?: string): Promise<SandboxPreview> {
    const sb = await this.getSandbox(workspace);
    const host = sb.getHost(port);
    await sb.commands.run(command || `python3 -m http.server ${port} --bind 0.0.0.0`, {
      cwd: WORKSPACE,
      background: true,
      timeoutMs: 0
    });

    const script = `import time,urllib.request,sys\nfor i in range(30):\n try:\n  req=urllib.request.Request('http://127.0.0.1:${port}/',headers={'Host':sys.argv[1]})\n  with urllib.request.urlopen(req,timeout=1) as r:\n   assert 200<=r.status<400\n   print('READY');sys.exit(0)\n except Exception:time.sleep(.25)\nsys.exit(1)`;
    const result = await sb.commands.run(`python3 -c ${quote(script)} ${quote(host)}`, { timeoutMs: 12000 });
    if (result.exitCode !== 0 || !result.stdout.includes('READY')) {
      throw new Error(`Preview server is not ready. Bind port ${port} to 0.0.0.0 and allow the sandbox preview host.`);
    }

    const url = new URL(`https://${host}`);
    if (!/^[a-zA-Z0-9.-]+$/.test(url.hostname)) throw new Error('Invalid preview host.');

    return {
      url: url.href.endsWith('/') ? url.href : `${url.href}/`,
      port,
      provider: this.name
    };
  }

  async terminateWorkspace(workspace: SandboxWorkspace): Promise<void> {
    const sb = this.instances.get(workspace.id) || (workspace.raw as Sandbox);
    this.instances.delete(workspace.id);
    if (sb) {
      await sb.kill({ requestTimeoutMs: 10000 }).catch(() => {});
    }
  }
}
