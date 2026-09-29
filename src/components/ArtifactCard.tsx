import React from 'react';
import { Layers, ArrowRight, Play } from 'lucide-react';
import type { Artifact } from '../types';

interface ArtifactCardProps {
  artifact: Artifact;
  onOpen: (artifact: Artifact) => void;
}

export const ArtifactCard: React.FC<ArtifactCardProps> = ({ artifact, onOpen }) => {
  return (
    <div 
      data-testid="artifact-card"
      onClick={() => onOpen(artifact)}
      className="my-3 p-3.5 rounded-xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark hover:border-claude-terracotta/70 shadow-claude-card hover:shadow-md cursor-pointer transition-all duration-200 group flex items-center justify-between"
    >
      <div className="flex items-center space-x-3 min-w-0">
        <div className="w-10 h-10 rounded-lg bg-claude-terracotta/10 text-claude-terracotta flex items-center justify-center flex-shrink-0 group-hover:scale-105 transition-transform">
          <Layers className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center space-x-2">
            <h4 className="text-sm font-semibold text-claude-text-light dark:text-claude-text-dark group-hover:text-claude-terracotta transition-colors truncate">
              {artifact.title}
            </h4>
            <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark border border-claude-border-light dark:border-claude-border-dark">
              {artifact.language || 'app'}
            </span>
          </div>
          <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark flex items-center space-x-1.5 mt-0.5">
            <span>Aira Output</span>
            <span>•</span>
            <span className="flex items-center text-claude-terracotta font-medium">
              <Play className="w-2.5 h-2.5 mr-0.5 inline" /> Run live preview
            </span>
          </p>
        </div>
      </div>

      <div className="flex items-center space-x-2 flex-shrink-0 ml-3">
        <span className="hidden sm:flex items-center space-x-1 text-xs font-medium text-claude-muted-light dark:text-claude-muted-dark group-hover:text-claude-terracotta transition-colors">
          <span>Open studio</span>
          <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </span>
      </div>
    </div>
  );
};
