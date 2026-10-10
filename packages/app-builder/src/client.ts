import { z } from 'zod';
import type { ModelPolicy } from '../../contracts/src/index.js';
import { ModelRouter } from '../../model-router/src/index.js';
import { BuildInput, type BuildJob, type BuildRequest } from './worker.js';

const BuildDraft = BuildInput.omit({ ownerId: true });
const JobAccepted = z.object({ jobId: z.string().uuid(), state: z.string() });
const WorkerHealth = z.object({ status: z.literal('PARTIAL'), runtime: z.literal('docker'), dependencyInstall: z.literal(false) });

function requiredConfig(): { url: string; token: string } {
  if (process.env.AIRA_BUILDER_ENABLED !== 'true') throw new Error('APPLICATION_BUILD_NOT_ENABLED');
  const url = process.env.AIRA_BUILD_WORKER_URL || '';
  const token = process.env.AIRA_BUILD_WORKER_TOKEN || '';
  if (token.length < 32) throw new Error('APPLICATION_BUILD_WORKER_TOKEN_NOT_CONFIGURED');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'))) {
    throw new Error('APPLICATION_BUILD_WORKER_REQUIRES_HTTPS');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('INVALID_WORKER_ENDPOINT');
  }
  return { url: parsed.origin, token };
}

export class ApplicationBuildClient {
  readonly config: { url: string; token: string };
  constructor(config = requiredConfig()) { this.config = config; }

  private async request(path: string, ownerId: string, payload?: unknown): Promise<unknown> {
    const res = await fetch(this.config.url + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + this.config.token,
        'x-aira-owner': ownerId,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    });
    const data = await res.json();
    if (!res.ok) throw new Error('BUILD_WORKER_HTTP_' + res.status + ': ' + String((data as { error?: string }).error || 'Request failed'));
    return data;
  }
  async health(): Promise<boolean> {
    const data = await this.request('/health', 'health-probe');
    WorkerHealth.parse(data);
    return true;
  }
  async create(input: BuildRequest): Promise<string> {
    const valid = BuildInput.parse(input);
    const result = await this.request('/v1/jobs', valid.ownerId, valid);
    return JobAccepted.parse(result).jobId;
  }
  async inspect(jobId: string, ownerId: string): Promise<BuildJob> {
    const result = await this.request('/v1/jobs/' + encodeURIComponent(jobId), ownerId);
    return result as BuildJob;
  }
  async awaitTerminal(jobId: string, ownerId: string, maxWaitMs = 50_000): Promise<BuildJob> {
    const stopAt = Date.now() + maxWaitMs;
    while (Date.now() < stopAt) {
      const result = await this.inspect(jobId, ownerId);
      if (result.state === 'BUILD_PASSED' || result.state === 'FAILED' || result.state === 'BLOCKED') return result;
      await new Promise(resolve => setTimeout(resolve, 850));
    }
    throw new Error('BUILD_STILL_RUNNING: ' + jobId);
  }
}

/**
 * Real configured provider only. A model must emit a structured project, never
 * a chat tutorial. The generator does not claim the output compiles until the
 * isolated worker executes the requested steps.
 */
export async function generateApplicationDraft(
  prompt: string,
  modelRouter: ModelRouter,
  policy: ModelPolicy
): Promise<z.infer<typeof BuildDraft>> {
  if (modelRouter.listProviders().length === 0 || policy.model === 'mock-deterministic') {
    throw new Error('APPLICATION_BUILD_MODEL_NOT_CONFIGURED');
  }
  const adapter = modelRouter.getAdapter(policy);
  const response = await adapter.complete([
    { role: 'system', content:
      'You are writing a real self-contained browser application. Return a single JSON object only: ' +
      '{"files":[{"path":"index.html","content":"..."},{"path":"app.js","content":"..."},' +
      '{"path":"test.js","content":"..."},{"path":"package.json","content":"..."}],' +
      '"steps":["syntax","build","test"]}. ' +
      'Do not use external packages, CDNs, fetch, remote assets, npm dependencies or imports from third-party modules. ' +
      'Use package.json scripts build and test with built-in Node only. Keep all browser assets relative. ' +
      'Include executable Node assertions in test.js. Render the requested user interactions in index.html/app.js. ' +
      'Generated tests are not independent product acceptance evidence. Do not output Markdown fences or commentary.'
    },
    { role: 'user', content: prompt.slice(0, 8_000) }
  ], policy);
  const raw = response.text.trim();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('APPLICATION_BUILD_GENERATION_NOT_VALID_JSON'); }
  const draft = BuildDraft.parse(parsed);
  const paths = new Set(draft.files.map(f => f.path));
  if (!paths.has('index.html') || !paths.has('package.json') || !paths.has('test.js')) {
    throw new Error('APPLICATION_BUILD_MISSING_REQUIRED_FILES');
  }
  if (draft.steps.join(',') !== 'syntax,build,test') {
    throw new Error('APPLICATION_BUILD_INVALID_EXECUTION_PLAN');
  }
  const pkg = draft.files.find(f => f.path === 'package.json');
  try {
    const value = JSON.parse(pkg!.content) as { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object };
    if (!value.scripts?.build || !value.scripts?.test ||
        Object.keys(value.dependencies || {}).length > 0 ||
        Object.keys(value.devDependencies || {}).length > 0) {
      throw new Error('APPLICATION_BUILD_UNSUPPORTED_DEPENDENCIES_OR_SCRIPTS');
    }
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'APPLICATION_BUILD_BAD_PACKAGE_MANIFEST');
  }
  return draft;
}
