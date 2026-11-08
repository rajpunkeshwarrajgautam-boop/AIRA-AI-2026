import React, { useState, useMemo, useRef, useCallback } from 'react';
import { ArrowUpRight, Zap, RotateCcw } from 'lucide-react';
import confetti from 'canvas-confetti';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import type { WorkspaceMode, Conversation, Project } from '../types';
import { AiraMark } from './AiraMark';

gsap.registerPlugin(useGSAP);

interface GreetingScreenProps {
  userName: string;
  workspaceMode: WorkspaceMode;
  conversations?: Conversation[];
  activeProject?: Project;
  extendedThinking?: boolean;
  onSelectChat?: (id: string) => void;
}

export const GreetingScreen: React.FC<GreetingScreenProps> = ({
  userName,
  workspaceMode,
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

  // Keep conversation continuation available without rendering suggestion cards.
  const recentChat = useMemo(() => conversations.find(c => c.messages?.length > 0), [conversations]);

  // Contextual Greeting Title
  const dynamicGreetingTitle = useMemo(() => {
    if (workspaceMode === 'agent') return 'Autonomous Agent Mission';

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
    if (workspaceMode === 'agent') {
      return 'Delegate multi-step goals, scaffold complete web applications, or design automated workflows with verifiable deliverables.';
    }
    if (extendedThinking) {
      return 'Deep reasoning enabled. Complex analysis, architecture, and multi-step synthesis ready.';
    }
    return timeContext.situationDescription;
  }, [activeProject, workspaceMode, extendedThinking, timeContext]);

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
    // Framer/CSS and the greeting entrance must respect the same motion settings.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('force-reduced-motion')) {
      gsap.set('.claude-fade-up', { clearProps: 'all' });
      return;
    }
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
      className="aira-editorial-greeting flex-1 w-full min-w-0 max-w-[760px] mx-auto px-4 sm:px-8 py-6 sm:py-10 md:py-14 flex flex-col items-center justify-center select-none text-center"
    >
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-sm flex items-center gap-2 text-xs font-sans text-claude-text-light dark:text-claude-text-dark animate-fade-in">
          <Zap className="w-3.5 h-3.5 text-claude-terracotta" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Aira Neural Cognition Knot with Ambient Aura Glow */}
      <div 
        onClick={handleEmblemClick}
        className="claude-fade-up relative cursor-pointer mb-7 flex items-center justify-center active:scale-95 transition-transform duration-200"
        title="Aira Intelligence"
      >
        <div className="aura-ambient-glow" />
        <div className="relative z-10">
          <AiraMark size="hero" isAnimated={true} />
        </div>
      </div>

      {/* Literary Newsreader Serif Dynamic Greeting Headline */}
      <h1 
        className="claude-fade-up font-serif font-normal text-[clamp(2.25rem,5vw,3.5rem)] text-claude-text-light dark:text-claude-text-dark tracking-[-0.035em] leading-[1.08] mb-4 max-w-3xl"
        style={{ textWrap: 'balance' }}
      >
        {dynamicGreetingTitle}
      </h1>

      {/* Dynamic Situation Subtitle */}
      <p 
        className="claude-fade-up text-sm sm:text-base text-claude-muted-light dark:text-claude-muted-dark font-sans leading-[1.55] mb-8 max-w-xl"
        style={{ textWrap: 'balance' }}
      >
        {dynamicSubtitle}
      </p>

      {/* A single unobtrusive text link retains recent-chat access. */}
      {recentChat && onSelectChat && (
        <button
          onClick={() => onSelectChat(recentChat.id)}
          className="claude-fade-up group inline-flex max-w-full items-center gap-2 text-xs text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-accentInk transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5 shrink-0" />
          <span className="shrink-0">Continue:</span>
          <span className="truncate font-medium">{recentChat.title}</span>
          <ArrowUpRight className="w-3.5 h-3.5 shrink-0" />
        </button>
      )}

    </div>
  );
};
