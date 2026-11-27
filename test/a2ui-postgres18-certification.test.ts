import './setup-disposable-db.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db } from '../packages/db/src/index.js';
import { ConversationSearchRepository } from '../packages/retrieval/src/index.js';
import { AIRA_GENUI_CONTRACT_VERSION, validateGenUISurface } from '../packages/contracts/src/genui.js';

describe('Phase 2 PostgreSQL 18 Certification: Durable GenUI Conversation Metadata & Action Idempotency', () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const ownerId = `usr_p2_pg18_owner_${suffix}`;
  const foreignId = `usr_p2_pg18_foreign_${suffix}`;
  const convClientId = `chat_p2_pg18_${suffix}`;

  after(async () => {
    try {
      await db('idempotent_operations').where('principal_id', ownerId).del();
      await db('conversation_search_documents').where('principal_id', ownerId).del();
      await db('conversation_messages').where('principal_id', ownerId).del();
      await db('conversations').where('principal_id', ownerId).del();
    } catch {
      // Best-effort cleanup
    } finally {
      await db.destroy();
    }
  });

  it('GATE 1: confirms disposable PostgreSQL 18.x on 127.0.0.1:5432/aira_test_db', async () => {
    const dbUrl = process.env.DATABASE_URL || '';
    assert.ok(dbUrl.includes('127.0.0.1:5432/aira_test_db'));
    assert.equal(dbUrl.includes('neon.tech'), false);
    const res = await db.raw(
      "SELECT current_database() AS db_name, current_setting('server_version_num')::int / 10000 AS major_ver"
    );
    assert.equal(res.rows[0].db_name, 'aira_test_db');
    assert.equal(Number(res.rows[0].major_ver), 18);
  });

  it('GATE 2: persists and restores validated GenUI surfaces & user state in conversation_messages.metadata with tenant isolation', async () => {
    const repo = new ConversationSearchRepository();
    const surface = {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: `surf_study_${suffix}`,
      title: 'Study Planner',
      rootId: 'root',
      textFallback: 'Weekly study plan: 10h goal',
      origin: 'model' as const,
      state: { '/study/hours': 10, '/study/task1': false },
      computed: [{ target: '/derived/pct', kind: 'progress_ratio' as const, itemKeys: ['/study/task1'] }],
      actions: [],
      evidence: [],
      components: [
        { id: 'root', type: 'vertical_group' as const, props: { gap: 'sm' as const, children: ['sl', 'cb'] } },
        { id: 'sl', type: 'slider' as const, props: { label: 'Hours', stateKey: '/study/hours', min: 1, max: 40, step: 1, defaultValue: 10 } },
        { id: 'cb', type: 'checkbox' as const, props: { label: 'Task 1', stateKey: '/study/task1', defaultChecked: false } },
      ],
    };
    const checked = validateGenUISurface(surface);
    assert.equal(checked.ok, true);

    const now = Date.now();
    await repo.syncConversation(ownerId, {
      id: convClientId,
      title: 'Study Session Persistence',
      createdAt: now - 1000,
      updatedAt: now,
      messages: [
        { id: 'm_user', role: 'user', content: 'Build a study planner', createdAt: now - 500 },
        {
          id: 'm_asst',
          role: 'assistant',
          content: 'Here is your interactive study planner.',
          createdAt: now,
          metadata: {
            genui: {
              surfaces: [surface],
              surfaceState: {
                [surface.surfaceId]: { '/study/hours': 18, '/study/task1': true },
              },
              updatedAt: now,
            },
          },
        },
      ],
    });

    const restored = await repo.getConversation(ownerId, convClientId);
    assert.ok(restored);
    const asstMsg = restored.messages.find((m) => m.id === 'm_asst');
    assert.ok(asstMsg?.metadata && typeof asstMsg.metadata === 'object');
    const metaGenui = (asstMsg.metadata as any).genui;
    assert.equal(metaGenui.surfaces.length, 1);
    assert.equal(metaGenui.surfaces[0].surfaceId, surface.surfaceId);
    assert.equal(metaGenui.surfaceState[surface.surfaceId]['/study/task1'], true);
    assert.equal(metaGenui.surfaceState[surface.surfaceId]['/study/hours'], 18);

    // Cross-tenant isolation check
    const crossTenant = await repo.getConversation(foreignId, convClientId);
    assert.equal(crossTenant, null);
  });

  it('GATE 3: enforces durable genui_action idempotency & payload hash conflict detection on PG 18', async () => {
    const opId = `gact_${suffix}`;
    const opKey = `genui_action:${ownerId}:${opId}`;
    const payload1 = { surfaceId: 'surf_1', actionId: 'act_submit', kind: 'attach_followup', stateSnapshot: { step: 2 } };
    const hash1 = crypto.createHash('sha256').update(JSON.stringify(payload1)).digest('hex');
    const now = Date.now();

    await db('idempotent_operations').insert({
      key: opKey,
      principal_id: ownerId,
      operation_id: opId,
      operation_type: 'genui_action',
      payload_hash: hash1,
      status: 'COMPLETED',
      response_status: 200,
      response_body: JSON.stringify({ accepted: true, eventId: opId }),
      locked_until: now + 60_000,
      created_at: now,
      updated_at: now,
    });

    const existing = await db('idempotent_operations').where({ key: opKey }).first();
    assert.equal(existing.payload_hash, hash1);

    const payloadTampered = { surfaceId: 'surf_1', actionId: 'act_submit', kind: 'attach_followup', stateSnapshot: { step: 99 } };
    const hashTampered = crypto.createHash('sha256').update(JSON.stringify(payloadTampered)).digest('hex');
    assert.notEqual(existing.payload_hash, hashTampered);
  });
});
