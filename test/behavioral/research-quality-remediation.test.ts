import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeCitationMarkers,
  normalizeSourceTitle,
  normalizeSnippetText,
  buildResearchEvidenceContext,
  buildResearchSourcesAppendix,
  buildDomainResearchGuidelines,
  type ResearchTopic
} from '../../packages/agent-runtime/src/research-evidence.js';
import type { Citation } from '../../packages/contracts/src/index.js';

describe('Research Quality & Citation Rendering Remediation', () => {

  describe('1. Raw Citation Marker Sanitization', () => {
    it('cleans raw tool line-range citation markers like [5†L9-L13] and [1†L9-L11]', () => {
      const input = 'Avatar: Fire and Ash worldwide gross is $1,485,999,890 [5†L9-L13], with domestic at $404,340,010 [1†L9-L11].';
      const output = sanitizeCitationMarkers(input);
      assert.ok(!output.includes('†'), 'Must not leak dagger symbol');
      assert.ok(!output.includes('L9-L13'), 'Must not leak line-range syntax');
      assert.ok(!output.includes('L9-L11'), 'Must not leak line-range syntax');
      assert.match(output, /\[Source 5\]/);
      assert.match(output, /\[Source 1\]/);
    });

    it('cleans single-digit and multi-digit chunk markers like [2†L1-L4] and [12†source]', () => {
      const input = 'Premarket quote was $229.69 [2†L1-L4] and after-hours was $229.66 [12†source].';
      const output = sanitizeCitationMarkers(input);
      assert.ok(!output.includes('†L1-L4'));
      assert.ok(!output.includes('†source'));
      assert.match(output, /\[Source 2\]/);
      assert.match(output, /\[Source 12\]/);
    });

    it('cleans Chinese/bracketed tool markers like 【4:1†source】', () => {
      const input = 'Tokyo temperature today is 21°C 【4:1†source】. Weather is partly cloudy.';
      const output = sanitizeCitationMarkers(input);
      assert.ok(!output.includes('†'));
      assert.ok(!output.includes('【'));
      assert.match(output, /\[Source 4\]/);
    });

    it('strips orphaned raw dagger fragments', () => {
      const input = 'Reported data †L1-L4 indicates high volume.';
      const output = sanitizeCitationMarkers(input);
      assert.ok(!output.includes('†L1-L4'));
    });
  });

  describe('2. Source Title Normalization & De-duplication', () => {
    it('removes duplicated website name suffixes from scraper output', () => {
      assert.equal(
        normalizeSourceTitle('Avatar: Fire and Ash (2025) - Box Office MojoBox Office Mojo'),
        'Avatar: Fire and Ash (2025) - Box Office Mojo'
      );
      assert.equal(
        normalizeSourceTitle('NVIDIA Corporation (NVDA) Stock Price, News, Quote - Yahoo FinanceYahoo Finance'),
        'NVIDIA Corporation (NVDA) Stock Price, News, Quote - Yahoo Finance'
      );
      assert.equal(
        normalizeSourceTitle('Tokyo, Tokyo, Japan Weather Forecast | AccuWeatherAccuWeather'),
        'Tokyo, Japan Weather Forecast | AccuWeather'
      );
      assert.equal(
        normalizeSourceTitle('Avatar: Fire and Ash - The NumbersThe Numbers'),
        'Avatar: Fire and Ash - The Numbers'
      );
    });

    it('unescapes HTML entities and strips residual HTML tags', () => {
      assert.equal(
        normalizeSourceTitle('Tokyo Weather &amp; Climate in October: What to Expect &mdash; Go Tokyo'),
        'Tokyo Weather & Climate in October: What to Expect — Go Tokyo'
      );
      assert.equal(
        normalizeSourceTitle('<b>NVIDIA</b> Stock Quote &#39;NVDA&#39; &quot;Live&quot;'),
        'NVIDIA Stock Quote \'NVDA\' "Live"'
      );
    });

    it('preserves valid titles without trailing breadcrumbs or URL fragments', () => {
      const raw = 'NVIDIA Stock Price Today https://finance.yahoo.com/quote/NVDA';
      const clean = normalizeSourceTitle(raw);
      assert.ok(!clean.includes('https://'));
      assert.match(clean, /NVIDIA Stock Price Today/);
    });
  });

  describe('3. Snippet Word-Collapse and Whitespace Normalization', () => {
    it('separates collapsed text where numbers and words adjoin without spaces', () => {
      const input = 'Previous Close$229.30Premarket$229.69Volume32.4M';
      const output = normalizeSnippetText(input);
      assert.match(output, /Close \$229\.30/);
      assert.match(output, /Premarket \$229\.69/);
    });

    it('separates collapsed sentences where periods lack following spaces', () => {
      const input = 'Inspected time was 8:00 AM.Contemporary sources showed different values.Subsequent checks confirmed.';
      const output = normalizeSnippetText(input);
      assert.match(output, /AM\. Contemporary/);
      assert.match(output, /values\. Subsequent/);
    });

    it('decodes HTML entities in snippet text', () => {
      const input = 'Low of 18&deg;C &amp; High of 24&deg;C &mdash; clear skies';
      const output = normalizeSnippetText(input);
      assert.equal(output, 'Low of 18°C & High of 24°C — clear skies');
    });
  });

  describe('4. Markdown Link & Source Appendix Integrity', () => {
    it('escapes bracket characters in titles so Markdown links never break', () => {
      const citations: Citation[] = [{
        id: 'cite_1',
        sourceId: 'web_1',
        sourceTitle: 'NVIDIA [NVDA] Stock Quote & Analysis [2026]',
        uri: 'https://finance.yahoo.com/quote/NVDA',
        snippet: 'Sample snippet',
        score: 1.0,
        provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
      }];
      const appendix = buildResearchSourcesAppendix(citations);
      assert.ok(!appendix.includes('\\[NVDA\\]'), 'Should not have double backslashes in anchor text');
      assert.match(appendix, /1\. \[NVIDIA \(NVDA\) Stock Quote & Analysis \(2026\)\]\(https:\/\/finance\.yahoo\.com\/quote\/NVDA\)/);
    });

    it('treats publication date, retrieval date, and reporting cutoff distinctly', () => {
      const citations: Citation[] = [
        {
          id: 'cite_1',
          sourceId: 'web_1',
          sourceTitle: 'Box Office Mojo - Avatar 3',
          uri: 'https://www.boxofficemojo.com/title/tt1757678/',
          publishedDate: '2026-10-11',
          snippet: 'Domestic: $404,340,010 Worldwide: $1,485,999,890 through weekend Oct 11',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: 1791811200000 }
        },
        {
          id: 'cite_2',
          sourceId: 'web_2',
          sourceTitle: 'The Numbers - Avatar 3',
          uri: 'https://www.the-numbers.com/movie/Avatar-3',
          snippet: 'Worldwide: $1,490,386,712',
          score: 1.0,
          provenance: { retrievalMechanism: 'web_search', timestamp: 1791811200000 }
        }
      ];
      const appendix = buildResearchSourcesAppendix(citations);
      assert.match(appendix, /Published: 2026-10-11/);
      assert.match(appendix, /Published: not provided by search provider/);
    });
  });

  describe('5. Domain-Specific Research Synthesis Protocols', () => {
    it('includes strict financial quote rules prohibiting synthetic consensus blending', () => {
      const guidelines = buildDomainResearchGuidelines('FINANCIAL');
      assert.match(guidelines, /FINANCIAL QUOTE RULES/);
      assert.match(guidelines, /Regular Session/);
      assert.match(guidelines, /Premarket/);
      assert.match(guidelines, /After-Hours/);
      assert.match(guidelines, /Previous Close/);
      assert.match(guidelines, /NEVER blend/);
      assert.match(guidelines, /timestamp/i);
    });

    it('includes strict weather rules prohibiting climate-average extrapolation for today', () => {
      const guidelines = buildDomainResearchGuidelines('WEATHER');
      assert.match(guidelines, /WEATHER RESEARCH RULES/);
      assert.match(guidelines, /Current Observed Conditions/);
      assert.match(guidelines, /Today's Dated Forecast/);
      assert.match(guidelines, /NEVER infer/);
      assert.match(guidelines, /monthly climate/i);
      assert.match(guidelines, /local date/i);
    });

    it('includes strict box office rules requiring tracker attribution and cutoff clarity', () => {
      const guidelines = buildDomainResearchGuidelines('BOX_OFFICE');
      assert.match(guidelines, /BOX OFFICE & TRACKER RULES/);
      assert.match(guidelines, /Box Office Mojo/);
      assert.match(guidelines, /The Numbers/);
      assert.match(guidelines, /NEVER blend/);
      assert.match(guidelines, /as-of/i);
      assert.match(guidelines, /Reporting Cutoff/i);
    });
  });

  describe('6. Evidence Context Integration with Guidelines', () => {
    it('embeds topic-specific rules into evidence context when topic is provided', () => {
      const citations: Citation[] = [{
        id: 'c1',
        sourceId: 's1',
        sourceTitle: 'Yahoo Finance - NVDA',
        uri: 'https://finance.yahoo.com/quote/NVDA',
        snippet: 'Premarket: 229.69, Prev Close: 229.30',
        score: 1.0,
        provenance: { retrievalMechanism: 'web_search', timestamp: Date.now() }
      }];
      const financialContext = buildResearchEvidenceContext(citations, 'FINANCIAL');
      assert.match(financialContext, /FINANCIAL QUOTE RULES/);
      assert.match(financialContext, /NEVER blend/);

      const weatherContext = buildResearchEvidenceContext(citations, 'WEATHER');
      assert.match(weatherContext, /WEATHER RESEARCH RULES/);
      assert.match(weatherContext, /NEVER infer/);

      const boxOfficeContext = buildResearchEvidenceContext(citations, 'BOX_OFFICE');
      assert.match(boxOfficeContext, /BOX OFFICE & TRACKER RULES/);
    });
  });
});
