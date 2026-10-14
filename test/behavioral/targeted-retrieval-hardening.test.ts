import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Citation } from '../../packages/contracts/src/index.js';
import {
  sanitizeCitationMarkers,
  rankAndFilterWeatherCitations,
  evaluateEvidenceSufficiency,
  buildTargetedSearchQuery,
  resolveTradingSession,
  isEasternDaylightTime
} from '../../packages/agent-runtime/src/research-evidence.js';
import { renderMarkdownToHtml } from '../../src/utils/markdown.js';

describe('AIRA Targeted Retrieval & Temporal Accuracy — Regression & Defect Verification', () => {

  describe('Concern 1: Tracker Title or URL Alone Must Not Establish Worldwide Numerical Totals', () => {
    it('rejects Box Office Mojo / The Numbers URLs with text mentioning worldwide but lacking numerical totals', () => {
      const prompt = 'What is the worldwide gross of Avatar: Fire and Ash according to Box Office Mojo?';
      const nonNumericalCitations: Citation[] = [
        {
          id: 'c1',
          sourceId: 's1',
          sourceTitle: 'Avatar: Fire and Ash - Box Office Mojo Worldwide Overview',
          uri: 'https://www.boxofficemojo.com/title/tt1757678/',
          snippet: 'Check out worldwide release dates, theater counts, news, and cast information for the film.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        }
      ];

      const sufficiency = evaluateEvidenceSufficiency(prompt, nonNumericalCitations);
      assert.equal(
        sufficiency.isSufficient,
        false,
        'URL containing boxofficemojo and word "worldwide" without a dollar/number total must NOT be marked sufficient'
      );
      assert.equal(sufficiency.missingDimension, 'WORLDWIDE_TOTAL');
    });
  });

  describe('Concern 2: Multi-Tracker Comparison Requests Require Sufficiency for Each Requested Tracker', () => {
    it('marks evidence insufficient when prompt asks for Box Office Mojo AND The Numbers, but only one has worldwide totals', () => {
      const prompt = 'What is the worldwide gross of Avatar: Fire and Ash according to Box Office Mojo and The Numbers? Explain any reporting-date differences.';
      const singleTrackerCitations: Citation[] = [
        {
          id: 'c1',
          sourceId: 's1',
          sourceTitle: 'Avatar: Fire and Ash - Box Office Mojo',
          uri: 'https://www.boxofficemojo.com/title/tt1757678/',
          snippet: 'Worldwide gross: $1,485,999,890 as of October 11.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        },
        {
          id: 'c2',
          sourceId: 's2',
          sourceTitle: 'The Numbers - Domestic Daily Chart',
          uri: 'https://www.the-numbers.com/movie/Avatar-Fire-and-Ash#tab=box-office',
          snippet: 'Domestic daily tracking and weekend chart summaries for North American theaters.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        }
      ];

      const sufficiency = evaluateEvidenceSufficiency(prompt, singleTrackerCitations);
      assert.equal(
        sufficiency.isSufficient,
        false,
        'When prompt asks for both trackers, missing worldwide numerical data for The Numbers must trigger insufficient evidence'
      );
      assert.equal(sufficiency.missingDimension, 'WORLDWIDE_TOTAL');
    });

    it('marks evidence sufficient when both requested trackers contain numerical worldwide figures', () => {
      const prompt = 'What is the worldwide gross of Avatar: Fire and Ash according to Box Office Mojo and The Numbers?';
      const bothTrackersCitations: Citation[] = [
        {
          id: 'c1',
          sourceId: 's1',
          sourceTitle: 'Avatar: Fire and Ash - Box Office Mojo',
          uri: 'https://www.boxofficemojo.com/title/tt1757678/',
          snippet: 'Worldwide gross: $1,485,999,890.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        },
        {
          id: 'c2',
          sourceId: 's2',
          sourceTitle: 'Avatar: Fire and Ash (2025) - The Numbers',
          uri: 'https://www.the-numbers.com/movie/Avatar-Fire-and-Ash#tab=summary',
          snippet: 'Worldwide Box Office: $1,490,386,712; International: $1,085,000,000.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        }
      ];

      const sufficiency = evaluateEvidenceSufficiency(prompt, bothTrackersCitations);
      assert.equal(sufficiency.isSufficient, true);
    });
  });

  describe('Concern 4: Weather Evidence Must Match Requested Location and Reject Operational-Domain Seasonal Pages', () => {
    it('penalizes seasonal guides even when hosted on operational domains like accuweather.com', () => {
      const citations: Citation[] = [
        {
          id: 'c1',
          sourceId: 's1',
          sourceTitle: 'Tokyo in December Weather & Travel Guide - AccuWeather',
          uri: 'https://www.accuweather.com/en/jp/tokyo/travel/december-weather',
          snippet: 'What to wear in Tokyo in December: average monthly temperatures and seasonal climate.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        },
        {
          id: 'c2',
          sourceId: 's2',
          sourceTitle: 'Tokyo, Japan Current Conditions & Today Forecast - Weather.com',
          uri: 'https://weather.com/weather/today/l/Tokyo+Japan',
          snippet: 'Tokyo, Japan today: 22°C, Sunny, Humidity 45%, Wind 8 km/h.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        }
      ];

      const ranked = rankAndFilterWeatherCitations(citations, 'Tokyo');
      assert.equal(ranked[0].uri, 'https://weather.com/weather/today/l/Tokyo+Japan');
      const uris = ranked.map(c => c.uri);
      assert.ok(!uris.includes('https://www.accuweather.com/en/jp/tokyo/travel/december-weather'), 'Seasonal guide on accuweather must be filtered out');
    });

    it('deprioritizes operational forecast pages for the wrong city when location is specified', () => {
      const citations: Citation[] = [
        {
          id: 'c1',
          sourceId: 's1',
          sourceTitle: 'London, UK Today Weather Forecast - AccuWeather',
          uri: 'https://www.accuweather.com/en/gb/london/today-weather',
          snippet: 'Current conditions in London: 14°C, Rainy.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        },
        {
          id: 'c2',
          sourceId: 's2',
          sourceTitle: 'Tokyo, Japan Weather Forecast - Tenki.jp',
          uri: 'https://tenki.jp/forecast/3/16/4410/13101/',
          snippet: 'Tokyo local weather forecast: 21°C, clear sky today.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        }
      ];

      const ranked = rankAndFilterWeatherCitations(citations, 'Tokyo');
      assert.equal(ranked[0].uri, 'https://tenki.jp/forecast/3/16/4410/13101/', 'Forecast matching requested location Tokyo must rank above London');
    });
  });

  describe('Concern 5 & 6: Out-of-Bounds Source Sanitization & Frontend Markdown Rendering', () => {
    it('neutralizes raw [Source 12] or [12] when only 3 sources are verified', () => {
      const text = 'The stock price was $229.30 [Source 12] and opened at $229.69 [Source 1].';
      const cleaned = sanitizeCitationMarkers(text, 3);
      assert.doesNotMatch(cleaned, /\[Source 12\]/, 'Must neutralize [Source 12] when validSourceCount is 3');
      assert.match(cleaned, /\[Source 1\]/, 'Must preserve valid [Source 1]');
    });

    it('preserves array indexing arr[12] in fenced code and inline code', () => {
      const markdown = 'Lookup `cache[12]` and:\n```javascript\nconst item = items[12];\n```\nAccording to [Source 1].';
      const cleaned = sanitizeCitationMarkers(markdown, 3);
      assert.match(cleaned, /`cache\[12\]`/, 'Inline code indexing must not be touched');
      assert.match(cleaned, /items\[12\];/, 'Fenced code indexing must not be touched');
      assert.match(cleaned, /\[Source 1\]/);
    });

    it('renderMarkdownToHtml respects validSourceCount and does not manufacture links for unsupported sources', () => {
      const markdown = 'Reported in [12†source] and [1†source].';
      const html = renderMarkdownToHtml(markdown, 3);
      assert.doesNotMatch(html, /Source 12/);
      assert.match(html, /Source 1/);
    });
  });

  describe('Concern 7: Programmatic Financial Timezone & Trading Session Verification', () => {
    it('accurately identifies Eastern Daylight Time (EDT) in October vs EST in January', () => {
      // October 12, 2026 is EDT
      const octDate = new Date('2026-10-12T13:30:00Z');
      assert.equal(isEasternDaylightTime(octDate), true, 'October 12 must be Eastern Daylight Time (EDT)');

      // January 15, 2026 is EST
      const janDate = new Date('2026-01-15T14:30:00Z');
      assert.equal(isEasternDaylightTime(janDate), false, 'January 15 must be Eastern Standard Time (EST)');
    });

    it('identifies 9:30 AM Eastern as Regular Session Open, NOT Premarket', () => {
      // 9:30 AM EDT on Oct 12, 2026 is 13:30 UTC
      const openDate = new Date('2026-10-12T13:30:00Z');
      const session = resolveTradingSession(openDate);
      assert.equal(session.session, 'REGULAR_SESSION_OPEN');
      assert.equal(session.timezone, 'EDT');
      assert.equal(session.isPremarket, false);

      // 9:15 AM EDT on Oct 12, 2026 is 13:15 UTC
      const preDate = new Date('2026-10-12T13:15:00Z');
      const preSession = resolveTradingSession(preDate);
      assert.equal(preSession.session, 'PREMARKET');
      assert.equal(preSession.isPremarket, true);

      // 4:15 PM EDT on Oct 12, 2026 is 20:15 UTC
      const postDate = new Date('2026-10-12T20:15:00Z');
      const postSession = resolveTradingSession(postDate);
      assert.equal(postSession.session, 'AFTER_HOURS');
    });
  });

  describe('Concern 3: Zero-Result Initial Searches Deliberately Trigger Stage-2 Targeted Search', () => {
    it('executes Stage-2 targeted search when Stage-1 search returns zero results', async () => {
      const { ResearchService } = await import('../../packages/agent-runtime/src/research.js');

      let searchCalls = 0;
      const queries: string[] = [];

      const toolRegistry = {
        get: () => ({ definition: { id: 'tool_web_search' } }),
        execute: async (call: any) => {
          searchCalls++;
          queries.push(call.arguments.query);

          if (searchCalls === 1) {
            // Stage 1: Returns empty results
            return {
              isError: false,
              output: { provider: 'tavily', results: [] },
              toolCallId: call.id,
              timestamp: Date.now(),
              durationMs: 50
            };
          } else {
            // Stage 2: Returns targeted results
            return {
              isError: false,
              output: {
                provider: 'tavily',
                results: [
                  {
                    title: 'Avatar: Fire and Ash - Box Office Mojo Summary',
                    url: 'https://www.boxofficemojo.com/title/tt1757678/',
                    snippet: 'Worldwide Gross: $1,485,999,890.'
                  }
                ]
              },
              toolCallId: call.id,
              timestamp: Date.now(),
              durationMs: 60
            };
          }
        }
      } as any;

      const knowledge = { search: async () => [] } as any;
      const prevTavily = process.env.TAVILY_API_KEY;
      try {
        process.env.TAVILY_API_KEY = 'test-key';
        const service = new ResearchService(toolRegistry, knowledge);
        const result = await service.executeResearch({
          prompt: 'What is the worldwide gross of Avatar: Fire and Ash according to Box Office Mojo and The Numbers?',
          runId: 'zero-result-test',
          topic: 'BOX_OFFICE'
        });

        assert.equal(searchCalls, 2, 'Must execute exactly 2 tool calls: initial (empty) + Stage-2 targeted');
        assert.match(queries[1], /site:boxofficemojo\.com OR site:the-numbers\.com/i);
        assert.equal(result.citations.length, 1);
        assert.equal(result.providerReady, true);
        assert.match(result.citations[0].snippet, /\$1,485,999,890/);
      } finally {
        process.env.TAVILY_API_KEY = prevTavily;
      }
    });
  });

  describe('Concern 8: Upstream HTTP Call and Tool Call Tracking', () => {
    it('tracks both tool calls and upstream provider calls during failover', async () => {
      const { searchWeb } = await import('../../packages/tool-runtime/src/search-providers.js');

      const httpCalls: string[] = [];
      const mockFetch = (async (url: string | URL | Request) => {
        httpCalls.push(String(url));
        if (String(url).includes('api.tavily.com')) {
          // Tavily fails with 500 error
          return { ok: false, status: 500 } as Response;
        }
        if (String(url).includes('api.exa.ai')) {
          // Exa succeeds
          return {
            ok: true,
            status: 200,
            json: async () => ({
              results: [
                {
                  title: 'Tokyo Local Forecast - Tenki',
                  url: 'https://tenki.jp/forecast/3/16/4410/tokyo',
                  text: 'Tokyo today: 20°C, Clear.'
                }
              ]
            })
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      }) as typeof fetch;

      const creds = { tavilyApiKey: 'tavily-test', exaApiKey: 'exa-test' };
      const res = await searchWeb('Tokyo weather today', creds, mockFetch);

      // Single tool call produced 2 upstream HTTP calls (Tavily fail + Exa fallback)
      assert.equal(res.provider, 'exa');
      assert.equal(httpCalls.length, 2);
      assert.ok(httpCalls[0].includes('tavily.com'));
      assert.ok(httpCalls[1].includes('exa.ai'));
    });
  });
});

