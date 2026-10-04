import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Bot as BotIcon, Check, Clock3, Download, FileText, Globe, ListChecks, Monitor, Plus, RefreshCw, Settings2, ShieldCheck, Square, Terminal, Trash2, Wrench, X } from 'lucide-react';
import { botApi, botPath, downloadResult, terminal } from './api';
import type { Bot, BotInput, Capabilities, Run, StreamingEvent, TaskRecord } from './api';
import { BotEditor } from './BotEditor';
import './aira-bot.css';

const firebaseConfigured = Boolean(import.meta.env.VITE_FIREBASE_PROJECT_ID && import.meta.env.VITE_FIREBASE_API_KEY);
const EMPTY_CAPABILITIES: Capabilities = { models: [], tools: [], computer: false, delegation: false, scheduling: false };
const EVENT_LABELS: Record<string, string> = { 'run.created': 'Task created', 'run.started': 'Status updated', 'tool.requested': 'Tool selected', 'tool.started': 'Tool running', 'tool.completed': 'Tool finished', 'approval.required': 'Approval requested', 'approval.resolved': 'Approval recorded', 'artifact.created': 'Result ready', 'run.completed': 'Task completed', 'run.failed': 'Task failed', 'run.cancelled': 'Task cancelled' };
const PANEL_TABS = ['activity', 'files', 'computer'] as const;
const STATE_LABELS: Record<string, string> = { QUEUED: 'Queued', RUNNING: 'Working', WAITING_FOR_TOOL: 'Using a tool', WAITING_FOR_APPROVAL: 'Needs approval', COMPLETED: 'Completed', FAILED: 'Failed', CANCELLED: 'Cancelled', INTERRUPTED: 'Interrupted' };
const dateLabel = (value: number) => new Date(Number(value)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function Status({ run }: { run: Run }) { return <span className={`ab-status ab-status-${run.state.toLowerCase()}`}><span />{STATE_LABELS[run.state] || run.state}</span>; }

export function AiraBotWorkspace({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const parts = path.split('/').filter(Boolean);
  const botId = parts[1] ? decodeURIComponent(parts[1]) : '';
  const runId = parts[2] === 'runs' && parts[3] ? decodeURIComponent(parts[3]) : '';
  const [bots, setBots] = useState<Bot[]>([]);
  const [capabilities, setCapabilities] = useState(EMPTY_CAPABILITIES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [taskRecords, setTasks] = useState<TaskRecord[]>([]);
  const [runRecord, setRun] = useState<Run>();
  const [eventRecords, setEvents] = useState<StreamingEvent[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Bot | 'new'>();
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [tab, setTab] = useState<'activity' | 'files' | 'computer'>('activity');
  const refreshVersion = useRef(0);
  const tasks = taskRecords.filter(task => task.run?.agentId === botId);
  const run = runRecord?.id === runId && runRecord.agentId === botId ? runRecord : undefined;
  const events = eventRecords.filter(event => event.runId === runId);
  const bot = bots.find(b => b.id === botId);
  const load = useCallback(async () => {
    const version = ++refreshVersion.current;
    setLoading(true); setError('');
    try { const [records, available] = await Promise.all([botApi<Bot[]>('/bots'), botApi<Capabilities>('/capabilities')]); if (version === refreshVersion.current) { setBots(records); setCapabilities(available); } }
    catch (err) { if (version === refreshVersion.current) setError((err as Error).message); }
    finally { if (version === refreshVersion.current) setLoading(false); }
  }, []);
  useEffect(() => { let active = true; void Promise.resolve().then(() => { if (active) return load(); }); return () => { active = false; }; }, [load]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    if (!botId) return;
    async function refresh() {
      try {
        const [records, current, timeline] = await Promise.all([
          botApi<TaskRecord[]>(`/bots/${encodeURIComponent(botId)}/tasks`),
          runId ? botApi<Run>(`/runs/${encodeURIComponent(runId)}`) : Promise.resolve(undefined),
          runId ? botApi<StreamingEvent[]>(`/runs/${encodeURIComponent(runId)}/events`) : Promise.resolve([])
        ]);
        if (disposed) return;
        if (current && current.agentId !== botId) { setError('This run belongs to a different bot.'); return; }
        setTasks(records); setRun(current); setEvents(timeline);
        timer = setTimeout(refresh, 2000);
      } catch (err) { if (!disposed) { setError((err as Error).message); timer = setTimeout(refresh, 6000); } }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [botId, runId]);
  async function save(input: BotInput) {
    const saved = await botApi<Bot>(editing === 'new' ? '/bots' : `/bots/${encodeURIComponent((editing as Bot).id)}`, { method: editing === 'new' ? 'POST' : 'PATCH', body: JSON.stringify(input) });
    setBots(prev => [saved, ...prev.filter(b => b.id !== saved.id)]);
    onNavigate(botPath(saved.id));
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!bot || !prompt.trim()) return;
    setBusy(true); setError('');
    try { const result = await botApi<{ run: Run }>(`/bots/${encodeURIComponent(bot.id)}/tasks`, { method: 'POST', body: JSON.stringify({ prompt }) }); setPrompt(''); onNavigate(`${botPath(bot.id)}/runs/${encodeURIComponent(result.run.id)}`); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function act(action: 'cancel' | 'ALLOW_ONCE' | 'REJECT') {
    if (!run) return; setBusy(true); setError('');
    try {
      await botApi(`/runs/${encodeURIComponent(run.id)}/${action === 'cancel' ? 'cancel' : 'approval'}`, { method: 'POST', body: action === 'cancel' ? undefined : JSON.stringify({ requestId: run.pendingApproval?.id, decision: action }) });
      setRun(await botApi<Run>(`/runs/${encodeURIComponent(run.id)}`));
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!bot) return; setBusy(true); setError('');
    try { await botApi(`/bots/${encodeURIComponent(bot.id)}`, { method: 'DELETE' }); setBots(prev => prev.filter(b => b.id !== bot.id)); onNavigate('/bots'); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <section className="ab-workspace" aria-label="Aira Bot workspace">
    {error && <div className="ab-error-banner" role="alert"><span>{error}</span>{firebaseConfigured && <button className="ab-secondary" onClick={() => { void import('./auth').then(module => module.signInBot()).then(load).catch(err => setError(err.message)); }}>Sign in</button>}<button className="ab-icon-button" onClick={() => void load()} aria-label="Retry connection"><RefreshCw size={16} /></button><button className="ab-icon-button" onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}
    {!botId ? <div className="ab-home">
      <div className="ab-home-heading"><div><span className="ab-eyebrow">A LITTLE DIRECTION. A LOT DONE.</span><h1>Your own capable team.</h1><p>Persistent bots with a purpose. Real tasks, tools, and results.</p></div><button className="ab-primary" onClick={() => setEditing('new')} disabled={loading || !!error}><Plus size={17} />Create bot</button></div>
      <div className="ab-feature-strip"><span><BotIcon size={17} />A purpose for every bot</span><span><ListChecks size={17} />Work that keeps going</span><span><ShieldCheck size={17} />You stay in control</span></div>
      <div className="ab-section-heading"><h2>Your bots <span>{bots.length}</span></h2><button className="ab-text-button" onClick={() => void load()} disabled={loading}><RefreshCw size={14} />Refresh</button></div>
      {loading ? <div className="ab-empty" role="status">Connecting to your workspace…</div> : bots.length ? <div className="ab-bot-grid">{bots.map(b => <button key={b.id} className="ab-bot-card" onClick={() => onNavigate(botPath(b.id))}><div className="ab-bot-avatar"><BotIcon size={25} /></div><h3>{b.name}</h3><p>{b.description || b.instructions.slice(0, 140)}</p><footer><span>{b.tools.length} tools · {b.skills.length} skills</span><span>Open →</span></footer></button>)}</div> : <div className="ab-empty"><div className="ab-empty-icon"><BotIcon size={36} /></div><h2>Start with one good teammate.</h2><p>Create a bot for research, analysis, or your next big idea.<br />Its instructions and memory stay with it across tasks.</p><button className="ab-primary" onClick={() => setEditing('new')} disabled={!!error}><Plus size={16} />Create your first bot</button></div>}
      <div className="ab-infrastructure"><div><Monitor size={20} /><h3>Computer workspace</h3><p>Browser, terminal, and isolated files.</p><span>Requires a computer provider</span></div><div><Wrench size={20} /><h3>Tools with boundaries</h3><p>Only the capabilities you enable.</p><span>{capabilities.tools.length ? `${capabilities.tools.length} tools connected` : 'Waiting for the runtime'}</span></div><div><Clock3 size={20} /><h3>Routines and delegation</h3><p>Schedules and specialist collaboration.</p><span>Requires scheduler and agent bus</span></div></div>
    </div> : loading ? <div className="ab-empty" role="status">Loading your bot…</div> : !bot ? <div className="ab-empty"><h2>Bot is unavailable.</h2><p>The bot may not exist or you may not have access.</p><button className="ab-secondary" onClick={() => onNavigate('/bots')}>Back to your bots</button></div> : <>
      <div className="ab-bot-heading"><button className="ab-icon-button" onClick={() => onNavigate('/bots')} aria-label="Back to your bots"><ArrowLeft size={19} /></button><div className="ab-bot-avatar ab-small-avatar"><BotIcon size={21} /></div><div className="ab-heading-text"><h1>{bot.name}</h1><p>{bot.description || 'Ready for your next task'}</p></div><button className="ab-secondary" onClick={() => setEditing(bot)}><Settings2 size={15} /><span>Configure</span></button></div>
      <div className="ab-detail-grid">
        <aside className="ab-tasks"><div className="ab-section-heading"><h2>Tasks</h2><button className="ab-icon-button" aria-label="New task" onClick={() => onNavigate(botPath(bot.id))}><Plus size={16} /></button></div>{tasks.length ? tasks.map(task => <button key={task.id} className={`ab-task ${task.run_id === runId ? 'ab-task-selected' : ''}`} onClick={() => onNavigate(`${botPath(bot.id)}/runs/${encodeURIComponent(task.run_id)}`)}><strong>{task.objective}</strong>{task.run && <Status run={task.run} />}<time>{dateLabel(task.created_at)}</time></button>) : <p className="ab-muted ab-task-empty">Your task history appears here.</p>}<div className="ab-bot-meta"><ShieldCheck size={16} /><span>{bot.approvalPolicy === 'always_ask' ? 'Approval before every tool' : 'Enabled read tools allowed'}</span><small>{bot.model} · {bot.maxSteps} step limit</small><button className="ab-text-button" onClick={() => setDeleteConfirm(true)} disabled={busy}><Trash2 size={14} />Delete bot</button>{deleteConfirm && <div className="ab-delete-confirm"><p>Delete this bot? Bots with task history are retained.</p><button className="ab-secondary" onClick={() => setDeleteConfirm(false)}>Keep</button><button className="ab-secondary" onClick={() => void remove()} disabled={busy}>Delete</button></div>}</div></aside>
        <div className="ab-conversation">
          <div className="ab-run-content">{run ? <><div className="ab-objective"><span className="ab-eyebrow">YOUR OBJECTIVE</span><p>{run.prompt}</p><div className="ab-run-meta"><Status run={run} /><span>{run.stepCount} / {run.maxSteps} steps</span>{!terminal(run) && <button className="ab-text-button" disabled={busy} onClick={() => void act('cancel')}><Square size={12} />Cancel</button>}</div></div>
          {run.state === 'WAITING_FOR_APPROVAL' && run.pendingApproval && <div className="ab-approval"><ShieldCheck size={22} /><h3>Aira Bot asks for permission</h3><p>{run.pendingApproval.reason}</p><pre>{JSON.stringify(run.pendingApproval.sanitizedPreview, null, 2)}</pre><div><button className="ab-secondary" disabled={busy} onClick={() => void act('REJECT')}>Reject</button><button className="ab-primary" disabled={busy} onClick={() => void act('ALLOW_ONCE')}><Check size={15} />Approve once</button></div></div>}
          {run.content ? <article className="ab-result"><div className="ab-section-heading"><h2><BotIcon size={18} />Aira Bot</h2><button className="ab-text-button" onClick={() => downloadResult(run)}><Download size={15} />Download</button></div><div className="ab-result-text">{run.content}</div></article> : !terminal(run) && run.state !== 'WAITING_FOR_APPROVAL' ? <p className="ab-working" role="status">{STATE_LABELS[run.state]}… You can leave this workspace while the server runs your task.</p> : null}
          {run.error && <p className="ab-error" role="alert">{run.error}</p>}
          {terminal(run) && run.state !== 'COMPLETED' && <button className="ab-secondary" onClick={() => { setPrompt(run.prompt); onNavigate(botPath(bot.id)); }}>Retry as a new task</button>}
          </> : <div className="ab-ready"><div className="ab-bot-avatar"><BotIcon size={32} /></div><h2>What should we get done?</h2><p>{bot.description || 'Give your bot a clear objective and an expected result.'}</p><div className="ab-capability-pills">{bot.tools.map(t => <span key={t}>{t === 'web_search' ? <Globe size={13} /> : <Wrench size={13} />}{t.replace(/_/g, ' ')}</span>)}<span><ShieldCheck size={13} />{bot.approvalPolicy === 'always_ask' ? 'Ask before tools' : 'Read tools enabled'}</span></div></div>}</div>
          <form className="ab-composer" onSubmit={submit}><label className="ab-sr-only" htmlFor="bot-objective">Task objective</label><textarea id="bot-objective" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={`Give ${bot.name} a task…`} rows={3} maxLength={16000} required /><footer><span>Each objective starts a separate task.</span><button className="ab-primary ab-send" disabled={busy || !prompt.trim() || !capabilities.models.length} aria-label="Start bot task"><ArrowUp size={19} /></button></footer>{!capabilities.models.length && <p className="ab-muted">Connect a server model provider to run tasks.</p>}</form>
        </div>
        <aside className="ab-execution"><div className="ab-panel-tabs" role="tablist" aria-label="Execution details">{PANEL_TABS.map(t => <button key={t} role="tab" id={`ab-tab-${t}`} aria-controls="ab-execution-panel" aria-selected={tab === t} tabIndex={tab === t ? 0 : -1} onKeyDown={event => {
          const current = PANEL_TABS.indexOf(t);
          const next = event.key === 'ArrowRight' ? (current + 1) % PANEL_TABS.length : event.key === 'ArrowLeft' ? (current + PANEL_TABS.length - 1) % PANEL_TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? PANEL_TABS.length - 1 : -1;
          if (next >= 0) { event.preventDefault(); setTab(PANEL_TABS[next]); document.getElementById(`ab-tab-${PANEL_TABS[next]}`)?.focus(); }
        }} onClick={() => setTab(t)}>{t === 'activity' ? <ListChecks size={15} /> : t === 'files' ? <FileText size={15} /> : <Monitor size={15} />}<span>{t}</span></button>)}</div><div className="ab-panel-body" role="tabpanel" id="ab-execution-panel" aria-labelledby={`ab-tab-${tab}`}>{tab === 'activity' ? events.length ? <ol className="ab-timeline">{events.filter(e => !['content.delta', 'thinking.delta'].includes(e.type)).map(e => <li key={e.eventId}><span className="ab-event-dot" /><strong>{EVENT_LABELS[e.type] || 'Activity updated'}</strong><time>{dateLabel(e.timestamp)}</time>{(e.data?.name || e.data?.state) && <p>{String(e.data.name || STATE_LABELS[e.data.state] || e.data.state)}</p>}</li>)}</ol> : <p className="ab-muted">Real execution events appear here when a task starts.</p> : tab === 'files' ? run?.artifacts.length ? run.artifacts.map(a => <button className="ab-file" key={a.id} onClick={() => downloadResult({ ...run, content: a.content })}><FileText size={21} /><span>{a.title}<small>Markdown result</small></span><Download size={15} /></button>) : <p className="ab-muted">Generated results appear here.</p> : <div className="ab-computer-empty"><Monitor size={34} /><h3>Computer is not connected</h3><p>Isolated browser, terminal, and filesystem access require a computer runtime provider.</p><div><Globe size={16} />Browser <Terminal size={16} />Terminal</div></div>}</div></aside>
      </div>
    </>}
    {editing && <BotEditor bot={editing === 'new' ? undefined : editing} capabilities={capabilities} onSave={save} onClose={() => setEditing(undefined)} />}
  </section>;
}
