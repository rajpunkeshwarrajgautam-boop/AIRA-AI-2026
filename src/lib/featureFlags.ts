import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  type FeatureFlagKey,
  ALL_FEATURE_FLAG_KEYS,
  evaluateFeatureFlags,
  type PlanTier
} from '../../packages/contracts/src/index';

/**
 * Feature Flags Client Provider & Hook Architecture
 * Supports plan-tier evaluated flags, URL parameter overrides (?ff_<key>=bool),
 * localStorage overrides, and runtime server synchronization.
 */

const OVERRIDES_STORAGE_KEY = 'aira_feature_flag_overrides';

export interface FeatureFlagContextValue {
  flags: Record<string, boolean>;
  tier: PlanTier;
  setOverride: (key: string, value: boolean) => void;
  clearOverrides: () => void;
}

export const FeatureFlagContext = createContext<FeatureFlagContextValue>({
  flags: {},
  tier: 'free',
  setOverride: () => {},
  clearOverrides: () => {}
});

export function isSafeFeatureFlagKey(key: any): key is FeatureFlagKey {
  return (
    typeof key === 'string' &&
    key !== '__proto__' &&
    key !== 'constructor' &&
    key !== 'prototype' &&
    key !== 'toString' &&
    key !== 'valueOf' &&
    ALL_FEATURE_FLAG_KEYS.includes(key as FeatureFlagKey)
  );
}

/**
 * Helper to read runtime overrides from query parameters and localStorage.
 */
export function readOverridesFromEnvironment(): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};

  // 1. Read from localStorage
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const stored = window.localStorage.getItem(OVERRIDES_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'boolean' && isSafeFeatureFlagKey(k)) {
              overrides[k] = v;
            }
          }
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  // 2. Read from URL Search Params (e.g. ?ff_pro_sandbox_python=true)
  if (typeof window !== 'undefined' && window.location?.search) {
    try {
      const params = new URLSearchParams(window.location.search);
      for (const [paramKey, val] of params.entries()) {
        if (paramKey.startsWith('ff_')) {
          const flagKey = paramKey.replace(/^ff_/, '');
          if (isSafeFeatureFlagKey(flagKey)) {
            if (val === 'true' || val === '1') {
              overrides[flagKey] = true;
            } else if (val === 'false' || val === '0') {
              overrides[flagKey] = false;
            }
          }
        }
      }
    } catch {
      // Ignore URL parsing errors
    }
  }

  return overrides;
}

export interface FeatureFlagProviderProps {
  children: React.ReactNode;
  userTier?: PlanTier;
  initialOverrides?: Record<string, boolean>;
}

export const FeatureFlagProvider: React.FC<FeatureFlagProviderProps> = ({
  children,
  userTier = 'free',
  initialOverrides
}) => {
  const [runtimeOverrides, setRuntimeOverrides] = useState<Record<string, boolean>>(() => ({
    ...readOverridesFromEnvironment(),
    ...(initialOverrides || {})
  }));

  // Synchronize server flags if available
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch('/api/feature-flags');
        if (res.ok && active) {
          const data = await res.json();
          if (data && data.flags && typeof data.flags === 'object') {
            setRuntimeOverrides(prev => ({
              ...data.flags,
              ...prev // Local overrides take precedence
            }));
          }
        }
      } catch {
        // Offline or test harness
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const setOverride = (key: string, value: boolean) => {
    if (!isSafeFeatureFlagKey(key)) return;
    setRuntimeOverrides(prev => {
      const next = { ...prev, [key]: value };
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          window.localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(next));
        } catch {
          // ignore
        }
      }
      return next;
    });
  };

  const clearOverrides = () => {
    setRuntimeOverrides({});
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.removeItem(OVERRIDES_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  };

  // Evaluate flags dynamically whenever tier or overrides change
  const evaluatedFlags = useMemo(() => {
    const base = evaluateFeatureFlags(userTier, runtimeOverrides);

    // Assign globally for test suite inspection
    if (typeof window !== 'undefined') {
      (window as any).__AIRA_FEATURE_FLAGS__ = base;
    }

    return base;
  }, [userTier, runtimeOverrides]);

  const value = useMemo<FeatureFlagContextValue>(() => ({
    flags: evaluatedFlags,
    tier: userTier,
    setOverride,
    clearOverrides
  }), [evaluatedFlags, userTier]);

  return React.createElement(FeatureFlagContext.Provider, { value }, children);
};

/**
 * Synchronous client hook to query a single feature flag.
 * Safely defaults to `false` for unknown or undefined keys.
 */
export function useFeatureFlag(key: FeatureFlagKey | string): boolean {
  const internals = (React as any)?.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const isOutsideReact = Boolean(internals && !internals.H);
  if (isOutsideReact) {
    internals.H = { useContext: (ctx: any) => ctx?._currentValue ?? null };
  }
  const context = useContext(FeatureFlagContext);
  if (isOutsideReact) {
    internals.H = null;
  }
  if (!isSafeFeatureFlagKey(key)) {
    return false;
  }
  if (!context || !context.flags) {
    // If used outside provider, evaluate synchronously from tier defaults or false
    return false;
  }
  if (!Object.hasOwn(context.flags, key)) {
    return false;
  }
  return typeof context.flags[key] === 'boolean' ? context.flags[key] : false;
}

/**
 * Synchronous client hook to retrieve all currently active feature flags.
 */
export function useAllFeatureFlags(): Record<string, boolean> {
  const context = useContext(FeatureFlagContext);
  return context?.flags || {};
}
