import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AIRA_COLLAB_CONTRACT_VERSION,
  CollabActorSchema,
  CollabOperationSchema,
  CollabPresenceSchema,
  CollabSessionStateSchema,
  type CollabActor,
  type CollabOperation,
} from '../packages/contracts/src/collaboration.js';

import { CollaborativeDocumentEngine } from '../src/utils/collaborationEngine.js';
import type { Artifact } from '../src/types/index.js';

test('AIRA GenUI Phase 4C — Collaborative CRDT Engine Unit Suite', async (t) => {
  const humanActorA: CollabActor = {
    actorId: 'usr-alice',
    principalId: 'p-alice',
    displayName: 'Alice Engineer',
    role: 'owner',
    isAgent: false,
    color: '#3b82f6',
  };

  const humanActorB: CollabActor = {
    actorId: 'usr-bob',
    principalId: 'p-bob',
    displayName: 'Bob Designer',
    role: 'editor',
    isAgent: false,
    color: '#10b981',
  };

  const agentActorData: CollabActor = {
    actorId: 'agent-data-1',
    principalId: 'p-system',
    displayName: 'Data Analyst Specialist',
    role: 'agent',
    isAgent: true,
    agentRole: 'data-analyst',
    runId: 'run-101',
    taskId: 'task-55',
    color: '#8b5cf6',
  };

  await t.test('1. Contract & Zod Schema Validation', () => {
    assert.equal(AIRA_COLLAB_CONTRACT_VERSION, 'aira-collab/v1');

    assert.doesNotThrow(() => CollabActorSchema.parse(humanActorA));
    assert.doesNotThrow(() => CollabActorSchema.parse(agentActorData));

    const sampleOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: 'sess-1',
      artifactId: 'art-1',
      actor: humanActorA,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'text_insert',
      payload: { position: 0, text: 'Hello World\n' },
    };

    assert.doesNotThrow(() => CollabOperationSchema.parse(sampleOp));
  });

  await t.test('2. Causal Lamport Ordering & State Vector Tracking', () => {
    const doc: Artifact = {
      id: 'doc-1',
      title: 'Design Doc',
      type: 'text/markdown',
      content: '# Title\n\nInitial paragraph.\n',
      version: 1,
      versions: [],
    };

    const engine = new CollaborativeDocumentEngine(doc);

    const op1: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: engine.sessionId,
      artifactId: doc.id,
      actor: humanActorA,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'text_insert',
      payload: { position: 8, text: 'Executive ' },
    };

    const res1 = engine.applyOperation(op1, true);
    assert.equal(res1.ok, true);
    assert.equal(res1.seq, 2);
    assert.equal(engine.getLamportClock(), 2);
    assert.equal(engine.getStateVector()['usr-alice'], 1);

    const op2: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: engine.sessionId,
      artifactId: doc.id,
      actor: humanActorB,
      baseSeq: 2,
      lamportClock: 3,
      timestamp: Date.now(),
      type: 'text_insert',
      payload: { position: 0, text: 'DRAFT: ' },
    };

    const res2 = engine.applyOperation(op2, true);
    assert.equal(res2.ok, true);
    assert.equal(res2.seq, 3);
    assert.equal(engine.getLamportClock(), 4);
    assert.equal(engine.getStateVector()['usr-bob'], 3);
  });

  await t.test('3. Idempotency — Duplicate opId is safely ignored', () => {
    const doc: Artifact = {
      id: 'doc-idempotency',
      title: 'Notes',
      type: 'text/markdown',
      content: 'Line 1\n',
      version: 1,
      versions: [],
    };

    const engine = new CollaborativeDocumentEngine(doc);
    const sharedOpId = crypto.randomUUID();

    const op: CollabOperation = {
      opId: sharedOpId,
      sessionId: engine.sessionId,
      artifactId: doc.id,
      actor: humanActorA,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'text_insert',
      payload: { position: 7, text: 'Line 2\n' },
    };

    const res1 = engine.applyOperation(op, true);
    assert.equal(res1.ok, true);
    assert.equal(res1.seq, 2);
    const contentAfterFirst = engine.getContent();

    // Duplicate submission of exact same opId
    const res2 = engine.applyOperation(op, true);
    assert.equal(res2.ok, true);
    assert.equal(engine.getContent(), contentAfterFirst, 'Duplicate operation must NOT duplicate text');
  });

  await t.test('4. Participant-Scoped Undo/Redo Invariants', () => {
    const doc: Artifact = {
      id: 'doc-undo',
      title: 'Shared Doc',
      type: 'text/markdown',
      content: 'Base ',
      version: 1,
      versions: [],
    };

    const engine = new CollaborativeDocumentEngine(doc);

    // Alice types "A"
    const aliceOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: engine.sessionId,
      artifactId: doc.id,
      actor: humanActorA,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'text_insert',
      payload: { position: 5, text: 'A' },
    };
    engine.applyOperation(aliceOp, true);
    assert.equal(engine.getContent(), 'Base A');

    // Bob types "B"
    const bobOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: engine.sessionId,
      artifactId: doc.id,
      actor: humanActorB,
      baseSeq: 2,
      lamportClock: 2,
      timestamp: Date.now(),
      type: 'text_insert',
      payload: { position: 6, text: 'B' },
    };
    engine.applyOperation(bobOp, true);
    assert.equal(engine.getContent(), 'Base AB');

    // Alice undos her edit — Bob's "B" must remain intact!
    const inverseOp = engine.undo('usr-alice');
    assert.notEqual(inverseOp, null);
    assert.equal(inverseOp!.type, 'text_delete');
    assert.equal(engine.getContent().includes('B'), true, "Bob's edit must NOT be erased when Alice undos");
  });

  await t.test('5. Spreadsheet Convergence & AST Recalculation', () => {
    const sheetDoc: Artifact = {
      id: 'sheet-crdt',
      title: 'Financial Model',
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
              A2: { raw: '200', computed: 200 },
              A3: { raw: '=A1+A2', computed: 300 },
            },
          },
        ],
      }),
      version: 1,
      versions: [],
    };

    const engine = new CollaborativeDocumentEngine(sheetDoc);

    // Agent updates cell A1 to 500
    const updateA1: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: engine.sessionId,
      artifactId: sheetDoc.id,
      actor: agentActorData,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'cell_update',
      payload: {
        sheetName: 'Q1',
        cellCoord: 'A1',
        cellValue: 500,
        cellFormula: '500',
      },
    };

    const res = engine.applyOperation(updateA1, true);
    assert.equal(res.ok, true);

    const parsedWb = JSON.parse(engine.getContent());
    assert.equal(parsedWb.sheets[0].cells.A1.computed, 500);
    // Formula =A1+A2 must automatically recalculate to 700!
    assert.equal(parsedWb.sheets[0].cells.A3.computed, 700, 'A3 formula must evaluate to 500+200=700');
  });

  await t.test('6. Same-Cell Conflict Detection & Attribution', () => {
    const sheetDoc: Artifact = {
      id: 'sheet-conflict',
      title: 'Budget',
      type: 'application/vnd.aira.sheet',
      content: JSON.stringify({
        activeSheet: 'Q1',
        sheets: [{ name: 'Q1', rowCount: 5, colCount: 5, cells: { B2: { raw: '10', computed: 10 } } }],
      }),
      version: 1,
      versions: [],
    };

    const engine = new CollaborativeDocumentEngine(sheetDoc);

    // Alice edits B2 based on seq 1
    const aliceOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: engine.sessionId,
      artifactId: sheetDoc.id,
      actor: humanActorA,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'cell_update',
      payload: { cellCoord: 'B2', cellValue: 50 },
    };
    engine.applyOperation(aliceOp, true);

    // Bob concurrently edits B2 also based on seq 1
    const bobOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: engine.sessionId,
      artifactId: sheetDoc.id,
      actor: humanActorB,
      baseSeq: 1, // Same baseSeq indicates concurrent conflict
      lamportClock: 1,
      timestamp: Date.now() + 10,
      type: 'cell_update',
      payload: { cellCoord: 'B2', cellValue: 75 },
    };
    const bobRes = engine.applyOperation(bobOp, true);

    assert.equal(bobRes.conflictDetected, true, 'Same-cell collision must flag conflictDetected');
    assert.equal(bobRes.conflictDetails?.includes('B2'), true);
    assert.equal(engine.cellConflicts.has('B2'), true);
  });

  await t.test('7. Presentation Slide Deck Mutex & Reordering', () => {
    const deckDoc: Artifact = {
      id: 'deck-collab',
      title: 'Company Overview',
      type: 'application/vnd.aira.slide',
      content: JSON.stringify({
        title: 'Company Overview',
        theme: 'default',
        slides: [
          { id: 's1', layout: 'title-slide', title: 'Welcome', bullets: [] },
          { id: 's2', layout: 'content', title: 'Roadmap', bullets: ['Milestone 1'] },
        ],
      }),
      version: 1,
      versions: [],
    };

    const engine = new CollaborativeDocumentEngine(deckDoc);

    // Insert new slide at index 1
    const insertOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: engine.sessionId,
      artifactId: deckDoc.id,
      actor: humanActorA,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'slide_mutate',
      payload: {
        slideAction: 'insert',
        slideIndex: 1,
        slideData: { id: 's-new', layout: 'content', title: 'Executive Summary', bullets: ['Q4 Goal'] },
      },
    };

    const res = engine.applyOperation(insertOp, true);
    assert.equal(res.ok, true);

    const deck = JSON.parse(engine.getContent());
    assert.equal(deck.slides.length, 3);
    assert.equal(deck.slides[1].id, 's-new');
  });

  await t.test('8. Ephemeral Presence TTL & State Vector Delta Computation', () => {
    const doc: Artifact = {
      id: 'doc-presence',
      title: 'Team Notes',
      type: 'text/markdown',
      content: 'Hello',
      version: 1,
      versions: [],
    };

    const engine = new CollaborativeDocumentEngine(doc);

    // Active presence
    engine.updatePresence({
      actorId: humanActorA.actorId,
      actor: humanActorA,
      artifactId: doc.id,
      status: 'active',
      updatedAt: Date.now(),
    });

    const activePresences = engine.getActivePresences(30000);
    assert.equal(activePresences.length, 1);
    assert.equal(activePresences[0].actorId, 'usr-alice');

    // Simulate stale presence (> 30s ago)
    engine.updatePresence({
      actorId: humanActorB.actorId,
      actor: humanActorB,
      artifactId: doc.id,
      status: 'active',
      updatedAt: Date.now() - 35000,
    });

    const refreshedPresences = engine.getActivePresences(30000);
    assert.equal(refreshedPresences.length, 1, 'Stale presence > 30s must be filtered out');

    // State Vector Delta
    const aliceOp: CollabOperation = {
      opId: crypto.randomUUID(),
      sessionId: engine.sessionId,
      artifactId: doc.id,
      actor: humanActorA,
      baseSeq: 1,
      lamportClock: 5,
      timestamp: Date.now(),
      type: 'text_insert',
      payload: { position: 5, text: ' World' },
    };
    engine.applyOperation(aliceOp, true);

    // Remote peer has alice up to clock 2
    const missing = engine.computeDeltaSince({ 'usr-alice': 2 });
    assert.equal(missing.length, 1);
    assert.equal(missing[0].opId, aliceOp.opId);
  });
});
