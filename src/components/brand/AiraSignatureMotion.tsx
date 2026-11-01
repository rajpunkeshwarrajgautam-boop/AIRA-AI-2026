import React, { useState, useEffect, useRef } from 'react';
import { MASTER_PORTAL_FACETS } from './AiraPortalGeometry';
import { getPrefersReducedMotion } from './motion-tokens';

export interface AiraSignatureMotionProps {
  size?: 'lg' | 'xl' | 'hero' | number;
  mode?: 'entrance' | 'static' | 'controlled';
  replayKey?: number | string;
  className?: string;
  forceReducedMotion?: boolean;
  onComplete?: () => void;
  'aria-label'?: string;
}

const sizeClassMap: Record<string, string> = {
  lg: 'w-10 h-10',     // 40px
  xl: 'w-16 h-16',     // 64px
  hero: 'w-28 h-28 sm:w-32 sm:h-32 md:w-36 md:h-36', // AIRA responsive hero contract
};

/**
 * AiraSignatureMotion — Concept C: Sculptural Assembly
 * 
 * High-craft Choreographed Assembly for Hero and Presentation surfaces.
 * 10 discrete facets assemble from exploded spatial coordinates into the completed monolithic mark.
 * Mount-guarded against spurious rerenders.
 */
export const AiraSignatureMotion: React.FC<AiraSignatureMotionProps> = ({
  size = 'hero',
  mode = 'entrance',
  replayKey = 0,
  className = '',
  forceReducedMotion = false,
  onComplete,
  'aria-label': ariaLabel = 'AIRA Signature Identity',
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
    // The final tier facet to dock is facet-r1 at ~1550ms
    const target = e.target as Element | null;
    if (target?.classList?.contains('facet-r1') || target === containerRef.current) {
      setAnimating(false);
      onComplete?.();
    }
  };

  const sizeClass = typeof size === 'number' ? '' : sizeClassMap[size] || 'w-28 h-28 sm:w-32 sm:h-32 md:w-36 md:h-36';
  const customStyle = typeof size === 'number' ? { width: `${size}px`, height: `${size}px` } : undefined;

  const leftFacets = MASTER_PORTAL_FACETS.filter(f => f.pylon === 'left');
  const rightFacets = MASTER_PORTAL_FACETS.filter(f => f.pylon === 'right');

  const isMotionActive = animating && mode !== 'static' && !forceReducedMotion;
  const motionClass = isMotionActive ? 'portal-motion-svg anim-concept-c' : '';

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
