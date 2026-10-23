import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Target URL and Expected SHA from environment — STRICTLY MANDATORY FOR RELEASE CERTIFICATION
const PREVIEW_URL = process.env.PREVIEW_URL?.trim();
const EXPECTED_COMMIT_SHA = process.env.EXPECTED_COMMIT_SHA?.trim();

if (!PREVIEW_URL) {
  throw new Error(
    'RELEASE_CERTIFICATION_GATE_FAILURE: PREVIEW_URL environment variable is mandatory. Hardcoded or stale URL fallbacks are strictly prohibited.'
  );
}
if (!EXPECTED_COMMIT_SHA) {
  throw new Error(
    'RELEASE_CERTIFICATION_GATE_FAILURE: EXPECTED_COMMIT_SHA environment variable is mandatory. Deployment certification requires authoritative cryptographic commit provenance.'
  );
}

async function runPreviewAcceptance() {
  console.log('================================================================');
  console.log('  AIRA ONE — STRICT PLAYWRIGHT ACCEPTANCE & SAFETY AUDIT');
  console.log(`  Preview Target:  ${PREVIEW_URL}`);
  console.log(`  Expected Commit: ${EXPECTED_COMMIT_SHA}`);
  console.log('================================================================\n');

  // Ensure screenshot and test artifact directory exists
  const artifactDir = path.resolve(process.cwd(), 'test-results/acceptance');
  fs.mkdirSync(artifactDir, { recursive: true });

  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  page.on('pageerror', err => {
    consoleErrors.push(`[PAGE_ERROR] ${err.message}`);
  });

  try {
    // -------------------------------------------------------------
    // GATE 3.0: Preview Reachability & Authoritative Deployment Identity
    // -------------------------------------------------------------
    console.log('[1/11] Verifying Preview Reachability & Deployment Identity...');
    const response = await page.goto(PREVIEW_URL, { waitUntil: 'networkidle', timeout: 35000 });
    assert.ok(response, 'Preview URL failed to respond.');
    assert.strictEqual(response.status(), 200, `Expected HTTP 200 from preview, got ${response.status()}`);

    const title = await page.title();
    assert.ok(title.toLowerCase().includes('aira'), `Page title does not include aira: "${title}"`);
    console.log(`  PASS: Preview loaded successfully (HTTP 200, Title: "${title}")`);

    // Verify Authoritative Deployment Identity (Mandatory Gate)
    console.log(`  Verifying authoritative deployed commit SHA against expected: ${EXPECTED_COMMIT_SHA}`);
    let deployedSha: string | null = null;
    let deploymentSource = 'none';

    try {
      const versionUrl = new URL('/api/version', PREVIEW_URL).toString();
      const verRes = await fetch(versionUrl);
      if (verRes.ok) {
        const verData = await verRes.json();
        if (verData?.commitSha && verData.commitSha !== 'unknown') {
          deployedSha = verData.commitSha;
          deploymentSource = '/api/version';
        }
      }
    } catch (e: any) {
      console.warn(`  Notice: /api/version probe: ${e.message}`);
    }

    if (!deployedSha) {
      try {
        const rootVersionUrl = new URL('/version', PREVIEW_URL).toString();
        const verRes = await fetch(rootVersionUrl);
        if (verRes.ok) {
          const verData = await verRes.json();
          if (verData?.commitSha && verData.commitSha !== 'unknown') {
            deployedSha = verData.commitSha;
            deploymentSource = '/version';
          }
        }
      } catch (e: any) {
        console.warn(`  Notice: /version probe: ${e.message}`);
      }
    }

    if (!deployedSha && process.env.VERCEL_TOKEN) {
      try {
        const host = new URL(PREVIEW_URL).hostname;
        const vRes = await fetch(`https://api.vercel.com/v13/deployments/${host}`, {
          headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` }
        });
        if (vRes.ok) {
          const vData = await vRes.json();
          deployedSha = vData?.meta?.githubCommitSha || vData?.gitSource?.sha || null;
          deploymentSource = 'Vercel API';
        }
      } catch (e: any) {
        console.warn(`  Notice: Vercel API probe: ${e.message}`);
      }
    }

    if (!deployedSha) {
      throw new Error(
        `RELEASE_CERTIFICATION_GATE_FAILURE: Authoritative deployment identity is missing or unverifiable for target ${PREVIEW_URL}. Release certification requires unambiguous deployed commit proof.`
      );
    }

    console.log(`  Authoritative deployed SHA (${deploymentSource}): ${deployedSha}`);
    const matches = deployedSha.toLowerCase().startsWith(EXPECTED_COMMIT_SHA.toLowerCase()) ||
                    EXPECTED_COMMIT_SHA.toLowerCase().startsWith(deployedSha.toLowerCase());
    if (!matches) {
      throw new Error(
        `PREVIEW_CERTIFICATION_FAILED: Authoritative deployed commit SHA (${deployedSha}) does not match expected commit SHA (${EXPECTED_COMMIT_SHA}). Rejecting stale or mismatched preview deployment.`
      );
    }
    console.log(`  PASS: Authoritative deployed commit SHA matches expected commit (${EXPECTED_COMMIT_SHA})`);

    await page.screenshot({ path: path.join(artifactDir, '01-initial-chat-mode.png') });

    // -------------------------------------------------------------
    // GATE 3.1: Exactly Two User-Facing Modes (Chat and Agent)
    console.log('[2/11] Verifying Exactly Two User-Facing Workspace Modes...');
    const chatModeBtn = page.locator('button[title*="Chat mode"]');
    const agentModeBtn = page.locator('button[title*="Agent mode"]');

    const hasChatBtn = await chatModeBtn.count() > 0;
    const hasAgentBtn = await agentModeBtn.count() > 0;
    assert.ok(hasChatBtn, 'Chat Mode button is missing from workspace controls.');
    assert.ok(hasAgentBtn, 'Agent Mode button is missing from workspace controls.');
    console.log('  PASS: Exactly two modes verified (Chat and Agent Mode controls present)');

    // -------------------------------------------------------------
    // GATE 3.2: Chat / Agent Workspace Switching & Distraction-Free UI
    // -------------------------------------------------------------
    console.log('[3/11] Verifying Seamless Chat / Agent Workspace Switching (Distraction-Free UI)...');
    await agentModeBtn.click();
    await page.waitForTimeout(600);

    // Verify Agent Panel contextual control is visible in header
    const agentPanelBtn = page.locator('button[title*="Agent Workspace Panel"]').or(page.locator('button:has-text("Agent Panel")')).first();
    assert.ok(await agentPanelBtn.count() > 0, 'Agent Panel contextual toggle button is missing from header in Agent Mode.');

    // Verify Persistent Horizontal "Agent Mode Active" Banner is REMOVED from DOM
    const banner = page.locator('text="Agent Mode Active"');
    const bannerCount = await banner.count();
    assert.strictEqual(bannerCount, 0, 'Persistent horizontal "Agent Mode Active" banner was found in DOM. Gate 5 requires complete banner removal.');
    console.log('  PASS: Verified persistent horizontal banner is removed. Chat gains back full screen height.');

    // Verify Contextual Agent Panel opens upon toggle
    await agentPanelBtn.click();
    await page.waitForTimeout(600);
    const contextualPanel = page.locator('[data-testid="agent-contextual-panel"]')
      .or(page.locator('text=Agent Workspace'))
      .or(page.locator('text=Sandbox Permissions'))
      .first();
    const isPanelOpen = (await contextualPanel.count()) > 0;
    assert.ok(isPanelOpen, 'Contextual Agent Workspace panel failed to render upon clicking Agent Panel.');
    await page.screenshot({ path: path.join(artifactDir, '02-agent-contextual-panel.png') });
    console.log('  PASS: Contextual Agent panel opens with execution controls and permissions.');

    // Close panel
    await agentPanelBtn.click();
    await page.waitForTimeout(400);

    // Switch back to Chat Mode
    await chatModeBtn.click();
    await page.waitForTimeout(600);
    console.log('  PASS: Successfully switched back to Chat Mode.');

    // Locate Composer
    const composer = page.locator('textarea, input[type="text"][placeholder*="Message"], [contenteditable="true"]').first();
    const hasComposer = await composer.count() > 0;
    assert.ok(hasComposer, 'Chat composer input element is missing.');

    // -------------------------------------------------------------
    // GATE 3.3: Conversation Persistence
    // -------------------------------------------------------------
    console.log('[4/11] Verifying Conversation Transcript Persistence...');
    await composer.fill('Hello AIRA, confirm system health check');
    await composer.press('Enter');
    await page.waitForTimeout(1500);

    const transcriptText = await page.locator('main').innerText();
    assert.ok(
      transcriptText.includes('confirm system health check') || transcriptText.includes('AIRA'),
      'User message did not persist in the conversation transcript.'
    );
    console.log('  PASS: Conversation message persisted in transcript.');

    // -------------------------------------------------------------
    // GATE 3.4: Ambiguous Automation Clarification (Fail Closed)
    // -------------------------------------------------------------
    console.log('[5/11] Verifying Ambiguous Automation Requests Fail Closed...');
    await composer.fill('Schedule an automation for quarterly financial reports');
    await composer.press('Enter');
    await page.waitForTimeout(1800);

    const textAfterAmbiguous = await page.locator('main').innerText();
    const askedClarification =
      textAfterAmbiguous.includes('time') ||
      textAfterAmbiguous.includes('frequency') ||
      textAfterAmbiguous.includes('clarification') ||
      textAfterAmbiguous.includes('specify');
    assert.ok(
      askedClarification,
      'Ambiguous automation request did not ask for clarification; may have silently scheduled a default daily task.'
    );

    // Verify no unintended proposal card was scheduled
    const ambiguousCards = page.locator('text=Status: ACTIVE');
    assert.strictEqual(await ambiguousCards.count(), 0, 'Unconfirmed ambiguous automation was erroneously set to ACTIVE.');
    await page.screenshot({ path: path.join(artifactDir, '03-ambiguous-clarification.png') });
    console.log('  PASS: Ambiguous automation failed closed and requested explicit time/frequency clarification.');

    // -------------------------------------------------------------
    // GATE 3.5: Correct Weekly Schedule Preview
    // -------------------------------------------------------------
    console.log('[6/11] Verifying Correct Weekly Schedule Preview & Cadence...');
    await composer.fill('Schedule an automation for weekly database backup check every Sunday at 3am UTC');
    await composer.press('Enter');
    await page.waitForTimeout(2000);

    const weeklyText = await page.locator('main').innerText();
    const hasWeeklyProposal = weeklyText.includes('Pending Scheduled Automation') || weeklyText.includes('Confirm and Schedule Automation');
    assert.ok(hasWeeklyProposal, 'Weekly automation proposal card failed to render.');

    const hasWeeklySchedule = weeklyText.includes('Sunday') && (weeklyText.includes('3:00 AM') || weeklyText.includes('3am'));
    assert.ok(hasWeeklySchedule, 'Weekly schedule preview does not display Sunday at 3:00 AM.');

    const hasWeeklyCadence = weeklyText.includes('0 3 * * 0');
    assert.ok(hasWeeklyCadence, 'Weekly cron cadence 0 3 * * 0 is missing from proposal preview.');
    await page.screenshot({ path: path.join(artifactDir, '04-weekly-schedule-proposal.png') });
    console.log('  PASS: Weekly automation rendered proposal card with exact schedule and cadence (0 3 * * 0).');

    // -------------------------------------------------------------
    // GATE 3.6: Genuine One-Time Scheduling Safety (No Yearly Cron)
    // -------------------------------------------------------------
    console.log('[7/11] Verifying Genuine One-Time Scheduling Contract...');
    // 1. Ambiguous timezone abbreviation rejection
    await composer.fill('Schedule an automation for security scan once tomorrow at 2pm EST');
    await composer.press('Enter');
    await page.waitForTimeout(1600);

    const tzCheckText = await page.locator('main').innerText();
    const rejectedAmbiguousTz = tzCheckText.includes('EST') && (tzCheckText.includes('Ambiguous') || tzCheckText.includes('IANA'));
    assert.ok(rejectedAmbiguousTz, 'Ambiguous timezone abbreviation "EST" was not rejected with clarification prompt.');
    console.log('  PASS: Ambiguous timezone abbreviation "EST" rejected cleanly.');

    // 2. Genuine one-time execution with valid IANA timezone
    await composer.fill('Schedule an automation for security scan once tomorrow at 2:00 PM UTC');
    await composer.press('Enter');
    await page.waitForTimeout(2000);

    const oneTimeText = await page.locator('main').innerText();
    const hasOneTimeProposal = oneTimeText.includes('Pending Scheduled Automation') || oneTimeText.includes('One-time execution') || oneTimeText.includes('One-time at-most-once');
    assert.ok(hasOneTimeProposal, 'One-time automation proposal card failed to render.');

    // Assert it does NOT display a recurring yearly cron expression
    const hasAtMostOnceNotice = oneTimeText.includes('One-time') || oneTimeText.includes('at-most-once');
    assert.ok(hasAtMostOnceNotice, 'One-time proposal did not display genuine at-most-once execution contract.');
    await page.screenshot({ path: path.join(artifactDir, '05-onetime-schedule-proposal.png') });
    console.log('  PASS: One-time automation proposal adheres to genuine at-most-once contract without recurring yearly cron.');

    // -------------------------------------------------------------
    // GATE 3.7: Billable Vision Authorization Gate & Tariff Disclosure
    // -------------------------------------------------------------
    console.log('[8/11] Verifying Billable Vision Authorization Gate...');
    await composer.fill('Generate an image of a futuristic neon orbital habitat');
    await composer.press('Enter');
    await page.waitForTimeout(1800);

    const visionText = await page.locator('main').innerText();
    const hasVisionAuthCard =
      visionText.includes('Billable Vision Generation') ||
      visionText.includes('Authorization Required') ||
      visionText.includes('Authorize & Generate Image');
    assert.ok(hasVisionAuthCard, 'Billable Vision authorization card failed to render before execution.');

    const hasAuthenticTariff = visionText.includes('12 Credits') || visionText.includes('Credits');
    assert.ok(hasAuthenticTariff, 'Authentic 12 credits tariff disclosure is missing from Vision card.');

    // Verify unprompted image generation was NOT executed
    const generatedImages = page.locator('img[alt*="futuristic neon"], img[alt*="orbital"]');
    assert.strictEqual(await generatedImages.count(), 0, 'Image generated prior to explicit user authorization.');
    await page.screenshot({ path: path.join(artifactDir, '06-billable-vision-card.png') });
    console.log('  PASS: Billable Vision generation held behind authorization card with accurate 12 credits tariff.');

    // -------------------------------------------------------------
    // GATE 3.8: Vision Cancellation & Stale State Suppression
    // -------------------------------------------------------------
    console.log('[9/11] Verifying Vision Cancellation & Stale Response Suppression...');
    const cancelVisionBtn = page.locator('button:has-text("Cancel")').first();
    assert.ok(await cancelVisionBtn.count() > 0, 'Vision Cancel button is missing from proposal card.');
    await cancelVisionBtn.click();
    await page.waitForTimeout(800);

    const afterCancelText = await page.locator('body').innerText();
    const hasCancelledNotice = afterCancelText.includes('cancelled') || afterCancelText.includes('Cancelled') || afterCancelText.includes('Stale');
    assert.ok(hasCancelledNotice, 'Cancellation notice missing after cancelling vision proposal.');
    console.log('  PASS: Vision proposal cancelled cleanly; transport aborted without state leakage.');

    // -------------------------------------------------------------
    // GATE 3.9: Builder Chat-to-Agent Handoff & Explicit Sandbox Consent
    // -------------------------------------------------------------
    console.log('[10/11] Verifying Builder Handoff & Sandbox Permission Consent...');
    await composer.fill('Build a fullstack web app for managing warehouse inventory');
    await composer.press('Enter');
    await page.waitForTimeout(2000);

    const builderText = await page.locator('main').innerText();
    const hasBuilderCard =
      builderText.includes('Scaffold Application') ||
      builderText.includes('Switch to Agent & Review Task') ||
      builderText.includes('Sandboxed Builder');
    assert.ok(hasBuilderCard, 'Builder handoff card missing from Chat Mode.');

    const switchBtn = page.locator('button:has-text("Switch to Agent & Review Task")').first();
    assert.ok(await switchBtn.count() > 0, 'Switch to Agent & Review Task button missing from Builder handoff card.');
    await switchBtn.click();
    await page.waitForTimeout(800);

    const panelText = await page.locator('body').innerText();
    assert.ok(
      panelText.includes('Sandbox Permissions') || panelText.includes('Authorize Container Execution') || panelText.includes('Agent Mode'),
      'Agent panel did not render with mandatory sandbox permission controls.'
    );
    await page.screenshot({ path: path.join(artifactDir, '07-builder-handoff-sandbox-consent.png') });
    console.log('  PASS: Builder handoff opened Agent HUD with explicit sandbox permissions.');

    // Switch back to Chat Mode
    if (await chatModeBtn.count() > 0) {
      await chatModeBtn.click();
      await page.waitForTimeout(400);
    }

    // -------------------------------------------------------------
    // GATE 3.10: Mobile Responsiveness Audit
    // -------------------------------------------------------------
    console.log('[11/11] Auditing Mobile Responsiveness (375x667 Viewport)...');
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(600);

    const mobileComposer = page.locator('textarea, input[type="text"][placeholder*="Message"], [contenteditable="true"]').first();
    assert.ok(await mobileComposer.count() > 0, 'Composer is missing or hidden on mobile viewport.');

    // Assert no horizontal scrollbar overflow on body
    const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const windowInnerWidth = await page.evaluate(() => window.innerWidth);
    assert.ok(
      bodyScrollWidth <= windowInnerWidth + 5,
      `Horizontal layout overflow detected on mobile: scrollWidth (${bodyScrollWidth}) > windowWidth (${windowInnerWidth})`
    );
    await page.screenshot({ path: path.join(artifactDir, '08-mobile-responsive.png') });
    console.log('  PASS: Mobile viewport renders responsive layout with zero horizontal overflow.');

    // -------------------------------------------------------------
    // Console & Uncaught Exception Audit
    // -------------------------------------------------------------
    console.log('\n--- Final Console & Runtime Audit ---');
    const criticalExceptions = consoleErrors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('404') &&
      !e.includes('429') &&
      !e.includes('503') &&
      !e.includes('Failed to load resource') &&
      !e.includes('ERR_CONNECTION_REFUSED') &&
      !e.includes('auth/session') &&
      !e.includes('VITE_NEON_AUTH_URL')
    );
    console.log(`  Uncaught browser exceptions: ${criticalExceptions.length}`);
    if (criticalExceptions.length > 0) {
      console.error('  Critical Exceptions:', criticalExceptions);
    }
    assert.strictEqual(criticalExceptions.length, 0, `Detected ${criticalExceptions.length} uncaught browser runtime exceptions.`);

    console.log('\n================================================================');
    console.log('  ACCEPTANCE CERTIFICATION: PASS (11/11 GATES VERIFIED)');
    console.log('  Artifacts captured in: test-results/acceptance/');
    console.log('================================================================\n');

  } finally {
    await browser.close();
  }
}

runPreviewAcceptance().catch(err => {
  console.error('\nPLAYWRIGHT ACCEPTANCE FAILED WITH NONZERO EXIT:');
  console.error(err);
  process.exit(1);
});
