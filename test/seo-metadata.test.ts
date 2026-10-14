import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

console.log('--- RUNNING SEO & METADATA ACCURACY AUDIT ---');

const rootDir = process.cwd();
const indexHtmlPath = path.join(rootDir, 'index.html');
const robotsPath = path.join(rootDir, 'public', 'robots.txt');
const sitemapPath = path.join(rootDir, 'public', 'sitemap.xml');

// 1. Audit index.html
console.log('[1/4] Auditing index.html metadata...');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

// Check canonical URL
assert.match(
  indexHtml,
  /<link\s+rel="canonical"\s+href="https:\/\/aira-ai-2026\.vercel\.app\/"\s*\/>/,
  'Canonical URL must be exactly https://aira-ai-2026.vercel.app/'
);

// Check OG URL
assert.match(
  indexHtml,
  /<meta\s+property="og:url"\s+content="https:\/\/aira-ai-2026\.vercel\.app\/"\s*\/>/,
  'Open Graph URL must be https://aira-ai-2026.vercel.app/'
);

// Check Twitter URL
assert.match(
  indexHtml,
  /<meta\s+name="twitter:url"\s+content="https:\/\/aira-ai-2026\.vercel\.app\/"\s*\/>/,
  'Twitter URL must be https://aira-ai-2026.vercel.app/'
);

// Check no legacy hardcoded aira.ai
assert.ok(!indexHtml.includes('https://aira.ai/'), 'No occurrences of legacy unverified https://aira.ai/ in index.html');

// Check capability honesty: no unsupported Claude 3.7 claims
assert.ok(!indexHtml.includes('Claude 3.7'), 'No unsupported Claude 3.7 claims in production SEO metadata');

// Check structured data
console.log('[2/4] Auditing JSON-LD structured data in index.html...');
const ldJsonMatch = indexHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
assert.ok(ldJsonMatch, 'Must contain JSON-LD structured data block');
const parsedLdJson = JSON.parse(ldJsonMatch[1]);
assert.equal(parsedLdJson['@context'], 'https://schema.org');
assert.ok(Array.isArray(parsedLdJson['@graph']));
assert.equal(parsedLdJson['@graph'][0].url, 'https://aira-ai-2026.vercel.app/');

// 2. Audit robots.txt
console.log('[3/4] Auditing public/robots.txt...');
const robots = fs.readFileSync(robotsPath, 'utf8');
assert.match(robots, /Host:\s*https:\/\/aira-ai-2026\.vercel\.app/);
assert.match(robots, /Sitemap:\s*https:\/\/aira-ai-2026\.vercel\.app\/sitemap\.xml/);
assert.ok(!robots.includes('https://aira.ai'), 'robots.txt must not contain legacy domain');

// 3. Audit sitemap.xml
console.log('[4/4] Auditing public/sitemap.xml...');
const sitemap = fs.readFileSync(sitemapPath, 'utf8');
assert.ok(sitemap.includes('<loc>https://aira-ai-2026.vercel.app/</loc>'));
assert.ok(!sitemap.includes('https://aira.ai'), 'sitemap.xml must not contain legacy domain');

console.log('\n===========================================================');
console.log(' P1 SEO & CAPABILITY ACCURACY AUDIT: 100% PASS');
console.log(' - Canonical URL: https://aira-ai-2026.vercel.app/');
console.log(' - Open Graph / Twitter URL: VERIFIED');
console.log(' - Structured JSON-LD Data: VALID');
console.log(' - Capability Honesty (No unsupported claims): VERIFIED');
console.log(' - robots.txt & sitemap.xml synchronization: VERIFIED');
console.log('===========================================================\n');
