import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Maximize2,
  Minimize2,
  Film,
  Code,
  Layers,
  ChevronRight,
  ChevronLeft,
  X,
  Volume2,
  VolumeX,
  ExternalLink,
  Check,
  Copy,
  Gauge
} from 'lucide-react';
import { SHOWCASE_SCENES, type ShowcaseScene } from '../video/types';

interface MotionStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const MotionStudioModal: React.FC<MotionStudioModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [progress, setProgress] = useState(0); // 0 to 1 within the current scene
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9');
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [isMuted, setIsMuted] = useState(true);
  const [activeTab, setActiveTab] = useState<'player' | 'code' | 'storyboard'>('player');
  const [copiedCode, setCopiedCode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const scene = SHOWCASE_SCENES[currentSceneIndex] || SHOWCASE_SCENES[0];
  const totalScenes = SHOWCASE_SCENES.length;
  const SCENE_DURATION_MS = 5000; // 5 seconds per scene

  // Playback timer loop
  useEffect(() => {
    if (!isOpen || !isPlaying || activeTab !== 'player') return;

    const intervalTime = 50; // update every 50ms for smooth 20-30fps progress
    const step = (intervalTime * playbackSpeed) / SCENE_DURATION_MS;

    const timer = setInterval(() => {
      setProgress((prev) => {
        const next = prev + step;
        if (next >= 1) {
          // Advance to next scene or loop back
          setCurrentSceneIndex((idx) => (idx + 1) % totalScenes);
          return 0;
        }
        return next;
      });
    }, intervalTime);

    return () => clearInterval(timer);
  }, [isOpen, isPlaying, playbackSpeed, activeTab, totalScenes]);

  const handleSeekScene = useCallback((index: number) => {
    setCurrentSceneIndex(index);
    setProgress(0);
  }, []);

  const handleTimelineSeek = useCallback((totalSeconds: number) => {
    const clamped = Math.max(0, Math.min(29.99, totalSeconds));
    const newSceneIndex = Math.floor(clamped / 5);
    const newProgress = (clamped % 5) / 5;
    setCurrentSceneIndex(newSceneIndex);
    setProgress(newProgress);
  }, []);

  const handlePrevScene = useCallback(() => {
    setCurrentSceneIndex((idx) => (idx - 1 + totalScenes) % totalScenes);
    setProgress(0);
  }, [totalScenes]);

  const handleNextScene = useCallback(() => {
    setCurrentSceneIndex((idx) => (idx + 1) % totalScenes);
    setProgress(0);
  }, [totalScenes]);

  const handleTogglePlay = useCallback(() => {
    setIsPlaying((prev) => !prev);
  }, []);

  const handleRestart = useCallback(() => {
    setCurrentSceneIndex(0);
    setProgress(0);
    setIsPlaying(true);
  }, []);

  const handleCopyRemotionCode = useCallback(() => {
    const code = `// Remotion Composition for AIRA AI 2026 Showcase
// Target: https://aira-ai-2026.vercel.app
import { Composition, Sequence, Img, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export const AiraVideoShowcase: React.FC = () => {
  return (
    <Composition
      id="AiraShowcase"
      component={MainSequence}
      durationInFrames={900} // 30 seconds at 30 fps
      fps={30}
      width={1920}
      height={1080}
    />
  );
};

const MainSequence = () => {
  // 6 Scenes x 150 frames (5 seconds each)
  return (
    <div style={{ backgroundColor: '#0e121a', width: '100%', height: '100%', color: '#f2f5f9' }}>
      <Sequence from={0} durationInFrames={150}>
        <SceneIntro />
      </Sequence>
      <Sequence from={150} durationInFrames={150}>
        <SceneFastRouting />
      </Sequence>
      <Sequence from={300} durationInFrames={150}>
        <SceneDeepReasoning />
      </Sequence>
      <Sequence from={450} durationInFrames={150}>
        <SceneOnboardingTour />
      </Sequence>
      <Sequence from={600} durationInFrames={150}>
        <SceneCognitiveSettings />
      </Sequence>
      <Sequence from={750} durationInFrames={150}>
        <SceneProductionWorkspace />
      </Sequence>
    </div>
  );
};`;
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  }, []);

  if (!isOpen) return null;

  // Format timecode (total 30 seconds)
  const currentTotalSeconds = currentSceneIndex * 5 + progress * 5;
  const mm = Math.floor(currentTotalSeconds / 60).toString().padStart(2, '0');
  const ss = Math.floor(currentTotalSeconds % 60).toString().padStart(2, '0');
  const ff = Math.floor((currentTotalSeconds % 1) * 30).toString().padStart(2, '0');
  const timecodeString = `00:${mm}:${ss}:${ff}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 md:p-6 bg-black/85 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="motion-studio-title"
    >
      <div
        ref={containerRef}
        className={`w-full max-w-6xl h-[92vh] flex flex-col studio-shell border border-[var(--color-studio-rule)] shadow-lg overflow-hidden ${
          isFullscreen ? 'fixed inset-0 max-w-none h-screen z-50' : ''
        }`}
      >
        {/* Studio Top Navigation Chrome */}
        <header className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-studio-rule)] bg-[var(--color-studio-paper-2)] select-none">
          <div className="flex items-center space-x-3 min-w-0">
            <span className="flex items-center space-x-1.5 px-2.5 py-1 text-xs font-semibold bg-[var(--color-studio-paper-3)] border border-[var(--color-studio-rule-2)] text-[var(--color-studio-accent)] shrink-0">
              <Film className="w-3.5 h-3.5" />
              <span>Motion Studio</span>
            </span>
            <h1 id="motion-studio-title" className="text-sm font-semibold tracking-tight text-[var(--color-studio-ink)] whitespace-nowrap truncate">
              AIRA AI 2026 Feature Showcase
            </h1>
            <span className="hidden sm:inline-block px-2 py-0.5 text-[11px] font-mono bg-[var(--color-studio-paper)] border border-[var(--color-studio-rule)] text-[var(--color-studio-muted)] shrink-0">
              {timecodeString}
            </span>
          </div>

          <div className="flex items-center space-x-2">
            {/* Aspect Ratio Switcher */}
            <div className="hidden sm:flex items-center border border-[var(--color-studio-rule-2)] bg-[var(--color-studio-paper)] p-0.5">
              {(['16:9', '9:16', '1:1'] as const).map((ratio) => (
                <button
                  key={ratio}
                  onClick={() => setAspectRatio(ratio)}
                  className={`px-2 py-0.5 text-xs transition-colors ${
                    aspectRatio === ratio
                      ? 'bg-[var(--color-studio-accent)] text-[var(--color-studio-accent-ink)] font-medium'
                      : 'text-[var(--color-studio-muted)] hover:text-[var(--color-studio-ink)]'
                  }`}
                  aria-label={`Aspect ratio ${ratio}`}
                >
                  {ratio}
                </button>
              ))}
            </div>

            {/* Mode Switcher */}
            <div className="flex items-center border border-[var(--color-studio-rule-2)] bg-[var(--color-studio-paper)] p-0.5">
              <button
                onClick={() => setActiveTab('player')}
                className={`px-2.5 py-1 text-xs flex items-center space-x-1 transition-colors ${
                  activeTab === 'player'
                    ? 'bg-[var(--color-studio-paper-3)] text-[var(--color-studio-ink)] font-medium'
                    : 'text-[var(--color-studio-muted)] hover:text-[var(--color-studio-ink)]'
                }`}
              >
                <Play className="w-3 h-3" />
                <span>Player</span>
              </button>
              <button
                onClick={() => setActiveTab('storyboard')}
                className={`px-2.5 py-1 text-xs flex items-center space-x-1 transition-colors ${
                  activeTab === 'storyboard'
                    ? 'bg-[var(--color-studio-paper-3)] text-[var(--color-studio-ink)] font-medium'
                    : 'text-[var(--color-studio-muted)] hover:text-[var(--color-studio-ink)]'
                }`}
              >
                <Layers className="w-3 h-3" />
                <span className="hidden sm:inline">Scenes</span>
              </button>
              <button
                onClick={() => setActiveTab('code')}
                className={`px-2.5 py-1 text-xs flex items-center space-x-1 transition-colors ${
                  activeTab === 'code'
                    ? 'bg-[var(--color-studio-paper-3)] text-[var(--color-studio-ink)] font-medium'
                    : 'text-[var(--color-studio-muted)] hover:text-[var(--color-studio-ink)]'
                }`}
              >
                <Code className="w-3 h-3" />
                <span className="hidden sm:inline">Remotion</span>
              </button>
            </div>

            {/* Fullscreen toggle */}
            <button
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="p-1.5 text-[var(--color-studio-muted)] hover:text-[var(--color-studio-ink)] transition-colors"
              aria-label="Toggle Fullscreen"
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>

            {/* Close */}
            <button
              onClick={onClose}
              className="p-1.5 text-[var(--color-studio-muted)] hover:text-[var(--color-studio-ink)] transition-colors"
              aria-label="Close Motion Studio"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Studio Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden bg-[var(--color-studio-paper)]">
          {activeTab === 'player' && (
            <div className="flex-1 w-full flex flex-col items-center justify-center p-2 sm:p-4 overflow-hidden min-h-0">
              {/* Motion Canvas Stage */}
              <div
                className={`relative w-full overflow-hidden border border-[var(--color-studio-rule)] bg-black shadow-2xl flex flex-col justify-between transition-transform duration-300 motion-reduce:transition-none ${
                  aspectRatio === '16:9'
                    ? 'max-w-5xl aspect-video max-h-full'
                    : aspectRatio === '9:16'
                    ? 'max-w-sm aspect-[9/16] max-h-full'
                    : 'max-w-xl aspect-square max-h-full'
                }`}
              >
                {/* Scene Background Artwork / Visual Screenshot */}
                <div className="absolute inset-0 z-0 overflow-hidden bg-black flex items-center justify-center">
                  <img
                    src={scene.screenshotUrl}
                    alt={scene.title}
                    className="w-full h-full object-cover object-top opacity-90 filter contrast-[1.08] brightness-95 transition-opacity duration-300"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/40 to-black/30 pointer-events-none" />
                </div>

                {/* Top Scene Marker Header */}
                <div className="relative z-10 flex items-center justify-between p-3 sm:p-4 bg-gradient-to-b from-black/80 to-transparent">
                  <div className="flex items-center space-x-2">
                    <span className="px-2.5 py-0.5 text-xs font-mono font-semibold border border-[var(--color-studio-rule-2)] bg-[var(--color-studio-paper-2)]/90 text-[var(--color-studio-accent)] rounded">
                      {scene.badge}
                    </span>
                    <span className="text-xs font-medium text-stone-300 bg-black/60 px-2.5 py-0.5 rounded backdrop-blur-sm">
                      Scene <span className="font-mono text-white">{currentSceneIndex + 1}</span> of <span className="font-mono text-white">{totalScenes}</span>
                    </span>
                  </div>

                  <a
                    href="https://aira-ai-2026.vercel.app"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center space-x-1.5 text-xs font-medium text-[var(--color-studio-accent)] hover:underline bg-black/60 px-2.5 py-1 rounded backdrop-blur-sm transition-colors"
                  >
                    <span>aira-ai-2026.vercel.app</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>

                {/* Frosted Glass Lower Third Card */}
                <div className="relative z-10 p-3 sm:p-5 m-2 sm:m-4 rounded-xl bg-black/85 backdrop-blur-md border border-white/15 shadow-xl space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] sm:text-[11px] font-mono tracking-wider uppercase text-[var(--color-studio-accent)] font-semibold">
                      {scene.subtitle}
                    </span>
                    <span className="text-[11px] font-mono text-stone-400">
                      {scene.timecode}
                    </span>
                  </div>
                  <h2 className="studio-head-display text-lg sm:text-2xl text-white font-normal leading-snug">
                    {scene.headline}
                  </h2>
                  <p className="text-xs sm:text-sm text-stone-300 leading-relaxed line-clamp-2">
                    {scene.statement}
                  </p>

                  {/* Real Metrics Grid */}
                  {scene.metrics && scene.metrics.length > 0 && (
                    <div className="pt-2 flex flex-wrap items-center gap-2 border-t border-white/10">
                      {scene.metrics.map((m, i) => (
                        <div
                          key={i}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-xs"
                        >
                          <span className="text-stone-400 font-medium">{m.label}:</span>
                          <span className="text-white font-mono font-semibold">{m.value}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Scene In-Canvas Scrubber Indicator */}
                <div className="relative z-10 w-full h-1 bg-white/10">
                  <div
                    className="h-full bg-[var(--color-studio-accent)] transition-all duration-75"
                    style={{ width: `${progress * 100}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'storyboard' && (
            <div className="flex-1 p-4 sm:p-6 pb-16 overflow-y-auto">
              <div className="max-w-5xl mx-auto space-y-6">
                <div>
                  <h2 className="studio-head-display text-xl text-[var(--color-studio-ink)]">
                    Sequential Storyboards (6 Scenes)
                  </h2>
                  <p className="text-xs text-[var(--color-studio-muted)]">
                    Each 5-second scene demonstrates a verified production capability with real metrics.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                  {SHOWCASE_SCENES.map((sc, index) => (
                    <button
                      key={sc.id}
                      onClick={() => {
                        handleSeekScene(index);
                        setActiveTab('player');
                      }}
                      className={`text-left border transition-colors duration-150 p-3 flex flex-col space-y-2.5 ${
                        currentSceneIndex === index
                          ? 'border-[var(--color-studio-accent)] bg-[var(--color-studio-paper-2)]'
                          : 'border-[var(--color-studio-rule)] bg-[var(--color-studio-paper)] hover:border-[var(--color-studio-rule-2)]'
                      }`}
                    >
                      <div className="relative aspect-video w-full overflow-hidden bg-black border border-[var(--color-studio-rule)]">
                        <img
                          src={sc.screenshotUrl}
                          alt={sc.title}
                          className="w-full h-full object-cover object-top opacity-60"
                        />
                        <span className="absolute bottom-1 right-1 px-1 py-0.5 text-[9px] font-mono bg-black/80 text-white">
                          {sc.timecode}
                        </span>
                        <span className="absolute top-1 left-1 px-1.5 py-0.5 text-[9px] font-mono bg-[var(--color-studio-paper)] text-[var(--color-studio-accent)]">
                          {sc.badge}
                        </span>
                      </div>

                      <div>
                        <span className="text-[11px] font-medium text-[var(--color-studio-muted)]">
                          Scene <span className="font-mono">0{index + 1}</span>
                        </span>
                        <h3 className="text-sm font-medium text-[var(--color-studio-ink)] line-clamp-1">
                          {sc.headline}
                        </h3>
                        <p className="text-xs text-[var(--color-studio-muted)] line-clamp-2 mt-0.5">
                          {sc.statement}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'code' && (
            <div className="flex-1 p-6 overflow-y-auto">
              <div className="max-w-4xl mx-auto space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="studio-head-display text-xl text-[var(--color-studio-ink)]">
                      Remotion Composition Code
                    </h2>
                    <p className="text-xs text-[var(--color-studio-muted)]">
                      Deployable React/TypeScript composition matching this video template exactly.
                    </p>
                  </div>
                  <button
                    onClick={handleCopyRemotionCode}
                    className="studio-btn flex items-center space-x-1.5 text-xs font-medium"
                  >
                    {copiedCode ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedCode ? 'Copied' : 'Copy Code'}</span>
                  </button>
                </div>

                <div className="p-4 border border-[var(--color-studio-rule)] bg-[var(--color-studio-paper-2)] font-mono text-xs overflow-x-auto text-[var(--color-studio-ink-2)] leading-relaxed">
                  <pre>{`// Remotion Composition for AIRA AI 2026 Feature Trailer
// Frame Rate: 30 fps · Total Duration: 900 frames (30.0s)
// Production URL: https://aira-ai-2026.vercel.app

import React from 'react';
import { Composition, Sequence, spring, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

export const AIRA_SHOWCASE_COMPOSITION: React.FC = () => {
  return (
    <Composition
      id="AiraMotionTrailer"
      component={AiraTrailerTimeline}
      durationInFrames={900}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{
        canonicalUrl: 'https://aira-ai-2026.vercel.app',
        contextWindow: '128K tokens',
        primaryInferenceEngine: 'Groq LPU (openai/gpt-oss-120b)',
        failoverEngine: 'Gemini 3.5 Flash-Lite (1M Context)',
        reasoningEngine: 'Groq Reasoning Effort with Gemini failover (NVIDIA Nemotron 70B experimental)'
      }}
    />
  );
};

const AiraTrailerTimeline = () => {
  return (
    <div style={{ backgroundColor: '#0e121a', width: '100%', height: '100%', fontFamily: 'Mona Sans, sans-serif' }}>
      {/* Scene 1: Intelligent Router & Truthful Architecture (0-5s) */}
      <Sequence from={0} durationInFrames={150}>
        <SceneCard title="AIRA AI 2026" headline="Cognitive Architecture" badge="Router" />
      </Sequence>

      {/* Scene 2: Ultra-Fast Groq LPU with Gemini Failover (5-10s) */}
      <Sequence from={150} durationInFrames={150}>
        <SceneCard title="AIRA Fast" headline="Groq LPU & Gemini Failover" badge="Groq LPU" />
      </Sequence>

      {/* Scene 3: Deep Reasoning with Calibrated Bounds (10-15s) */}
      <Sequence from={300} durationInFrames={150}>
        <SceneCard title="Deep Reasoning" headline="Calibrated Token Bounds & Effort" badge="Reasoning" />
      </Sequence>

      {/* Scene 4: Account-Scoped Onboarding Tour (15-20s) */}
      <Sequence from={450} durationInFrames={150}>
        <SceneCard title="Onboarding" headline="Interactive Tutorial Tour" badge="Guidance" />
      </Sequence>

      {/* Scene 5: Cognitive Settings & Enforced Safeguards (20-25s) */}
      <Sequence from={600} durationInFrames={150}>
        <SceneCard title="Settings" headline="Enforced Privacy Scrubbing" badge="Security" />
      </Sequence>

      {/* Scene 6: Production Workspace Launch (25-30s) */}
      <Sequence from={750} durationInFrames={150}>
        <SceneCard title="Live Release" headline="aira-ai-2026.vercel.app" badge="Production" />
      </Sequence>
    </div>
  );
};`}</pre>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Studio Bottom Timeline & Transport Strip */}
        <footer className="border-t border-[var(--color-studio-rule)] bg-[var(--color-studio-paper-2)] p-3 sm:p-4 select-none shrink-0">
          {/* Timeline Track with Scene Segments & Interactive Scrubber */}
          <div className="max-w-5xl mx-auto space-y-2.5">
            <div className="grid grid-cols-6 gap-2">
              {SHOWCASE_SCENES.map((sc, idx) => {
                const isCurrent = currentSceneIndex === idx;
                const isPassed = currentSceneIndex > idx;
                const sceneProgress = isCurrent ? progress : isPassed ? 1 : 0;

                return (
                  <button
                    key={sc.id}
                    onClick={() => handleSeekScene(idx)}
                    className={`group flex flex-col text-left p-1.5 rounded-lg border transition-all ${
                      isCurrent
                        ? 'border-[var(--color-studio-accent)] bg-[var(--color-studio-paper-3)]'
                        : 'border-[var(--color-studio-rule)] bg-[var(--color-studio-paper)] hover:border-[var(--color-studio-rule-2)]'
                    }`}
                    aria-label={`Jump to ${sc.title}`}
                  >
                    <div className="w-full h-1.5 bg-black/40 border border-white/5 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--color-studio-accent)] transition-all duration-75"
                        style={{ width: `${sceneProgress * 100}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between mt-1 min-w-0">
                      <span
                        className={`text-[11px] font-mono truncate ${
                          isCurrent
                            ? 'text-[var(--color-studio-accent)] font-bold'
                            : 'text-[var(--color-studio-muted)] group-hover:text-[var(--color-studio-ink)]'
                        }`}
                      >
                        0{idx + 1} {sc.badge}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Interactive Timeline Scrubber Slider */}
            <div className="flex items-center gap-3 px-1">
              <span className="text-[11px] font-mono text-stone-400">00:00</span>
              <input
                type="range"
                min="0"
                max="29.99"
                step="0.05"
                value={currentTotalSeconds}
                onChange={(e) => handleTimelineSeek(parseFloat(e.target.value))}
                aria-label="Timeline scrubber"
                className="flex-1 h-2 bg-stone-800 rounded-lg appearance-none cursor-pointer accent-[var(--color-studio-accent)]"
              />
              <span className="text-[11px] font-mono text-stone-400">00:30</span>
            </div>

            {/* Transport Controls Bar */}
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center space-x-2">
                <button
                  onClick={handlePrevScene}
                  className="p-2 sm:p-2.5 rounded-lg bg-[var(--color-studio-paper-3)] border border-[var(--color-studio-rule)] text-[var(--color-studio-muted)] hover:text-white transition-colors"
                  aria-label="Previous Scene"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>

                <button
                  onClick={handleTogglePlay}
                  className="p-2 sm:p-2.5 px-3.5 rounded-lg bg-[var(--color-studio-accent)] text-[var(--color-studio-accent-ink)] hover:opacity-90 font-bold transition-all shadow-md flex items-center gap-1.5"
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  <span className="text-xs font-semibold">{isPlaying ? 'Pause' : 'Play'}</span>
                </button>

                <button
                  onClick={handleNextScene}
                  className="p-2 sm:p-2.5 rounded-lg bg-[var(--color-studio-paper-3)] border border-[var(--color-studio-rule)] text-[var(--color-studio-muted)] hover:text-white transition-colors"
                  aria-label="Next Scene"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>

                <button
                  onClick={handleRestart}
                  className="p-2 sm:p-2.5 rounded-lg bg-[var(--color-studio-paper-3)] border border-[var(--color-studio-rule)] text-[var(--color-studio-muted)] hover:text-white transition-colors"
                  aria-label="Restart Timeline"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>

                <span className="text-xs font-mono text-[var(--color-studio-ink-2)] ml-2">
                  {timecodeString} <span className="text-[var(--color-studio-muted)]">/ 00:00:30:00</span>
                </span>
              </div>

              <div className="flex items-center space-x-3">
                {/* Speed Controls */}
                <div className="flex items-center space-x-1 text-xs">
                  <span className="text-xs font-medium text-[var(--color-studio-muted)]">Speed</span>
                  {[1, 1.5, 2].map((spd) => (
                    <button
                      key={spd}
                      onClick={() => setPlaybackSpeed(spd)}
                      className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                        playbackSpeed === spd
                          ? 'bg-[var(--color-studio-paper-3)] text-[var(--color-studio-accent)] font-bold'
                          : 'text-[var(--color-studio-muted)] hover:text-[var(--color-studio-ink)]'
                      }`}
                    >
                      {spd}x
                    </button>
                  ))}
                </div>

                {/* Audio toggle */}
                <button
                  onClick={() => setIsMuted(!isMuted)}
                  className="p-2 rounded-lg bg-[var(--color-studio-paper-3)] text-[var(--color-studio-muted)] hover:text-[var(--color-studio-ink)] transition-colors"
                  aria-label={isMuted ? 'Unmute Audio' : 'Mute Audio'}
                >
                  {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                </button>

                <a
                  href="https://aira-ai-2026.vercel.app"
                  target="_blank"
                  rel="noreferrer"
                  className="studio-btn studio-btn-primary text-xs flex items-center space-x-1.5 px-3 py-1.5 rounded-lg font-bold"
                >
                  <span>Launch Live</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
};
