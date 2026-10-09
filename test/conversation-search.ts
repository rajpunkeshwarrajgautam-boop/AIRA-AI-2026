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

    const deleted = await repo.deleteConversation(principalA, 'search_test_conv_amd');
    assert.equal(deleted, true);
    const afterDelete = await repo.search(principalA, { query: 'AmdTools64' });
    assert.equal(afterDelete.length, 0, 'deleted conversation must disappear from search');

    console.log('PASS: full-message lexical conversation search');
    console.log('PASS: title search and snippets');
    console.log('PASS: project scoping');
    console.log('PASS: cross-principal isolation');
    console.log('PASS: deletion removes search visibility');
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
