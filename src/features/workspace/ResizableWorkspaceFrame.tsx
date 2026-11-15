import { useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent, type CSSProperties } from 'react';

interface ResizableWorkspaceFrameProps {
  onClose: () => void;
  children: ReactNode;
}
const MIN_WIDTH = 360;
const MAX_WIDTH = 760;
const MOBILE_BREAKPOINT = 1100;

export function ResizableWorkspaceFrame({ onClose, children }: ResizableWorkspaceFrameProps) {
  const frame = useRef<HTMLDivElement>(null);
  const originFocus = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(480);
  const [mobile, setMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);

  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const change = () => setMobile(media.matches);
    change();
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    originFocus.current = document.activeElement as HTMLElement | null;
    if (mobile) {
      frame.current?.querySelector<HTMLElement>('button, a, input, [tabindex="0"]')?.focus();
    }
    return () => originFocus.current?.focus();
  }, [mobile]);

  useEffect(() => {
    if (!mobile) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const focusables = Array.from(frame.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
      ) ?? []);
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobile, onClose]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mobile || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent) => {
      const railWidth = document.querySelector<HTMLElement>('.aira-sidebar-shell')?.getBoundingClientRect().width || 0;
      const allowable = Math.max(MIN_WIDTH, window.innerWidth - railWidth - 560);
      setWidth(Math.min(Math.max(window.innerWidth - move.clientX, MIN_WIDTH), Math.min(MAX_WIDTH, allowable)));
    };
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd, { once: true });
    window.addEventListener('pointercancel', onEnd, { once: true });
  };

  return (
    <div
      ref={frame}
      className="aira-v3-workspace-frame"
      data-testid="workspace-resizable-frame"
      role={mobile ? 'dialog' : 'complementary'}
      aria-modal={mobile ? true : undefined}
      aria-label="AIRA contextual workspace"
      style={{ '--workspace-panel-width': `${width}px` } as CSSProperties}
    >
      {!mobile && <div
        role="separator"
        tabIndex={0}
        aria-label="Resize contextual workspace"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        className="aira-v3-resize-handle"
        onPointerDown={startResize}
        onKeyDown={event => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); setWidth(value => Math.min(MAX_WIDTH, value + 24)); }
          if (event.key === 'ArrowRight') { event.preventDefault(); setWidth(value => Math.max(MIN_WIDTH, value - 24)); }
        }}
      />}
      {children}
    </div>
  );
}

