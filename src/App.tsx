import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { PanelLeft, Layers, Bookmark, Share2, Check, FolderGit2, Bot, MessageSquareText } from 'lucide-react';
import type { Conversation, Message, Artifact, Attachment, Project, AppSettings, WorkspaceMode } from './types';
import {
  loadConversations, saveConversations, saveActiveChatId,
  getSessionActiveChatId, setSessionActiveChatId,
  loadProjects, saveProjects, loadSettings, saveSettings, clearAccountSettings, INITIAL_CONVERSATION,
  hydrateStorageFromIndexedDb, hydrateProjectsFromIndexedDb, hydrateSettingsFromIndexedDb
} from './utils/storage';
import { streamAIResponse } from './utils/aiEngine';
import { appendAgentTimelineEvent } from './utils/agentTimeline';
import { createArtifactRepairPrompt } from './utils/artifactRuntimeError';
import { reconcileArtifactRevision } from './utils/artifactRevisions';
import { retrieveRelevantSubgraph } from './utils/knowledgeGraph';
import { Sidebar } from './components/Sidebar';
import { ChatMessage } from './components/ChatMessage';
import { ChatInput } from './components/ChatInput';
import { GreetingScreen } from './components/GreetingScreen';
import { ModelSelector } from './components/ModelSelector';
import { AiraMark } from './components/AiraMark';
import { CommandPalette } from './components/CommandPalette';
import { ConversationSearchOverlay } from './components/ConversationSearchOverlay';
import { InlineToast } from './components/InlineToast';
import { ExecutionApprovalBanner, type PendingToolApproval } from './components/ExecutionApprovalBanner';
import { backfillConversationsBestEffort, deleteConversationFromServer, fetchAllConversationsFromServer, fetchConversationFromServer, syncConversationToServer } from './utils/conversationSearch';
import { useAnimatedFavicon } from './utils/animatedFavicon';
import { detectCapabilityIntent, executeVisionGeneration, createBackendAutomation, getVisionTariff } from './utils/capabilityDispatcher';
// Unified Contextual Workspace presentation architecture
import { AdaptiveStudioEmptyState } from './components/AdaptiveStudioEmptyState';
import type { AgentExecutionGraph } from './types/executionGraph';
import { applyExecutionGraphEvent } from './utils/executionGraphEngine';
import './styles/adaptiveStudio.css';

// Keep the verified legacy UI as the default. The opt-in shell only changes presentation.
const ADAPTIVE_STUDIO_PREVIEW = import.meta.env.VITE_ADAPTIVE_STUDIO_PREVIEW === 'true';

// Lazy-loaded heavy auxiliary surfaces to optimize FCP and TTI
const ArtifactStudio = React.lazy(() => import('./components/ArtifactStudio').then(m => ({ default: m.ArtifactStudio })));
const UnifiedWorkspace = React.lazy(() => import('./components/UnifiedWorkspace').then(m => ({ default: m.UnifiedWorkspace })));
const ProjectsModal = React.lazy(() => import('./components/ProjectsModal').then(m => ({ default: m.ProjectsModal })));
const SettingsModal = React.lazy(() => import('./components/SettingsModal').then(m => ({ default: m.SettingsModal })));
import { MemoryVaultModal } from './components/MemoryVaultModal';
import { agentMemory } from './utils/agentMemoryEngine';
import { AuthModal } from './components/AuthModal';
import { PricingModal } from './components/PricingModal';
import { VisionStudioModal } from './components/VisionStudioModal';
import { AccountBillingModal } from './components/AccountBillingModal';
import { HelpCenterModal } from './components/HelpCenterModal';
import { PrivacyCenterModal } from './components/PrivacyCenterModal';
import { ReleaseNotesModal } from './components/ReleaseNotesModal';
import { DownloadAppsModal } from './components/DownloadAppsModal';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal';
import { LegalViewerModal } from './components/LegalViewerModal';
import { ReportBugModal } from './components/ReportBugModal';
import { UpgradeModal } from './components/UpgradeModal';
import { MotionStudioModal } from './components/MotionStudioModal';
import { FeatureFlagProvider } from './lib/featureFlags';
import { WhatsNewAnnouncementModal } from './components/WhatsNewAnnouncementModal';
import { OnboardingWalkthrough } from './components/OnboardingWalkthrough';
import { FeatureDiscoveryCard } from './components/FeatureDiscoveryCard';
import {
  shouldShowFirstViewPopup,
  getUnreadAnnouncementCount
} from './utils/announcements';
import {
  getOnboardingState,
  restartOnboarding,
  fetchOnboardingFromServer
} from './utils/onboarding';
import {
  type FeatureGuidanceItem,
  getTierTransitionGuidance,
  dismissFeatureGuidance
} from './utils/featureDiscovery';
import type { Announcement } from '../packages/contracts/src/index';
import type { PlanTier } from './types/commercial-types';
import { parseBillingSummary } from './lib/accountBillingTruth';
import { neonAuth, authenticatedApiFetch } from './lib/neonAuth';
import { dispatchRunApproval } from './utils/approvalDispatch';

const MODE_CONTEXT: Record<WorkspaceMode, string> = {
  chat: '',
  agent: 'Work in agent-mission mode. Plan and execute multi-step objectives with tool use, verification checkpoints, file creation, sandbox execution, and deliverables.',
};

function App() {
  useAnimatedFavicon();
  const [currentUserId, setCurrentUserId] = useState<string | null>(() => neonAuth.getCurrentUser()?.id || null);
  const activeUserIdRef = useRef<string | null>(currentUserId);
  activeUserIdRef.current = currentUserId;
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const user = neonAuth.getCurrentUser();
    return loadConversations(user?.id);
  });
  // Root visits without an active tab session start on a transient welcome draft.
  // When an active session exists (in-tab session or ?c= param), restore it on reload.
  // Capture initial ?c= or in-tab active chat ID before async BFF session/server hydration runs.
  const pendingSessionChatIdRef = useRef<string | null>(getSessionActiveChatId());
  const [activeChatId, setActiveChatId] = useState<string>(() => {
    const sessionChatId = pendingSessionChatIdRef.current;
    if (sessionChatId) {
      const user = neonAuth.getCurrentUser();
      const stored = loadConversations(user?.id);
      if (stored.some(c => c.id === sessionChatId)) {
        return sessionChatId;
      }
    }
    return '';
  });
  useEffect(() => {
    let isCancelled = false;
    void hydrateStorageFromIndexedDb(currentUserId || undefined).then(loaded => {
      if (!isCancelled && loaded && loaded.length > 0) {
        setConversations(prev => {
          if (prev.length === 1 && prev[0].id === 'welcome-to-aira' && prev[0].messages.length === 0) {
            return loaded;
          }
          return prev;
        });
      }
    });
    void hydrateProjectsFromIndexedDb(currentUserId || undefined).then(loaded => {
      if (!isCancelled && projectsOwnerRef.current === (currentUserId || null)) {
        if (loaded && loaded.length > 0) {
          setProjects(prev => (prev.length === 0 ? loaded : prev));
        }
      }
    });
    const currentUser = neonAuth.getCurrentUser();
    const idbIdentity = (currentUser && currentUser.id === currentUserId)
      ? { userId: currentUser.id, email: currentUser.email }
      : (currentUserId ? { userId: currentUserId } : undefined);
    void hydrateSettingsFromIndexedDb(idbIdentity).then(loadedSettings => {
      if (!isCancelled && loadedSettings && settingsOwnerRef.current === (currentUserId || null)) {
        setSettings(prev => ({
          ...loadedSettings,
          userName: prev.userName || loadedSettings.userName,
          email: prev.email || loadedSettings.email,
        }));
      }
    });
    return () => {
      isCancelled = true;
    };
  }, [currentUserId]);

  const [welcomeConversation] = useState<Conversation>(() => ({
    ...INITIAL_CONVERSATION, id: `chat-${crypto.randomUUID()}`,
    createdAt: Date.now(), updatedAt: Date.now(), messages: [],
  }));
  const [projects, setProjects] = useState<Project[]>(() => {
    const user = neonAuth.getCurrentUser();
    return loadProjects(user?.id);
  });
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(() => localStorage.getItem('aira_active_project_id_v1') || undefined);
  const [settings, setSettings] = useState<AppSettings>(() => {
    const user = neonAuth.getCurrentUser();
    return loadSettings(user ? { userId: user.id, email: user.email } : undefined);
  });
  const [workspaceMode, setWorkspaceModeState] = useState<WorkspaceMode>(() => {
    const user = neonAuth.getCurrentUser();
    const key = `aira_workspace_mode_${user?.id || 'guest'}`;
    const stored = typeof window !== 'undefined' ? localStorage.getItem(key) : null;
    return (stored === 'agent' || stored === 'chat') ? stored : 'chat';
  });

  const setWorkspaceMode = useCallback((mode: WorkspaceMode) => {
    setWorkspaceModeState(mode);
    const user = neonAuth.getCurrentUser();
    const key = `aira_workspace_mode_${user?.id || 'guest'}`;
    try {
      localStorage.setItem(key, mode);
    } catch {
      // ignore storage errors
    }
  }, []);

  // Unified contextual workspace uses coordinated isStudioOpen state
  const [repairDraft, setRepairDraft] = useState<{ id: number; text: string } | null>(null);
  const artifactRevisionsRef = useRef<Map<string, Artifact>>(new Map());
  useEffect(() => {
    // Never retain generated code from a previous principal in this session cache.
    artifactRevisionsRef.current.clear();
  }, [currentUserId]);
  const [activeAgentPrompt, setActiveAgentPrompt] = useState<string | undefined>(undefined);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const activeAssistantMsgIdRef = useRef<string | null>(null);
  const [cancelBuilderSignal, setCancelBuilderSignal] = useState(0);
  const [isBuilderBusy, setIsBuilderBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== 'undefined' ? window.innerWidth >= 1280 : true);
  const pendingAutomationIdsRef = useRef<Set<string>>(new Set());
  const [confirmingAutoId, setConfirmingAutoId] = useState<string | null>(null);
  const pendingVisionOpsRef = useRef<Set<string>>(new Set());
  const [authorizingVisionId, setAuthorizingVisionId] = useState<string | null>(null);
  const [isProjectsOpen, setIsProjectsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const [isVisionOpen, setIsVisionOpen] = useState(false);
  const [isAccountBillingOpen, setIsAccountBillingOpen] = useState(false);
  const [isMemoryVaultOpen, setIsMemoryVaultOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isConversationSearchOpen, setIsConversationSearchOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string>('general');
  const [isHelpCenterOpen, setIsHelpCenterOpen] = useState(false);
  const [isPrivacyCenterOpen, setIsPrivacyCenterOpen] = useState(false);
  const [isReleaseNotesOpen, setIsReleaseNotesOpen] = useState(false);
  const [isDownloadAppsOpen, setIsDownloadAppsOpen] = useState(false);
  const [isKeyboardShortcutsOpen, setIsKeyboardShortcutsOpen] = useState(false);
  const [isLegalViewerOpen, setIsLegalViewerOpen] = useState(false);
  const [legalViewerInitialDoc, setLegalViewerInitialDoc] = useState<'terms' | 'privacy'>('terms');
  const [isReportBugOpen, setIsReportBugOpen] = useState(false);
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const [isMotionStudioOpen, setIsMotionStudioOpen] = useState(false);
  const [upgradeModalTrigger, setUpgradeModalTrigger] = useState<string | null>(null);
  const [userTier, setUserTier] = useState<PlanTier>(() => neonAuth.getCurrentUser() ? 'free' : 'guest');

  const handleTriggerUpgrade = useCallback((trigger: string) => {
    setUpgradeModalTrigger(trigger);
    setIsUpgradeModalOpen(true);
  }, []);

  const handleOpenSettings = useCallback((tab = 'general') => {
    setSettingsInitialTab(tab);
    setIsSettingsOpen(true);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const url = new URL(window.location.href);
      const tabParam = url.searchParams.get('tab');
      const viewParam = url.searchParams.get('view');
      const hash = window.location.hash;
      if (viewParam === 'video-studio' || viewParam === 'motion-studio' || hash === '#video-studio' || hash === '#motion-studio') {
        setIsMotionStudioOpen(true);
      }
      const isSettingsPath = url.pathname.includes('/settings');
      if (isSettingsPath || tabParam) {
        const validTabs = ['general', 'plan', 'billing', 'subscription', 'usage', 'reasoning', 'memory', 'instructions', 'artifacts', 'data'];
        const targetTab = tabParam && validTabs.includes(tabParam.toLowerCase()) ? tabParam.toLowerCase() : 'general';
        handleOpenSettings(targetTab);
      }
    } catch {
      // ignore URL parsing errors
    }
  }, [handleOpenSettings]);

  useEffect(() => {
    const user = neonAuth.getCurrentUser();
    if (!user) {
      setUserTier('guest');
      return;
    }
    let active = true;
    authenticatedApiFetch('/api/billing/summary')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!active || !data) return;
        const parsed = parseBillingSummary(data, user.id);
        if (parsed?.planId) {
          setUserTier(parsed.planId);
        }
      })
      .catch(() => {
        // fallback to free
      });
    return () => { active = false; };
  }, [currentUserId]);

  // Milestone 4: Announcements, Onboarding & Feature Discovery
  const [isWhatsNewOpen, setIsWhatsNewOpen] = useState(false);
  const [focusedAnnouncement, setFocusedAnnouncement] = useState<Announcement | null>(null);
  const [unreadAnnouncementsCount, setUnreadAnnouncementsCount] = useState<number>(() =>
    getUnreadAnnouncementCount(userTier, currentUserId)
  );

  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);

  const [activeFeatureGuidance, setActiveFeatureGuidance] = useState<FeatureGuidanceItem | null>(null);
  const prevTierRef = useRef<PlanTier>(userTier);
  const lastCheckedUserIdRef = useRef<string | null | undefined>(undefined);

  // Synchronize unread announcements badge count whenever userTier or currentUserId changes
  useEffect(() => {
    setUnreadAnnouncementsCount(getUnreadAnnouncementCount(userTier, currentUserId));
  }, [userTier, currentUserId]);

  // Check first-view popup on initial mount and when user identity transitions
  useEffect(() => {
    if (lastCheckedUserIdRef.current === currentUserId) return;
    lastCheckedUserIdRef.current = currentUserId;

    // Feature announcements only automatically pop up for users who have completed or skipped onboarding
    // (A brand-new user or uninitialized session is in onboarding / exploration flow, not changelog popups)
    const obState = getOnboardingState(currentUserId);
    if (!obState.completed && !obState.skipped) {
      return;
    }

    const popup = shouldShowFirstViewPopup(userTier, currentUserId, settings.announcementsEnabled !== false);
    if (popup) {
      setFocusedAnnouncement(popup);
      setIsWhatsNewOpen(true);
    }
  }, [userTier, currentUserId, settings.announcementsEnabled]);

  // Check first-login onboarding on initial mount and auth changes
  useEffect(() => {
    // Guests or unauthenticated sessions never auto-open or leak previous account tutorials
    if (!currentUserId || currentUserId.startsWith('guest_') || userTier === 'guest') {
      setIsOnboardingOpen(false);
      return;
    }

    let cancelled = false;
    const obState = getOnboardingState(currentUserId);
    setIsOnboardingOpen(!obState.completed && !obState.skipped);

    void fetchOnboardingFromServer(currentUserId).then(remoteOb => {
      if (cancelled || activeUserIdRef.current !== currentUserId || !remoteOb) return;
      setIsOnboardingOpen(!remoteOb.completed && !remoteOb.skipped);
    });

    return () => {
      cancelled = true;
    };
  }, [currentUserId, userTier]);

  // Track tier upgrades to display feature discovery card
  useEffect(() => {
    if (prevTierRef.current !== userTier) {
      const guidanceItems = getTierTransitionGuidance(prevTierRef.current, userTier, currentUserId);
      if (guidanceItems.length > 0) {
        setActiveFeatureGuidance(guidanceItems[0]);
      }
      prevTierRef.current = userTier;
      setUnreadAnnouncementsCount(getUnreadAnnouncementCount(userTier, currentUserId));
    }
  }, [userTier, currentUserId]);

  const handleRestartOnboarding = useCallback(() => {
    restartOnboarding(currentUserId);
    setIsOnboardingOpen(true);
  }, [currentUserId]);

  const handleDismissFeatureGuidance = useCallback(() => {
    if (activeFeatureGuidance) {
      dismissFeatureGuidance(activeFeatureGuidance.feature, currentUserId);
      setActiveFeatureGuidance(null);
    }
  }, [activeFeatureGuidance, currentUserId]);

  const handleWhatsNewAction = useCallback((route: string) => {
    if (route === '#settings-billing' || route.includes('settings')) {
      handleOpenSettings('plan');
    } else if (route === '#onboarding' || route.includes('onboarding')) {
      handleRestartOnboarding();
    } else if (route.includes('agent')) {
      setWorkspaceMode('agent');
    }
  }, [handleOpenSettings, handleRestartOnboarding]);
  const [conversationSearchSeed, setConversationSearchSeed] = useState('');
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [isStudioOpen, setIsStudioOpen] = useState(false);
  const setIsAgentPanelOpen = setIsStudioOpen;
  const userDismissedStudioRef = useRef(false);

useEffect(() => {
    if (!isStudioOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsAgentPanelOpen(false);
        setIsStudioOpen(false);
        userDismissedStudioRef.current = true;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isStudioOpen]);
  const [activeExecutionGraph, setActiveExecutionGraph] = useState<AgentExecutionGraph | null>(() => {
    if (typeof window !== 'undefined' && (window as any).__AIRA_PHASE3_INITIAL_GRAPH__) {
      return (window as any).__AIRA_PHASE3_INITIAL_GRAPH__;
    }
    return null;
  });
  const [isLoading, setIsLoading] = useState(false);
  const [sharedCopied, setSharedCopied] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingToolApproval | null>(null);
  const [isSubmittingApproval, setIsSubmittingApproval] = useState(false);
  const approvalSubmissionRef = useRef(false);
  const [executionStatus, setExecutionStatus] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const conversationSyncVersionsRef = useRef<Map<string, string>>(new Map());
  const initialConversationBackfillRef = useRef(false);
  const authEpochRef = useRef(0);
  const conversationsOwnerRef = useRef<string | null>(currentUserId);
  const projectsOwnerRef = useRef<string | null>(currentUserId);
  const settingsOwnerRef = useRef<string | null>(currentUserId);

  const activeConversation = useMemo(
    () => conversations.find(c => c.id === activeChatId) || welcomeConversation,
    [conversations, activeChatId, welcomeConversation]
  );


  const currentProject = useMemo(
    () => projects.find(p => p.id === activeProjectId),
    [projects, activeProjectId]
  );

  const conversationArtifacts = useMemo(() => {
    if (!activeConversation?.messages) return [];
    const list: Artifact[] = [];
    const seen = new Set<string>();
    for (const msg of activeConversation.messages) {
      if (msg.artifacts) {
        for (const art of msg.artifacts) {
          if (!seen.has(art.id)) {
            seen.add(art.id);
            list.push(art);
          }
        }
      }
    }
    return list;
  }, [activeConversation]);

  // The sidebar is a desktop rail at xl and a temporary drawer below xl.
  // Reconcile visibility when an orientation change crosses that boundary.
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1280px)');
    const onBreakpointChange = (event: MediaQueryListEvent) => setSidebarOpen(event.matches);
    desktop.addEventListener('change', onBreakpointChange);
    return () => desktop.removeEventListener('change', onBreakpointChange);
  }, []);

  // Proactively restore first-party BFF session from HttpOnly cookie on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location?.search) {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('auth_error')) {
        setIsAuthOpen(true);
      }
    }
    neonAuth.restoreSession()
      .then((restoredSession) => {
        if (!restoredSession?.user && pendingSessionChatIdRef.current) {
          const guestConvs = loadConversations();
          if (!guestConvs.some(c => c.id === pendingSessionChatIdRef.current)) {
            pendingSessionChatIdRef.current = null;
            setSessionActiveChatId(null);
          }
        }
      })
      .catch((err) => {
        console.warn('[App] First-party session restore notice:', err);
      });
  }, []);

  useEffect(() => {
    return neonAuth.onAuthStateChange(async (user) => {
      const epoch = ++authEpochRef.current;
      const nextUserId = user?.id || null;

      // Identity transition boundary: immediately isolate and purge prior account in-memory state
      if (nextUserId !== currentUserId) {
        if (activeAbortControllerRef.current) {
          activeAbortControllerRef.current.abort();
          activeAbortControllerRef.current = null;
        }
        neonAuth.abortActiveRequests();
        activeRunIdRef.current = null;
        activeAssistantMsgIdRef.current = null;
        pendingAutomationIdsRef.current.clear();
        pendingVisionOpsRef.current.clear();
        setConfirmingAutoId(null);
        setAuthorizingVisionId(null);
        setIsLoading(false);
        setExecutionStatus(null);
        setActiveAgentPrompt(undefined);
        setIsAgentPanelOpen(false);
        setIsStudioOpen(false);
        setIsOnboardingOpen(false);
        setIsWhatsNewOpen(false);
        setFocusedAnnouncement(null);
        setActiveFeatureGuidance(null);
        setPendingApproval(null);
        setActiveExecutionGraph(null);
        setRepairDraft(null);

        // Restore user-scoped workspace mode
        try {
          const modeKey = `aira_workspace_mode_${nextUserId || 'guest'}`;
          const storedMode = localStorage.getItem(modeKey);
          setWorkspaceModeState((storedMode === 'agent' || storedMode === 'chat') ? storedMode : 'chat');
        } catch {
          // ignore storage errors
        }

        setActiveProjectId(undefined);
        try {
          localStorage.removeItem('aira_active_project_id_v1');
        } catch {
          // ignore storage errors
        }

        setActiveChatId('');
        if (currentUserId !== null) {
          pendingSessionChatIdRef.current = null;
          setSessionActiveChatId(null);
        } else if (!pendingSessionChatIdRef.current) {
          setSessionActiveChatId(null);
        }
        setActiveArtifact(null);
        setHighlightedMessageId(null);
        conversationSyncVersionsRef.current.clear();
      }

      setCurrentUserId(nextUserId);

      if (user) {
        const nextOwnerSettings = loadSettings({ userId: user.id, email: user.email });
        settingsOwnerRef.current = user.id;
        setSettings({
          ...nextOwnerSettings,
          userName: nextOwnerSettings.userName || user.name || '',
          email: user.email || nextOwnerSettings.email || '',
        });

        // Immediately load cached conversations belonging to this verified user
        const cached = loadConversations(user.id);
        conversationsOwnerRef.current = user.id;
        setConversations(cached);
        const pendingIdFromCache = pendingSessionChatIdRef.current;
        if (pendingIdFromCache && cached.some(c => c.id === pendingIdFromCache)) {
          setActiveChatId(pendingIdFromCache);
        }

        // Immediately load cached projects belonging to this verified user
        const userProjects = loadProjects(user.id);
        projectsOwnerRef.current = user.id;
        setProjects(userProjects);

        // Hydrate persistent conversations from PostgreSQL server
        try {
          const serverConvs = await fetchAllConversationsFromServer();
          // Discard stale hydration response if user logged out or switched accounts while fetch was in flight
          if (authEpochRef.current !== epoch) return;

          const desiredId = pendingSessionChatIdRef.current;
          pendingSessionChatIdRef.current = null;
          if (serverConvs && serverConvs.length > 0) {
            conversationsOwnerRef.current = user.id;
            setConversations(serverConvs);
            saveConversations(serverConvs, user.id);
            setActiveChatId(prev => {
              const target = prev || desiredId || '';
              const exists = Boolean(target && serverConvs.some(c => c.id === target));
              if (!exists) {
                setSessionActiveChatId(null);
                return '';
              }
              return target;
            });
          } else if (desiredId) {
            setSessionActiveChatId(null);
          }
        } catch {
          pendingSessionChatIdRef.current = null;
          // Server fetch failed: cached local state remains active
        }
      } else {
        // Account signed out: revert to isolated guest state and clear memory
        const guestSettings = loadSettings();
        settingsOwnerRef.current = null;
        setSettings({
          ...guestSettings,
          userName: guestSettings.userName || 'Guest User',
          email: '',
        });
        conversationsOwnerRef.current = null;
        const guestConvs = loadConversations();
        setConversations(guestConvs);
        // Preserve root welcome screen contract on fresh tab; restore only if already active
        setActiveChatId(prev => (guestConvs.some(c => c.id === prev) ? prev : ''));

        // Reset projects to guest state
        projectsOwnerRef.current = null;
        setActiveProjectId(undefined);
        try {
          localStorage.removeItem('aira_active_project_id_v1');
        } catch {
          // ignore storage errors
        }
        const guestProjects = loadProjects();
        projectsOwnerRef.current = null;
        setProjects(guestProjects);
      }
    });
  }, [currentUserId]);

  useEffect(() => {
    // Only persist conversations if in-memory data strictly belongs to current active user
    if (conversationsOwnerRef.current === currentUserId) {
      saveConversations(conversations, currentUserId || undefined);
    }
  }, [conversations, currentUserId]);

  useEffect(() => {
    if (!initialConversationBackfillRef.current) {
      initialConversationBackfillRef.current = true;
      for (const conversation of conversations) {
        const stableMessages = conversation.messages.filter(message => !message.isStreaming).length;
        conversationSyncVersionsRef.current.set(
          conversation.id,
          `${conversation.updatedAt}:${stableMessages}:${conversation.title}:${Boolean(conversation.isPinned)}`
        );
      }
      const populated = conversations.filter(c => c.messages.some(m => !m.isStreaming));
      if (populated.length > 0) {
        void backfillConversationsBestEffort(populated);
      }
      return;
    }

    for (const conversation of conversations) {
      // Never persist a partially streamed assistant response into the durable
      // transcript. Existing local state remains the immediate UI source.
      if (conversation.messages.some(message => message.isStreaming)) continue;

      const stableMessages = conversation.messages.length;
      if (stableMessages === 0) continue;
      const version = `${conversation.updatedAt}:${stableMessages}:${conversation.title}:${Boolean(conversation.isPinned)}`;
      if (conversationSyncVersionsRef.current.get(conversation.id) === version) continue;

      conversationSyncVersionsRef.current.set(conversation.id, version);
      void syncConversationToServer(conversation);
    }
  }, [conversations]);

  useEffect(() => {
    if (projectsOwnerRef.current === currentUserId) {
      saveProjects(projects, currentUserId || undefined);
    }
  }, [projects, currentUserId]);
  useEffect(() => {
    if (settingsOwnerRef.current === currentUserId) {
      saveSettings(settings, currentUserId);
    }
  }, [settings, currentUserId]);
  useEffect(() => {
    if (activeChatId) {
      setSessionActiveChatId(activeChatId);
    } else if (!pendingSessionChatIdRef.current) {
      setSessionActiveChatId(null);
    }
  }, [activeChatId]);
  useEffect(() => {
    if (activeProjectId) localStorage.setItem('aira_active_project_id_v1', activeProjectId);
    else localStorage.removeItem('aira_active_project_id_v1');
  }, [activeProjectId]);

  useEffect(() => {
    const root = document.documentElement;
    const systemColor = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && systemColor.matches);
      root.classList.toggle('dark', dark);
      if (settings.aestheticPreset && settings.aestheticPreset !== 'default') root.dataset.theme = settings.aestheticPreset;
      else delete root.dataset.theme;

      if (settings.highContrast) root.classList.add('high-contrast');
      else root.classList.remove('high-contrast');

      if (settings.reducedMotion === 'always') root.classList.add('reduce-motion', 'force-reduced-motion', 'reduced-motion');
      else root.classList.remove('reduce-motion', 'force-reduced-motion', 'reduced-motion');

      if (settings.fontSize) root.dataset.fontSize = settings.fontSize;
    };
    applyTheme();
    systemColor.addEventListener('change', applyTheme);
    return () => systemColor.removeEventListener('change', applyTheme);
  }, [settings.theme, settings.aestheticPreset, settings.highContrast, settings.reducedMotion, settings.fontSize]);

  // Only scroll the conversation region; scrollIntoView can also move the
  // document/root viewport and leave a blank page after long conversations.
  useEffect(() => {
    const scrollRegion = chatScrollRef.current;
    if (!scrollRegion) return;
    // Empty conversations render the greeting, not a message transcript.
    // Scrolling those to the bottom clips the hero emblem on shorter screens.
    if (!activeConversation?.messages.length) {
      scrollRegion.scrollTo({ top: 0, behavior: 'instant' });
      return;
    }
    scrollRegion.scrollTo({ top: scrollRegion.scrollHeight, behavior: 'instant' });
  }, [activeConversation?.id, activeConversation?.messages.length]);

  const updateConversation = (id: string, updater: (c: Conversation) => Conversation) => {
    setConversations(prev => prev.map(c => c.id === id ? updater(c) : c));
  };

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToastMessage(message);
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 1800);
  }, []);

  const handleSaveArtifactToProject = useCallback((art: Artifact) => {
    if (!currentProject) {
      showToast('Select an active project first.');
      return;
    }
    showToast(`Saved "${art.title}" to ${currentProject.name}`);
  }, [currentProject, showToast]);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  const handleNewChat = useCallback(() => {
    const id = 'chat-' + Date.now();
    const next: Conversation = { id, title: 'New task', messages: [], createdAt: Date.now(), updatedAt: Date.now(), projectId: activeProjectId };
    setConversations(prev => [next, ...prev]);
    setActiveChatId(id);
    saveActiveChatId(id);
    setSessionActiveChatId(id);
    setActiveArtifact(null);
    setWorkspaceMode('chat');
  }, [activeProjectId]);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleNewChat();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        handleOpenSettings('general');
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        setSidebarOpen((prev: boolean) => !prev);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        const composer = document.querySelector('textarea') as HTMLTextAreaElement | null;
        composer?.focus();
        return;
      }
      if (e.key === 'Escape' && activeAbortControllerRef.current) {
        e.preventDefault();
        activeAbortControllerRef.current.abort();
        activeAbortControllerRef.current = null;
        return;
      }
      if (e.key === '?' && !isInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setIsKeyboardShortcutsOpen(true);
        return;
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [handleNewChat, handleOpenSettings]);

  const handleSelectChat = (id: string) => {
    setActiveChatId(id);
    saveActiveChatId(id);
    setSessionActiveChatId(id);
    setActiveArtifact(null);
  };

  const handleOpenConversationSearch = (query = '') => {
    setConversationSearchSeed(query);
    setIsConversationSearchOpen(true);
  };

  const handleSelectSearchResult = async (conversationId: string, messageId?: string) => {
    let available = conversations.some(conversation => conversation.id === conversationId);

    if (!available) {
      const hydrated = await fetchConversationFromServer(conversationId);
      if (!hydrated) {
        showToast('Conversation could not be loaded');
        return;
      }

      setConversations(prev => {
        if (prev.some(conversation => conversation.id === hydrated.id)) return prev;
        return [hydrated, ...prev];
      });
      available = true;
    }

    if (!available) return;

    setWorkspaceMode('chat');
    handleSelectChat(conversationId);

    if (!messageId) return;

    setHighlightedMessageId(messageId);
    window.setTimeout(() => {
      const scrollRegion = chatScrollRef.current;
      const target = document.getElementById(`message-${messageId}`);
      if (!scrollRegion || !target || !scrollRegion.contains(target)) return;
      const containerRect = scrollRegion.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetScrollTop = scrollRegion.scrollTop +
        targetRect.top - containerRect.top -
        (scrollRegion.clientHeight - targetRect.height) / 2;
      scrollRegion.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: 'smooth'
      });
    }, 120);
    window.setTimeout(() => setHighlightedMessageId(current => current === messageId ? null : current), 1800);
  };

  const handleDeleteChat = (id: string) => {
    if (!conversations.some(conversation => conversation.id === id)) return;
    setConversations(prev => {
      const filtered = prev.filter(c => c.id !== id);
      const next = filtered.length ? filtered : [{ ...INITIAL_CONVERSATION, id: 'chat-' + Date.now(), createdAt: Date.now(), updatedAt: Date.now() }];
      if (id === activeChatId) {
        setActiveChatId(next[0].id);
        saveActiveChatId(next[0].id);
        setSessionActiveChatId(next[0].id);
      }
      return next;
    });
    conversationSyncVersionsRef.current.delete(id);
    void deleteConversationFromServer(id);
    showToast('Conversation deleted');
  };

  const handleRenameChat = (id: string, title: string) => updateConversation(id, c => ({ ...c, title, updatedAt: Date.now() }));
  const handleToggleBookmark = (id: string) => updateConversation(id, c => ({ ...c, isPinned: !c.isPinned, updatedAt: Date.now() }));
  const handleToggleStar = handleToggleBookmark;

  const handleDuplicateChat = (id: string) => {
    const source = conversations.find(c => c.id === id);
    if (!source) return;

    const now = Date.now();
    const duplicate: Conversation = {
      ...structuredClone(source),
      id: `chat-${crypto.randomUUID()}`,
      title: `${source.title} (copy)`,
      isPinned: false,
      createdAt: now,
      updatedAt: now,
      messages: source.messages.map(message => ({
        ...structuredClone(message),
        id: `${message.role}-${crypto.randomUUID()}`,
        artifacts: message.artifacts?.map(artifact => ({ ...structuredClone(artifact), id: `artifact-${crypto.randomUUID()}` })),
        attachments: message.attachments?.map(attachment => ({ ...structuredClone(attachment), id: `attachment-${crypto.randomUUID()}` })),
      })),
    };

    setConversations(prev => [duplicate, ...prev]);
    setActiveChatId(duplicate.id);
    saveActiveChatId(duplicate.id);
    setSessionActiveChatId(duplicate.id);
    setActiveArtifact(null);
    setWorkspaceMode('chat');
    showToast('Conversation duplicated');
  };

  const shareConversation = async (conversation: Conversation): Promise<boolean> => {
    const text = conversation.messages
      .map(m => `${m.role === 'user' ? 'You' : 'Aira'}: ${m.content}`)
      .join('\n\n') || conversation.title;

    if (navigator.share) {
      try {
        await navigator.share({ title: conversation.title, text });
        return true;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return false;
      }
    }

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  const handleShareChat = async (id: string) => {
    const conversation = conversations.find(c => c.id === id);
    if (!conversation) return;
    const shared = await shareConversation(conversation);
    if (shared) showToast('Conversation shared');
  };

  const handleCancelExecution = useCallback(async () => {
    // 1. Abort active streaming fetch
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
      activeAbortControllerRef.current = null;
    }

    // 2. Stop active sandboxed builder execution in AgentContextualPanel
    setCancelBuilderSignal(prev => prev + 1);

    // 3. Notify backend run cancellation if active run ID exists
    const runId = activeRunIdRef.current;
    if (runId) {
      activeRunIdRef.current = null;
      try {
        await authenticatedApiFetch(`/api/runs/${runId}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        console.warn('[App] Backend run cancellation notice:', err);
      }
    }

    // 4. Mark active assistant message as cancelled
    const assistantId = activeAssistantMsgIdRef.current;
    if (assistantId && activeChatId) {
      updateConversation(activeChatId, c => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages.map(m => m.id === assistantId ? {
          ...m,
          content: m.content
            ? `${m.content}\n\n*[Execution cancelled by user. Transport connection aborted. Note: If backend provider processing had already begun, billing is reconciled by backend ledger rules.]*`
            : '*[Execution cancelled by user. Transport connection aborted]*',
          isStreaming: false,
          thinking: m.thinking ? { ...m.thinking, isStreaming: false } : undefined,
          visionProposal: undefined,
        } : m),
      }));
      activeAssistantMsgIdRef.current = null;
    }

    setIsLoading(false);
    setExecutionStatus(null);
    showToast('Execution cancelled');
  }, [activeChatId, showToast]);

  const handleSwitchToAgentAndReview = useCallback((prompt: string) => {
    setWorkspaceMode('agent');
    setActiveAgentPrompt(prompt);
    // Normal conversation is primary; workspace remains closed by default
    showToast('Switched to Agent Mode. Task ready in conversation.');
  }, [setWorkspaceMode, showToast]);

  const handleConfirmAutomation = useCallback(async (proposal: {
    id?: string;
    name: string;
    objective: string;
    trigger: any;
    cronExpression?: string;
    targetRunAt?: number;
    humanSchedule?: string;
    timezone?: string;
  }) => {
    if (!activeChatId) return;
    const opKey = proposal.id || `${proposal.name}_${proposal.cronExpression || proposal.targetRunAt || 'one_time'}`;
    if (pendingAutomationIdsRef.current.has(opKey)) return;
    pendingAutomationIdsRef.current.add(opKey);
    setConfirmingAutoId(opKey);
    setIsLoading(true);
    setExecutionStatus('Persisting automation to backend engine…');
    try {
      const result = await createBackendAutomation({
        name: proposal.name,
        objective: proposal.objective,
        trigger: proposal.trigger,
        cronExpression: proposal.cronExpression,
        targetRunAt: proposal.targetRunAt,
        timezone: proposal.timezone,
        clientOperationId: proposal.id,
      });
      setIsLoading(false);
      setExecutionStatus(null);

      if (result.success && result.automationId) {
        const confirmMsgId = 'assistant-' + Date.now();
        const scheduleInfo = proposal.humanSchedule ? `\n**Proposed Cadence:** ${proposal.humanSchedule}` : '';
        const tzInfo = proposal.timezone ? `\n**Timezone:** ${proposal.timezone}` : '';
        const triggerDetail = proposal.cronExpression ? ` (\`${proposal.cronExpression}\`)` : (proposal.targetRunAt ? ' (one-time)' : '');
        
        const isActuallyActive = result.enabled === true;
        const statusLabel = isActuallyActive ? 'ACTIVE' : 'INACTIVE (Draft)';
        const headerTitle = isActuallyActive ? '[Automation Confirmed & Activated]' : '[Automation Saved — Inactive Draft]';
        const noticeBody = isActuallyActive
          ? 'Your automation has been persisted to the server-authoritative engine and scheduled for autonomous execution.'
          : 'Autonomous scheduling is temporarily unavailable in this environment. Your automation has been securely saved to the database as an inactive draft and will not execute autonomously until a certified scheduler is configured.';

        const confirmationMessage: Message = {
          id: confirmMsgId,
          role: 'assistant',
          content: `${headerTitle}\n\n**Automation ID:** \`${result.automationId}\`\n**Name:** ${proposal.name}${scheduleInfo}${tzInfo}\n**Trigger:** ${proposal.trigger}${triggerDetail}\n**Status:** ${statusLabel}\n\n${noticeBody}`,
          timestamp: Date.now(),
          isStreaming: false,
        };
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: [...c.messages, confirmationMessage],
        }));
        showToast(isActuallyActive ? 'Automation activated successfully' : 'Automation saved as inactive draft');
      } else {
        showToast(result.error || 'Automation persistence failed');
      }
    } catch (err: any) {
      setIsLoading(false);
      setExecutionStatus(null);
      showToast(`Automation error: ${err.message || 'Failed to create automation'}`);
    } finally {
      pendingAutomationIdsRef.current.delete(opKey);
      setConfirmingAutoId(null);
    }
  }, [activeChatId, showToast]);

  const handleAuthorizeVision = useCallback(async (proposal: NonNullable<Message['visionProposal']>) => {
    if (!activeChatId) return;
    if (pendingVisionOpsRef.current.has(proposal.id)) return;
    pendingVisionOpsRef.current.add(proposal.id);
    setAuthorizingVisionId(proposal.id);

    const controller = new AbortController();
    activeAbortControllerRef.current = controller;
    const currentUserIdAtStart = currentUserId;
    const epochAtStart = authEpochRef.current;

    setIsLoading(true);
    setExecutionStatus('Invoking Vision Engine backend…');

    try {
      const visionRes = await executeVisionGeneration(
        proposal.prompt,
        {
          aspectRatio: proposal.options?.aspectRatio,
          quality: proposal.options?.quality,
          resolution: proposal.options?.resolution,
          numImages: proposal.options?.numImages,
          clientOperationId: proposal.id,
        },
        controller.signal
      );

      // Verify identity and transport integrity: discard stale results if user switched or operation cancelled
      if (authEpochRef.current !== epochAtStart || controller.signal.aborted || currentUserId !== currentUserIdAtStart) {
        setIsLoading(false);
        setExecutionStatus(null);
        activeAbortControllerRef.current = null;
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: `${m.content}\n\n*[Vision generation cancelled by user. Stale result suppressed.]*`,
            visionProposal: undefined,
          } : m),
        }));
        return;
      }

      setIsLoading(false);
      setExecutionStatus(null);
      activeAbortControllerRef.current = null;

      if (visionRes.authRequired) {
        setIsAuthOpen(true);
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: '[Authentication Required]: Please sign in to generate images with AIRA Vision Engine.',
            visionProposal: undefined,
          } : m),
        }));
        return;
      }

      if (visionRes.success && visionRes.imageUrl) {
        const billingText = typeof visionRes.creditsCharged === 'number'
          ? `*Generated by AIRA Vision Engine (${visionRes.creditsCharged} credits billed)*`
          : '*Generated by AIRA Vision Engine*';
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: `Here is the generated image for "${proposal.prompt}":\n\n![${proposal.prompt}](${visionRes.imageUrl})\n\n${billingText}`,
            visionProposal: undefined,
          } : m),
        }));
      } else if (visionRes.quotaExceeded) {
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: `[Quota Exceeded] **Vision Quota Exceeded**: You need additional credits to generate images.\n\n${visionRes.error || 'Please upgrade your plan or purchase image credits in Account & Billing.'}`,
            visionProposal: undefined,
          } : m),
        }));
      } else if (visionRes.providerUnavailable) {
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: `[Vision Service Unavailable] **Vision Engine Not Ready**: ${visionRes.error || 'No active image generation provider is configured or available. Zero credits were deducted.'}`,
            visionProposal: undefined,
          } : m),
        }));
      } else if (visionRes.cancelled) {
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: `${m.content}\n\n*[Vision generation cancelled by user. Transport connection aborted.]*`,
            visionProposal: undefined,
          } : m),
        }));
      } else {
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: `[Notice] **Vision Notice**: ${visionRes.error || 'Failed to generate visual render.'}`,
            visionProposal: undefined,
          } : m),
        }));
      }
    } catch (err: any) {
      setIsLoading(false);
      setExecutionStatus(null);
      activeAbortControllerRef.current = null;
      updateConversation(activeChatId, c => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
          ...m,
          content: `[Error] **Vision Error**: ${err.message || 'Image generation service error.'}`,
          visionProposal: undefined,
        } : m),
      }));
    } finally {
      pendingVisionOpsRef.current.delete(proposal.id);
      setAuthorizingVisionId(null);
    }
  }, [activeChatId, currentUserId]);

  const handleCancelVisionProposal = useCallback((proposalId: string) => {
    if (!activeChatId) return;
    updateConversation(activeChatId, c => ({
      ...c,
      updatedAt: Date.now(),
      messages: c.messages.map(m => m.visionProposal?.id === proposalId ? {
        ...m,
        content: `${m.content}\n\n*[Vision generation cancelled by user]*`,
        visionProposal: undefined,
      } : m),
    }));
    showToast('Vision generation cancelled');
  }, [activeChatId, showToast]);

  const handleSendMessage = async (rawText: string, attachments: Attachment[]) => {
    if (isLoading) return;
    let conversation = activeConversation;
    if (!conversation) return;

    const id = conversation.id;
    if (!conversations.some(c => c.id === id)) {
      conversation = { ...conversation, projectId: activeProjectId };
      const draft = conversation;
      setConversations(prev => [draft, ...prev]);
      setActiveChatId(id);
      saveActiveChatId(id);
      setSessionActiveChatId(id);
    }
    const cleanTitle = rawText.replace(/^\[[^\]]+\]\s*/, '').trim();
    const userMessage: Message = {
      id: 'user-' + Date.now(),
      role: 'user',
      content: rawText,
      attachments,
      timestamp: Date.now(),
    };

    const assistantId = 'assistant-' + (Date.now() + 1);
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      modelUsed: settings.activeModel,
      isStreaming: true,
      thinking: settings.extendedThinking ? { text: '', isStreaming: true } : undefined,
      artifacts: [],
    };

    const history = conversation.messages.map(m => ({ role: m.role, content: m.content }));
    updateConversation(id, c => ({
      ...c,
      title: c.messages.length === 0 && cleanTitle ? cleanTitle.slice(0, 52) : c.title,
      messages: [...c.messages, userMessage, assistantMessage],
      updatedAt: Date.now(),
    }));
    setIsLoading(true);

    const controller = new AbortController();
    activeAbortControllerRef.current = controller;
    activeAssistantMsgIdRef.current = assistantId;
    activeRunIdRef.current = null;

    const intent = detectCapabilityIntent(rawText, workspaceMode);

    // 1. VISION ENGINE CAPABILITY DISPATCH (Requires explicit user authorization and tariff disclosure)
    if (intent.capability === 'IMAGE_GENERATION') {
      setIsLoading(false);
      activeAbortControllerRef.current = null;
      activeAssistantMsgIdRef.current = null;
      const tariff = getVisionTariff(intent.parameters);
      updateConversation(id, c => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages.map(m => m.id === assistantId ? {
          ...m,
          content: `I prepared a visual generation request for your prompt: **"${intent.cleanPrompt}"**.\n\nImage generation is a billable operation requiring **${tariff} Credits** (${intent.parameters?.quality === 'premium' ? 'Premium' : 'Standard Economy'}, ${intent.parameters?.aspectRatio || '1:1'}). Under AIRA commercial safety controls, billable operations require explicit authorization before execution. Review the details below and authorize generation to proceed.`,
          isStreaming: false,
          visionProposal: {
            id: `vis_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            prompt: intent.cleanPrompt,
            estimatedCredits: tariff,
            options: intent.parameters,
          },
        } : m),
      }));
      return;
    }

    // 2. BUILDER APP IN CHAT MODE (Propose switching to Agent Mode with actionable handoff)
    if (intent.capability === 'BUILDER_APP' && workspaceMode === 'chat') {
      setIsLoading(false);
      activeAbortControllerRef.current = null;
      activeAssistantMsgIdRef.current = null;
      updateConversation(id, c => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages.map(m => m.id === assistantId ? {
          ...m,
          content: `I recognized your request to scaffold and build an application: **"${intent.cleanPrompt}"**.\n\nTo create files, inspect the codebase, execute commands in an isolated sandbox, run tests, and generate live previews, this task requires **Agent Mode** with explicit sandbox permissions.`,
          isStreaming: false,
          builderHandoff: {
            prompt: intent.cleanPrompt,
            conversationId: id,
          },
        } : m),
      }));
      return;
    }

    // 3. BUILDER APP IN AGENT MODE (Launch builder and open contextual panel)
    if (intent.capability === 'BUILDER_APP' && workspaceMode === 'agent') {
      // Normal conversation is primary; workspace remains closed by default
      setActiveAgentPrompt(intent.cleanPrompt || rawText);
    }

    // 4. AUTOMATION ENGINE CAPABILITY DISPATCH (Requires explicit schedule resolution and user confirmation)
    if (intent.capability === 'AUTOMATION') {
      setIsLoading(false);
      activeAbortControllerRef.current = null;
      activeAssistantMsgIdRef.current = null;

      const schedule = intent.parameters?.schedule;
      if (schedule && schedule.isAmbiguous) {
        updateConversation(id, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.id === assistantId ? {
            ...m,
            content: `I recognized your request to automate a workflow: **"${intent.cleanPrompt}"**.\n\n${schedule.clarificationPrompt || 'Please specify the exact time and frequency for this automation (for example: "every Monday at 9:00 AM" or "tomorrow at 3:00 PM").'}`,
            isStreaming: false,
          } : m),
        }));
        return;
      }

      const proposalName = intent.cleanPrompt.slice(0, 48) || 'AIRA Automation';
      updateConversation(id, c => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages.map(m => m.id === assistantId ? {
          ...m,
          content: `I prepared an automation workflow draft for your request: **"${intent.cleanPrompt}"**.\n\n**Proposed Schedule:** ${schedule?.humanSchedule || 'Scheduled automation'}\n\n*Note: Autonomous background scheduling is temporarily unavailable in this environment. Review the proposal below and click **Save Automation (Inactive Draft)** (Confirm and Schedule Automation action) to safely register an inactive draft.*`,
          isStreaming: false,
          automationProposal: {
            id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: proposalName,
            objective: intent.cleanPrompt,
            trigger: schedule?.scheduleType === 'ONE_TIME' ? 'ONE_TIME' : 'CRON',
            cronExpression: schedule?.scheduleType === 'ONE_TIME' ? undefined : (schedule?.cronExpression || '0 9 * * *'),
            targetRunAt: schedule?.targetTimestamp,
            humanSchedule: schedule?.humanSchedule,
            timezone: schedule?.timezone,
            scheduleType: schedule?.scheduleType,
          },
        } : m),
      }));
      return;
    }

    let projectContext = '';
    if (currentProject?.instructions) projectContext += `Project instructions:\n${currentProject.instructions}\n\n`;
    if (currentProject?.knowledgeGraph) {
      const retrieved = retrieveRelevantSubgraph(rawText, currentProject.knowledgeGraph);
      if (retrieved) projectContext += retrieved.formattedContext;
    }
    let modeContext = MODE_CONTEXT[workspaceMode];
    if (intent.capability === 'RESEARCH') {
      modeContext += '\nPerform deep research synthesis. Decompose the inquiry into core sub-questions, extract evidence, cite primary sources, and clearly distinguish verified facts from inferences.';
    }
    const requestEpoch = authEpochRef.current;
    const requestOwnerId = currentUserId;
    const isSameRequestIdentity = () => (
      authEpochRef.current === requestEpoch &&
      activeUserIdRef.current === requestOwnerId
    );

    try {
      await streamAIResponse(
        rawText,
        history,
        settings.activeModel,
        settings,
        attachments,
        {
          onThinkingChunk: chunk => {
            if (!isSameRequestIdentity()) return;
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => m.id === assistantId ? {
                ...m,
                thinking: { text: (m.thinking?.text || '') + chunk, isStreaming: true },
              } : m),
            }));
          },
          onContentChunk: chunk => {
            if (!isSameRequestIdentity()) return;
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => m.id === assistantId ? { ...m, content: m.content + chunk } : m),
            }));
          },
          onProvenance: provenance => {
            if (!isSameRequestIdentity()) return;
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => m.id === assistantId ? {
                ...m,
                provenance,
                modelUsed: (provenance.executedModel || m.modelUsed) as any
              } : m),
            }));
          },
          onArtifactFound: artifact => {
            if (!isSameRequestIdentity()) return;
            const key = `${requestOwnerId || 'guest'}:${id}:${artifact.id}`;
            const previous = artifactRevisionsRef.current.get(key);
            const updatedArtifact = ADAPTIVE_STUDIO_PREVIEW
              ? reconcileArtifactRevision(previous, artifact)
              : artifact;
            if (ADAPTIVE_STUDIO_PREVIEW) {
              if (artifactRevisionsRef.current.size >= 40 && !artifactRevisionsRef.current.has(key)) {
                artifactRevisionsRef.current.delete(artifactRevisionsRef.current.keys().next().value!);
              }
              artifactRevisionsRef.current.set(key, updatedArtifact);
            }
            setActiveArtifact(updatedArtifact);
            if (!userDismissedStudioRef.current) {
              setIsStudioOpen(true);
            }
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => {
                if (m.id !== assistantId) return m;
                const existing = m.artifacts || [];
                const idx = existing.findIndex(a => a.id === artifact.id);
                if (idx >= 0) {
                  const updated = [...existing];
                  updated[idx] = updatedArtifact;
                  return { ...m, artifacts: updated };
                }
                return { ...m, artifacts: [...existing, updatedArtifact] };
              }),
            }));
          },
          onApprovalRequired: approval => {
            if (!isSameRequestIdentity()) return;
            setPendingApproval({
              id: approval.id,
              runId: approval.runId,
              toolName: approval.toolCall?.name,
              reason: approval.reason
            });
          },
          onStatusUpdate: status => {
            if (!isSameRequestIdentity()) return;
            setExecutionStatus(status);
          },
          onAgentEvent: ADAPTIVE_STUDIO_PREVIEW ? event => {
            if (!isSameRequestIdentity()) return;
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => m.id === assistantId ? {
                ...m,
                agentEvents: appendAgentTimelineEvent(m.agentEvents || [], event),
              } : m),
            }));
          } : undefined,
          onGraphEvent: ADAPTIVE_STUDIO_PREVIEW ? (type, data) => {
            if (!isSameRequestIdentity()) return;
            setActiveExecutionGraph(prev => {
              const base = prev || {
                graphId: 'graph_' + Date.now(),
                runId: activeRunIdRef.current || 'run_' + Date.now(),
                title: 'Agent Workflow Execution',
                nodes: {},
                waves: [],
                state: 'RUNNING' as const,
                totalTasks: 0,
                completedTasks: 0,
                failedTasks: 0
              };
              return applyExecutionGraphEvent(base, type, data);
            });
          } : undefined,
          onLatencyMetrics: metrics => {
            if (!isSameRequestIdentity()) return;
            if (!settings.telemetryOptOut) {
              console.info('[AIRA Telemetry] Client observed latency metrics:', metrics);
            }
          },
          onRunStarted: runId => {
            if (!isSameRequestIdentity()) return;
            activeRunIdRef.current = runId;
          },
          onSourceAdded: source => {
            if (!isSameRequestIdentity()) return;
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => m.id === assistantId ? {
                ...m,
                citations: [...(m.citations || []), {
                  sourceTitle: source.title,
                  uri: source.url,
                  snippet: source.snippet,
                }],
              } : m),
            }));
          },
          onCancelled: () => {
            if (!isSameRequestIdentity()) return;
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => m.id === assistantId ? {
                ...m,
                content: m.content ? `${m.content}\n\n*[Execution cancelled by user]*` : '*[Execution cancelled by user]*',
                isStreaming: false,
              } : m),
            }));
          },
          onComplete: () => {
            if (!isSameRequestIdentity()) return;
            activeAbortControllerRef.current = null;
            activeAssistantMsgIdRef.current = null;
            activeRunIdRef.current = null;
            setExecutionStatus(null);
            updateConversation(id, c => ({
              ...c,
              updatedAt: Date.now(),
              messages: c.messages.map(m => m.id === assistantId ? {
                ...m,
                isStreaming: false,
                thinking: m.thinking ? { ...m.thinking, isStreaming: false } : undefined,
              } : m),
            }));
            setIsLoading(false);
          },
          onError: error => {
            if (!isSameRequestIdentity()) return;
            activeAbortControllerRef.current = null;
            activeAssistantMsgIdRef.current = null;
            activeRunIdRef.current = null;
            setExecutionStatus(null);
            if (typeof error === 'string') {
              if (error.includes('PLAN_MODEL_RESTRICTED')) {
                handleTriggerUpgrade('flagship_model');
              } else if (error.includes('PLAN_CAPABILITY_RESTRICTED')) {
                if (error.toLowerCase().includes('sandbox') || error.toLowerCase().includes('browser') || error.toLowerCase().includes('python')) {
                  handleTriggerUpgrade('plus_to_pro_tool');
                } else {
                  handleTriggerUpgrade('agent_mode');
                }
              } else if (error.includes('429') || error.toLowerCase().includes('quota') || error.toLowerCase().includes('limit')) {
                handleTriggerUpgrade(userTier === 'guest' ? 'guest_limit' : 'quota_exhausted');
              }
            }
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => m.id === assistantId ? { ...m, content: `Aira encountered an execution error: ${error}`, isStreaming: false } : m),
            }));
            setIsLoading(false);
          },
        },
        projectContext.trim() || undefined,
        id,
        intent.capability === 'RESEARCH' ? 'RESEARCH' : undefined,
        controller.signal,
        ADAPTIVE_STUDIO_PREVIEW,
        modeContext.trim() || undefined
      );
    } catch (err: any) {
      if (!isSameRequestIdentity()) return;
      activeAbortControllerRef.current = null;
      activeAssistantMsgIdRef.current = null;
      activeRunIdRef.current = null;
      setExecutionStatus(null);
      setIsLoading(false);
      if (err?.name === 'AbortError') {
        return;
      }
      updateConversation(id, c => ({
        ...c,
        messages: c.messages.map(m => m.id === assistantId ? { ...m, content: 'Aira could not complete this request.', isStreaming: false } : m),
      }));
    }
  };

  const handleSelectArtifactById = useCallback((artifactId: string) => {
    const found = conversationArtifacts.find(a => a.id === artifactId);
    if (found) {
      setActiveArtifact(found);
    }
  }, [conversationArtifacts]);

  const handleTaskApproval = useCallback(async (taskId: string, approvalId: string, decision: 'APPROVE' | 'REJECT') => {
    if (approvalSubmissionRef.current) return;
    approvalSubmissionRef.current = true;
    setIsSubmittingApproval(true);
    try {
      const runId = activeExecutionGraph?.runId || activeRunIdRef.current || pendingApproval?.runId;
      await dispatchRunApproval(runId, approvalId, decision);
      showToast(decision === 'APPROVE' ? 'Task execution approved.' : 'Task execution rejected.');
      if (pendingApproval && (pendingApproval.id === approvalId || !approvalId)) {
        setPendingApproval(null);
      }
      setActiveExecutionGraph(prev => prev ? applyExecutionGraphEvent(prev, 'approval.resolved', {
        taskId,
        approvalId,
        decision: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'
      }) : null);
    } catch (e: any) {
      showToast(`Approval error: ${e.message}`);
    } finally {
      approvalSubmissionRef.current = false;
      setIsSubmittingApproval(false);
    }
  }, [activeExecutionGraph, pendingApproval, showToast]);

  const handleApprovalDecision = async (decision: 'APPROVE' | 'REJECT') => {
    if (!pendingApproval || approvalSubmissionRef.current) return;
    approvalSubmissionRef.current = true;
    setIsSubmittingApproval(true);
    try {
      await dispatchRunApproval(pendingApproval.runId, pendingApproval.id, decision);
      showToast(decision === 'APPROVE' ? 'Action approved. Resuming execution...' : 'Action rejected.');
      setPendingApproval(null);
    } catch (e: any) {
      showToast(`Error: ${e.message}`);
    } finally {
      approvalSubmissionRef.current = false;
      setIsSubmittingApproval(false);
    }
  };

  const handleShare = async () => {
    if (!activeConversation) return;
    const shared = await shareConversation(activeConversation);
    if (!shared) return;
    setSharedCopied(true);
    showToast('Conversation shared');
    setTimeout(() => setSharedCopied(false), 1500);
  };

  const updateSettings = (partial: Partial<AppSettings>) => setSettings(prev => ({ ...prev, ...partial }));

  return (
    <FeatureFlagProvider userTier={userTier}>
      <div className={`aira-editorial-app ${ADAPTIVE_STUDIO_PREVIEW ? 'aira-adaptive-shell ' : ''}${isStudioOpen ? 'has-studio-open ' : ''}h-[100dvh] w-full min-w-0 flex overflow-hidden bg-claude-bg-light dark:bg-claude-bg-dark text-claude-text-light dark:text-claude-text-dark`}>
        <Sidebar
          conversations={conversations}
          activeChatId={activeChatId}
          onSelectChat={handleSelectChat}
          onNewChat={handleNewChat}
          onDeleteChat={handleDeleteChat}
          onRenameChat={handleRenameChat}
          onToggleBookmark={handleToggleBookmark}
          onToggleStar={handleToggleStar}
          onDuplicateChat={handleDuplicateChat}
          onShareChat={handleShareChat}
          projects={projects}
          activeProjectId={activeProjectId}
          onOpenProjects={() => setIsProjectsOpen(true)}
          onOpenSettings={handleOpenSettings}
          onOpenAuth={() => setIsAuthOpen(true)}
          onOpenSearch={handleOpenConversationSearch}
          isOpen={sidebarOpen}
          onToggleOpen={() => setSidebarOpen(v => !v)}
          onClose={() => setSidebarOpen(false)}
          settings={settings}
          onUpdateSettings={updateSettings}
          workspaceMode={workspaceMode}
          onSelectWorkspace={setWorkspaceMode}
          onOpenVisionStudio={() => setIsVisionOpen(true)}
          onOpenPricing={() => setIsPricingOpen(true)}
          onOpenBilling={() => setIsAccountBillingOpen(true)}
          onOpenHelpCenter={() => setIsHelpCenterOpen(true)}
          onOpenPrivacyCenter={() => setIsPrivacyCenterOpen(true)}
          onOpenReleaseNotes={() => setIsReleaseNotesOpen(true)}
          onOpenDownloadApps={() => setIsDownloadAppsOpen(true)}
          onOpenShortcuts={() => setIsKeyboardShortcutsOpen(true)}
          onOpenLegalViewer={(doc) => {
            setLegalViewerInitialDoc(doc);
            setIsLegalViewerOpen(true);
          }}
          onOpenReportBug={() => setIsReportBugOpen(true)}
          userTier={userTier}
          onOpenWhatsNew={() => {
            setFocusedAnnouncement(null);
            setIsWhatsNewOpen(true);
          }}
          onRestartOnboarding={handleRestartOnboarding}
          onOpenMotionStudio={() => setIsMotionStudioOpen(true)}
          unreadAnnouncementsCount={unreadAnnouncementsCount}
        />

      <CommandPalette
        isOpen={isCommandPaletteOpen}
        conversations={conversations}
        projects={projects}
        onClose={() => setIsCommandPaletteOpen(false)}
        onNewChat={handleNewChat}
        onSelectChat={handleSelectChat}
        onSelectWorkspace={setWorkspaceMode}
        onOpenProjects={() => setIsProjectsOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      <ConversationSearchOverlay
        isOpen={isConversationSearchOpen}
        initialQuery={conversationSearchSeed}
        conversations={conversations}
        projects={projects}
        onClose={() => setIsConversationSearchOpen(false)}
        onSelectChat={handleSelectSearchResult}
      />

      <InlineToast message={toastMessage} />

      <main className={`${ADAPTIVE_STUDIO_PREVIEW ? 'aira-adaptive-main ' : 'bg-mesh-canvas '}flex-1 min-w-0 min-h-0 h-[100dvh] flex flex-col overflow-hidden w-full max-w-full`}>
        <header className={`aira-editorial-header ${ADAPTIVE_STUDIO_PREVIEW ? 'aira-adaptive-header ' : ''}h-[60px] md:h-[64px] shrink-0 px-3 md:px-6 flex items-center justify-between border-b border-claude-border-light dark:border-claude-border-dark gradient-fade-header relative z-30 bg-claude-bg-light dark:bg-claude-bg-dark`}>
          <div className="flex flex-1 items-center gap-1 min-w-0">
            {!sidebarOpen && (
              <>
                <button 
                  onClick={() => setSidebarOpen(true)} 
                  className="p-2 -ml-1 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark transition-colors touch-manipulation" 
                  title="Open sidebar"
                  aria-label="Open sidebar navigation"
                >
                  <PanelLeft className="w-4 h-4" />
                </button>
                <div className="flex items-center gap-1.5 mr-1">
                  <AiraMark size="sm" isAnimated={true} motionConcept="a" />
                </div>
              </>
            )}
            {ADAPTIVE_STUDIO_PREVIEW && (
              <div className="aira-adaptive-mode-toggle" role="group" aria-label="Workspace mode">
                <button type="button" aria-pressed={workspaceMode === 'chat'} onClick={() => setWorkspaceMode('chat')}>
                  <MessageSquareText size={15} aria-hidden="true" /> Chat
                </button>
                <button type="button" aria-pressed={workspaceMode === 'agent'} onClick={() => setWorkspaceMode('agent')}>
                  <Bot size={15} aria-hidden="true" /> Agent
                </button>
              </div>
            )}
            <ModelSelector
              currentModel={settings.activeModel}
              onSelectModel={model => updateSettings({ activeModel: model })}
              extendedThinking={settings.extendedThinking}
              onToggleThinking={enabled => updateSettings({ extendedThinking: enabled })}
              userTier={userTier}
              onTriggerUpgrade={handleTriggerUpgrade}
            />
            {currentProject && <button onClick={() => setIsProjectsOpen(true)} className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-aira-blue/10 text-aira-blue text-xs max-w-[180px]"><FolderGit2 className="w-3 h-3" /><span className="truncate">{currentProject.name}</span></button>}
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            {workspaceMode === 'agent' && (
              <button
                onClick={() => {
                  if (isStudioOpen) {
                    setIsAgentPanelOpen(false);
        setIsStudioOpen(false);
                    userDismissedStudioRef.current = true;
                  } else {
                    setIsStudioOpen(true);
                    userDismissedStudioRef.current = false;
                    if (!activeArtifact && conversationArtifacts.length > 0) {
                      setActiveArtifact(conversationArtifacts[conversationArtifacts.length - 1]);
                    }
                  }
                }}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                  isStudioOpen
                    ? 'bg-aira-blue text-white'
                    : 'bg-aira-blue/10 text-aira-blue dark:text-aira-silver hover:bg-aira-blue/20'
                }`}
                title="Toggle Agent Workspace Panel"
              >
                <Bot className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Agent Panel</span>
              </button>
            )}
            {(isLoading || isBuilderBusy) && (
              <button
                onClick={handleCancelExecution}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-rose-500 hover:bg-rose-500/10 active:scale-95 transition-transform duration-150 motion-reduce:transition-none"
                title="Cancel active execution"
              >
                Cancel
              </button>
            )}
            {workspaceMode === 'chat' && (ADAPTIVE_STUDIO_PREVIEW || activeConversation?.messages.some(m => (m.artifacts?.length || 0) > 0)) && (
              <button
                data-testid="artifact-studio-launcher"
                onClick={() => {
                  if (isStudioOpen) {
                    setIsAgentPanelOpen(false);
        setIsStudioOpen(false);
                    userDismissedStudioRef.current = true;
                  } else {
                    setIsStudioOpen(true);
                    userDismissedStudioRef.current = false;
                    if (!activeArtifact && conversationArtifacts.length > 0) {
                      setActiveArtifact(conversationArtifacts[conversationArtifacts.length - 1]);
                    }
                  }
                }}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                  isStudioOpen
                    ? 'bg-aira-blue text-white shadow-sm'
                    : 'hover:bg-claude-surface2-light dark:hover:bg-white/5 text-claude-text-light dark:text-claude-text-dark'
                }`}
                title={isStudioOpen ? 'Close Artifact Studio' : 'Open Artifact Studio'}
                aria-label={isStudioOpen ? 'Close Artifact Studio' : 'Open Artifact Studio'}
                aria-expanded={isStudioOpen}
              >
                <Layers className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Artifact Studio</span>
              </button>
            )}
            {activeConversation && <button onClick={() => handleToggleStar(activeConversation.id)} className="p-1.5 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-white/5 active:scale-95 transition-transform duration-150 motion-reduce:transition-none" title={activeConversation.isPinned ? 'Remove bookmark' : 'Bookmark conversation'}><Bookmark className={`w-4 h-4 ${activeConversation.isPinned ? 'fill-aira-blue text-aira-blue' : 'text-claude-muted-light dark:text-claude-muted-dark'}`} /></button>}
            <button onClick={handleShare} className="p-1.5 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-white/5">{sharedCopied ? <Check className="w-4 h-4 text-emerald-400" /> : <Share2 className="w-4 h-4 text-claude-muted-light dark:text-claude-muted-dark" />}</button>
          </div>
        </header>

        <div ref={chatScrollRef} data-testid="chat-scroll-region" className={`${ADAPTIVE_STUDIO_PREVIEW ? 'aira-adaptive-chat-content ' : ''}flex-1 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain flex flex-col`}>
          {!activeConversation || activeConversation.messages.length === 0 ? (
            <GreetingScreen 
              userName={settings.userName} 
              workspaceMode={workspaceMode} 
              conversations={conversations}
              activeProject={currentProject}
              extendedThinking={settings.extendedThinking}
              onSelectChat={handleSelectChat}
            />
          ) : (
            <div className="flex-1 pb-24 sm:pb-8 space-y-4">
              {activeConversation.messages.map(message => (
                <div
                  id={`message-${message.id}`}
                  key={message.id}
                  className={highlightedMessageId === message.id
                    ? 'rounded-xl ring-2 ring-aira-blue/35 bg-aira-blue/[0.035] transition-colors duration-500'
                    : 'transition-colors duration-500'}
                >
                  <ChatMessage
                    message={message}
                    showAgentTimeline={ADAPTIVE_STUDIO_PREVIEW}
                    userName={settings.userName}
                    onOpenArtifact={artifact => {
                      setActiveArtifact(artifact);
                      setIsStudioOpen(true);
                      userDismissedStudioRef.current = false;
                    }}
                    onSwitchToAgentAndReview={handleSwitchToAgentAndReview}
                    onConfirmAutomation={handleConfirmAutomation}
                    onAuthorizeVision={handleAuthorizeVision}
                    onCancelVisionProposal={handleCancelVisionProposal}
                    onApprovalDecision={handleApprovalDecision}
                    isSubmittingApproval={isSubmittingApproval}
                    isConfirmingAutomation={Boolean(confirmingAutoId)}
                    isAuthorizingVision={Boolean(authorizingVisionId)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Persistent Composer (Visible in both Chat Mode and Agent Mode) */}
        <div className={`${ADAPTIVE_STUDIO_PREVIEW ? 'aira-adaptive-composer ' : ''}shrink-0 min-w-0 relative z-10 pt-2 sm:pt-4 gradient-mask-bottom`}>
          {executionStatus && (
            <div className="max-w-2xl mx-auto px-4 mb-2">
              <div className="flex items-center gap-2 text-xs text-aira-blue dark:text-aira-silver bg-aira-blue/10 border border-aira-blue/20 rounded-lg px-3 py-1.5 shadow-sm backdrop-blur">
                <div className="w-2 h-2 rounded-full bg-aira-blue animate-pulse" />
                <span className="font-medium">{executionStatus}</span>
              </div>
            </div>
          )}

          {pendingApproval && (
            <ExecutionApprovalBanner
              approval={pendingApproval}
              isSubmitting={isSubmittingApproval}
              onDecision={handleApprovalDecision}
            />
          )}

          {activeFeatureGuidance && (
            <div className="max-w-3xl mx-auto px-3 sm:px-5 mb-3">
              <FeatureDiscoveryCard
                guidance={activeFeatureGuidance}
                onDismiss={handleDismissFeatureGuidance}
                onTryFeature={(prompt, targetMode) => {
                  if (targetMode) setWorkspaceMode(targetMode);
                  handleSendMessage(prompt, []);
                  handleDismissFeatureGuidance();
                }}
              />
            </div>
          )}

          <ChatInput
            key={ADAPTIVE_STUDIO_PREVIEW ? (repairDraft?.id ?? 'normal-composer') : 'normal-composer'}
            onSendMessage={handleSendMessage}
            repairDraft={ADAPTIVE_STUDIO_PREVIEW ? repairDraft : undefined}
            isLoading={isLoading}
            currentModel={settings.activeModel}
            extendedThinking={settings.extendedThinking}
            workspaceMode={workspaceMode}
            onWorkspaceModeChange={setWorkspaceMode}
            userTier={userTier}
            onTriggerUpgrade={handleTriggerUpgrade}
          />
        </div>
      </main>

      <React.Suspense fallback={null}>
        {ADAPTIVE_STUDIO_PREVIEW ? (
          isStudioOpen && (
            <UnifiedWorkspace
              isOpen={isStudioOpen}
              artifact={activeArtifact}
              onClose={() => {
                setIsAgentPanelOpen(false);
                setIsStudioOpen(false);
                userDismissedStudioRef.current = true;
              }}
              onUpdateArtifact={restored => {
                const key = `${currentUserId || 'guest'}:${activeChatId}:${restored.id}`;
                artifactRevisionsRef.current.set(key, restored);
                setActiveArtifact(restored);
                updateConversation(activeChatId, conversation => {
                  const messages = [...conversation.messages];
                  for (let i = messages.length - 1; i >= 0; i--) {
                    const entry = messages[i];
                    if (entry.artifacts?.some(item => item.id === restored.id)) {
                      messages[i] = {
                        ...entry,
                        artifacts: entry.artifacts.map(item => item.id === restored.id ? restored : item),
                      };
                      break;
                    }
                  }
                  return { ...conversation, messages, updatedAt: Date.now() };
                });
              }}
              onRepairArtifact={(error, title) => {
                setWorkspaceMode('agent');
                setRepairDraft({ id: Date.now(), text: createArtifactRepairPrompt(title, error) });
              }}
              allArtifacts={conversationArtifacts}
              onSelectArtifact={setActiveArtifact}
              activeProjectName={currentProject?.name}
              onSaveToProject={handleSaveArtifactToProject}
              executionGraph={activeExecutionGraph}
              onApproveTask={handleTaskApproval}
              workspaceMode={workspaceMode}
            />
          )
        ) : (
          isStudioOpen && activeArtifact && (
            <ArtifactStudio
              artifact={activeArtifact}
              adaptiveDock={false}
              onClose={() => {
                setIsAgentPanelOpen(false);
                setIsStudioOpen(false);
                userDismissedStudioRef.current = true;
              }}
              allArtifacts={undefined}
              onSelectArtifact={undefined}
              activeProjectName={undefined}
              onSaveToProject={undefined}
              executionGraph={undefined}
              onApproveTask={undefined}
            />
          )
        )}

        {isProjectsOpen && (
          <ProjectsModal
            isOpen={isProjectsOpen}
            onClose={() => setIsProjectsOpen(false)}
            projects={projects}
            activeProjectId={activeProjectId}
            onSelectProject={setActiveProjectId}
            onSaveProject={project => {
              setProjects(prev => {
                const next = [project, ...prev.filter(p => p.id !== project.id)];
                saveProjects(next, currentUserId || undefined);
                return next;
              });
            }}
            onDeleteProject={id => {
              setProjects(prev => {
                const next = prev.filter(p => p.id !== id);
                saveProjects(next, currentUserId || undefined);
                return next;
              });
              if (activeProjectId === id) setActiveProjectId(undefined);
            }}
          />
        )}

        {isSettingsOpen && (
          <SettingsModal
            key={`settings-${currentUserId || 'guest'}`}
            isOpen={isSettingsOpen}
            onClose={() => setIsSettingsOpen(false)}
            settings={settings}
            onSaveSettings={setSettings}
            conversations={conversations}
            projects={projects}
            initialTab={settingsInitialTab}
            onImportData={data => { setConversations(data.conversations); setProjects(data.projects); if (data.conversations[0]) handleSelectChat(data.conversations[0].id); }}
            onClearAll={() => {
              const fresh = { ...INITIAL_CONVERSATION, id: 'chat-' + Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
              clearAccountSettings(currentUserId);
              setConversations([fresh]);
              setActiveChatId(fresh.id);
              setProjects([]);
              setActiveProjectId(undefined);
              setSettings(loadSettings(currentUserId));
              setActiveArtifact(null);
              agentMemory.purge(undefined, true);
            }}
            onOpenMemoryVault={() => setIsMemoryVaultOpen(true)}
            onOpenBilling={() => setIsAccountBillingOpen(true)}
            onOpenPricing={() => setIsPricingOpen(true)}
            onOpenShortcuts={() => setIsKeyboardShortcutsOpen(true)}
            userTier={userTier}
            onTriggerUpgrade={handleTriggerUpgrade}
            onRestartOnboarding={handleRestartOnboarding}
            onResetAnnouncements={() => setUnreadAnnouncementsCount(getUnreadAnnouncementCount(userTier, currentUserId))}
          />
        )}

        <HelpCenterModal
          isOpen={isHelpCenterOpen}
          onClose={() => setIsHelpCenterOpen(false)}
          onOpenReportBug={() => setIsReportBugOpen(true)}
          onOpenShortcuts={() => setIsKeyboardShortcutsOpen(true)}
          onOpenPrivacyCenter={() => setIsPrivacyCenterOpen(true)}
          onOpenMotionStudio={() => setIsMotionStudioOpen(true)}
        />

        <PrivacyCenterModal
          key={`privacy-${currentUserId || 'guest'}`}
          isOpen={isPrivacyCenterOpen}
          onClose={() => setIsPrivacyCenterOpen(false)}
          settings={settings}
          onUpdateSettings={updateSettings}
          conversations={conversations}
          projects={projects}
          onClearAllData={() => {
            const fresh = { ...INITIAL_CONVERSATION, id: 'chat-' + Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
            clearAccountSettings(currentUserId);
            setConversations([fresh]);
            setActiveChatId(fresh.id);
            setProjects([]);
            setActiveProjectId(undefined);
            setSettings(loadSettings(currentUserId));
            setActiveArtifact(null);
            agentMemory.purge(undefined, true);
          }}
          onOpenLegalViewer={(doc) => {
            setLegalViewerInitialDoc(doc);
            setIsLegalViewerOpen(true);
          }}
        />

        <ReleaseNotesModal
          isOpen={isReleaseNotesOpen}
          onClose={() => setIsReleaseNotesOpen(false)}
          onOpenHelpCenter={() => setIsHelpCenterOpen(true)}
        />

        <DownloadAppsModal
          isOpen={isDownloadAppsOpen}
          onClose={() => setIsDownloadAppsOpen(false)}
        />

        <KeyboardShortcutsModal
          isOpen={isKeyboardShortcutsOpen}
          onClose={() => setIsKeyboardShortcutsOpen(false)}
        />

        <LegalViewerModal
          isOpen={isLegalViewerOpen}
          onClose={() => setIsLegalViewerOpen(false)}
          initialDocument={legalViewerInitialDoc}
        />

        <ReportBugModal
          isOpen={isReportBugOpen}
          onClose={() => setIsReportBugOpen(false)}
          settings={settings}
        />

        {isMemoryVaultOpen && (
          <MemoryVaultModal
            isOpen={isMemoryVaultOpen}
            onClose={() => setIsMemoryVaultOpen(false)}
          />
        )}

        <AuthModal
          isOpen={isAuthOpen}
          onClose={() => setIsAuthOpen(false)}
          onAuthSuccess={(user) => {
            setToastMessage(`Welcome, ${user.name}! Sync active.`);
          }}
        />

        <PricingModal
          isOpen={isPricingOpen}
          onClose={() => setIsPricingOpen(false)}
        />

        <VisionStudioModal
          isOpen={isVisionOpen}
          onClose={() => setIsVisionOpen(false)}
        />

        <AccountBillingModal
          isOpen={isAccountBillingOpen}
          onClose={() => setIsAccountBillingOpen(false)}
          onOpenPricing={() => {
            setIsAccountBillingOpen(false);
            setIsPricingOpen(true);
          }}
        />

        <UpgradeModal
          isOpen={isUpgradeModalOpen}
          onClose={() => setIsUpgradeModalOpen(false)}
          trigger={upgradeModalTrigger}
          currentTier={userTier}
          onOpenAuth={() => setIsAuthOpen(true)}
          onOpenPlanSettings={() => handleOpenSettings('plan')}
          onOpenPricing={() => setIsPricingOpen(true)}
        />

        <WhatsNewAnnouncementModal
          isOpen={isWhatsNewOpen}
          onClose={() => {
            setIsWhatsNewOpen(false);
            setFocusedAnnouncement(null);
            setUnreadAnnouncementsCount(getUnreadAnnouncementCount(userTier, currentUserId));
          }}
          userTier={userTier}
          userId={currentUserId}
          isFirstViewPopup={Boolean(focusedAnnouncement)}
          focusedAnnouncement={focusedAnnouncement}
          onAction={handleWhatsNewAction}
        />

        <OnboardingWalkthrough
          key={`onboarding-${currentUserId || 'guest'}`}
          isOpen={isOnboardingOpen}
          onClose={() => setIsOnboardingOpen(false)}
          userId={currentUserId}
          userTier={userTier}
          onOpenPlanSettings={() => handleOpenSettings('plan')}
          onSwitchWorkspaceMode={setWorkspaceMode}
          onOpenProjects={() => setIsProjectsOpen(true)}
        />

        <MotionStudioModal
          isOpen={isMotionStudioOpen}
          onClose={() => setIsMotionStudioOpen(false)}
        />
      </React.Suspense>
    </div>
  </FeatureFlagProvider>
  );
}

export default App;
