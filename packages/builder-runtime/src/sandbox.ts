import { LightningSandboxProvider } from './lightning-provider.js';
import { E2BSandboxProvider } from './e2b-provider.js';
import { OCISandboxProvider } from './oci-provider.js';
import type {
  SandboxProvider,
  SandboxWorkspace,
  SandboxCreateOptions,
  SandboxCommandResult,
  SandboxFile,
  SandboxPreview
} from './provider-types.js';

export * from './provider-types.js';
export { LightningSandboxProvider } from './lightning-provider.js';
export { E2BSandboxProvider } from './e2b-provider.js';
export { OCISandboxProvider } from './oci-provider.js';

export interface BuilderSandbox {
  id: string;
  provider: string;
  write(path: string, content: string): Promise<unknown>;
  read(path: string): Promise<Uint8Array>;
  list(path: string): Promise<unknown>;
  command(command: string, timeoutMs: number): Promise<unknown>;
  preview(command?: string): Promise<string>;
  kill(): Promise<unknown>;
}

export interface SandboxFactory {
  create(options: { allowInternet: boolean; allowPreview: boolean; timeoutMs: number; signal: AbortSignal }): Promise<BuilderSandbox>;
  connect(id: string, signal?: AbortSignal, provider?: string): Promise<BuilderSandbox>;
}

export class ProviderBoundSandbox implements BuilderSandbox {
  constructor(
    readonly workspace: SandboxWorkspace,
    readonly sandboxProvider: SandboxProvider,
    private signal?: AbortSignal
  ) {}

  get id(): string {
    return this.workspace.id;
  }

  get provider(): string {
    return this.sandboxProvider.name;
  }

  async write(path: string, content: string): Promise<{ path: string; bytesWritten: number }> {
    return this.sandboxProvider.writeFile(this.workspace, path, content);
  }

  async read(path: string): Promise<Uint8Array> {
    return this.sandboxProvider.readFile(this.workspace, path);
  }

  async list(path: string): Promise<SandboxFile[]> {
    return this.sandboxProvider.listFiles(this.workspace, path);
  }

  async command(command: string, timeoutMs: number): Promise<SandboxCommandResult> {
    return this.sandboxProvider.runCommand(this.workspace, command, { timeoutMs, signal: this.signal });
  }

  async preview(command?: string): Promise<string> {
    const p = await this.sandboxProvider.startPreview(this.workspace, 3000, command);
    return p.url;
  }

  async kill(): Promise<void> {
    return this.sandboxProvider.terminateWorkspace(this.workspace);
  }
}

export class MultiProviderSandboxFactory implements SandboxFactory {
  private providers = new Map<string, SandboxProvider>();

  constructor(customProviders?: SandboxProvider[]) {
    if (customProviders && customProviders.length > 0) {
      for (const p of customProviders) {
        this.providers.set(p.name, p);
      }
    } else {
      this.register(new LightningSandboxProvider());
      this.register(new E2BSandboxProvider());
      this.register(new OCISandboxProvider());
    }
  }

  register(provider: SandboxProvider) {
    this.providers.set(provider.name, provider);
  }

  getProvider(name: string): SandboxProvider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`Unknown sandbox provider: '${name}'. Supported: ${[...this.providers.keys()].join(', ')}`);
    return p;
  }

  get primaryProviderName(): string {
    return process.env.AIRA_SANDBOX_PROVIDER || 'lightning';
  }

  get fallbackProviderName(): string | undefined {
    return process.env.AIRA_SANDBOX_FALLBACK_PROVIDER;
  }

  async create(options: { allowInternet: boolean; allowPreview: boolean; timeoutMs: number; signal: AbortSignal }): Promise<BuilderSandbox> {
    const primaryName = this.primaryProviderName;
    const primary = this.getProvider(primaryName);

    try {
      const workspace = await primary.createWorkspace(options);
      return new ProviderBoundSandbox(workspace, primary, options.signal);
    } catch (primaryError: any) {
      const fallbackName = this.fallbackProviderName;
      if (fallbackName && fallbackName !== primaryName) {
        const fallback = this.getProvider(fallbackName);
        if (fallback.isConfigured()) {
          const workspace = await fallback.createWorkspace(options);
          return new ProviderBoundSandbox(workspace, fallback, options.signal);
        }
      }
      throw primaryError;
    }
  }

  async connect(id: string, signal?: AbortSignal, providerName?: string): Promise<BuilderSandbox> {
    const targetProviderName = providerName || this.primaryProviderName;
    const provider = this.getProvider(targetProviderName);
    const workspace = await provider.reconnectWorkspace(id, { signal });
    return new ProviderBoundSandbox(workspace, provider, signal);
  }
}

export class E2BSandboxFactory implements SandboxFactory {
  private provider = new E2BSandboxProvider();

  async create(options: { allowInternet: boolean; allowPreview: boolean; timeoutMs: number; signal: AbortSignal }): Promise<BuilderSandbox> {
    const ws = await this.provider.createWorkspace(options);
    return new ProviderBoundSandbox(ws, this.provider, options.signal);
  }

  async connect(id: string, signal?: AbortSignal): Promise<BuilderSandbox> {
    const ws = await this.provider.reconnectWorkspace(id, { signal });
    return new ProviderBoundSandbox(ws, this.provider, signal);
  }
}

export class LightningSandboxFactory implements SandboxFactory {
  private provider = new LightningSandboxProvider();

  async create(options: { allowInternet: boolean; allowPreview: boolean; timeoutMs: number; signal: AbortSignal }): Promise<BuilderSandbox> {
    const ws = await this.provider.createWorkspace(options);
    return new ProviderBoundSandbox(ws, this.provider, options.signal);
  }

  async connect(id: string, signal?: AbortSignal): Promise<BuilderSandbox> {
    const ws = await this.provider.reconnectWorkspace(id, { signal });
    return new ProviderBoundSandbox(ws, this.provider, signal);
  }
}
