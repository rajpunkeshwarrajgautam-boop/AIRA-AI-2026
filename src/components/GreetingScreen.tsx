import React, { useMemo } from 'react';
import { ArrowUpRight, Code, Compass, FileText, Sparkles, Bot, Library, Workflow } from 'lucide-react';
import type { WorkspaceMode } from '../types';
import { PROMPT_STARTERS } from '../utils/constants';
import { AiraMark } from './AiraMark';

interface GreetingScreenProps {
  userName: string;
  workspaceMode: WorkspaceMode;
  onSelectStarter: (prompt: string) => void;
}

const modeCopy: Record<WorkspaceMode, { eyebrow: string; title: string; body: string }> = {
  chat: {
    eyebrow: 'ONE WORKSPACE · EVERY INTELLIGENCE',
    title: 'What are we working on?',
    body: 'Ask, research, build, analyze, or hand off a mission. Aira keeps the work in one place.',
  },
  research: {
    eyebrow: 'RESEARCH',
    title: 'Investigate with depth.',
    body: 'Frame the question, gather evidence, compare sources, and turn findings into an actionable answer.',
  },
  library: {
    eyebrow: 'LIBRARY',
    title: 'Work from your knowledge.',
    body: 'The Aira library shell is active. Connect files and project knowledge here as the production data layer is wired in.',
  },
  agents: {
    eyebrow: 'AGENTS',
    title: 'Delegate an outcome.',
    body: 'Define the objective, constraints, and deliverable. Aira can turn it into an agent mission as execution services come online.',
  },
  automations: {
    eyebrow: 'AUTOMATIONS',
    title: 'Make the work repeat itself.',
    body: 'Describe the trigger, cadence, or condition and the action you want Aira to perform.',
  },
};

export const GreetingScreen: React.FC<GreetingScreenProps> = ({
  userName,
  workspaceMode,
  onSelectStarter,
}) => {
  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const copy = modeCopy[workspaceMode];

  const getStarterIcon = (iconName: string) => {
    switch (iconName) {
      case 'code': return <Code className="w-4 h-4 text-claude-terracotta" />;
      case 'file-text': return <FileText className="w-4 h-4 text-cyan-300" />;
      case 'compass': return <Compass className="w-4 h-4 text-violet-300" />;
      case 'bot': return <Bot className="w-4 h-4 text-indigo-300" />;
      case 'library': return <Library className="w-4 h-4 text-cyan-300" />;
      case 'workflow': return <Workflow className="w-4 h-4 text-violet-300" />;
      default: return <Sparkles className="w-4 h-4 text-claude-terracotta" />;
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 max-w-3xl mx-auto py-14 select-none">
      <AiraMark size="lg" className="mb-7" />

      <div className="text-[10px] md:text-[11px] font-semibold tracking-[0.18em] text-claude-terracotta mb-3">
        {copy.eyebrow}
      </div>
      <h1 className="text-3xl md:text-[40px] font-semibold tracking-[-0.04em] text-claude-text-light dark:text-claude-text-dark text-center mb-2.5">
        {workspaceMode === 'chat' ? `${greeting}, ${userName || 'there'}.` : copy.title}
      </h1>
      {workspaceMode === 'chat' && (
        <div className="text-xl md:text-2xl font-medium tracking-[-0.03em] text-claude-text-light/80 dark:text-claude-text-dark/80 text-center mb-3">
          {copy.title}
        </div>
      )}
      <p className="text-sm md:text-[15px] text-claude-muted-light dark:text-claude-muted-dark text-center max-w-xl mb-10 leading-relaxed">
        {copy.body}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
        {PROMPT_STARTERS.map((starter, index) => (
          <button
            key={index}
            onClick={() => onSelectStarter(starter.prompt)}
            className="group relative text-left p-4 rounded-2xl bg-claude-surface-light/90 dark:bg-claude-surface-dark/90 border border-claude-border-light dark:border-claude-border-dark shadow-claude-card hover:shadow-claude-card-hover hover:border-claude-terracotta/40 cursor-pointer transition-all duration-200 ease-out flex flex-col justify-between min-h-[108px] overflow-hidden"
          >
            <div className="aira-card-glow" aria-hidden="true" />
            <div className="relative z-10 flex items-start justify-between mb-2">
              <div className="flex items-center space-x-2.5">
                <div className="p-1.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light/60 dark:border-claude-border-dark/60 group-hover:scale-105 transition-transform duration-150">
                  {getStarterIcon(starter.icon)}
                </div>
                <h3 className="text-xs font-semibold text-claude-text-light dark:text-claude-text-dark group-hover:text-claude-terracotta transition-colors tracking-tight">
                  {starter.title}
                </h3>
              </div>
              <ArrowUpRight className="w-3.5 h-3.5 text-claude-muted-light dark:text-claude-muted-dark opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all duration-150 flex-shrink-0" />
            </div>
            <p className="relative z-10 text-xs text-claude-muted-light dark:text-claude-muted-dark line-clamp-2 leading-relaxed">
              {starter.prompt}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
};
