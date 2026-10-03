import React from 'react';
import { Layers, ArrowRight, Play } from 'lucide-react';
import { motion } from 'framer-motion';
import type { Artifact } from '../types';

interface ArtifactCardProps {
  artifact: Artifact;
  onOpen: (artifact: Artifact) => void;
}

export const ArtifactCard: React.FC<ArtifactCardProps> = ({ artifact, onOpen }) => {
  return (
    <motion.div 
      layout
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.98 }}
      transition={{ duration: 0.15 }}
      data-testid="artifact-card"
      onClick={() => onOpen(artifact)}
      className="my-3 p-3.5 sm:p-4 rounded-xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-[0_1px_3px_rgba(45,40,30,0.04)] hover:border-claude-terracotta/40 cursor-pointer transition-all duration-200 group flex items-center justify-between"
    >
      <div className="flex items-center space-x-3.5 min-w-0">
        <div className="w-10 h-10 rounded-lg bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-terracotta flex items-center justify-center flex-shrink-0 group-hover:bg-claude-terracotta/10 transition-colors">
          <Layers className="w-5 h-5" strokeWidth={1.5} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center space-x-2">
            <h4 className="text-sm font-medium text-claude-text-light dark:text-claude-text-dark transition-colors truncate">
              {artifact.title}
            </h4>
            <span className="text-[10px] font-mono uppercase px-1.5 py-0.2 rounded bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark">
              {artifact.language || 'app'}
            </span>
          </div>
          <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark flex items-center space-x-1.5 mt-0.5">
            <span>Click to open in Artifact Studio</span>
            <span className="opacity-40">•</span>
            <span className="flex items-center text-claude-terracotta font-medium">
              <Play className="w-2.5 h-2.5 mr-1 fill-current inline" /> Preview
            </span>
          </p>
        </div>
      </div>

      <div className="flex items-center space-x-2 flex-shrink-0 ml-3">
        <div className="flex items-center space-x-1 text-xs text-claude-muted-light dark:text-claude-muted-dark group-hover:text-claude-terracotta transition-colors">
          <span className="hidden sm:inline">View</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </div>
      </div>
    </motion.div>
  );
};
