import React, { useId } from 'react';
import { RotateCcw } from 'lucide-react';
import { getActionById, resolveDataRefValue, type GenUIComponentRenderer } from './types';

export const ProgressIndicatorRenderer: GenUIComponentRenderer<'progress_indicator'> = ({ component, ctx }) => {
  const { label, value, valueRef, max, unit, tone } = component.props;
  const liveRaw = valueRef ? resolveDataRefValue(ctx.state, valueRef) : undefined;
  const liveValue = typeof liveRaw === 'number' && Number.isFinite(liveRaw) ? liveRaw : value;
  const pct = Math.min(100, Math.max(0, Math.round((liveValue / max) * 100)));
  const fillCls =
    tone === 'success'
      ? 'bg-emerald-500'
      : tone === 'warning'
        ? 'bg-amber-500'
        : tone === 'danger'
          ? 'bg-red-500'
          : tone === 'neutral'
            ? 'bg-stone-500 dark:bg-stone-400'
            : 'bg-[#c25938]';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-claude-text-light dark:text-claude-text-dark">{label}</span>
        <span className="font-mono tabular-nums text-claude-subtext-light dark:text-claude-subtext-dark">
          {liveValue} / {max}
          {unit ? ` ${unit}` : ''} ({pct}%)
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={liveValue}
        aria-valuemin={0}
        aria-valuemax={max}
        className="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
      >
        <div className={`h-full rounded-full transition-all duration-300 ${fillCls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

export const MetricDisplayRenderer: GenUIComponentRenderer<'metric_display'> = ({ component, ctx }) => {
  const { label, value, stateKey, dataRef, delta, deltaTone, caption } = component.props;
  const bound = dataRef ? resolveDataRefValue(ctx.state, dataRef) : stateKey ? resolveDataRefValue(ctx.state, stateKey) : undefined;
  const liveVal = bound !== undefined ? bound : value;
  const deltaCls =
    deltaTone === 'positive'
      ? 'text-emerald-600 dark:text-emerald-400'
      : deltaTone === 'negative'
        ? 'text-red-600 dark:text-red-400'
        : 'text-claude-subtext-light dark:text-claude-subtext-dark';

  return (
    <div className="rounded-xl border border-claude-border-light bg-claude-surface-light/80 p-3 dark:border-claude-border-dark dark:bg-claude-surface-dark/80">
      <div className="text-[11px] font-medium uppercase tracking-wide text-claude-subtext-light dark:text-claude-subtext-dark">
        {label}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <span className="text-lg font-semibold tabular-nums text-claude-text-light dark:text-claude-text-dark">
          {String(liveVal)}
        </span>
        {delta && <span className={`text-xs font-medium tabular-nums ${deltaCls}`}>{delta}</span>}
      </div>
      {caption && (
        <div className="mt-1 text-xs text-claude-subtext-light dark:text-claude-subtext-dark">{caption}</div>
      )}
    </div>
  );
};

export const ComparisonVizRenderer: GenUIComponentRenderer<'comparison_viz'> = ({ component }) => {
  const { title, primaryLabel, secondaryLabel, unit, items } = component.props;
  const maxVal = Math.max(
    1,
    ...items.flatMap((i) => [Math.abs(i.primaryValue), Math.abs(i.secondaryValue ?? 0)])
  );

  return (
    <div className="rounded-xl border border-claude-border-light bg-claude-surface-light/70 p-3.5 dark:border-claude-border-dark dark:bg-claude-surface-dark/70">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-claude-text-light dark:text-claude-text-dark">{title}</h4>
        <div className="flex items-center gap-3 text-xs text-claude-subtext-light dark:text-claude-subtext-dark">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-[#c25938]" />
            {primaryLabel}
          </span>
          {secondaryLabel && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-blue-500" />
              {secondaryLabel}
            </span>
          )}
        </div>
      </div>
      <div className="space-y-3">
        {items.map((item, idx) => {
          const w1 = Math.min(100, Math.max(2, (Math.abs(item.primaryValue) / maxVal) * 100));
          const w2 =
            item.secondaryValue !== undefined
              ? Math.min(100, Math.max(2, (Math.abs(item.secondaryValue) / maxVal) * 100))
              : null;
          return (
            <div key={item.label + idx} className="space-y-1 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-claude-text-light dark:text-claude-text-dark">{item.label}</span>
                <span className="font-mono tabular-nums text-claude-subtext-light dark:text-claude-subtext-dark">
                  {item.primaryValue}
                  {unit ? ` ${unit}` : ''}
                  {item.secondaryValue !== undefined
                    ? ` vs ${item.secondaryValue}${unit ? ` ${unit}` : ''}`
                    : ''}
                </span>
              </div>
              <div className="space-y-1">
                <div className="h-2 w-full rounded-full bg-black/5 dark:bg-white/10">
                  <div className="h-2 rounded-full bg-[#c25938]" style={{ width: `${w1}%` }} />
                </div>
                {w2 !== null && (
                  <div className="h-2 w-full rounded-full bg-black/5 dark:bg-white/10">
                    <div className="h-2 rounded-full bg-blue-500" style={{ width: `${w2}%` }} />
                  </div>
                )}
              </div>
              {item.note && (
                <p className="text-[11px] text-claude-subtext-light dark:text-claude-subtext-dark">{item.note}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const FieldErrorBanner: React.FC<{ errors: string[] }> = ({ errors }) => {
  if (errors.length === 0) return null;
  return (
    <span role="alert" className="text-[11px] font-medium text-red-600 dark:text-red-400">
      {errors[0]}
    </span>
  );
};

function getFieldErrors(ctx: Parameters<GenUIComponentRenderer<'numeric_input'>>[0]['ctx'], componentId: string, stateKey: string): string[] {
  return ctx.fieldErrors[componentId] || ctx.fieldErrors[stateKey] || [];
}

export const NumericInputRenderer: GenUIComponentRenderer<'numeric_input'> = ({ component, ctx }) => {
  const inputId = useId();
  const { label, stateKey, min, max, step, defaultValue, unit, helperText } = component.props;
  const raw = resolveDataRefValue(ctx.state, stateKey);
  const val = typeof raw === 'number' && Number.isFinite(raw) ? raw : defaultValue;
  const errors = getFieldErrors(ctx, component.id, stateKey);
  const [draft, setDraft] = React.useState<string>(String(val));
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (!focused) setDraft(String(val));
  }, [val, focused]);

  const clampNum = (n: number) =>
    min !== undefined && n < min ? min : max !== undefined && n > max ? max : n;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-claude-subtext-light dark:text-claude-subtext-dark">
        {label}
      </label>
      <div className="relative flex items-center">
        <input
          id={inputId}
          type="number"
          min={min}
          max={max}
          step={step}
          value={focused ? draft : String(val)}
          aria-invalid={errors.length > 0 || undefined}
          disabled={ctx.disabled}
          onFocus={() => {
            setFocused(true);
            setDraft(String(val));
          }}
          onBlur={() => {
            setFocused(false);
            const parsed = Number(draft);
            if (draft.trim() === '' || !Number.isFinite(parsed)) {
              setDraft(String(val));
              return;
            }
            const clamped = clampNum(parsed);
            setDraft(String(clamped));
            if (clamped !== val) ctx.setStateValue(stateKey, clamped);
          }}
          onChange={(e) => {
            const nextStr = e.target.value;
            setDraft(nextStr);
            if (nextStr.trim() === '' || nextStr === '-' || nextStr.endsWith('.')) return;
            const parsed = Number(nextStr);
            if (!Number.isFinite(parsed)) return;
            const withinMin = min === undefined || parsed >= min;
            const withinMax = max === undefined || parsed <= max;
            if (withinMin && withinMax) {
              ctx.setStateValue(stateKey, parsed);
            }
          }}
          className="w-full rounded-lg border border-claude-border-light bg-claude-surface-light px-3 py-1.5 pr-12 text-sm tabular-nums text-claude-text-light focus:border-[#c25938] focus:outline-none dark:border-claude-border-dark dark:bg-claude-surface-dark dark:text-claude-text-dark"
        />
        {unit && (
          <span className="pointer-events-none absolute right-2.5 text-xs text-claude-subtext-light dark:text-claude-subtext-dark">
            {unit}
          </span>
        )}
      </div>
      <FieldErrorBanner errors={errors} />
      {helperText && (
        <span className="text-[11px] text-claude-subtext-light dark:text-claude-subtext-dark">{helperText}</span>
      )}
    </div>
  );
};

export const TextInputRenderer: GenUIComponentRenderer<'text_input'> = ({ component, ctx }) => {
  const inputId = useId();
  const { label, stateKey, placeholder, defaultValue, maxLength } = component.props;
  const raw = resolveDataRefValue(ctx.state, stateKey);
  const val = typeof raw === 'string' ? raw : defaultValue;
  const errors = getFieldErrors(ctx, component.id, stateKey);

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-claude-subtext-light dark:text-claude-subtext-dark">
        {label}
      </label>
      <input
        id={inputId}
        type="text"
        value={val}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-invalid={errors.length > 0 || undefined}
        disabled={ctx.disabled}
        onChange={(e) => ctx.setStateValue(stateKey, e.target.value)}
        className="w-full rounded-lg border border-claude-border-light bg-claude-surface-light px-3 py-1.5 text-sm text-claude-text-light focus:border-[#c25938] focus:outline-none dark:border-claude-border-dark dark:bg-claude-surface-dark dark:text-claude-text-dark"
      />
      <FieldErrorBanner errors={errors} />
    </div>
  );
};

export const SliderRenderer: GenUIComponentRenderer<'slider'> = ({ component, ctx }) => {
  const inputId = useId();
  const { label, stateKey, min, max, step, defaultValue, unit } = component.props;
  const raw = resolveDataRefValue(ctx.state, stateKey);
  const val = typeof raw === 'number' && Number.isFinite(raw) ? raw : defaultValue;
  const errors = getFieldErrors(ctx, component.id, stateKey);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <label htmlFor={inputId} className="font-medium text-claude-subtext-light dark:text-claude-subtext-dark">
          {label}
        </label>
        <span className="font-mono font-medium tabular-nums text-claude-text-light dark:text-claude-text-dark">
          {val}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
      <input
        id={inputId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={val}
        aria-invalid={errors.length > 0 || undefined}
        disabled={ctx.disabled}
        onChange={(e) => ctx.setStateValue(stateKey, Number(e.target.value))}
        style={{ accentColor: '#d97757' }}
        className="h-2 w-full cursor-pointer"
      />
      <FieldErrorBanner errors={errors} />
    </div>
  );
};

export const SelectControlRenderer: GenUIComponentRenderer<'select_control'> = ({ component, ctx }) => {
  const selectId = useId();
  const { label, stateKey, defaultValue, options } = component.props;
  const raw = resolveDataRefValue(ctx.state, stateKey);
  const val = typeof raw === 'string' ? raw : defaultValue;
  const errors = getFieldErrors(ctx, component.id, stateKey);

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={selectId} className="text-xs font-medium text-claude-subtext-light dark:text-claude-subtext-dark">
        {label}
      </label>
      <select
        id={selectId}
        value={val}
        aria-invalid={errors.length > 0 || undefined}
        disabled={ctx.disabled}
        onChange={(e) => ctx.setStateValue(stateKey, e.target.value)}
        className="w-full rounded-lg border border-claude-border-light bg-claude-surface-light px-3 py-1.5 text-sm text-claude-text-light focus:border-[#c25938] focus:outline-none dark:border-claude-border-dark dark:bg-claude-surface-dark dark:text-claude-text-dark"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <FieldErrorBanner errors={errors} />
    </div>
  );
};

export const CheckboxRenderer: GenUIComponentRenderer<'checkbox'> = ({ component, ctx }) => {
  const checkId = useId();
  const { label, stateKey, defaultChecked, description } = component.props;
  const raw = resolveDataRefValue(ctx.state, stateKey);
  const checked = typeof raw === 'boolean' ? raw : defaultChecked;
  const errors = getFieldErrors(ctx, component.id, stateKey);

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={checkId} className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input
          id={checkId}
          type="checkbox"
          checked={checked}
          aria-invalid={errors.length > 0 || undefined}
          disabled={ctx.disabled}
          onChange={(e) => ctx.setStateValue(stateKey, e.target.checked)}
          style={{ accentColor: '#c25938' }}
          className="mt-0.5 h-4 w-4 rounded"
        />
        <span>
          <span className="font-medium text-claude-text-light dark:text-claude-text-dark">{label}</span>
          {description && (
            <span className="block text-xs text-claude-subtext-light dark:text-claude-subtext-dark">{description}</span>
          )}
        </span>
      </label>
      <FieldErrorBanner errors={errors} />
    </div>
  );
};

export const RadioGroupRenderer: GenUIComponentRenderer<'radio_group'> = ({ component, ctx }) => {
  const groupName = useId();
  const { label, stateKey, defaultValue, options } = component.props;
  const raw = resolveDataRefValue(ctx.state, stateKey);
  const current = typeof raw === 'string' ? raw : defaultValue;
  const errors = getFieldErrors(ctx, component.id, stateKey);

  return (
    <fieldset className="space-y-1.5" aria-invalid={errors.length > 0 || undefined}>
      <legend className="text-xs font-medium text-claude-subtext-light dark:text-claude-subtext-dark">
        {label}
      </legend>
      <div className="flex flex-col gap-1.5">
        {options.map((opt) => (
          <label key={opt.value} className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio"
              name={groupName}
              value={opt.value}
              checked={current === opt.value}
              disabled={ctx.disabled}
              onChange={() => ctx.setStateValue(stateKey, opt.value)}
              style={{ accentColor: '#c25938' }}
              className="h-4 w-4"
            />
            <span className="text-claude-text-light dark:text-claude-text-dark">{opt.label}</span>
          </label>
        ))}
      </div>
      <FieldErrorBanner errors={errors} />
    </fieldset>
  );
};

export const SegmentedControlRenderer: GenUIComponentRenderer<'segmented_control'> = ({ component, ctx }) => {
  const { label, stateKey, defaultValue, options } = component.props;
  const raw = resolveDataRefValue(ctx.state, stateKey);
  const current = typeof raw === 'string' ? raw : defaultValue;
  const errors = getFieldErrors(ctx, component.id, stateKey);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-claude-subtext-light dark:text-claude-subtext-dark">{label}</span>
      <div
        role="group"
        aria-label={label}
        aria-invalid={errors.length > 0 || undefined}
        className="inline-flex flex-wrap gap-1 rounded-xl border border-claude-border-light bg-black/[0.03] p-1 dark:border-claude-border-dark dark:bg-white/[0.04]"
      >
        {options.map((opt) => {
          const active = current === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              disabled={ctx.disabled}
              onClick={() => ctx.setStateValue(stateKey, opt.value)}
              className={`rounded-lg px-3 py-1 text-xs font-medium transition ${
                active
                  ? 'bg-claude-surface-light text-claude-text-light shadow-sm dark:bg-claude-surface-dark dark:text-claude-text-dark'
                  : 'text-claude-subtext-light hover:text-claude-text-light dark:text-claude-subtext-dark'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <FieldErrorBanner errors={errors} />
    </div>
  );
};

export const ResetControlRenderer: GenUIComponentRenderer<'reset_control'> = ({ component, ctx }) => (
  <button
    type="button"
    disabled={ctx.disabled}
    onClick={() => {
      ctx.resetState();
      if (component.props.actionId) {
        ctx.onTriggerAction(component.id, component.props.actionId);
      }
    }}
    className="inline-flex items-center gap-1.5 rounded-lg border border-claude-border-light px-3 py-1.5 text-xs font-medium text-claude-text-light transition hover:bg-black/5 disabled:opacity-50 dark:border-claude-border-dark dark:text-claude-text-dark dark:hover:bg-white/10"
  >
    <RotateCcw className="h-3.5 w-3.5" />
    {component.props.label}
  </button>
);

export const ActionButtonRenderer: GenUIComponentRenderer<'action_button'> = ({ component, ctx }) => {
  const { label, actionId, variant, disabled, requiresValidState, setState } = component.props;
  const action = getActionById(ctx.surface, actionId);
  const isBusy = ctx.pendingActionId === actionId;
  const blockedByValidation = Boolean(requiresValidState && !ctx.isValid);
  const isDisabled = Boolean(disabled || ctx.disabled || !action || isBusy || blockedByValidation);

  const variantCls =
    variant === 'primary'
      ? 'bg-[#b84b29] text-white hover:bg-[#9f3f21] border-transparent shadow-sm'
      : variant === 'danger'
        ? 'bg-red-600 text-white hover:bg-red-700 border-transparent'
        : variant === 'ghost'
          ? 'border-transparent text-claude-text-light hover:bg-black/5 dark:text-claude-text-dark dark:hover:bg-white/10'
          : 'border-claude-border-light bg-claude-surface-light text-claude-text-light hover:bg-black/5 dark:border-claude-border-dark dark:bg-claude-surface-dark dark:text-claude-text-dark dark:hover:bg-white/10';

  return (
    <button
      type="button"
      disabled={isDisabled}
      onClick={() => {
        if (!action || isDisabled) return;
        if (setState && action.kind === 'local_recompute') {
          ctx.setStateBatch(setState);
          return;
        }
        if (action.requiresApproval && action.confirmMessage && typeof window !== 'undefined') {
          if (!window.confirm(action.confirmMessage)) return;
        }
        ctx.onTriggerAction(component.id, actionId);
      }}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${variantCls}`}
    >
      {isBusy ? 'Processing...' : label}
    </button>
  );
};
