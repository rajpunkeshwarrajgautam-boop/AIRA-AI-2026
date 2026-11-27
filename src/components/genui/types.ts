import type React from 'react';
import type {
  GenUIActionDefinition,
  GenUIComponent,
  GenUIComponentType,
  GenUISurface,
  GenUIStateRecord,
  GenUIStateValue,
} from '../../../packages/contracts/src/genui';

export interface GenUIRenderContext {
  surface: GenUISurface;
  state: GenUIStateRecord;
  setStateValue: (key: string, value: GenUIStateValue) => void;
  resetState: () => void;
  onTriggerAction: (componentId: string, actionId: string) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onResolveApproval?: (approvalId: string, runId: string, decision: 'ALLOW_ONCE' | 'ALLOW_SESSION' | 'REJECT') => void;
  renderComponentById: (componentId: string) => React.ReactNode;
  pendingActionId?: string | null;
  disabled?: boolean;
}

export type GenUIComponentRenderer<T extends GenUIComponentType> = React.FC<{
  component: Extract<GenUIComponent, { type: T }>;
  ctx: GenUIRenderContext;
}>;

export function getActionById(
  surface: GenUISurface,
  actionId: string | undefined
): GenUIActionDefinition | undefined {
  if (!actionId) return undefined;
  return surface.actions.find((a) => a.id === actionId);
}

export function resolveDataRefValue(
  state: GenUIStateRecord,
  dataRef: string | undefined
): GenUIStateValue | undefined {
  if (!dataRef || !dataRef.startsWith('/')) return undefined;
  const key = dataRef.slice(1).split('/')[0];
  if (!key || !Object.hasOwn(state, key)) return undefined;
  return state[key];
}
