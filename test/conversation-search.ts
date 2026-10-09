import assert from 'node:assert/strict';
import { runMigrations, closeDb, db } from '../packages/db/src/index.js';
import { ConversationSearchRepository } from '../packages/retrieval/src/index.js';

async function main() {
  await runMigrations();

  const repo = new ConversationSearchRepository();
  const principalA = 'search_test_user_a';
  const principalB = 'search_test_user_b';
  const now = Date.now();

  await db('conversation_search_documents').whereIn('principal_id', [principalA, principalB]).delete();
  await db('conversation_messages').whereIn('principal_id', [principalA, principalB]).delete();
  await db('conversations').whereIn('principal_id', [principalA, principalB]).delete();

  try {
    await repo.syncConversation(principalA, {
      id: 'search_test_conv_amd',
      title: 'AMD driver cleanup',
      projectId: 'project_aira',
      isPinned: true,
      createdAt: now - 3000,
      updatedAt: now - 1000,
      messages: [
        {
          id: 'search_test_msg_amd_user',
          role: 'user',
          content: 'The AmdTools64 ghost driver keeps reappearing after reboot.',
          createdAt: now - 3000
        },
        {
          id: 'search_test_msg_amd_assistant',
          role: 'assistant',
          content: 'After cleanup, sc.exe query AmdTools64 reports that the service does not exist.',
          createdAt: now - 2000
        }
      ]
    });

    await repo.syncConversation(principalA, {
      id: 'search_test_conv_food',
      title: 'Dinner ideas',
      createdAt: now - 6000,
      updatedAt: now - 5000,
      messages: [
        {
          id: 'search_test_msg_food',
          role: 'user',
          content: 'Give me a simple paneer bhurjee recipe with onions and tomatoes.',
          createdAt: now - 6000
        }
      ]
    });

    await repo.syncConversation(principalB, {
      id: 'search_test_conv_private',
      title: 'Private other-user chat',
      createdAt: now - 4000,
      updatedAt: now - 3500,
      messages: [
        {
          id: 'search_test_msg_private',
          role: 'user',
          content: 'Cross tenant secret phrase violet-orbit-731.',
          createdAt: now - 4000
        }
      ]
    });

    // Two principals may legitimately carry the same client/localStorage IDs.
    // Server persistence must isolate them instead of returning 403 ownership
    // mismatches or leaking one principal's transcript into the other.
    await repo.syncConversation(principalB, {
      id: 'search_test_conv_amd',
      title: 'Same client ID, different tenant',
      createdAt: now - 3200,
      updatedAt: now - 3100,
      messages: [
        {
          id: 'search_test_msg_amd_user',
          role: 'user',
          content: 'same-client-id tenant B content only',
          createdAt: now - 3200
        }
      ]
    });

    const hydratedA = await repo.getConversation(principalA, 'search_test_conv_amd');
    assert.equal(hydratedA?.id, 'search_test_conv_amd');
    assert.equal(hydratedA?.messages[0]?.id, 'search_test_msg_amd_user');
    assert.equal(hydratedA?.messages[1]?.id, 'search_test_msg_amd_assistant');

    const hydratedB = await repo.getConversation(principalB, 'search_test_conv_amd');
    assert.equal(hydratedB?.id, 'search_test_conv_amd');
    assert.equal(hydratedB?.messages[0]?.content, 'same-client-id tenant B content only');

    const isolatedHydration = await repo.getConversation(principalA, 'search_test_conv_private');
    assert.equal(isolatedHydration, null, 'principal A must not hydrate principal B conversations');

    const exactCode = await repo.search(principalA, { query: 'AmdTools64' });
    assert.equal(exactCode[0]?.conversationId, 'search_test_conv_amd');
    assert.match(exactCode[0]?.snippet || '', /AmdTools64/i);

    const assistantContent = await repo.search(principalA, { query: 'service does not exist' });
    assert.equal(assistantContent[0]?.conversationId, 'search_test_conv_amd');
    assert.equal(assistantContent[0]?.role, 'assistant');

    const title = await repo.search(principalA, { query: 'AMD driver' });
    assert.equal(title[0]?.conversationId, 'search_test_conv_amd');

    const messageBody = await repo.search(principalA, { query: 'paneer bhurjee' });
    assert.equal(messageBody[0]?.conversationId, 'search_test_conv_food');

    const projectScoped = await repo.search(principalA, {
      query: 'AmdTools64',
      projectId: 'project_aira'
    });
    assert.equal(projectScoped.length, 1);
    assert.equal(projectScoped[0]?.conversationId, 'search_test_conv_amd');

    const wrongProject = await repo.search(principalA, {
      query: 'AmdTools64',
      projectId: 'project_other'
    });
    assert.equal(wrongProject.length, 0);

    const isolation = await repo.search(principalA, { query: 'violet-orbit-731' });
    assert.equal(isolation.length, 0, 'principal A must never see principal B search candidates');

    const sameClientTenantB = await repo.search(principalB, { query: 'same-client-id' });
    assert.equal(sameClientTenantB[0]?.conversationId, 'search_test_conv_amd');
    assert.equal(sameClientTenantB[0]?.messageId, 'search_test_msg_amd_user');

    const sameClientLeak = await repo.search(principalA, { query: 'same-client-id' });
    assert.equal(sameClientLeak.length, 0, 'same client IDs across principals must remain isolated');

    const deleted = await repo.deleteConversation(principalA, 'search_test_conv_amd');
    assert.equal(deleted, true);
    const afterDelete = await repo.search(principalA, { query: 'AmdTools64' });
    assert.equal(afterDelete.length, 0, 'deleted conversation must disappear from search');

    console.log('PASS: full-message lexical conversation search');
    console.log('PASS: title search and snippets');
    console.log('PASS: project scoping');
    console.log('PASS: cross-principal isolation');
    console.log('PASS: same client conversation/message IDs are tenant-safe');
    console.log('PASS: deletion removes search visibility');
    console.log('PASS: durable search results hydrate with client IDs and tenant isolation');
  } finally {
    await db('conversation_search_documents').whereIn('principal_id', [principalA, principalB]).delete();
    await db('conversation_messages').whereIn('principal_id', [principalA, principalB]).delete();
    await db('conversations').whereIn('principal_id', [principalA, principalB]).delete();
    await closeDb();
  }
}

main().catch(async error => {
  console.error('CONVERSATION SEARCH CERTIFICATION FAILED');
  console.error(error);
  try {
    await closeDb();
  } finally {
    process.exit(1);
  }
});
