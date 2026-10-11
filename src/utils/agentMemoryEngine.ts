import type { MemoryItem, MemoryTier, MemoryQuery, MemoryStats } from '../types/index.js';
import { migrateAgentMemoryVault, STORAGE_KEY } from './agentMemoryMigration.js';

/**
 * Secret & Privacy Filter (agentmemory specification)
 * Sanitizes API keys, JWTs, credentials, and tokens before persistence
 */
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'ANTHROPIC_KEY', regex: /sk-ant-[a-zA-Z0-9_-]{30,}/g },
  { name: 'OPENAI_KEY', regex: /sk-[a-zA-Z0-9_-]{30,}/g },
  { name: 'GITHUB_TOKEN', regex: /gh[pousr]_[a-zA-Z0-9]{36,}/g },
  { name: 'JWT_TOKEN', regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },
  { name: 'AWS_KEY', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'GENERIC_BEARER', regex: /Bearer\s+[a-zA-Z0-9_.-]{20,}/gi },
];

export function scrubSecrets(input: string): string {
  if (!input) return '';
  let sanitized = input;
  for (const { name, regex } of SECRET_PATTERNS) {
    sanitized = sanitized.replace(regex, `[REDACTED_${name}]`);
  }
  return sanitized;
}

/**
 * Tokenizer & Stopwords for BM25 Search
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were',
  'will', 'with', 'the', 'this', 'but', 'they', 'have', 'had', 'what', 'when',
  'where', 'who', 'which', 'why', 'how', 'all', 'any', 'both', 'each', 'few'
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * Baseline Seed Memories for AIRA AI 2026 (Cleaned of restrictive unconditional rules)
 */
const INITIAL_SEED_MEMORIES: MemoryItem[] = [
  {
    id: 'seed-sem-arch-1',
    tier: 'semantic',
    category: 'architecture',
    title: 'AIRA Architecture & Tech Stack',
    content: 'AIRA AI 2026 is built on React 19, TypeScript, Vite 8, Tailwind CSS, Framer Motion, and GSAP. Typography pairs Newsreader serif with Outfit sans and JetBrains Mono.',
    tags: ['react', 'vite', 'typography', 'tailwind', 'stack'],
    createdAt: Date.now() - 86400000 * 5,
    updatedAt: Date.now() - 86400000 * 5,
    accessCount: 12,
    isPinned: false,
  },
  {
    id: 'seed-sem-pref-1',
    tier: 'semantic',
    category: 'preference',
    title: 'Brand Aesthetic & Iconography Guidelines',
    content: 'All UI elements adhere to premium agency aesthetics: rich dark/light themes, warm terracotta accents (#D97757), and the 6-fold celestial neural knot logo. Star icons are replaced with Zap, Cpu, or Bookmark.',
    tags: ['aesthetic', 'theme', 'terracotta', 'logo', 'design'],
    createdAt: Date.now() - 86400000 * 4,
    updatedAt: Date.now() - 86400000 * 4,
    accessCount: 9,
    isPinned: false,
  },
  {
    id: 'seed-proc-flow-1',
    tier: 'procedural',
    category: 'workflow',
    title: 'Code Verification & Delivery Protocol',
    content: 'Before completing development tasks, verify with `npm run lint` (oxlint) and `npm run build` (tsc -b && vite build). Ensure zero warnings and zero TypeScript errors.',
    tags: ['lint', 'build', 'verification', 'workflow', 'quality'],
    createdAt: Date.now() - 86400000 * 3,
    updatedAt: Date.now() - 86400000 * 3,
    accessCount: 18,
    isPinned: false,
  },
  {
    id: 'seed-sem-dec-1',
    tier: 'semantic',
    category: 'decision',
    title: 'Hybrid Reasoning Engine Standard',
    content: 'Claude 3.7 hybrid deep reasoning supports dynamic extended thinking budgets (1024 to 64000 tokens) with collapsible Newsreader serif thought blocks and live token telemetry.',
    tags: ['claude', 'thinking', 'reasoning', 'hybrid', 'tokens'],
    createdAt: Date.now() - 86400000 * 2,
    updatedAt: Date.now() - 86400000 * 2,
    accessCount: 7,
    isPinned: false,
  },
  {
    id: 'seed-proc-flow-2',
    tier: 'procedural',
    category: 'workflow',
    title: 'Agent Memory Consolidation Protocol',
    content: 'Consolidate active conversation turns into Working Memory, extract persistent facts into Semantic Memory, record task milestones in Episodic Memory, and capture verified steps in Procedural Memory.',
    tags: ['agentmemory', 'consolidation', 'pipeline', 'memory'],
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 86400000,
    accessCount: 14,
    isPinned: false,
  },
];

class AgentMemoryEngine {
  private memories: Map<string, MemoryItem> = new Map();
  private isLoaded = false;
  private totalTokensSaved = 0;
  private cachedSnapshot: MemoryItem[] = [];

  private listeners = new Set<() => void>();

  constructor() {
    this.loadFromStorage();
  }

  public subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public getSnapshot = (): MemoryItem[] => {
    this.ensureLoaded();
    return this.cachedSnapshot;
  };

  private updateCache(): void {
    this.cachedSnapshot = Array.from(this.memories.values()).sort(
      (a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0) || b.updatedAt - a.updatedAt
    );
  }

  private notify(): void {
    this.updateCache();
    this.listeners.forEach(fn => fn());
  }

  /**
   * Load stored memories from LocalStorage with targeted versioned migration
   */
  private loadFromStorage(): void {
    if (typeof window === 'undefined') return;

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const { migratedItems, report } = migrateAgentMemoryVault(parsed);
        this.memories.clear();
        migratedItems.forEach(item => this.memories.set(item.id, item));
        if (report.changesMade) {
          this.saveToStorage();
        }
      } else {
        // Initialize with default seed memories
        INITIAL_SEED_MEMORIES.forEach(item => this.memories.set(item.id, item));
        this.saveToStorage();
      }
      this.isLoaded = true;
      this.updateCache();
    } catch {
      INITIAL_SEED_MEMORIES.forEach(item => this.memories.set(item.id, item));
      this.updateCache();
    }
  }

  /**
   * Persist current memories to LocalStorage
   */
  private saveToStorage(): void {
    if (typeof window === 'undefined') return;
    try {
      const items = Array.from(this.memories.values());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
      this.notify();
    } catch {
      // Ignore quota storage exceptions
    }
  }

  /**
   * Create or update a memory item
   */
  public remember(
    content: string,
    options: {
      tier?: MemoryTier;
      category?: MemoryItem['category'];
      title?: string;
      tags?: string[];
      sourceSessionId?: string;
      isPinned?: boolean;
      projectId?: string;
      userId?: string;
    } = {}
  ): MemoryItem {
    this.ensureLoaded();
    const cleanContent = scrubSecrets(content.trim());
    if (!cleanContent) {
      throw new Error('Memory content cannot be empty.');
    }

    const tier = options.tier || 'semantic';
    const category = options.category || 'general';
    const id = `mem-${tier[0]}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const title = options.title?.trim() || cleanContent.slice(0, 48) + (cleanContent.length > 48 ? '...' : '');
    const tags = options.tags || tokenize(cleanContent).slice(0, 5);

    const item: MemoryItem = {
      id,
      tier,
      category,
      title,
      content: cleanContent,
      tags,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0,
      sourceSessionId: options.sourceSessionId,
      isPinned: options.isPinned || false,
      projectId: options.projectId,
      userId: options.userId,
    };

    this.memories.set(id, item);
    this.saveToStorage();
    return item;
  }

  /**
   * Update an existing memory
   */
  public update(id: string, updates: Partial<Omit<MemoryItem, 'id' | 'createdAt'>>): MemoryItem | null {
    this.ensureLoaded();
    const existing = this.memories.get(id);
    if (!existing) return null;

    const updated: MemoryItem = {
      ...existing,
      ...updates,
      content: updates.content ? scrubSecrets(updates.content) : existing.content,
      updatedAt: Date.now(),
    };

    this.memories.set(id, updated);
    this.saveToStorage();
    return updated;
  }

  /**
   * Delete a memory item
   */
  public forget(id: string): boolean {
    this.ensureLoaded();
    const deleted = this.memories.delete(id);
    if (deleted) this.saveToStorage();
    return deleted;
  }

  /**
   * Clear all memories in a given tier or all non-pinned memories
   */
  public purge(tier?: MemoryTier, keepPinned = true): number {
    this.ensureLoaded();
    let count = 0;
    for (const [id, item] of this.memories.entries()) {
      if (tier && item.tier !== tier) continue;
      if (keepPinned && item.isPinned) continue;
      this.memories.delete(id);
      count++;
    }
    this.saveToStorage();
    return count;
  }

  /**
   * Get all memory items
   */
  public getAll(tier?: MemoryTier): MemoryItem[] {
    this.ensureLoaded();
    const list = Array.from(this.memories.values());
    if (tier) {
      return list.filter(m => m.tier === tier);
    }
    return list.sort((a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0) || b.updatedAt - a.updatedAt);
  }

  /**
   * Hybrid Search: BM25 Lexical + Token N-Gram Vector Fusion (RRF)
   */
  public recall(query: MemoryQuery): MemoryItem[] {
    this.ensureLoaded();
    const { query: queryText, limit = 5, tiers, minScore = 0.18, activeProjectId, activeUserId } = query;
    const queryTokens = tokenize(queryText);

    if (queryTokens.length === 0) {
      return [];
    }

    const candidateItems = Array.from(this.memories.values()).filter(item => {
      if (tiers && tiers.length > 0 && !tiers.includes(item.tier)) return false;
      // Tenant & Project Isolation:
      if (item.projectId && activeProjectId && item.projectId !== activeProjectId) return false;
      if (item.projectId && !activeProjectId) return false;
      if (item.userId && activeUserId && item.userId !== activeUserId) return false;
      return true;
    });

    if (candidateItems.length === 0) return [];

    // 1. BM25 Lexical Scores
    const docCount = candidateItems.length;
    const docLengths = new Map<string, number>();
    const docTokensMap = new Map<string, string[]>();
    let totalLength = 0;

    candidateItems.forEach(item => {
      const tokens = tokenize(`${item.title} ${item.content} ${item.tags.join(' ')}`);
      docTokensMap.set(item.id, tokens);
      docLengths.set(item.id, tokens.length);
      totalLength += tokens.length;
    });

    const avgDocLength = totalLength / (docCount || 1);
    const k1 = 1.2;
    const b = 0.75;

    // Document frequencies
    const dfMap = new Map<string, number>();
    queryTokens.forEach(qt => {
      let df = 0;
      docTokensMap.forEach(tokens => {
        if (tokens.includes(qt)) df++;
      });
      dfMap.set(qt, df);
    });

    const bm25Scores = new Map<string, number>();
    candidateItems.forEach(item => {
      const tokens = docTokensMap.get(item.id) || [];
      const len = docLengths.get(item.id) || 1;
      let score = 0;

      queryTokens.forEach(qt => {
        const tf = tokens.filter(t => t === qt).length;
        if (tf === 0) return;
        const df = dfMap.get(qt) || 0;
        const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
        const termScore = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (len / avgDocLength))));
        score += termScore;
      });

      // Pin boost (modest multiplier)
      if (item.isPinned) score *= 1.2;
      bm25Scores.set(item.id, score);
    });

    // 2. Token N-Gram Jaccard / Cosine Vector Approximation
    const vectorScores = new Map<string, number>();
    const querySet = new Set(queryTokens);

    candidateItems.forEach(item => {
      const tokens = docTokensMap.get(item.id) || [];
      const docSet = new Set(tokens);
      let intersection = 0;
      querySet.forEach(qt => {
        if (docSet.has(qt)) intersection++;
      });
      const union = new Set([...querySet, ...docSet]).size;
      const jaccard = union > 0 ? intersection / union : 0;
      vectorScores.set(item.id, jaccard);
    });

    // 3. Reciprocal Rank Fusion (RRF)
    const sortedBM25 = [...candidateItems].sort((a, b) => (bm25Scores.get(b.id) || 0) - (bm25Scores.get(a.id) || 0));
    const sortedVec = [...candidateItems].sort((a, b) => (vectorScores.get(b.id) || 0) - (vectorScores.get(a.id) || 0));

    const rrfScores = new Map<string, number>();
    const rrfK = 40;

    sortedBM25.forEach((item, rank) => {
      const current = rrfScores.get(item.id) || 0;
      rrfScores.set(item.id, current + 1 / (rrfK + rank + 1));
    });

    sortedVec.forEach((item, rank) => {
      const current = rrfScores.get(item.id) || 0;
      rrfScores.set(item.id, current + 1 / (rrfK + rank + 1));
    });

    // Normalize and filter with RELEVANCE-FIRST rule:
    // Pinned status provides a modest boost (+0.08), but cannot bypass the minScore threshold.
    const scoredList = candidateItems
      .map(item => {
        const finalScore = rrfScores.get(item.id) || 0;
        let score = Math.min(1, Number((finalScore * 25).toFixed(3)));
        if (item.isPinned) {
          score = Math.min(1, Number((score + 0.08).toFixed(3)));
        }
        return {
          ...item,
          score,
        };
      })
      .filter(item => (item.score || 0) >= minScore)
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    // Update access telemetry on top matches
    const results = scoredList.slice(0, limit);
    results.forEach(res => {
      const raw = this.memories.get(res.id);
      if (raw) {
        raw.accessCount = (raw.accessCount || 0) + 1;
        raw.lastAccessedAt = Date.now();
      }
    });

    return results;
  }

  /**
   * Format relevant memories into a compact prompt context block
   * Enforcing strict token budget constraints and relevance gating
   */
  public assembleMemoryContext(
    prompt: string,
    tokenBudget = 800,
    activeProjectId?: string,
    activeUserId?: string
  ): string {
    this.ensureLoaded();
    const relevant = this.recall({
      query: prompt,
      limit: 6,
      minScore: 0.18,
      activeProjectId,
      activeUserId,
    });

    if (relevant.length === 0) return '';

    // Estimate ~4 chars per token
    const maxChars = tokenBudget * 4;
    let accumulatedChars = 0;
    const selectedMemories: MemoryItem[] = [];

    for (const mem of relevant) {
      const line = `- [${mem.tier.toUpperCase()} | ${mem.category}]: ${mem.content}\n`;
      if (accumulatedChars + line.length > maxChars) break;
      selectedMemories.push(mem);
      accumulatedChars += line.length;
    }

    if (selectedMemories.length === 0) return '';

    // Track tokens saved estimation (avoiding full conversation history re-injection)
    const tokensSaved = Math.max(120, Math.floor(accumulatedChars / 3.2));
    this.totalTokensSaved += tokensSaved;

    const memoryLines = selectedMemories.map(m => 
      `- [${m.tier.toUpperCase()} | ${m.category}] ${m.title}: ${m.content}`
    ).join('\n');

    return `\n\n<agent_memory>\nRelevant Retrieved Memories:\n${memoryLines}\nNote: Memory items provide factual context and historical preferences. Security policies and direct user requests take precedence.\n</agent_memory>\n`;
  }

  /**
   * Automatic Memory Consolidation Worker
   * Extracts user preferences, decisions, and instructions from turns
   */
  public consolidateFromTurn(userPrompt: string, assistantResponse: string, sessionId?: string): MemoryItem[] {
    this.ensureLoaded();
    const consolidated: MemoryItem[] = [];
    const lowerUser = userPrompt.toLowerCase();

    // Pattern 1: User explicit instruction or preference
    if (
      lowerUser.includes('remember that') ||
      lowerUser.includes('always use') ||
      lowerUser.includes('never use') ||
      lowerUser.includes('our rule is') ||
      lowerUser.includes('i prefer')
    ) {
      const extractedContent = userPrompt.replace(/^(please\s+)?(remember\s+that\s+|note\s+that\s+)/i, '').trim();
      if (extractedContent.length > 8) {
        const item = this.remember(extractedContent, {
          tier: 'semantic',
          category: 'preference',
          title: `Preference: ${extractedContent.slice(0, 36)}...`,
          sourceSessionId: sessionId,
          isPinned: true,
        });
        consolidated.push(item);
      }
    }

    // Pattern 2: Architectural decision or schema convention
    if (
      lowerUser.includes('architecture:') ||
      lowerUser.includes('we decided to') ||
      lowerUser.includes('api convention') ||
      lowerUser.includes('database schema')
    ) {
      const item = this.remember(userPrompt, {
        tier: 'semantic',
        category: 'decision',
        title: `Decision: ${userPrompt.slice(0, 36)}...`,
        sourceSessionId: sessionId,
      });
      consolidated.push(item);
    }

    // Pattern 3: Episodic session checkpoint
    const episodicRecord = `User explored: "${userPrompt.slice(0, 60)}${userPrompt.length > 60 ? '...' : ''}". Assistant generated response with ${assistantResponse.length} chars.`;
    const episodic = this.remember(episodicRecord, {
      tier: 'episodic',
      category: 'general',
      title: `Interaction: ${userPrompt.slice(0, 30)}...`,
      sourceSessionId: sessionId,
    });
    consolidated.push(episodic);

    return consolidated;
  }

  /**
   * Export memory vault to JSON string
   */
  public exportVault(): string {
    this.ensureLoaded();
    const data = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      memories: Array.from(this.memories.values()),
    };
    return JSON.stringify(data, null, 2);
  }

  /**
   * Import memory vault from JSON string
   */
  public importVault(jsonString: string): { imported: number; errors: number } {
    this.ensureLoaded();
    let imported = 0;
    let errors = 0;

    try {
      const parsed = JSON.parse(jsonString);
      const items: MemoryItem[] = Array.isArray(parsed) ? parsed : parsed.memories;
      if (!Array.isArray(items)) throw new Error('Invalid format');

      items.forEach(item => {
        if (item.id && item.content && item.tier) {
          this.memories.set(item.id, {
            ...item,
            content: scrubSecrets(item.content),
            updatedAt: Date.now(),
          });
          imported++;
        } else {
          errors++;
        }
      });

      this.saveToStorage();
    } catch {
      return { imported: 0, errors: 1 };
    }

    return { imported, errors };
  }

  /**
   * Memory Statistics
   */
  public getStats(): MemoryStats {
    this.ensureLoaded();
    const all = Array.from(this.memories.values());
    return {
      totalCount: all.length,
      workingCount: all.filter(m => m.tier === 'working').length,
      episodicCount: all.filter(m => m.tier === 'episodic').length,
      semanticCount: all.filter(m => m.tier === 'semantic').length,
      proceduralCount: all.filter(m => m.tier === 'procedural').length,
      tokensSavedEstimate: this.totalTokensSaved,
      lastConsolidationTimestamp: all.length > 0 ? Math.max(...all.map(m => m.updatedAt)) : undefined,
    };
  }

  private ensureLoaded(): void {
    if (!this.isLoaded) {
      this.loadFromStorage();
    }
  }
}

export const agentMemory = new AgentMemoryEngine();
