import { ExecutionPrincipal, SideEffectLevel } from '../../../contracts/src/index.js';

export type ConnectorState =
  | 'CONNECTED'
  | 'AUTH_REQUIRED'
  | 'PERMISSION_REQUIRED'
  | 'READY'
  | 'DEGRADED'
  | 'DISCONNECTED';

export interface ConnectorActionDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  sideEffectLevel: SideEffectLevel;
  requiredScopes: string[];
}

export interface ConnectorAdapter {
  id: string;
  name: string;
  provider: string;
  description: string;
  getState(principal: ExecutionPrincipal): Promise<{
    state: ConnectorState;
    configured: boolean;
    reason?: string;
  }>;
  listActions(): ConnectorActionDefinition[];
  executeAction(
    actionName: string,
    params: Record<string, any>,
    principal: ExecutionPrincipal
  ): Promise<any>;
}

export class ConnectorRegistry {
  private connectors: Map<string, ConnectorAdapter> = new Map();

  register(connector: ConnectorAdapter): void {
    this.connectors.set(connector.id, connector);
  }

  get(id: string): ConnectorAdapter | undefined {
    return this.connectors.get(id);
  }

  list(): ConnectorAdapter[] {
    return Array.from(this.connectors.values());
  }

  async getStatusForPrincipal(principal: ExecutionPrincipal): Promise<Array<{
    id: string;
    name: string;
    provider: string;
    state: ConnectorState;
    configured: boolean;
    reason?: string;
  }>> {
    const results = [];
    for (const c of this.connectors.values()) {
      const s = await c.getState(principal);
      results.push({
        id: c.id,
        name: c.name,
        provider: c.provider,
        state: s.state,
        configured: s.configured,
        reason: s.reason
      });
    }
    return results;
  }
}

/**
 * Real GitHub Connector Adapter
 * Validates GITHUB_TOKEN on server side.
 * Never leaks token to model or client.
 */
export class GitHubConnectorAdapter implements ConnectorAdapter {
  id = 'connector_github';
  name = 'GitHub Connector';
  provider = 'github';
  description = 'Inspect public or authorized GitHub repositories and issues safely.';

  private getToken(): string | undefined {
    return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  }

  async getState(_principal: ExecutionPrincipal): Promise<{
    state: ConnectorState;
    configured: boolean;
    reason?: string;
  }> {
    const token = this.getToken();
    if (!token) {
      return {
        state: 'AUTH_REQUIRED',
        configured: false,
        reason: 'Server environment variable GITHUB_TOKEN is not configured.'
      };
    }
    return {
      state: 'READY',
      configured: true
    };
  }

  listActions(): ConnectorActionDefinition[] {
    return [
      {
        name: 'get_repository',
        description: 'Get public metadata for a GitHub repository',
        parameters: {
          owner: { type: 'string', description: 'Repository owner or organization' },
          repo: { type: 'string', description: 'Repository name' }
        },
        sideEffectLevel: 'READ',
        requiredScopes: ['connector.read']
      },
      {
        name: 'list_commits',
        description: 'Get recent commit history for a GitHub repository',
        parameters: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          limit: { type: 'number', description: 'Number of commits (max 10)' }
        },
        sideEffectLevel: 'READ',
        requiredScopes: ['connector.read']
      }
    ];
  }

  async executeAction(
    actionName: string,
    params: Record<string, any>,
    principal: ExecutionPrincipal
  ): Promise<any> {
    const status = await this.getState(principal);
    if (status.state !== 'READY') {
      throw new Error(`GitHub connector is unavailable: ${status.reason || status.state}`);
    }

    const token = this.getToken()!;
    const headers: Record<string, string> = {
      'User-Agent': 'Aira-Tool-Gateway/2026',
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${token}`
    };

    if (actionName === 'get_repository') {
      const owner = String(params.owner || '').trim();
      const repo = String(params.repo || '').trim();
      if (!owner || !repo) throw new Error('Parameters "owner" and "repo" are required.');

      const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers });
      if (!res.ok) {
        throw new Error(`GitHub API error (${res.status}): ${await res.text()}`);
      }
      const data = await res.json() as any;
      return {
        fullName: data.full_name,
        description: data.description,
        defaultBranch: data.default_branch,
        stars: data.stargazers_count,
        openIssues: data.open_issues_count,
        updatedAt: data.updated_at
      };
    }

    if (actionName === 'list_commits') {
      const owner = String(params.owner || '').trim();
      const repo = String(params.repo || '').trim();
      const limit = Math.min(Number(params.limit) || 5, 10);
      if (!owner || !repo) throw new Error('Parameters "owner" and "repo" are required.');

      const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=${limit}`, { headers });
      if (!res.ok) {
        throw new Error(`GitHub API error (${res.status}): ${await res.text()}`);
      }
      const commits = await res.json() as any[];
      return commits.map(c => ({
        sha: c.sha?.slice(0, 7),
        message: c.commit?.message?.split('\n')[0],
        author: c.commit?.author?.name,
        date: c.commit?.author?.date
      }));
    }

    throw new Error(`Unknown action "${actionName}" on GitHub connector.`);
  }
}
