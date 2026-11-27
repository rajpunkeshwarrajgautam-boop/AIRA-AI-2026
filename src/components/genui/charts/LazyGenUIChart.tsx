import React, { Suspense, useState } from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import type { GenUIChartComponent } from './GenUIChartCanvas';
export type { GenUIChartComponent };

const GenUIChartCanvas = React.lazy(() => import('./GenUIChartCanvas'));

class ChartRenderBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: React.ReactNode; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function ChartDataTable({ component }: { component: GenUIChartComponent }) {
  if (component.type === 'scatter_chart') {
    const rows = component.props.series.flatMap((s) =>
      s.points.slice(0, 60).map((pt) => ({
        series: s.label,
        x: pt.x,
        y: pt.y,
        label: pt.label || '',
      }))
    );
    return (
      <div className="max-h-64 overflow-auto rounded-lg border border-claude-border-light dark:border-claude-border-dark">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-claude-border-light bg-black/[0.03] dark:border-claude-border-dark dark:bg-white/[0.04]">
              <th className="px-3 py-2 font-medium">Series</th>
              <th className="px-3 py-2 font-medium">{component.props.xLabel}</th>
              <th className="px-3 py-2 font-medium">{component.props.yLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-claude-border-light/60 last:border-0 dark:border-claude-border-dark/60">
                <td className="px-3 py-1.5">{r.series}</td>
                <td className="px-3 py-1.5 font-mono">{r.x}</td>
                <td className="px-3 py-1.5 font-mono">{r.y}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (component.type === 'pie_chart' || component.type === 'doughnut_chart') {
    return (
      <div className="max-h-64 overflow-auto rounded-lg border border-claude-border-light dark:border-claude-border-dark">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-claude-border-light bg-black/[0.03] dark:border-claude-border-dark dark:bg-white/[0.04]">
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 text-right font-medium">
                Value{component.props.unit ? ` (${component.props.unit})` : ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {component.props.labels.map((label, idx) => (
              <tr key={label + idx} className="border-b border-claude-border-light/60 last:border-0 dark:border-claude-border-dark/60">
                <td className="px-3 py-1.5">{label}</td>
                <td className="px-3 py-1.5 text-right font-mono">{component.props.values[idx]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="max-h-64 overflow-auto rounded-lg border border-claude-border-light dark:border-claude-border-dark">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-claude-border-light bg-black/[0.03] dark:border-claude-border-dark dark:bg-white/[0.04]">
            <th className="px-3 py-2 font-medium">Label</th>
            {component.props.datasets.map((ds) => (
              <th key={ds.label} className="px-3 py-2 text-right font-medium">
                {ds.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {component.props.labels.map((label, rowIdx) => (
            <tr key={label + rowIdx} className="border-b border-claude-border-light/60 last:border-0 dark:border-claude-border-dark/60">
              <td className="px-3 py-1.5 font-medium">{label}</td>
              {component.props.datasets.map((ds) => (
                <td key={ds.label} className="px-3 py-1.5 text-right font-mono">
                  {ds.values[rowIdx] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const LazyGenUIChart: React.FC<{ component: GenUIChartComponent }> = ({ component }) => {
  const [viewMode, setViewMode] = useState<'chart' | 'table'>('chart');
  const allowToggle = component.props.allowTableToggle !== false;

  const tableFallback = <ChartDataTable component={component} />;

  return (
    <div
      className="rounded-xl border border-claude-border-light bg-claude-surface-light/70 p-3.5 dark:border-claude-border-dark dark:bg-claude-surface-dark/70"
      data-testid={`genui-chart-${component.id}`}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-claude-text-light dark:text-claude-text-dark">
            {component.props.title}
          </h4>
          {component.props.subtitle && (
            <p className="mt-0.5 text-xs text-claude-subtext-light dark:text-claude-subtext-dark">
              {component.props.subtitle}
            </p>
          )}
        </div>
        {allowToggle && (
          <div className="inline-flex rounded-lg border border-claude-border-light bg-black/[0.03] p-0.5 dark:border-claude-border-dark dark:bg-white/[0.04]">
            <button
              type="button"
              onClick={() => setViewMode('chart')}
              aria-pressed={viewMode === 'chart'}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition ${
                viewMode === 'chart'
                  ? 'bg-claude-surface-light text-claude-text-light shadow-sm dark:bg-claude-surface-dark dark:text-claude-text-dark'
                  : 'text-claude-subtext-light hover:text-claude-text-light dark:text-claude-subtext-dark'
              }`}
            >
              <BarChart3 className="h-3.5 w-3.5" />
              Chart
            </button>
            <button
              type="button"
              onClick={() => setViewMode('table')}
              aria-pressed={viewMode === 'table'}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition ${
                viewMode === 'table'
                  ? 'bg-claude-surface-light text-claude-text-light shadow-sm dark:bg-claude-surface-dark dark:text-claude-text-dark'
                  : 'text-claude-subtext-light hover:text-claude-text-light dark:text-claude-subtext-dark'
              }`}
            >
              <Table2 className="h-3.5 w-3.5" />
              Table
            </button>
          </div>
        )}
      </div>

      {viewMode === 'table' ? (
        tableFallback
      ) : (
        <ChartRenderBoundary fallback={tableFallback}>
          <Suspense
            fallback={
              <div className="space-y-2">
                <div className="text-xs text-claude-subtext-light dark:text-claude-subtext-dark">
                  Loading interactive chart...
                </div>
                {tableFallback}
              </div>
            }
          >
            <GenUIChartCanvas component={component} />
          </Suspense>
        </ChartRenderBoundary>
      )}
    </div>
  );
};
