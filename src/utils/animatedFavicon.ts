import { useEffect } from 'react';

export const EXACT_BRAND_TITLE = 'Aira AI';
export const FRAME_COUNT = 24;
export const FRAME_INTERVAL_MS = 120;

function buildSvgFrame(knotAngle: number, orbitAngle: number, coreRadius: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">` +
    `<defs>` +
      `<radialGradient id="airaCore" cx="35%" cy="35%" r="65%">` +
        `<stop offset="0%" stop-color="#FFFFFF"/>` +
        `<stop offset="55%" stop-color="#FFA88B"/>` +
        `<stop offset="100%" stop-color="#D97757"/>` +
      `</radialGradient>` +
    `</defs>` +
    `<g transform="rotate(${orbitAngle.toFixed(1)} 32 32)">` +
      `<circle cx="32" cy="32" r="28" stroke="#D97757" stroke-width="1.5" stroke-dasharray="4 3" stroke-opacity="0.4"/>` +
    `</g>` +
    `<g transform="rotate(${knotAngle.toFixed(1)} 32 32)" stroke="#D97757" stroke-width="4.2" stroke-linecap="round">` +
      `<path d="M 25 24 C 23 16 26 8 32 7 C 37 6 42 10 41 16 C 40 21 34 26 27 27"/>` +
      `<path d="M 25 24 C 23 16 26 8 32 7 C 37 6 42 10 41 16 C 40 21 34 26 27 27" transform="rotate(60 32 32)"/>` +
      `<path d="M 25 24 C 23 16 26 8 32 7 C 37 6 42 10 41 16 C 40 21 34 26 27 27" transform="rotate(120 32 32)"/>` +
      `<path d="M 25 24 C 23 16 26 8 32 7 C 37 6 42 10 41 16 C 40 21 34 26 27 27" transform="rotate(180 32 32)"/>` +
      `<path d="M 25 24 C 23 16 26 8 32 7 C 37 6 42 10 41 16 C 40 21 34 26 27 27" transform="rotate(240 32 32)"/>` +
      `<path d="M 25 24 C 23 16 26 8 32 7 C 37 6 42 10 41 16 C 40 21 34 26 27 27" transform="rotate(300 32 32)"/>` +
    `</g>` +
    `<g transform="rotate(${knotAngle.toFixed(1)} 32 32)" stroke="#FFFFFF" stroke-width="1.1" stroke-linecap="round" stroke-opacity="0.85">` +
      `<path d="M 28 11 C 31 8 35 8 38 10.5"/>` +
      `<path d="M 28 11 C 31 8 35 8 38 10.5" transform="rotate(60 32 32)"/>` +
      `<path d="M 28 11 C 31 8 35 8 38 10.5" transform="rotate(120 32 32)"/>` +
      `<path d="M 28 11 C 31 8 35 8 38 10.5" transform="rotate(180 32 32)"/>` +
      `<path d="M 28 11 C 31 8 35 8 38 10.5" transform="rotate(240 32 32)"/>` +
      `<path d="M 28 11 C 31 8 35 8 38 10.5" transform="rotate(300 32 32)"/>` +
    `</g>` +
    `<circle cx="32" cy="32" r="${coreRadius.toFixed(2)}" fill="url(#airaCore)"/>` +
    `<circle cx="32" cy="32" r="1.6" fill="#FFFFFF"/>` +
  `</svg>`;
}

// Pre-render a bounded set of 24 frames once in memory.
export const FAVICON_FRAMES: readonly string[] = Object.freeze(
  Array.from({ length: FRAME_COUNT }, (_, i) => {
    const knotAngle = (i * 360) / FRAME_COUNT;
    const orbitAngle = -(i * 360) / FRAME_COUNT;
    const coreRadius = 3.6 + 0.6 * Math.sin((2 * Math.PI * i) / FRAME_COUNT);
    const svg = buildSvgFrame(knotAngle, orbitAngle, coreRadius);
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  })
);

export const STATIC_FAVICON_HREF = FAVICON_FRAMES[0];

let timerId: ReturnType<typeof setInterval> | null = null;
let currentFrameIndex = 0;
let isAnimating = false;

function getFaviconLink(): HTMLLinkElement | null {
  if (typeof document === 'undefined') return null;
  let link = document.querySelector<HTMLLinkElement>('link#aira-favicon') ||
    document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.id = 'aira-favicon';
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = STATIC_FAVICON_HREF;
    document.head.appendChild(link);
  }
  return link;
}

export function setFaviconHref(href: string): void {
  const link = getFaviconLink();
  if (link && link.href !== href) {
    link.href = href;
  }
}

export function startFaviconAnimation(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced || document.hidden) {
    setFaviconHref(STATIC_FAVICON_HREF);
    stopFaviconAnimation();
    return;
  }

  if (timerId !== null) return;

  isAnimating = true;
  timerId = setInterval(() => {
    currentFrameIndex = (currentFrameIndex + 1) % FAVICON_FRAMES.length;
    setFaviconHref(FAVICON_FRAMES[currentFrameIndex]);
  }, FRAME_INTERVAL_MS);
}

export function stopFaviconAnimation(resetToStatic = false): void {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
  isAnimating = false;
  if (resetToStatic) {
    currentFrameIndex = 0;
    setFaviconHref(STATIC_FAVICON_HREF);
  }
}

export function isFaviconAnimationActive(): boolean {
  return isAnimating && timerId !== null;
}

export function enforceBrandTitle(): void {
  if (typeof document !== 'undefined' && document.title !== EXACT_BRAND_TITLE) {
    document.title = EXACT_BRAND_TITLE;
  }
}

/**
 * React hook to attach the animated favicon lifecycle and ensure the tab title
 * stays locked strictly to "Aira AI".
 */
export function useAnimatedFavicon(): void {
  useEffect(() => {
    enforceBrandTitle();

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    const handleVisibility = () => {
      if (document.hidden) {
        stopFaviconAnimation();
      } else if (!mediaQuery.matches) {
        startFaviconAnimation();
      }
    };

    const handleReducedMotion = (event: MediaQueryListEvent) => {
      if (event.matches) {
        stopFaviconAnimation(true);
      } else if (!document.hidden) {
        startFaviconAnimation();
      }
    };

    if (!mediaQuery.matches && !document.hidden) {
      startFaviconAnimation();
    } else {
      setFaviconHref(STATIC_FAVICON_HREF);
    }

    document.addEventListener('visibilitychange', handleVisibility);
    mediaQuery.addEventListener('change', handleReducedMotion);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      mediaQuery.removeEventListener('change', handleReducedMotion);
      stopFaviconAnimation(true);
    };
  }, []);
}
