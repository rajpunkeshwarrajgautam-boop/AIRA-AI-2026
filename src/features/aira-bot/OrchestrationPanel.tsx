import { useCallback, useEffect, useState } from 'react';
import { Bell, Bot as BotIcon, CalendarClock, Check, ExternalLink, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { botApi, botPath } from './api';
import type { Bot, BotDelegation, BotNotification, BotRoutine } from './api';
import './orchestration.css';

const when = (value?: number) => value ? new Date(value).toLocaleString() : 'Never';

export function OrchestrationPanel({ bot, scheduling, delegation, onNavigate }: { bot: Bot; scheduling: boolean; delegation: boolean; onNavigate: (path: string) => void }) {
  const [routines, setRoutines] = useState<BotRoutine[]>([]);
  const [delegations, setDelegations] = useState<BotDelegation[]>([]);
  const [notifications, setNotifications] = useState<BotNotification[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [cronExpression, setCron] = useState('0 7 * * 1');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setError('');
    try {
      const [nextRoutines, nextDelegations, nextNotifications] = await Promise.all([
        scheduling ? botApi<BotRoutine[]>(`/bots/${encodeURIComponent(bot.id)}/routines`) : Promise.resolve([]),
        delegation ? botApi<BotDelegation[]>(`/bots/${encodeURIComponent(bot.id)}/delegations`) : Promise.resolve([]),
        botApi<BotNotification[]>('/notifications')
      ]);
      setRoutines(nextRoutines);
      setDelegations(nextDelegations);
      setNotifications(nextNotifications.filter(note => !note.botId || note.botId === bot.id).slice(0, 20));
    } catch (err) { setError((err as Error).message); }
  }, [bot.id, delegation, scheduling]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function action(key: string, task: () => Promise<void>) {
    setBusy(key); setError('');
    try { await task(); await refresh(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  }

  async function createRoutine(event: React.FormEvent) {
    event.preventDefault();
    await action('create', async () => {
      await botApi(`/bots/${encodeURIComponent(bot.id)}/routines`, { method: 'POST', body: JSON.stringify({ name, objective, cronExpression, timezone, enabled: true }) });
      setName(''); setObjective(''); setCreating(false);
    });
  }

  return <div className="ab-orchestration">
    <div className="ab-orchestration-head"><div><strong>Orchestration</strong><small>Scheduled work, specialist delegation, and background results.</small></div><button className="ab-icon-button" aria-label="Refresh orchestration" disabled={!!busy} onClick={() => void refresh()}><RefreshCw size={15} /></button></div>
    {error && <p className="ab-error" role="alert">{error}</p>}

    <section className="ab-orchestration-section">
      <header><CalendarClock size={16} /><div><strong>Routines</strong><small>Bot-owned cron schedules with durable run history.</small></div>{scheduling && <button className="ab-text-button" onClick={() => setCreating(value => !value)}><Plus size={14} />Routine</button>}</header>
      {!scheduling ? <p className="ab-muted">The Bot scheduler is not connected on this host.</p> : <>
        {creating && <form className="ab-routine-form" onSubmit={createRoutine}>
          <input value={name} onChange={event => setName(event.target.value)} placeholder="Weekly competitor brief" maxLength={120} required aria-label="Routine name" />
          <textarea value={objective} onChange={event => setObjective(event.target.value)} placeholder="Research competitors and create a concise evidence-backed brief." maxLength={16000} required rows={3} aria-label="Routine objective" />
          <div><input value={cronExpression} onChange={event => setCron(event.target.value)} placeholder="0 7 * * 1" maxLength={120} required aria-label="Cron expression" /><input value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="Asia/Kolkata" maxLength={100} required aria-label="Routine timezone" /></div>
          <footer><small>Cron uses the selected IANA timezone.</small><button className="ab-primary" disabled={busy === 'create'}><Check size={14} />Create</button></footer>
        </form>}
        {routines.length ? <div className="ab-routine-list">{routines.map(routine => <article key={routine.id}>
          <div><strong>{routine.name}</strong><p>{routine.objective}</p><small>{routine.cronExpression} · {routine.timezone} · Last: {when(routine.lastScheduledFor)}</small></div>
          <div><button className="ab-secondary" disabled={!!busy} onClick={() => void action(`toggle-${routine.id}`, async () => { await botApi(`/bots/${encodeURIComponent(bot.id)}/routines/${encodeURIComponent(routine.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !routine.enabled }) }); })}>{routine.enabled ? 'Pause' : 'Enable'}</button><button className="ab-icon-button" aria-label={`Delete ${routine.name}`} disabled={!!busy} onClick={() => void action(`delete-${routine.id}`, async () => { await botApi(`/bots/${encodeURIComponent(bot.id)}/routines/${encodeURIComponent(routine.id)}`, { method: 'DELETE' }); })}><Trash2 size={14} /></button></div>
        </article>)}</div> : !creating && <p className="ab-muted">No routines yet. Scheduled tasks become normal Bot tasks and runs when they fire.</p>}
      </>}
    </section>

    <section className="ab-orchestration-section">
      <header><BotIcon size={16} /><div><strong>Delegation</strong><small>Work this bot handed to or received from specialist Aira Bots.</small></div></header>
      {!delegation ? <p className="ab-muted">Delegation is not connected.</p> : delegations.length ? <div className="ab-delegation-list">{delegations.map(item => <button key={item.id} onClick={() => onNavigate(`${botPath(item.targetBotId)}/runs/${encodeURIComponent(item.childRunId)}`)}>
        <span><strong>{item.parentBotId === bot.id ? 'Delegated out' : 'Received'}</strong><small>{item.status} · {when(item.createdAt)}</small></span><p>{item.objective}</p><ExternalLink size={14} />
      </button>)}</div> : <p className="ab-muted">No delegated tasks yet. Enable “Delegate work to another Aira Bot” in this Bot’s capabilities to let its model create bounded child tasks.</p>}
    </section>

    <section className="ab-orchestration-section">
      <header><Bell size={16} /><div><strong>Notifications</strong><small>Background routine and delegation outcomes.</small></div></header>
      {notifications.length ? <div className="ab-notification-list">{notifications.map(note => <button key={note.id} className={note.readAt ? '' : 'is-unread'} onClick={() => void action(`note-${note.id}`, async () => { if (!note.readAt) await botApi(`/notifications/${encodeURIComponent(note.id)}/read`, { method: 'POST' }); if (note.runId && note.botId) onNavigate(`${botPath(note.botId)}/runs/${encodeURIComponent(note.runId)}`); })}><span><strong>{note.title}</strong><small>{when(note.createdAt)}</small></span><p>{note.message}</p></button>)}</div> : <p className="ab-muted">Background results and attention requests appear here.</p>}
    </section>
  </div>;
}
