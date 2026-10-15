import React, { useState, useEffect } from 'react';
import {
  Bot,
  Play,
  Plus,
  Trash2,
  Edit2,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Sparkles,
  RefreshCw,
  Cpu,
  ShieldAlert,
  Zap,
  X,
  Layers,
  Wrench
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { authenticatedApiFetch } from '../lib/neonAuth';

interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  modelPolicy: { model: string; provider?: string };
  tools: string[];
  memoryScopes: string[];
  approvalPolicy: 'always_ask' | 'risky_only' | 'autonomous';
  maxSteps: number;
  timeoutMs: number;
  createdAt?: number;
  updatedAt?: number;
}

interface AgentRunState {
  agentId: string;
  runId: string;
  state: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  content?: string;
  startedAt: number;
}

export const AgentsView: React.FC = () => {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Active run states
  const [activeRuns, setActiveRuns] = useState<AgentRunState[]>([]);
  const [runningAgentId, setRunningAgentId] = useState<string | null>(null);

  // Create Agent Modal State
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formInstructions, setFormInstructions] = useState('');
  const [formModel, setFormModel] = useState('aira-fast');
  const [formApproval, setFormApproval] = useState<'autonomous' | 'risky_only' | 'always_ask'>('risky_only');
  const [formTools, setFormTools] = useState<string[]>(['web_search', 'read_file']);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Run Mission Modal State
  const [missionAgent, setMissionAgent] = useState<AgentDefinition | null>(null);
  const [missionPrompt, setMissionPrompt] = useState('');
  const [isExecutingMission, setIsExecutingMission] = useState(false);
  const [missionOutput, setMissionOutput] = useState<{ runId: string; content?: string } | null>(null);

  const availableToolsList = [
    { id: 'web_search', label: 'Live Web Research (Tavily/Exa)' },
    { id: 'read_file', label: 'Read Workspace Files' },
    { id: 'write_file', label: 'Write Code / Files' },
    { id: 'run_command', label: 'Execute Shell Command' },
    { id: 'browser_action', label: 'Browser Automation' }
  ];

  const fetchAgents = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authenticatedApiFetch('/api/agents');
      if (!res.ok) throw new Error('Failed to fetch agents registry.');
      const data = await res.json();
      setAgents(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAgents();
  }, []);

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim() || !formInstructions.trim()) {
      setFormError('Agent Name and Instructions are required.');
      return;
    }
    setIsSubmitting(true);
    setFormError(null);
    try {
      const res = await authenticatedApiFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          description: formDescription.trim(),
          instructions: formInstructions.trim(),
          modelPolicy: { model: formModel },
          tools: formTools,
          approvalPolicy: formApproval,
          memoryScopes: ['workspace'],
          maxSteps: 10,
          timeoutPolicy: { maxMs: 60000 }
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create agent.');
      }
      setIsCreateOpen(false);
      setFormName('');
      setFormDescription('');
      setFormInstructions('');
      await fetchAgents();
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteAgent = async (id: string) => {
    if (!confirm('Are you sure you want to delete this agent?')) return;
    try {
      const res = await authenticatedApiFetch(`/api/agents/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Failed to delete agent.');
      await fetchAgents();
    } catch (err: any) {
      alert(`Deletion error: ${err.message}`);
    }
  };

  const handleStartMission = async (agent: AgentDefinition) => {
    setMissionAgent(agent);
    setMissionPrompt(agent.instructions);
    setMissionOutput(null);
  };

  const handleExecuteMissionRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!missionAgent) return;
    setIsExecutingMission(true);
    try {
      const res = await authenticatedApiFetch(`/api/agents/${encodeURIComponent(missionAgent.id)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: missionPrompt.trim() })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Agent run failed.');
      }
      const data = await res.json();
      setMissionOutput({ runId: data.runId, content: data.content });
      setActiveRuns(prev => [
        {
          agentId: missionAgent.id,
          runId: data.runId,
          state: data.state || 'COMPLETED',
          content: data.content,
          startedAt: Date.now()
        },
        ...prev.slice(0, 9)
      ]);
    } catch (err: any) {
      alert(`Execution error: ${err.message}`);
    } finally {
      setIsExecutingMission(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-claude-bg-light dark:bg-claude-bg-dark text-claude-text-light dark:text-claude-text-dark">
      {/* Header */}
      <div className="border-b border-claude-border-light dark:border-claude-border-dark px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-claude-surface-light/50 dark:bg-claude-surface-dark/50 backdrop-blur-sm">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-claude-terracotta/10 text-claude-accentInk flex items-center justify-center">
              <Bot className="w-4 h-4" />
            </div>
            <h1 className="text-xl font-serif font-medium tracking-tight">Autonomous Agents</h1>
            <span className="text-xs px-2 py-0.5 rounded-full font-mono bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              {agents.length} Registered
            </span>
          </div>
          <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mt-1">
            Deterministic multi-step agent execution with tool gating, permission kernel, and human-in-the-loop approvals.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => fetchAgents()}
            className="p-2 rounded-xl border border-claude-border-light dark:border-claude-border-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light transition-all"
            title="Refresh Agents"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setIsCreateOpen(true)}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-claude-terracotta hover:bg-[#d97757]/90 text-white font-medium text-xs shadow-sm shadow-claude-terracotta/20 transition-all active:scale-95"
          >
            <Plus className="w-4 h-4" />
            <span>Create Agent</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {error && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-claude-muted-light dark:text-claude-muted-dark">
            <RefreshCw className="w-6 h-6 animate-spin text-claude-accentInk mb-2" />
            <p className="text-xs">Loading agent definitions...</p>
          </div>
        ) : agents.length === 0 ? (
          <div className="text-center py-20 flex flex-col items-center justify-center">
            <Bot className="w-10 h-10 text-claude-muted-light mb-3" />
            <h3 className="font-serif text-base font-medium">No agents found</h3>
            <p className="text-xs text-claude-muted-light max-w-sm mt-1 mb-4">
              Create an autonomous agent with specific instructions and tool capabilities.
            </p>
            <button
              onClick={() => setIsCreateOpen(true)}
              className="px-4 py-2 rounded-xl bg-claude-terracotta text-white font-medium text-xs"
            >
              Create Default Agent
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {agents.map((agent) => (
              <motion.div
                key={agent.id}
                layout
                className="p-5 rounded-2xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-sm hover:border-claude-terracotta/40 hover:shadow-md transition-all flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-start justify-between gap-3 mb-2.5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark flex items-center justify-center text-claude-accentInk">
                        <Bot className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="font-serif font-medium text-sm leading-snug">{agent.name}</h3>
                        <span className="text-[10px] font-mono text-claude-muted-light dark:text-claude-muted-dark">
                          {agent.id}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`text-[9px] font-mono uppercase px-2 py-0.5 rounded-full font-bold ${
                        agent.approvalPolicy === 'autonomous'
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                          : agent.approvalPolicy === 'risky_only'
                          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                          : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'
                      }`}
                    >
                      {agent.approvalPolicy.replace('_', ' ')}
                    </span>
                  </div>

                  <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark line-clamp-3 mb-3 leading-relaxed">
                    {agent.description || agent.instructions}
                  </p>

                  <div className="space-y-1.5 mb-4">
                    <div className="flex items-center gap-1.5 text-[11px] text-claude-muted-light dark:text-claude-muted-dark">
                      <Cpu className="w-3.5 h-3.5 text-claude-accentInk" />
                      <span className="font-mono">Model: {agent.modelPolicy?.model || 'aira-fast'}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-claude-muted-light dark:text-claude-muted-dark">
                      <Wrench className="w-3.5 h-3.5 text-claude-accentInk" />
                      <span>{agent.tools?.length || 0} Tools Enabled</span>
                    </div>
                  </div>
                </div>

                <div className="border-t border-claude-border-light/60 dark:border-claude-border-dark/60 pt-3 flex items-center justify-between">
                  <button
                    onClick={() => handleStartMission(agent)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-claude-terracotta/10 hover:bg-claude-terracotta text-claude-accentInk hover:text-white font-medium text-xs transition-all active:scale-95"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Run Mission</span>
                  </button>

                  {agent.id !== 'agent-default' && (
                    <button
                      onClick={() => handleDeleteAgent(agent.id)}
                      className="p-1.5 rounded-lg text-claude-muted-light hover:text-rose-500 hover:bg-rose-500/10 transition-colors"
                      title="Delete Agent"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        )}

        {/* Recent Runs History */}
        {activeRuns.length > 0 && (
          <div className="mt-8 p-5 rounded-2xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark">
            <h3 className="font-serif font-medium text-sm mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4 text-claude-accentInk" />
              <span>Recent Mission Executions</span>
            </h3>
            <div className="space-y-2">
              {activeRuns.map((r) => (
                <div
                  key={r.runId}
                  className="p-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-claude-accentInk font-bold">
                      {r.runId}
                    </span>
                    <span className="text-claude-muted-light">({r.agentId})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 font-bold">
                      {r.state}
                    </span>
                    <span className="text-[10px] text-claude-muted-light">
                      {new Date(r.startedAt).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Create Agent Modal */}
      <AnimatePresence>
        {isCreateOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-lg rounded-2xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-2xl p-6"
            >
              <div className="flex items-center justify-between pb-4 border-b border-claude-border-light dark:border-claude-border-dark">
                <h3 className="font-serif font-medium text-base">Create Autonomous Agent</h3>
                <button
                  onClick={() => setIsCreateOpen(false)}
                  className="p-1 rounded-lg text-claude-muted-light hover:text-claude-text-light"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {formError && (
                <div className="mt-3 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-500 text-xs">
                  {formError}
                </div>
              )}

              <form onSubmit={handleCreateAgent} className="mt-4 space-y-3.5">
                <div>
                  <label className="block text-xs font-medium text-claude-muted-light mb-1">
                    Agent Name
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Code Review Architect or Research Analyst"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-claude-muted-light mb-1">
                    Description
                  </label>
                  <input
                    type="text"
                    placeholder="Brief description of the agent's objective"
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-claude-muted-light mb-1">
                    System Instructions (Prompt)
                  </label>
                  <textarea
                    required
                    rows={4}
                    placeholder="Describe how the agent behaves, reasons, and executes tasks..."
                    value={formInstructions}
                    onChange={(e) => setFormInstructions(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs font-mono bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta resize-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-claude-muted-light mb-1">
                      Inference Model
                    </label>
                    <select
                      value={formModel}
                      onChange={(e) => setFormModel(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl text-xs bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta"
                    >
                      <option value="aira-fast">Aira Fast (NVIDIA Nemotron)</option>
                      <option value="aira-pro">Aira Pro (High Precision)</option>
                      <option value="aira-auto">Aira Auto (Dynamic Router)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-claude-muted-light mb-1">
                      Approval Policy
                    </label>
                    <select
                      value={formApproval}
                      onChange={(e) => setFormApproval(e.target.value as any)}
                      className="w-full px-3 py-2 rounded-xl text-xs bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta"
                    >
                      <option value="risky_only">Risky Only (Recommended)</option>
                      <option value="always_ask">Always Ask</option>
                      <option value="autonomous">Fully Autonomous</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsCreateOpen(false)}
                    className="px-3 py-1.5 rounded-xl text-xs text-claude-muted-light hover:text-claude-text-light"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-4 py-1.5 rounded-xl bg-claude-terracotta hover:bg-[#d97757]/90 text-white text-xs font-medium disabled:opacity-50"
                  >
                    {isSubmitting ? 'Registering...' : 'Create Agent'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Run Mission Modal */}
      <AnimatePresence>
        {missionAgent && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-xl max-h-[85vh] flex flex-col rounded-2xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-2xl p-6"
            >
              <div className="flex items-center justify-between pb-4 border-b border-claude-border-light dark:border-claude-border-dark">
                <div className="flex items-center gap-2">
                  <Play className="w-4 h-4 text-claude-accentInk fill-current" />
                  <h3 className="font-serif font-medium text-base">Launch Mission: {missionAgent.name}</h3>
                </div>
                <button
                  onClick={() => setMissionAgent(null)}
                  className="p-1 rounded-lg text-claude-muted-light hover:text-claude-text-light"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleExecuteMissionRun} className="flex-1 flex flex-col py-4 space-y-4 overflow-hidden">
                <div>
                  <label className="block text-xs font-medium text-claude-muted-light mb-1">
                    Mission Objective & Prompt
                  </label>
                  <textarea
                    rows={4}
                    value={missionPrompt}
                    onChange={(e) => setMissionPrompt(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs font-mono bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta resize-none"
                    placeholder="Enter mission prompt..."
                  />
                </div>

                {missionOutput && (
                  <div className="flex-1 min-h-0 flex flex-col">
                    <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 mb-1 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Mission Output ({missionOutput.runId})
                    </span>
                    <div className="flex-1 overflow-y-auto p-3 rounded-xl bg-claude-surface2-light dark:bg-black/30 border border-claude-border-light dark:border-claude-border-dark font-mono text-xs whitespace-pre-wrap leading-relaxed">
                      {missionOutput.content || 'Execution completed with return code 0.'}
                    </div>
                  </div>
                )}

                <div className="pt-2 flex items-center justify-between">
                  <span className="text-[10px] text-claude-muted-light">
                    Executed via server-authoritative agent runtime
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setMissionAgent(null)}
                      className="px-3 py-1.5 rounded-xl text-xs text-claude-muted-light"
                    >
                      Close
                    </button>
                    <button
                      type="submit"
                      disabled={isExecutingMission}
                      className="px-4 py-1.5 rounded-xl bg-claude-terracotta hover:bg-[#d97757]/90 text-white text-xs font-medium flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {isExecutingMission ? (
                        <>
                          <RefreshCw className="w-3 h-3 animate-spin" />
                          <span>Running Mission...</span>
                        </>
                      ) : (
                        <>
                          <Play className="w-3 h-3 fill-current" />
                          <span>Start Run</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
