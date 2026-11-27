import {
  computeCompoundInterest,
  computeLoanPayment,
  evaluateSafeMathExpression,
  sampleSafeMathFunction,
} from './genui-calculators.js';
import type {
  GenUICheckRule,
  GenUIComponent,
  GenUIComputedRule,
  GenUIStateRecord,
  GenUIStateValue,
  GenUISurface,
  GenUIVisibleCondition,
} from './genui.js';

const FORBIDDEN_POINTER_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_POINTER_DEPTH = 8;

export function parseJsonPointerSegments(pointer: string): string[] {
  if (!pointer.startsWith('/')) {
    throw new Error(`Invalid JSON Pointer "${pointer}": must start with "/".`);
  }
  if (pointer === '/') return [];
  const raw = pointer.slice(1).split('/');
  if (raw.length > MAX_POINTER_DEPTH) {
    throw new Error(`JSON Pointer "${pointer}" exceeds max depth (${MAX_POINTER_DEPTH}).`);
  }
  return raw.map((seg) => {
    const unescaped = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!unescaped || unescaped === '..' || FORBIDDEN_POINTER_SEGMENTS.has(unescaped)) {
      throw new Error(`Forbidden JSON Pointer segment "${unescaped}".`);
    }
    return unescaped;
  });
}

export function getByJsonPointer(root: unknown, pointer: string): unknown {
  if (!pointer) return undefined;
  if (pointer === '/') return root;
  const segments = parseJsonPointerSegments(pointer);
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      if (!Object.hasOwn(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

export function setByJsonPointer<T extends Record<string, unknown>>(
  root: T,
  pointer: string,
  value: unknown
): T {
  if (pointer === '/') {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...(value as Record<string, unknown>) } as T;
    }
    throw new Error('Root JSON Pointer "/" update requires an object.');
  }

  const segments = parseJsonPointerSegments(pointer);
  const cloneContainer = (node: unknown, expectArrayIndex: string): Record<string, unknown> | unknown[] => {
    if (Array.isArray(node)) return [...node];
    if (node && typeof node === 'object') return { ...(node as Record<string, unknown>) };
    return /^\d+$/.test(expectArrayIndex) ? [] : {};
  };

  const applyAt = (node: unknown, depth: number): unknown => {
    const seg = segments[depth];
    const container = cloneContainer(node, seg);
    if (depth === segments.length - 1) {
      if (Array.isArray(container)) {
        const idx = Number(seg);
        if (!Number.isInteger(idx) || idx < 0 || idx > 500) {
          throw new Error(`Array index out of bounds at "${seg}".`);
        }
        if (value === null) container.splice(idx, 1);
        else container[idx] = value;
      } else {
        if (value === null) {
          delete container[seg];
        } else {
          container[seg] = value;
        }
      }
      return container;
    }

    const nextChild = Array.isArray(container)
      ? container[Number(seg)]
      : Object.hasOwn(container, seg)
        ? container[seg]
        : undefined;
    const updatedChild = applyAt(nextChild, depth + 1);
    if (Array.isArray(container)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx > 500) {
        throw new Error(`Array index out of bounds at "${seg}".`);
      }
      container[idx] = updatedChild;
    } else {
      container[seg] = updatedChild;
    }
    return container;
  };

  return applyAt(root, 0) as T;
}

export function resolveStateKeyOrPointer(state: GenUIStateRecord, keyOrPointer: string): unknown {
  if (!keyOrPointer) return undefined;
  if (keyOrPointer.startsWith('/')) {
    return getByJsonPointer(state, keyOrPointer);
  }
  return Object.hasOwn(state, keyOrPointer) ? state[keyOrPointer] : undefined;
}

export function writeStateKeyOrPointer(
  state: GenUIStateRecord,
  keyOrPointer: string,
  value: GenUIStateValue
): GenUIStateRecord {
  if (keyOrPointer.startsWith('/')) {
    return setByJsonPointer(state as Record<string, unknown>, keyOrPointer, value) as GenUIStateRecord;
  }
  if (FORBIDDEN_POINTER_SEGMENTS.has(keyOrPointer)) {
    throw new Error(`Forbidden state key "${keyOrPointer}".`);
  }
  return { ...state, [keyOrPointer]: value };
}

function normalizeDepPointer(pathOrKey: string): string {
  return pathOrKey.startsWith('/') ? pathOrKey : `/${pathOrKey}`;
}

export function validateComputedDependencyGraph(
  rules: readonly GenUIComputedRule[]
): { ok: true; ordered: GenUIComputedRule[] } | { ok: false; code: string; error: string } {
  if (rules.length === 0) return { ok: true, ordered: [] };
  const byTarget = new Map<string, GenUIComputedRule>();
  for (const r of rules) {
    const t = normalizeDepPointer(r.target);
    if (byTarget.has(t)) {
      return { ok: false, code: 'GENUI_DUPLICATE_COMPUTED_TARGET', error: `Duplicate computed target "${r.target}".` };
    }
    byTarget.set(t, r);
  }

  const getDeps = (r: GenUIComputedRule): string[] => {
    const deps: string[] = [...(r.deps || [])];
    if ('bindings' in r && r.bindings) {
      deps.push(...Object.values(r.bindings));
    }
    for (const k of ['principalRef', 'monthlyContributionRef', 'annualRateRef', 'yearsRef', 'termMonthsRef', 'candidatesRef', 'weightsRef', 'filterRef', 'rowsRef', 'searchRef', 'categoryRef', 'minValueRef', 'itemsRef', 'stepRef', 'valueRef', 'expressionRef', 'xMinRef', 'xMaxRef'] as const) {
      const refVal = (r as any)[k];
      if (typeof refVal === 'string') deps.push(refVal);
    }
    return deps.map(normalizeDepPointer);
  };

  const state = new Map<string, 'visiting' | 'visited'>();
  const ordered: GenUIComputedRule[] = [];

  const visit = (target: string): string | null => {
    const mark = state.get(target);
    if (mark === 'visiting') return `Cycle detected in reactive computed graph at "${target}".`;
    if (mark === 'visited') return null;
    const rule = byTarget.get(target);
    if (!rule) return null;
    state.set(target, 'visiting');
    for (const dep of getDeps(rule)) {
      // Exact target or parent/child dependency relationship
      for (const candidateTarget of byTarget.keys()) {
        if (
          dep === candidateTarget ||
          dep.startsWith(`${candidateTarget}/`) ||
          candidateTarget.startsWith(`${dep}/`)
        ) {
          if (candidateTarget === target && dep === target) {
            return `Self-referential computed dependency at "${target}".`;
          }
          const err = visit(candidateTarget);
          if (err) return err;
        }
      }
    }
    state.set(target, 'visited');
    ordered.push(rule);
    return null;
  };

  for (const t of byTarget.keys()) {
    const err = visit(t);
    if (err) return { ok: false, code: 'GENUI_COMPUTED_CYCLE', error: err };
  }

  return { ok: true, ordered };
}

function asFinite(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function round(v: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round((v + Number.EPSILON) * f) / f;
}

function formatMoney(v: number, currency = 'USD', decimals = 2): string {
  const cleanCurrency = /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: cleanCurrency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(v);
  } catch {
    return `${round(v, decimals)}`;
  }
}

const RESERVED_MATH_IDENTIFIERS = new Set([
  'e', 'pi', 'abs', 'min', 'max', 'round', 'floor', 'ceil', 'sqrt', 'pow', 'log', 'exp', 'sin', 'cos', 'tan',
]);

export function isSafeGenUIRegexPattern(pattern: string): boolean {
  if (!pattern || pattern.length > 120) return false;
  // Reject backreferences and lookarounds
  if (/\\[1-9]|k<|\(\?[=!<]/.test(pattern)) return false;
  // Walk pattern respecting character classes and escapes to reject nested quantifiers,
  // quantified groups containing alternation, and excessive nesting/quantifier counts
  let inClass = false;
  let escaped = false;
  let groupDepth = 0;
  let quantifierCount = 0;
  const groupHasQuantifierOrAlt: boolean[] = [];

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;

    if (ch === '(') {
      groupDepth += 1;
      if (groupDepth > 3) return false;
      groupHasQuantifierOrAlt.push(false);
    } else if (ch === ')') {
      if (groupDepth === 0) return false;
      const hasRiskyInner = groupHasQuantifierOrAlt.pop() ?? false;
      groupDepth -= 1;
      const next = pattern[i + 1];
      const quantified = next === '+' || next === '*' || next === '?' || next === '{';
      if (quantified && hasRiskyInner) return false;
      if ((quantified || hasRiskyInner) && groupDepth > 0) {
        groupHasQuantifierOrAlt[groupHasQuantifierOrAlt.length - 1] = true;
      }
    } else if (ch === '|') {
      if (groupHasQuantifierOrAlt.length > 0) {
        groupHasQuantifierOrAlt[groupHasQuantifierOrAlt.length - 1] = true;
      }
    } else if (ch === '+' || ch === '*' || ch === '?' || ch === '{') {
      quantifierCount += 1;
      if (quantifierCount > 6) return false;
      const prev = pattern[i - 1];
      if (prev === '+' || prev === '*' || prev === '}' || prev === '?') {
        if (ch !== '?' || prev === '?') return false;
      }
      if (groupHasQuantifierOrAlt.length > 0) {
        groupHasQuantifierOrAlt[groupHasQuantifierOrAlt.length - 1] = true;
      }
    }
  }
  if (inClass || groupDepth !== 0) return false;
  if (/\.[\*\+][^)]*\.[\*\+]/.test(pattern)) return false;
  return true;
}

export function evaluateSingleCheckRule(
  rule: GenUICheckRule,
  state: GenUIStateRecord,
  overrideValue?: unknown
): { valid: boolean; message?: string } {
  const val =
    overrideValue !== undefined
      ? overrideValue
      : rule.valueRef
        ? resolveStateKeyOrPointer(state, rule.valueRef)
        : undefined;

  let valid = true;
  if (rule.kind === 'required') {
    if (typeof val === 'string') valid = val.trim().length > 0;
    else if (Array.isArray(val)) valid = val.length > 0;
    else valid = val !== null && val !== undefined && val !== false;
  } else if (rule.kind === 'regex') {
    const rawStr = typeof val === 'string' ? val : String(val ?? '');
    const str = rawStr.length > 1024 ? rawStr.slice(0, 1024) : rawStr;
    if (rawStr.length > 1024 || !rule.pattern || !isSafeGenUIRegexPattern(rule.pattern)) {
      valid = false;
    } else {
      try {
        valid = new RegExp(rule.pattern).test(str);
      } catch {
        valid = false;
      }
    }
  } else if (rule.kind === 'length') {
    const str = typeof val === 'string' ? val : Array.isArray(val) ? val : String(val ?? '');
    const len = str.length;
    valid =
      (rule.min === undefined || len >= rule.min) &&
      (rule.max === undefined || len <= rule.max);
  } else if (rule.kind === 'numeric') {
    const n = typeof val === 'number' ? val : typeof val === 'string' && val.trim() !== '' ? Number(val) : NaN;
    valid =
      Number.isFinite(n) &&
      (rule.min === undefined || n >= rule.min) &&
      (rule.max === undefined || n <= rule.max);
  } else if (rule.kind === 'email') {
    const str = typeof val === 'string' ? val.trim() : '';
    valid = str.length > 3 && str.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str);
  }

  return valid ? { valid: true } : { valid: false, message: rule.message || 'Validation failed.' };
}

export function evaluateVisibilityCondition(
  cond: GenUIVisibleCondition | undefined,
  state: GenUIStateRecord
): boolean {
  if (!cond) return true;
  const val = resolveStateKeyOrPointer(state, cond.stateKey);
  if (cond.equals !== undefined) return val === cond.equals;
  if (cond.notEquals !== undefined) return val !== cond.notEquals;
  if (cond.min !== undefined) return asFinite(val, -Infinity) >= cond.min;
  if (cond.max !== undefined) return asFinite(val, Infinity) <= cond.max;
  if (cond.truthy !== undefined) return Boolean(val) === cond.truthy;
  return true;
}

export interface ReactiveEvaluationResult {
  surface: GenUISurface;
  state: GenUIStateRecord;
  fieldErrors: Record<string, string[]>;
  isValid: boolean;
  computedErrors: string[];
}

export function evaluateReactiveSurface(
  surface: GenUISurface,
  stateOverride?: GenUIStateRecord
): ReactiveEvaluationResult {
  let state: GenUIStateRecord = {
    ...(surface.state || {}),
    ...(stateOverride || {}),
  };

  const computedErrors: string[] = [];
  const rules = surface.computed || [];
  const graph = validateComputedDependencyGraph(rules);

  if (!graph.ok) {
    computedErrors.push(graph.error);
  } else {
    for (const rule of graph.ordered) {
      try {
        if (rule.kind === 'math') {
          const scope: Record<string, number> = {};
          for (const [k, v] of Object.entries(state)) {
            if (typeof v === 'number' && Number.isFinite(v) && !RESERVED_MATH_IDENTIFIERS.has(k.toLowerCase())) {
              scope[k] = v;
            }
          }
          if (rule.bindings) {
            for (const [varName, ptr] of Object.entries(rule.bindings)) {
              if (RESERVED_MATH_IDENTIFIERS.has(varName.toLowerCase())) continue;
              const resolved = resolveStateKeyOrPointer(state, ptr);
              scope[varName] = asFinite(resolved, 0);
            }
          }
          const evalRes = evaluateSafeMathExpression(rule.expression, scope);
          if (evalRes.ok) {
            state = setByJsonPointer(state as Record<string, unknown>, rule.target, round(evalRes.value, rule.decimals ?? 4)) as GenUIStateRecord;
          } else {
            computedErrors.push(`${rule.target}: ${evalRes.error}`);
          }
        } else if (rule.kind === 'compound_growth') {
          const principal = asFinite(resolveStateKeyOrPointer(state, rule.principalRef), 10000);
          const monthlyContribution = rule.monthlyContributionRef
            ? asFinite(resolveStateKeyOrPointer(state, rule.monthlyContributionRef), 0)
            : 0;
          const annualRatePercent = asFinite(resolveStateKeyOrPointer(state, rule.annualRateRef), 8);
          const years = asFinite(resolveStateKeyOrPointer(state, rule.yearsRef), 10);
          const currency = rule.currency || 'USD';
          const out = computeCompoundInterest({ principal, monthlyContribution, annualRatePercent, years, compoundingPerYear: 12 });
          if (out.ok) {
            const rows = out.yearlySchedule.slice(0, 60).map((r) => ({
              year: `Yr ${r.year}`,
              principal: round(r.principalContributed, 2),
              interest: round(r.interestEarned, 2),
              balance: round(r.balance, 2),
              balanceFormatted: formatMoney(r.balance, currency, 0),
            }));
            const payload = {
              finalBalance: out.finalBalance,
              totalPrincipal: out.totalPrincipal,
              totalInterest: out.totalInterest,
              finalBalanceFormatted: formatMoney(out.finalBalance, currency, 0),
              totalPrincipalFormatted: formatMoney(out.totalPrincipal, currency, 0),
              totalInterestFormatted: formatMoney(out.totalInterest, currency, 0),
              labels: rows.map((r) => r.year),
              datasets: [
                { label: 'Projected Value', values: rows.map((r) => r.balance), colorToken: 'primary' },
                { label: 'Total Contributed', values: rows.map((r) => r.principal), colorToken: 'secondary' },
              ],
              rows,
            };
            state = setByJsonPointer(state as Record<string, unknown>, rule.target, payload) as GenUIStateRecord;
          }
        } else if (rule.kind === 'amortization') {
          const principal = asFinite(resolveStateKeyOrPointer(state, rule.principalRef), 250000);
          const annualRatePercent = asFinite(resolveStateKeyOrPointer(state, rule.annualRateRef), 6.5);
          const termMonthsRaw = asFinite(resolveStateKeyOrPointer(state, rule.termMonthsRef), 60);
          const termMonths = rule.termIsYears ? Math.round(termMonthsRaw * 12) : termMonthsRaw;
          const currency = rule.currency || 'USD';
          const out = computeLoanPayment({ principal, annualRatePercent, termMonths });
          if (out.ok) {
            const rows = out.yearlySchedule.slice(0, 60).map((r) => ({
              month: r.month === 0 ? 'Start' : `M${r.month}`,
              principalPaid: round(r.principalPaidCumulative, 2),
              interestPaid: round(r.interestPaidCumulative, 2),
              balance: round(r.remainingBalance, 2),
              balanceFormatted: formatMoney(r.remainingBalance, currency, 0),
            }));
            const payload = {
              monthlyPayment: out.monthlyPayment,
              totalPayment: out.totalPaid,
              totalInterest: out.totalInterest,
              monthlyPaymentFormatted: formatMoney(out.monthlyPayment, currency, 2),
              totalPaymentFormatted: formatMoney(out.totalPaid, currency, 0),
              totalInterestFormatted: formatMoney(out.totalInterest, currency, 0),
              labels: rows.map((r) => r.month),
              datasets: [
                { label: 'Remaining Balance', values: rows.map((r) => r.balance), colorToken: 'primary' },
                { label: 'Cumulative Interest', values: rows.map((r) => r.interestPaid), colorToken: 'warning' },
              ],
              rows,
            };
            state = setByJsonPointer(state as Record<string, unknown>, rule.target, payload) as GenUIStateRecord;
          }
        } else if (rule.kind === 'function_series') {
          const exprRaw = asString(resolveStateKeyOrPointer(state, rule.expressionRef), 'sin(x)');
          const xMin = asFinite(rule.xMinRef ? resolveStateKeyOrPointer(state, rule.xMinRef) : -6, -6);
          const xMax = asFinite(rule.xMaxRef ? resolveStateKeyOrPointer(state, rule.xMaxRef) : 6, 6);
          const sampled = sampleSafeMathFunction(exprRaw, xMin, xMax, rule.steps ?? 33);
          if (sampled.ok) {
            const ys = sampled.points.map((p) => p.y);
            const payload = {
              expression: exprRaw,
              minY: round(Math.min(...ys), 3),
              maxY: round(Math.max(...ys), 3),
              labels: sampled.points.map((p) => String(p.x)),
              datasets: [{ label: `f(x) = ${exprRaw}`, values: ys, colorToken: 'primary' }],
              series: [{ label: `f(x) = ${exprRaw}`, points: sampled.points, colorToken: 'primary' }],
              error: '',
            };
            state = setByJsonPointer(state as Record<string, unknown>, rule.target, payload) as GenUIStateRecord;
          } else {
            const errPayload = {
              expression: exprRaw,
              minY: 0,
              maxY: 0,
              labels: [],
              datasets: [],
              series: [],
              error: sampled.error,
            };
            state = setByJsonPointer(state as Record<string, unknown>, rule.target, errPayload) as GenUIStateRecord;
            computedErrors.push(sampled.error);
          }
        } else if (rule.kind === 'weighted_decision') {
          const rawCandidates = resolveStateKeyOrPointer(state, rule.candidatesRef);
          const rawWeights = (resolveStateKeyOrPointer(state, rule.weightsRef) || {}) as Record<string, unknown>;
          const filterVal = rule.filterRef ? asString(resolveStateKeyOrPointer(state, rule.filterRef), 'all').toLowerCase() : 'all';
          const list = Array.isArray(rawCandidates) ? rawCandidates : [];
          const filtered = list.filter((item) => {
            if (!item || typeof item !== 'object') return false;
            if (!rule.filterField || filterVal === 'all' || filterVal === '') return true;
            return String((item as Record<string, unknown>)[rule.filterField] || '').toLowerCase() === filterVal;
          }) as Array<Record<string, unknown>>;

          const totalWeight = rule.criteria.reduce((sum, c) => sum + Math.max(0, asFinite(rawWeights[c.key], 0)), 0);
          const scoredRows = filtered
            .map((cand) => {
              let weightedSum = 0;
              for (const c of rule.criteria) {
                const w = Math.max(0, asFinite(rawWeights[c.key], 0));
                const score = asFinite(cand[c.key], 0);
                weightedSum += w * score;
              }
              const weightedScore = totalWeight > 0 ? round(weightedSum / totalWeight, 2) : 0;
              return {
                ...cand,
                name: asString(cand[rule.nameField || 'name'], 'Option'),
                weightedScore,
              };
            })
            .sort((a, b) => b.weightedScore - a.weightedScore);

          const top = scoredRows[0];
          const payload = {
            rows: scoredRows.slice(0, 50),
            labels: scoredRows.slice(0, 20).map((r) => r.name),
            datasets: [{ label: 'Weighted Score', values: scoredRows.slice(0, 20).map((r) => r.weightedScore), colorToken: 'primary' }],
            topCandidate: top ? top.name : '—',
            topScore: top ? top.weightedScore : 0,
            topScoreLabel: top ? `${top.name} (${top.weightedScore})` : '—',
            count: scoredRows.length,
          };
          state = setByJsonPointer(state as Record<string, unknown>, rule.target, payload) as GenUIStateRecord;
        } else if (rule.kind === 'table_filter_aggregate') {
          const rawRows = resolveStateKeyOrPointer(state, rule.rowsRef);
          const query = rule.searchRef ? asString(resolveStateKeyOrPointer(state, rule.searchRef), '').trim().toLowerCase() : '';
          const category = rule.categoryRef ? asString(resolveStateKeyOrPointer(state, rule.categoryRef), 'all').trim().toLowerCase() : 'all';
          const minVal = rule.minValueRef ? asFinite(resolveStateKeyOrPointer(state, rule.minValueRef), -Infinity) : -Infinity;
          const rows = (Array.isArray(rawRows) ? rawRows : []).filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'));

          const filtered = rows.filter((row) => {
            if (category !== 'all' && category !== '' && rule.categoryField) {
              if (String(row[rule.categoryField] ?? '').toLowerCase() !== category) return false;
            }
            if (rule.valueField && Number.isFinite(minVal)) {
              if (asFinite(row[rule.valueField], -Infinity) < minVal) return false;
            }
            if (query) {
              const hay = Object.values(row).map((v) => String(v ?? '').toLowerCase()).join(' ');
              if (!hay.includes(query)) return false;
            }
            return true;
          });

          const totalValue = rule.valueField
            ? round(filtered.reduce((s, r) => s + asFinite(r[rule.valueField!], 0), 0), 2)
            : filtered.length;
          const avgValue = filtered.length > 0 && rule.valueField ? round(totalValue / filtered.length, 2) : 0;

          const labelKey = rule.labelField || Object.keys(rows[0] || {})[0] || 'label';
          const valKey = rule.valueField || 'value';
          const payload = {
            rows: filtered.slice(0, 200),
            count: filtered.length,
            totalValue,
            avgValue,
            totalFormatted: rule.currency ? formatMoney(totalValue, rule.currency, 0) : String(totalValue),
            labels: filtered.slice(0, 24).map((r) => asString(r[labelKey], '')),
            datasets: [{ label: rule.metricLabel || valKey, values: filtered.slice(0, 24).map((r) => asFinite(r[valKey], 0)), colorToken: 'primary' }],
          };
          state = setByJsonPointer(state as Record<string, unknown>, rule.target, payload) as GenUIStateRecord;
        } else if (rule.kind === 'progress_ratio') {
          let completed = 0;
          let total = rule.itemKeys?.length ?? 0;
          if (rule.itemKeys && rule.itemKeys.length > 0) {
            for (const k of rule.itemKeys) {
              if (Boolean(resolveStateKeyOrPointer(state, k))) completed += 1;
            }
          } else if (rule.itemsRef) {
            const arr = resolveStateKeyOrPointer(state, rule.itemsRef);
            if (Array.isArray(arr)) {
              total = arr.length;
              for (const item of arr) {
                if (typeof item === 'boolean' && item) completed += 1;
                else if (item && typeof item === 'object' && Boolean((item as Record<string, unknown>)[rule.doneField || 'done'])) completed += 1;
              }
            }
          }
          const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
          state = setByJsonPointer(state as Record<string, unknown>, rule.target, {
            completed,
            total,
            percent,
            summary: `${completed} / ${total} (${percent}%)`,
          }) as GenUIStateRecord;
        } else if (rule.kind === 'format_value') {
          const val = asFinite(resolveStateKeyOrPointer(state, rule.valueRef), 0);
          const formatted =
            rule.format === 'currency'
              ? formatMoney(val, rule.currency || 'USD', rule.decimals ?? 0)
              : rule.format === 'percent'
                ? `${round(val, rule.decimals ?? 1)}%`
                : round(val, rule.decimals ?? 2).toLocaleString('en-US');
          state = setByJsonPointer(state as Record<string, unknown>, rule.target, formatted) as GenUIStateRecord;
        }
      } catch (err: any) {
        computedErrors.push(`${rule.target}: ${err?.message || 'Computation error'}`);
      }
    }
  }

  // Evaluate component field validation rules (@checks)
  const fieldErrors: Record<string, string[]> = {};
  for (const comp of surface.components) {
    const visibleWhen = 'visibleWhen' in comp ? comp.visibleWhen : undefined;
    if (!evaluateVisibilityCondition(visibleWhen, state)) continue;
    const checks = 'checks' in comp ? comp.checks : undefined;
    if (!checks || checks.length === 0) continue;
    const key = 'stateKey' in comp.props && typeof comp.props.stateKey === 'string' ? comp.props.stateKey : comp.id;
    let val = 'stateKey' in comp.props && typeof comp.props.stateKey === 'string' ? resolveStateKeyOrPointer(state, comp.props.stateKey) : undefined;
    if (val === undefined) {
      if ('defaultValue' in comp.props) val = (comp.props as Record<string, unknown>).defaultValue;
      else if ('defaultChecked' in comp.props) val = (comp.props as Record<string, unknown>).defaultChecked;
    }
    for (const check of checks) {
      const checkRes = evaluateSingleCheckRule(check, state, check.valueRef ? undefined : val);
      if (!checkRes.valid && checkRes.message) {
        if (!fieldErrors[comp.id]) fieldErrors[comp.id] = [];
        fieldErrors[comp.id].push(checkRes.message);
        if (key !== comp.id) {
          if (!fieldErrors[key]) fieldErrors[key] = [];
          fieldErrors[key].push(checkRes.message);
        }
      }
    }
  }

  // Resolve data-bound labels/datasets/rows on components without mutating original schema props permanently
  const resolveCartesian = <T extends Extract<GenUIComponent, { type: 'bar_chart' | 'line_chart' }>>(comp: T): T => {
    const boundLabels = comp.props.labelsRef ? resolveStateKeyOrPointer(state, comp.props.labelsRef) : undefined;
    const boundDatasets = comp.props.datasetsRef ? resolveStateKeyOrPointer(state, comp.props.datasetsRef) : undefined;
    const labels = Array.isArray(boundLabels) && boundLabels.length > 0 ? boundLabels.map(String).slice(0, 120) : comp.props.labels;
    const datasetsRaw =
      Array.isArray(boundDatasets) && boundDatasets.length > 0
        ? (boundDatasets as typeof comp.props.datasets).slice(0, 16)
        : comp.props.datasets.slice(0, 16);
    const sanitizedDatasets = datasetsRaw
      .filter((ds) => ds && typeof ds === 'object' && Array.isArray(ds.values))
      .map((ds) => ({
        ...ds,
        label: typeof ds.label === 'string' ? ds.label.slice(0, 120) : 'Series',
        values: ds.values.slice(0, 120).map((v) => asFinite(v, 0)),
      }));
    return {
      ...comp,
      props: {
        ...comp.props,
        labels: labels.length > 0 ? labels : ['—'],
        datasets:
          sanitizedDatasets.length > 0
            ? sanitizedDatasets.map((ds) => ({
                ...ds,
                values: ds.values.length > 0 ? ds.values : [0],
              }))
            : comp.props.datasets,
      },
    };
  };

  const resolvedComponents: GenUIComponent[] = surface.components.map((comp): GenUIComponent => {
    if (comp.type === 'data_table' && comp.props.rowsRef) {
      const boundRows = resolveStateKeyOrPointer(state, comp.props.rowsRef);
      if (Array.isArray(boundRows)) {
        return {
          ...comp,
          props: {
            ...comp.props,
            rows: boundRows.slice(0, 500) as typeof comp.props.rows,
          },
        };
      }
    }
    if (comp.type === 'bar_chart' && (comp.props.labelsRef || comp.props.datasetsRef)) {
      return resolveCartesian(comp);
    }
    if (comp.type === 'line_chart' && (comp.props.labelsRef || comp.props.datasetsRef)) {
      return resolveCartesian(comp);
    }
    if (comp.type === 'scatter_chart' && comp.props.seriesRef) {
      const boundSeries = resolveStateKeyOrPointer(state, comp.props.seriesRef);
      if (Array.isArray(boundSeries) && boundSeries.length > 0) {
        const safeSeries = boundSeries
          .slice(0, 16)
          .filter((s): s is { label: string; points: Array<{ x: number; y: number; label?: string }> } => Boolean(s && typeof s === 'object' && Array.isArray((s as any).points)))
          .map((s) => ({
            label: typeof s.label === 'string' ? s.label.slice(0, 120) : 'Series',
            points: s.points.slice(0, 300).map((pt) => ({
              x: asFinite(pt?.x, 0),
              y: asFinite(pt?.y, 0),
              ...(typeof pt?.label === 'string' ? { label: pt.label.slice(0, 120) } : {}),
            })),
          }));
        if (safeSeries.length > 0) {
          return {
            ...comp,
            props: {
              ...comp.props,
              series: safeSeries as typeof comp.props.series,
            },
          };
        }
      }
    }
    if (comp.type === 'pie_chart' && (comp.props.labelsRef || comp.props.valuesRef)) {
      const boundLabels = comp.props.labelsRef ? resolveStateKeyOrPointer(state, comp.props.labelsRef) : undefined;
      const boundValues = comp.props.valuesRef ? resolveStateKeyOrPointer(state, comp.props.valuesRef) : undefined;
      if (Array.isArray(boundLabels) && Array.isArray(boundValues) && boundLabels.length === boundValues.length && boundLabels.length > 0) {
        return {
          ...comp,
          props: {
            ...comp.props,
            labels: boundLabels.map(String).slice(0, 20),
            values: boundValues.map((v) => Math.max(0, asFinite(v, 0))).slice(0, 20),
          },
        };
      }
    }
    if (comp.type === 'doughnut_chart' && (comp.props.labelsRef || comp.props.valuesRef)) {
      const boundLabels = comp.props.labelsRef ? resolveStateKeyOrPointer(state, comp.props.labelsRef) : undefined;
      const boundValues = comp.props.valuesRef ? resolveStateKeyOrPointer(state, comp.props.valuesRef) : undefined;
      if (Array.isArray(boundLabels) && Array.isArray(boundValues) && boundLabels.length === boundValues.length && boundLabels.length > 0) {
        return {
          ...comp,
          props: {
            ...comp.props,
            labels: boundLabels.map(String).slice(0, 20),
            values: boundValues.map((v) => Math.max(0, asFinite(v, 0))).slice(0, 20),
          },
        };
      }
    }
    if (comp.type === 'progress_indicator' && comp.props.valueRef) {
      const boundVal = resolveStateKeyOrPointer(state, comp.props.valueRef);
      const num = asFinite(boundVal, comp.props.value);
      return {
        ...comp,
        props: {
          ...comp.props,
          value: Math.max(0, num),
        },
      };
    }
    return comp;
  });

  const isValid = Object.keys(fieldErrors).length === 0 && computedErrors.length === 0;
  return {
    surface: {
      ...surface,
      state,
      components: resolvedComponents,
    },
    state,
    fieldErrors,
    isValid,
    computedErrors,
  };
}
