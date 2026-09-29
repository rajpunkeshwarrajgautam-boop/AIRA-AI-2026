
export type WorkspaceMode = 'chat' | 'research' | 'library' | 'agents' | 'automations';

export type ModelId = 
  | 'claude-3-7-sonnet' 
  | 'claude-3-5-sonnet' 
  | 'claude-3-5-haiku' 
  | 'claude-3-opus';

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
  thinkingBudget: number; // e.g. 1024 to 32000
  provider: AIProvider;
  anthropicApiKey: string;
  openRouterApiKey: string;
  customInstructions: string;
  userName: string;
  aestheticPreset?: 'default' | 'linear-precision' | 'warm-parchment' | 'liquid-glass' | 'industrial-brutalist' | 'nordic-moss';
}
