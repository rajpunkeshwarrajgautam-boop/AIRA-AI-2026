import React from 'react';
import { AiraBrandMark } from './brand/AiraBrandMark';

export interface AiraMarkProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'hero';
  className?: string;
  isAnimated?: boolean;
  motionConcept?: 'a' | 'c' | 'none';
  replayKey?: number | string;
}

/**
 * AiraMark — The Sheared Perspective Portal
 * 
 * Principal Brand Mark for AIRA AI 2026:
 * - Master Scale (10 facets): Hero & Keynotes with Concept C (Sculptural Assembly)
 * - UI Scale (7 facets): Product UI, Navbar, Sidebar with Concept A (Architectural Alignment)
 * - Micro Scale (4 facets): Compact utility placements & favicon
 * 
 * Rules:
 * - Explicit animation only: Chat avatars and utility marks default to static.
 * - Mount-guarded against chat streaming, theme changes, and routine rerenders.
 */
export const AiraMark: React.FC<AiraMarkProps> = ({ 
  size = 'md', 
  className = '',
  isAnimated = false,
  motionConcept = 'none',
  replayKey = 0,
}) => {
  // Determine if motion is explicitly requested
  let motionVariant: 'product' | 'signature' | 'static' = 'static';
  let mode: 'entrance' | 'static' = 'static';

  if (motionConcept === 'a') {
    motionVariant = 'product';
    mode = 'entrance';
  } else if (motionConcept === 'c') {
    motionVariant = 'signature';
    mode = 'entrance';
  } else if (isAnimated) {
    if (size === 'hero' || size === 'xl') {
      motionVariant = 'signature';
      mode = 'entrance';
    } else {
      motionVariant = 'product';
      mode = 'entrance';
    }
  }

  return (
    <AiraBrandMark
      size={size}
      variant={motionVariant}
      mode={mode}
      replayKey={replayKey}
      className={className}
    />
  );
};

export default AiraMark;
