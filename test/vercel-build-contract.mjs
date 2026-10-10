// Regression guard: static Vercel previews must not need live database credentials.
// The real migration and schema gates run independently in GitHub CI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
assert.equal(config.framework, 'vite');
assert.equal(config.buildCommand, 'npm run build', 'Vercel must only build the static frontend');
assert.equal(config.outputDirectory, 'dist');

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
assert.match(workflow, /- name: Build\s+run: npm run build/, 'CI must build the frontend');
assert.match(workflow, /- name: Run database migrations\s+run: npm run db:migrate/, 'CI must migrate an isolated database');
assert.match(workflow, /- name: Verify deploy database contract[^\n]*\s+(?:env:[\s\S]*?)?run: npm run db:verify:deploy/, 'CI must preserve deploy schema verification');
console.log('Vercel preview/frontend build is isolated; CI migration and database gates remain enforced.');
