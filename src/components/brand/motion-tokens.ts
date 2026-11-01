/**
 * AIRA Motion Tokens & Lifecycle Foundation
 * Built according to motion-foundations and motion-patterns standards.
 */

export const airaMotionTokens = {
  duration: {
    instant: 0.08,
    fast: 0.18,
    productAlignment: 1.40,  // Concept A: Architectural Alignment
    signatureAssembly: 1.55, // Concept C: Sculptural Assembly
    slowInspection: 3.00,    // 0.5x Slow Inspection Mode
  },
  easing: {
    architectural: 'cubic-bezier(0.16, 1, 0.3, 1)',   // Spring-damped glide with subtle inertia
    sculptural: 'cubic-bezier(0.2, 0.8, 0.2, 1)',      // Precision docking ease
    linear: 'linear',
  },
  inertia: {
    overshootPx: 0.4,
  },
  stagger: {
    facetIntervalMs: 40,
  },
};

/**
 * Checks whether user prefers reduced motion.
 * Safe for SSR and client runtime.
 */
export function getPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Determines whether animation should execute.
 * When reduced motion is preferred or mode is static, animation is disabled.
 */
export function shouldAnimateBrand(mode?: 'entrance' | 'static' | 'controlled', forceReduced?: boolean): boolean {
  if (mode === 'static') return false;
  if (forceReduced) return false;
  return !getPrefersReducedMotion();
}
