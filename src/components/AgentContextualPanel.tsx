import React, { useEffect, useRef, useState } from 'react';
import { 
  Bot, 
  CheckCircle2, 
  Download, 
  ExternalLink, 
  FileCode2, 
  Loader2, 
  Play, 
  Plus, 
  Square, 
  Terminal, 
  Wrench, 
  X, 
  Maximize2, 
  Minimize2,
  Layers,
  ShieldCheck,
  RotateCw,
  Users
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ModelId } from '../types';
import { AgentsView } from './AgentsView';
import { 
  builderStatus, 
  cancelBuilder, 
  downloadBuilderFile, 
  streamBuilder, 
  type BuilderEvent, 
  type BuilderStatus 
} from '../utils/builderClient';

export interface ToolStep {
  id: string;
  name: string;
  label: string;
  state: 'running' | 'done' | 'error';
  output?: unknown;
}

export interface FileResult {
  title: string;
  path: string;
  bytes: number;
  url: string;
  expiresAt: number;
}

interface AgentContextualPanelProps {
  isOpen: boolean;
  onClose: () => void;
  model: ModelId;
  activePrompt?: string;
  onActivePromptConsumed?: () => void;
  onToolStepUpdate?: (step: ToolStep) => void;
  onPreviewAvailable?: (url: string) => void;
}

type AgentPanelTab = 'preview' | 'files' | 'activity' | 'timeline' | 'saved';

export const AgentContextualPanel: React.FC<AgentContextualPanelProps> = ({
  isOpen,
  onClose,
  model,
  activePrompt,
  onActivePromptConsumed,
  onToolStepUpdate,
  onPreviewAvailable
}) => {
  const [activeTab, setActiveTab] = useState<AgentPanelTab>('preview');
  const [isExpanded, setIsExpanded] = useState(false);
  const [status, setStatus] = useState<BuilderStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  
  const [prompt, setPrompt] = useState('');
  const [allowExecution, setAllowExecution] = useState(true);
  const [allowInternet, setAllowInternet] = useState(true);
  const [allowPreview, setAllowPreview] = useState(true);
  const [hasWorkspace, setHasWorkspace] = useState(false);
  
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<ToolStep[]>([]);
  const [files, setFiles] = useState<FileResult[]>([]);
  const [preview, setPreview] = useState('');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  const [activity, setActivity] = useState('');
  const [expires, setExpires] = useState(0);
  const [provenance, setProvenance] = useState('');
  
  const controller = useRef<AbortController | null>(null);
  const ticket = useRef('');
  const active = useRef(false);
  const mounted = useRef(true);
  const [clock, setClock] = useState(() => Date.now());

  const refreshStatus = () => {
    setStatusError('');
    builderStatus()
      .then(s => { if (mounted.current) setStatus(s); })
      .catch(e => { if (mounted.current) setStatusError(e.message); });
  };

  useEffect(() => {
    mounted.current = true;
    refreshStatus();
    const timer = setInterval(() => setClock(Date.now()), 10000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      if (active.current) controller.current?.abort();
      if (ticket.current) void cancelBuilder(ticket.current, true).catch(() => {});
    };
  }, []);

  // When active prompt passed from chat
  useEffect(() => {
    if (activePrompt && activePrompt.trim() && !busy) {
      setPrompt(activePrompt);
      if (onActivePromptConsumed) onActivePromptConsumed();
    }
  }, [activePrompt, busy, onActivePromptConsumed]);

  const expired = expires > 0 && clock >= expires;

  const onEvent = ({ type, data }: BuilderEvent) => {
    if (!mounted.current) return;
    if (type === 'builder.started') {
      ticket.current = data.workspaceTicket;
      setHasWorkspace(true);
      setExpires(data.expiresAt);
    }
    if (type === 'builder.status') setActivity(data.text);
    if (type === 'builder.tool.started') {
      const step: ToolStep = { id: data.id, name: data.name, label: data.label, state: 'running' };
      setSteps(s => [...s, step]);
      if (onToolStepUpdate) onToolStepUpdate(step);
    }
    if (type === 'builder.tool.completed') {
      const stepState = data.isError ? 'error' : 'done';
      setSteps(s => s.map(t => t.id === data.id ? { ...t, state: stepState, output: data.output } : t));
      if (onToolStepUpdate) onToolStepUpdate({ id: data.id, name: '', label: '', state: stepState, output: data.output });
    }
    if (type === 'builder.file') {
      setFiles(f => [...f.filter(x => x.path !== data.path), data as FileResult]);
      if (activeTab === 'preview' && !preview) setActiveTab('files');
    }
    if (type === 'builder.preview' && /^https:\/\/[a-zA-Z0-9.-]+\/$/.test(data.url)) {
      setPreview(data.url);
      setActiveTab('preview');
      if (onPreviewAvailable) onPreviewAvailable(data.url);
    }
    if (type === 'model.provenance') {
      setProvenance(`${data.provider} · ${data.executedModel}${data.verified ? '' : ' · upstream unconfirmed'}`);
    }
    if (type === 'builder.completed') {
      setSummary(data.summary);
      setActivity('Completed');
    }
    if (type === 'builder.error') {
      setError(data.error);
      ticket.current = '';
      setHasWorkspace(false);
      setPreview('');
      setFiles([]);
      setSteps(s => s.map(t => t.state === 'running' ? { ...t, state: 'error' } : t));
    }
  };

  const handleRun = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (busy || !allowExecution || !status?.ready || !prompt.trim() || expired) return;
    setBusy(true);
    active.current = true;
    setSteps([]);
    setFiles([]);
    setSummary('');
    setError('');
    setActivity('Connecting to isolated sandbox…');
    controller.current = new AbortController();

    try {
      await streamBuilder(
        {
          prompt,
          model,
          allowExecution: true,
          allowInternet,
          allowPreview,
          ...(ticket.current ? { workspaceTicket: ticket.current } : {})
        },
        controller.current.signal,
        onEvent
      );
    } catch (err: any) {
      if (mounted.current) {
        setError(err.name === 'AbortError' ? 'Execution stopped.' : err.message);
        setFiles([]);
        setPreview('');
        ticket.current = '';
        setHasWorkspace(false);
        setSteps(s => s.map(t => t.state === 'running' ? { ...t, state: 'error' } : t));
      }
    } finally {
      active.current = false;
      if (mounted.current) {
        setBusy(false);
        setActivity('');
      }
    }
  };

  const handleStop = async () => {
    const token = ticket.current;
    controller.current?.abort();
    ticket.current = '';
    setHasWorkspace(false);
    setFiles([]);
    setPreview('');
    if (token) {
      try {
        await cancelBuilder(token);
      } catch (err: any) {
        setError(err.message);
      }
    }
  };

  const handleReset = async () => {
    const old = ticket.current;
    ticket.current = '';
    setHasWorkspace(false);
    if (old) void cancelBuilder(old).catch(() => {});
    setSteps([]);
    setFiles([]);
    setPreview('');
    setSummary('');
    setExpires(0);
    setError('');
    setProvenance('');
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.aside
        initial={{ x: '100%', opacity: 0.5 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: '100%', opacity: 0.5 }}
        transition={{ type: 'spring', stiffness: 250, damping: 25, mass: 0.8 }}
        data-testid="agent-contextual-panel"
        className={`${
          isExpanded ? 'fixed inset-y-0 right-0 z-[60] w-full' : 'fixed inset-y-0 right-0 z-50 w-full xl:relative xl:inset-auto xl:z-40 xl:w-[48vw]'
        } h-[100dvh] min-w-0 flex flex-col bg-claude-surface-light dark:bg-[#111C35] border-l border-claude-border-light dark:border-white/10 shadow-2xl xl:shadow-none flex-shrink-0 transition-colors`}
      >
        {/* Top Header */}
        <div className="min-h-[56px] px-3 sm:px-4 py-2 flex items-center justify-between border-b border-claude-border-light dark:border-white/10 bg-claude-surface-light/95 dark:bg-[#111C35]/95 backdrop-blur-md select-none">
          <div className="flex items-center space-x-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-aira-blue/15 text-aira-blue flex items-center justify-center border border-aira-blue/30 shrink-0">
              <Bot className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h2 className="text-[13px] font-semibold text-claude-text-light dark:text-white truncate">
                  Agent Workspace & Sandbox
                </h2>
                <span className="rounded-full bg-aira-blue/20 px-1.5 py-0.5 text-[9px] font-semibold text-aira-blue dark:text-aira-silver">
                  LIVE
                </span>
              </div>
              <p className="text-[10px] text-claude-muted-light dark:text-slate-400 truncate">
                {activity || (busy ? 'Executing tools…' : preview ? 'Live sandbox running' : 'Ready for execution')}
              </p>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="hidden sm:inline-flex p-1.5 rounded-lg text-claude-muted-light dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              title={isExpanded ? 'Collapse panel' : 'Expand panel'}
            >
              {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-claude-muted-light dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              title="Close panel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tab Selector */}
        <div className="flex items-center border-b border-claude-border-light dark:border-white/10 px-3 bg-claude-surface2-light/50 dark:bg-black/20 overflow-x-auto">
          {[
            { id: 'preview' as const, label: 'Live Preview', icon: ExternalLink, count: preview ? 1 : 0 },
            { id: 'files' as const, label: 'Files', icon: FileCode2, count: files.length },
            { id: 'activity' as const, label: 'Activity', icon: Terminal, count: steps.length },
            { id: 'timeline' as const, label: 'Mission & Config', icon: ShieldCheck, count: 0 },
            { id: 'saved' as const, label: 'Agents', icon: Users, count: 0 },
          ].map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
                  active
                    ? 'border-aira-blue text-aira-blue dark:text-aira-silver font-semibold'
                    : 'border-transparent text-claude-muted-light dark:text-slate-400 hover:text-claude-text-light dark:hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
                {tab.count > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-aira-blue/20 text-aira-blue dark:text-white">
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 text-xs">
          {activeTab === 'preview' && (
            <div className="h-full flex flex-col space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-claude-text-light dark:text-white">
                  Sandbox Server Output
                </span>
                {preview && !expired && (
                  <a
                    href={preview}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-aira-blue hover:underline"
                  >
                    Open separate window <ExternalLink size={12} />
                  </a>
                )}
              </div>

              {preview && !expired ? (
                <div className="flex-1 min-h-[360px] border border-claude-border-light dark:border-white/10 rounded-xl overflow-hidden bg-white shadow-inner">
                  <iframe
                    title="Aira Sandbox Preview"
                    src={preview}
                    sandbox="allow-scripts allow-forms allow-modals"
                    referrerPolicy="no-referrer"
                    className="w-full h-full min-h-[400px] border-0"
                  />
                </div>
              ) : (
                <div className="flex-1 min-h-[280px] flex flex-col items-center justify-center border border-dashed border-claude-border-light dark:border-white/10 rounded-xl p-8 text-center text-claude-muted-light dark:text-slate-400">
                  <FileCode2 className="w-10 h-10 mb-2 opacity-40 text-aira-blue" />
                  <p className="font-medium">
                    {expired
                      ? 'The isolated preview has expired.'
                      : busy
                      ? 'Building sandbox environment and starting server…'
                      : 'No live preview currently running.'}
                  </p>
                  <p className="mt-1 text-[11px] opacity-75">
                    Start a build task in Agent Mode to spawn a sandboxed runtime.
                  </p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'files' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-claude-text-light dark:text-white">
                  Generated Workspace Deliverables
                </h3>
                <span className="text-[11px] text-claude-muted-light dark:text-slate-400">
                  {files.length} {files.length === 1 ? 'file' : 'files'}
                </span>
              </div>

              {files.length === 0 ? (
                <div className="p-8 text-center text-claude-muted-light dark:text-slate-400 border border-dashed border-claude-border-light dark:border-white/10 rounded-xl">
                  No files have been generated yet for this workspace.
                </div>
              ) : (
                <div className="space-y-2">
                  {files.map(f => (
                    <div
                      key={f.path}
                      className="flex items-center justify-between p-3 rounded-xl border border-claude-border-light dark:border-white/10 bg-white/40 dark:bg-white/[0.02]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-claude-text-light dark:text-white truncate">
                          {f.title || f.path.split('/').pop()}
                        </div>
                        <div className="text-[10px] text-claude-muted-light dark:text-slate-400 font-mono">
                          {f.path} · {Math.ceil(f.bytes / 1024)} KB
                        </div>
                      </div>
                      <button
                        onClick={() => downloadBuilderFile(f.url, f.path.split('/').pop() || 'file')}
                        disabled={expired || busy}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-aira-blue/15 text-aira-blue hover:bg-aira-blue/25 transition-colors font-medium"
                      >
                        <Download size={13} />
                        <span>Download</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'activity' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-claude-text-light dark:text-white">
                  Tool Execution Activity
                </h3>
                {busy && (
                  <span className="flex items-center gap-1 text-amber-500 font-medium">
                    <Loader2 size={12} className="animate-spin" /> Running
                  </span>
                )}
              </div>

              {steps.length === 0 ? (
                <div className="p-8 text-center text-claude-muted-light dark:text-slate-400 border border-dashed border-claude-border-light dark:border-white/10 rounded-xl">
                  Tool execution telemetry will display here in real time.
                </div>
              ) : (
                <div className="space-y-2">
                  {steps.map(step => (
                    <div
                      key={step.id}
                      className="p-3 rounded-xl border border-claude-border-light dark:border-white/10 bg-white/40 dark:bg-white/[0.02] space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 font-mono font-medium text-claude-text-light dark:text-white">
                          {step.state === 'running' ? (
                            <Loader2 size={13} className="text-amber-500 animate-spin" />
                          ) : step.state === 'done' ? (
                            <CheckCircle2 size={13} className="text-emerald-500" />
                          ) : (
                            <Wrench size={13} className="text-rose-500" />
                          )}
                          <span>{step.name.replaceAll('_', ' ')}</span>
                        </div>
                        <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
                          step.state === 'running' ? 'bg-amber-500/10 text-amber-500' :
                          step.state === 'done' ? 'bg-emerald-500/10 text-emerald-500' :
                          'bg-rose-500/10 text-rose-500'
                        }`}>
                          {step.state}
                        </span>
                      </div>
                      <p className="text-[11px] text-claude-muted-light dark:text-slate-400 break-words">
                        {step.label}
                      </p>
                      {step.output !== undefined && (
                        <details className="mt-1 pt-1 border-t border-black/5 dark:border-white/5">
                          <summary className="cursor-pointer text-[10px] text-aira-blue hover:underline">
                            View output payload
                          </summary>
                          <pre className="mt-1 p-2 rounded bg-black/10 dark:bg-black/40 text-[10px] font-mono overflow-x-auto max-h-36">
                            {JSON.stringify(step.output, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'timeline' && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl border border-claude-border-light dark:border-white/10 bg-white/40 dark:bg-white/[0.02] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-claude-text-light dark:text-white">Sandbox Provider Status</span>
                  <button onClick={refreshStatus} className="text-aira-blue hover:underline flex items-center gap-1 text-[11px]">
                    <RotateCw size={11} /> Refresh
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div><span className="text-claude-muted-light dark:text-slate-400">Provider:</span> {status?.sandboxProvider || 'Lightning'}</div>
                  <div><span className="text-claude-muted-light dark:text-slate-400">Status:</span> {status?.ready ? 'Ready' : 'Checking…'}</div>
                  <div><span className="text-claude-muted-light dark:text-slate-400">TTL:</span> {status?.workspaceTtlMinutes || 15}m</div>
                  <div><span className="text-claude-muted-light dark:text-slate-400">Runtime:</span> {status?.runtime || 'node24'}</div>
                </div>
              </div>

              <div className="p-3.5 rounded-xl border border-claude-border-light dark:border-white/10 bg-white/40 dark:bg-white/[0.02] space-y-2">
                <span className="font-semibold text-claude-text-light dark:text-white">Sandbox Permissions</span>
                <div className="space-y-2 text-[11px] text-claude-muted-light dark:text-slate-400">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={allowExecution} onChange={e => setAllowExecution(e.target.checked)} className="mt-0.5" />
                    <span>Authorize file creation and isolated command execution.</span>
                  </label>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={allowInternet} onChange={e => setAllowInternet(e.target.checked)} className="mt-0.5" />
                    <span>Allow outbound internet access for packages.</span>
                  </label>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={allowPreview} onChange={e => setAllowPreview(e.target.checked)} className="mt-0.5" />
                    <span>Allow public sandbox preview URL.</span>
                  </label>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {busy ? (
                  <button
                    onClick={handleStop}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl border border-rose-500/30 text-rose-500 hover:bg-rose-500/10 font-medium"
                  >
                    <Square size={13} />
                    <span>Stop Execution</span>
                  </button>
                ) : (
                  <button
                    onClick={() => handleRun()}
                    disabled={!prompt.trim() || !status?.ready}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-aira-blue text-white hover:bg-aira-blue/90 disabled:opacity-40 font-medium"
                  >
                    <Play size={13} />
                    <span>Execute in Sandbox</span>
                  </button>
                )}
                <button
                  onClick={handleReset}
                  disabled={busy}
                  className="px-3 py-2 rounded-xl border border-claude-border-light dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
                  title="Reset workspace"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          )}

          {activeTab === 'saved' && (
            <div className="h-full">
              <AgentsView />
            </div>
          )}
        </div>
      </motion.aside>
    </AnimatePresence>
  );
};
