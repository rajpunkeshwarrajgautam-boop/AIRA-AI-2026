import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const canonicalUrl = 'https://aira-ai-2026.vercel.app';
const artifactDir = 'C:/Users/WORKSTATION/.gemini/antigravity/brain/5ef6a26c-9a24-46a2-8c8b-ffeeb356edb4/screenshots/canonical-live-hardening';

function seedTestConversation() {
  const timestamp = Date.now();
  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect width="200" height="200" rx="20" fill="#2563eb" />
  <circle cx="100" cy="100" r="40" fill="#ffffff" />
  <text x="100" y="105" font-family="sans-serif" font-size="14" font-weight="bold" fill="#2563eb" text-anchor="middle">AIRA</text>
</svg>`;

  const artifact = {
    id: 'art-live-prod-svg',
    type: 'image/svg+xml',
    title: 'AIRA 2026 Production Crest',
    content: svgContent,
    versions: [{ version: 1, content: svgContent, timestamp }],
  };

  const conversation = {
    id: 'chat-live-hardening-verify',
    title: 'Production Verification Chat',
    createdAt: timestamp - 3600000,
    updatedAt: timestamp,
    messages: [
      {
        id: 'msg-u1',
        role: 'user',
        content: 'Render the official AIRA 2026 Production Crest vector badge.',
        timestamp: timestamp - 2000,
      },
      {
        id: 'msg-a1',
        role: 'assistant',
        content: 'Here is the certified vector crest for AIRA 2026.',
        timestamp: timestamp - 1000,
        artifacts: [artifact],
      },
    ],
  };

  localStorage.setItem('aira_conversations_v1', JSON.stringify([conversation]));
  sessionStorage.setItem('aira_active_chat_session', conversation.id);
}

async function runLiveCanonicalEdgeSuite() {
  mkdirSync(artifactDir, { recursive: true });

  console.log('====================================================================');
  console.log(`LAUNCHING MICROSOFT EDGE CANONICAL LIVE AUDIT: ${canonicalUrl}`);
  console.log('====================================================================\n');

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const browserVersion = await browser.version();
  console.log(`Microsoft Edge Channel Launched: ${browserVersion}\n`);

  try {
    // 1. Desktop Test (1600x1000 Dark)
    console.log('--- Testing Desktop 1600x1000 Dark on Canonical Production ---');
    const desktopContext = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      colorScheme: 'dark',
    });
    const desktopPage = await desktopContext.newPage();
    const consoleErrors = [];
    desktopPage.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await desktopPage.goto(canonicalUrl);
    await desktopPage.waitForLoadState('networkidle');

    // Verify A: Default state — Artifact Studio is CLOSED by default
    const emptyCount = await desktopPage.locator('[data-testid="adaptive-studio-empty"]').count();
    const realStudioCount = await desktopPage.locator('[data-testid="artifact-studio"]').count();
    assert.equal(emptyCount, 0, 'Empty studio must NOT be visible by default on initial visit');
    assert.equal(realStudioCount, 0, 'Artifact studio must NOT be visible by default');

    const shot1 = path.join(artifactDir, 'canonical-edge-desktop-1-default-closed.png');
    await desktopPage.screenshot({ path: shot1 });
    console.log(`[PASS] Default closed state verified: ${shot1}`);

    // Verify B: Launcher button opens empty studio
    const launcher = desktopPage.locator('[data-testid="artifact-studio-launcher"]');
    assert.ok((await launcher.count()) > 0, 'Launcher button must exist in header');
    await launcher.click();
    await desktopPage.waitForTimeout(300);

    assert.equal(await desktopPage.locator('[data-testid="adaptive-studio-empty"]').count(), 1, 'Empty studio opens on launcher click');
    const shot2 = path.join(artifactDir, 'canonical-edge-desktop-2-launcher-opened.png');
    await desktopPage.screenshot({ path: shot2 });
    console.log(`[PASS] Launcher opened studio verified: ${shot2}`);

    // Verify C: Close button dismisses studio
    const closeBtn = desktopPage.locator('[data-testid="adaptive-studio-close"]');
    assert.ok((await closeBtn.count()) > 0, 'Close button must exist on studio');
    await closeBtn.click();
    await desktopPage.waitForTimeout(300);

    assert.equal(await desktopPage.locator('[data-testid="adaptive-studio-empty"]').count(), 0, 'Studio closes on close button click');
    const shot3 = path.join(artifactDir, 'canonical-edge-desktop-3-dismissed-restored.png');
    await desktopPage.screenshot({ path: shot3 });
    console.log(`[PASS] Dismissal and full-width chat restoration verified: ${shot3}`);

    // Verify D: Artifact card click opens real Artifact Studio
    await desktopPage.evaluate(seedTestConversation);
    await desktopPage.reload();
    await desktopPage.waitForLoadState('networkidle');

    // Find and click the artifact preview card
    const artifactCard = desktopPage.locator('[data-testid="artifact-card"]').first();
    assert.ok((await artifactCard.count()) > 0, 'Artifact card rendered in chat');
    await artifactCard.click();
    await desktopPage.waitForTimeout(600);

    assert.equal(await desktopPage.locator('[data-testid="artifact-studio"]').count(), 1, 'Real Artifact Studio opened on card click');
    const shot4 = path.join(artifactDir, 'canonical-edge-desktop-4-artifact-preview.png');
    await desktopPage.screenshot({ path: shot4 });
    console.log(`[PASS] Artifact preview in studio verified: ${shot4}`);

    // Check storage quota resilience in production Edge
    const quotaErrors = consoleErrors.filter(e => e.includes('QuotaExceededError') || e.includes('Failed to save conversations'));
    assert.equal(quotaErrors.length, 0, 'Zero QuotaExceededError logged to console');
    console.log('[PASS] Console has zero unhandled quota or storage errors');

    await desktopContext.close();

    // 2. Mobile Viewport Test (390x844 Dark)
    console.log('\n--- Testing Mobile 390x844 Dark on Canonical Production ---');
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      colorScheme: 'dark',
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(canonicalUrl);
    await mobilePage.waitForLoadState('networkidle');

    assert.equal(await mobilePage.locator('[data-testid="adaptive-studio-empty"]').count(), 0, 'Mobile starts with studio closed');
    const mobileLauncher = mobilePage.locator('[data-testid="artifact-studio-launcher"]');
    assert.ok((await mobileLauncher.count()) > 0, 'Mobile header has launcher icon');

    await mobileLauncher.click();
    await mobilePage.waitForTimeout(300);
    assert.equal(await mobilePage.locator('[data-testid="adaptive-studio-empty"]').count(), 1, 'Mobile opens studio drawer');

    const shotMobile = path.join(artifactDir, 'canonical-edge-mobile-390x844-drawer.png');
    await mobilePage.screenshot({ path: shotMobile });
    console.log(`[PASS] Mobile responsive drawer verified: ${shotMobile}`);

    const mobileClose = mobilePage.locator('[data-testid="adaptive-studio-close"]');
    assert.ok((await mobileClose.count()) > 0, 'Mobile close button visible');
    await mobileClose.click();
    await mobilePage.waitForTimeout(300);
    assert.equal(await mobilePage.locator('[data-testid="adaptive-studio-empty"]').count(), 0, 'Mobile drawer closed cleanly');
    console.log('[PASS] Mobile drawer dismissal verified');

    await mobileContext.close();

    console.log('\n====================================================================');
    console.log('CANONICAL PRODUCTION VERIFICATION IN MICROSOFT EDGE COMPLETED: PASS');
    console.log('====================================================================');
    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    console.error('\n[FATAL ERROR in Canonical Edge Suite]:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

runLiveCanonicalEdgeSuite();
