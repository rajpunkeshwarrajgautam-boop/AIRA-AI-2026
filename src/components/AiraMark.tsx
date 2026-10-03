import React from 'react';
import { motion } from 'framer-motion';

interface AiraMarkProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'hero';
  className?: string;
  isAnimated?: boolean;
}

const sizeMap = {
  xs: 'w-4 h-4',
  sm: 'w-5 h-5',
  md: 'w-7 h-7',
  lg: 'w-10 h-10',
  xl: 'w-16 h-16',
  hero: 'w-28 h-28 sm:w-32 sm:h-32 md:w-36 md:h-36',
};

/**
 * AiraMark — The Aira Celestial Neural Knot
 * 
 * Design Synthesis:
 * - ChatGPT: 6-loop recursive interlocking continuous topological ribbon knot (C6 symmetry)
 * - Claude: Warm humanist organic curves, terracotta/amber multi-stop luminous gradients
 * - Manus: Dimensional 3D origami folded bevels with crisp white specular ridge reflections
 * - Cosmic/Planetary: Nested gyroscopic celestial orbital rings with a glowing core singularity
 */
export const AiraMark: React.FC<AiraMarkProps> = ({ 
  size = 'md', 
  className = '',
  isAnimated = true
}) => {
  const isCompact = size === 'xs' || size === 'sm';
  const isHero = size === 'hero' || size === 'xl';

  // Compact scale optimized for chat message avatars and small badges
  if (isCompact) {
    return (
      <div 
        className={`relative inline-flex items-center justify-center flex-shrink-0 select-none ${sizeMap[size]} ${className}`}
        aria-label="Aira Neural Knot"
      >
        <svg 
          viewBox="0 0 64 64" 
          fill="none" 
          xmlns="http://www.w3.org/2000/svg"
          className="w-full h-full overflow-visible"
        >
          <g>
            {[0, 60, 120, 180, 240, 300].map((angle, idx) => (
              <g key={idx} transform={`rotate(${angle} 32 32)`}>
                <path
                  d="M 25 24 C 23 16 26 8 32 7 C 37 6 42 10 41 16 C 40 21 34 26 27 27"
                  stroke="var(--accent-terracotta, #D97757)"
                  strokeWidth="4.2"
                  strokeLinecap="round"
                />
              </g>
            ))}
            <circle cx="32" cy="32" r="3.2" fill="#FFFFFF" />
          </g>
        </svg>
      </div>
    );
  }

  const ribbonPath = "M 25 24 C 23 16 26 8 32 7 C 37 6 42 10 41 16 C 40 21 34 26 27 27";
  const angles = [0, 60, 120, 180, 240, 300];

  return (
    <motion.div
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 380, damping: 22 }}
      className={`relative inline-flex items-center justify-center flex-shrink-0 select-none ${sizeMap[size]} ${className}`}
      aria-label="Aira Celestial Neural Knot"
    >
      {/* Ambient Pulsing Atmospheric Planetary Nebula Aura (Hero Scale) */}
      {isHero && isAnimated && (
        <motion.div
          animate={{
            scale: [0.95, 1.22, 0.95],
            opacity: [0.35, 0.65, 0.35],
          }}
          transition={{
            duration: 5.2,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
          className="absolute inset-0 -m-8 bg-gradient-to-tr from-claude-terracotta/35 via-amber-500/25 to-claude-terracotta/35 blur-3xl rounded-full pointer-events-none -z-10"
        />
      )}

      <svg 
        viewBox="0 0 64 64" 
        fill="none" 
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full overflow-visible drop-shadow-[0_4px_20px_rgba(217,119,87,0.32)]"
      >
        <defs>
          {/* Gradients for each of the 6 interlocking ribbons */}
          {angles.map((_, i) => {
            const rad = (i * 60 * Math.PI) / 180;
            const x1 = (32 + Math.cos(rad) * 8).toFixed(1);
            const y1 = (32 + Math.sin(rad) * 8).toFixed(1);
            const x2 = (32 + Math.cos(rad) * 26).toFixed(1);
            const y2 = (32 + Math.sin(rad) * 26).toFixed(1);
            return (
              <linearGradient 
                key={i} 
                id={`airaHexGrad_${i}`} 
                x1={x1} 
                y1={y1} 
                x2={x2} 
                y2={y2} 
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0%" stopColor="var(--accent-terracotta-hover, #FFA88B)" />
                <stop offset="50%" stopColor="var(--accent-terracotta, #D97757)" />
                <stop offset="100%" stopColor="var(--accent-terracotta-hover, #9E3F24)" />
              </linearGradient>
            );
          })}

          {/* 3D Depth Shadow for True Topological Layering */}
          <filter id="airaRibbonShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1.6" stdDeviation="1.4" floodColor="#000000" floodOpacity="0.48" />
          </filter>

          {/* Core Singularity Radial Glow */}
          <radialGradient id="airaCoreSingularity" cx="35%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="55%" stopColor="var(--accent-terracotta-hover, #FFA88B)" />
            <stop offset="100%" stopColor="var(--accent-terracotta, #D97757)" />
          </radialGradient>
        </defs>

        {/* Counter-rotating Gyroscopic Cosmic Orbital Rings */}
        <motion.g
          animate={isAnimated ? { rotate: [0, -360] } : undefined}
          transition={isAnimated ? { duration: 42, repeat: Infinity, ease: 'linear' } : undefined}
          style={{ transformOrigin: '32px 32px' }}
        >
          <circle 
            cx="32" 
            cy="32" 
            r="28.5" 
            stroke="var(--accent-terracotta, #D97757)" 
            strokeWidth="0.8" 
            strokeDasharray="2.5 4" 
            strokeOpacity="0.32" 
            fill="none" 
          />
          <circle 
            cx="32" 
            cy="32" 
            r="19" 
            stroke="var(--accent-terracotta, #D97757)" 
            strokeWidth="0.6" 
            strokeDasharray="1.5 3" 
            strokeOpacity="0.26" 
            fill="none" 
          />
        </motion.g>

        {/* 6-Fold Interlocking Ribbon Knot (Smooth Prograde Rotation) */}
        <motion.g
          animate={isAnimated ? { rotate: [0, 360] } : undefined}
          transition={isAnimated ? { duration: 24, repeat: Infinity, ease: 'linear' } : undefined}
          style={{ transformOrigin: '32px 32px' }}
        >
          {angles.map((angle, idx) => (
            <g key={idx} transform={`rotate(${angle} 32 32)`}>
              {/* Outer 3D shaded ribbon body */}
              <path
                d={ribbonPath}
                stroke={`url(#airaHexGrad_${idx})`}
                strokeWidth={isHero ? '3.8' : '3.2'}
                strokeLinecap="round"
                fill="none"
                filter="url(#airaRibbonShadow)"
              />
              {/* Manus 3D faceted specular ridge highlight */}
              <path
                d="M 28 11 C 31 7.5 36 7.5 39 10"
                stroke="#FFFFFF"
                strokeWidth={isHero ? '1.2' : '0.9'}
                strokeLinecap="round"
                strokeOpacity="0.88"
                fill="none"
              />
            </g>
          ))}

          {/* Central Pulsar Singularity Core */}
          <motion.circle
            cx="32"
            cy="32"
            r={isHero ? '4' : '3.2'}
            fill="url(#airaCoreSingularity)"
            stroke="#FFFFFF"
            strokeWidth="1.2"
            animate={isAnimated ? {
              scale: [1, 1.25, 1],
              opacity: [0.92, 1, 0.92],
            } : undefined}
            transition={isAnimated ? {
              duration: 2.8,
              repeat: Infinity,
              ease: 'easeInOut',
            } : undefined}
            style={{ transformOrigin: '32px 32px' }}
          />
        </motion.g>
      </svg>
    </motion.div>
  );
};
