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

export interface FirecrawlCrawlResult {
  pages: Array<{ url: string; title: string; markdown: string }>;
  totalScraped: number;
}

export interface FirecrawlResearchReport {
  query: string;
  title: string;
  executiveSummary: string;
  evidence: Array<{ url: string; title: string; excerpt: string }>;
  generatedAt: string;
  tenantId?: string;
}

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
   * SSRF Prevention & Safe URL Validation:
   * Blocks access to loopback, link-local, private RFC1918 ranges, and cloud metadata services.
   */
  public isSafeUrl(urlString: string): boolean {
    try {
      const parsed = new URL(urlString);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
      }

      const host = parsed.hostname.toLowerCase();

      // Block local/loopback
      if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host === '[::1]') {
        return false;
      }

      // Block AWS/GCP/Azure link-local metadata
      if (host === '169.254.169.254' || host === 'metadata.google.internal' || host === 'metadata') {
        return false;
      }

      // Block IPv4 private address ranges (RFC 1918 & RFC 3927)
      const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (ipv4Match) {
        const octet1 = parseInt(ipv4Match[1], 10);
        const octet2 = parseInt(ipv4Match[2], 10);

        if (octet1 === 10) return false; // 10.0.0.0/8
        if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return false; // 172.16.0.0/12
        if (octet1 === 192 && octet2 === 168) return false; // 192.168.0.0/16
        if (octet1 === 127) return false; // 127.0.0.0/8
        if (octet1 === 169 && octet2 === 254) return false; // 169.254.0.0/16
        if (octet1 === 0) return false;
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
    options?: { limit?: number; tenantId?: string }
  ): Promise<FirecrawlSearchResult[]> {
    if (!this.isEnabled()) {
      throw new Error('FIRECRAWL_DISABLED: Firecrawl research adapter is not enabled in this environment.');
    }

    const cleanQuery = (query || '').trim();
    if (!cleanQuery) return [];

    const limit = Math.min(options?.limit ?? 5, 10);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

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
        throw new Error(`Firecrawl search failed with HTTP ${response.status}`);
      }

      const data = await response.json();
      const results: FirecrawlSearchResult[] = [];

      for (const item of data?.data || []) {
        if (item.url && this.isSafeUrl(item.url)) {
          results.push({
            title: item.title || item.url,
            url: item.url,
            snippet: (item.description || item.markdown || '').slice(0, 1000),
            provenance: 'firecrawl_search'
          });
        }
      }

      return results;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Chat & Agent Mode: Clean single-page markdown extraction.
   */
  public async scrape(
    url: string,
    options?: { tenantId?: string }
  ): Promise<FirecrawlScrapeResult> {
    if (!this.isEnabled()) {
      throw new Error('FIRECRAWL_DISABLED: Firecrawl research adapter is not enabled in this environment.');
    }

    if (!this.isSafeUrl(url)) {
      throw new Error(`SSRF_PROHIBITED: URL "${url}" violates internal IP/metadata boundary rules.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

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
        throw new Error(`Firecrawl scrape failed with HTTP ${response.status}`);
      }

      const data = await response.json();
      const markdown = data?.data?.markdown || '';

      return {
        url,
        title: data?.data?.metadata?.title || url,
        markdown: markdown.slice(0, 50000), // Bound size
        metadata: data?.data?.metadata || {},
        quarantined: true // Retained as untrusted external data
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Agent Mode: Bounded multi-page crawl.
   */
  public async crawl(
    url: string,
    options?: { maxDepth?: number; limit?: number; tenantId?: string }
  ): Promise<FirecrawlCrawlResult> {
    if (!this.isEnabled()) {
      throw new Error('FIRECRAWL_DISABLED: Firecrawl research adapter is not enabled in this environment.');
    }

    if (!this.isSafeUrl(url)) {
      throw new Error(`SSRF_PROHIBITED: URL "${url}" violates internal IP/metadata boundary rules.`);
    }

    const maxDepth = Math.min(options?.maxDepth ?? this.maxDepth, 2);
    const limit = Math.min(options?.limit ?? 5, 10);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

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
        throw new Error(`Firecrawl crawl initiation failed with HTTP ${response.status}`);
      }

      const data = await response.json();
      const pages = (data?.data || []).map((p: any) => ({
        url: p.url,
        title: p.title || p.url,
        markdown: (p.markdown || '').slice(0, 30000)
      }));

      return {
        pages,
        totalScraped: pages.length
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Agent Mode: Multi-source research report generation.
   */
  public async generateResearchReport(
    query: string,
    options?: { tenantId?: string }
  ): Promise<FirecrawlResearchReport> {
    const searchResults = await this.search(query, { limit: 5, tenantId: options?.tenantId });
    const evidence = searchResults.map(r => ({
      url: r.url,
      title: r.title,
      excerpt: r.snippet.slice(0, 300)
    }));

    return {
      query,
      title: `Research Report: ${query}`,
      executiveSummary: `Synthesized analysis from ${evidence.length} authoritative web sources.`,
      evidence,
      generatedAt: new Date().toISOString(),
      tenantId: options?.tenantId
    };
  }
}
