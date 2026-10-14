import React, { useState, useEffect } from 'react';
import {
  Workflow,
  Play,
  Plus,
  Trash2,
  Clock,
  CheckCircle2,
  AlertCircle,
  ToggleLeft,
  ToggleRight,
  RefreshCw,
  Calendar,
  X,
  Activity,
  History,
  ShieldCheck
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface AutomationDefinition {
  id: string;
  principalId?: string;
  name: string;
  enabled: boolean;
  trigger: 'MANUAL' | 'CRON' | 'EVENT' | 'WEBHOOK';
  cronExpression?: string;
  conditions?: Record<string, any>;
  agentId: string;
  objective: string;
  approvalPolicy: 'always_ask' | 'risky_only' | 'autonomous';
  lastRun?: number;
  nextRun?: number;
  failureState?: string;
  createdAt?: number;
}

interface AutomationRun {
  id: string;
  automationId: string;
  scheduledFor: number;
  startedAt: number;
  completedAt?: number;
  status: 'CLAIMED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  error?: string;
}

export const AutomationsView: React.FC = () => {
  const [automations, setAutomations] = useState<AutomationDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create Modal State
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [formName, setFormName] = useState('');
  const [formTrigger, setFormTrigger] = useState<'CRON' | 'MANUAL'>('CRON');
  const [formCron, setFormCron] = useState('0 9 * * 1-5'); // Default: Weekdays at 9am
  const [formAgentId, setFormAgentId] = useState('agent-default');
  const [formObjective, setFormObjective] = useState('');
  const [formApproval, setFormApproval] = useState<'autonomous' | 'risky_only'>('autonomous');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Runs History Modal State
  const [selectedAutomation, setSelectedAutomation] = useState<AutomationDefinition | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  const fetchAutomations = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/automations');
      if (!res.ok) throw new Error('Failed to load automations.');
      const data = await res.json();
      setAutomations(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAutomations();
  }, []);

  const handleToggleEnable = async (auto: AutomationDefinition) => {
    const action = auto.enabled ? 'disable' : 'enable';
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(auto.id)}/${action}`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error(`Failed to ${action} automation.`);
      await fetchAutomations();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleTriggerNow = async (id: string) => {
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(id)}/trigger`, {
        method: 'POST'
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Trigger failed.');
      }
      alert('Automation triggered successfully!');
      await fetchAutomations();
    } catch (err: any) {
      alert(`Trigger error: ${err.message}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this automation schedule?')) return;
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Failed to delete automation.');
      await fetchAutomations();
    } catch (err: any) {
      alert(`Delete error: ${err.message}`);
    }
  };

  const handleViewRuns = async (auto: AutomationDefinition) => {
    setSelectedAutomation(auto);
    setRunsLoading(true);
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(auto.id)}/runs`);
      if (res.ok) {
        const data = await res.json();
        setRuns(Array.isArray(data) ? data : []);
      }
    } catch {
      setRuns([]);
    } finally {
      setRunsLoading(false);
    }
  };

  const handleCreateAutomation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim() || !formObjective.trim()) {
      setFormError('Name and objective are required.');
      return;
    }
    setIsSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          trigger: formTrigger,
          cronExpression: formTrigger === 'CRON' ? formCron.trim() : undefined,
          agentId: formAgentId,
          objective: formObjective.trim(),
          approvalPolicy: formApproval,
          enabled: true
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create automation.');
      }
      setIsCreateOpen(false);
      setFormName('');
      setFormObjective('');
      await fetchAutomations();
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatScheduleText = (cron?: string) => {
    if (!cron) return 'Manual Trigger';
    if (cron === '0 0 * * *') return 'Daily at midnight';
    if (cron === '0 9 * * 1-5') return 'Weekdays at 9:00 AM';
    if (cron === '*/15 * * * *') return 'Every 15 minutes';
    if (cron === '0 * * * *') return 'Hourly at :00';
    return cron;
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-claude-bg-light dark:bg-claude-bg-dark text-claude-text-light dark:text-claude-text-dark">
      {/* Header */}
      <div className="border-b border-claude-border-light dark:border-claude-border-dark px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-claude-surface-light/50 dark:bg-claude-surface-dark/50 backdrop-blur-sm">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-claude-terracotta/10 text-claude-accentInk flex items-center justify-center">
              <Workflow className="w-4 h-4" />
            </div>
            <h1 className="text-xl font-serif font-medium tracking-tight">Workflow Automations</h1>
            <span className="text-xs px-2 py-0.5 rounded-full font-mono bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              {automations.filter(a => a.enabled).length} Active
            </span>
          </div>
          <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mt-1">
            Scheduled recurring background jobs, telemetry audits, and automated agent workflows.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => fetchAutomations()}
            className="p-2 rounded-xl border border-claude-border-light dark:border-claude-border-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light transition-all"
            title="Refresh Automations"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setIsCreateOpen(true)}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-claude-terracotta hover:bg-[#d97757]/90 text-white font-medium text-xs shadow-sm shadow-claude-terracotta/20 transition-all active:scale-95"
          >
            <Plus className="w-4 h-4" />
            <span>Create Automation</span>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {error && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-claude-muted-light dark:text-claude-muted-dark">
            <RefreshCw className="w-6 h-6 animate-spin text-claude-accentInk mb-2" />
            <p className="text-xs">Loading workflow schedules...</p>
          </div>
        ) : automations.length === 0 ? (
          <div className="text-center py-20 flex flex-col items-center justify-center">
            <Workflow className="w-10 h-10 text-claude-muted-light mb-3" />
            <h3 className="font-serif text-base font-medium">No active automations</h3>
            <p className="text-xs text-claude-muted-light max-w-sm mt-1 mb-4">
              Schedule automated runs for health monitoring, report generation, or knowledge refreshes.
            </p>
            <button
              onClick={() => setIsCreateOpen(true)}
              className="px-4 py-2 rounded-xl bg-claude-terracotta text-white font-medium text-xs"
            >
              Create First Automation
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {automations.map((auto) => (
              <motion.div
                key={auto.id}
                layout
                className={`p-5 rounded-2xl border transition-all ${
                  auto.enabled
                    ? 'bg-claude-surface-light dark:bg-claude-surface-dark border-claude-border-light dark:border-claude-border-dark shadow-sm'
                    : 'bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 border-claude-border-light/50 dark:border-claude-border-dark/50 opacity-75'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2.5">
                      <h3 className="font-serif font-medium text-sm text-claude-text-light dark:text-claude-text-dark">
                        {auto.name}
                      </h3>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light">
                        {auto.trigger}
                      </span>
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold ${
                          auto.enabled
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                            : 'bg-stone-500/10 text-stone-600 dark:text-stone-400 border border-stone-500/20'
                        }`}
                      >
                        {auto.enabled ? 'ACTIVE' : 'PAUSED'}
                      </span>
                    </div>

                    <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark line-clamp-2">
                      {auto.objective}
                    </p>

                    <div className="flex flex-wrap items-center gap-4 pt-1 text-[11px] font-mono text-claude-muted-light dark:text-claude-muted-dark">
                      <div className="flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5 text-claude-accentInk" />
                        <span>Schedule: {formatScheduleText(auto.cronExpression)}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Activity className="w-3.5 h-3.5 text-claude-accentInk" />
                        <span>Agent: {auto.agentId}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 border-t sm:border-t-0 pt-3 sm:pt-0 border-claude-border-light/60 dark:border-claude-border-dark/60">
                    <button
                      onClick={() => handleTriggerNow(auto.id)}
                      className="p-2 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark hover:bg-claude-terracotta/10 text-claude-text-light hover:text-claude-accentInk transition-all"
                      title="Trigger Execution Now"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                    </button>

                    <button
                      onClick={() => handleViewRuns(auto)}
                      className="p-2 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark hover:bg-claude-surface-light text-claude-text-light transition-all"
                      title="View Run History"
                    >
                      <History className="w-3.5 h-3.5" />
                    </button>

                    <button
                      onClick={() => handleToggleEnable(auto)}
                      className="p-2 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark hover:bg-claude-surface-light text-claude-text-light transition-all"
                      title={auto.enabled ? 'Disable Automation' : 'Enable Automation'}
                    >
                      {auto.enabled ? (
                        <ToggleRight className="w-4 h-4 text-emerald-500" />
                      ) : (
                        <ToggleLeft className="w-4 h-4 text-claude-muted-light" />
                      )}
                    </button>

                    <button
                      onClick={() => handleDelete(auto.id)}
                      className="p-2 rounded-xl hover:bg-rose-500/10 text-rose-500 transition-colors"
                      title="Delete Automation"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* Create Automation Modal */}
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
                <h3 className="font-serif font-medium text-base">Schedule New Automation</h3>
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

              <form onSubmit={handleCreateAutomation} className="mt-4 space-y-3.5">
                <div>
                  <label className="block text-xs font-medium text-claude-muted-light mb-1">
                    Automation Name
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Daily Workspace Health Audit"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-claude-muted-light mb-1">
                      Trigger Type
                    </label>
                    <select
                      value={formTrigger}
                      onChange={(e) => setFormTrigger(e.target.value as any)}
                      className="w-full px-3 py-2 rounded-xl text-xs bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta"
                    >
                      <option value="CRON">Cron Schedule (Recurring)</option>
                      <option value="MANUAL">Manual Trigger Only</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-claude-muted-light mb-1">
                      Target Agent
                    </label>
                    <select
                      value={formAgentId}
                      onChange={(e) => setFormAgentId(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl text-xs bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta"
                    >
                      <option value="agent-default">Default Agent</option>
                      <option value="agent_sys_monitor">System Monitor</option>
                    </select>
                  </div>
                </div>

                {formTrigger === 'CRON' && (
                  <div>
                    <label className="block text-xs font-medium text-claude-muted-light mb-1">
                      Cron Schedule Expression
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="0 9 * * 1-5"
                      value={formCron}
                      onChange={(e) => setFormCron(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl text-xs font-mono bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta"
                    />
                    <span className="text-[10px] text-claude-muted-light mt-1 block">
                      Standard 5-field cron: minute hour day-of-month month day-of-week
                    </span>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-claude-muted-light mb-1">
                    Objective / Instructions
                  </label>
                  <textarea
                    required
                    rows={4}
                    placeholder="Describe the tasks and telemetry that this automation executes on trigger..."
                    value={formObjective}
                    onChange={(e) => setFormObjective(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs font-mono bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta resize-none"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsCreateOpen(false)}
                    className="px-3 py-1.5 rounded-xl text-xs text-claude-muted-light"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-4 py-1.5 rounded-xl bg-claude-terracotta hover:bg-[#d97757]/90 text-white text-xs font-medium disabled:opacity-50"
                  >
                    {isSubmitting ? 'Scheduling...' : 'Save Automation'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Run History Modal */}
      <AnimatePresence>
        {selectedAutomation && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-xl max-h-[85vh] flex flex-col rounded-2xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-2xl p-6"
            >
              <div className="flex items-center justify-between pb-4 border-b border-claude-border-light dark:border-claude-border-dark">
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-claude-accentInk" />
                  <h3 className="font-serif font-medium text-base">Execution History: {selectedAutomation.name}</h3>
                </div>
                <button
                  onClick={() => setSelectedAutomation(null)}
                  className="p-1 rounded-lg text-claude-muted-light hover:text-claude-text-light"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto py-4 space-y-2.5">
                {runsLoading ? (
                  <div className="text-center py-10 text-xs text-claude-muted-light">Loading runs...</div>
                ) : runs.length === 0 ? (
                  <div className="text-center py-10 text-xs text-claude-muted-light">
                    No runs recorded yet for this automation.
                  </div>
                ) : (
                  runs.map((r) => (
                    <div
                      key={r.id}
                      className="p-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark flex items-center justify-between text-xs"
                    >
                      <div className="space-y-0.5">
                        <span className="font-mono text-[11px] font-bold text-claude-accentInk">{r.id}</span>
                        <div className="text-[10px] text-claude-muted-light">
                          Started: {new Date(r.startedAt).toLocaleString()}
                        </div>
                      </div>
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 font-bold">
                        {r.status}
                      </span>
                    </div>
                  ))
                )}
              </div>

              <div className="pt-3 border-t border-claude-border-light dark:border-claude-border-dark flex justify-end">
                <button
                  onClick={() => setSelectedAutomation(null)}
                  className="px-4 py-1.5 rounded-xl bg-claude-surface2-light text-xs font-medium"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
