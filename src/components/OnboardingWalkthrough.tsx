import React, { useState, useEffect, useCallback } from 'react';
import {
  MessageSquare,
  Bot,
  Sliders,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  X,
  Zap,
  Code,
  ShieldCheck,
  Compass,
  ArrowRight
} from 'lucide-react';
import type { PlanTier } from '../../packages/contracts/src/index';
import {
  ONBOARDING_STAGES,
  type OnboardingStage,
  getOnboardingState,
  saveOnboardingStage,
  skipOnboarding,
  finishOnboarding
} from '../utils/onboarding';

export interface OnboardingWalkthroughProps {
  isOpen: boolean;
  onClose: () => void;
  userId?: string | null;
  userTier?: PlanTier;
  onOpenPlanSettings?: () => void;
  onSwitchWorkspaceMode?: (mode: 'chat' | 'agent') => void;
  onOpenProjects?: () => void;
}

export const OnboardingWalkthrough: React.FC<OnboardingWalkthroughProps> = ({
  isOpen,
  onClose,
  userId,
  userTier = 'free',
  onOpenPlanSettings,
  onSwitchWorkspaceMode: _onSwitchWorkspaceMode,
  onOpenProjects: _onOpenProjects
}) => {
  const [stageIndex, setStageIndex] = useState<number>(0);

  const handleSkip = useCallback(() => {
    skipOnboarding(userId);
    onClose();
  }, [userId, onClose]);

  const handleFinish = useCallback(() => {
    finishOnboarding(userId);
    onClose();
  }, [userId, onClose]);

  // Restore saved stage on open
  useEffect(() => {
    if (isOpen) {
      const saved = getOnboardingState(userId);
      const idx = ONBOARDING_STAGES.indexOf(saved.currentStage);
      setStageIndex(idx >= 0 ? idx : 0);
    }
  }, [isOpen, userId]);

  // Handle ESC key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleSkip();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleSkip]);

  const currentStage: OnboardingStage = ONBOARDING_STAGES[stageIndex] || 'intro';

  const handleNext = () => {
    if (stageIndex < ONBOARDING_STAGES.length - 1) {
      const nextIdx = stageIndex + 1;
      const nextStage = ONBOARDING_STAGES[nextIdx];
      setStageIndex(nextIdx);
      saveOnboardingStage(nextStage, userId);
    }
  };

  const handleBack = () => {
    if (stageIndex > 0) {
      const prevIdx = stageIndex - 1;
      const prevStage = ONBOARDING_STAGES[prevIdx];
      setStageIndex(prevIdx);
      saveOnboardingStage(prevStage, userId);
    }
  };

  const jumpToStage = (idx: number) => {
    if (idx >= 0 && idx < ONBOARDING_STAGES.length) {
      setStageIndex(idx);
      saveOnboardingStage(ONBOARDING_STAGES[idx], userId);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="onboarding-walkthrough"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/65 backdrop-blur-md animate-in fade-in duration-200"
    >
      <div
        className="w-full max-w-2xl flex flex-col rounded-2xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-white/10 shadow-lg overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Top Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-100 dark:border-white/10 bg-stone-50/50 dark:bg-white/[0.02]">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-aira-blue/10 dark:bg-cyan-500/10 flex items-center justify-center text-aira-blue dark:text-cyan-400">
              <Compass className="w-4 h-4" />
            </div>
            <div>
              <span className="text-xs font-semibold text-aira-blue dark:text-cyan-400">
                AIRA Tour
              </span>
              <span className="text-xs text-stone-400 dark:text-stone-500 ml-2">
                Step {stageIndex + 1} of {ONBOARDING_STAGES.length}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="onboarding-skip-btn"
              onClick={handleSkip}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-white/10 transition-colors"
            >
              Skip Tour
            </button>
            <button
              type="button"
              onClick={handleSkip}
              aria-label="Close Tour"
              className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Stage Content */}
        <div
          data-testid={`onboarding-stage-${currentStage}`}
          className="flex-1 p-8 space-y-6 overflow-y-auto max-h-[60vh]"
        >
          {/* Stage 1: Intro */}
          {currentStage === 'intro' && (
            <div className="space-y-4 animate-in fade-in duration-300">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-aira-blue/20 to-cyan-500/20 text-aira-blue dark:text-cyan-400 flex items-center justify-center shadow-inner">
                <Compass className="w-7 h-7" />
              </div>
              <div>
                <h3 className="text-2xl font-bold text-stone-900 dark:text-white">
                  Welcome to AIRA
                </h3>
                <p className="text-sm font-medium text-stone-500 dark:text-stone-400 mt-1">
                  Autonomous Agent Workspace and Multi-Model Intelligence
                </p>
              </div>
              <p className="text-sm text-stone-600 dark:text-stone-300 leading-relaxed">
                AIRA combines multi-model conversational intelligence with autonomous agent execution, persistent memory, and live interactive artifact rendering. Let’s take a quick 1-minute walkthrough to help you get the most out of your workspace.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                <div className="p-3.5 rounded-xl border border-stone-200/80 dark:border-white/10 bg-stone-50/50 dark:bg-white/[0.02]">
                  <div className="font-semibold text-xs text-stone-900 dark:text-white flex items-center gap-1.5">
                    <MessageSquare className="w-3.5 h-3.5 text-aira-blue" />
                    Conversational Chat
                  </div>
                  <div className="text-xs text-stone-500 dark:text-stone-400 mt-1">
                    Direct answers, deep reasoning, and collaborative writing.
                  </div>
                </div>
                <div className="p-3.5 rounded-xl border border-stone-200/80 dark:border-white/10 bg-stone-50/50 dark:bg-white/[0.02]">
                  <div className="font-semibold text-xs text-stone-900 dark:text-white flex items-center gap-1.5">
                    <Bot className="w-3.5 h-3.5 text-cyan-500" />
                    Autonomous Agent
                  </div>
                  <div className="text-xs text-stone-500 dark:text-stone-400 mt-1">
                    Multi-step plans, tool executions, and file sandboxes.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Stage 2: Chat & Reasoning */}
          {currentStage === 'chat_reasoning' && (
            <div className="space-y-4 animate-in fade-in duration-300">
              <div className="w-14 h-14 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center shadow-inner">
                <Zap className="w-7 h-7" />
              </div>
              <div>
                <h3 className="text-2xl font-bold text-stone-900 dark:text-white">
                  Conversational Intelligence & Reasoning
                </h3>
                <p className="text-sm font-medium text-stone-500 dark:text-stone-400 mt-1">
                  Adaptive model routing with thinking tokens
                </p>
              </div>
              <p className="text-sm text-stone-600 dark:text-stone-300 leading-relaxed">
                Seamlessly toggle between ultra-fast inference (Groq LPU with Gemini failover) for everyday tasks and deep reasoning models (NVIDIA Nemotron 70B on NVIDIA NIM) for architectural analysis, complex coding, and structured problem-solving.
              </p>
              <ul className="space-y-2.5 pt-2">
                <li className="flex items-start gap-2.5 text-xs text-stone-700 dark:text-stone-300">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  <span>
                    <strong>Output & Reasoning Ceiling:</strong> Configure up to 8,192 output tokens in Settings (applied via runtime generation caps or provider-native effort where supported).
                  </span>
                </li>
                <li className="flex items-start gap-2.5 text-xs text-stone-700 dark:text-stone-300">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  <span>
                    <strong>Multi-Provider Routing:</strong> Switch models anytime via the model selector in the chat toolbar.
                  </span>
                </li>
              </ul>
            </div>
          )}

          {/* Stage 3: Agent Mode */}
          {currentStage === 'agent_mode' && (
            <div className="space-y-4 animate-in fade-in duration-300">
              <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center shadow-inner">
                <Bot className="w-7 h-7" />
              </div>
              <div>
                <h3 className="text-2xl font-bold text-stone-900 dark:text-white">
                  Autonomous Agent Missions
                </h3>
                <p className="text-sm font-medium text-stone-500 dark:text-stone-400 mt-1">
                  Multi-step planning, tool runtime & sandbox execution
                </p>
              </div>
              <p className="text-sm text-stone-600 dark:text-stone-300 leading-relaxed">
                When a task requires real actions (such as web research, Python calculations, creating multi-file projects, or automated testing), switch to Agent Mode. AIRA breaks down your prompt into explicit waves and executes safely.
              </p>
              <div className="p-4 rounded-xl bg-stone-50 dark:bg-white/[0.03] border border-stone-200/80 dark:border-white/5 space-y-2">
                <div className="flex items-center gap-2 text-xs font-bold text-stone-800 dark:text-stone-200">
                  <ShieldCheck className="w-4 h-4 text-amber-500" />
                  Human-in-the-Loop Safety Approval
                </div>
                <p className="text-xs text-stone-600 dark:text-stone-400">
                  High-risk operations (such as file modifications or external communications) will prompt you for explicit one-click approval before execution.
                </p>
              </div>
            </div>
          )}

          {/* Stage 4: Projects & Artifacts */}
          {currentStage === 'projects_artifacts' && (
            <div className="space-y-4 animate-in fade-in duration-300">
              <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 text-cyan-500 flex items-center justify-center shadow-inner">
                <Code className="w-7 h-7" />
              </div>
              <div>
                <h3 className="text-2xl font-bold text-stone-900 dark:text-white">
                  Projects & Artifact Studio
                </h3>
                <p className="text-sm font-medium text-stone-500 dark:text-stone-400 mt-1">
                  Durable knowledge grounding & live preview rendering
                </p>
              </div>
              <p className="text-sm text-stone-600 dark:text-stone-300 leading-relaxed">
                Create dedicated Projects to ground conversations in custom documents, architecture specs, and style rules. Code snippets, React components, and diagrams render live side-by-side in Artifact Studio.
              </p>
              <ul className="space-y-2.5 pt-2">
                <li className="flex items-start gap-2.5 text-xs text-stone-700 dark:text-stone-300">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  <span>
                    <strong>Live React & HTML Previews:</strong> Run interactive frontends directly in sandboxed iframes.
                  </span>
                </li>
                <li className="flex items-start gap-2.5 text-xs text-stone-700 dark:text-stone-300">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  <span>
                    <strong>Mermaid & SVG Rendering:</strong> Generate diagrams and charts with instant vector visualizers.
                  </span>
                </li>
              </ul>
            </div>
          )}

          {/* Stage 5: Plans & Personalization */}
          {currentStage === 'plans' && (
            <div className="space-y-4 animate-in fade-in duration-300">
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center shadow-inner">
                <Sliders className="w-7 h-7" />
              </div>
              <div>
                <h3 className="text-2xl font-bold text-stone-900 dark:text-white">
                  Plans & Personalization
                </h3>
                <p className="text-sm font-medium text-stone-500 dark:text-stone-400 mt-1">
                  Transparent allowances & custom directives
                </p>
              </div>
              <p className="text-sm text-stone-600 dark:text-stone-300 leading-relaxed">
                AIRA features a 4-tier entitlement system (Guest, Free, Plus, and Pro). You can monitor your daily chat quota, reasoning boosts, and credits anytime in Account Settings under "My Plan & Usage".
              </p>
              <div className="p-4 rounded-xl bg-stone-50 dark:bg-white/[0.03] border border-stone-200/80 dark:border-white/5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-stone-800 dark:text-stone-200">
                    Your Current Plan: <span className="capitalize text-aira-blue dark:text-cyan-400">{userTier}</span>
                  </span>
                  {onOpenPlanSettings && (
                    <button
                      type="button"
                      onClick={() => {
                        handleFinish();
                        onOpenPlanSettings();
                      }}
                      className="text-xs font-semibold text-aira-blue dark:text-cyan-400 hover:underline"
                    >
                      View Usage Meters
                    </button>
                  )}
                </div>
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  You can restart this walkthrough anytime from the Settings modal or the Account dropdown.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Bottom Navigation Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-stone-100 dark:border-white/10 bg-stone-50/50 dark:bg-white/[0.02]">
          {/* Back Button */}
          <button
            type="button"
            data-testid="onboarding-back-btn"
            disabled={stageIndex === 0}
            onClick={handleBack}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold transition-colors duration-150 ${
              stageIndex === 0
                ? 'opacity-40 cursor-not-allowed text-stone-400 dark:text-stone-600'
                : 'text-stone-700 dark:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-white/10'
            }`}
          >
            <ChevronLeft className="w-4 h-4" />
            <span>Back</span>
          </button>

          {/* Progress Dots */}
          <div
            data-testid="onboarding-progress-dots"
            className="flex items-center gap-2"
          >
            {ONBOARDING_STAGES.map((st, idx) => (
              <button
                key={st}
                type="button"
                data-testid={`onboarding-dot-${st}`}
                onClick={() => jumpToStage(idx)}
                aria-label={`Jump to stage ${idx + 1}`}
                className={`transition-colors duration-150 rounded-full ${
                  idx === stageIndex
                    ? 'w-6 h-2 bg-aira-blue dark:bg-cyan-400'
                    : idx < stageIndex
                    ? 'w-2 h-2 bg-emerald-500'
                    : 'w-2 h-2 bg-stone-300 dark:bg-white/20 hover:bg-stone-400'
                }`}
              />
            ))}
          </div>

          {/* Next / Finish Button */}
          {stageIndex < ONBOARDING_STAGES.length - 1 ? (
            <button
              type="button"
              data-testid="onboarding-next-btn"
              onClick={handleNext}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl text-xs font-bold text-white bg-aira-blue hover:bg-aira-blue/90 shadow-sm transition-colors duration-150"
            >
              <span>Next</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              data-testid="onboarding-finish-btn"
              onClick={handleFinish}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 shadow-sm transition-colors duration-150"
            >
              <span>Get Started</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
