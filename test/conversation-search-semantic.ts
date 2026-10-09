import assert from 'node:assert/strict';
import { runMigrations, closeDb, db } from '../packages/db/src/index.js';
import {
  ConversationSearchRepository,
  ConversationEmbeddingIndexer,
  HybridConversationSearchService,
  type EmbeddingBatch,
  type EmbeddingProvider,
  type EmbeddingPurpose
} from '../packages/retrieval/src/index.js';

class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = 'deterministic-test';

  isConfigured(): boolean {
    return true;
  }

  async embed(texts: string[], _purpose: EmbeddingPurpose): Promise<EmbeddingBatch> {
    const vectors = texts.map(text => {
      const value = text.toLowerCase();
      if (/browser|navigate|navigation|url|web_search|example\.com/.test(value)) return [1, 0, 0];
      if (/paneer|recipe|food|dinner/.test(value)) return [0, 1, 0];
      if (/amd|driver|amdtools64|service/.test(value)) return [0, 0, 1];
      return [0.2, 0.2, 0.2];
    });

    return {
      modelId: 'deterministic-semantic-test',
      modelVersion: '1',
      dimensions: 3,
      vectors
    };
  }
}

async function cleanup(principals: string[]) {
  await db('conversation_search_documents').whereIn('principal_id', principals).delete();
  await db('conversation_messages').whereIn('principal_id', principals).delete();
  await db('conversations').whereIn('principal_id', principals).delete();
}

async function main() {
  await runMigrations();

  const repo = new ConversationSearchRepository();
  const provider = new DeterministicEmbeddingProvider();
  const indexer = new ConversationEmbeddingIndexer(repo, provider);
  const hybrid = new HybridConversationSearchService(repo, provider);

  const principalA = 'semantic_search_user_a';
  const principalB = 'semantic_search_user_b';
  const now = Date.now();

  await cleanup([principalA, principalB]);

  try {
    const capability = await repo.getVectorCapability();
    assert.equal(capability.extensionEnabled, true, 'pgvector extension must be enabled in semantic CI');
    assert.equal(capability.vectorColumnPresent, true, 'embedding_vector column must exist in semantic CI');
    assert.equal(capability.ready, true, 'semantic vector capability must be READY');

    await repo.syncConversation(principalA, {
      id: 'semantic_conv_browser',
      title: 'Production routing incident',
      createdAt: now - 7000,
      updatedAt: now - 6000,
      messages: [{
        id: 'semantic_msg_browser',
        role: 'assistant',
        content: 'Explicit URL requests were sent to web_search instead of browser_navigate during the production incident.',
        createdAt: now - 7000
      }]
    });

    await repo.syncConversation(principalA, {
      id: 'semantic_conv_food',
      title: 'Dinner ideas',
      createdAt: now - 5000,
      updatedAt: now - 4000,
      messages: [{
        id: 'semantic_msg_food',
        role: 'user',
        content: 'Give me a simple paneer bhurjee recipe with onions and tomatoes.',
        createdAt: now - 5000
      }]
    });

    await repo.syncConversation(principalA, {
      id: 'semantic_conv_amd',
      title: 'Windows cleanup',
      isPinned: true,
      createdAt: now - 3000,
      updatedAt: now - 2000,
      messages: [{
        id: 'semantic_msg_amd',
        role: 'assistant',
        content: 'AmdTools64 ghost driver service was removed and no longer exists.',
        createdAt: now - 3000
      }]
    });

    await repo.syncConversation(principalB, {
      id: 'semantic_conv_private',
      title: 'Other user browser notes',
      createdAt: now - 1000,
      updatedAt: now - 500,
      messages: [{
        id: 'semantic_msg_private',
        role: 'assistant',
        content: 'Private browser navigation record belonging to another principal.',
        createdAt: now - 1000
      }]
    });

    assert.equal((await indexer.indexConversation(principalA, 'semantic_conv_browser')).indexed, 1);
    assert.equal((await indexer.indexConversation(principalA, 'semantic_conv_food')).indexed, 1);
    assert.equal((await indexer.indexConversation(principalA, 'semantic_conv_amd')).indexed, 1);
    assert.equal((await indexer.indexConversation(principalB, 'semantic_conv_private')).indexed, 1);

    const semanticOnly = await hybrid.search(principalA, {
      query: 'page navigation tool failure',
      limit: 5
    });
    assert.equal(semanticOnly.mode, 'hybrid');
    assert.equal(semanticOnly.semanticAvailable, true);
    assert.equal(semanticOnly.results[0]?.conversationId, 'semantic_conv_browser');
    assert.ok(
      semanticOnly.results[0]?.matchType === 'semantic' || semanticOnly.results[0]?.matchType === 'hybrid',
      'semantic concept must retrieve the browser routing conversation'
    );

    const exactPlusSemantic = await hybrid.search(principalA, {
      query: 'AmdTools64 service',
      limit: 5
    });
    assert.equal(exactPlusSemantic.results[0]?.conversationId, 'semantic_conv_amd');
    assert.equal(exactPlusSemantic.results[0]?.matchType, 'hybrid');

    const foodSemantic = await hybrid.search(principalA, {
      query: 'what did we cook for dinner',
      limit: 5
    });
    assert.equal(foodSemantic.results[0]?.conversationId, 'semantic_conv_food');

    const isolation = await hybrid.search(principalA, {
      query: 'private browser navigation record',
      limit: 10
    });
    assert.equal(
      isolation.results.some(result => result.conversationId === 'semantic_conv_private'),
      false,
      'semantic retrieval must filter by principal before ranking'
    );

    // Inject a real embedding-call failure after the pgvector-backed search
    // has been confirmed. Lexical retrieval must survive a provider outage.
    const failedProvider: EmbeddingProvider = {
      providerId: 'simulated-nvidia-503',
      isConfigured: () => true,
      embed: async () => { throw new Error('SIMULATED_NVIDIA_EMBEDDING_503'); }
    };
    const failedSearch = new HybridConversationSearchService(repo, failedProvider);
    const lexicalAfterProviderFailure = await failedSearch.search(principalA, {
      query: 'Production routing incident',
      limit: 5
    });
    assert.equal(lexicalAfterProviderFailure.mode, 'lexical');
    assert.equal(lexicalAfterProviderFailure.semanticAvailable, false);
    assert.equal(lexicalAfterProviderFailure.results[0]?.conversationId, 'semantic_conv_browser');
    assert.equal(
      (await failedSearch.search(principalA, {
        query: 'Private browser navigation record',
        limit: 10
      })).results.some(result => result.conversationId === 'semantic_conv_private'),
      false,
      'lexical fallback must remain principal-isolated during provider failure'
    );

    const disabledProvider: EmbeddingProvider = {
      providerId: 'disabled-semantic-test',
      isConfigured: () => false,
      embed: async () => { throw new Error('DISABLED_PROVIDER_MUST_NOT_BE_CALLED'); }
    };
    const unconfiguredSearch = new HybridConversationSearchService(repo, disabledProvider);
    const noProvider = await unconfiguredSearch.search(principalA, {
      query: 'Production routing incident',
      limit: 5
    });
    assert.equal(noProvider.mode, 'lexical');
    assert.equal(noProvider.semanticAvailable, false);
    assert.equal(noProvider.results[0]?.conversationId, 'semantic_conv_browser');

    const pendingAfterIndex = await repo.listPendingEmbeddingDocuments(
      principalA,
      'semantic_conv_browser',
      10
    );
    assert.equal(pendingAfterIndex.length, 0);

    // Re-sync unchanged content: embedding must remain valid instead of being
    // invalidated on every title/timestamp write.
    await repo.syncConversation(principalA, {
      id: 'semantic_conv_browser',
      title: 'Production routing incident',
      createdAt: now - 7000,
      updatedAt: now,
      messages: [{
        id: 'semantic_msg_browser',
        role: 'assistant',
        content: 'Explicit URL requests were sent to web_search instead of browser_navigate during the production incident.',
        createdAt: now - 7000
      }]
    });
    assert.equal(
      (await repo.listPendingEmbeddingDocuments(principalA, 'semantic_conv_browser', 10)).length,
      0,
      'unchanged content must not trigger unnecessary re-embedding'
    );

    console.log('PASS: real pgvector column and cosine retrieval');
    console.log('PASS: semantic concept retrieval');
    console.log('PASS: lexical + semantic RRF hybrid ranking');
    console.log('PASS: semantic tenant isolation');
    console.log('PASS: unchanged content preserves embedding state');
    console.log('PASS: simulated NVIDIA 503 degrades to tenant-isolated lexical search');
    console.log('PASS: unconfigured embedding provider degrades to lexical search');
  } finally {
    await cleanup([principalA, principalB]);
    await closeDb();
  }
}

main().catch(async error => {
  console.error('SEMANTIC CONVERSATION SEARCH CERTIFICATION FAILED');
  console.error(error);
  try {
    await closeDb();
  } finally {
    process.exit(1);
  }
});
