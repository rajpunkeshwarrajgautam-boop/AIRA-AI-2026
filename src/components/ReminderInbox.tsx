import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Check, X } from 'lucide-react';

interface ReminderNotification {
  id: string;
  automationId: string;
  title: string;
  message: string;
  scheduledFor: number;
  createdAt: number;
  readAt: number | null;
}

/** Reads only the signed-in principal's durable reminder inbox. */
export default function ReminderInbox() {
  const [items, setItems] = useState<ReminderNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [arrived, setArrived] = useState(false);
  const initialized = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const session = await fetch('/api/auth/session', { method: 'POST', credentials: 'same-origin' });
      if (!session.ok) return;
      const response = await fetch('/api/reminders/inbox', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Reminder inbox unavailable');
      const data = await response.json() as { notifications: ReminderNotification[] };
      const next = data.notifications || [];
      if (initialized.current && next.some(item => !item.readAt && !itemsRef.current.has(item.id))) {
        setArrived(true);
      }
      itemsRef.current = new Set(next.map(item => item.id));
      initialized.current = true;
      setItems(next);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  const itemsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const markRead = async (id: string) => {
    const res = await fetch(`/api/reminders/inbox/${encodeURIComponent(id)}/read`, {
      method: 'POST', credentials: 'same-origin'
    });
    if (!res.ok) { setError(true); return; }
    setItems(previous => previous.map(item => item.id === id ? { ...item, readAt: Date.now() } : item));
  };

  const unread = items.filter(item => !item.readAt).length;

  return (
    <div className="relative">
      <button type="button" title="Reminder inbox" aria-label={`Reminder inbox, ${unread} unread`}
        aria-expanded={open} onClick={() => { setOpen(value => !value); setArrived(false); }}
        className="relative p-2 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark">
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unread > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-claude-terracotta text-white text-[9px] min-w-4 h-4 flex items-center justify-center">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {arrived && !open && (
        <span role="status" className="sr-only">You have new reminders in your AIRA inbox.</span>
      )}
      {open && (
        <section aria-label="Reminders" className="absolute right-0 top-full mt-2 w-[min(90vw,360px)] max-h-[min(70vh,440px)] overflow-y-auto rounded-xl bg-claude-bg-light dark:bg-claude-bg-dark border border-claude-border-light dark:border-claude-border-dark shadow-2xl z-[80] p-3">
          <div className="flex justify-between items-center mb-2">
            <strong className="text-sm">Reminders</strong>
            <button type="button" aria-label="Close reminders" onClick={() => setOpen(false)}><X className="w-4 h-4" /></button>
          </div>
          {error && <p role="alert" className="text-xs text-red-500 mb-2">Unable to refresh reminders. Please try again.</p>}
          {!items.length && <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark py-4">No reminders delivered yet.</p>}
          {items.map(item => (
            <article key={item.id} className="py-2 border-t border-claude-border-light dark:border-claude-border-dark">
              <p className="text-sm font-medium">{item.message}</p>
              <p className="text-xs opacity-70 mt-1">{new Date(item.scheduledFor).toLocaleString()}</p>
              {!item.readAt && <button type="button" onClick={() => void markRead(item.id)}
                className="text-xs flex items-center gap-1 mt-2 text-claude-accentInk">
                <Check className="w-3 h-3" /> Mark as read
              </button>}
            </article>
          ))}
          <button type="button" onClick={() => void refresh()} className="text-xs mt-3 underline">Refresh</button>
        </section>
      )}
    </div>
  );
}
