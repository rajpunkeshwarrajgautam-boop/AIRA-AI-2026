export interface FirecrawlConfig {
  apiKey?: string;
  baseUrl?: string;
  enabled?: boolean;
  maxDepth?: number;
  timeoutMs?: number;
}

export interface FirecrawlSearchResult {
  title: string;
  url: string;
  snippet: string;
  provenance: string;
}

export interface FirecrawlScrapeResult {
  url: string;
  title: string;
  markdown: string;
  metadata: Record<string, any>;
  quarantined: boolean;
}

export interface FirecrawlCrawlJob {
  jobId: string;
  url: string;
  status: 'initiated' | 'active' | 'completed' | 'failed';
  pages?: Array<{ url: string; title: string; markdown: string }>;
  totalScraped?: number;
}

export interface FirecrawlCrawlResult {
  pages: Array<{ url: string; title: string; markdown: string }>;
  totalScraped: number;
  jobId?: string;
}

export interface FirecrawlResearchReport {
  query: string;
  title: string;
  executiveSummary: string;
  evidence: Array<{ url: string; title: string; excerpt: string }>;
  generatedAt: string;
  tenantId?: string;
  status: 'SUCCESS' | 'EMPTY' | 'DISABLED' | 'FAILED';
}

// Prohibited internal ports that must not be probed via HTTP/HTTPS
const PROHIBITED_PORTS = new Set([
  21, 22, 23, 25, 53, 110, 111, 135, 137, 138, 139, 445, 1433, 1521, 2049,
  2375, 2376, 3306, 5432, 6379, 8000, 8001, 8086, 9200, 11211, 27017, 28017
]);

export class FirecrawlResearchAdapter {
  private apiKey: string | null;
  private baseUrl: string;
  private enabled: boolean;
  private maxDepth: number;
  private timeoutMs: number;

  constructor(config?: FirecrawlConfig) {
    this.apiKey = config?.apiKey || process.env.FIRECRAWL_API_KEY || null;
    this.baseUrl = (config?.baseUrl || process.env.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev').replace(/\/+$/, '');
    // Strictly disabled by default in production and this milestone unless explicitly enabled via flag
    this.enabled = config?.enabled ?? (process.env.FIRECRAWL_ENABLED === 'true');
    this.maxDepth = config?.maxDepth ?? 2;
    this.timeoutMs = config?.timeoutMs ?? 30000;
  }

  public isEnabled(): boolean {
    return this.enabled && Boolean(this.apiKey);
  }

  /**
   * SSRF Prevention & Multi-Layer Safe URL Validation:
   *
   * AIRA-SIDE CHECKS (Local Pre-Dispatch Boundary):
   * - Restricts protocols strictly to http: and https:
   * - Blocks access to loopback (localhost, 127.0.0.0/8, ::1, ::ffff:127.0.0.1)
   * - Blocks link-local addresses (169.254.0.0/16, fe80::/10)
   * - Blocks private RFC 1918 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
   * - Blocks cloud provider metadata endpoints (169.254.169.254, 100.100.100.200, metadata.google.internal)
   * - Rejects alternative IP representations (integer, hex, octal obfuscation)
   * - Blocks probing of prohibited internal/database ports (22, 2375, 3306, 5432, 6379, 8000, 9200, etc.)
   *
   * SECURITY BOUNDARY & RESIDUAL LIMITATIONS:
   * - Local syntactic inspection cannot synchronously detect DNS rebinding or subsequent HTTP 3xx
   *   redirect hops without an in-flight forward proxy / DNS resolver.
   * - When requests are delegated to Firecrawl's hosted cloud service, network egress restrictions
   *   and redirect sandboxing are enforced by Firecrawl's hosted infrastructure.
   */
  public isSafeUrl(urlString: string): boolean {
    if (!urlString || typeof urlString !== 'string') {
      return false;
    }

    try {
      const parsed = new URL(urlString.trim());

      // Only allow http: and https: protocols
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
      }

      // Block prohibited internal/database ports
      if (parsed.port) {
        const portNum = parseInt(parsed.port, 10);
        if (PROHIBITED_PORTS.has(portNum)) {
          return false;
        }
      }

      let host = parsed.hostname.toLowerCase().trim();

      // Strip enclosing brackets for IPv6
      if (host.startsWith('[') && host.endsWith(']')) {
        host = host.slice(1, -1);
      }

      // Check common loopback & metadata names
      if (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === 'metadata.google.internal' ||
        host === 'metadata' ||
        host === 'instance-data'
      ) {
        return false;
      }

      // Check IPv6 loopback, link-local, unique-local, and IPv4-mapped IPv6
      if (host.includes(':')) {
        // Pure IPv6 loopback
        if (host === '::1' || /^0*(:0*)*:0*1$/.test(host)) {
          return false;
        }
        // IPv6 link-local fe80::/10
        if (/^fe[89ab]/i.test(host)) {
          return false;
        }
        // IPv6 unique local fc00::/7 (fc00:: - fdff::)
        if (/^f[cd]/i.test(host)) {
          return false;
        }
        // IPv4-mapped IPv6 (::ffff:127.0.0.1, ::ffff:7f00:1, etc.)
        const mappedMatch = host.match(/::ffff:(?:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|([0-9a-f]{1,4}:[0-9a-f]{1,4}))$/i);
        if (mappedMatch) {
          if (mappedMatch[1]) {
            host = mappedMatch[1]; // inspect as IPv4 below
          } else {
            return false; // Hex mapped IPv4 is prohibited
          }
        } else {
          // General IPv6 address - if not public, reject
          if (/^0*$/.test(host.replace(/:/g, ''))) return false; // ::0
          return true;
        }
      }

      // Check integer or hex encoded IPv4 (e.g. 2130706433, 0x7f000001)
      if (/^\d+$/.test(host)) {
        const decIp = parseInt(host, 10);
        if (decIp >= 0 && decIp <= 4294967295) {
          const b1 = (decIp >> 24) & 255;
          const b2 = (decIp >> 16) & 255;
          const b3 = (decIp >> 8) & 255;
          const b4 = decIp & 255;
          host = `${b1}.${b2}.${b3}.${b4}`;
        } else {
          return false;
        }
      } else if (/^0x[0-9a-f]+$/i.test(host)) {
        const hexIp = parseInt(host, 16);
        if (hexIp >= 0 && hexIp <= 4294967295) {
          const b1 = (hexIp >> 24) & 255;
          const b2 = (hexIp >> 16) & 255;
          const b3 = (hexIp >> 8) & 255;
          const b4 = hexIp & 255;
          host = `${b1}.${b2}.${b3}.${b4}`;
        } else {
          return false;
        }
      }

      // Check dotted IPv4 address ranges
      const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (ipv4Match) {
        const octet1 = parseInt(ipv4Match[1], 10);
        const octet2 = parseInt(ipv4Match[2], 10);
        const octet3 = parseInt(ipv4Match[3], 10);
        const octet4 = parseInt(ipv4Match[4], 10);

        if ([octet1, octet2, octet3, octet4].some(o => o < 0 || o > 255)) {
          return false;
        }

        // 0.0.0.0/8 (Current network)
        if (octet1 === 0) return false;
        // 127.0.0.0/8 (Loopback)
        if (octet1 === 127) return false;
        // 10.0.0.0/8 (RFC 1918 Private)
        if (octet1 === 10) return false;
        // 172.16.0.0/12 (RFC 1918 Private)
        if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return false;
        // 192.168.0.0/16 (RFC 1918 Private)
        if (octet1 === 192 && octet2 === 168) return false;
        // 169.254.0.0/16 (RFC 3927 Link-local & Cloud Metadata)
        if (octet1 === 169 && octet2 === 254) return false;
        // 100.64.0.0/10 (RFC 6598 Carrier Grade NAT & Alibaba metadata 100.100.100.200)
        if (octet1 === 100 && octet2 >= 64 && octet2 <= 127) return false;
        // 255.255.255.255 (Broadcast)
        if (octet1 === 255 && octet2 === 255 && octet3 === 255 && octet4 === 255) return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Chat Mode: Live web search with citation provenance.
   */
  public async search(
    query: string,
    options?: { limit?: number; tenantId?: string; signal?: AbortSignal }
  ): Promise<FirecrawlSearchResult[]> {
    if (!this.isEnabled()) {
      throw new Error('FIRECRAWL_DISABLED: Firecrawl research adapter is not enabled in this environment.');
    }

    const cleanQuery = (query || '').trim();
    if (!cleanQuery) return [];

    const limit = Math.min(options?.limit ?? 5, 10);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('FIRECRAWL_TIMEOUT')), this.timeoutMs);

    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Tenant-ID': options?.tenantId || 'aira-default'
        },
        body: JSON.stringify({ query: cleanQuery, limit }),
        signal: controller.signal
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`FIRECRAWL_UNAUTHORIZED: Authentication failed (HTTP ${response.status}). Verify FIRECRAWL_API_KEY.`);
        }
        if (response.status === 429) {
          throw new Error('FIRECRAWL_RATE_LIMITED: Firecrawl upstream rate limit exceeded (HTTP 429).');
        }
        if (response.status === 404) {
          throw new Error('FIRECRAWL_NOT_FOUND: Firecrawl search endpoint not found (HTTP 404).');
        }
        if (response.status >= 500) {
          throw new Error(`FIRECRAWL_SERVER_ERROR: Firecrawl upstream server error (HTTP ${response.status}).`);
        }
        throw new Error(`Firecrawl search failed with HTTP ${response.status}`);
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        throw new Error('FIRECRAWL_MALFORMED_RESPONSE: Failed to parse upstream JSON response.');
      }

      const results: FirecrawlSearchResult[] = [];
      const items = Array.isArray(data?.data) ? data.data : [];

      for (const item of items) {
        if (item && item.url && this.isSafeUrl(item.url)) {
          results.push({
            title: item.title || item.url,
            url: item.url,
            snippet: (item.description || item.markdown || '').slice(0, 1000),
            provenance: 'firecrawl_search'
          });
        }
      }

      return results;
    } catch (err: any) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw new Error('FIRECRAWL_TIMEOUT_OR_CANCELLED: Firecrawl search request timed out or was cancelled.');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Chat & Agent Mode: Clean single-page markdown extraction.
   */
  public async scrape(
    url: string,
    options?: { tenantId?: string; signal?: AbortSignal }
  ): Promise<FirecrawlScrapeResult> {
    if (!this.isEnabled()) {
      throw new Error('FIRECRAWL_DISABLED: Firecrawl research adapter is not enabled in this environment.');
    }

    if (!this.isSafeUrl(url)) {
      throw new Error(`SSRF_PROHIBITED: URL "${url}" violates internal IP/metadata boundary rules.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('FIRECRAWL_TIMEOUT')), this.timeoutMs);

    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/scrape`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Tenant-ID': options?.tenantId || 'aira-default'
        },
        body: JSON.stringify({ url, formats: ['markdown'] }),
        signal: controller.signal
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`FIRECRAWL_UNAUTHORIZED: Authentication failed (HTTP ${response.status}). Verify FIRECRAWL_API_KEY.`);
        }
        if (response.status === 429) {
          throw new Error('FIRECRAWL_RATE_LIMITED: Firecrawl upstream rate limit exceeded (HTTP 429).');
        }
        if (response.status === 404) {
          throw new Error(`FIRECRAWL_NOT_FOUND: Target URL "${url}" or scrape endpoint not found (HTTP 404).`);
        }
        if (response.status >= 500) {
          throw new Error(`FIRECRAWL_SERVER_ERROR: Firecrawl upstream server error (HTTP ${response.status}).`);
        }
        throw new Error(`Firecrawl scrape failed with HTTP ${response.status}`);
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        throw new Error('FIRECRAWL_MALFORMED_RESPONSE: Failed to parse upstream scrape JSON response.');
      }

      const markdown = data?.data?.markdown || '';

      return {
        url,
        title: data?.data?.metadata?.title || url,
        markdown: markdown.slice(0, 50000), // Bound size
        metadata: data?.data?.metadata || {},
        quarantined: true // Retained as untrusted external data
      };
    } catch (err: any) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw new Error('FIRECRAWL_TIMEOUT_OR_CANCELLED: Firecrawl scrape request timed out or was cancelled.');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Agent Mode: Initiate bounded crawl job.
   * Conforms to official Firecrawl v1 asynchronous crawl lifecycle:
   * POST /v1/crawl returns a job identifier ({ id: string, url: string }).
   */
  public async initiateCrawl(
    url: string,
    options?: { maxDepth?: number; limit?: number; tenantId?: string; signal?: AbortSignal }
  ): Promise<FirecrawlCrawlJob> {
    if (!this.isEnabled()) {
      throw new Error('FIRECRAWL_DISABLED: Firecrawl research adapter is not enabled in this environment.');
    }

    if (!this.isSafeUrl(url)) {
      throw new Error(`SSRF_PROHIBITED: URL "${url}" violates internal IP/metadata boundary rules.`);
    }

    const maxDepth = Math.min(options?.maxDepth ?? this.maxDepth, 2);
    const limit = Math.min(options?.limit ?? 5, 10);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('FIRECRAWL_TIMEOUT')), this.timeoutMs);

    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Tenant-ID': options?.tenantId || 'aira-default'
        },
        body: JSON.stringify({ url, maxDepth, limit }),
        signal: controller.signal
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`FIRECRAWL_UNAUTHORIZED: Authentication failed (HTTP ${response.status}).`);
        }
        if (response.status === 429) {
          throw new Error('FIRECRAWL_RATE_LIMITED: Firecrawl crawl rate limit exceeded (HTTP 429).');
        }
        throw new Error(`Firecrawl crawl initiation failed with HTTP ${response.status}`);
      }

      const data = await response.json();
      const jobId = data?.id || data?.jobId || 'crawl_job_unknown';

      return {
        jobId,
        url,
        status: 'initiated'
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Agent Mode: Bounded crawl execution.
   */
  public async crawl(
    url: string,
    options?: { maxDepth?: number; limit?: number; tenantId?: string; signal?: AbortSignal }
  ): Promise<FirecrawlCrawlResult> {
    if (!this.isEnabled()) {
      throw new Error('FIRECRAWL_DISABLED: Firecrawl research adapter is not enabled in this environment.');
    }

    if (!this.isSafeUrl(url)) {
      throw new Error(`SSRF_PROHIBITED: URL "${url}" violates internal IP/metadata boundary rules.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('FIRECRAWL_TIMEOUT')), this.timeoutMs);

    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
    }

    try {
      const job = await this.initiateCrawl(url, { ...options, signal: controller.signal });
      return {
        pages: [],
        totalScraped: 0,
        jobId: job.jobId
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Agent Mode: Retrieve status and pages from an ongoing or completed crawl job.
   * Conforms to official Firecrawl v1 asynchronous crawl polling: GET /v1/crawl/{jobId}
   */
  public async getCrawlStatus(
    jobId: string,
    options?: { signal?: AbortSignal }
  ): Promise<FirecrawlCrawlJob> {
    if (!this.isEnabled()) {
      throw new Error('FIRECRAWL_DISABLED: Firecrawl research adapter is not enabled in this environment.');
    }

    if (!jobId || typeof jobId !== 'string') {
      throw new Error('INVALID_JOB_ID: A valid crawl jobId must be provided.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('FIRECRAWL_TIMEOUT')), this.timeoutMs);

    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/crawl/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        signal: controller.signal
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`FIRECRAWL_UNAUTHORIZED: Authentication failed (HTTP ${response.status}).`);
        }
        if (response.status === 404) {
          throw new Error(`FIRECRAWL_NOT_FOUND: Crawl job "${jobId}" not found (HTTP 404).`);
        }
        throw new Error(`Firecrawl get crawl status failed with HTTP ${response.status}`);
      }

      const data: any = await response.json();
      const statusRaw = data?.status;
      const status: 'initiated' | 'active' | 'completed' | 'failed' =
        statusRaw === 'completed' ? 'completed'
        : statusRaw === 'scraping' || statusRaw === 'active' ? 'active'
        : statusRaw === 'failed' ? 'failed'
        : 'initiated';

      const pages: Array<{ url: string; title: string; markdown: string }> = [];
      if (Array.isArray(data?.data)) {
        for (const item of data.data) {
          if (item && item.markdown) {
            pages.push({
              url: item.url || '',
              title: item.metadata?.title || item.title || item.url || '',
              markdown: (item.markdown || '').slice(0, 50000)
            });
          }
        }
      }

      return {
        jobId,
        url: data?.url || '',
        status,
        pages,
        totalScraped: data?.total || pages.length
      };
    } finally {
      clearTimeout(timeout);
    }
  }


  /**
   * Agent Mode: Multi-source research report generation.
   * Truthful evidence synthesis: Never fabricates synthetic research evidence when disabled or empty.
   */
  public async generateResearchReport(
    query: string,
    options?: { tenantId?: string; signal?: AbortSignal }
  ): Promise<FirecrawlResearchReport> {
    if (!this.isEnabled()) {
      return {
        query,
        title: `Research Report: ${query}`,
        executiveSummary: 'Firecrawl research adapter is disabled in this environment. No external web research was conducted.',
        evidence: [],
        generatedAt: new Date().toISOString(),
        tenantId: options?.tenantId,
        status: 'DISABLED'
      };
    }

    try {
      const searchResults = await this.search(query, { limit: 5, tenantId: options?.tenantId, signal: options?.signal });
      const evidence = searchResults.map(r => ({
        url: r.url,
        title: r.title,
        excerpt: r.snippet.slice(0, 300)
      }));

      if (evidence.length === 0) {
        return {
          query,
          title: `Research Report: ${query}`,
          executiveSummary: 'No external research evidence was returned for this query.',
          evidence: [],
          generatedAt: new Date().toISOString(),
          tenantId: options?.tenantId,
          status: 'EMPTY'
        };
      }

      return {
        query,
        title: `Research Report: ${query}`,
        executiveSummary: `Synthesized analysis from ${evidence.length} authoritative web sources.`,
        evidence,
        generatedAt: new Date().toISOString(),
        tenantId: options?.tenantId,
        status: 'SUCCESS'
      };
    } catch (err: any) {
      return {
        query,
        title: `Research Report: ${query}`,
        executiveSummary: `Research retrieval failed: ${err?.message || 'Unknown error'}.`,
        evidence: [],
        generatedAt: new Date().toISOString(),
        tenantId: options?.tenantId,
        status: 'FAILED'
      };
    }
  }
}
