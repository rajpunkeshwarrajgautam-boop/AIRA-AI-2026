import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { GenUIComponentRenderer } from './types';

const GAP_MAP = {
  xs: 'gap-1.5',
  sm: 'gap-2.5',
  md: 'gap-3.5',
  lg: 'gap-5',
} as const;

export const VerticalGroupRenderer: GenUIComponentRenderer<'vertical_group'> = ({ component, ctx }) => (
  <div className={`flex flex-col ${GAP_MAP[component.props.gap]}`}>
    {component.props.children.map((id) => (
      <React.Fragment key={id}>{ctx.renderComponentById(id)}</React.Fragment>
    ))}
  </div>
);

export const HorizontalGroupRenderer: GenUIComponentRenderer<'horizontal_group'> = ({ component, ctx }) => {
  const alignCls =
    component.props.align === 'center'
      ? 'items-center'
      : component.props.align === 'end'
        ? 'items-end'
        : component.props.align === 'start'
          ? 'items-start'
          : 'items-stretch';
  return (
    <div
      className={`flex ${component.props.wrap ? 'flex-wrap' : 'flex-nowrap overflow-x-auto'} ${alignCls} ${GAP_MAP[component.props.gap]}`}
    >
      {component.props.children.map((id) => (
        <React.Fragment key={id}>{ctx.renderComponentById(id)}</React.Fragment>
      ))}
    </div>
  );
};

export const ResponsiveGridRenderer: GenUIComponentRenderer<'responsive_grid'> = ({ component, ctx }) => {
  const colsCls =
    component.props.columns === 1
      ? 'grid-cols-1'
      : component.props.columns === 3
        ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
        : component.props.columns === 4
          ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
          : 'grid-cols-1 sm:grid-cols-2';
  return (
    <div className={`grid ${colsCls} ${GAP_MAP[component.props.gap]}`}>
      {component.props.children.map((id) => (
        <React.Fragment key={id}>{ctx.renderComponentById(id)}</React.Fragment>
      ))}
    </div>
  );
};

export const CardRenderer: GenUIComponentRenderer<'card'> = ({ component, ctx }) => {
  const toneCls =
    component.props.tone === 'elevated'
      ? 'shadow-sm bg-claude-surface-light dark:bg-claude-surface-dark'
      : component.props.tone === 'subtle'
        ? 'bg-black/[0.02] dark:bg-white/[0.03]'
        : component.props.tone === 'accent'
          ? 'border-[#c25938]/35 bg-[#c25938]/[0.04]'
          : 'bg-claude-surface-light/80 dark:bg-claude-surface-dark/80';
  return (
    <div className={`rounded-xl border border-claude-border-light p-4 dark:border-claude-border-dark ${toneCls}`}>
      {(component.props.title || component.props.subtitle) && (
        <div className="mb-3">
          {component.props.title && (
            <h4 className="text-sm font-semibold text-claude-text-light dark:text-claude-text-dark">
              {component.props.title}
            </h4>
          )}
          {component.props.subtitle && (
            <p className="mt-0.5 text-xs text-claude-subtext-light dark:text-claude-subtext-dark">
              {component.props.subtitle}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-col gap-3">
        {component.props.children.map((id) => (
          <React.Fragment key={id}>{ctx.renderComponentById(id)}</React.Fragment>
        ))}
      </div>
    </div>
  );
};

export const SectionRenderer: GenUIComponentRenderer<'section'> = ({ component, ctx }) => {
  const [collapsed, setCollapsed] = useState(component.props.defaultCollapsed);
  return (
    <section className="rounded-xl border border-claude-border-light/80 p-3.5 dark:border-claude-border-dark/80">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-claude-text-light dark:text-claude-text-dark">
            {component.props.title}
          </h4>
          {component.props.description && (
            <p className="mt-0.5 text-xs text-claude-subtext-light dark:text-claude-subtext-dark">
              {component.props.description}
            </p>
          )}
        </div>
        {component.props.collapsible && (
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((v) => !v)}
            className="rounded-md p-1 text-claude-subtext-light hover:bg-black/5 hover:text-claude-text-light dark:text-claude-subtext-dark dark:hover:bg-white/10"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="mt-3 flex flex-col gap-3">
          {component.props.children.map((id) => (
            <React.Fragment key={id}>{ctx.renderComponentById(id)}</React.Fragment>
          ))}
        </div>
      )}
    </section>
  );
};

export const AdaptiveContainerRenderer: GenUIComponentRenderer<'adaptive_container'> = ({ component, ctx }) => {
  const widthCls =
    component.props.maxWidth === 'sm'
      ? 'max-w-md'
      : component.props.maxWidth === 'md'
        ? 'max-w-2xl'
        : component.props.maxWidth === 'lg'
          ? 'max-w-4xl'
          : 'max-w-full';
  const padCls = component.props.padding === 'none' ? '' : component.props.padding === 'sm' ? 'p-2' : 'p-4';
  return (
    <div className={`w-full ${widthCls} ${padCls}`}>
      <div className="flex flex-col gap-3">
        {component.props.children.map((id) => (
          <React.Fragment key={id}>{ctx.renderComponentById(id)}</React.Fragment>
        ))}
      </div>
    </div>
  );
};
