import assert from 'node:assert/strict';
import { searchWeb, configuredSearchProviders, WebSearchError } from '../packages/tool-runtime/src/search-providers.js';

type StubResponse = { ok: boolean; results?: any[] };
function mockFetch(responses: StubResponse[], calls: Array<{ url: string; options: RequestInit }>): typeof fetch {
  return (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), options: options || {} });
    const next = responses.shift();
    if (!next) throw new Error('Unexpected request');
    return { ok: next.ok, json: async () => ({ results: next.results ?? [] }) } as Response;
  }) as typeof fetch;
}

async function main(): Promise<void> {
  const credentials = { tavilyApiKey: 'test-tavily-key', exaApiKey: 'test-exa-key' };
  assert.deepEqual(configuredSearchProviders(credentials), ['tavily', 'exa']);
  assert.deepEqual(configuredSearchProviders({ exaApiKey: 'test-exa-key' }), ['exa']);

  // Primary provider supplies the answer; Exa must not be called.
  const primaryCalls: Array<{ url: string; options: RequestInit }> = [];
  const primary = await searchWeb('latest technology', credentials, mockFetch([
    { ok: true, results: [{ title: 'Verified page', url: 'https://example.org/article', content: 'Public data.' }] }
  ], primaryCalls));
  assert.equal(primary.provider, 'tavily');
  assert.equal(primary.results[0].snippet, 'Public data.');
  assert.equal(primaryCalls.length, 1);
  assert.equal(primaryCalls[0].url, 'https://api.tavily.com/search');
  assert.equal((primaryCalls[0].options.headers as Record<string, string>).Authorization, 'Bearer test-tavily-key');
  assert.equal(JSON.parse(String(primaryCalls[0].options.body)).search_depth, 'basic');

  // Tavily HTTP failure leads to Exa fixture evidence.
  const fallbackCalls: Array<{ url: string; options: RequestInit }> = [];
  const fallback = await searchWeb('scientific research', credentials, mockFetch([
    { ok: false },
    { ok: true, results: [{ title: 'Exa page', url: 'https://example.com/research', text: 'Article text' }] }
  ], fallbackCalls));
  assert.equal(fallback.provider, 'exa');
  assert.equal(fallback.results[0].snippet, 'Article text');
  assert.equal(fallbackCalls[1].url, 'https://api.exa.ai/search');
  assert.equal((fallbackCalls[1].options.headers as Record<string, string>)['x-api-key'], 'test-exa-key');
  assert.equal(JSON.parse(String(fallbackCalls[1].options.body)).numResults, 5);

  // Empty or invalid evidence also triggers fallback.
  const emptyCalls: Array<{ url: string; options: RequestInit }> = [];
  const fromEmpty = await searchWeb('climate', credentials, mockFetch([
    { ok: true, results: [{ title: 'Invalid result', url: 'javascript:alert(1)' }] },
    { ok: true, results: [{ title: 'Valid result', url: 'https://example.com/climate', text: 'Evidence' }] }
  ], emptyCalls));
  assert.equal(fromEmpty.provider, 'exa');
  assert.equal(emptyCalls.length, 2);

  // Provider credentials missing: no network calls, typed error.
  await assert.rejects(
    () => searchWeb('latest technology', {}, mockFetch([], [])),
    (error: unknown) => error instanceof WebSearchError && error.code === 'SEARCH_PROVIDER_NOT_READY'
  );

  // Both providers fail: return typed unavailable error rather than invented citations.
  await assert.rejects(
    () => searchWeb('latest technology', credentials, mockFetch([{ ok: false }, { ok: false }], [])),
    (error: unknown) => error instanceof WebSearchError && error.code === 'SEARCH_PROVIDER_UNAVAILABLE' &&
      !String(error.message).includes('test-exa-key')
  );

  // Exa works independently if Tavily is not configured.
  const exaOnly = await searchWeb('medical literature', { exaApiKey: 'test-exa-key' }, mockFetch([
    { ok: true, results: [{ title: 'Paper', url: 'https://example.org/paper', text: 'A source' }] }
  ], []));
  assert.equal(exaOnly.provider, 'exa');

  // Explicit provider selection must never silently certify a fallback provider.
  const selectedExaCalls: Array<{ url: string; options: RequestInit }> = [];
  const selectedExa = await searchWeb('owned provider fixture', credentials, mockFetch([
    { ok: true, results: [{ url: 'https://example.org/source', text: 'Fixture evidence' }] }
  ], selectedExaCalls), { provider: 'exa' });
  assert.equal(selectedExa.provider, 'exa');
  assert.equal(selectedExaCalls.length, 1);
  assert.equal(selectedExaCalls[0].url, 'https://api.exa.ai/search');
  const selectedTavilyCalls: Array<{ url: string; options: RequestInit }> = [];
  await assert.rejects(searchWeb('owned provider fixture', credentials, mockFetch([{ ok: false }], selectedTavilyCalls), { provider: 'tavily' }),
    (error: unknown) => error instanceof WebSearchError && error.code === 'SEARCH_PROVIDER_UNAVAILABLE');
  assert.equal(selectedTavilyCalls.length, 1, 'Selected Tavily failure must not call Exa');
  await assert.rejects(searchWeb('owned provider fixture', { exaApiKey: 'test-exa-key' }, mockFetch([], []), { provider: 'tavily' }),
    (error: unknown) => error instanceof WebSearchError && error.code === 'SEARCH_PROVIDER_NOT_READY');

  console.log('PASS: Tavily primary, Exa fallback, empty/invalid evidence, Exa-only, and fail-closed errors.');
}

main().catch(error => {
  console.error('Search provider certification failed:', error);
  process.exitCode = 1;
});
