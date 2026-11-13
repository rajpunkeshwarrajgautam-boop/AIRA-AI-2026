import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Zap,
  Shield,
  Bot,
  Terminal,
  Globe,
  Clock,
  ArrowRight,
  X,
  CheckCircle2,
  Info,
  Lock,
} from 'lucide-react';
import type { PlanTier } from '../types/commercial-types';
import { COMMERCIAL_PLANS } from '../types/commercial-types';

export type UpgradeTrigger =
  | 'guest_limit'
  | 'guest_chat_limit'
  | 'agent_requires_account'
  | 'model_requires_account'
  | 'flagship_model'
  | 'free_to_plus_model'
  | 'pro_model'
  | 'free_to_pro_model'
  | 'plus_to_pro_model'
  | 'agent_mode'
  | 'agent'
  | 'free_to_plus_agent'
  | 'autonomous_agents'
  | 'autonomous_agent'
  | 'pro_tools_agent'
  | 'plus_to_pro_tool'
  | 'pro_tools_sandbox'
  | 'pro_tools_browser'
  | 'python_sandbox'
  | 'browser_tools'
  | 'quota_exhausted'
  | 'quota_exhaustion'
  | string;

export interface UpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  trigger?: UpgradeTrigger | null;
  currentTier?: PlanTier;
  onUpgrade?: (targetTier: PlanTier) => void;
  onOpenAuth?: () => void;
  onOpenPlanSettings?: () => void;
  onOpenPricing?: () => void;
}

interface ModalConfig {
  title: string;
  subtitle: string;
  description: string;
  recommendedTier: PlanTier;
  ctaText: string;
  features: string[];
  showResetTimer: boolean;
  upgradeOptions: PlanTier[];
}

export function getUpgradeModalConfig(trigger: UpgradeTrigger | null | undefined): ModalConfig {
  const norm = (trigger || '').toLowerCase();

  if (norm === 'agent_requires_account' || norm === 'guest_agent_requires_account') {
    return {
      title: 'Sign In to Access Agent Workspace',
      subtitle: 'Autonomous agents and multi-step missions require an account.',
      description: 'Create a free account to unlock conversation workspaces, memory records, and explore agent capabilities. Upgrade to Plus to run autonomous execution missions.',
      recommendedTier: 'free',
      ctaText: 'Sign In / Create Account',
      features: [
        'Persistent account workspaces & conversation history',
        'Explore autonomous agent planning & tools',
        'Upgrade to Plus or Pro for autonomous multi-step execution',
        '15 daily standard chats & memory records',
      ],
      showResetTimer: false,
      upgradeOptions: ['free', 'plus', 'pro'],
    };
  }

  if (norm === 'model_requires_account' || norm === 'guest_model_requires_account') {
    return {
      title: 'Sign In to Access AIRA Auto',
      subtitle: 'Dynamic multi-model routing requires a registered account.',
      description: 'Create a free account to unlock AIRA Auto dynamic routing, persistent chats, and project workspaces.',
      recommendedTier: 'free',
      ctaText: 'Sign In / Sign Up Free',
      features: [
        'AIRA Auto dynamic model routing',
        '15 standard chats daily',
        'Persistent multi-session conversation history',
        '3 Project workspaces',
      ],
      showResetTimer: false,
      upgradeOptions: ['free', 'plus', 'pro'],
    };
  }

  if (norm === 'guest_limit' || norm === 'guest_chat_limit') {
    return {
      title: 'Sign In to Keep Chatting',
      subtitle: 'Guest session allowance completed.',
      description: 'Create a free account to keep your full conversation history, project workspaces, and receive 15 standard chats every day.',
      recommendedTier: 'free',
      ctaText: 'Sign In / Sign Up Free',
      features: [
        '15 standard chats daily (resets at 00:00 UTC)',
        'Persistent multi-session conversation history',
        '3 Project workspaces with knowledge documents',
        '50 Agent Memory records with privacy scrubbing',
        '5 Complimentary Auto reasoning boosts monthly',
      ],
      showResetTimer: false,
      upgradeOptions: ['free', 'plus', 'pro'],
    };
  }

  if (
    norm === 'pro_model' ||
    norm === 'free_to_pro_model' ||
    norm === 'plus_to_pro_model' ||
    norm === 'pro_only_model' ||
    norm === 'aira-deep' ||
    norm === 'claude-3-opus'
  ) {
    return {
      title: 'Unlock AIRA Deep & Pro Intelligence',
      subtitle: 'AIRA Deep and flagship frontier reasoning require AIRA Pro.',
      description: 'Upgrade to AIRA Pro for 150 daily chats, 7,500 monthly credits, 200 reasoning boosts, isolated Python sandboxes, and headless browser automation.',
      recommendedTier: 'pro',
      ctaText: 'Upgrade to Pro',
      features: [
        'AIRA Deep frontier model access',
        '200 Complimentary Reasoning Boosts & Extended Thinking',
        '150 Standard Chats / Day with 7,500 monthly credits',
        'Isolated Python Sandbox code execution',
        'Headless web browser automation tools',
        '2 Concurrent inference streams',
      ],
      showResetTimer: false,
      upgradeOptions: ['pro'],
    };
  }

  if (norm === 'flagship_model' || norm === 'free_to_plus_model') {
    return {
      title: 'Unlock AIRA Plus & Expanded Models',
      subtitle: 'High-throughput models and extended daily compute require AIRA Plus or Pro.',
      description: 'Upgrade to AIRA Plus for 50 chats per day, AIRA Pro model quality, reasoning controls, Vision Studio, and 3,000 monthly credits.',
      recommendedTier: 'plus',
      ctaText: 'Upgrade to Plus',
      features: [
        '50 Chats/Day with 3,000 monthly credits',
        'AIRA Pro model quality & reasoning controls',
        'Experimental NVIDIA Nemotron 70B access',
        'AIRA Vision Studio (Generate & Edit)',
        '10 Projects & 250 Memories',
      ],
      showResetTimer: false,
      upgradeOptions: ['plus', 'pro'],
    };
  }

  if (
    norm === 'agent_mode' ||
    norm === 'agent' ||
    norm === 'free_to_plus_agent' ||
    norm === 'autonomous_agents' ||
    norm === 'autonomous_agent'
  ) {
    return {
      title: 'Unlock Autonomous Agent Missions with Plus',
      subtitle: 'Multi-step goal execution and workflow automation are available on AIRA Plus.',
      description: 'Upgrade to AIRA Plus to run autonomous agent missions, save up to 3 custom agents, and enjoy 50 daily chats with verified reasoning.',
      recommendedTier: 'plus',
      ctaText: 'Upgrade to Plus',
      features: [
        'Autonomous multi-step agent execution',
        '3 Saved custom agent definitions',
        '50 Standard Chats / Day',
        '3,000 Monthly Premium Credits',
        'AIRA Vision Studio (Generate & Edit)',
        '10 Project workspaces & 250 Memories',
      ],
      showResetTimer: false,
      upgradeOptions: ['plus', 'pro'],
    };
  }

  if (
    norm === 'pro_tools_sandbox' ||
    norm === 'pro_tools_browser' ||
    norm === 'plus_to_pro_tool' ||
    norm === 'python_sandbox' ||
    norm === 'browser_tools' ||
    norm === 'pro_tools_agent'
  ) {
    return {
      title: 'Execute with Live Sandboxes & Browser Tools',
      subtitle: 'Isolated Python code execution and web browser automation require AIRA Pro.',
      description: 'AIRA Pro provides isolated Python sandbox runtimes, headless browser tools, up to 20 saved agents, 150 daily chats, and 2 concurrent inference streams.',
      recommendedTier: 'pro',
      ctaText: 'Upgrade to Pro',
      features: [
        'Isolated Python sandbox code execution',
        'Headless web browser automation tools',
        '20 Saved custom agent definitions',
        '150 Standard Chats / Day',
        '7,500 Monthly Premium Credits',
        '200 Complimentary Reasoning Boosts',
        '2 Concurrent inference streams',
        'Unlimited Projects & Memories',
      ],
      showResetTimer: false,
      upgradeOptions: ['pro'],
    };
  }

  if (norm === 'quota_exhausted' || norm === 'quota_exhaustion') {
    return {
      title: 'Daily Chat Limit Reached',
      subtitle: 'You have utilized all standard chats for today.',
      description: 'Your daily allowance resets tonight at 00:00 UTC. Upgrade your plan to immediately unlock expanded quotas and keep working without interruption.',
      recommendedTier: 'plus',
      ctaText: 'Upgrade Plan',
      features: [
        'Expanded daily chat capacity (50 for Plus, 150 for Pro)',
        'Dedicated monthly credit wallet',
        'Reasoning boost allowances',
        'Higher concurrent inference throughput',
      ],
      showResetTimer: true,
      upgradeOptions: ['plus', 'pro'],
    };
  }

  // Graceful fallback for unknown trigger identifiers
  return {
    title: 'Upgrade Your AIRA Plan',
    subtitle: 'Expand your intelligence, reasoning, and tool limits.',
    description: 'Choose the commercial tier that matches your engineering velocity with transparent compute allowances.',
    recommendedTier: 'plus',
    ctaText: 'View Plans',
    features: [
      '50 to 150 standard chats per day',
      'Reasoning boosts and flagship models',
      'Autonomous agent execution & tool runtime',
    ],
    showResetTimer: false,
    upgradeOptions: ['plus', 'pro'],
  };
}

function calculateCountdownToUtcMidnight(): string {
  const now = new Date();
  const midnightUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  const diffMs = midnightUtc.getTime() - now.getTime();
  if (diffMs <= 0) return '0h 0m';
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
}

export const UpgradeModal: React.FC<UpgradeModalProps> = ({
  isOpen,
  onClose,
  trigger,
  currentTier = 'free',
  onUpgrade,
  onOpenAuth,
  onOpenPlanSettings,
  onOpenPricing,
}) => {
  const config = useMemo(() => getUpgradeModalConfig(trigger), [trigger]);
  const [countdown, setCountdown] = useState(calculateCountdownToUtcMidnight);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setNotice(null);
    const interval = setInterval(() => {
      setCountdown(calculateCountdownToUtcMidnight());
    }, 30000);
    return () => clearInterval(interval);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handlePrimaryAction = () => {
    if (config.recommendedTier === 'free' && onOpenAuth) {
      onClose();
      onOpenAuth();
      return;
    }

    if (onUpgrade) {
      onUpgrade(config.recommendedTier);
      setNotice('Paid checkout is in preview. Commercial checkout is isolated.');
      return;
    }

    if (onOpenPlanSettings) {
      onClose();
      onOpenPlanSettings();
      return;
    }

    if (onOpenPricing) {
      onClose();
      onOpenPricing();
      return;
    }

    setNotice('Paid checkout is in preview. Commercial checkout is isolated.');
  };

  const planDef = COMMERCIAL_PLANS[config.recommendedTier] || COMMERCIAL_PLANS.plus;

  return (
    <AnimatePresence>
      <div
        data-testid="upgrade-modal-backdrop"
        className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6 bg-stone-900/60 dark:bg-black/75 backdrop-blur-md select-none overflow-y-auto"
        onClick={onClose}
      >
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="upgrade-modal-title"
          data-testid="upgrade-modal"
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ type: 'spring', stiffness: 360, damping: 28 }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-[358px] sm:max-w-lg rounded-2xl sm:rounded-[1.75rem] border border-claude-border-light dark:border-white/10 bg-claude-surface-light dark:bg-stone-900 shadow-lg overflow-hidden flex flex-col my-auto text-claude-text-light dark:text-white"
        >
          {/* Header Banner */}
          <div className="relative px-5 sm:px-6 pt-5 pb-4 border-b border-claude-border-light/80 dark:border-white/10 bg-gradient-to-br from-claude-terracotta/10 via-transparent to-transparent">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-claude-terracotta text-white shadow-sm shrink-0">
                  {config.recommendedTier === 'pro' ? <Zap className="w-4 h-4" /> : config.recommendedTier === 'plus' ? <Bot className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
                </div>
                <div>
                  <h3 id="upgrade-modal-title" className="text-base sm:text-lg font-bold tracking-tight text-claude-text-light dark:text-white flex items-center gap-2">
                    <span>{config.title}</span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-claude-terracotta/15 text-claude-accentInk text-xs font-semibold">
                      Target: {planDef.name}
                    </span>
                  </h3>
                </div>
              </div>

              <button
                type="button"
                data-testid="upgrade-modal-close"
                onClick={onClose}
                aria-label="Close upgrade dialog"
                className="p-1.5 rounded-xl text-claude-muted-light dark:text-stone-400 hover:text-claude-text-light dark:hover:text-white hover:bg-claude-surface2-light dark:hover:bg-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-claude-muted-light dark:text-stone-400 mt-2 leading-relaxed">
              {config.subtitle}
            </p>
          </div>

          {/* Reset Timer Callout (when applicable) */}
          {config.showResetTimer && (
            <div className="mx-5 sm:mx-6 mt-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300 text-xs flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 shrink-0 text-amber-500" />
                <span>Daily allowance resets in:</span>
              </div>
              <span className="font-medium font-bold"><span className="font-mono">{countdown}</span> at <span className="font-mono">00:00</span> UTC</span>
            </div>
          )}

          {/* Content Body */}
          <div className="p-5 sm:p-6 space-y-4 text-xs">
            <p className="text-claude-muted-light dark:text-stone-300 leading-relaxed font-normal">
              {config.description}
            </p>

            {/* Feature Highlights */}
            <div className="space-y-2 pt-1">
              <div className="text-xs font-semibold text-claude-muted-light dark:text-stone-400">
                Unlocked on {planDef.name}:
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {config.features.map((feat, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-claude-text-light dark:text-stone-200">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <span>{feat}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Notice message if triggered */}
            {notice && (
              <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-700 dark:text-blue-300 text-[11px] flex items-center gap-2">
                <Info className="w-3.5 h-3.5 shrink-0" />
                <span>{notice}</span>
              </div>
            )}

            {/* Isolated Sandbox Notice */}
            <div className="p-2.5 rounded-xl bg-claude-surface2-light dark:bg-white/5 border border-claude-border-light/60 dark:border-white/5 text-[10px] text-claude-muted-light dark:text-stone-400 flex items-center gap-2">
              <Shield className="w-3.5 h-3.5 text-claude-accentInk shrink-0" />
              <span>Paid checkout is currently in preview mode. Commercial activation is isolated.</span>
            </div>
          </div>

          {/* Actions Footer */}
          <div className="p-4 sm:p-6 pt-2 border-t border-claude-border-light/80 dark:border-white/10 flex flex-col sm:flex-row items-center justify-between gap-2.5 bg-claude-surface2-light/40 dark:bg-white/[0.02]">
            <button
              type="button"
              onClick={() => {
                onClose();
                if (onOpenPlanSettings) {
                  onOpenPlanSettings();
                } else if (onOpenPricing) {
                  onOpenPricing();
                }
              }}
              className="w-full sm:w-auto px-3.5 py-2 rounded-xl text-xs font-semibold text-claude-muted-light dark:text-stone-400 hover:text-claude-text-light dark:hover:text-white transition-colors text-center order-2 sm:order-1"
            >
              Compare All Plans
            </button>

            <motion.button
              type="button"
              data-testid="upgrade-modal-cta"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={handlePrimaryAction}
              className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-claude-terracotta hover:bg-claude-terracotta-hover text-white text-xs font-bold transition-colors duration-150 shadow-md flex items-center justify-center gap-2 order-1 sm:order-2"
            >
              <span>{config.ctaText}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </motion.button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
