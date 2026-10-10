import React, { useState, useMemo, useRef, useCallback } from 'react';
import { 
  Compass, 
  Code2, 
  FileText, 
  Bot, 
  ArrowUpRight,
  Zap,
  RotateCcw,
  FolderGit2,
  Brain,
  Layers
} from 'lucide-react';
import confetti from 'canvas-confetti';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import type { WorkspaceMode, Conversation, Project } from '../types';
import { AiraMark } from './AiraMark';

gsap.registerPlugin(useGSAP);

interface GreetingScreenProps {
  userName: string;
  workspaceMode: WorkspaceMode;
  onSelectStarter: (prompt: string) => void;
  conversations?: Conversation[];
  activeProject?: Project;
  extendedThinking?: boolean;
  onSelectChat?: (id: string) => void;
}

interface PromptCard {
  id: string;
  title: string;
  prompt: string;
  icon: React.ReactNode;
}

export const GreetingScreen: React.FC<GreetingScreenProps> = ({
  userName,
  workspaceMode,
  onSelectStarter,
  conversations = [],
  activeProject,
  extendedThinking = false,
  onSelectChat,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [easterEggCount, setEasterEggCount] = useState(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [currentTime] = useState(() => new Date());

  // Time & date situation analysis
  const timeContext = useMemo(() => {
    const hour = currentTime.getHours();
    const day = currentTime.getDay(); // 0 is Sunday, 6 is Saturday
    const isWeekend = day === 0 || day === 6;
    const isFriday = day === 5;
    const isMonday = day === 1;

    let period: 'early' | 'morning' | 'afternoon' | 'evening' | 'night';
    let baseGreeting = 'Good morning';
    let situationDescription = 'Ready to explore, build, or analyze today?';

    if (hour >= 4 && hour < 9) {
      period = 'early';
      baseGreeting = 'Early start';
      situationDescription = 'The quiet hours are ideal for deep architecture and uninterrupted focus.';
    } else if (hour >= 9 && hour < 12) {
      period = 'morning';
      baseGreeting = 'Good morning';
      situationDescription = isMonday 
        ? 'A fresh week begins. What key objective shall we set in motion?' 
        : 'Fresh momentum. What would you like to build, research, or solve?';
    } else if (hour >= 12 && hour < 17) {
      period = 'afternoon';
      baseGreeting = 'Good afternoon';
      situationDescription = isFriday 
        ? 'Friday afternoon wrap-up. Ready to finish strong or plan next steps?' 
        : 'Deep in the flow. How can Aira assist with execution and technical design?';
    } else if (hour >= 17 && hour < 22) {
      period = 'evening';
      baseGreeting = 'Good evening';
      situationDescription = isWeekend
        ? 'Weekend focus session. Exploring creative ideas or building personal projects?'
        : 'Winding down or synthesizing today’s breakthroughs? Let’s review.';
    } else {
      period = 'night';
      baseGreeting = 'Late night focus';
      situationDescription = 'Midnight clarity. Let’s make this quiet session productive and sharp.';
    }

    return { hour, day, isWeekend, isFriday, isMonday, period, baseGreeting, situationDescription };
  }, [currentTime]);

  // Chat history situation analysis
  const recentHistory = useMemo(() => {
    const activeChats = conversations.filter(c => c.messages && c.messages.length > 0);
    if (!activeChats.length) return { recentChat: null, domain: 'general' as const };

    const recentChat = activeChats[0]; // Most recent active conversation
    const allRecentText = activeChats.slice(0, 3).map(c => `${c.title} ${c.messages.map(m => m.content).join(' ')}`).join(' ').toLowerCase();

    let domain: 'code' | 'research' | 'writing' | 'agent' | 'general' = 'general';
    if (allRecentText.includes('code') || allRecentText.includes('react') || allRecentText.includes('typescript') || allRecentText.includes('bug') || allRecentText.includes('component')) {
      domain = 'code';
    } else if (allRecentText.includes('research') || allRecentText.includes('market') || allRecentText.includes('competitor') || allRecentText.includes('analysis') || allRecentText.includes('paper')) {
      domain = 'research';
    } else if (allRecentText.includes('agent') || allRecentText.includes('workflow') || allRecentText.includes('pipeline') || allRecentText.includes('automation')) {
      domain = 'agent';
    }

    return { recentChat, domain };
  }, [conversations]);

  // Contextual Greeting Title
  const dynamicGreetingTitle = useMemo(() => {
    // If specific workspace mode is active, reflect it
    if (workspaceMode === 'research') return 'Research & Investigation';
    if (workspaceMode === 'agents') return 'Autonomous Missions';
    if (workspaceMode === 'automations') return 'Workflow Engineering';
    if (workspaceMode === 'library') return 'Workspace Knowledge';

    // Standard chat mode with dynamic persona
    const cleanedName = userName && userName.trim() !== 'Explorer' ? userName.trim() : '';

    if (cleanedName) {
      return `${timeContext.baseGreeting}, ${cleanedName}.`;
    }
    return `${timeContext.baseGreeting}.`;
  }, [workspaceMode, userName, timeContext]);

  // Dynamic Subtitle
  const dynamicSubtitle = useMemo(() => {
    if (activeProject) {
      return `Working within "${activeProject.name}" with ${activeProject.docs.length} linked document${activeProject.docs.length === 1 ? '' : 's'}.`;
    }
    if (workspaceMode === 'research') {
      return 'Cross-examine sources, gather structured citations, and synthesize technical briefs.';
    }
    if (workspaceMode === 'agents') {
      return 'Delegate multi-step goals with automated checkpoints and verifiable deliverables.';
    }
    if (workspaceMode === 'automations') {
      return 'Construct repeatable trigger-action routines with self-healing failure guards.';
    }
    if (workspaceMode === 'library') {
      return 'Query your connected project knowledge graphs, files, and repositories.';
    }
    if (extendedThinking) {
      return 'Deep reasoning enabled. Complex analysis, architecture, and multi-step synthesis ready.';
    }
    return timeContext.situationDescription;
  }, [activeProject, workspaceMode, extendedThinking, timeContext]);

  // Dynamic Starter Suggestion Grid tailored to context & history
  const dynamicStarters: PromptCard[] = useMemo(() => {
    if (activeProject) {
      return [
        {
          id: 'proj-arch',
          title: `Analyze ${activeProject.name} Architecture`,
          prompt: `Analyze the documents in project "${activeProject.name}" and provide a high-level system architecture and component dependency map.`,
          icon: <FolderGit2 className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
        },
        {
          id: 'proj-code',
          title: 'Implement Core Feature',
          prompt: `Based on project "${activeProject.name}" specifications, write the production TypeScript implementation for the primary missing capability.`,
          icon: <Code2 className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
        },
        {
          id: 'proj-review',
          title: 'Red Team & Risk Audit',
          prompt: `Review the design constraints and architecture of "${activeProject.name}". Identify 3 potential edge-case failures and mitigation strategies.`,
          icon: <Brain className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
        },
        {
          id: 'proj-doc',
          title: 'Synthesize Executive Brief',
          prompt: `Synthesize the current status of project "${activeProject.name}" into a 1-page executive decision memo with next milestone priorities.`,
          icon: <FileText className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
        }
      ];
    }

    if (recentHistory.domain === 'code') {
      return [
        {
          id: 'code-dash',
          title: 'Build interactive React artifact',
          prompt: 'Design and build a polished interactive dashboard artifact with realtime telemetry, responsive grid layout, and smooth animations.',
          icon: <Code2 className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
        },
        {
          id: 'code-audit',
          title: 'Review codebase & optimize performance',
          prompt: 'Review this frontend component architecture for re-render bottlenecks, accessibility WCAG compliance, and type safety improvements.',
          icon: <Brain className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
        },
        {
          id: 'code-agent',
          title: 'Design full-stack API contract',
          prompt: 'Draft an OpenAPI-spec compliant schema with TypeScript types, rate limiting rules, and idempotent mutation handlers.',
          icon: <Layers className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
        },
        {
          id: 'code-doc',
          title: 'Generate interactive SVG illustration',
          prompt: 'Generate an SVG architectural diagram representing a multi-agent orchestration pipeline with glowing bus lines and clean geometric nodes.',
          icon: <Zap className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
        }
      ];
    }

    if (recentHistory.domain === 'research') {
      return [
        {
          id: 'res-comp',
          title: 'Research a competitive landscape',
          prompt: 'Research the current landscape for multi-model AI workspaces and compile a structured, sourced competitive brief with key product gaps.',
          icon: <Compass className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
        },
        {
          id: 'res-synthesis',
          title: 'Synthesize complex technical paper',
          prompt: 'Break down the core trade-offs between dense vs mixture-of-experts transformer architectures and summarize empirical benchmarks.',
          icon: <FileText className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
        },
        {
          id: 'res-memo',
          title: 'Draft executive decision memo',
          prompt: 'Draft a concise decision memo outlining 3 architectural alternatives for scalable real-time collaboration with estimated costs and risks.',
          icon: <FileText className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
        },
        {
          id: 'res-agent',
          title: 'Explore emerging market signals',
          prompt: 'Analyze current adoption trends for local agentic coding assistants and identify key enterprise security requirements.',
          icon: <Bot className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
        }
      ];
    }

    // Default high-caliber Claude starters
    return [
      {
        id: 'default-research',
        title: 'Research a complex topic',
        prompt: 'Research the current landscape for multi-model AI workspaces and compile a structured, sourced competitive brief with key product gaps.',
        icon: <Compass className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
      },
      {
        id: 'default-code',
        title: 'Build an interactive web artifact',
        prompt: 'Design and build a polished interactive dashboard artifact for an AI operations workspace with realtime telemetry and responsive charts.',
        icon: <Code2 className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
      },
      {
        id: 'default-analyze',
        title: 'Analyze documents or data',
        prompt: 'Analyze attached project materials, extract the critical findings, and organize them into an executive decision memo.',
        icon: <FileText className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
      },
      {
        id: 'default-agent',
        title: 'Plan an autonomous workflow',
        prompt: 'Break this objective into an autonomous agent mission with clear steps, tools, checkpoints, and a verifiable deliverable.',
        icon: <Bot className="w-4 h-4 text-claude-terracotta" strokeWidth={1.5} />,
      },
    ];
  }, [activeProject, recentHistory.domain]);

  const triggerCelebration = useCallback(() => {
    confetti({
      particleCount: 40,
      spread: 60,
      origin: { y: 0.45, x: 0.5 },
      colors: ['#D97757', '#C15335', '#F5E3DC', '#F0EFEA'],
    });
    setToastMessage('Aira intelligence synchronized.');
    setTimeout(() => setToastMessage(null), 3000);
  }, []);

  // Easter egg
  const handleEmblemClick = () => {
    const next = easterEggCount + 1;
    setEasterEggCount(next);
    if (next === 5) {
      triggerCelebration();
      setEasterEggCount(0);
    }
  };

  useGSAP(() => {
    const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });
    tl.fromTo(
      '.claude-fade-up',
      { y: 14, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.65, stagger: 0.07 }
    );
  }, { scope: containerRef });

  return (
    <div 
      ref={containerRef} 
      className="flex-1 w-full max-w-2xl mx-auto px-4 sm:px-6 py-10 md:py-16 flex flex-col items-center justify-center select-none text-center"
    >
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-xs flex items-center gap-2 text-xs font-sans text-claude-text-light dark:text-claude-text-dark animate-fade-in">
          <Zap className="w-3.5 h-3.5 text-claude-terracotta" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Aira Neural Cognition Knot with Ambient Aura Glow */}
      <div 
        onClick={handleEmblemClick}
        className="claude-fade-up relative cursor-pointer mb-5 flex items-center justify-center active:scale-95 transition-transform duration-200"
        title="Aira Intelligence"
      >
        <div className="aura-ambient-glow" />
        <div className="relative z-10">
          <AiraMark size="hero" isAnimated={true} />
        </div>
      </div>

      {/* Literary Newsreader Serif Dynamic Greeting Headline */}
      <h1 
        className="claude-fade-up font-serif font-normal text-[2.5rem] sm:text-[3.25rem] text-claude-text-light dark:text-claude-text-dark tracking-[-0.02em] leading-[1.15] mb-2.5 max-w-3xl"
        style={{ textWrap: 'balance' }}
      >
        {dynamicGreetingTitle}
      </h1>

      {/* Dynamic Situation Subtitle */}
      <p 
        className="claude-fade-up text-sm sm:text-base text-claude-muted-light dark:text-claude-muted-dark font-sans leading-relaxed mb-6 max-w-lg"
        style={{ textWrap: 'balance' }}
      >
        {dynamicSubtitle}
      </p>

      {/* History Continuation Pill (if recent chat exists) */}
      {recentHistory.recentChat && onSelectChat && (
        <div className="claude-fade-up mb-7 w-full max-w-md">
          <button
            onClick={() => onSelectChat(recentHistory.recentChat!.id)}
            className="w-full flex items-center justify-between p-2.5 px-3.5 rounded-xl gradient-card-surface hover:border-claude-terracotta/40 text-left transition-all duration-300 group active:scale-[0.99]"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="p-1 rounded-lg bg-linear-to-br from-claude-terracotta/20 to-claude-terracotta/5 text-claude-terracotta">
                <RotateCcw className="w-3.5 h-3.5" />
              </span>
              <div className="min-w-0">
                <span className="text-[10px] uppercase font-bold tracking-wider text-claude-muted-light dark:text-claude-muted-dark block">Pick up recent thread</span>
                <span className="text-xs font-semibold text-claude-text-light dark:text-white truncate block">{recentHistory.recentChat.title}</span>
              </div>
            </div>
            <ArrowUpRight className="w-4 h-4 text-claude-muted-light group-hover:text-claude-terracotta group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all shrink-0" />
          </button>
        </div>
      )}

      {/* Context-aware Starter Suggestion Grid (Claude 2x2 warm cards with gradient surfaces) */}
      <div className="claude-fade-up w-full grid grid-cols-1 sm:grid-cols-2 gap-3 text-left grid-flow-dense">
        {dynamicStarters.map((starter, idx) => (
          <button
            key={starter.id}
            onClick={() => onSelectStarter(starter.prompt)}
            className={`group p-4 rounded-xl gradient-card-surface specular-hover transition-all duration-300 cursor-pointer flex flex-col justify-between active:scale-[0.98] ${idx === 0 ? 'border-claude-terracotta/30 shadow-[0_2px_12px_rgba(217,119,87,0.06)]' : ''}`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="p-1.5 rounded-lg bg-claude-surface2-light/80 dark:bg-claude-surface2-dark/80 text-claude-terracotta group-hover:bg-claude-terracotta/15 transition-colors">
                {starter.icon}
              </span>
              <ArrowUpRight className="w-3.5 h-3.5 text-claude-muted-light/40 dark:text-claude-muted-dark/40 group-hover:text-claude-terracotta group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" strokeWidth={1.5} />
            </div>

            <div>
              <div className="text-sm font-medium text-claude-text-light dark:text-claude-text-dark mb-1 group-hover:text-claude-terracotta transition-colors font-sans">
                {starter.title}
              </div>
              <div 
                className="text-xs text-claude-muted-light dark:text-claude-muted-dark line-clamp-2 leading-relaxed font-sans"
                style={{ textWrap: 'pretty' }}
              >
                {starter.prompt}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};
