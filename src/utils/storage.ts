import { Conversation, Project, AppSettings } from '../types';
import { DEFAULT_SETTINGS } from './constants';

const STORAGE_KEYS = {
  CONVERSATIONS: 'aira_conversations_v1',
  ACTIVE_CHAT: 'aira_active_chat_id_v1',
  PROJECTS: 'aira_projects_v1',
  ACTIVE_PROJECT: 'aira_active_project_id_v1',
  SETTINGS: 'aira_settings_v1',
  PINNED_CHATS: 'aira_pinned_chats_v1',
};

export const INITIAL_CONVERSATION: Conversation = {
  id: 'welcome-to-aira',
  title: 'New Aira workspace',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
};

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CONVERSATIONS);
    if (!raw) {
      saveConversations([INITIAL_CONVERSATION]);
      return [INITIAL_CONVERSATION];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [INITIAL_CONVERSATION];
  } catch {
    console.error('Failed to load conversations from localStorage');
    return [INITIAL_CONVERSATION];
  }
}

export function saveConversations(conversations: Conversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(conversations));
  } catch {
    console.error('Failed to save conversations to localStorage');
  }
}

export function loadActiveChatId(): string {
  return localStorage.getItem(STORAGE_KEYS.ACTIVE_CHAT) || INITIAL_CONVERSATION.id;
}

export function saveActiveChatId(id: string): void {
  localStorage.setItem(STORAGE_KEYS.ACTIVE_CHAT, id);
}

export function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PROJECTS);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    console.error('Failed to load projects');
    return [];
  }
}

export function saveProjects(projects: Project[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(projects));
  } catch {
    console.error('Failed to save projects');
  }
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save settings', e);
  }
}
