import test from 'node:test';
import assert from 'node:assert/strict';
import { CollaborativeDocumentEngine } from '../src/utils/collaborationEngine.js';
import { CollaborationSessionManager } from '../src/server/collaborationManager.js';
import type { CollabActor, CollabOperation, CollabPresence } from '../packages/contracts/src/collaboration.js';
import type { Artifact } from '../src/types/index.js';

test.describe('AIRA GenUI Phase 5A — Comprehensive CRDT Property & Concurrency Verification', () => {
  const alice: CollabActor = {
    actorId: 'usr_alice',
    principalId: 'p_alice',
    displayName: 'Alice Engineer',
    role: 'editor',
    color: '#3B82F6',
  };

  const bob: CollabActor = {
    actorId: 'usr_bob',
    principalId: 'p_bob',
    displayName: 'Bob Architect',
    role: 'editor',
    color: '#10B981',
  };

  const charlie: CollabActor = {
    actorId: 'usr_charlie',
    principalId: 'p_charlie',
    displayName: 'Charlie Agent',
    role: 'editor',
    isAgent: true,
    agentRole: 'Research Specialist',
    color: '#F59E0B',
  };

  const baseArtifact: Artifact = {
    id: 'art-prop-01',
    title: 'Distributed Concurrency Spec',
    type: 'application/vnd.ant.markdown',
    content: 'Initial text for distributed test.',
    version: 1,
    versions: [],
  };

  test('Property 1: Concurrent insertions at identical positions preserve all fragments', () => {
    const engine = new CollaborativeDocumentEngine(baseArtifact, 'sess-prop-1');
    const startLen = engine.getContent().length;

    // Both Alice and Bob concurrently insert at index 0 based on baseSeq: 1
    const opAlice: CollabOperation = {
      opId: 'op_a_01',
      sessionId: 'sess-prop-1',
      artifactId: baseArtifact.id,
      actor: alice,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'text_insert',
      payload: { position: 0, text: '[ALICE_HEADER] ' },
    };

    const opBob: CollabOperation = {
      opId: 'op_b_01',
      sessionId: 'sess-prop-1',
      artifactId: baseArtifact.id,
      actor: bob,
      baseSeq: 1,
      lamportClock: 2,
      timestamp: Date.now() + 1,
      type: 'text_insert',
      payload: { position: 0, text: '[BOB_HEADER] ' },
    };

    const resA = engine.applyOperation(opAlice, true);
    assert.equal(resA.ok, true);

    const resB = engine.applyOperation(opBob, true);
    assert.equal(resB.ok, true);

    const finalContent = engine.getContent();
    assert.equal(finalContent.includes('[ALICE_HEADER]'), true);
    assert.equal(finalContent.includes('[BOB_HEADER]'), true);
    assert.equal(finalContent.includes('Initial text for distributed test.'), true);
    assert.equal(finalContent.length, startLen + '[ALICE_HEADER] '.length + '[BOB_HEADER] '.length);
  });

  test('Property 2: Concurrent deletion and insertion interleave deterministically', () => {
    const docArtifact: Artifact = {
      id: 'art-prop-02',
      title: 'Deletion Spec',
      type: 'application/vnd.ant.markdown',
      content: 'ABCDEFGHIJ', // 10 chars
      version: 1,
      versions: [],
    };
    const engine = new CollaborativeDocumentEngine(docArtifact, 'sess-prop-2');

    // Alice deletes characters 0..5 ('ABCDE') based on baseSeq: 1
    const opAlice: CollabOperation = {
      opId: 'op_a_del',
      sessionId: 'sess-prop-2',
      artifactId: docArtifact.id,
      actor: alice,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'text_delete',
      payload: { position: 0, length: 5 },
    };

    // Bob inserts 'XYZ' at position 8 ('I') based on baseSeq: 1
    const opBob: CollabOperation = {
      opId: 'op_b_ins',
      sessionId: 'sess-prop-2',
      artifactId: docArtifact.id,
      actor: bob,
      baseSeq: 1,
      lamportClock: 2,
      timestamp: Date.now() + 2,
      type: 'text_insert',
      payload: { position: 8, text: 'XYZ' },
    };

    const resA = engine.applyOperation(opAlice, true);
    assert.equal(resA.ok, true);
    const resB = engine.applyOperation(opBob, true);
    assert.equal(resB.ok, true);

    const content = engine.getContent();
    assert.equal(content, 'FGHXYZIJ');
    assert.equal(content.includes('XYZ'), true);
    assert.equal(content.includes('ABCDE'), false);
  });

  test('Property 3: Idempotency under repeated operations (at-least-once delivery safety)', () => {
    const engine = new CollaborativeDocumentEngine(baseArtifact, 'sess-prop-3');
    const op: CollabOperation = {
      opId: 'op_idempotent_01',
      sessionId: 'sess-prop-3',
      artifactId: baseArtifact.id,
      actor: alice,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'text_insert',
      payload: { position: 0, text: 'UNIQUE_IDEMPOTENT_PREFIX: ' },
    };

    // Apply first time
    const res1 = engine.applyOperation(op, true);
    assert.equal(res1.ok, true);
    const contentAfterFirst = engine.getContent();
    const seqAfterFirst = engine.getCurrentSeq();

    // Replay 20 times (simulating network retry flooding)
    for (let i = 0; i < 20; i++) {
      const replayRes = engine.applyOperation(op, true);
      assert.equal(replayRes.ok, true);
      assert.equal(engine.getContent(), contentAfterFirst);
      assert.equal(engine.getCurrentSeq(), seqAfterFirst);
    }
  });

  test('Property 4: State-vector delta computation for reconnect & catch-up', () => {
    const engine = new CollaborativeDocumentEngine(baseArtifact, 'sess-prop-4');

    const ops: CollabOperation[] = [
      {
        opId: 'op_cv_01',
        sessionId: 'sess-prop-4',
        artifactId: baseArtifact.id,
        actor: alice,
        baseSeq: 1,
        lamportClock: 1,
        timestamp: 100,
        type: 'text_insert',
        payload: { position: 0, text: 'A1 ' },
      },
      {
        opId: 'op_cv_02',
        sessionId: 'sess-prop-4',
        artifactId: baseArtifact.id,
        actor: bob,
        baseSeq: 2,
        lamportClock: 2,
        timestamp: 200,
        type: 'text_insert',
        payload: { position: 3, text: 'B1 ' },
      },
      {
        opId: 'op_cv_03',
        sessionId: 'sess-prop-4',
        artifactId: baseArtifact.id,
        actor: charlie,
        baseSeq: 3,
        lamportClock: 3,
        timestamp: 300,
        type: 'text_insert',
        payload: { position: 6, text: 'C1 ' },
      },
    ];

    for (const op of ops) {
      engine.applyOperation(op, true);
    }

    // Client only has seen Alice clock 1, missing Bob (2) and Charlie (3)
    const clientStateVector = { usr_alice: 1, usr_bob: 0, usr_charlie: 0 };
    const missing = engine.computeDeltaSince(clientStateVector);

    assert.equal(missing.length, 2);
    assert.equal(missing[0].opId, 'op_cv_02');
    assert.equal(missing[1].opId, 'op_cv_03');
  });

  test('Property 5: Multiple independent replicas converge via delta synchronization', () => {
    const manager = new CollaborationSessionManager();
    const sessionAuth = { principalId: 'p_owner', conversationId: 'c_test' };
    const serverEngine = manager.getOrCreateSession('room-replica-sync', baseArtifact, sessionAuth);

    const replica1 = new CollaborativeDocumentEngine(baseArtifact, 'room-replica-sync');
    const replica2 = new CollaborativeDocumentEngine(baseArtifact, 'room-replica-sync');

    // Replica 1 generates edit
    const opR1: CollabOperation = {
      opId: 'op_rep_1',
      sessionId: 'room-replica-sync',
      artifactId: baseArtifact.id,
      actor: alice,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: 10,
      type: 'text_insert',
      payload: { position: 0, text: 'R1_EDIT ' },
    };
    replica1.applyOperation(opR1, true);

    // Replica 2 generates edit concurrently based on baseSeq: 1
    const opR2: CollabOperation = {
      opId: 'op_rep_2',
      sessionId: 'room-replica-sync',
      artifactId: baseArtifact.id,
      actor: bob,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: 20,
      type: 'text_insert',
      payload: { position: baseArtifact.content.length, text: ' R2_EDIT' },
    };
    replica2.applyOperation(opR2, true);

    // Submit both to authoritative server
    serverEngine.applyOperation(opR1, true);
    serverEngine.applyOperation(opR2, true);

    // Sync Replica 1 with missing ops from server
    const r1Missing = serverEngine.computeDeltaSince(replica1.getStateVector());
    for (const m of r1Missing) {
      replica1.applyOperation(m, true);
    }

    // Sync Replica 2 with missing ops from server
    const r2Missing = serverEngine.computeDeltaSince(replica2.getStateVector());
    for (const m of r2Missing) {
      replica2.applyOperation(m, true);
    }

    // Both replicas and server must achieve identical content
    assert.equal(replica1.getContent(), serverEngine.getContent());
    assert.equal(replica2.getContent(), serverEngine.getContent());
    assert.equal(replica1.getContent().includes('R1_EDIT'), true);
    assert.equal(replica1.getContent().includes('R2_EDIT'), true);
  });

  test('Property 6: Participant-scoped undo/redo preserves concurrent peer edits', () => {
    const engine = new CollaborativeDocumentEngine(baseArtifact, 'sess-prop-6');

    // Alice inserts text
    const opA: CollabOperation = {
      opId: 'op_undo_a',
      sessionId: 'sess-prop-6',
      artifactId: baseArtifact.id,
      actor: alice,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: 100,
      type: 'text_insert',
      payload: { position: 0, text: '[ALICE_NOTE] ' },
    };
    engine.applyOperation(opA, true);

    // Bob inserts text concurrently
    const opB: CollabOperation = {
      opId: 'op_undo_b',
      sessionId: 'sess-prop-6',
      artifactId: baseArtifact.id,
      actor: bob,
      baseSeq: 2,
      lamportClock: 2,
      timestamp: 200,
      type: 'text_insert',
      payload: { position: engine.getContent().length, text: ' [BOB_NOTE]' },
    };
    engine.applyOperation(opB, true);

    assert.equal(engine.getContent().includes('[ALICE_NOTE]'), true);
    assert.equal(engine.getContent().includes('[BOB_NOTE]'), true);

    // Alice performs undo
    const inverseOp = engine.undo(alice.actorId);
    assert.notEqual(inverseOp, null);

    // Alice's note should be removed, but Bob's note must remain completely intact
    const contentAfterUndo = engine.getContent();
    assert.equal(contentAfterUndo.includes('[ALICE_NOTE]'), false, 'Alice note must be removed on undo');
    assert.equal(contentAfterUndo.includes('[BOB_NOTE]'), true, 'Bob note must remain intact after Alice undo');
  });

  test('Property 7: Spreadsheet cell-level LWW convergence and reactive recalculation', () => {
    const sheetArtifact: Artifact = {
      id: 'art-sheet-prop',
      title: 'Financial Model',
      type: 'application/vnd.aira.sheet',
      content: JSON.stringify({
        activeSheet: 'Sheet1',
        sheets: [
          {
            name: 'Sheet1',
            rowCount: 10,
            colCount: 5,
            cells: {
              A1: { raw: '50', computed: 50 },
              A2: { raw: '100', computed: 100 },
              A3: { raw: '=A1*A2', computed: 5000 },
            },
          },
        ],
      }),
      version: 1,
      versions: [],
    };

    const engine = new CollaborativeDocumentEngine(sheetArtifact, 'sess-sheet-prop');

    // Concurrent edits to A1 (Alice sets 60, Bob sets 70 with higher lamport clock)
    const opAlice: CollabOperation = {
      opId: 'op_sheet_a',
      sessionId: 'sess-sheet-prop',
      artifactId: sheetArtifact.id,
      actor: alice,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: 100,
      type: 'cell_update',
      payload: { cellCoord: 'A1', cellRaw: '60' },
    };

    const opBob: CollabOperation = {
      opId: 'op_sheet_b',
      sessionId: 'sess-sheet-prop',
      artifactId: sheetArtifact.id,
      actor: bob,
      baseSeq: 1,
      lamportClock: 2, // higher lamport clock wins
      timestamp: 101,
      type: 'cell_update',
      payload: { cellCoord: 'A1', cellRaw: '70' },
    };

    const resA = engine.applyOperation(opAlice, true);
    assert.equal(resA.ok, true);

    const resB = engine.applyOperation(opBob, true);
    assert.equal(resB.ok, true);
    assert.equal(resB.conflictDetected, true, 'Same-cell collision must be flagged');

    const updatedSheet = JSON.parse(engine.getContent());
    assert.equal(updatedSheet.sheets[0].cells.A1.computed, 70, 'Bob edit wins due to higher Lamport clock');
    assert.equal(updatedSheet.sheets[0].cells.A3.computed, 7000, 'Formula =A1*A2 automatically recomputed 70 * 100 = 7000');
  });

  test('Property 8: Presentation slide ordering collision resistance', () => {
    const deckArtifact: Artifact = {
      id: 'art-deck-prop',
      title: 'Strategy Deck',
      type: 'application/vnd.aira.presentation',
      content: JSON.stringify({
        title: 'Strategy Deck',
        theme: 'dark',
        slides: [
          { id: 's1', layout: 'title', title: 'Slide 1', bullets: [] },
          { id: 's2', layout: 'content', title: 'Slide 2', bullets: [] },
          { id: 's3', layout: 'content', title: 'Slide 3', bullets: [] },
        ],
      }),
      version: 1,
      versions: [],
    };

    const engine = new CollaborativeDocumentEngine(deckArtifact, 'sess-deck-prop');

    // Alice moves slide 3 to front (index 0)
    const opAlice: CollabOperation = {
      opId: 'op_deck_a',
      sessionId: 'sess-deck-prop',
      artifactId: deckArtifact.id,
      actor: alice,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: 100,
      type: 'slide_mutate',
      payload: { slideAction: 'reorder', slideId: 's3', slideIndex: 0 },
    };

    // Bob updates slide 2 title
    const opBob: CollabOperation = {
      opId: 'op_deck_b',
      sessionId: 'sess-deck-prop',
      artifactId: deckArtifact.id,
      actor: bob,
      baseSeq: 1,
      lamportClock: 2,
      timestamp: 101,
      type: 'slide_mutate',
      payload: { slideAction: 'update', slideId: 's2', slideData: { title: 'Updated Slide 2 by Bob' } },
    };

    engine.applyOperation(opAlice, true);
    engine.applyOperation(opBob, true);

    const deck = JSON.parse(engine.getContent());
    assert.equal(deck.slides.length, 3, 'Slide count must remain 3 with zero duplicate or missing slides');
    assert.equal(deck.slides[0].id, 's3', 'Slide 3 successfully moved to index 0');
    assert.equal(deck.slides.find((s: any) => s.id === 's2')?.title, 'Updated Slide 2 by Bob');
  });

  test('Property 9: Diagram referential integrity preserves graph relationships', () => {
    const diagramArtifact: Artifact = {
      id: 'art-diag-prop',
      title: 'Architecture Diagram',
      type: 'image/svg+xml',
      content: 'graph TD\n  A[Client] --> B[API Gateway]\n  B --> C[Service]',
      version: 1,
      versions: [],
    };

    const engine = new CollaborativeDocumentEngine(diagramArtifact, 'sess-diag-prop');

    const opDiagram: CollabOperation = {
      opId: 'op_diag_01',
      sessionId: 'sess-diag-prop',
      artifactId: diagramArtifact.id,
      actor: alice,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: 100,
      type: 'diagram_mutate',
      payload: { diagramData: 'graph TD\n  A[Client] --> B[API Gateway]\n  B --> C[Service]\n  C --> D[(PostgreSQL)]' },
    };

    const res = engine.applyOperation(opDiagram, true);
    assert.equal(res.ok, true);
    assert.equal(engine.getContent().includes('C --> D[(PostgreSQL)]'), true);
  });

  test('Property 10: Server-authoritative presence receipt timestamp enforcement', () => {
    const manager = new CollaborationSessionManager();
    const sessionAuth = { principalId: 'p_owner', conversationId: 'c_test' };
    manager.getOrCreateSession('room-pres-auth', baseArtifact, sessionAuth);

    // Client attempts to spoof an expiration timestamp in the far past (timestamp 1000)
    const spoofedPresence: CollabPresence = {
      actorId: alice.actorId,
      principalId: alice.principalId,
      displayName: alice.displayName,
      role: alice.role,
      status: 'active',
      updatedAt: 1000, // Spoofed client timestamp
    };

    manager.updatePresence('room-pres-auth', spoofedPresence);

    const state = manager.getSessionState('room-pres-auth');
    assert.notEqual(state, null);
    const recordedPresence = state!.participants[alice.actorId];
    assert.notEqual(recordedPresence, undefined);
    // Server must have stamped authoritative receipt time (around Date.now()), NOT the client spoofed 1000
    assert.equal(recordedPresence.updatedAt > 1000000, true);
    assert.equal(Math.abs(Date.now() - recordedPresence.updatedAt) < 5000, true);
  });

  test('Property 11: Randomized stress sequence with deterministic seed converges stably', () => {
    const engine = new CollaborativeDocumentEngine(baseArtifact, 'sess-prop-random');

    // Pseudo-random linear congruential generator for reproducible stress testing
    let seed = 42;
    function rand() {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    }

    const actors = [alice, bob, charlie];
    const initialText = engine.getContent();

    for (let i = 0; i < 40; i++) {
      const actor = actors[Math.floor(rand() * actors.length)];
      const currentLen = engine.getContent().length;
      const pos = Math.floor(rand() * (currentLen + 1));
      const opType = rand() > 0.3 ? 'text_insert' : 'text_delete';

      const op: CollabOperation = {
        opId: `rand_op_${i}`,
        sessionId: 'sess-prop-random',
        artifactId: baseArtifact.id,
        actor,
        baseSeq: Math.max(1, engine.getCurrentSeq() - Math.floor(rand() * 3)),
        lamportClock: engine.getLamportClock() + 1,
        timestamp: Date.now() + i,
        type: opType,
        payload: opType === 'text_insert'
          ? { position: pos, text: `[${actor.actorId.slice(-1)}:${i}]` }
          : { position: Math.min(pos, currentLen), length: Math.min(5, currentLen - pos) },
      };

      const res = engine.applyOperation(op, true);
      assert.equal(res.ok, true);
      assert.equal(typeof engine.getContent(), 'string');
      assert.equal(engine.getCurrentSeq(), baseArtifact.version! + i + 1);
    }

    assert.equal(engine.getCurrentSeq(), baseArtifact.version! + 40);
  });
});
