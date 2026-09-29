import React from 'react';
import { Sparkles } from 'lucide-react';

interface AiraMarkProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeMap = {
  sm: 'w-7 h-7 rounded-lg',
  md: 'w-9 h-9 rounded-xl',
  lg: 'w-14 h-14 rounded-[18px]',
};

const iconMap = {
  sm: 'w-3.5 h-3.5',
  md: 'w-4.5 h-4.5',
  lg: 'w-6 h-6',
};

export const AiraMark: React.FC<AiraMarkProps> = ({ size = 'md', className = '' }) => (
  <div
    className={`${sizeMap[size]} aira-mark relative flex items-center justify-center overflow-hidden text-white shadow-sm ${className}`}
    aria-label="Aira"
  >
    <span className="aira-mark-orbit" aria-hidden="true" />
    <Sparkles className={`${iconMap[size]} relative z-10`} strokeWidth={2.2} />
  </div>
);
