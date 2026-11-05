import { LightningSandboxProvider } from './lightning-provider.js';
import { E2BSandboxProvider } from './e2b-provider.js';
import { OCISandboxProvider } from './oci-provider.js';
import { LocalIsolatedSandboxProvider } from './local-provider.js';
import { DockerIsolatedSandboxProvider } from './docker-provider.js';
import { SidecarSandboxProvider } from './sidecar-provider.js';
import type {
  SandboxProvider,
  SandboxWorkspace,
  SandboxCommandResult,
  SandboxFile
} from './provider-types.js';

export * from './provider-types.js';
export { LightningSandboxProvider } from './lightning-provider.js';
export { E2BSandboxProvider } from './e2b-provider.js';
export { OCISandboxProvider } from './oci-provider.js';
export { LocalIsolatedSandboxProvider } from './local-provider.js';
export { DockerIsolatedSandboxProvider, type DockerSandboxProviderOptions } from './docker-provider.js';
export { SidecarSandboxProvider } from './sidecar-provider.js';

export interface ResolveIsolatedSandboxOptions {
  requireContainer?: boolean;
  trustedLocalExecution?: boolean;
  disableLocalDocker?: boolean;
}

/**
 * Authoritative resolver for untrusted code execution sandbox provider.
 * Enforces an approved isolated backend (Docker, Podman/OCI, E2B, Lightning) by default
 * for all untrusted agent-generated code.
 * Fails closed if isolation is unavailable.
 * Trusted local host development operations are strictly separated and require explicit authorization.
 */
export function resolveIsolatedSandboxProvider(options?: ResolveIsolatedSandboxOptions): SandboxProvider {
  const isTrustedLocal = options?.trustedLocalExecution === true && (
    process.env.AIRA_TRUSTED_LOCAL_EXECUTION === 'true' ||
    process.env.AIRA_TRUSTED_HOST_EXECUTION === 'true'
  );

  if (isTrustedLocal) {
    return new LocalIsolatedSandboxProvider();
  }

  // Untrusted workload (Default for all agent/tool execution):
  // Check available approved isolated backends in security preference order:
  if (process.env.AIRA_DISABLE_LOCAL_DOCKER !== 'true' && !options?.disableLocalDocker) {
    const docker = new DockerIsolatedSandboxProvider();
    if (docker.isConfigured()) {
      return docker;
    }
  }

  const sidecar = new SidecarSandboxProvider();
  if (sidecar.isConfigured()) {
    return sidecar;
  }

  const oci = new OCISandboxProvider();
  if (oci.isConfigured()) {
    return oci;
  }

  const e2b = new E2BSandboxProvider();
  if (e2b.isConfigured()) {
    return e2b;
  }

  const lightning = new LightningSandboxProvider();
  if (lightning.isConfigured()) {
    return lightning;
  }

  // Fail closed! No approved isolated backend is reachable.
  throw new Error('CONTAINER_ISOLATION_UNAVAILABLE: Untrusted code execution requires an approved isolated backend (Docker, Sidecar, Podman/OCI, E2B, or Lightning), but no isolated runtime is configured or reachable. Host execution is prohibited. Fail-closed enforced.');
}

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
      this.register(new DockerIsolatedSandboxProvider());
      this.register(new SidecarSandboxProvider());
      if (process.env.AIRA_TRUSTED_LOCAL_EXECUTION === 'true') {
        this.register(new LocalIsolatedSandboxProvider());
      }
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
        if (fallbackName === 'local' && process.env.AIRA_TRUSTED_LOCAL_EXECUTION !== 'true') {
          throw new Error('SECURITY_VIOLATION: Fallback to unisolated local host provider is forbidden for untrusted workloads.');
        }
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
