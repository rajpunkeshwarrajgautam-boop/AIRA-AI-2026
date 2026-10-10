import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, lstat, stat, rm } from 'node:fs/promises';
import { resolve, relative, extname, join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createSourceArchive } from './archive.js';
import { validateOfflineDependencyLock, validateApprovedDependencySpecs, approvedLockfileKey } from './dependencies.js';
import { collectCompiledPreview, type PreviewFile } from './preview-output.js';

const execFileAsync = promisify(execFile);
const SourceFile = z.object({
  path: z.string().min(1).max(160),
  content: z.string().max(256_000)
}).strict();
export const BuildInput = z.object({
  ownerId: z.string().min(1).max(120),
  idempotencyKey: z.string().regex(/^[a-zA-Z0-9:_-]{1,180}$/).optional(),
  files: z.array(SourceFile).min(1).max(50),
  steps: z.tuple([z.literal('syntax'), z.literal('build'), z.literal('test')])
}).strict();

export type BuildRequest = z.infer<typeof BuildInput>;
/** Stable, owner-scoped remote job identifier for recovery after lost responses. */
export function stableBuildJobId(ownerId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(ownerId + '\0' + idempotencyKey).digest('hex');
  return digest.slice(0, 8) + '-' + digest.slice(8, 12) + '-4' + digest.slice(13, 16) +
    '-a' + digest.slice(17, 20) + '-' + digest.slice(20, 32);
}
export type BuildState = 'QUEUED' | 'RUNNING' | 'BUILD_PASSED' | 'FAILED' | 'BLOCKED' | 'CANCELLED';
export interface BuildJob {
  id: string;
  ownerId: string;
  idempotencyKey?: string;
  requestDigest?: string;
  state: BuildState;
  createdAt: number;
  updatedAt: number;
  steps: Array<{ name: string; exitCode: number | null; output: string }>;
  error?: string;
  manifest?: Array<{ path: string; sha256: string }>;
  previewManifest?: PreviewFile[];
  previewMode?: 'compiled' | 'source';
  previewTicket?: string;
  previewUrl?: string;
}
export interface WorkerConfig {
  root: string;
  token: string;
  port: number;
  previewPort: number;
  previewOrigin: string;
  frameOrigin: string;
  image: string;
  npmCache?: string;
  approvedPackages?: Record<string, string>;
}
export const workerConfig = (): WorkerConfig => ({
  root: process.env.AIRA_WORKER_ROOT || '/tmp/aira-build-worker',
  token: process.env.AIRA_WORKER_TOKEN || '',
  port: Number(process.env.AIRA_WORKER_PORT || 4101),
  previewPort: Number(process.env.AIRA_WORKER_PREVIEW_PORT || 4102),
  previewOrigin: process.env.AIRA_WORKER_PREVIEW_ORIGIN || 'http://127.0.0.1:4102',
  frameOrigin: process.env.AIRA_WORKER_FRAME_ORIGIN || 'http://127.0.0.1:5173',
  image: process.env.AIRA_WORKER_IMAGE || 'node:24-alpine',
  npmCache: process.env.AIRA_WORKER_NPM_CACHE || undefined,
  approvedPackages: JSON.parse(process.env.AIRA_WORKER_APPROVED_PACKAGES_JSON || '{}') as Record<string, string>
});

function safePath(root: string, file: string): string {
  if (!/^[a-zA-Z0-9_.\/-]+$/.test(file) || file.startsWith('/') || file.split('/').some(p => p === '..' || p === '' || p.startsWith('.')) ||
      file.includes('\\') || file.length > 160) {
    throw new Error('INVALID_PROJECT_PATH');
  }
  const result = resolve(root, file);
  if (!result.startsWith(resolve(root) + sep)) throw new Error('INVALID_PROJECT_PATH');
  return result;
}
export { safePath as validateProjectPath };

async function noSymlinkParents(root: string, filename: string): Promise<void> {
  const rel = relative(root, filename).split(sep);
  let current = root;
  for (const segment of rel) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (info?.isSymbolicLink()) throw new Error('SYMLINK_REJECTED');
  }
}
function denyDangerousSource(paths: string[]): void {
  if (new Set(paths).size !== paths.length) throw new Error('DUPLICATE_FILES');
  for (const p of paths) {
    if (/^(?:job-state\.json|node_modules|dist|\.env|\.git)(?:\/|$)/i.test(p)) {
      throw new Error('RESERVED_PROJECT_PATH');
    }
  }
}
function timingSafeToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp'
};

export class DockerProjectWorker {
  private jobs = new Map<string, BuildJob>();
  private tickets = new Map<string, { jobId: string; expires: number }>();
  private active = 0;
  private controllers = new Map<string, AbortController>();
  constructor(readonly config: WorkerConfig) {
    if (config.token.length < 32) throw new Error('WORKER_TOKEN_TOO_SHORT');
    if (!Number.isInteger(config.port) || !Number.isInteger(config.previewPort) || config.port === config.previewPort) throw new Error('INVALID_WORKER_PORTS');
    if (process.getuid?.() === 0) throw new Error('WORKER_MUST_NOT_RUN_AS_ROOT');
    if (new URL(config.previewOrigin).origin !== config.previewOrigin) throw new Error('INVALID_PREVIEW_ORIGIN');
    if (new URL(config.frameOrigin).origin !== config.frameOrigin) throw new Error('INVALID_FRAME_ORIGIN');
  }

  private async persist(job: BuildJob): Promise<void> {
    job.updatedAt = Date.now();
    await writeFile(join(this.config.root, '_state', job.id + '.json'), JSON.stringify(job), { mode: 0o600 });
  }
  async initialize(): Promise<void> {
    // Production must run on a reviewed rootless Docker daemon with an
    // immutable runtime image. CI/dev may test rootful Docker but may not
    // report production sandbox isolation certification.
    if (process.env.NODE_ENV === 'production') {
      if (!/@sha256:[a-f0-9]{64}$/.test(this.config.image)) {
        throw new Error('PRODUCTION_WORKER_IMAGE_DIGEST_REQUIRED');
      }
      if (new URL(this.config.previewOrigin).protocol !== 'https:' ||
          new URL(this.config.frameOrigin).protocol !== 'https:') {
        throw new Error('PRODUCTION_PREVIEW_HTTPS_REQUIRED');
      }
      const info = await execFileAsync('docker', ['info', '--format', '{{json .SecurityOptions}}'], {
        timeout: 8_000, maxBuffer: 8192
      });
      let options: unknown;
      try { options = JSON.parse(info.stdout); }
      catch { throw new Error('DOCKER_SECURITY_OPTIONS_UNAVAILABLE'); }
      if (!Array.isArray(options) || !options.some(item => typeof item === 'string' && /(?:^|=)rootless(?:$|,)/.test(item))) {
        throw new Error('PRODUCTION_REQUIRES_ROOTLESS_DOCKER');
      }
    }
    await mkdir(this.config.root, { recursive: true, mode: 0o700 });
    await mkdir(join(this.config.root, '_state'), { recursive: true, mode: 0o700 });
    if (this.config.approvedPackages) {
      for (const [name, version] of Object.entries(this.config.approvedPackages)) {
        if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
            !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
          throw new Error('INVALID_APPROVED_PACKAGE_CONFIGURATION');
        }
      }
      if (Object.keys(this.config.approvedPackages).length && !this.config.npmCache) {
        throw new Error('APPROVED_PACKAGES_REQUIRE_OFFLINE_CACHE');
      }
    }
    if (this.config.npmCache) {
      if (!this.config.npmCache.startsWith('/')) throw new Error('NPM_CACHE_MUST_BE_ABSOLUTE');
      const source = resolve(this.config.npmCache);
      if (source.startsWith(resolve(this.config.root) + sep)) throw new Error('NPM_CACHE_MUST_BE_OUTSIDE_PROJECTS');
      const info = await lstat(source);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('NPM_CACHE_NOT_TRUSTED_DIRECTORY');
    }
    // A previously running job cannot be assumed to have succeeded after a crash.
    for (const name of await readdir(this.config.root)) {
      if (!/^[0-9a-f-]{36}$/.test(name)) continue;
      const file = join(this.config.root, '_state', name + '.json');
      try {
        const record = JSON.parse(await readFile(file, 'utf8')) as BuildJob;
        if (!record.ownerId || !record.id) continue;
        if (record.state === 'RUNNING' || record.state === 'QUEUED') {
          record.state = 'BLOCKED';
          record.error = 'WORKER_INTERRUPTED_REQUIRES_RECONCILIATION';
          record.previewTicket = undefined;
          record.previewUrl = undefined;
          await writeFile(file, JSON.stringify(record), { mode: 0o600 });
        }
        // Tickets are process-local bearer capabilities. After restart they are
        // no longer valid and must not appear as functioning previews.
        record.previewTicket = undefined;
        record.previewUrl = undefined;
        this.jobs.set(name, record);
      } catch { /* unrelated files are not trusted */ }
    }
  }
  getJob(id: string, ownerId: string): BuildJob | undefined {
    const job = this.jobs.get(id);
    if (!job || job.ownerId !== ownerId) return undefined;
    return { ...job, steps: [...job.steps] };
  }
  private async docker(workspace: string, args: string[], signal: AbortSignal): Promise<{ exitCode: number; output: string }> {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (!uid || gid === undefined) throw new Error('DEDICATED_UNPRIVILEGED_WORKER_REQUIRED');
    // Docker runs only on the separately deployed trusted worker, never on the AIRA API host.
    // Only fixed commands are passed as argv; never invoke a shell.
    const containerName = 'aira-build-' + randomUUID().replaceAll('-', '');
    const dockerArgs = [
      'run', '--name', containerName, '--rm', '--network', 'none', '--read-only', '--init',
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
      '--pids-limit', '64', '--memory', '512m', '--cpus', '1',
      '--user', String(uid) + ':' + String(gid),
      '--env', 'HOME=/tmp', '--env', 'npm_config_cache=/tmp/.npm',
      '--tmpfs', '/tmp:rw,nosuid,size=64m',
      '--mount', 'type=bind,src=' + workspace + ',dst=/workspace',
      ...(this.config.npmCache ? ['--mount', 'type=bind,src=' + resolve(this.config.npmCache) + ',dst=/npm-cache,readonly'] : []),
      '--workdir', '/workspace',
      this.config.image, ...args
    ];
    try {
      const out = await execFileAsync('docker', dockerArgs, {
        timeout: 45_000, maxBuffer: 256_000, windowsHide: true, signal
      });
      return { exitCode: 0, output: (out.stdout + '\n' + out.stderr).slice(-8_000) };
    } catch (error: unknown) {
      // A timed-out Docker CLI must not leave an untracked build container running.
      await execFileAsync('docker', ['rm', '-f', containerName], { timeout: 5_000, maxBuffer: 4096 }).catch(() => {});
      const e = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      return { exitCode: typeof e.code === 'number' ? e.code : 1,
        output: String(e.stdout || '') .slice(-4000) + '\n' + String(e.stderr || e.message || '').slice(-4000) };
    }
  }
  async submit(input: BuildRequest): Promise<BuildJob> {
    const validated = BuildInput.parse(input);
    denyDangerousSource(validated.files.map(f => f.path));
    const requestDigest = createHash('sha256').update(JSON.stringify({
      ownerId: validated.ownerId, files: validated.files, steps: validated.steps
    })).digest('hex');
    const id = validated.idempotencyKey
      ? stableBuildJobId(validated.ownerId, validated.idempotencyKey)
      : randomUUID();
    const already = this.jobs.get(id);
    if (already) {
      if (already.ownerId !== validated.ownerId || already.requestDigest !== requestDigest ||
          already.idempotencyKey !== validated.idempotencyKey) {
        throw new Error('BUILD_IDEMPOTENCY_CONFLICT');
      }
      return { ...already, steps: [...already.steps] };
    }
    if (this.active >= 2) throw new Error('WORKER_CAPACITY_EXCEEDED');
    if (validated.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > 1_000_000) throw new Error('PROJECT_SIZE_EXCEEDED');
    const root = resolve(this.config.root, id);
    for (const f of validated.files) safePath(root, f.path);
    // Stable directory creation is an atomic cross-request guard. Do not delete
    // an existing keyed workspace when a concurrent request loses the race.
    this.active += 1;
    let created = false;
    try {
      await mkdir(root, { recursive: false, mode: 0o700 });
      created = true;
      for (const f of validated.files) {
        const target = safePath(root, f.path);
        await noSymlinkParents(root, target);
        await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
        await writeFile(target, f.content, { flag: 'wx', mode: 0o600 });
      }
      const job: BuildJob = {
        id, ownerId: validated.ownerId, idempotencyKey: validated.idempotencyKey,
        requestDigest, state: 'QUEUED',
        createdAt: Date.now(), updatedAt: Date.now(), steps: [],
        manifest: validated.files.map(f => ({ path: f.path, sha256: createHash('sha256').update(f.content).digest('hex') }))
      };
      this.jobs.set(id, job);
      await this.persist(job);
      const controller = new AbortController();
      this.controllers.set(id, controller);
      void this.execute(job, validated, root, controller.signal).finally(() => {
        this.controllers.delete(id);
        this.active -= 1;
      });
      return { ...job };
    } catch (error) {
      this.active -= 1;
      if (created) await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
  private async execute(job: BuildJob, request: BuildRequest, root: string, signal: AbortSignal): Promise<void> {
    try {
      if (signal.aborted) return;
      job.state = 'RUNNING';
      await this.persist(job);
      // Trusted-cache mode enables reproducible dependencies without outbound
      // networking in user-code containers. npm lifecycle scripts are disabled.
      const pkg = request.files.find(f => f.path === 'package.json');
      if (pkg) {
        const data = JSON.parse(pkg.content) as { dependencies?: object; devDependencies?: object };
        const hasDeps = Boolean(Object.keys(data.dependencies || {}).length || Object.keys(data.devDependencies || {}).length);
        if (hasDeps) {
          if (!this.config.npmCache) throw new Error('DEPENDENCY_INSTALL_NOT_CONFIGURED');
          validateApprovedDependencySpecs(pkg.content, this.config.approvedPackages || {});
          const lock = request.files.find(f => f.path === 'package-lock.json');
          let lockText = lock?.content;
          if (!lockText) {
            // An offline cache can contain package bytes without the registry
            // metadata required for lockfile resolution. A reviewed lockfile
            // template is supplied by the operator OUTSIDE untrusted code.
            const key = approvedLockfileKey(pkg.content);
            const approvedFile = join(this.config.npmCache, 'approved-locks', key + '.json');
            const approvedInfo = await lstat(approvedFile).catch(() => null);
            if (!approvedInfo?.isFile() || approvedInfo.isSymbolicLink() || approvedInfo.size > 500_000) {
              throw new Error('APPROVED_LOCKFILE_NOT_PROVISIONED');
            }
            const template = JSON.parse(await readFile(approvedFile, 'utf8')) as Record<string, unknown>;
            lockText = JSON.stringify(template);
            validateOfflineDependencyLock(pkg.content, lockText);
            await writeFile(join(root, 'package-lock.json'), lockText, { flag: 'wx', mode: 0o600 });
            job.steps.push({ name: 'resolve', exitCode: 0, output: 'Loaded validated operator-curated lockfile template; no network resolution performed.' });
            job.manifest?.push({
              path: 'package-lock.json',
              sha256: createHash('sha256').update(lockText).digest('hex')
            });
            await this.persist(job);
          }
          validateOfflineDependencyLock(pkg.content, lockText);
          const result = await this.docker(root, [
            'npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
            '--cache', '/npm-cache'
          ], signal);
          if (signal.aborted) throw new Error('BUILD_CANCELLED');
          job.steps.push({ name: 'install', exitCode: result.exitCode, output: result.output });
          await this.persist(job);
          if (result.exitCode !== 0) throw new Error('DEPENDENCY_INSTALL_FAILED');
        }
      }
      for (const step of request.steps) {
        if (signal.aborted) throw new Error('BUILD_CANCELLED');
        let argv: string[];
        if (step === 'syntax') {
          const js = request.files.find(f => f.path.endsWith('.js'));
          if (!js) throw new Error('NO_JAVASCRIPT_FILE_FOR_SYNTAX_CHECK');
          argv = ['node', '--check', js.path];
        } else {
          if (!pkg) throw new Error('PACKAGE_JSON_REQUIRED_FOR_NPM_SCRIPTS');
          const scripts = (JSON.parse(pkg.content) as { scripts?: Record<string, string> }).scripts || {};
          if (!scripts[step]) throw new Error('SCRIPT_NOT_DEFINED_' + step.toUpperCase());
          argv = ['npm', 'run', step, '--offline'];
        }
        const result = await this.docker(root, argv, signal);
        if (signal.aborted) throw new Error('BUILD_CANCELLED');
        job.steps.push({ name: step, exitCode: result.exitCode, output: result.output });
        await this.persist(job);
        if (result.exitCode !== 0) throw new Error('STEP_FAILED_' + step.toUpperCase());
      }
      if (signal.aborted) throw new Error('BUILD_CANCELLED');
      const compiled = await collectCompiledPreview(root);
      const index = request.files.find(f => f.path === 'index.html');
      if (!compiled && !index) throw new Error('STATIC_PREVIEW_REQUIRES_INDEX_HTML');
      job.previewMode = compiled ? 'compiled' : 'source';
      job.previewManifest = compiled || job.manifest;
      job.state = 'BUILD_PASSED'; // Build steps passed only; not functional gameplay certification.
      const ticket = randomBytes(24).toString('hex');
      this.tickets.set(ticket, { jobId: job.id, expires: Date.now() + 15 * 60_000 });
      job.previewTicket = ticket;
      job.previewUrl = this.config.previewOrigin + '/p/' + ticket + '/index.html';
      await this.persist(job);
    } catch (err: unknown) {
      job.state = signal.aborted ? 'CANCELLED' : 'FAILED';
      job.error = signal.aborted ? 'BUILD_CANCELLED' : (err instanceof Error ? err.message : String(err));
      job.previewTicket = undefined;
      job.previewUrl = undefined;
      await this.persist(job);
    }
  }
  async cancelJob(id: string, ownerId: string): Promise<BuildJob | undefined> {
    const job = this.jobs.get(id);
    if (!job || job.ownerId !== ownerId) return undefined;
    if (job.state === 'QUEUED' || job.state === 'RUNNING') {
      job.state = 'CANCELLED';
      job.error = 'BUILD_CANCELLED';
      job.previewTicket = undefined;
      job.previewUrl = undefined;
      for (const [ticket, grant] of this.tickets) if (grant.jobId === id) this.tickets.delete(ticket);
      this.controllers.get(id)?.abort();
      await this.persist(job);
    }
    return this.getJob(id, ownerId);
  }
  private authenticate(req: IncomingMessage): boolean {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') && timingSafeToken(header.slice(7), this.config.token);
  }
  private async json(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk as Uint8Array);
      length += bytes.byteLength;
      if (length > 1_100_000) throw new Error('REQUEST_TOO_LARGE');
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  }
  controlServer() {
    return createServer(async (req, res) => {
      if (req.url === '/health' && req.method === 'GET') {
        if (!this.authenticate(req)) return this.send(res, 401, { error: 'UNAUTHORIZED' });
        return this.send(res, 200, { status: 'PARTIAL', runtime: 'docker', network: 'none', dependencyInstall: Boolean(this.config.npmCache && Object.keys(this.config.approvedPackages || {}).length), approvedPackages: this.config.npmCache ? (this.config.approvedPackages || {}) : {} });
      }
      if (!this.authenticate(req)) return this.send(res, 401, { error: 'UNAUTHORIZED' });
      const owner = req.headers['x-aira-owner'];
      if (!owner || Array.isArray(owner)) return this.send(res, 400, { error: 'OWNER_REQUIRED' });
      if (req.url === '/v1/jobs' && req.method === 'POST') {
        try {
          const body = BuildInput.parse(await this.json(req));
          if (body.ownerId !== owner) return this.send(res, 403, { error: 'OWNER_MISMATCH' });
          const job = await this.submit(body);
          return this.send(res, 202, { jobId: job.id, state: job.state });
        } catch (err: unknown) {
          return this.send(res, 400, { error: err instanceof Error ? err.message : 'INVALID_JOB' });
        }
      }
      // Export immutable compiled dist bytes through the authenticated
      // control plane, never through a public or model-controlled file path.
      const compiledMatch = req.url?.match(/^\/v1\/jobs\/([0-9a-f-]{36})\/compiled$/);
      if (compiledMatch && req.method === 'GET') {
        const job = this.getJob(compiledMatch[1], owner);
        if (!job || job.state !== 'BUILD_PASSED' || job.previewMode !== 'compiled' ||
            !job.previewManifest?.length) {
          return this.send(res, 404, { error: 'COMPILED_OUTPUT_NOT_AVAILABLE' });
        }
        try {
          const archive = await createSourceArchive(
            resolve(this.config.root, job.id, 'dist'), job.previewManifest,
            { maxFileBytes: 1_500_000, maxTotalBytes: 8_000_000, maxFiles: 200 }
          );
          res.writeHead(200, {
            'Content-Type': 'application/gzip',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
          });
          res.end(archive);
        } catch {
          this.send(res, 409, { error: 'COMPILED_OUTPUT_INTEGRITY_FAILED' });
        }
        return;
      }
      const sourceMatch = req.url?.match(/^\/v1\/jobs\/([0-9a-f-]{36})\/source$/);
      if (sourceMatch && req.method === 'GET') {
        const job = this.getJob(sourceMatch[1], owner);
        if (!job || job.state !== 'BUILD_PASSED' || !job.manifest) {
          return this.send(res, 404, { error: 'SOURCE_NOT_AVAILABLE' });
        }
        try {
          const archive = await createSourceArchive(resolve(this.config.root, job.id), job.manifest);
          res.writeHead(200, {
            'Content-Type': 'application/gzip',
            'Content-Disposition': 'attachment; filename="aira-project-source.tar.gz"',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
          });
          res.end(archive);
        } catch (err: unknown) {
          return this.send(res, 409, { error: err instanceof Error ? err.message : 'EXPORT_ERROR' });
        }
        return;
      }
      const match = req.url?.match(/^\/v1\/jobs\/([0-9a-f-]{36})$/);
      if (match && req.method === 'DELETE') {
        const job = await this.cancelJob(match[1], owner);
        if (!job) return this.send(res, 404, { error: 'JOB_NOT_FOUND' });
        return this.send(res, 200, job);
      }
      if (match && req.method === 'GET') {
        const job = this.getJob(match[1], owner);
        if (!job) return this.send(res, 404, { error: 'JOB_NOT_FOUND' });
        return this.send(res, 200, job);
      }
      this.send(res, 404, { error: 'NOT_FOUND' });
    });
  }
  previewServer() {
    return createServer(async (req, res) => {
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy',
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors " + this.config.frameOrigin);
      const match = req.url?.match(/^\/p\/([a-f0-9]{48})\/([a-zA-Z0-9_./-]+)$/);
      if (!match || req.method !== 'GET') return this.send(res, 404, { error: 'NOT_FOUND' });
      const grant = this.tickets.get(match[1]);
      if (!grant || grant.expires <= Date.now()) return this.send(res, 404, { error: 'PREVIEW_EXPIRED' });
      const job = this.jobs.get(grant.jobId);
      if (!job || job.state !== 'BUILD_PASSED') return this.send(res, 404, { error: 'PREVIEW_NOT_BUILD_PASSED' });
      if (!job.previewManifest?.some(f => f.path === match[2])) return this.send(res, 404, { error: 'PREVIEW_FILE_UNAUTHORIZED' });
      try {
        const sourceRoot = resolve(this.config.root, grant.jobId, ...(job.previewMode === 'compiled' ? ['dist'] : []));
        const filename = safePath(sourceRoot, match[2]);
        await noSymlinkParents(sourceRoot, filename);
        const meta = await stat(filename);
        if (!meta.isFile() || meta.size > 1_000_000) throw new Error('INVALID_PREVIEW_FILE');
        const mime = contentTypes[extname(filename)];
        if (!mime) throw new Error('UNSUPPORTED_PREVIEW_CONTENT');
        const originalHash = job.previewManifest?.find(f => f.path === match[2])?.sha256;
        const bytes = await readFile(filename);
        if (!originalHash || createHash('sha256').update(bytes).digest('hex') !== originalHash) {
          throw new Error('PREVIEW_SOURCE_CHANGED');
        }
        res.writeHead(200, { 'Content-Type': mime });
        res.end(bytes);
      } catch {
        this.send(res, 404, { error: 'PREVIEW_FILE_NOT_FOUND' });
      }
    });
  }
  async closeJob(jobId: string, owner: string): Promise<void> {
    const job = this.getJob(jobId, owner);
    if (!job || job.state === 'RUNNING' || job.state === 'QUEUED') throw new Error('JOB_NOT_CLEANABLE');
    for (const [key, value] of this.tickets) if (value.jobId === jobId) this.tickets.delete(key);
    this.jobs.delete(jobId);
    await rm(resolve(this.config.root, jobId), { recursive: true, force: true });
    await rm(join(this.config.root, '_state', jobId + '.json'), { force: true });
  }
}

if (process.argv[1]?.endsWith('/worker.ts') || process.argv[1]?.endsWith('\\worker.ts')) {
  const worker = new DockerProjectWorker(workerConfig());
  worker.initialize().then(() => {
    worker.controlServer().listen(worker.config.port, '127.0.0.1', () => {
      console.log('AIRA_BUILD_WORKER_CONTROL_READY');
    });
    worker.previewServer().listen(worker.config.previewPort, '127.0.0.1', () => {
      console.log('AIRA_BUILD_WORKER_PREVIEW_READY');
    });
  }).catch(err => { console.error(err); process.exitCode = 1; });
}
