import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Citation } from '../../packages/contracts/src/index.js';
import {
  sanitizeCitationMarkers,
  buildDomainResearchGuidelines,
  buildResearchEvidenceContext,
  rankAndFilterWeatherCitations,
  evaluateEvidenceSufficiency,
  buildTargetedSearchQuery
} from '../../packages/agent-runtime/src/research-evidence.js';

describe('AIRA Research Retrieval & Temporal Accuracy Hardening', () => {

  describe('1. Source-Aware Citation Sanitization & Code Integrity', () => {
    it('neutralizes citation markers when index exceeds available citation count', () => {
      const text = 'NVIDIA revenue was reported in [12†source] and [1†L1-L4].';
      // Only 3 sources available
      const cleaned = sanitizeCitationMarkers(text, 3);
      assert.doesNotMatch(cleaned, /\[Source 12\]/, 'Must not invent [Source 12] when only 3 sources exist');
      assert.doesNotMatch(cleaned, /\[12†source\]/, 'Raw dagger marker must be cleaned');
      assert.match(cleaned, /\[Source 1\]/, 'In-bounds source 1 must be formatted as [Source 1]');
    });

    it('converts in-bounds citation markers to clean references', () => {
      const text = 'The report from Box Office Mojo [2†L9-L15] confirmed the numbers [3†source].';
      const cleaned = sanitizeCitationMarkers(text, 5);
      assert.equal(cleaned, 'The report from Box Office Mojo [Source 2] confirmed the numbers [Source 3].');
    });

    it('preserves bracketed syntax inside fenced code blocks', () => {
      const markdown = [
        'Here is the analysis:',
        '```python',
        '# This should not be mutated: [5†L9-L13]',
        'data = [1, 2, 3]',
        '```',
        'According to the source [2†L1-L4], the trend continues.'
      ].join('\n');

      const cleaned = sanitizeCitationMarkers(markdown, 5);
      assert.match(cleaned, /# This should not be mutated: \[5†L9-L13\]/, 'Fenced code content must be untouched');
      assert.match(cleaned, /\[Source 2\]/, 'Prose citation must be cleanly formatted');
    });

    it('preserves bracketed syntax inside inline code', () => {
      const text = 'Use the command `process([1†inline])` as documented in [1†L1-L4].';
      const cleaned = sanitizeCitationMarkers(text, 3);
      assert.match(cleaned, /`process\(\[1†inline\]\)`/, 'Inline code must remain literal');
      assert.match(cleaned, /documented in \[Source 1\]/, 'Prose citation must be converted');
    });

    it('handles negative or zero citation indices cleanly without inventing sources', () => {
      const text = 'Invalid citations: [0†source] and [-1†source].';
      const cleaned = sanitizeCitationMarkers(text, 3);
      assert.doesNotMatch(cleaned, /\[Source 0\]/);
      assert.doesNotMatch(cleaned, /\[Source -1\]/);
    });
  });

  describe('2. Financial Trading Session & Timezone Precision', () => {
    it('contains no hardcoded historical price numbers in runtime guidelines', () => {
      const guidelines = buildDomainResearchGuidelines('FINANCIAL');
      assert.doesNotMatch(guidelines, /\$229\.30/, 'Must not hardcode $229.30 in runtime guidelines');
      assert.doesNotMatch(guidelines, /\$229\.69/, 'Must not hardcode $229.69 in runtime guidelines');
      assert.doesNotMatch(guidelines, /\$229\.66/, 'Must not hardcode $229.66 in runtime guidelines');
    });

    it('enforces America/New_York timezone rules with EDT daylight saving vs EST standard time', () => {
      const guidelines = buildDomainResearchGuidelines('FINANCIAL');
      assert.match(guidelines, /America\/New_York|Eastern Time/i);
      assert.match(guidelines, /EDT/);
      assert.match(guidelines, /EST/);
      assert.match(guidelines, /Daylight Saving/i);
    });

    it('enforces 9:30 AM Eastern as Regular Session Open, never Premarket', () => {
      const guidelines = buildDomainResearchGuidelines('FINANCIAL');
      assert.match(guidelines, /9:30\s*AM/);
      assert.match(guidelines, /Regular Session/i);
      assert.match(guidelines, /NEVER.*(?:label|describe|call).*9:30\s*AM.*premarket/i);
    });

    it('prohibits labeling exchange metadata as "assumed"', () => {
      const guidelines = buildDomainResearchGuidelines('FINANCIAL');
      assert.match(guidelines, /NEVER.*(?:assume|assumed).*exchange/i);
    });

    it('requires explicit disclosure when quote timestamp is missing rather than claiming live status', () => {
      const guidelines = buildDomainResearchGuidelines('FINANCIAL');
      assert.match(guidelines, /timestamp/i);
      assert.match(guidelines, /live/i);
    });
  });

  describe('3. Weather Operational Source Ranking & Climate Guide Rejection', () => {
    it('filters out or downranks seasonal tourism pages when operational forecasts exist', () => {
      const mockCitations: Citation[] = [
        {
          id: 'c1',
          sourceId: 's1',
          sourceTitle: 'Tokyo in December: Weather, What to Wear & Travel Guide',
          uri: 'https://travel-example.com/tokyo-december-tourism',
          snippet: 'December in Tokyo is chilly with average monthly highs of 12C.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        },
        {
          id: 'c2',
          sourceId: 's2',
          sourceTitle: 'Tokyo, Tokyo Weather Forecast & Current Conditions - AccuWeather',
          uri: 'https://www.accuweather.com/en/jp/tokyo/forecast/today',
          snippet: 'Tokyo, Japan current conditions: 21°C, clear sky, humidity 54%, wind 7 km/h.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        },
        {
          id: 'c3',
          sourceId: 's3',
          sourceTitle: 'Best Time to Visit Tokyo: Monthly Climate Guide',
          uri: 'https://japan-guide-example.com/tokyo-monthly-climate',
          snippet: 'Monthly climate guide for Tokyo tourism and seasonal weather averages.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        },
        {
          id: 'c4',
          sourceId: 's4',
          sourceTitle: 'Japan Meteorological Agency - Tokyo Local Forecast',
          uri: 'https://www.jma.go.jp/bosai/forecast/tokyo',
          snippet: 'Today Tokyo weather forecast: high 22°C, low 15°C, precipitation 10%.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        }
      ];

      const filtered = rankAndFilterWeatherCitations(mockCitations, 'Tokyo');
      // Operational forecasts should be prioritized at the top
      assert.equal(filtered[0].uri, 'https://www.accuweather.com/en/jp/tokyo/forecast/today');
      assert.equal(filtered[1].uri, 'https://www.jma.go.jp/bosai/forecast/tokyo');
      // Seasonal tourism / monthly guides should be ranked below or omitted
      const uris = filtered.slice(0, 2).map(c => c.uri);
      assert.ok(!uris.includes('https://travel-example.com/tokyo-december-tourism'));
    });

    it('requires target location IANA timezone and prohibits monthly average substitution', () => {
      const guidelines = buildDomainResearchGuidelines('WEATHER');
      assert.match(guidelines, /IANA|time\s*zone/i);
      assert.match(guidelines, /NEVER infer/);
      assert.match(guidelines, /monthly climate/i);
    });
  });

  describe('4. Box Office Evidence Sufficiency & Bounded Targeted Search', () => {
    it('contains no hardcoded box office totals in runtime guidelines', () => {
      const guidelines = buildDomainResearchGuidelines('BOX_OFFICE');
      assert.doesNotMatch(guidelines, /\$1,485,999,890/, 'Must not hardcode $1,485,999,890');
      assert.doesNotMatch(guidelines, /\$1,490,386,712/, 'Must not hardcode $1,490,386,712');
    });

    it('detects when initial citations lack worldwide totals for explicit box office questions', () => {
      const prompt = 'What is the worldwide gross of Avatar: Fire and Ash according to Box Office Mojo and The Numbers?';
      const domesticOnlyCitations: Citation[] = [
        {
          id: 'c1',
          sourceId: 's1',
          sourceTitle: 'Avatar: Fire and Ash - Domestic Daily Grosses',
          uri: 'https://www.boxofficemojo.com/title/tt1757678/daily',
          snippet: 'Friday gross $12,400,000 across 3,800 domestic theaters.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        },
        {
          id: 'c2',
          sourceId: 's2',
          sourceTitle: 'Avatar: Fire and Ash - Germany Box Office',
          uri: 'https://www.the-numbers.com/movie/Avatar-Fire-and-Ash#tab=international-germany',
          snippet: 'Weekend gross in Germany: €4,200,000.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        }
      ];

      const sufficiency = evaluateEvidenceSufficiency(prompt, domesticOnlyCitations);
      assert.equal(sufficiency.isSufficient, false, 'Evidence with only domestic/country daily numbers is insufficient for worldwide totals');
      assert.equal(sufficiency.missingDimension, 'WORLDWIDE_TOTAL');
    });

    it('detects when citations have sufficient worldwide totals', () => {
      const prompt = 'What is the worldwide gross of Avatar: Fire and Ash according to Box Office Mojo?';
      const completeCitations: Citation[] = [
        {
          id: 'c1',
          sourceId: 's1',
          sourceTitle: 'Avatar: Fire and Ash - Box Office Mojo Summary',
          uri: 'https://www.boxofficemojo.com/title/tt1757678/',
          snippet: 'Worldwide gross: $1,485,999,890; Domestic: $404,340,010; International: $1,081,659,880.',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
        }
      ];

      const sufficiency = evaluateEvidenceSufficiency(prompt, completeCitations);
      assert.equal(sufficiency.isSufficient, true);
    });

    it('builds a targeted search query for missing box office dimensions', () => {
      const prompt = 'What is the worldwide gross of Avatar: Fire and Ash according to Box Office Mojo and The Numbers?';
      const targeted = buildTargetedSearchQuery(prompt, 'BOX_OFFICE', 'WORLDWIDE_TOTAL');
      assert.match(targeted, /worldwide/i);
      assert.match(targeted, /Box Office Mojo/i);
      assert.match(targeted, /The Numbers/i);
    });
  });
});
