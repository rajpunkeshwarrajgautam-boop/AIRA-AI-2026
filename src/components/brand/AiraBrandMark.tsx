import React from 'react';
import { MASTER_PORTAL_FACETS, UI_PORTAL_FACETS, MICRO_PORTAL_FACETS } from './AiraPortalGeometry';
import { AiraProductMotion } from './AiraProductMotion';
import { AiraSignatureMotion } from './AiraSignatureMotion';

export interface AiraBrandMarkProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'hero' | number;
  scale?: 'auto' | 'master' | 'ui' | 'micro';
  variant?: 'product' | 'signature' | 'static';
  mode?: 'entrance' | 'static' | 'controlled';
  replayKey?: number | string;
  className?: string;
  forceReducedMotion?: boolean;
  onAnimationComplete?: () => void;
  'aria-label'?: string;
}

const sizeClassMap: Record<string, string> = {
  xs: 'w-4 h-4',       // 16px
  sm: 'w-5 h-5',       // 20px
  md: 'w-7 h-7',       // 28px (AIRA standard medium mark)
  lg: 'w-10 h-10',     // 40px
  xl: 'w-16 h-16',     // 64px
  hero: 'w-28 h-28 sm:w-32 sm:h-32 md:w-36 md:h-36', // AIRA responsive hero mark
};

/**
 * AiraBrandMark — Unified Brand Identity Component
 * 
 * Provides consistent access to:
 * - Product Motion (Concept A: Architectural Alignment for UI/Navbars)
 * - Signature Motion (Concept C: Sculptural Assembly for Hero/Keynotes)
 * - Pure Static Vector rendering across Master (10-facet), UI (7-facet), and Micro Favicon (4-facet)
 */
export const AiraBrandMark: React.FC<AiraBrandMarkProps> = ({
  size = 'md',
  scale = 'auto',
  variant = 'static',
  mode = 'static',
  replayKey = 0,
  className = '',
  forceReducedMotion = false,
  onAnimationComplete,
  'aria-label': ariaLabel = 'AIRA Identity',
}) => {
  // If Product Motion is explicitly requested
  if (variant === 'product' && mode !== 'static') {
    return (
      <AiraProductMotion
        size={typeof size === 'string' && ['xs', 'sm', 'md', 'lg', 'xl'].includes(size) ? (size as any) : (typeof size === 'number' ? size : 'md')}
        mode={mode}
        replayKey={replayKey}
        className={className}
        forceReducedMotion={forceReducedMotion}
        onComplete={onAnimationComplete}
        aria-label={ariaLabel}
      />
    );
  }

  // If Signature Motion is explicitly requested
  if (variant === 'signature' && mode !== 'static') {
    return (
      <AiraSignatureMotion
        size={typeof size === 'string' && ['lg', 'xl', 'hero'].includes(size) ? (size as any) : (typeof size === 'number' ? size : 'hero')}
        mode={mode}
        replayKey={replayKey}
        className={className}
        forceReducedMotion={forceReducedMotion}
        onComplete={onAnimationComplete}
        aria-label={ariaLabel}
      />
    );
  }

  // Pure Static Rendering (Zero Animation Overhead)
  let effectiveScale = scale;
  if (effectiveScale === 'auto') {
    if (size === 'xs' || (typeof size === 'number' && size <= 18)) {
      effectiveScale = 'micro';
    } else if (size === 'hero' || size === 'xl' || (typeof size === 'number' && size >= 56)) {
      effectiveScale = 'master';
    } else {
      effectiveScale = 'ui';
    }
  }

  const sizeClass = typeof size === 'number' ? '' : sizeClassMap[size] || 'w-7 h-7';
  const customStyle = typeof size === 'number' ? { width: `${size}px`, height: `${size}px` } : undefined;

  if (effectiveScale === 'micro') {
    return (
      <div className={`relative inline-flex items-center justify-center flex-shrink-0 select-none ${sizeClass} ${className}`} style={customStyle} aria-label={ariaLabel} role="img">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" className="w-full h-full">
          <g className="pylon-group pylon-left">
            {MICRO_PORTAL_FACETS.filter(f => f.pylon === 'left').map(f => (
              <path key={f.id} d={f.d} fill="currentColor" />
            ))}
          </g>
          <g className="pylon-group pylon-right">
            {MICRO_PORTAL_FACETS.filter(f => f.pylon === 'right').map(f => (
              <path key={f.id} d={f.d} fill="currentColor" />
            ))}
          </g>
        </svg>
      </div>
    );
  }

  if (effectiveScale === 'ui') {
    return (
      <div className={`relative inline-flex items-center justify-center flex-shrink-0 select-none ${sizeClass} ${className}`} style={customStyle} aria-label={ariaLabel} role="img">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" className="w-full h-full">
          <g className="pylon-group pylon-left">
            {UI_PORTAL_FACETS.filter(f => f.pylon === 'left').map(f => (
              <path key={f.id} d={f.d} fill="currentColor" />
            ))}
          </g>
          <g className="pylon-group pylon-right">
            {UI_PORTAL_FACETS.filter(f => f.pylon === 'right').map(f => (
              <path key={f.id} d={f.d} fill="currentColor" />
            ))}
          </g>
        </svg>
      </div>
    );
  }

  // Master Scale (Default 10 Facets)
  return (
    <div className={`relative inline-flex items-center justify-center flex-shrink-0 select-none ${sizeClass} ${className}`} style={customStyle} aria-label={ariaLabel} role="img">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" className="w-full h-full">
        <g className="pylon-group pylon-left">
          {MASTER_PORTAL_FACETS.filter(f => f.pylon === 'left').map(f => (
            <path key={f.id} d={f.d} fill="currentColor" />
          ))}
        </g>
        <g className="pylon-group pylon-right">
          {MASTER_PORTAL_FACETS.filter(f => f.pylon === 'right').map(f => (
            <path key={f.id} d={f.d} fill="currentColor" />
          ))}
        </g>
      </svg>
    </div>
  );
};

export default AiraBrandMark;
