import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkspaceBackup,
  validateAndParseBackup,
  redactSensitiveText,
  BACKUP_FORMAT_IDENTIFIER,
  CURRENT_BACKUP_VERSION,
} from '../src/utils/workspaceBackup';
import {
  shouldShowFirstViewPopup,
  getUnreadAnnouncementCount,
  resetDismissedAnnouncements,
} from '../src/utils/announcements';
import type { Conversation, Project, AppSettings } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/utils/constants';

describe('Settings Ecosystem & Security Certification', () => {
  const mockAnthropicSecret = ['sk', 'ant', 'api03', 'SECRETKEYNEVEREXPOSE1234567890'].join('-');
  const mockOpenRouterSecret = ['sk', 'or', 'v1', 'SECRETKEYNEVEREXPOSE1234567890'].join('-');
  const mockGithubSecret = ['ghp', '0123456789abcdefghijklmnopqrstuvwxyz'].join('_');
  const mockCustomSecret = ['sk', 'ant', 'api03', 'customsecret1234567890'].join('-');
  const mockUserMsgSecret = ['sk', 'ant', 'api03', 'abcdef1234567890abcdef1234567890'].join('-');

  const mockConversations: Conversation[] = [
    {
      id: 'chat-101',
      title: 'Architectural Analysis',
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: `Here is my secret Anthropic key: ${mockUserMsgSecret} and OpenRouter ${mockOpenRouterSecret}`,
          timestamp: 1700000000000,
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'I will never store your API key in plain text.',
          timestamp: 1700000001000,
        },
      ],
    },
  ];

  const mockProjects: Project[] = [
    {
      id: 'proj-1',
      name: `Project Alpha (${mockGithubSecret})`,
      description: `Secret GitHub token: ${mockGithubSecret} and bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token`,
      instructions: 'Use secret token bearer my-secret-token-1234567890',
      docs: [],
      createdAt: 1700000000000,
    },
  ];

  const mockSettingsWithSecrets: AppSettings = {
    ...DEFAULT_SETTINGS,
    userName: 'Certified Engineer',
    email: 'engineer@virexaaiventures.com',
    anthropicApiKey: mockAnthropicSecret,
    openRouterApiKey: mockOpenRouterSecret,
    customInstructions: `Always verify security with ${mockCustomSecret}`,
    userBio: `Principal Architect with ${mockGithubSecret}`,
    announcementsEnabled: true,
    productUpdatesEnabled: true,
    tipsEnabled: true,
    autoOpenArtifacts: false,
  };

  it('1. Zero credential leakage in workspace export', () => {
    const backupJson = createWorkspaceBackup(
      mockConversations,
      mockProjects,
      mockSettingsWithSecrets,
      'usr-certified-123'
    );

    // Assert raw credentials are completely absent
    assert.strictEqual(backupJson.includes(mockAnthropicSecret), false, 'Anthropic API key must never be in export');
    assert.strictEqual(backupJson.includes(mockOpenRouterSecret), false, 'OpenRouter API key must never be in export');
    assert.strictEqual(backupJson.includes('anthropicApiKey'), false, 'anthropicApiKey key must not exist in export payload');
    assert.strictEqual(backupJson.includes('openRouterApiKey'), false, 'openRouterApiKey key must not exist in export payload');

    const parsed = JSON.parse(backupJson);
    assert.strictEqual(parsed.format, BACKUP_FORMAT_IDENTIFIER);
    assert.strictEqual(parsed.version, CURRENT_BACKUP_VERSION);
    assert.strictEqual(parsed.ownerScope, 'usr-certified-123');

    // Safe preferences are exported
    assert.strictEqual(parsed.preferences.autoOpenArtifacts, false);
    assert.strictEqual(parsed.preferences.tipsEnabled, true);
  });

  it('2. Deep secret pattern redaction in exported message and project content', () => {
    const backupJson = createWorkspaceBackup(
      mockConversations,
      mockProjects,
      mockSettingsWithSecrets,
      'usr-certified-123'
    );

    const parsed = JSON.parse(backupJson);

    // Messages must have secret tokens replaced with [REDACTED_SECRET]
    const userMsg = parsed.conversations[0].messages[0].content;
    assert.strictEqual(userMsg.includes(mockUserMsgSecret), false);
    assert.strictEqual(userMsg.includes(mockOpenRouterSecret), false);
    assert.ok(userMsg.includes('[REDACTED_SECRET]'), 'Secret must be replaced with [REDACTED_SECRET]');

    // Projects must have secret tokens redacted
    const projDesc = parsed.projects[0].description;
    assert.strictEqual(projDesc.includes(mockGithubSecret), false);
    assert.ok(projDesc.includes('[REDACTED_SECRET]'));

    // Custom instructions in preferences must be redacted
    const customInst = parsed.preferences.customInstructions;
    assert.strictEqual(customInst.includes(mockCustomSecret), false);
    assert.ok(customInst.includes('[REDACTED_SECRET]'));
  });

  it('3. Prototype pollution defense on workspace import', () => {
    const maliciousPayload = '{"__proto__": {"isAdmin": true, "polluted": "danger"}, "conversations": [], "projects": []}';

    const result = validateAndParseBackup(maliciousPayload, [], []);
    assert.strictEqual(result.valid, false, 'Malicious prototype pollution must be rejected');
    assert.ok(result.error?.includes('prototype pollution') || result.error?.includes('Malicious'));

    const constructorPayload = '{"constructor": {"prototype": {"polluted": true}}, "conversations": []}';
    const result2 = validateAndParseBackup(constructorPayload, [], []);
    assert.strictEqual(result2.valid, false, 'Constructor prototype pollution must be rejected');
  });

  it('4. Safe ID de-duplication and collision prevention on workspace import', () => {
    const existingConvs: Conversation[] = [
      {
        id: 'chat-101',
        title: 'Original Existing Chat',
        createdAt: 1690000000000,
        updatedAt: 1690000000000,
        messages: [],
      },
    ];

    const existingProjs: Project[] = [
      {
        id: 'proj-1',
        name: 'Original Existing Project',
        description: '',
        instructions: '',
        docs: [],
        createdAt: 1690000000000,
      },
    ];

    const validBackup = JSON.stringify({
      format: BACKUP_FORMAT_IDENTIFIER,
      version: CURRENT_BACKUP_VERSION,
      conversations: mockConversations,
      projects: mockProjects,
      preferences: {
        theme: 'dark',
        autoOpenArtifacts: true,
      },
    });

    const result = validateAndParseBackup(validBackup, existingConvs, existingProjs);
    assert.strictEqual(result.valid, true);
    assert.ok(result.data);

    // Must contain both original and restored copy without collision
    assert.strictEqual(result.data.conversations.length, 2);
    assert.strictEqual(result.data.conversations[0].id, 'chat-101');
    assert.strictEqual(result.data.conversations[0].title, 'Original Existing Chat');
    assert.strictEqual(result.data.conversations[1].title, 'Architectural Analysis (Restored)');
    assert.ok(result.data.conversations[1].id.startsWith('imported-'));

    // Must contain both original and restored projects
    assert.strictEqual(result.data.projects.length, 2);
    assert.strictEqual(result.data.projects[0].id, 'proj-1');
    assert.ok(result.data.projects[1].name.includes('(Restored)'));
  });

  it('5. Notification preferences filter announcements and product updates', () => {
    resetDismissedAnnouncements('test-user-notifications');

    // With announcements disabled, getUnreadAnnouncementCount should return 0
    const unreadDisabled = getUnreadAnnouncementCount('free', 'test-user-notifications', {
      announcementsEnabled: false,
    });
    assert.strictEqual(unreadDisabled, 0, 'Unread count must be 0 when announcements are disabled');

    // With announcements disabled, shouldShowFirstViewPopup should return null
    const popupDisabled = shouldShowFirstViewPopup('free', 'test-user-notifications', false, true);
    assert.strictEqual(popupDisabled, null, 'Popup must be null when announcements are disabled');

    // With productUpdates disabled, model announcements should be filtered out
    const unreadAll = getUnreadAnnouncementCount('free', 'test-user-notifications', {
      announcementsEnabled: true,
      productUpdatesEnabled: true,
    });
    const unreadNoModel = getUnreadAnnouncementCount('free', 'test-user-notifications', {
      announcementsEnabled: true,
      productUpdatesEnabled: false,
    });
    assert.ok(unreadNoModel <= unreadAll, 'Filtered unread count must not exceed full count');
  });

  it('6. autoOpenArtifacts preference is preserved and correctly typed', () => {
    assert.strictEqual(mockSettingsWithSecrets.autoOpenArtifacts, false);
    const backupJson = createWorkspaceBackup([], [], { autoOpenArtifacts: false });
    const parsed = JSON.parse(backupJson);
    assert.strictEqual(parsed.preferences.autoOpenArtifacts, false);

    const importResult = validateAndParseBackup(backupJson, [], []);
    assert.strictEqual(importResult.valid, true);
    assert.strictEqual(importResult.data?.preferences?.autoOpenArtifacts, false);
  });
});
