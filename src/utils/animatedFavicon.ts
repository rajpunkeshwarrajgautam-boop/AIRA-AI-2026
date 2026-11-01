import { useEffect } from 'react';

export const EXACT_BRAND_TITLE = 'Aira AI';

/**
 * Ensures a valid document title is present without overwriting
 * dynamic conversation or route titles.
 */
export function enforceBrandTitle(customTitle?: string): void {
  if (typeof document === 'undefined') return;
  if (customTitle) {
    document.title = customTitle;
  } else if (!document.title) {
    document.title = EXACT_BRAND_TITLE;
  }
}

/**
 * Retired legacy animation routines preserved for interface compatibility.
 * Zero background timers, zero canvas/SVG thrashing, zero continuous favicon updates.
 */
export function startFaviconAnimation(): void {
  // Decommissioned: favicon is now static/media-query adaptive
}

export function stopFaviconAnimation(_resetToStatic = false): void {
  // Decommissioned
}

export function isFaviconAnimationActive(): boolean {
  return false;
}

export function setFaviconHref(_href: string): void {
  // Decommissioned
}

/**
 * Hook attaching initial title fallback without continuous intervals or title overwrites.
 * Preserves existing descriptive or dynamic application document titles.
 */
export function useAnimatedFavicon(): void {
  useEffect(() => {
    // Only apply default if document title is currently empty
    if (typeof document !== 'undefined' && !document.title) {
      document.title = EXACT_BRAND_TITLE;
    }
  }, []);
}
