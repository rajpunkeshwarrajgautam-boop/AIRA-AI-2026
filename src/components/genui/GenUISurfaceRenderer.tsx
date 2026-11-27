import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import {
  type GenUIInteractionEvent,
  type GenUIStateRecord,
  type GenUIStateValue,
  type GenUISurface,
  validateGenUISurface,
} from '../../../packages/contracts/src/genui';
import { recomputeCalculatorSurface } from '../../../packages/contracts/src/genui-calculators';
import {
  evaluateReactiveSurface,
  evaluateVisibilityCondition,
  writeStateKeyOrPointer,
} from '../../../packages/contracts/src/genui-reactive';
import { renderRegisteredComponent } from './registry';
import type { GenUIRenderContext } from './types';

class SurfaceErrorBoundary extends React.Component<
  { fallbackText: string; resetKey: string; children: React.ReactNode },
  { hasError: boolean; lastResetKey: string }
> {
  constructor(props: { fallbackText: string; resetKey: string; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, lastResetKey: props.resetKey };
  }
  static getDerivedStateFromProps(
    nextProps: { resetKey: string },
    prevState: { hasError: boolean; lastResetKey: string }
  ) {
    if (nextProps.resetKey !== prevState.lastResetKey) {
      return { hasError: false, lastResetKey: nextProps.resetKey };
    }
    return null;
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-xl border border-claude-border-light bg-claude-surface-light/70 p-3.5 text-sm text-claude-text-light dark:border-claude-border-dark dark:bg-claude-surface-dark/70 dark:text-claude-text-dark">
          {this.props.fallbackText}
        </div>
      );
    }
    return this.props.children;
  }
}

export interface GenUISurfaceRendererProps {
  surface: unknown;
  initialStateOverride?: GenUIStateRecord;
  onStateChange?: (surfaceId: string, nextState: GenUIStateRecord) => void;
  onAction?: (event: GenUIInteractionEvent, surface: GenUISurface) => void | Promise<void>;
  onOpenArtifact?: (artifactId: string) => void;
  onResolveApproval?: (approvalId: string, runId: string, decision: 'ALLOW_ONCE' | 'ALLOW_SESSION' | 'REJECT') => void;
  disabled?: boolean;
}

export const GenUISurfaceRenderer: React.FC<GenUISurfaceRendererProps> = ({
  surface: rawSurface,
  initialStateOverride,
  onStateChange,
  onAction,
  onOpenArtifact,
  onResolveApproval,
  disabled = false,
}) => {
  const validation = useMemo(() => validateGenUISurface(rawSurface), [rawSurface]);
  const baseSurface = validation.ok ? validation.surface : null;
  const serializedServerState = useMemo(
    () => (baseSurface ? JSON.stringify(baseSurface.state) : ''),
    [baseSurface]
  );
  const surfaceKey = baseSurface
    ? `${baseSurface.surfaceId}:${baseSurface.components.length}:${serializedServerState}`
    : 'invalid';

  const [localState, setLocalState] = useState<GenUIStateRecord>(() => ({
    ...(baseSurface?.state ?? {}),
    ...(initialStateOverride ?? {}),
  }));
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const lastSurfaceKeyRef = useRef(surfaceKey);
  const pendingStateNotifyRef = useRef(false);

  useEffect(() => {
    if (lastSurfaceKeyRef.current !== surfaceKey && baseSurface) {
      lastSurfaceKeyRef.current = surfaceKey;
      pendingStateNotifyRef.current = false;
      setLocalState({
        ...baseSurface.state,
        ...(initialStateOverride ?? {}),
      });
    }
  }, [surfaceKey, baseSurface, initialStateOverride]);

  useEffect(() => {
    if (!pendingStateNotifyRef.current || !baseSurface) return;
    pendingStateNotifyRef.current = false;
    onStateChange?.(baseSurface.surfaceId, localState);
  }, [localState, baseSurface, onStateChange]);

  const evaluation = useMemo(() => {
    if (!baseSurface) return null;
    if (baseSurface.calculatorKind) {
      const calcSurf = recomputeCalculatorSurface(baseSurface, localState);
      if (calcSurf.computed && calcSurf.computed.length > 0) {
        return evaluateReactiveSurface(calcSurf, calcSurf.state);
      }
      return {
        surface: calcSurf,
        state: calcSurf.state,
        fieldErrors: {} as Record<string, string[]>,
        isValid: true,
        computedErrors: [] as string[],
      };
    }
    if ((baseSurface.computed && baseSurface.computed.length > 0) || baseSurface.components.some((c) => Boolean(('checks' in c && c.checks?.length) || ('visibleWhen' in c && c.visibleWhen)))) {
      return evaluateReactiveSurface(baseSurface, localState);
    }
    return {
      surface: { ...baseSurface, state: localState },
      state: localState,
      fieldErrors: {} as Record<string, string[]>,
      isValid: true,
      computedErrors: [] as string[],
    };
  }, [baseSurface, localState]);

  const effectiveSurface = evaluation?.surface ?? null;

  const componentMap = useMemo(() => {
    const map = new Map<string, GenUISurface['components'][number]>();
    if (!effectiveSurface) return map;
    for (const c of effectiveSurface.components) {
      map.set(c.id, c);
    }
    return map;
  }, [effectiveSurface]);

  const setStateValue = useCallback(
    (key: string, value: GenUIStateValue) => {
      if (!baseSurface) return;
      pendingStateNotifyRef.current = true;
      setLocalState((prev) => writeStateKeyOrPointer(prev, key, value));
    },
    [baseSurface]
  );

  const setStateBatch = useCallback(
    (patch: Record<string, GenUIStateValue>) => {
      if (!baseSurface) return;
      pendingStateNotifyRef.current = true;
      setLocalState((prev) => {
        let next = prev;
        for (const [k, v] of Object.entries(patch)) {
          next = writeStateKeyOrPointer(next, k, v);
        }
        return next;
      });
    },
    [baseSurface]
  );

  const resetState = useCallback(() => {
    if (!baseSurface) return;
    pendingStateNotifyRef.current = true;
    setLocalState({ ...baseSurface.state });
  }, [baseSurface]);

  const handleTriggerAction = useCallback(
    async (componentId: string, actionId: string) => {
      if (!effectiveSurface) return;
      const action = effectiveSurface.actions.find((a) => a.id === actionId);
      if (!action) return;
      if (action.kind === 'reset_state') {
        resetState();
        return;
      }

      const evt: GenUIInteractionEvent = {
        eventId: `gact_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        surfaceId: effectiveSurface.surfaceId,
        componentId,
        actionId,
        kind: action.kind,
        runId: action.targetRunId,
        stateSnapshot: { ...localState },
        timestamp: Date.now(),
      };

      setPendingActionId(actionId);
      setActionNotice(null);
      try {
        await onAction?.(evt, effectiveSurface);
      } catch (err: any) {
        setActionNotice(err?.message || 'Action could not be completed.');
      } finally {
        setPendingActionId(null);
      }
    },
    [effectiveSurface, localState, onAction, resetState]
  );

  if (!validation.ok || !effectiveSurface) {
    const fallbackText =
      rawSurface && typeof rawSurface === 'object' && typeof (rawSurface as any).textFallback === 'string'
        ? (rawSurface as any).textFallback
        : 'Interactive panel unavailable; see response text.';
    return (
      <div
        className="rounded-xl border border-claude-border-light bg-claude-surface-light/70 p-3.5 text-sm text-claude-text-light dark:border-claude-border-dark dark:bg-claude-surface-dark/70 dark:text-claude-text-dark"
        data-testid="genui-fallback-surface"
      >
        <p>{fallbackText}</p>
      </div>
    );
  }

  const renderComponentById = (componentId: string): React.ReactNode => {
    const comp = componentMap.get(componentId);
    if (!comp) return null;
    if ('visibleWhen' in comp && !evaluateVisibilityCondition(comp.visibleWhen, evaluation?.state ?? localState)) {
      return null;
    }
    return renderRegisteredComponent(comp, ctx);
  };

  const ctx: GenUIRenderContext = {
    surface: effectiveSurface,
    state: evaluation?.state ?? localState,
    setStateValue,
    setStateBatch,
    resetState,
    onTriggerAction: handleTriggerAction,
    onOpenArtifact,
    onResolveApproval,
    renderComponentById,
    fieldErrors: evaluation?.fieldErrors ?? {},
    isValid: evaluation?.isValid ?? true,
    pendingActionId,
    disabled,
  };

  return (
    <SurfaceErrorBoundary fallbackText={effectiveSurface.textFallback} resetKey={surfaceKey}>
      <div
        className="my-3 rounded-2xl border border-claude-border-light bg-claude-surface-light/60 p-4 shadow-sm dark:border-claude-border-dark dark:bg-claude-surface-dark/60"
        data-testid={`genui-surface-${effectiveSurface.surfaceId}`}
      >
        {renderComponentById(effectiveSurface.rootId)}

        {actionNotice && (
          <div className="mt-3 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
            {actionNotice}
          </div>
        )}

        {effectiveSurface.evidence.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-claude-border-light/70 pt-2.5 text-[11px] text-claude-subtext-light dark:border-claude-border-dark/70 dark:text-claude-subtext-dark">
            <span className="inline-flex items-center gap-1 font-medium">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              Sources:
            </span>
            {effectiveSurface.evidence.map((ev) =>
              ev.uri ? (
                <a
                  key={ev.id}
                  href={ev.uri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-claude-border-light px-2 py-0.5 hover:border-[#c25938]/60 hover:text-claude-text-light dark:border-claude-border-dark dark:hover:text-claude-text-dark"
                >
                  <span>{ev.title}</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span
                  key={ev.id}
                  className="rounded-md border border-claude-border-light px-2 py-0.5 dark:border-claude-border-dark"
                >
                  {ev.title}
                </span>
              )
            )}
          </div>
        )}
      </div>
    </SurfaceErrorBoundary>
  );
};
