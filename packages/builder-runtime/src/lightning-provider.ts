import { randomUUID } from 'node:crypto';
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

export interface LightningConfig {
  apiKey?: string;
  baseUrl?: string;
  teamspace?: string;
  projectId?: string;
  organizationId?: string;
  runtime?: string;
  instanceType?: string;
  previewPort?: number;
  timeoutMs?: number;
}

export class LightningSandboxProvider implements SandboxProvider {
  readonly name = 'lightning';
  private cachedProjectId?: string;
  private cachedOrgId?: string;

  constructor(private configOverride: LightningConfig = {}) {}

  get apiKey(): string {
    return this.configOverride.apiKey ?? process.env.LIGHTNING_SANDBOX_API_KEY ?? '';
  }

  get baseUrl(): string {
    return (this.configOverride.baseUrl ?? process.env.LIGHTNING_CLOUD_URL ?? 'https://lightning.ai').replace(/\/+$/, '');
  }

  get teamspace(): string {
    return this.configOverride.teamspace ?? process.env.AIRA_LIGHTNING_TEAMSPACE ?? 'rajpunkeshwarrajgautam-org/aira-ai-2026';
  }

  get projectId(): string {
    return this.configOverride.projectId ?? process.env.AIRA_LIGHTNING_PROJECT_ID ?? '';
  }

  get organizationId(): string {
    return this.configOverride.organizationId ?? process.env.AIRA_LIGHTNING_ORG_ID ?? this.cachedOrgId ?? '';
  }

  get runtime(): string {
    return this.configOverride.runtime ?? process.env.AIRA_LIGHTNING_RUNTIME ?? 'node24';
  }

  get instanceType(): string {
    return this.configOverride.instanceType ?? process.env.AIRA_LIGHTNING_INSTANCE_TYPE ?? 'cpu-2';
  }

  get previewPort(): number {
    const override = this.configOverride.previewPort;
    if (typeof override === 'number') return override;
    const envVal = Number(process.env.AIRA_LIGHTNING_PREVIEW_PORT);
    return Number.isFinite(envVal) && envVal > 0 ? envVal : 3000;
  }

  get defaultTimeoutMs(): number {
    const override = this.configOverride.timeoutMs;
    if (typeof override === 'number') return override;
    const envVal = Number(process.env.AIRA_LIGHTNING_SANDBOX_TIMEOUT_MS);
    return Number.isFinite(envVal) && envVal >= 1000 ? envVal : 900000;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey.trim());
  }

  private authHeaders(): HeadersInit {
    const key = this.apiKey.trim();
    if (!key) throw new Error('LIGHTNING_SANDBOX_API_KEY is not configured.');
    return {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  async resolveProjectAndOrgId(signal?: AbortSignal): Promise<{ projectId: string; organizationId?: string }> {
    if (this.cachedProjectId !== undefined) {
      return { projectId: this.cachedProjectId, organizationId: this.cachedOrgId };
    }
    if (this.projectId) {
      this.cachedProjectId = this.projectId;
      this.cachedOrgId = this.organizationId;
      return { projectId: this.projectId, organizationId: this.organizationId };
    }

    const teamspaceStr = this.teamspace.trim();
    const teamspaceName = teamspaceStr.includes('/') ? teamspaceStr.split('/')[1] : teamspaceStr;

    const url = `${this.baseUrl}/v1/memberships?filterByUserId=true`;
    const res = await fetch(url, { headers: this.authHeaders(), signal });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to resolve Lightning memberships (${res.status}): ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      memberships?: Array<{
        name?: string;
        displayName?: string;
        display_name?: string;
        projectId?: string;
        project_id?: string;
        ownerId?: string;
        owner_id?: string;
        ownerType?: string;
        owner_type?: string;
      }>;
    };
    const memberships = data.memberships || [];
    // Prefer match where owner is organization
    const matched = memberships.find(m =>
      (m.name === teamspaceName || m.displayName === teamspaceName || m.display_name === teamspaceName) &&
      (m.ownerType === 'organization' || m.owner_type === 'organization')
    ) || memberships.find(m =>
      m.name === teamspaceName || m.displayName === teamspaceName || m.display_name === teamspaceName
    );

    const resolvedProjectId = this.projectId || matched?.projectId || matched?.project_id;
    if (!resolvedProjectId) {
      throw new Error(`Could not resolve Lightning teamspace project ID for '${teamspaceStr}'. Available teamspaces: ${memberships.map(m => m.name).filter(Boolean).join(', ')}`);
    }

    const resolvedOrgId = this.organizationId ||
      ((matched?.ownerType === 'organization' || matched?.owner_type === 'organization') ? (matched?.ownerId || matched?.owner_id) : undefined);

    this.cachedProjectId = resolvedProjectId;
    if (resolvedOrgId) this.cachedOrgId = resolvedOrgId;

    return { projectId: resolvedProjectId, organizationId: resolvedOrgId };
  }

  async resolveProjectId(signal?: AbortSignal): Promise<string> {
    const res = await this.resolveProjectAndOrgId(signal);
    return res.projectId;
  }

  private async checked(workspace: SandboxWorkspace, value: string, allowRoot = false, signal?: AbortSignal): Promise<string> {
    const relative = safeRelativePath(value, allowRoot);
    const script = `import pathlib,sys\nr=pathlib.Path(${JSON.stringify(WORKSPACE)}).resolve()\np=(r/sys.argv[1]).resolve()\nassert p==r or r in p.parents, 'Path escapes workspace through a symlink'\nprint(str(p))`;
    const res = await this.runCommand(workspace, `python3 -c ${quote(script)} ${quote(relative)}`, { timeoutMs: 5000, signal });
    if (res.exitCode !== 0) throw new Error('Workspace path validation failed.');
    const resolved = res.stdout.trim();
    if (!(resolved === WORKSPACE || resolved.startsWith(WORKSPACE + '/'))) throw new Error('Invalid resolved workspace path.');
    return resolved;
  }

  async createWorkspace(options: SandboxCreateOptions): Promise<SandboxWorkspace> {
    if (!this.isConfigured()) {
      throw new Error('Lightning AI Sandbox is not configured. Set LIGHTNING_SANDBOX_API_KEY.');
    }

    const resolved = await this.resolveProjectAndOrgId(options.signal);
    const name = options.name || `aira-builder-${randomUUID().slice(0, 8)}`;
    const timeoutMs = options.timeoutMs || this.defaultTimeoutMs;

    const payload: Record<string, unknown> = {
      name,
      instance_type: options.instanceType || this.instanceType,
      runtime: options.runtime || this.runtime,
      project_id: resolved.projectId,
      ports: [String(this.previewPort)],
      timeout: String(timeoutMs),
      spot: false,
      persistent: false
    };
    if (resolved.organizationId) {
      payload.organization_id = resolved.organizationId;
    }

    const createRes = await fetch(`${this.baseUrl}/v1/core/sandboxes`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(payload),
      signal: options.signal
    });

    if (!createRes.ok) {
      const err = await createRes.text().catch(() => '');
      throw new Error(`Lightning sandbox allocation failed (${createRes.status}): ${err.slice(0, 300)}`);
    }

    let sbData = (await createRes.json()) as {
      id: string;
      status?: string;
      organizationId?: string;
      organization_id?: string;
      ports?: string[];
      portUrls?: Record<string, string>;
      port_urls?: Record<string, string>;
      createdAt?: string;
      created_at?: string;
    };

    // Poll until running
    const start = Date.now();
    const deadline = start + 300000; // 5 minute max wait for cloud provision
    const orgId = sbData.organizationId || sbData.organization_id || resolved.organizationId;
    const orgQuery = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';

    while (sbData.status !== 'running') {
      if (sbData.status === 'error' || sbData.status === 'stopped' || sbData.status === 'shutdown') {
        throw new Error(`Lightning sandbox entered terminal state: ${sbData.status}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Lightning sandbox did not reach running state within timeout (status: ${sbData.status})`);
      }
      options.signal?.throwIfAborted();
      await new Promise(r => setTimeout(r, 1000));
      const pollRes = await fetch(`${this.baseUrl}/v1/core/sandboxes/${encodeURIComponent(sbData.id)}${orgQuery}`, {
        headers: this.authHeaders(),
        signal: options.signal
      });
      if (!pollRes.ok) {
        const err = await pollRes.text().catch(() => '');
        throw new Error(`Failed to poll Lightning sandbox status (${pollRes.status}): ${err.slice(0, 200)}`);
      }
      sbData = (await pollRes.json()) as typeof sbData;
    }

    const portUrls = sbData.portUrls || sbData.port_urls || {};
    const createdStr = sbData.createdAt || sbData.created_at;
    const createdAt = createdStr ? new Date(createdStr).getTime() : Date.now();

    const workspace: SandboxWorkspace = {
      id: sbData.id,
      provider: this.name,
      status: sbData.status,
      createdAt,
      expiresAt: Date.now() + timeoutMs,
      previewUrl: portUrls[String(this.previewPort)] || Object.values(portUrls)[0],
      portUrls,
      raw: { ...sbData, organizationId: orgId, organization_id: orgId }
    };

    // Initialize WORKSPACE directory inside sandbox
    await this.runCommand(workspace, `mkdir -p ${WORKSPACE}`, { cwd: '/', timeoutMs: 8000, signal: options.signal });

    return workspace;
  }

  async reconnectWorkspace(workspaceId: string, options?: SandboxReconnectOptions): Promise<SandboxWorkspace> {
    if (!this.isConfigured()) {
      throw new Error('Lightning AI Sandbox is not configured. Set LIGHTNING_SANDBOX_API_KEY.');
    }

    const orgId = this.organizationId || (await this.resolveProjectAndOrgId(options?.signal)).organizationId;
    const orgQuery = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';

    const res = await fetch(`${this.baseUrl}/v1/core/sandboxes/${encodeURIComponent(workspaceId)}${orgQuery}`, {
      headers: this.authHeaders(),
      signal: options?.signal
    });

    if (res.status === 404) {
      throw new Error('Workspace expired or not found. Start a new builder workspace.');
    }

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Failed to reconnect Lightning sandbox (${res.status}): ${err.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      id: string;
      status?: string;
      organizationId?: string;
      organization_id?: string;
      ports?: string[];
      portUrls?: Record<string, string>;
      port_urls?: Record<string, string>;
      createdAt?: string;
      created_at?: string;
      timeout?: string;
    };

    if (data.status !== 'running') {
      throw new Error(`Lightning sandbox is not running (status: ${data.status}). Start a new builder workspace.`);
    }

    const portUrls = data.portUrls || data.port_urls || {};
    const timeoutMs = Number(data.timeout) || this.defaultTimeoutMs;
    const createdStr = data.createdAt || data.created_at;
    const createdAt = createdStr ? new Date(createdStr).getTime() : Date.now();
    const finalOrgId = data.organizationId || data.organization_id || orgId;

    return {
      id: data.id,
      provider: this.name,
      status: data.status,
      createdAt,
      expiresAt: createdAt + timeoutMs,
      previewUrl: portUrls[String(this.previewPort)] || Object.values(portUrls)[0],
      portUrls,
      raw: { ...data, organizationId: finalOrgId, organization_id: finalOrgId }
    };
  }

  async runCommand(workspace: SandboxWorkspace, command: string, options?: SandboxCommandOptions): Promise<SandboxCommandResult> {
    const start = Date.now();
    const timeoutMs = options?.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Command timeout')), timeoutMs);
    const combinedSignal = options?.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;

    try {
      const orgId = (workspace.raw as any)?.organizationId || (workspace.raw as any)?.organization_id || this.organizationId;
      const payload: Record<string, unknown> = {
        command: 'sh',
        args: ['-c', command],
        cwd: options?.cwd || WORKSPACE,
        env: options?.env,
        detached: Boolean(options?.detached)
      };
      if (orgId) {
        payload.organization_id = orgId;
      }

      const res = await fetch(`${this.baseUrl}/v1/core/sandboxes/${encodeURIComponent(workspace.id)}/commands`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(payload),
        signal: combinedSignal
      });

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(`Command execution request failed (${res.status}): ${err.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        cmdId?: string;
        cmd_id?: string;
        id?: string;
        exitCode?: number;
        exit_code?: number;
        output?: string;
        running?: boolean;
      };

      const exitCode = typeof data.exitCode === 'number'
        ? data.exitCode
        : (typeof data.exit_code === 'number' ? data.exit_code : (data.running ? 0 : 0));
      const output = String(data.output || '');
      const commandId = data.cmdId || data.cmd_id || data.id;

      return {
        exitCode,
        stdout: output.slice(0, 16000),
        stderr: '',
        commandId,
        durationMs: Date.now() - start,
        provider: this.name
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async writeFile(workspace: SandboxWorkspace, path: string, contents: Uint8Array | string): Promise<{ path: string; bytesWritten: number }> {
    const file = await this.checked(workspace, path, false);
    const contentStr = typeof contents === 'string' ? contents : Buffer.from(contents).toString('utf8');
    const bytesWritten = Buffer.byteLength(contentStr);

    const dir = file.slice(0, file.lastIndexOf('/'));
    if (dir && dir !== WORKSPACE) {
      await this.runCommand(workspace, `mkdir -p ${quote(dir)}`, { timeoutMs: 5000 });
    }

    const orgId = (workspace.raw as any)?.organizationId || (workspace.raw as any)?.organization_id || this.organizationId;
    const payload: Record<string, unknown> = {
      path: file,
      content: contentStr
    };
    if (orgId) {
      payload.organization_id = orgId;
    }

    const res = await fetch(`${this.baseUrl}/v1/core/sandboxes/${encodeURIComponent(workspace.id)}/files`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Lightning file write failed (${res.status}): ${err.slice(0, 200)}`);
    }

    return { path, bytesWritten };
  }

  async readFile(workspace: SandboxWorkspace, path: string): Promise<Uint8Array> {
    const file = await this.checked(workspace, path, false);
    const script = `import sys,os,base64\np=sys.argv[1]\nif not os.path.isfile(p): sys.exit(1)\ns=os.path.getsize(p)\nif s > ${MAX_DOWNLOAD_BYTES}: sys.exit(2)\nwith open(p, 'rb') as f: sys.stdout.write(base64.b64encode(f.read()).decode('ascii'))`;

    const res = await this.runCommand(workspace, `python3 -c ${quote(script)} ${quote(file)}`, { timeoutMs: 10000 });
    if (res.exitCode === 1) throw new Error('File not found or is not a regular file.');
    if (res.exitCode === 2) throw new Error('File exceeds download limit (3 MiB maximum).');
    if (res.exitCode !== 0) throw new Error(`Read file failed with exit code ${res.exitCode}.`);

    const b64 = res.stdout.trim();
    const data = Buffer.from(b64, 'base64');
    if (data.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('File exceeds download limit.');
    return new Uint8Array(data);
  }

  async listFiles(workspace: SandboxWorkspace, path = '.'): Promise<SandboxFile[]> {
    const dir = await this.checked(workspace, path, true);
    const script = `import sys,os,json\np=sys.argv[1]\nif not os.path.isdir(p): sys.exit(1)\nentries=[]\nfor e in sorted(os.scandir(p), key=lambda x: x.name):\n entries.append({'name': e.name, 'type': 'dir' if e.is_dir() else 'file'})\n if len(entries) >= 100: break\nprint(json.dumps(entries))`;

    const res = await this.runCommand(workspace, `python3 -c ${quote(script)} ${quote(dir)}`, { timeoutMs: 5000 });
    if (res.exitCode !== 0) throw new Error('Failed to list workspace files.');

    try {
      return JSON.parse(res.stdout) as SandboxFile[];
    } catch {
      return [];
    }
  }

  async startPreview(workspace: SandboxWorkspace, port = 3000, command?: string): Promise<SandboxPreview> {
    let previewUrl = workspace.portUrls?.[String(port)] || workspace.previewUrl;
    if (!previewUrl) {
      const reconnected = await this.reconnectWorkspace(workspace.id);
      previewUrl = reconnected.portUrls?.[String(port)] || reconnected.previewUrl;
    }

    if (!previewUrl) {
      throw new Error(`Lightning sandbox has no public preview URL for port ${port}. Ensure port was exposed at creation.`);
    }

    const serverCmd = command || `python3 -m http.server ${port} --bind 0.0.0.0`;
    await this.runCommand(workspace, serverCmd, { cwd: WORKSPACE, detached: true, timeoutMs: 5000 });

    const probeScript = `import time,urllib.request,sys\nfor i in range(30):\n try:\n  req=urllib.request.Request('http://127.0.0.1:${port}/')\n  with urllib.request.urlopen(req,timeout=1) as r:\n   assert 200<=r.status<400\n   print('READY')\n   sys.exit(0)\n except Exception:\n  time.sleep(0.25)\nsys.exit(1)`;
    const probeRes = await this.runCommand(workspace, `python3 -c ${quote(probeScript)}`, { timeoutMs: 12000 });

    if (probeRes.exitCode !== 0 || !probeRes.stdout.includes('READY')) {
      throw new Error(`Preview server is not ready on port ${port}. Bind port ${port} to 0.0.0.0.`);
    }

    const urlObj = new URL(previewUrl);
    if (!urlObj.pathname.endsWith('/')) urlObj.pathname += '/';

    return {
      url: urlObj.href,
      port,
      provider: this.name
    };
  }

  async stopCommand(workspace: SandboxWorkspace, commandId: string): Promise<void> {
    const orgId = (workspace.raw as any)?.organizationId || (workspace.raw as any)?.organization_id || this.organizationId;
    const orgQuery = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';
    const url = `${this.baseUrl}/v1/core/sandboxes/${encodeURIComponent(workspace.id)}/commands/${encodeURIComponent(commandId)}/kill${orgQuery}`;
    await fetch(url, {
      method: 'POST',
      headers: this.authHeaders()
    }).catch(() => {});
  }

  async terminateWorkspace(workspace: SandboxWorkspace): Promise<void> {
    if (!this.isConfigured()) return;

    const orgId = (workspace.raw as any)?.organizationId || (workspace.raw as any)?.organization_id || this.organizationId;
    const orgQuery = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';

    // Ephemeral teardown: call stop and delete
    try {
      const stopUrl = `${this.baseUrl}/v1/core/sandboxes/${encodeURIComponent(workspace.id)}/stop`;
      const stopBody: Record<string, unknown> = {};
      if (orgId) stopBody.organization_id = orgId;

      const res = await fetch(stopUrl, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(stopBody)
      });
      if (res.status === 404) return;
    } catch {
      // tolerate network errors during teardown
    }

    try {
      const delUrl = `${this.baseUrl}/v1/core/sandboxes/${encodeURIComponent(workspace.id)}${orgQuery}`;
      const res = await fetch(delUrl, {
        method: 'DELETE',
        headers: this.authHeaders()
      });
      if (res.status === 404) return;
    } catch {
      // tolerate
    }
  }
}
