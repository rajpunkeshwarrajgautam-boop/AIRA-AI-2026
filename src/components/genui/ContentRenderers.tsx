import React, { useMemo, useState } from 'react';
import { ArrowUpDown, Check, Copy } from 'lucide-react';
import { renderMarkdownToHtml, renderSafeMathHtml } from '../../utils/markdown';
import { resolveDataRefValue, type GenUIComponentRenderer } from './types';

export const TextRenderer: GenUIComponentRenderer<'text'> = ({ component, ctx }) => {
  const refVal = resolveDataRefValue(ctx.state, component.props.dataRef);
  const display = refVal !== undefined ? String(refVal) : component.props.text;
  const cls =
    component.props.variant === 'muted'
      ? 'text-xs text-claude-subtext-light dark:text-claude-subtext-dark'
      : component.props.variant === 'lead'
        ? 'text-base font-medium text-claude-text-light dark:text-claude-text-dark'
        : component.props.variant === 'emphasis'
          ? 'text-sm font-semibold text-claude-text-light dark:text-claude-text-dark'
          : 'text-sm leading-relaxed text-claude-text-light dark:text-claude-text-dark';
  return <p className={cls}>{display}</p>;
};

export const HeadingRenderer: GenUIComponentRenderer<'heading'> = ({ component }) => {
  const { level, text, subtitle } = component.props;
  const sizeClass =
    level === 1
      ? 'text-xl font-semibold'
      : level === 2
        ? 'text-lg font-semibold'
        : level === 3
          ? 'text-base font-semibold'
          : 'text-sm font-semibold';
  const Tag = (`h${level}` as 'h1' | 'h2' | 'h3' | 'h4');
  return (
    <div>
      <Tag className={`${sizeClass} tracking-tight text-claude-text-light dark:text-claude-text-dark`}>
        {text}
      </Tag>
      {subtitle && (
        <p className="mt-0.5 text-xs text-claude-subtext-light dark:text-claude-subtext-dark">
          {subtitle}
        </p>
      )}
    </div>
  );
};

export const CaptionRenderer: GenUIComponentRenderer<'caption'> = ({ component }) => (
  <p className="text-xs text-claude-subtext-light dark:text-claude-subtext-dark">
    {component.props.text}
    {component.props.sourceLabel ? ` — ${component.props.sourceLabel}` : ''}
  </p>
);

export const RichTextRenderer: GenUIComponentRenderer<'rich_text'> = ({ component }) => {
  const html = useMemo(() => renderMarkdownToHtml(component.props.markdown), [component.props.markdown]);
  return (
    <div
      className="aira-prose max-w-none text-sm leading-relaxed text-claude-text-light dark:text-claude-text-dark"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export const DividerRenderer: GenUIComponentRenderer<'divider'> = ({ component }) =>
  component.props.label ? (
    <div className="my-2 flex items-center gap-3">
      <div className="h-px flex-1 bg-claude-border-light dark:bg-claude-border-dark" />
      <span className="text-[11px] font-medium uppercase tracking-wider text-claude-subtext-light dark:text-claude-subtext-dark">
        {component.props.label}
      </span>
      <div className="h-px flex-1 bg-claude-border-light dark:bg-claude-border-dark" />
    </div>
  ) : (
    <hr className="my-2 border-claude-border-light dark:border-claude-border-dark" />
  );

export const CodeBlockRenderer: GenUIComponentRenderer<'code_block'> = ({ component }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(component.props.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-claude-border-light bg-black/[0.03] dark:border-claude-border-dark dark:bg-black/30">
      <div className="flex items-center justify-between border-b border-claude-border-light px-3 py-1.5 text-xs dark:border-claude-border-dark">
        <span className="font-mono text-claude-subtext-light dark:text-claude-subtext-dark">
          {component.props.title || component.props.language}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-claude-subtext-light hover:text-claude-text-light dark:text-claude-subtext-dark"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed text-claude-text-light dark:text-claude-text-dark">
        <code>{component.props.code}</code>
      </pre>
    </div>
  );
};

export const MathBlockRenderer: GenUIComponentRenderer<'math_block'> = ({ component }) => {
  const html = useMemo(
    () => renderSafeMathHtml(component.props.latex, component.props.displayMode),
    [component.props.latex, component.props.displayMode]
  );
  return (
    <div className="rounded-xl border border-claude-border-light bg-claude-surface-light/60 px-4 py-3 dark:border-claude-border-dark dark:bg-claude-surface-dark/60">
      <div className="overflow-x-auto text-center" dangerouslySetInnerHTML={{ __html: html }} />
      {component.props.caption && (
        <p className="mt-1.5 text-center text-xs text-claude-subtext-light dark:text-claude-subtext-dark">
          {component.props.caption}
        </p>
      )}
    </div>
  );
};

export const DataTableRenderer: GenUIComponentRenderer<'data_table'> = ({ component }) => {
  const { title, columns, rows, sortable, compact } = component.props;
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState(true);

  const sortedRows = useMemo(() => {
    if (!sortable || !sortCol) return rows;
    return [...rows].sort((a, b) => {
      const va = a[sortCol];
      const vb = b[sortCol];
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') {
        return sortAsc ? va - vb : vb - va;
      }
      return sortAsc
        ? String(va).localeCompare(String(vb))
        : String(vb).localeCompare(String(va));
    });
  }, [rows, sortable, sortCol, sortAsc]);

  const toggleSort = (key: string) => {
    if (!sortable) return;
    if (sortCol === key) setSortAsc((p) => !p);
    else {
      setSortCol(key);
      setSortAsc(true);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-claude-border-light bg-claude-surface-light/70 dark:border-claude-border-dark dark:bg-claude-surface-dark/70">
      {title && (
        <div className="border-b border-claude-border-light px-3.5 py-2 text-sm font-semibold text-claude-text-light dark:border-claude-border-dark dark:text-claude-text-dark">
          {title}
        </div>
      )}
      <div className="max-w-full overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs sm:text-sm">
          <thead>
            <tr className="border-b border-claude-border-light bg-black/[0.03] dark:border-claude-border-dark dark:bg-white/[0.04]">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`${compact ? 'px-2.5 py-1.5' : 'px-3.5 py-2.5'} font-medium text-claude-subtext-light dark:text-claude-subtext-dark ${
                    col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
                  }`}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className="inline-flex items-center gap-1 hover:text-claude-text-light dark:hover:text-claude-text-dark"
                    >
                      {col.label}
                      <ArrowUpDown className="h-3 w-3 opacity-60" />
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, rIdx) => (
              <tr
                key={rIdx}
                className="border-b border-claude-border-light/60 last:border-0 hover:bg-black/[0.02] dark:border-claude-border-dark/60 dark:hover:bg-white/[0.02]"
              >
                {columns.map((col) => {
                  const val = row[col.key];
                  return (
                    <td
                      key={col.key}
                      className={`${compact ? 'px-2.5 py-1.5' : 'px-3.5 py-2'} text-claude-text-light dark:text-claude-text-dark ${
                        col.align === 'right'
                          ? 'text-right font-mono tabular-nums'
                          : col.align === 'center'
                            ? 'text-center'
                            : 'text-left'
                      }`}
                    >
                      {val === null || val === undefined ? '—' : String(val)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export const DataSummaryRenderer: GenUIComponentRenderer<'data_summary'> = ({ component, ctx }) => (
  <div className="rounded-xl border border-claude-border-light bg-claude-surface-light/70 p-3.5 dark:border-claude-border-dark dark:bg-claude-surface-dark/70">
    {component.props.title && (
      <h4 className="mb-2.5 text-sm font-semibold text-claude-text-light dark:text-claude-text-dark">
        {component.props.title}
      </h4>
    )}
    <dl className="divide-y divide-claude-border-light/60 dark:divide-claude-border-dark/60">
      {component.props.items.map((item, idx) => {
        const liveVal = item.stateKey && Object.hasOwn(ctx.state, item.stateKey)
          ? ctx.state[item.stateKey]
          : item.value;
        return (
          <div key={item.label + idx} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5 text-xs sm:text-sm">
            <dt className="text-claude-subtext-light dark:text-claude-subtext-dark">{item.label}</dt>
            <dd className="font-medium tabular-nums text-claude-text-light dark:text-claude-text-dark">
              {String(liveVal)}
              {item.note && (
                <span className="ml-1.5 text-xs font-normal text-claude-subtext-light dark:text-claude-subtext-dark">
                  ({item.note})
                </span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  </div>
);
