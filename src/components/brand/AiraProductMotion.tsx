import React, { useState, useEffect, useRef } from 'react';
import { UI_PORTAL_FACETS } from './AiraPortalGeometry';
import { getPrefersReducedMotion } from './motion-tokens';

export interface AiraProductMotionProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;
  mode?: 'entrance' | 'static' | 'controlled';
  replayKey?: number | string;
  className?: string;
  forceReducedMotion?: boolean;
  onComplete?: () => void;
  'aria-label'?: string;
}

const sizeClassMap: Record<string, string> = {
  xs: 'w-4 h-4',       // 16px
  sm: 'w-5 h-5',       // 20px
  md: 'w-7 h-7',       // 28px (AIRA standard medium mark)
  lg: 'w-10 h-10',     // 40px
  xl: 'w-16 h-16',     // 64px
};

/**
 * AiraProductMotion — Concept A: Architectural Alignment
 * 
 * Reusable Product UI Component.
 * Restrained, quiet, authoritative alignment entrance.
 * Mount-guarded against spurious rerenders, chat streaming, and theme changes.
 */
export const AiraProductMotion: React.FC<AiraProductMotionProps> = ({
  size = 'md',
  mode = 'entrance',
  replayKey = 0,
  className = '',
  forceReducedMotion = false,
  onComplete,
  'aria-label': ariaLabel = 'AIRA Product Identity',
}) => {
  const [prevReplayKey, setPrevReplayKey] = useState(replayKey);
  const [animating, setAnimating] = useState<boolean>(() => {
    if (mode === 'static' || forceReducedMotion) return false;
    return !getPrefersReducedMotion();
  });

  // Adjust state during render when replayKey changes (idiomatic React prop-to-state pattern)
  if (replayKey !== prevReplayKey) {
    setPrevReplayKey(replayKey);
    if (mode !== 'static' && !forceReducedMotion && !getPrefersReducedMotion()) {
      setAnimating(true);
    }
  }

  const containerRef = useRef<HTMLDivElement>(null);

  // Tab visibility safeguard: Jump to completion if hidden during animation
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && animating) {
        setAnimating(false);
        onComplete?.();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [animating, onComplete]);

  const handleAnimationEnd = (e: React.AnimationEvent) => {
    // Only resolve on parent container animation completion or pylon group end
    const target = e.target as Element | null;
    if (target === containerRef.current || target?.classList?.contains('pylon-left')) {
      setAnimating(false);
      onComplete?.();
    }
  };

  const sizeClass = typeof size === 'number' ? '' : sizeClassMap[size] || 'w-7 h-7';
  const customStyle = typeof size === 'number' ? { width: `${size}px`, height: `${size}px` } : undefined;

  const leftFacets = UI_PORTAL_FACETS.filter(f => f.pylon === 'left');
  const rightFacets = UI_PORTAL_FACETS.filter(f => f.pylon === 'right');

  const isMotionActive = animating && mode !== 'static' && !forceReducedMotion;
  const motionClass = isMotionActive ? 'portal-motion-svg anim-concept-a' : '';

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex items-center justify-center flex-shrink-0 select-none ${sizeClass} ${className}`}
      style={customStyle}
      aria-label={ariaLabel}
      role="img"
      onAnimationEnd={handleAnimationEnd}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 64 64"
        fill="none"
        className={`w-full h-full ${motionClass}`}
        style={{ overflow: 'visible' }}
      >
        <g className="pylon-group pylon-left">
          {leftFacets.map(f => (
            <path
              key={f.id}
              className={`facet facet-${f.id}`}
              d={f.d}
              fill="currentColor"
            />
          ))}
        </g>
        <g className="pylon-group pylon-right">
          {rightFacets.map(f => (
            <path
              key={f.id}
              className={`facet facet-${f.id}`}
              d={f.d}
              fill="currentColor"
            />
          ))}
        </g>
      </svg>
    </div>
  );
};
