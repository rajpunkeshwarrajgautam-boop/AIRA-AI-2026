import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';

/** Integrates the existing PR #42–45 Docker build worker, rather than running code on the API host. */
const SourceFileSchema = z.object({
  path: z.string().min(1).max(160),
  content: z.string().max(256_000)
}).strict();
export const IsolatedBuildInputSchema = z.object({
  files: z.array(SourceFileSchema).min(1).max(50),
  steps: z.tuple([z.literal('syntax'), z.literal('build'), z.literal('test')])
}).strict();
export type IsolatedBuildInput = z.infer<typeof IsolatedBuildInputSchema>;
const JobSchema = z.object({
  id: z.string().uuid(), ownerId: z.string().min(1), idempotencyKey: z.string().optional(),
  state: z.enum(['QUEUED', 'RUNNING', 'BUILD_PASSED', 'FAILED', 'BLOCKED', 'CANCELLED']),
  error: z.string().optional(),
  steps: z.array(z.object({ name: z.string(), exitCode: z.number().nullable(), output: z.string() })).default([]),
  manifest: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).optional()
}).passthrough();
export type IsolatedBuildJob = z.infer<typeof JobSchema>;
type Config = { origin: string; token: string };
const terminal = new Set(['BUILD_PASSED', 'FAILED', 'BLOCKED', 'CANCELLED']);
function hash(s: string): string { return createHash('sha256').update(s).digest('hex'); }

export function validateSourceFiles(raw: unknown): IsolatedBuildInput {
  const input = IsolatedBuildInputSchema.parse(raw);
  const names = new Set<string>(); let bytes = 0;
  for (const f of input.files) {
    if (!/^[a-zA-Z0-9_.\/-]+$/.test(f.path) || f.path.startsWith('/') ||
      f.path.split('/').some(part => !part || part === '..' || part.startsWith('.')) ||
      f.path.includes('\\') || names.has(f.path)) throw new Error('ISOLATED_BUILD_UNSAFE_FILE_PATH');
    names.add(f.path);
    bytes += Buffer.byteLength(f.content);
  }
  if (bytes > 1_000_000) throw new Error('ISOLATED_BUILD_INPUT_TOO_LARGE');
  if (!names.has('package.json') || ![...names].some(name => name.endsWith('.js'))) {
    throw new Error('ISOLATED_BUILD_MISSING_RUNNABLE_SOURCE');
  }
  return input;
}
export function isolatedBuildConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.AIRA_ISOLATED_BUILD_ENABLED !== 'true') throw new Error('ISOLATED_BUILD_DISABLED');
  const token = env.AIRA_BUILD_WORKER_TOKEN || '';
  if (token.length < 32) throw new Error('ISOLATED_BUILD_WORKER_TOKEN_REQUIRED');
  let parsed: URL;
  try { parsed = new URL(env.AIRA_BUILD_WORKER_URL || ''); }
  catch { throw new Error('ISOLATED_BUILD_WORKER_URL_REQUIRED'); }
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!(parsed.protocol === 'https:' || (env.NODE_ENV !== 'production' && localhost && parsed.protocol === 'http:')) ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('ISOLATED_BUILD_WORKER_ENDPOINT_REJECTED');
  }
  return { origin: parsed.origin, token };
}
export function stableIsolatedBuildJobId(ownerId: string, idempotencyKey: string): string {
  const h = hash(ownerId + '\0' + idempotencyKey);
  return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);
}

/** Strict ustar reader for the source archive produced by the existing worker. */
export function verifyBuildArchive(
  packed: Buffer, manifest: Array<{ path: string; sha256: string }>,
  requested: IsolatedBuildInput
): { fileCount: number; sourceDigest: string } {
  if (packed.length > 1_500_000) throw new Error('ISOLATED_BUILD_ARCHIVE_TOO_LARGE');
  const tar = gunzipSync(packed, { maxOutputLength: 2_000_000 });
  const expected = new Map(requested.files.map(f => [f.path, hash(f.content)]));
  const listed = new Map(manifest.map(f => [f.path, f.sha256]));
  if (listed.size !== manifest.length || listed.size < expected.size ||
      [...expected].some(([name,digest]) => listed.get(name) !== digest)) {
    throw new Error('ISOLATED_BUILD_MANIFEST_MISMATCH');
  }
  let offset = 0;
  const seen = new Set<string>();
  while (offset + 512 <= tar.length) {
    const hdr = tar.subarray(offset,offset+512);
    if (hdr.every(c => c === 0)) break;
    const name = hdr.subarray(0,100).toString('utf8').split('\0')[0];
    const octalSize = hdr.subarray(124,136).toString('ascii').replace(/\0.*$/,'').trim();
    if (!/^[0-7]+$/.test(octalSize) || hdr[156] !== 48 ||
        !/^[a-zA-Z0-9_.\/-]{1,100}$/.test(name) ||
        name.startsWith('/') || name.split('/').some(p=>!p || p==='..' || p.startsWith('.')) ||
        seen.has(name)) throw new Error('ISOLATED_BUILD_INVALID_ARCHIVE_ENTRY');
    const size = parseInt(octalSize,8);
    if (size > 256_000 || offset+512+size > tar.length) throw new Error('ISOLATED_BUILD_ARCHIVE_BOUNDS');
    const body = tar.subarray(offset+512,offset+512+size);
    if (!listed.has(name) || hash(body.toString('utf8')) !== listed.get(name)) {
      throw new Error('ISOLATED_BUILD_ARCHIVE_CONTENT_MISMATCH');
    }
    seen.add(name);
    offset+=512+Math.ceil(size/512)*512;
    if(seen.size>50)throw new Error('ISOLATED_BUILD_TOO_MANY_FILES');
  }
  if (seen.size!==listed.size || [...listed.keys()].some(k=>!seen.has(k))) {
    throw new Error('ISOLATED_BUILD_ARCHIVE_INCOMPLETE');
  }
  return {fileCount:seen.size,sourceDigest:hash(tar.toString('base64'))};
}

export class IsolatedBuildBridge {
  private readonly config: Config;
  constructor(config: Config = isolatedBuildConfig()) { this.config=config; }
  private async request(path: string, ownerId: string, payload?: unknown, binary=false): Promise<unknown> {
    const res=await fetch(this.config.origin+path,{
      method:payload===undefined?'GET':'POST',
      headers:{Authorization:'Bearer '+this.config.token,'x-aira-owner':ownerId,
        ...(payload===undefined?{}:{'Content-Type':'application/json'})},
      body:payload===undefined?undefined:JSON.stringify(payload),
      signal:AbortSignal.timeout(15000)
    });
    if(res.status===404)throw new Error('ISOLATED_BUILD_JOB_NOT_FOUND');
    if(!res.ok)throw new Error('ISOLATED_BUILD_REMOTE_HTTP_'+res.status);
    if(binary){
      if(Number(res.headers.get('content-length')||'0')>1_500_000)throw new Error('ISOLATED_BUILD_ARCHIVE_TOO_LARGE');
      const buf=Buffer.from(await res.arrayBuffer());
      if(buf.length>1_500_000)throw new Error('ISOLATED_BUILD_ARCHIVE_TOO_LARGE');
      return buf;
    }
    return res.json();
  }
  async inspect(jobId: string, ownerId: string): Promise<IsolatedBuildJob> {
    if(!/^[0-9a-f-]{36}$/.test(jobId))throw new Error('ISOLATED_BUILD_INVALID_JOB');
    return JobSchema.parse(await this.request('/v1/jobs/'+jobId,ownerId));
  }
  /**
   * Submit once, reconciling after a lost response via stable job identity.
   * No duplicate remote creation is attempted after ambiguous errors.
   * Only a real BUILD_PASSED plus successful source readback can return verified.
   */
  async execute(ownerId: string, runId: string, raw: unknown, maxWaitMs=20000):
    Promise<{status:'BUILD_VERIFIED';jobId:string;ownerId:string;sourceDigest:string;fileCount:number;steps:string[]}> {
    if(!ownerId || !runId || ownerId.length>120 || runId.length>120)throw new Error('ISOLATED_BUILD_MISSING_VERIFIED_OWNER');
    const input=validateSourceFiles(raw);
    const idempotencyKey='aira_'+hash(runId+'\0'+JSON.stringify(input)).slice(0,48);
    const expectedId=stableIsolatedBuildJobId(ownerId,idempotencyKey);
    let job: IsolatedBuildJob;
    try {
      job=await this.inspect(expectedId,ownerId);
    } catch(e){
      if(!(e instanceof Error) || e.message!=='ISOLATED_BUILD_JOB_NOT_FOUND')throw e;
      try{
        const ack=await this.request('/v1/jobs',ownerId,{
          ownerId,idempotencyKey,...input
        }) as {jobId?:string};
        if(ack.jobId!==expectedId)throw new Error('ISOLATED_BUILD_JOB_ID_MISMATCH');
      } catch(e) {
        // Request may have reached the worker. Reconcile rather than blindly POST again.
        try { await this.inspect(expectedId,ownerId); }
        catch { throw e; }
      }
      job=await this.inspect(expectedId,ownerId);
    }
    const deadline=Date.now()+Math.min(Math.max(maxWaitMs,0),30000);
    while(!terminal.has(job.state)&&Date.now()<deadline) {
      await new Promise(r=>setTimeout(r,600));
      job=await this.inspect(expectedId,ownerId);
    }
    if(!terminal.has(job.state))throw new Error('ISOLATED_BUILD_PENDING: '+expectedId);
    if(job.state!=='BUILD_PASSED')throw new Error('ISOLATED_BUILD_'+job.state+': '+(job.error||expectedId));
    if(job.ownerId!==ownerId || job.id!==expectedId || job.idempotencyKey!==idempotencyKey ||
      !job.manifest?.length || !['syntax','build','test'].every(name =>
        job.steps.some(s=>s.name===name&&s.exitCode===0))) {
      throw new Error('ISOLATED_BUILD_EVIDENCE_INVALID');
    }
    const source=await this.request('/v1/jobs/'+expectedId+'/source',ownerId,undefined,true) as Buffer;
    const archive=verifyBuildArchive(source,job.manifest,input);
    return {status:'BUILD_VERIFIED',jobId:job.id,ownerId,sourceDigest:archive.sourceDigest,
      fileCount:archive.fileCount,steps:['syntax','build','test']};
  }
}
