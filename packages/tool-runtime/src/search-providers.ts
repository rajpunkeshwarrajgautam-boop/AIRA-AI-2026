/**
 * Live web-search providers for Aira. No SDK or credentials are bundled in the client.
 * Tavily is preferred; Exa is attempted only when Tavily has no usable evidence.
 */
export type SearchProviderName = 'tavily' | 'exa';

export interface SearchCredentials {
  tavilyApiKey?: string;
  exaApiKey?: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface SearchResponse {
  provider: SearchProviderName;
  results: SearchHit[];
}

export class WebSearchError extends Error {
  constructor(public readonly code: 'SEARCH_PROVIDER_NOT_READY' | 'SEARCH_PROVIDER_UNAVAILABLE') {
    super(code);
    this.name = 'WebSearchError';
  }
}

export function readSearchCredentials(): SearchCredentials {
  return {
    tavilyApiKey: process.env.TAVILY_API_KEY,
    exaApiKey: process.env.EXA_API_KEY
  };
}

export function configuredSearchProviders(credentials: SearchCredentials = readSearchCredentials()): SearchProviderName[] {
  const providers: SearchProviderName[] = [];
  if (credentials.tavilyApiKey?.trim()) providers.push('tavily');
  if (credentials.exaApiKey?.trim()) providers.push('exa');
  return providers;
}

function cleanSearchText(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHits(raw: unknown): SearchHit[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.url !== 'string') continue;
    let url: URL;
    try {
      url = new URL(candidate.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      if (url.username || url.password) continue;
    } catch {
      continue;
    }
    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const snippet = typeof candidate.content === 'string' ? candidate.content :
      typeof candidate.text === 'string' ? candidate.text :
      typeof candidate.snippet === 'string' ? candidate.snippet :
      typeof candidate.description === 'string' ? candidate.description : '';
    const rawDate = candidate.publishedDate ?? candidate.published_date ?? candidate.published_at;
    const publishedDate = typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rawDate)
      ? rawDate.slice(0, 10) : undefined;
    const rawTitle = typeof candidate.title === 'string' ? candidate.title : url.hostname;
    hits.push({
      title: cleanSearchText(rawTitle).slice(0, 250) || url.hostname,
      url: normalized,
      snippet: cleanSearchText(snippet).slice(0, 1400),
      ...(publishedDate ? { publishedDate } : {})
    });
    if (hits.length >= 5) break;
  }
  return hits;
}

async function tavilySearch(query: string, apiKey: string, fetcher: typeof fetch): Promise<SearchHit[]> {
  const response = await fetcher('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      query, search_depth: 'basic', topic: 'general', max_results: 5,
      include_answer: false, include_raw_content: false
    }),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new WebSearchError('SEARCH_PROVIDER_UNAVAILABLE');
  const body = await response.json() as { results?: unknown };
  return normalizeHits(body.results);
}

async function exaSearch(query: string, apiKey: string, fetcher: typeof fetch): Promise<SearchHit[]> {
  const response = await fetcher('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      query, type: 'auto', numResults: 5,
      contents: { text: { maxCharacters: 1200 } }
    }),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new WebSearchError('SEARCH_PROVIDER_UNAVAILABLE');
  const body = await response.json() as { results?: unknown };
  return normalizeHits(body.results);
}

/**
 * Falls back on timeout, HTTP failure, invalid responses, or no usable results.
 * Provider errors are intentionally opaque to avoid logging keys or API bodies.
 */
export async function searchWeb(
  query: string,
  credentials: SearchCredentials = readSearchCredentials(),
  fetcher: typeof fetch = fetch
): Promise<SearchResponse> {
  const text = query.trim().slice(0, 500);
  if (!text) throw new WebSearchError('SEARCH_PROVIDER_UNAVAILABLE');

  const providers = configuredSearchProviders(credentials);
  if (providers.length === 0) throw new WebSearchError('SEARCH_PROVIDER_NOT_READY');

  for (const provider of providers) {
    try {
      const hits = provider === 'tavily'
        ? await tavilySearch(text, credentials.tavilyApiKey!.trim(), fetcher)
        : await exaSearch(text, credentials.exaApiKey!.trim(), fetcher);
      if (hits.length > 0) return { provider, results: hits };
    } catch {
      // Use next configured provider, without leaking upstream error bodies.
    }
  }
  throw new WebSearchError('SEARCH_PROVIDER_UNAVAILABLE');
}
