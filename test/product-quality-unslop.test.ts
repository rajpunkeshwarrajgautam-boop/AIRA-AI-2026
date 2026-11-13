import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SHOWCASE_SCENES } from '../src/video/types';
import { AVAILABLE_MODELS } from '../src/utils/constants';
import { getUpgradeModalConfig } from '../src/components/UpgradeModal';
import { COMMERCIAL_PLANS } from '../packages/contracts/src/commercial';

describe('Product Quality & UNSLOP Remediation Suite', () => {

  it('Defect A & D: Truthful showcase scenes and model capability descriptors', () => {
    assert.equal(SHOWCASE_SCENES.length, 6, 'Must have exactly 6 showcase scenes');

    // Scene 1: Foundation
    const scene1 = SHOWCASE_SCENES[0];
    assert.equal(scene1.id, 'scene-1-identity');
    assert.ok(scene1.metrics?.some(m => m.label === 'inference engines' && m.value.includes('Groq LPU')), 'Scene 1 must cite Groq LPU');

    // Scene 3: Deep Reasoning (Truthful representation)
    const scene3 = SHOWCASE_SCENES[2];
    assert.equal(scene3.id, 'scene-3-reasoning');
    assert.equal(scene3.badge, 'Reasoning');
    assert.ok(scene3.subtitle.includes('Groq Reasoning Effort'), 'Scene 3 subtitle must cite Groq Reasoning Effort');
    assert.ok(scene3.metrics?.some(m => m.label === 'reasoning effort' && m.value === 'effort-mapped'), 'Scene 3 metrics must cite effort-mapped');

    // Model Selector: Experimental Nemotron qualification
    const nemotron = AVAILABLE_MODELS.find(m => m.id === 'nvidia/llama-3.1-nemotron-70b-instruct');
    assert.ok(nemotron, 'Nemotron model must exist in catalog');
    assert.equal(nemotron.name, 'Nemotron 70B', 'Must have clean non-truncated display name');
    assert.equal(nemotron.badge, 'NVIDIA (Exp)', 'Badge must explicitly identify experimental status');
    assert.ok(nemotron.description.toLowerCase().includes('experimental'), 'Description must qualify experimental status');
  });

  it('Defect B: Permanently eliminate unwanted decorative stars and sparkles', () => {
    const srcDir = path.resolve('src');

    function scanFiles(dir: string): string[] {
      let results: string[] = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const full = path.join(dir, file);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          results = results.concat(scanFiles(full));
        } else if (file.endsWith('.tsx') || file.endsWith('.ts')) {
          results.push(full);
        }
      }
      return results;
    }

    const files = scanFiles(srcDir);
    const offenders: string[] = [];

    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        // Exclude comments, strings mentioning star in other contexts (e.g. restartOnboarding, startsWith)
        if (/\b(Sparkles)\b/.test(line)) {
          offenders.push(`${path.relative(srcDir, f)}:${idx + 1}: ${line.trim()}`);
        }
        if (/<Star\b/.test(line) || /from\s+['"]lucide-react['"].*\bStar\b/.test(line)) {
          offenders.push(`${path.relative(srcDir, f)}:${idx + 1}: ${line.trim()}`);
        }
      });
    }

    assert.equal(
      offenders.length,
      0,
      `Found forbidden star/sparkles branding in src:\n${offenders.join('\n')}`
    );
  });

  it('Defect C: Establish consistent subscription recommendations for Agent and Pro tools', () => {
    // 1. Contracts truth
    assert.equal(COMMERCIAL_PLANS.plus.allowAutonomous, true, 'Plus tier must allow autonomous agents');
    assert.equal(COMMERCIAL_PLANS.plus.allowPythonSandbox, false, 'Plus tier must not allow python sandbox');
    assert.equal(COMMERCIAL_PLANS.plus.allowBrowserTools, false, 'Plus tier must not allow browser tools');
    assert.equal(COMMERCIAL_PLANS.pro.allowAutonomous, true, 'Pro tier allows autonomous agents');
    assert.equal(COMMERCIAL_PLANS.pro.allowPythonSandbox, true, 'Pro tier allows python sandbox');
    assert.equal(COMMERCIAL_PLANS.pro.allowBrowserTools, true, 'Pro tier allows browser tools');

    // 2. UpgradeModal mapping for Agent mode -> recommended tier PLUS
    const agentConfig1 = getUpgradeModalConfig('agent_mode');
    assert.equal(agentConfig1.recommendedTier, 'plus', 'agent_mode must recommend Plus');
    assert.equal(agentConfig1.ctaText, 'Upgrade to Plus');
    assert.ok(agentConfig1.title.includes('Plus'), 'Modal title must mention Plus');

    const agentConfig2 = getUpgradeModalConfig('free_to_plus_agent');
    assert.equal(agentConfig2.recommendedTier, 'plus');

    const agentConfig3 = getUpgradeModalConfig('autonomous_agents');
    assert.equal(agentConfig3.recommendedTier, 'plus');

    // 3. UpgradeModal mapping for Sandbox / Browser / Pro tools -> recommended tier PRO
    const proSandboxConfig = getUpgradeModalConfig('pro_tools_sandbox');
    assert.equal(proSandboxConfig.recommendedTier, 'pro', 'Sandbox tools must recommend Pro');
    assert.equal(proSandboxConfig.ctaText, 'Upgrade to Pro');
    assert.ok(proSandboxConfig.title.includes('Pro') || proSandboxConfig.title.includes('Sandboxes'));

    const proBrowserConfig = getUpgradeModalConfig('browser_tools');
    assert.equal(proBrowserConfig.recommendedTier, 'pro');

    const plusToProConfig = getUpgradeModalConfig('plus_to_pro_tool');
    assert.equal(plusToProConfig.recommendedTier, 'pro');

    // 4. Guest limit -> recommended tier FREE
    const guestConfig = getUpgradeModalConfig('guest_limit');
    assert.equal(guestConfig.recommendedTier, 'free');
  });

  it('Defect E: Preserve approved clean greeting without suggestion cards', () => {
    const greetingFile = path.resolve('src/components/GreetingScreen.tsx');
    const content = fs.readFileSync(greetingFile, 'utf8');

    assert.ok(content.includes('aira-editorial-greeting'), 'Greeting must use aira-editorial-greeting shell');
    assert.ok(content.includes('dynamicGreetingTitle'), 'Greeting must compute dynamic literary headline');
    assert.ok(!content.includes('PROMPT_STARTERS'), 'Greeting must not render prompt starters or suggestion cards');
    assert.ok(!content.includes('suggestion-card'), 'Greeting must not have suggestion cards');
  });

});
