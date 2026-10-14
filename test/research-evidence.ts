
import assert from 'node:assert/strict';
import { ResearchService } from '../packages/agent-runtime/src/research.js';
import { searchWeb } from '../packages/tool-runtime/src/search-providers.js';
import { buildResearchEvidenceContext, buildResearchSourcesAppendix, isResearchToolCallDump, renderGroundedResearchFallback, verifiedSearchCitationsFromToolResults } from '../packages/agent-runtime/src/research-evidence.js';

async function run() {
  const credentials = { tavilyApiKey: 'stub-primary', exaApiKey: 'stub-fallback' };
  const upstream: string[] = [];
  const mockFetch = (async (url: string | URL | Request) => {
    upstream.push(String(url));
    const records = String(url).includes('api.tavily')
      ? [{ title: 'NASA official update', url: 'https://www.nasa.gov/artemis-ii/', content: 'Mission information from the official website.', published_date: '2026-10-07' },
         { title: 'NASA Mission briefing', url: 'https://www.nasa.gov/mission/artemis-ii/', content: 'Additional official mission information.' }]
      : [];
    return { ok: true, json: async () => ({ results: records }) } as Response;
  }) as typeof fetch;
  const result = await searchWeb('latest Artemis II', credentials, mockFetch);
  assert.equal(result.provider, 'tavily');
  assert.equal(upstream.length, 1, 'A single successful search must not endlessly retry');
  assert.equal(result.results[0].publishedDate, '2026-10-07');

  let toolCalls = 0;
  const toolRegistry = {
    get: () => ({ definition: { id: 'tool_web_search' } }),
    execute: async () => {
      toolCalls++;
      return { isError: false, output: result, toolCallId: 'test', timestamp: Date.now(), durationMs: 0 };
    }
  } as any;
  const knowledge = { search: async () => [] } as any;
  const originalTavily = process.env.TAVILY_API_KEY;
  const originalExa = process.env.EXA_API_KEY;
  try {
    process.env.TAVILY_API_KEY = 'test-key';
    process.env.EXA_API_KEY = 'test-key';
    const research = await new ResearchService(toolRegistry, knowledge).executeResearch({
      prompt: 'Research latest official NASA Artemis II updates with sources', runId: 'test-research'
    });
    assert.equal(research.providerReady, true);
    assert.equal(toolCalls, 1);
    assert.equal(research.toolResults.length, 1, 'Executed result must persist');
    assert.equal(research.citations.length, 2);
    assert.equal(research.citations[0].publishedDate, '2026-10-07');
    const context = buildResearchEvidenceContext(research.citations);
    assert.match(context, /Mission information from the official website/);
    assert.match(context, /2026-10-07/);
    assert.match(context, /Do not generate JSON search requests/);
    const appendix = buildResearchSourcesAppendix(research.citations);
    assert.match(appendix, /\[NASA official update\]\(https:\/\/www\.nasa\.gov\/artemis-ii\/\)/);
    assert.match(appendix, /Published: not provided by search provider/);
    assert.equal(isResearchToolCallDump('The mission overview is here.'), false);
    const loop = Array.from({length:74}, (_, i) => JSON.stringify({
      query:'NASA Artemis II search '+i, region:'us-en', max_results:10, pages:1, source:'any'
    })).join('\n\n');
    assert.equal(isResearchToolCallDump(loop), true, 'Repeated model search JSON is not an answer');
    assert.match(renderGroundedResearchFallback(research.citations), /retrieved excerpts/);
    assert.ok(!buildResearchSourcesAppendix([{ ...research.citations[0], provenance: undefined }]).includes('nasa.gov'),
      'Never identify fabricated citations as verified web evidence');

    const toolEvidence = verifiedSearchCitationsFromToolResults(
      [{ id: 'call_real', name: 'web_search', arguments: { query: 'NASA' }, timestamp: 123 } as any],
      [{ toolCallId: 'call_real', timestamp: 124, isError: false, output: result } as any]
    );
    assert.equal(toolEvidence.length, 2);
    assert.equal(toolEvidence[0].provenance?.toolCallId, 'call_real');
    assert.equal(toolEvidence[0].uri, 'https://www.nasa.gov/artemis-ii/');
    assert.equal(verifiedSearchCitationsFromToolResults(
      [{ id: 'failed', name: 'web_search', arguments: {}, timestamp: 123 } as any],
      [{ toolCallId: 'failed', timestamp: 123, isError: true, output: result } as any]
    ).length, 0, 'Failed calls never generate verifiable citations');
    assert.equal(verifiedSearchCitationsFromToolResults(
      [{ id: 'not_web', name: 'calculator', arguments: {}, timestamp: 123 } as any],
      [{ toolCallId: 'not_web', timestamp: 123, isError: false, output: result } as any]
    ).length, 0);
    assert.equal(isResearchToolCallDump('{"tool":"web_search","args":{"query":"NASA Artemis II"}}'), true);
    assert.equal(isResearchToolCallDump('[{"tool":"exa_search","args":{"query":"NASA"}},{"tool":"web_search","args":{"query":"moon"}}]'), true);
    assert.equal(isResearchToolCallDump('The mission needs primary NASA sources.'), false);
    // Results may arrive out of order; the original implementation paired by
    // array index, allowing the wrong search request to certify source evidence.
    const orderedCalls = [
      { id: 'call_alpha', name: 'web_search', arguments: {}, timestamp: 100 },
      { id: 'call_beta', name: 'calculator', arguments: {}, timestamp: 101 }
    ] as any;
    const unrelatedReceipt = [{ toolCallId: 'call_beta', timestamp: 120, isError: false, output: result }] as any;
    assert.equal(verifiedSearchCitationsFromToolResults(orderedCalls, unrelatedReceipt).length, 0,
      'Calculator output cannot be promoted to web evidence because of matching position');
    assert.equal(verifiedSearchCitationsFromToolResults(orderedCalls, [
      { toolCallId: 'forged-unrelated-id', timestamp: 120, isError: false, output: result }
    ] as any).length, 0, 'Unmatched receipt cannot certify a citation');
    assert.equal(verifiedSearchCitationsFromToolResults(orderedCalls, [
      { toolCallId: 'call_alpha_retry_1', timestamp: 120, isError: false, output: result }
    ] as any)[0].provenance?.toolCallId, 'call_alpha_retry_1');
    assert.equal(verifiedSearchCitationsFromToolResults(orderedCalls, [
      { toolCallId: 'call_alpha_fallback_exa_search', timestamp: 120, isError: false, output: result }
    ] as any)[0].provenance?.toolCallId, 'call_alpha_fallback_exa_search');
    assert.equal(verifiedSearchCitationsFromToolResults(orderedCalls, [
      { toolCallId: 'call_alpha_fallback_browser_navigate', timestamp: 120, isError: false, output: result }
    ] as any).length, 0, 'Unapproved fallback tool cannot become verified web evidence');

    console.log('PASS: live source propagation, executed-tool evidence, and JSON suppression');
  } finally {
    if (originalTavily === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalTavily;
    if (originalExa === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = originalExa;
  }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
