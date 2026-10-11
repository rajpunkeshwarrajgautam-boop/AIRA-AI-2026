import type { MemoryItem } from '../types/index.js';

export const STORAGE_KEY = 'aira_agentmemory_vault_v1';
export const STORAGE_MIGRATION_VERSION_KEY = 'aira_agentmemory_vault_migration_version';
export const CURRENT_MIGRATION_VERSION = 20260210;

export interface MigrationReport {
  version: number;
  changesMade: boolean;
  totalItems: number;
  userAuthoredPreserved: number;
  defectiveSeedsCleaned: number;
  unpinnedProcedureSeeds: number;
  timestamp: number;
}

/**
 * Targeted, Versioned, Idempotent Memory Migration
 * 
 * Objectives:
 * 1. Cleanse defective seed entry `seed-sem-pref-1` ("Brand Aesthetic & Iconography Guidelines")
 *    by removing the erroneous "zero emojis" restriction while strictly preserving user customizations.
 * 2. Unpin `seed-proc-flow-1` ("Code Verification & Delivery Protocol") so development verification
 *    rules only apply when relevant to active coding tasks rather than contaminating ordinary chats.
 * 3. 100% preservation of user-authored memories, custom preferences, and conversation history.
 * 4. Idempotent: repeated runs produce 0 changes once migrated.
 * 5. Safe: malformed or null storage records are safely sanitized without global data loss.
 */
export function migrateAgentMemoryVault(rawItems: unknown): {
  migratedItems: MemoryItem[];
  report: MigrationReport;
} {
  const timestamp = Date.now();
  let items: any[] = [];

  if (Array.isArray(rawItems)) {
    items = rawItems;
  } else if (rawItems && typeof rawItems === 'object') {
    // Attempt recovery from object map if serialized incorrectly
    items = Object.values(rawItems);
  } else {
    items = [];
  }

  let changesMade = false;
  let userAuthoredPreserved = 0;
  let defectiveSeedsCleaned = 0;
  let unpinnedProcedureSeeds = 0;

  const migratedItems: MemoryItem[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    // Validate minimum required fields safely
    const id = typeof item.id === 'string' ? item.id : `mem_${Math.random().toString(36).slice(2, 9)}`;
    const isSeed = id.startsWith('seed-');

    if (!isSeed) {
      // User-authored entry: preserve completely untouched
      userAuthoredPreserved++;
      migratedItems.push(item as MemoryItem);
      continue;
    }

    // Handle Seed Entry 1: Brand Aesthetic & Iconography Guidelines
    if (id === 'seed-sem-pref-1' || (item.title && item.title.includes('Brand Aesthetic'))) {
      const content = String(item.content || '');
      // Check for defective "zero emojis" constraint
      if (content.includes('zero emojis')) {
        // Strip out "zero emojis, " or "zero emojis" cleanly
        const cleanedContent = content
          .replace(/,\s*zero emojis\b/gi, '')
          .replace(/\bzero emojis,\s*/gi, '')
          .replace(/\bzero emojis\b/gi, '')
          .trim();

        const updatedItem: MemoryItem = {
          ...item,
          content: cleanedContent,
          isPinned: false, // Unpin branding so it doesn't unconditionally pollute every query
          updatedAt: timestamp,
        };

        migratedItems.push(updatedItem);
        changesMade = true;
        defectiveSeedsCleaned++;
        continue;
      } else if (item.isPinned) {
        // Already cleaned of "zero emojis" but still pinned: unpin it for relevance-based retrieval
        const updatedItem: MemoryItem = {
          ...item,
          isPinned: false,
          updatedAt: timestamp,
        };
        migratedItems.push(updatedItem);
        changesMade = true;
        defectiveSeedsCleaned++;
        continue;
      }
    }

    // Handle Seed Entry 2: Code Verification & Delivery Protocol
    if (id === 'seed-proc-flow-1' || (item.title && item.title.includes('Code Verification'))) {
      if (item.isPinned) {
        const updatedItem: MemoryItem = {
          ...item,
          isPinned: false, // Unpin so it only activates when relevant to coding/development
          updatedAt: timestamp,
        };
        migratedItems.push(updatedItem);
        changesMade = true;
        unpinnedProcedureSeeds++;
        continue;
      }
    }

    // Other seed memories (e.g. seed-sem-arch-1, seed-sem-dec-1, seed-proc-flow-2)
    migratedItems.push(item as MemoryItem);
  }

  const report: MigrationReport = {
    version: CURRENT_MIGRATION_VERSION,
    changesMade,
    totalItems: migratedItems.length,
    userAuthoredPreserved,
    defectiveSeedsCleaned,
    unpinnedProcedureSeeds,
    timestamp
  };

  return { migratedItems, report };
}

/**
 * Browser LocalStorage Migration Driver
 */
export function runVaultStorageMigration(): MigrationReport | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return null;
  }

  try {
    const rawStored = localStorage.getItem(STORAGE_KEY);
    if (!rawStored) return null;

    const parsed = JSON.parse(rawStored);
    const { migratedItems, report } = migrateAgentMemoryVault(parsed);

    if (report.changesMade) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migratedItems));
      localStorage.setItem(STORAGE_MIGRATION_VERSION_KEY, String(CURRENT_MIGRATION_VERSION));
    }

    return report;
  } catch (err) {
    console.warn('Memory vault storage migration non-fatal error:', err);
    return null;
  }
}
