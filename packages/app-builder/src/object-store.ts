import { createHash, createHmac } from 'node:crypto';

export type ArtifactKind = 'source' | 'compiled' | 'test-evidence';
export interface ObjectStoreSettings {
  endpoint: string; region: string; bucket: string;
  accessKeyId: string; secretAccessKey: string;
}
export interface ImmutableObjectRef {
  key: string; sha256: string; size: number; contentType: string;
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest();
const keyPattern = /^aira-build\/v1\/[0-9a-f]{32}\/(?:source|compiled|test-evidence)\/[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const contentTypes: Record<ArtifactKind, string> = {
  source: 'application/gzip', compiled: 'application/gzip',
  'test-evidence': 'application/json'
};

export function objectStoreFromEnvironment(): S3ImmutableObjectStore | undefined {
  const names = [
    'AIRA_OBJECT_STORE_ENDPOINT', 'AIRA_OBJECT_STORE_REGION', 'AIRA_OBJECT_STORE_BUCKET',
    'AIRA_OBJECT_STORE_ACCESS_KEY_ID', 'AIRA_OBJECT_STORE_SECRET_ACCESS_KEY'
  ] as const;
  const values = names.map(name => process.env[name] || '');
  if (values.every(x => !x)) return undefined;
  if (values.some(x => !x)) throw new Error('OBJECT_STORE_CONFIGURATION_INCOMPLETE');
  return new S3ImmutableObjectStore({
    endpoint: values[0], region: values[1], bucket: values[2],
    accessKeyId: values[3], secretAccessKey: values[4]
  });
}

/**
 * Private S3-compatible object store with no generated-code egress or
 * additional npm dependencies. Uses AWS Signature V4 on every request.
 * Objects are immutable, owner-keyed and content-addressed.
 */
export class S3ImmutableObjectStore {
  private endpoint: URL;
  constructor(private settings: ObjectStoreSettings) {
    const parsed = new URL(settings.endpoint);
    if (parsed.protocol !== 'https:' &&
        !(process.env.NODE_ENV === 'test' && parsed.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) {
      throw new Error('OBJECT_STORE_HTTPS_REQUIRED');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(settings.bucket) ||
        !/^[a-z0-9-]{2,40}$/.test(settings.region) ||
        settings.accessKeyId.length < 3 || settings.secretAccessKey.length < 16) {
      throw new Error('INVALID_OBJECT_STORE_CONFIGURATION');
    }
    this.endpoint = parsed;
  }
  private objectUrl(key: string): URL {
    if (!keyPattern.test(key)) throw new Error('INVALID_OBJECT_KEY');
    // Path-style URL; reject endpoint query and encoded path input.
    return new URL('/' + this.settings.bucket + '/' + key, this.endpoint);
  }
  private async request(method: 'PUT' | 'GET' | 'DELETE',
    key: string, body?: Buffer, extra: Record<string, string> = {}): Promise<Response> {
    const url = this.objectUrl(key);
    const now = new Date();
    const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = stamp.slice(0, 8);
    const payloadHash = digest(body || Buffer.alloc(0));
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': stamp,
      ...extra
    };
    const names = Object.keys(headers).map(x => x.toLowerCase()).sort();
    const canonicalHeaders = names.map(name => name + ':' + headers[name].trim().replace(/\s+/g, ' ') + '\n').join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [
      method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash
    ].join('\n');
    const scope = day + '/' + this.settings.region + '/s3/aws4_request';
    const toSign = 'AWS4-HMAC-SHA256\n' + stamp + '\n' + scope + '\n' +
      createHash('sha256').update(canonicalRequest).digest('hex');
    let secret = hmac('AWS4' + this.settings.secretAccessKey, day);
    secret = hmac(secret, this.settings.region);
    secret = hmac(secret, 's3');
    secret = hmac(secret, 'aws4_request');
    const signature = createHmac('sha256', secret).update(toSign).digest('hex');
    const response = await fetch(url, {
      method, body: body ? new Uint8Array(body) : undefined,
      headers: {
        ...headers,
        authorization: 'AWS4-HMAC-SHA256 Credential=' + this.settings.accessKeyId +
          '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
      },
      signal: AbortSignal.timeout(20_000),
      redirect: 'error'
    });
    return response;
  }
  async put(ownerId: string, kind: ArtifactKind, bytes: Buffer): Promise<ImmutableObjectRef> {
    if (!ownerId || ownerId.length > 160 || !Buffer.isBuffer(bytes) ||
        bytes.length === 0 || bytes.length > 32_000_000 || !(kind in contentTypes)) {
      throw new Error('INVALID_ARTIFACT_UPLOAD');
    }
    const ownerHash = createHash('sha256').update(ownerId).digest('hex').slice(0, 32);
    const sha256 = digest(bytes);
    const key = 'aira-build/v1/' + ownerHash + '/' + kind + '/' + sha256;
    const response = await this.request('PUT', key, bytes, {
      'content-type': contentTypes[kind],
      'if-none-match': '*',
      'x-amz-meta-sha256': sha256
    });
    if (response.status === 412 || response.status === 409) {
      // Immutable duplicate is acceptable only when existing bytes match.
      const existing = await this.get({ key, sha256, size: bytes.length, contentType: contentTypes[kind] });
      if (!existing.equals(bytes)) throw new Error('ARTIFACT_IMMUTABILITY_CONFLICT');
    } else if (!response.ok) {
      throw new Error('OBJECT_STORE_UPLOAD_FAILED_' + response.status);
    }
    return { key, sha256, size: bytes.length, contentType: contentTypes[kind] };
  }
  async get(ref: ImmutableObjectRef): Promise<Buffer> {
    if (!keyPattern.test(ref.key) || !shaPattern.test(ref.sha256) ||
        !ref.key.endsWith('/' + ref.sha256) ||
        !Number.isSafeInteger(ref.size) || ref.size <= 0 || ref.size > 32_000_000) {
      throw new Error('INVALID_ARTIFACT_REFERENCE');
    }
    const response = await this.request('GET', ref.key);
    if (!response.ok) throw new Error('OBJECT_STORE_DOWNLOAD_FAILED_' + response.status);
    const reported = Number(response.headers.get('content-length'));
    if (reported > 32_000_000) throw new Error('OBJECT_STORE_OBJECT_TOO_LARGE');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== ref.size || digest(bytes) !== ref.sha256) {
      throw new Error('OBJECT_STORE_INTEGRITY_FAILED');
    }
    return bytes;
  }
}
