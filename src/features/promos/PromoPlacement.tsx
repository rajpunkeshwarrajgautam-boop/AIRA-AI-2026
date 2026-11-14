import { useEffect, useMemo, useRef, useState } from 'react';
import { authenticatedApiFetch } from '../../lib/neonAuth';
import type { PlanTier } from '../../types/commercial-types';

type Placement = 'rail' | 'welcome';
interface PromoPlacementProps {
  placement: Placement;
  userTier: PlanTier;
  userId: string | null;
  streaming: boolean;
  telemetryEnabled?: boolean;
  onOpenPlans: () => void;
}

function sessionId() {
  const key = 'aira_promo_session_id_v1';
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) return stored;
    const next = crypto.randomUUID();
    sessionStorage.setItem(key, next);
    return next;
  } catch { return ''; }
}

export function PromoPlacement({ placement, userTier, userId, streaming, onOpenPlans }: PromoPlacementProps) {
  const [dismissed, setDismissed] = useState(false);
  const key = useMemo(() => `aira_promo_v1:${userId || 'guest'}:${placement}`, [userId, placement]);
  const eligible = (userTier === 'free' || userTier === 'guest') && !streaming;
  const [allowed, setAllowed] = useState(false);
  const grantedKey = useRef<string | null>(null);

  useEffect(() => {
    setDismissed(false);
    let first = false;
    if (eligible) {
      try {
        first = sessionStorage.getItem(key) !== 'shown' || grantedKey.current === key;
        if (first) {
          sessionStorage.setItem(key, 'shown');
          grantedKey.current = key;
        }
      } catch { first = false; }
    }
    setAllowed(first);
  }, [key, eligible]);

  const emit = (kind: 'impression' | 'click') => {
    if (!userId || !telemetryEnabled) return;
    void authenticatedApiFetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placement, kind, sessionId: sessionId() }),
    }).catch(() => {}); // Telemetry never blocks the workspace.
  };

  useEffect(() => {
    if (allowed && eligible && !dismissed) emit('impression');
    // The user/account transition is captured through key and userId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, eligible, dismissed, key, userId]);

  if (!allowed || !eligible || dismissed) return null;
  return (
    <aside className={`aira-v3-promo aira-v3-promo-${placement}`} aria-label="AIRA plan information">
      <div>
        <strong>More room for complex work</strong>
        <p>See which AIRA tools and limits are available with each plan.</p>
      </div>
      <div className="aira-v3-promo-actions">
        <button type="button" onClick={() => { emit('click'); onOpenPlans(); }}>Compare plans</button>
        <button type="button" aria-label="Dismiss plan information" onClick={() => setDismissed(true)}>×</button>
      </div>
    </aside>
  );
}

