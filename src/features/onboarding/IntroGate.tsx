import { useEffect, useState, type ReactNode } from 'react';
import { authenticatedApiFetch, neonAuth } from '../../lib/neonAuth';
import { AiraMark } from '../../components/AiraMark';
import { INTRO_COPY, type IntroTone, type StarterId } from './copy';
import { StarterChips } from './StarterChips';

interface IntroGateProps {
  userId: string | null;
  tone?: IntroTone;
  fallback: ReactNode;
  onStart: (starter: StarterId, prompt: string) => void;
}

const GUEST_KEY = 'aira_intro_seen_guest_v1';

export function IntroGate({ userId, tone = 'Minimal', fallback, onStart }: IntroGateProps) {
  const [seen, setSeen] = useState<boolean | null>(null);
  const [activeTone, setActiveTone] = useState<IntroTone>(tone);
  const [busy, setBusy] = useState(false);
  const guestMode = !userId || userId === 'guest' || userId.startsWith('guest_') || !neonAuth.isAuthenticated();
  const guestStorageKey = `${GUEST_KEY}:${guestMode ? userId || 'anonymous' : 'signed-out'}`;

  useEffect(() => {
    let active = true;
    setSeen(null);
    if (guestMode) {
      try { setSeen(localStorage.getItem(guestStorageKey) === '1'); }
      catch { setSeen(false); }
      return () => { active = false; };
    }
    const epoch = neonAuth.getAuthEpoch();
    void authenticatedApiFetch('/api/me/onboarding', { method: 'GET' })
      .then(async response => {
        if (!response.ok) throw new Error(`Onboarding state unavailable: ${response.status}`);
        return response.json() as Promise<{ onboardedAt: number | null }>;
      })
      .then(data => {
        if (active && epoch === neonAuth.getAuthEpoch() && neonAuth.getCurrentUser()?.id === userId) {
          setSeen(typeof data.onboardedAt === 'number');
        }
      })
      // Fail closed for account state: do not overwrite authoritative state with guest storage.
      .catch(() => {
        if (active && epoch === neonAuth.getAuthEpoch() && neonAuth.getCurrentUser()?.id === userId) setSeen(true);
      });
    return () => { active = false; };
  }, [userId, guestMode, guestStorageKey]);

  const handleStart = async (starter?: StarterId, prompt?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      if (!guestMode && userId) {
        const epoch = neonAuth.getAuthEpoch();
        const response = await authenticatedApiFetch('/api/me/onboarding', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step: 'intro' }),
        });
        if (!response.ok) throw new Error(`Unable to save onboarding: ${response.status}`);
        if (epoch !== neonAuth.getAuthEpoch() || neonAuth.getCurrentUser()?.id !== userId) return;
      } else {
        try { localStorage.setItem(guestStorageKey, '1'); } catch { /* ephemeral guest mode */ }
      }
      setSeen(true);
      if (starter && prompt) onStart(starter, prompt);
    } catch {
      // Do not claim onboarding is complete or submit actions across an identity transition.
      setBusy(false);
    }
  };

  if (seen === null) return <div className="aira-v3-intro-loading" aria-live="polite">Loading workspace…</div>;
  if (seen) return <>{fallback}</>;
  const copy = INTRO_COPY[activeTone];
  return (
    <section className="aira-v3-intro" aria-label="Welcome to AIRA">
      <div className="aira-v3-intro-mark"><AiraMark size="xl" isAnimated={false} /></div>
      <h1>{copy.title}</h1>
      <p>{copy.description}</p>
      <StarterChips disabled={busy} onSelect={(starter, prompt) => void handleStart(starter, prompt)} />
      <button type="button" className="aira-v3-intro-skip" disabled={busy} onClick={() => void handleStart()}>
        Start with a blank chat
      </button>
      <div className="aira-v3-intro-tones" role="group" aria-label="Welcome message style">
        {(Object.keys(INTRO_COPY) as IntroTone[]).map(option => (
          <button key={option} type="button" aria-pressed={activeTone === option} onClick={() => setActiveTone(option)}>{option}</button>
        ))}
      </div>
    </section>
  );
}

