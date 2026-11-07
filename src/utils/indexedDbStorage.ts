/**
 * AIRA AI 2026 — Resilient IndexedDB Storage Engine
 * Provides durable, high-capacity client storage for conversations,
 * projects, multi-file artifact workspaces, and agent memory.
 *
 * IndexedDB provides gigabytes of quota, preventing LocalStorage QuotaExceededError.
 */

const DB_NAME = 'aira_db_v2';
const DB_VERSION = 1;

export const STORES = {
  CONVERSATIONS: 'conversations',
  PROJECTS: 'projects',
  SETTINGS: 'settings',
  WORKSPACES: 'workspaces',
  METADATA: 'metadata',
} as const;

export type StoreName = typeof STORES[keyof typeof STORES];

let dbPromise: Promise<IDBDatabase | null> | null = null;

export function isIndexedDbSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

/**
 * Opens or initializes the AIRA IndexedDB database with all required object stores.
 */
export function openAiraDatabase(): Promise<IDBDatabase | null> {
  if (!isIndexedDbSupported()) {
    return Promise.resolve(null);
  }

  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve) => {
    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        for (const store of Object.values(STORES)) {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store);
          }
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        // Fall back gracefully if IndexedDB is blocked (e.g., privacy settings / incognito restrictions)
        resolve(null);
      };

      request.onblocked = () => {
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

/**
 * Retrieves a value by key from an IndexedDB store.
 */
export async function idbGet<T>(storeName: StoreName, key: string): Promise<T | null> {
  try {
    const db = await openAiraDatabase();
    if (!db) return null;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(key);

        req.onsuccess = () => {
          resolve((req.result as T) ?? null);
        };

        req.onerror = () => {
          resolve(null);
        };
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

/**
 * Persists a value by key to an IndexedDB store.
 * Durability guarantee: Resolves true ONLY when the transaction is fully committed (tx.oncomplete).
 * If the transaction aborts, errors, or fails to commit, resolves false without claiming durability.
 */
export async function idbSet<T>(storeName: StoreName, key: string, value: T): Promise<boolean> {
  try {
    const db = await openAiraDatabase();
    if (!db) return false;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.put(value, key);

        let reqSucceeded = false;
        let settled = false;

        const fail = () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        };

        req.onsuccess = () => {
          reqSucceeded = true;
        };

        req.onerror = () => {
          fail();
        };

        tx.oncomplete = () => {
          if (!settled) {
            settled = true;
            resolve(reqSucceeded);
          }
        };

        tx.onerror = () => {
          fail();
        };

        tx.onabort = () => {
          fail();
        };
      } catch {
        resolve(false);
      }
    });
  } catch {
    return false;
  }
}

/**
 * Removes a value by key from an IndexedDB store.
 * Durability guarantee: Resolves true ONLY when the transaction is fully committed (tx.oncomplete).
 */
export async function idbDelete(storeName: StoreName, key: string): Promise<boolean> {
  try {
    const db = await openAiraDatabase();
    if (!db) return false;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.delete(key);

        let reqSucceeded = false;
        let settled = false;

        const fail = () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        };

        req.onsuccess = () => {
          reqSucceeded = true;
        };

        req.onerror = () => {
          fail();
        };

        tx.oncomplete = () => {
          if (!settled) {
            settled = true;
            resolve(reqSucceeded);
          }
        };

        tx.onerror = () => {
          fail();
        };

        tx.onabort = () => {
          fail();
        };
      } catch {
        resolve(false);
      }
    });
  } catch {
    return false;
  }
}

/**
 * Closes the active database connection. Useful for unit testing.
 */
export function resetDbConnectionForTesting(): void {
  dbPromise = null;
}
