import type { Sandbox } from 'e2b';
import { MAX_DOWNLOAD_BYTES, WORKSPACE } from './contracts.js';
import { safeRelativePath } from './security.js';

export interface BuilderSandbox {
  id: string;
  write(path: string, content: string): Promise<unknown>;
  read(path: string): Promise<Uint8Array>;
  list(path: string): Promise<unknown>;
  command(command: string, timeoutMs: number): Promise<unknown>;
  preview(command?: string): Promise<string>;
  kill(): Promise<unknown>;
}
export interface SandboxFactory {
  create(options: { allowInternet: boolean; allowPreview: boolean; timeoutMs: number; signal: AbortSignal }): Promise<BuilderSandbox>;
  connect(id: string, signal?: AbortSignal): Promise<BuilderSandbox>;
}
const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

class E2BBuilderSandbox implements BuilderSandbox {
  readonly id: string;
  constructor(private sandbox: Sandbox, private signal?: AbortSignal) { this.id = sandbox.sandboxId; }
  // Resolve symlinks IN THE REMOTE VM, never against the app server's filesystem.
  private async checked(value: string, allowRoot = false): Promise<string> {
    const relative = safeRelativePath(value, allowRoot);
    const script = `import pathlib,sys\nr=pathlib.Path(${JSON.stringify(WORKSPACE)}).resolve()\np=(r/sys.argv[1]).resolve()\nassert p==r or r in p.parents, 'Path escapes workspace through a symlink'\nprint(str(p))`;
    const result = await this.sandbox.commands.run(`python3 -c ${quote(script)} ${quote(relative)}`, { timeoutMs: 5000, signal: this.signal });
    if (result.exitCode !== 0) throw new Error('Workspace path validation failed.');
    const resolved = result.stdout.trim();
    if (!(resolved === WORKSPACE || resolved.startsWith(WORKSPACE + '/'))) throw new Error('Invalid resolved workspace path.');
    return resolved;
  }
  async write(value: string, content: string) {
    const file = await this.checked(value);
    await this.sandbox.files.makeDir(file.slice(0,file.lastIndexOf('/')), { signal: this.signal });
    await this.sandbox.files.write(file, content, { signal: this.signal });
    return { path: value, bytesWritten: Buffer.byteLength(content) };
  }
  async read(value: string) {
    const file = await this.checked(value);
    const info = await this.sandbox.files.getInfo(file, { signal: this.signal });
    if (info.size > MAX_DOWNLOAD_BYTES || info.type !== 'file') throw new Error('File is too large or is not a regular file (3 MiB maximum).');
    const data = await this.sandbox.files.read(file, { format: 'bytes', signal: this.signal });
    if (data.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('File exceeds download limit.');
    return data;
  }
  async list(value: string) {
    const dir = await this.checked(value, true);
    const entries = await this.sandbox.files.list(dir, { signal: this.signal });
    return entries.slice(0,100).map(e => ({ name: e.name, type: e.type }));
  }
  async command(command: string, timeoutMs: number) {
    try {
      const r = await this.sandbox.commands.run(command, { cwd: WORKSPACE, timeoutMs, signal: this.signal });
      return { exitCode: r.exitCode, stdout: r.stdout.slice(0,16000), stderr: r.stderr.slice(0,8000) };
    } catch (error: any) {
      if (typeof error.exitCode === 'number') return { exitCode: error.exitCode, stdout: String(error.stdout || '').slice(0,16000), stderr: String(error.stderr || error.message).slice(0,8000) };
      throw error;
    }
  }
  async preview(command?: string) {
    const host = this.sandbox.getHost(3000);
    await this.sandbox.commands.run(command || 'python3 -m http.server 3000 --bind 0.0.0.0', { cwd: WORKSPACE, background: true, timeoutMs: 0, signal: this.signal });
    const script = `import time,urllib.request,sys\nfor i in range(30):\n try:\n  req=urllib.request.Request('http://127.0.0.1:3000/',headers={'Host':sys.argv[1]})\n  with urllib.request.urlopen(req,timeout=1) as r:\n   assert 200<=r.status<400\n   print('READY');sys.exit(0)\n except Exception:time.sleep(.25)\nsys.exit(1)`;
    const result = await this.sandbox.commands.run(`python3 -c ${quote(script)} ${quote(host)}`, { timeoutMs: 12000, signal: this.signal });
    if (result.exitCode !== 0 || !result.stdout.includes('READY')) throw new Error('Preview server is not ready. Bind port 3000 to 0.0.0.0 and allow the sandbox preview host.');
    const url = new URL(`https://${host}`);
    if (!/^[a-zA-Z0-9.-]+$/.test(url.hostname)) throw new Error('Invalid preview host.');
    return url.href;
  }
  async kill() { return this.sandbox.kill({ requestTimeoutMs: 10000 }); }
}
export class E2BSandboxFactory implements SandboxFactory {
  async create(options: { allowInternet: boolean; allowPreview: boolean; timeoutMs: number; signal: AbortSignal }) {
    const { Sandbox } = await import('e2b');
    const sandbox = await Sandbox.create({
      apiKey: process.env.E2B_API_KEY,
      template: process.env.AIRA_BUILDER_TEMPLATE || 'base',
      timeoutMs: options.timeoutMs,
      allowInternetAccess: options.allowInternet,
      network: { allowPublicTraffic: options.allowPreview, ...(options.allowInternet ? { denyOut: ['0.0.0.0/0'], allowOut: (process.env.AIRA_BUILDER_EGRESS_ALLOWLIST || 'registry.npmjs.org,pypi.org,files.pythonhosted.org').split(',').map(s=>s.trim()).filter(Boolean) } : {}) },
      signal: options.signal,
      metadata: { application: 'aira-builder-beta' },
      // Deliberately do not forward app credentials or process.env into the VM.
    });
    try {
      await sandbox.commands.run(`mkdir -p ${WORKSPACE}`, { timeoutMs: 5000, signal: options.signal });
      return new E2BBuilderSandbox(sandbox, options.signal);
    } catch (error) { await sandbox.kill().catch(()=>{}); throw error; }
  }
  async connect(id: string, signal?: AbortSignal) {
    const { Sandbox } = await import('e2b');
    const sandbox = await Sandbox.connect(id, { apiKey: process.env.E2B_API_KEY, signal });
    return new E2BBuilderSandbox(sandbox, signal);
  }
}
