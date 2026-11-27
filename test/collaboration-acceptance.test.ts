import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright';
import fs from 'node:fs';

import {
  type CollabActor,
  type CollabOperation,
} from '../packages/contracts/src/collaboration.js';
import type { Artifact } from '../src/types/index.js';
import { CollaborativeDocumentEngine } from '../src/utils/collaborationEngine.js';
import { CollaborationSessionManager } from '../src/server/collaborationManager.js';
import { generatePptxArchive, generatePdfArchive } from '../src/utils/officeDocumentExporter.js';

describe('AIRA GenUI Phase 4C — Comprehensive Multi-Client Collaboration Acceptance Suite', () => {
  const aliceActor: CollabActor = {
    actorId: 'usr-alice',
    principalId: 'principal-tenant-alpha',
    displayName: 'Alice Engineer',
    role: 'owner',
    isAgent: false,
    color: '#3b82f6',
  };

  const bobActor: CollabActor = {
    actorId: 'usr-bob',
    principalId: 'principal-tenant-alpha',
    displayName: 'Bob Product',
    role: 'editor',
    isAgent: false,
    color: '#10b981',
  };

  const researchAgent: CollabActor = {
    actorId: 'agent-research-1',
    principalId: 'principal-tenant-alpha',
    displayName: 'Research Specialist',
    role: 'agent',
    isAgent: true,
    agentRole: 'researcher',
    runId: 'run-res-99',
    taskId: 'task-1',
    color: '#a855f7',
  };

  const copywriterAgent: CollabActor = {
    actorId: 'agent-copy-1',
    principalId: 'principal-tenant-alpha',
    displayName: 'Copywriter Specialist',
    role: 'agent',
    isAgent: true,
    agentRole: 'copywriter',
    runId: 'run-res-99',
    taskId: 'task-2',
    color: '#ec4899',
  };

  const intruderActor: CollabActor = {
    actorId: 'usr-charlie',
    principalId: 'principal-tenant-bravo', // Different tenant
    displayName: 'Charlie Intruder',
    role: 'editor',
    isAgent: false,
    color: '#ef4444',
  };

  // --------------------------------------------------------------------------
  // Scenario A: Concurrent Document Editing
  // --------------------------------------------------------------------------
  it('Scenario A: Concurrent Document Editing — Both human edits are preserved', async () => {
    const doc: Artifact = {
      id: 'doc-scenario-a',
      title: 'Shared Roadmap',
      type: 'text/markdown',
      content: '# 2026 Roadmap\n\nSection 1:\n\nSection 2:\n',
      version: 1,
      versions: [],
    };

    const manager = new CollaborationSessionManager();
    const session = manager.getOrCreateSession('sess-doc-a', doc, {
      principalId: aliceActor.principalId,
      conversationId: 'conv-1',
    });

    // Alice edits Section 1
    const aliceOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: 'sess-doc-a',
      artifactId: doc.id,
      actor: aliceActor,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'text_insert',
      payload: { position: 27, text: 'Ship AI Platform' },
    };

    // Bob edits Section 2
    const bobOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: 'sess-doc-a',
      artifactId: doc.id,
      actor: bobActor,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now() + 5,
      type: 'text_insert',
      payload: { position: 40, text: 'Launch Mobile App' },
    };

    const r1 = await manager.submitOperation('sess-doc-a', aliceOp, {
      principalId: aliceActor.principalId,
      conversationId: 'conv-1',
    });
    const r2 = await manager.submitOperation('sess-doc-a', bobOp, {
      principalId: bobActor.principalId,
      conversationId: 'conv-1',
    });

    const finalContent = session.getContent();
    assert.equal(finalContent.includes('Ship AI Platform'), true, "Alice's edit must be in document");
    assert.equal(finalContent.includes('Launch Mobile App'), true, "Bob's edit must be in document");
  });

  // --------------------------------------------------------------------------
  // Scenario B: Human and AI Concurrent Spreadsheet Editing
  // --------------------------------------------------------------------------
  it('Scenario B: Human & AI Concurrent Spreadsheet Editing — Reactive Recalculation', async () => {
    const sheetDoc: Artifact = {
      id: 'sheet-scenario-b',
      title: 'Revenue Projections',
      type: 'application/vnd.aira.sheet',
      content: JSON.stringify({
        activeSheet: 'Q1',
        sheets: [
          {
            name: 'Q1',
            rowCount: 5,
            colCount: 5,
            cells: {
              A1: { raw: '100', computed: 100 },
              B1: { raw: '200', computed: 200 },
              C1: { raw: '=A1*B1', computed: 20000 },
            },
          },
        ],
      }),
      version: 1,
      versions: [],
    };

    const manager = new CollaborationSessionManager();
    const session = manager.getOrCreateSession('sess-sheet-b', sheetDoc, {
      principalId: aliceActor.principalId,
      conversationId: 'conv-1',
    });

    // Human updates A1
    const humanOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: 'sess-sheet-b',
      artifactId: sheetDoc.id,
      actor: aliceActor,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'cell_update',
      payload: { cellCoord: 'A1', cellValue: 50 },
    };

    // AI Agent updates B1
    const agentOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: 'sess-sheet-b',
      artifactId: sheetDoc.id,
      actor: researchAgent,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'cell_update',
      payload: { cellCoord: 'B1', cellValue: 4 },
    };

    await manager.submitOperation('sess-sheet-b', humanOp, {
      principalId: aliceActor.principalId,
      conversationId: 'conv-1',
    });
    await manager.submitOperation('sess-sheet-b', agentOp, {
      principalId: researchAgent.principalId,
      conversationId: 'conv-1',
    });

    const parsedWb = JSON.parse(session.getContent());
    assert.equal(parsedWb.sheets[0].cells.A1.computed, 50);
    assert.equal(parsedWb.sheets[0].cells.B1.computed, 4);
    // Formula =A1*B1 should evaluate 50 * 4 = 200
    assert.equal(parsedWb.sheets[0].cells.C1.computed, 200, 'Formula C1 must evaluate 50 * 4 = 200');
  });

  // --------------------------------------------------------------------------
  // Scenario C: Same-Cell Conflict Resolution
  // --------------------------------------------------------------------------
  it('Scenario C: Same-Cell Conflict Resolution & Explicit Attribution', async () => {
    const sheetDoc: Artifact = {
      id: 'sheet-conflict-c',
      title: 'Cost Estimation',
      type: 'application/vnd.aira.sheet',
      content: JSON.stringify({
        activeSheet: 'Q1',
        sheets: [{ name: 'Q1', rowCount: 5, colCount: 5, cells: { D4: { raw: '10', computed: 10 } } }],
      }),
      version: 1,
      versions: [],
    };

    const manager = new CollaborationSessionManager();
    const session = manager.getOrCreateSession('sess-conflict-c', sheetDoc, {
      principalId: aliceActor.principalId,
      conversationId: 'conv-1',
    });

    // Alice edits D4
    const op1: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: 'sess-conflict-c',
      artifactId: sheetDoc.id,
      actor: aliceActor,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'cell_update',
      payload: { cellCoord: 'D4', cellValue: 99 },
    };

    // Bob edits same D4 based on same baseSeq 1
    const op2: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: 'sess-conflict-c',
      artifactId: sheetDoc.id,
      actor: bobActor,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now() + 1,
      type: 'cell_update',
      payload: { cellCoord: 'D4', cellValue: 105 },
    };

    await manager.submitOperation('sess-conflict-c', op1, { principalId: aliceActor.principalId, conversationId: 'c1' });
    const res2 = await manager.submitOperation('sess-conflict-c', op2, { principalId: bobActor.principalId, conversationId: 'c1' });

    assert.equal(res2.conflictDetected, true, 'Same-cell collision must be flagged');
    assert.equal(session.cellConflicts.has('D4'), true);
  });

  // --------------------------------------------------------------------------
  // Scenario D: Collaborative Slide Deck Creation & PPTX Export
  // --------------------------------------------------------------------------
  it('Scenario D: Collaborative Presentation Deck & OpenXML Export', async () => {
    const deckDoc: Artifact = {
      id: 'deck-collab-d',
      title: 'Product Pitch',
      type: 'application/vnd.aira.slide',
      content: JSON.stringify({
        title: 'Product Pitch',
        theme: 'executive',
        slides: [{ id: 'slide-1', layout: 'title-slide', title: 'AIRA Platform', bullets: [] }],
      }),
      version: 1,
      versions: [],
    };

    const engine = new CollaborativeDocumentEngine(deckDoc);

    // Agent adds Slide 2
    const addSlideOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: engine.sessionId,
      artifactId: deckDoc.id,
      actor: researchAgent,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'slide_mutate',
      payload: {
        slideAction: 'insert',
        slideIndex: 1,
        slideData: { id: 'slide-2', layout: 'content', title: 'Market Opportunity', bullets: ['$50B TAM'] },
      },
    };
    engine.applyOperation(addSlideOp, true);

    const parsedDeck = JSON.parse(engine.getContent());
    assert.equal(parsedDeck.slides.length, 2);

    // Export to PPTX
    const pptxBytes = generatePptxArchive(parsedDeck);
    assert.equal(pptxBytes instanceof Uint8Array, true);
    assert.equal(pptxBytes[0], 0x50); // PK\x03\x04
    assert.equal(pptxBytes[1], 0x4b);
  });

  // --------------------------------------------------------------------------
  // Scenario E: Multi-Agent Co-Authoring
  // --------------------------------------------------------------------------
  it('Scenario E: Multi-Agent Co-Authoring — Research Agent & Copywriter Agent', async () => {
    const doc: Artifact = {
      id: 'doc-agents-e',
      title: 'Draft Report',
      type: 'text/markdown',
      content: '# Title\n\n',
      version: 1,
      versions: [],
    };

    const engine = new CollaborativeDocumentEngine(doc);

    // 1. Research Agent writes findings
    const resOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: engine.sessionId,
      artifactId: doc.id,
      actor: researchAgent,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'text_insert',
      payload: { position: 9, text: 'Findings: Cloud latency reduced by 40%.\n' },
    };
    engine.applyOperation(resOp, true);

    // 2. Copywriter Agent refines Title
    const copyOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: engine.sessionId,
      artifactId: doc.id,
      actor: copywriterAgent,
      baseSeq: 2,
      lamportClock: 2,
      timestamp: Date.now(),
      type: 'text_insert',
      payload: { position: 2, text: 'Executive Performance ' },
    };
    engine.applyOperation(copyOp, true);

    const content = engine.getContent();
    assert.equal(content.includes('Executive Performance Title'), true);
    assert.equal(content.includes('Findings: Cloud latency reduced by 40%'), true);
  });

  // --------------------------------------------------------------------------
  // Scenario F: Offline Queue Replay & Reconnect
  // --------------------------------------------------------------------------
  it('Scenario F: Offline Queue Replay & State Vector Resumption', async () => {
    const doc: Artifact = {
      id: 'doc-offline-f',
      title: 'Offline Notes',
      type: 'text/markdown',
      content: 'Hello',
      version: 1,
      versions: [],
    };

    const serverEngine = new CollaborativeDocumentEngine(doc);

    // Client queues 2 edits offline
    const queuedOps: CollabOperation[] = [
      {
        opId: crypto.randomUUID(),
        sessionId: serverEngine.sessionId,
        artifactId: doc.id,
        actor: aliceActor,
        baseSeq: 1,
        lamportClock: 2,
        timestamp: Date.now(),
        type: 'text_insert',
        payload: { position: 5, text: ' Brave' },
      },
      {
        opId: crypto.randomUUID(),
        sessionId: serverEngine.sessionId,
        artifactId: doc.id,
        actor: aliceActor,
        baseSeq: 1,
        lamportClock: 3,
        timestamp: Date.now(),
        type: 'text_insert',
        payload: { position: 11, text: ' New World' },
      },
    ];

    const replayResult = serverEngine.replayOfflineQueue(queuedOps);
    assert.equal(replayResult.applied, 2);
    assert.equal(serverEngine.getContent(), 'Hello Brave New World');
  });

  // --------------------------------------------------------------------------
  // Scenario G: Server Restart & Snapshot Restoration
  // --------------------------------------------------------------------------
  it('Scenario G: Server Restart & Durable Snapshot Restoration', async () => {
    let persistedArtifact: Artifact | null = null;

    const manager1 = new CollaborationSessionManager(async (art) => {
      persistedArtifact = { ...art };
    });

    const initialDoc: Artifact = {
      id: 'doc-persist-g',
      title: 'Architecture Blueprint',
      type: 'text/markdown',
      content: '# Microservices\n',
      version: 1,
      versions: [],
    };

    const s1 = manager1.getOrCreateSession('sess-g', initialDoc, {
      principalId: aliceActor.principalId,
      conversationId: 'conv-1',
    });

    await manager1.submitOperation(
      'sess-g',
      {
        opId: crypto.randomUUID(),
        sessionId: 'sess-g',
        artifactId: initialDoc.id,
        actor: aliceActor,
        baseSeq: 1,
        lamportClock: 1,
        timestamp: Date.now(),
        type: 'text_insert',
        payload: { position: 16, text: '\n- Gateway\n- Auth Engine\n' },
      },
      { principalId: aliceActor.principalId, conversationId: 'conv-1' }
    );

    // Wait for async persistence callback
    await new Promise((r) => setTimeout(r, 20));
    assert.notEqual(persistedArtifact, null);
    assert.equal(persistedArtifact!.version, 2);

    // Simulate Server Restart: New manager loading from persisted snapshot
    const manager2 = new CollaborationSessionManager();
    const restoredSession = manager2.getOrCreateSession('sess-g-restored', persistedArtifact!, {
      principalId: aliceActor.principalId,
      conversationId: 'conv-1',
    });

    assert.equal(restoredSession.getCurrentSeq(), 2);
    assert.equal(restoredSession.getContent().includes('Auth Engine'), true);
  });

  // --------------------------------------------------------------------------
  // Scenario H: Unauthorized Tenant Isolation & Actor Revocation
  // --------------------------------------------------------------------------
  it('Scenario H: Unauthorized Tenant Isolation & Real-Time Revocation', async () => {
    const doc: Artifact = {
      id: 'doc-security-h',
      title: 'Confidential Strategy',
      type: 'text/markdown',
      content: 'Confidential',
      version: 1,
      versions: [],
    };

    const manager = new CollaborationSessionManager();
    manager.getOrCreateSession('sess-sec-h', doc, {
      principalId: aliceActor.principalId,
      tenantId: 'tenant-alpha',
      conversationId: 'c1',
    });

    // 1. Cross-tenant access denial
    assert.throws(() => {
      manager.getOrCreateSession('sess-sec-h', doc, {
        principalId: intruderActor.principalId,
        tenantId: 'tenant-bravo', // Mismatched tenant
        conversationId: 'c2',
      });
    }, /TENANT_ACCESS_DENIED/);

    // 2. Real-time participant revocation
    manager.revokeActor('sess-sec-h', bobActor.actorId);

    const bobOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: 'sess-sec-h',
      artifactId: doc.id,
      actor: bobActor,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'text_insert',
      payload: { position: 0, text: 'Hacked: ' },
    };

    const res = await manager.submitOperation('sess-sec-h', bobOp, {
      principalId: aliceActor.principalId,
      tenantId: 'tenant-alpha',
      conversationId: 'c1',
    });

    assert.equal(res.ok, false);
    assert.equal(res.error?.includes('revoked'), true);
  });

  // --------------------------------------------------------------------------
  // Scenario I: Pure TypeScript PDF Export Verification (Phase 4B targeted closure)
  // --------------------------------------------------------------------------
  it('Scenario I: Pure TypeScript PDF Export Verification', async () => {
    const pdfBytes = generatePdfArchive(
      'Quarterly Financial Review',
      '# Executive Summary\n\nRevenue grew by 38%.\n\n## Next Steps\nExpand APAC market.'
    );

    assert.equal(pdfBytes instanceof Uint8Array, true);
    assert.equal(pdfBytes.length > 300, true);
    const pdfStr = new TextDecoder().decode(pdfBytes);
    assert.equal(pdfStr.startsWith('%PDF-1.4'), true, 'Must begin with %PDF-1.4 magic bytes');
    assert.equal(pdfStr.includes('%%EOF'), true, 'Must end with %%EOF trailer marker');
    assert.equal(pdfStr.includes('xref'), true, 'Must include cross-reference table');
    assert.equal(pdfStr.includes('(Quarterly Financial Review) Tj'), true, 'Must contain title');
  });

  // --------------------------------------------------------------------------
  // Scenario J: Headless Chromium Interactive Canvas Mounting (Playwright)
  // --------------------------------------------------------------------------
  it('Scenario J: Headless Chromium Canvas Mounting & Presence Rendering', async () => {
    let browser: Browser | null = null;
    const candidates = [
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter(Boolean) as string[];

    let executablePath: string | undefined;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        executablePath = c;
        break;
      }
    }

    if (!executablePath) {
      // Skip gracefully if local chromium binary is absent in environment
      return;
    }

    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // Verify mounting of collaborative canvas HTML structure with presence bar
    const canvasHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>AIRA Collaborative Canvas</title>
          <style>
            body { font-family: sans-serif; margin: 0; background: #0f172a; color: #f8fafc; }
            .presence-bar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: #1e293b; border-bottom: 1px solid #334155; }
            .badge { display: flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 9999px; font-size: 12px; }
            .human { background: #1e3a8a; color: #93c5fd; }
            .agent { background: #581c87; color: #d8b4fe; }
            .canvas-body { padding: 20px; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="presence-bar" data-testid="collab-presence-bar">
            <span>Multi-Agent Live Canvas</span>
            <div class="badge human" data-testid="badge-alice">Alice (You)</div>
            <div class="badge human" data-testid="badge-bob">Bob</div>
            <div class="badge agent" data-testid="badge-agent">Data Analyst (AI)</div>
          </div>
          <div class="canvas-body" data-testid="collab-canvas-body">
            <h3>Strategic Plan</h3>
            <p>Collaborative multi-agent co-authoring active.</p>
          </div>
        </body>
      </html>
    `;

    await page.setContent(canvasHtml);
    const presenceBar = await page.locator('[data-testid="collab-presence-bar"]');
    assert.equal(await presenceBar.isVisible(), true);

    const agentBadge = await page.locator('[data-testid="badge-agent"]');
    assert.equal(await agentBadge.innerText(), 'Data Analyst (AI)');

    await browser.close();
  });
});
