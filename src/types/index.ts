
export type WorkspaceMode = 'chat' | 'agent';

export type CapabilityType = 'research' | 'vision' | 'builder' | 'agents' | 'automations' | 'library' | 'general';

export type ModelId = 
  | 'claude-3-7-sonnet' 
  | 'claude-3-5-sonnet' 
  | 'claude-3-5-haiku' 
  | 'claude-3-opus'
  | 'meta/llama-3.1-405b-instruct'
  | 'nvidia/nemotron-3-super-120b-a12b';

export interface ModelInfo {
  id: ModelId;
  name: string;
  badge?: string;
  description: string;
  supportsThinking?: boolean;
  contextWindow: string;
}

export type ArtifactType = 
  | 'application/vnd.ant.code'
  | 'application/vnd.ant.react'
  | 'image/svg+xml'
  | 'text/html'
  | 'text/markdown'
  | 'application/vnd.ant.mermaid';

export interface ArtifactVersion {
  version: number;
  content: string;
  timestamp: number;
}

export interface Artifact {
  id: string;
  title: string;
  type: ArtifactType;
  language?: string;
  content: string;
  version: number;
  versions: ArtifactVersion[];
}

export interface Attachment {
  id: string;
  name: string;
  size: string;
  type: string;
  content?: string; // Base64 or text preview
}

export interface ThinkingBlock {
  text: string;
  durationSeconds?: number;
  isStreaming?: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: ThinkingBlock;
  artifacts?: Artifact[];
  attachments?: Attachment[];
  timestamp: number;
  modelUsed?: ModelId;
  isStreaming?: boolean;
  provenance?: {
    requestedModel: string;
    resolvedPolicyModel: string;
    provider: 'nvidia' | 'anthropic' | 'openai' | 'mock' | 'unknown';
    executedModel: string;
    plannedModel?: string;
    outboundModel?: string;
    upstreamResponseModel?: string;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    verified: boolean;
    executionStatus: 'PENDING' | 'SUCCESS' | 'FALLBACK' | 'FAILED' | 'UNKNOWN';
    timestamp: number;
  };
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  isPinned?: boolean;
  projectId?: string;
}

export interface ProjectDoc {
  id: string;
  name: string;
  content: string;
  size: string;
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  instructions: string;
  docs: ProjectDoc[];
  createdAt: number;
  knowledgeGraph?: import('../utils/knowledgeGraph').KnowledgeGraph;
}

export type ThemeMode = 'light' | 'dark' | 'system';
export type AIProvider = 'simulated' | 'anthropic' | 'openrouter';

export interface AppSettings {
  theme: ThemeMode;
  activeModel: ModelId;
  extendedThinking: boolean;
  thinkingBudget: number; // e.g. 1024 to 64000
  provider: AIProvider;
  anthropicApiKey: string;
  openRouterApiKey: string;
  customInstructions: string;
  userName: string;
  email?: string;
  userBio?: string;
  responseStyle?: 'normal' | 'concise' | 'explanatory' | 'academic' | 'code-first';
  autoOpenArtifacts?: boolean;
  aestheticPreset?: 'default' | 'linear-precision' | 'warm-parchment' | 'liquid-glass' | 'industrial-brutalist' | 'nordic-moss' | 'solar-gold' | 'tokyo-neon' | 'vanguard-monolith';
  // Agent Persistent Memory (agentmemory integration)
  persistentMemoryEnabled?: boolean;
  autoConsolidateMemory?: boolean;
  privacyScrubbing?: boolean;
  memoryTokenBudget?: number;
}

export type MemoryTier = 'working' | 'episodic' | 'semantic' | 'procedural';

export interface MemoryItem {
  id: string;
  tier: MemoryTier;
  category: 'preference' | 'architecture' | 'decision' | 'workflow' | 'bugfix' | 'general';
  title: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt?: number;
  score?: number; // Hybrid BM25 + vector score
  sourceSessionId?: string;
  isPinned?: boolean;
  projectId?: string;
  userId?: string;
}

export interface MemoryQuery {
  query: string;
  limit?: number;
  tiers?: MemoryTier[];
  minScore?: number;
  activeProjectId?: string;
  activeUserId?: string;
}

export interface MemoryStats {
  totalCount: number;
  workingCount: number;
  episodicCount: number;
  semanticCount: number;
  proceduralCount: number;
  tokensSavedEstimate: number;
  lastConsolidationTimestamp?: number;
}
