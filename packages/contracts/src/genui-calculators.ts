import {
  AIRA_GENUI_CONTRACT_VERSION,
  type GenUICalculatorKind,
  type GenUIComponent,
  type GenUIStateRecord,
  type GenUISurface,
} from './genui.js';

export type CalculatorResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

function isFiniteInBounds(value: unknown, min = -1e12, max = 1e12): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function roundTo(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function formatNum(value: number, decimals = 2): string {
  return roundTo(value, decimals).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// ==========================================
// 1. COMPOUND INTEREST CALCULATOR
// ==========================================

export interface CompoundInterestInput {
  principal: number;
  annualRatePercent: number;
  years: number;
  compoundingPerYear?: number;
  monthlyContribution?: number;
}

export interface CompoundInterestScheduleRow {
  year: number;
  balance: number;
  principalContributed: number;
  interestEarned: number;
}

export interface CompoundInterestOutput {
  finalBalance: number;
  totalPrincipal: number;
  totalInterest: number;
  effectiveAnnualYieldPercent: number;
  yearlySchedule: CompoundInterestScheduleRow[];
}

export function computeCompoundInterest(
  input: CompoundInterestInput
): CalculatorResult<CompoundInterestOutput> {
  const principal = Number(input.principal);
  const annualRatePercent = Number(input.annualRatePercent);
  const years = Math.min(100, Math.max(0, Math.round(Number(input.years))));
  const compoundingPerYear = Math.min(365, Math.max(1, Math.round(Number(input.compoundingPerYear ?? 12))));
  const monthlyContribution = Number(input.monthlyContribution ?? 0);

  if (
    !isFiniteInBounds(principal, 0, 1e11) ||
    !isFiniteInBounds(annualRatePercent, -50, 500) ||
    !isFiniteInBounds(monthlyContribution, 0, 1e9)
  ) {
    return { ok: false, error: 'Inputs must be finite numbers within safe bounds.' };
  }

  const r = annualRatePercent / 100;
  const yearlySchedule: CompoundInterestScheduleRow[] = [];

  for (let yr = 0; yr <= years; yr++) {
    let balance = principal;
    if (yr > 0) {
      if (r === 0) {
        balance = principal + monthlyContribution * 12 * yr;
      } else {
        const growthFactor = (1 + r / compoundingPerYear) ** (compoundingPerYear * yr);
        const monthlyRate = (1 + r / compoundingPerYear) ** (compoundingPerYear / 12) - 1;
        const fvPrincipal = principal * growthFactor;
        const fvContrib =
          monthlyContribution > 0 && monthlyRate !== 0
            ? monthlyContribution * (((1 + monthlyRate) ** (12 * yr) - 1) / monthlyRate)
            : monthlyContribution * 12 * yr;
        balance = fvPrincipal + fvContrib;
      }
    }
    const principalContributed = principal + monthlyContribution * 12 * yr;
    const roundedBalance = roundTo(balance, 2);
    const roundedPrincipal = roundTo(principalContributed, 2);
    yearlySchedule.push({
      year: yr,
      balance: roundedBalance,
      principalContributed: roundedPrincipal,
      interestEarned: roundTo(roundedBalance - roundedPrincipal, 2),
    });
  }

  const last = yearlySchedule[yearlySchedule.length - 1];
  if (!last || !Number.isFinite(last.balance)) {
    return { ok: false, error: 'Calculated balance overflowed finite numeric bounds.' };
  }

  const apy = r === 0 ? 0 : ((1 + r / compoundingPerYear) ** compoundingPerYear - 1) * 100;

  return {
    ok: true,
    finalBalance: last.balance,
    totalPrincipal: last.principalContributed,
    totalInterest: last.interestEarned,
    effectiveAnnualYieldPercent: roundTo(apy, 3),
    yearlySchedule,
  };
}

// ==========================================
// 2. PERCENTAGE CALCULATOR
// ==========================================

export type PercentageMode = 'percent_of' | 'what_percent' | 'percent_change';

export interface PercentageInput {
  mode: PercentageMode;
  valueA: number;
  valueB: number;
}

export function computePercentage(
  input: PercentageInput
): CalculatorResult<{ result: number; formatted: string; explanation: string }> {
  const a = Number(input.valueA);
  const b = Number(input.valueB);
  if (!isFiniteInBounds(a) || !isFiniteInBounds(b)) {
    return { ok: false, error: 'Inputs must be finite numbers.' };
  }

  if (input.mode === 'percent_of') {
    const result = roundTo((a / 100) * b, 6);
    return { ok: true, result, formatted: formatNum(result, 2), explanation: `${a}% of ${b} = ${formatNum(result, 2)}` };
  }

  if (input.mode === 'what_percent') {
    if (b === 0) return { ok: false, error: 'Denominator cannot be zero.' };
    const result = roundTo((a / b) * 100, 6);
    return { ok: true, result, formatted: `${formatNum(result, 2)}%`, explanation: `${a} is ${formatNum(result, 2)}% of ${b}` };
  }

  if (a === 0) return { ok: false, error: 'Baseline value cannot be zero for percent change.' };
  const result = roundTo(((b - a) / Math.abs(a)) * 100, 6);
  const sign = result > 0 ? '+' : '';
  return {
    ok: true,
    result,
    formatted: `${sign}${formatNum(result, 2)}%`,
    explanation: `Change from ${a} to ${b} is ${sign}${formatNum(result, 2)}%`,
  };
}

// ==========================================
// 3. DETERMINISTIC UNIT CONVERTER
// ==========================================

export type UnitCategory = 'length' | 'mass' | 'temperature' | 'data' | 'speed' | 'time';

const LINEAR_FACTORS: Record<Exclude<UnitCategory, 'temperature'>, Record<string, number>> = {
  length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254 },
  mass: { kg: 1, g: 0.001, mg: 1e-6, lb: 0.45359237, oz: 0.028349523125, t: 1000 },
  data: { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 },
  speed: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, kn: 0.514444 },
  time: { s: 1, ms: 0.001, min: 60, h: 3600, d: 86400 },
};

export interface UnitConversionInput {
  category: UnitCategory;
  value: number;
  fromUnit: string;
  toUnit: string;
}

export function computeUnitConversion(
  input: UnitConversionInput
): CalculatorResult<{ result: number; formatted: string }> {
  const value = Number(input.value);
  if (!isFiniteInBounds(value)) {
    return { ok: false, error: 'Input value must be a finite number.' };
  }

  if (input.category === 'temperature') {
    const toKelvin = (v: number, unit: string): number | null => {
      if (unit === 'C') return v + 273.15;
      if (unit === 'F') return ((v - 32) * 5) / 9 + 273.15;
      if (unit === 'K') return v;
      return null;
    };
    const fromKelvin = (k: number, unit: string): number | null => {
      if (unit === 'C') return k - 273.15;
      if (unit === 'F') return ((k - 273.15) * 9) / 5 + 32;
      if (unit === 'K') return k;
      return null;
    };
    const kelvin = toKelvin(value, input.fromUnit);
    const out = kelvin === null ? null : fromKelvin(kelvin, input.toUnit);
    if (out === null || !Number.isFinite(out)) {
      return { ok: false, error: `Unsupported temperature conversion ${input.fromUnit} -> ${input.toUnit}.` };
    }
    const rounded = roundTo(out, 6);
    return { ok: true, result: rounded, formatted: `${formatNum(rounded, 2)} ${input.toUnit}` };
  }

  const table = LINEAR_FACTORS[input.category];
  if (!table || !(input.fromUnit in table) || !(input.toUnit in table)) {
    return { ok: false, error: `Incompatible units "${input.fromUnit}" -> "${input.toUnit}" for category "${input.category}".` };
  }

  const base = value * table[input.fromUnit];
  const converted = base / table[input.toUnit];
  if (!Number.isFinite(converted)) {
    return { ok: false, error: 'Conversion exceeded numeric bounds.' };
  }
  const rounded = roundTo(converted, 6);
  return { ok: true, result: rounded, formatted: `${formatNum(rounded, 4)} ${input.toUnit}` };
}

// ==========================================
// 4. LOAN / EMI CALCULATOR
// ==========================================

export interface LoanPaymentInput {
  principal: number;
  annualRatePercent: number;
  termMonths: number;
}

export interface LoanSchedulePoint {
  month: number;
  remainingBalance: number;
  principalPaidCumulative: number;
  interestPaidCumulative: number;
}

export function computeLoanPayment(input: LoanPaymentInput): CalculatorResult<{
  monthlyPayment: number;
  totalPaid: number;
  totalInterest: number;
  yearlySchedule: LoanSchedulePoint[];
}> {
  const principal = Number(input.principal);
  const annualRatePercent = Number(input.annualRatePercent);
  const termMonths = Math.min(600, Math.max(1, Math.round(Number(input.termMonths))));

  if (!isFiniteInBounds(principal, 1, 1e11) || !isFiniteInBounds(annualRatePercent, 0, 200)) {
    return { ok: false, error: 'Principal and rate must be valid non-negative finite numbers.' };
  }

  const r = annualRatePercent / 100 / 12;
  const monthlyPayment =
    r === 0
      ? principal / termMonths
      : (principal * (r * (1 + r) ** termMonths)) / ((1 + r) ** termMonths - 1);

  if (!Number.isFinite(monthlyPayment)) {
    return { ok: false, error: 'Loan payment calculation overflow.' };
  }

  const yearlySchedule: LoanSchedulePoint[] = [
    { month: 0, remainingBalance: roundTo(principal, 2), principalPaidCumulative: 0, interestPaidCumulative: 0 },
  ];

  let balance = principal;
  let cumPrincipal = 0;
  let cumInterest = 0;

  for (let m = 1; m <= termMonths; m++) {
    const interest = balance * r;
    const principalPart = Math.min(balance, monthlyPayment - interest);
    balance = Math.max(0, balance - principalPart);
    cumPrincipal += principalPart;
    cumInterest += interest;
    if (m % 12 === 0 || m === termMonths) {
      yearlySchedule.push({
        month: m,
        remainingBalance: roundTo(balance, 2),
        principalPaidCumulative: roundTo(cumPrincipal, 2),
        interestPaidCumulative: roundTo(cumInterest, 2),
      });
    }
  }

  const totalPaid = roundTo(monthlyPayment * termMonths, 2);
  const totalInterest = roundTo(totalPaid - principal, 2);
  return {
    ok: true,
    monthlyPayment: roundTo(monthlyPayment, 2),
    totalPaid,
    totalInterest: Math.max(0, totalInterest),
    yearlySchedule,
  };
}

// ==========================================
// 5. PURE SCIENTIFIC EXPRESSION EVALUATOR
// ==========================================

type Token =
  | { type: 'num'; value: number }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: '+' | '-' | '*' | '/' | '^' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' };

const ALLOWED_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

const ALLOWED_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sqrt: (v) => {
    if (v < 0) throw new Error('Square root of negative number.');
    return Math.sqrt(v);
  },
  abs: Math.abs,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: (v, decimals = 0) => {
    const d = Math.min(8, Math.max(0, Math.round(decimals)));
    const factor = 10 ** d;
    return Math.round((v + Number.EPSILON) * factor) / factor;
  },
  min: (...args) => Math.min(...args),
  max: (...args) => Math.max(...args),
};

function tokenizeMath(expr: string, extraIdentifiers?: ReadonlySet<string>): Token[] {
  if (typeof expr !== 'string' || expr.length === 0 || expr.length > 240) {
    throw new Error('Expression length out of bounds (1..240 chars).');
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let end = i;
      let dotCount = 0;
      while (end < expr.length && ((expr[end] >= '0' && expr[end] <= '9') || expr[end] === '.')) {
        if (expr[end] === '.') dotCount++;
        if (dotCount > 1) throw new Error('Malformed numeric literal.');
        end++;
      }
      const num = Number(expr.slice(i, end));
      if (!Number.isFinite(num)) throw new Error('Invalid number literal.');
      tokens.push({ type: 'num', value: num });
      i = end;
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let end = i;
      while (
        end < expr.length &&
        ((expr[end] >= 'a' && expr[end] <= 'z') ||
          (expr[end] >= 'A' && expr[end] <= 'Z') ||
          (expr[end] >= '0' && expr[end] <= '9') ||
          expr[end] === '_')
      ) {
        end++;
      }
      const ident = expr.slice(i, end).toLowerCase();
      if (
        !(ident in ALLOWED_CONSTANTS) &&
        !(ident in ALLOWED_FUNCTIONS) &&
        ident !== 'x' &&
        !extraIdentifiers?.has(ident)
      ) {
        throw new Error(`Unsupported identifier "${ident}".`);
      }
      tokens.push({ type: 'ident', value: ident });
      i = end;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '^') {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma' });
      i++;
      continue;
    }
    throw new Error(`Unsupported character "${ch}" in expression.`);
  }
  if (tokens.length === 0 || tokens.length > 128) {
    throw new Error('Expression token count out of bounds.');
  }
  return tokens;
}

export function evaluateSafeMathExpression(
  expr: string,
  variables: Record<string, number | undefined> = {}
): CalculatorResult<{ value: number }> {
  try {
    const normalizedVars: Record<string, number> = {};
    const extraIdents = new Set<string>();
    for (const [k, v] of Object.entries(variables)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        const lower = k.toLowerCase();
        normalizedVars[lower] = v;
        extraIdents.add(lower);
      }
    }
    const tokens = tokenizeMath(expr, extraIdents);
    let pos = 0;
    const peek = () => tokens[pos];
    const consume = () => tokens[pos++];

    const parsePrimary = (depth: number): number => {
      if (depth > 16) throw new Error('Expression nesting depth exceeds limit (16).');
      const tok = peek();
      if (!tok) throw new Error('Unexpected end of expression.');

      if (tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
        consume();
        const inner = parsePrimary(depth + 1);
        return tok.value === '-' ? -inner : inner;
      }
      if (tok.type === 'num') {
        consume();
        return tok.value;
      }
      if (tok.type === 'ident') {
        consume();
        if (Object.hasOwn(normalizedVars, tok.value)) {
          return normalizedVars[tok.value];
        }
        if (Object.hasOwn(ALLOWED_CONSTANTS, tok.value)) {
          return ALLOWED_CONSTANTS[tok.value];
        }
        const fn = Object.hasOwn(ALLOWED_FUNCTIONS, tok.value) ? ALLOWED_FUNCTIONS[tok.value] : undefined;
        if (!fn) throw new Error(`Unknown function "${tok.value}".`);
        const next = consume();
        if (!next || next.type !== 'lparen') throw new Error(`Expected "(" after function "${tok.value}".`);
        const args: number[] = [parseAdditive(depth + 1)];
        while (peek()?.type === 'comma') {
          consume();
          if (args.length >= 6) throw new Error(`Too many arguments to "${tok.value}".`);
          args.push(parseAdditive(depth + 1));
        }
        const close = consume();
        if (!close || close.type !== 'rparen') throw new Error(`Expected ")" after "${tok.value}" argument.`);
        const out = fn(...args);
        if (!Number.isFinite(out)) throw new Error(`Function "${tok.value}" produced non-finite value.`);
        return out;
      }
      if (tok.type === 'lparen') {
        consume();
        const inner = parseAdditive(depth + 1);
        const close = consume();
        if (!close || close.type !== 'rparen') throw new Error('Unmatched parenthesis.');
        return inner;
      }
      throw new Error('Unexpected token in expression.');
    };

    const parsePower = (depth: number): number => {
      const base = parsePrimary(depth);
      const tok = peek();
      if (tok?.type === 'op' && tok.value === '^') {
        consume();
        const exp = parsePower(depth + 1);
        const res = base ** exp;
        if (!Number.isFinite(res)) throw new Error('Exponentiation produced non-finite result.');
        return res;
      }
      return base;
    };

    const parseMultiplicative = (depth: number): number => {
      let left = parsePower(depth);
      while (true) {
        const tok = peek();
        if (tok?.type !== 'op' || (tok.value !== '*' && tok.value !== '/')) break;
        const op = consume() as Extract<Token, { type: 'op' }>;
        const right = parsePower(depth);
        if (op.value === '*') {
          left *= right;
        } else {
          if (right === 0) throw new Error('Division by zero.');
          left /= right;
        }
        if (!Number.isFinite(left)) throw new Error('Arithmetic result exceeded finite bounds.');
      }
      return left;
    };

    const parseAdditive = (depth: number): number => {
      let left = parseMultiplicative(depth);
      while (true) {
        const tok = peek();
        if (tok?.type !== 'op' || (tok.value !== '+' && tok.value !== '-')) break;
        const op = consume() as Extract<Token, { type: 'op' }>;
        const right = parseMultiplicative(depth);
        left = op.value === '+' ? left + right : left - right;
        if (!Number.isFinite(left)) throw new Error('Arithmetic result exceeded finite bounds.');
      }
      return left;
    };

    const value = parseAdditive(0);
    if (pos !== tokens.length) throw new Error('Unexpected trailing tokens in expression.');
    if (!Number.isFinite(value)) throw new Error('Non-finite expression output.');
    return { ok: true, value };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Invalid expression' };
  }
}

export function sampleSafeMathFunction(
  expr: string,
  xMin: number,
  xMax: number,
  steps = 25
): CalculatorResult<{ points: Array<{ x: number; y: number }> }> {
  const count = Math.min(100, Math.max(2, Math.round(steps)));
  if (!isFiniteInBounds(xMin) || !isFiniteInBounds(xMax) || xMax <= xMin) {
    return { ok: false, error: 'xMax must exceed xMin.' };
  }
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    const x = xMin + ((xMax - xMin) * i) / (count - 1);
    const evaluated = evaluateSafeMathExpression(expr, { x });
    if (!evaluated.ok) return { ok: false, error: evaluated.error };
    points.push({ x: roundTo(x, 4), y: roundTo(evaluated.value, 4) });
  }
  return { ok: true, points };
}

// ==========================================
// GENUI SURFACE BUILDERS FOR CALCULATORS
// ==========================================

export function buildCalculatorSurface(
  kind: GenUICalculatorKind,
  initialState: GenUIStateRecord = {},
  surfaceId = `calc_${kind}`
): GenUISurface {
  if (kind === 'compound_interest') {
    const state: GenUIStateRecord = {
      principal: Number(initialState.principal ?? 10000),
      annualRatePercent: Number(initialState.annualRatePercent ?? 8),
      years: Number(initialState.years ?? 10),
      compoundingPerYear: Number(initialState.compoundingPerYear ?? 12),
      monthlyContribution: Number(initialState.monthlyContribution ?? 250),
    };
    const res = computeCompoundInterest({
      principal: Number(state.principal),
      annualRatePercent: Number(state.annualRatePercent),
      years: Number(state.years),
      compoundingPerYear: Number(state.compoundingPerYear),
      monthlyContribution: Number(state.monthlyContribution),
    });

    const finalText = res.ok ? `$${formatNum(res.finalBalance)}` : res.error;
    const principalText = res.ok ? `$${formatNum(res.totalPrincipal)}` : '—';
    const interestText = res.ok ? `$${formatNum(res.totalInterest)}` : '—';
    const apyText = res.ok ? `${formatNum(res.effectiveAnnualYieldPercent, 2)}% APY` : undefined;
    const labels = res.ok ? res.yearlySchedule.map((r) => `Yr ${r.year}`) : ['Yr 0'];
    const totalSeries = res.ok ? res.yearlySchedule.map((r) => r.balance) : [0];
    const principalSeries = res.ok ? res.yearlySchedule.map((r) => r.principalContributed) : [0];

    const components: GenUIComponent[] = [
      { id: 'calc_root', type: 'vertical_group', props: { gap: 'md', children: ['calc_hdr', 'calc_metrics', 'calc_inputs', 'calc_chart', 'calc_footer'] } },
      { id: 'calc_hdr', type: 'heading', props: { level: 3, text: 'Compound Interest Explorer', subtitle: 'Deterministic real-time growth projection' } },
      { id: 'calc_metrics', type: 'responsive_grid', props: { columns: 3, gap: 'sm', children: ['metric_final', 'metric_principal', 'metric_interest'] } },
      { id: 'metric_final', type: 'metric_display', props: { label: 'Projected Balance', value: finalText, delta: apyText, deltaTone: 'positive' } },
      { id: 'metric_principal', type: 'metric_display', props: { label: 'Total Contributed', value: principalText, deltaTone: 'neutral' } },
      { id: 'metric_interest', type: 'metric_display', props: { label: 'Total Interest Earned', value: interestText, deltaTone: 'positive' } },
      {
        id: 'calc_inputs',
        type: 'responsive_grid',
        props: { columns: 2, gap: 'md', children: ['in_principal', 'in_rate', 'in_years', 'in_contrib'] },
      },
      { id: 'in_principal', type: 'numeric_input', props: { label: 'Initial Principal ($)', stateKey: 'principal', min: 0, max: 10000000, step: 500, defaultValue: Number(state.principal), unit: '$' } },
      { id: 'in_rate', type: 'slider', props: { label: 'Annual Rate (%)', stateKey: 'annualRatePercent', min: 0, max: 30, step: 0.25, defaultValue: Number(state.annualRatePercent), unit: '%' } },
      { id: 'in_years', type: 'slider', props: { label: 'Time Horizon (Years)', stateKey: 'years', min: 1, max: 40, step: 1, defaultValue: Number(state.years), unit: 'yrs' } },
      { id: 'in_contrib', type: 'numeric_input', props: { label: 'Monthly Contribution ($)', stateKey: 'monthlyContribution', min: 0, max: 500000, step: 50, defaultValue: Number(state.monthlyContribution), unit: '$/mo' } },
      {
        id: 'calc_chart',
        type: 'line_chart',
        props: {
          title: 'Balance Growth Over Time',
          labels,
          datasets: [
            { label: 'Total Balance', values: totalSeries, colorToken: 'primary' },
            { label: 'Total Principal', values: principalSeries, colorToken: 'secondary' },
          ],
          unit: '$',
          smooth: true,
          area: true,
          stacked: false,
          allowTableToggle: true,
        },
      },
      { id: 'calc_footer', type: 'horizontal_group', props: { gap: 'sm', wrap: true, align: 'center', children: ['btn_reset', 'btn_ask'] } },
      { id: 'btn_reset', type: 'reset_control', props: { label: 'Reset inputs' } },
      { id: 'btn_ask', type: 'action_button', props: { label: 'Ask AIRA about current inputs', actionId: 'act_followup', variant: 'primary', disabled: false } },
    ];

    return {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId,
      title: 'Compound Interest Explorer',
      rootId: 'calc_root',
      components,
      state,
      actions: [{ id: 'act_followup', label: 'Ask AIRA about current inputs', kind: 'attach_followup', permissionLevel: 'NONE', requiresApproval: false }],
      textFallback: `Compound interest result: balance ${finalText}, contributed ${principalText}, interest ${interestText}.`,
      evidence: [{ id: 'ev_calc', title: 'Deterministic Compound Interest Formula', sourceType: 'calculator', verified: true }],
      origin: 'deterministic_calculator',
      calculatorKind: 'compound_interest',
    };
  }

  if (kind === 'loan_payment') {
    const state: GenUIStateRecord = {
      principal: Number(initialState.principal ?? 250000),
      annualRatePercent: Number(initialState.annualRatePercent ?? 6.5),
      termMonths: Number(initialState.termMonths ?? 60),
    };
    const res = computeLoanPayment({
      principal: Number(state.principal),
      annualRatePercent: Number(state.annualRatePercent),
      termMonths: Number(state.termMonths),
    });
    const emiText = res.ok ? `$${formatNum(res.monthlyPayment)}` : res.error;
    const totalText = res.ok ? `$${formatNum(res.totalPaid)}` : '—';
    const intText = res.ok ? `$${formatNum(res.totalInterest)}` : '—';

    return {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId,
      title: 'Loan & Amortization Calculator',
      rootId: 'calc_root',
      components: [
        { id: 'calc_root', type: 'vertical_group', props: { gap: 'md', children: ['calc_hdr', 'calc_metrics', 'calc_inputs', 'calc_chart', 'calc_footer'] } },
        { id: 'calc_hdr', type: 'heading', props: { level: 3, text: 'Loan & EMI Calculator', subtitle: 'Monthly payment and principal vs interest amortization' } },
        { id: 'calc_metrics', type: 'responsive_grid', props: { columns: 3, gap: 'sm', children: ['metric_emi', 'metric_total', 'metric_interest'] } },
        { id: 'metric_emi', type: 'metric_display', props: { label: 'Monthly Payment', value: emiText, deltaTone: 'neutral' } },
        { id: 'metric_total', type: 'metric_display', props: { label: 'Total Repaid', value: totalText, deltaTone: 'neutral' } },
        { id: 'metric_interest', type: 'metric_display', props: { label: 'Total Interest', value: intText, deltaTone: 'negative' } },
        { id: 'calc_inputs', type: 'responsive_grid', props: { columns: 3, gap: 'md', children: ['in_principal', 'in_rate', 'in_term'] } },
        { id: 'in_principal', type: 'numeric_input', props: { label: 'Loan Amount ($)', stateKey: 'principal', min: 100, max: 100000000, step: 1000, defaultValue: Number(state.principal), unit: '$' } },
        { id: 'in_rate', type: 'slider', props: { label: 'APR (%)', stateKey: 'annualRatePercent', min: 0, max: 35, step: 0.25, defaultValue: Number(state.annualRatePercent), unit: '%' } },
        { id: 'in_term', type: 'slider', props: { label: 'Term (Months)', stateKey: 'termMonths', min: 6, max: 360, step: 6, defaultValue: Number(state.termMonths), unit: 'mo' } },
        {
          id: 'calc_chart',
          type: 'doughnut_chart',
          props: {
            title: 'Principal vs Total Interest',
            labels: ['Principal', 'Total Interest'],
            values: res.ok ? [Number(state.principal), res.totalInterest] : [1, 0],
            unit: '$',
            allowTableToggle: true,
          },
        },
        { id: 'calc_footer', type: 'horizontal_group', props: { gap: 'sm', wrap: true, align: 'center', children: ['btn_reset', 'btn_ask'] } },
        { id: 'btn_reset', type: 'reset_control', props: { label: 'Reset inputs' } },
        { id: 'btn_ask', type: 'action_button', props: { label: 'Ask AIRA about current inputs', actionId: 'act_followup', variant: 'primary', disabled: false } },
      ],
      state,
      actions: [{ id: 'act_followup', label: 'Ask AIRA about current inputs', kind: 'attach_followup', permissionLevel: 'NONE', requiresApproval: false }],
      textFallback: `Monthly payment: ${emiText}, total repaid: ${totalText}, interest: ${intText}.`,
      evidence: [{ id: 'ev_calc', title: 'Deterministic Amortization Formula', sourceType: 'calculator', verified: true }],
      origin: 'deterministic_calculator',
      calculatorKind: 'loan_payment',
    };
  }

  if (kind === 'percentage') {
    const mode = (String(initialState.mode ?? 'percent_of') as PercentageMode);
    const state: GenUIStateRecord = {
      mode,
      valueA: Number(initialState.valueA ?? 15),
      valueB: Number(initialState.valueB ?? 240),
    };
    const res = computePercentage({ mode, valueA: Number(state.valueA), valueB: Number(state.valueB) });
    return {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId,
      title: 'Percentage Calculator',
      rootId: 'calc_root',
      components: [
        { id: 'calc_root', type: 'vertical_group', props: { gap: 'md', children: ['calc_hdr', 'in_mode', 'calc_inputs', 'metric_result', 'calc_footer'] } },
        { id: 'calc_hdr', type: 'heading', props: { level: 3, text: 'Percentage Calculator' } },
        {
          id: 'in_mode',
          type: 'segmented_control',
          props: {
            label: 'Calculation Mode',
            stateKey: 'mode',
            defaultValue: mode,
            options: [
              { label: 'X% of Y', value: 'percent_of' },
              { label: 'X is what % of Y', value: 'what_percent' },
              { label: '% change X -> Y', value: 'percent_change' },
            ],
          },
        },
        { id: 'calc_inputs', type: 'responsive_grid', props: { columns: 2, gap: 'md', children: ['in_a', 'in_b'] } },
        { id: 'in_a', type: 'numeric_input', props: { label: 'Value X', stateKey: 'valueA', step: 1, defaultValue: Number(state.valueA) } },
        { id: 'in_b', type: 'numeric_input', props: { label: 'Value Y', stateKey: 'valueB', step: 1, defaultValue: Number(state.valueB) } },
        { id: 'metric_result', type: 'metric_display', props: { label: 'Result', value: res.ok ? res.formatted : res.error, caption: res.ok ? res.explanation : undefined, deltaTone: 'neutral' } },
        { id: 'calc_footer', type: 'horizontal_group', props: { gap: 'sm', wrap: true, align: 'center', children: ['btn_reset', 'btn_ask'] } },
        { id: 'btn_reset', type: 'reset_control', props: { label: 'Reset inputs' } },
        { id: 'btn_ask', type: 'action_button', props: { label: 'Ask AIRA about current inputs', actionId: 'act_followup', variant: 'primary', disabled: false } },
      ],
      state,
      actions: [{ id: 'act_followup', label: 'Ask AIRA about current inputs', kind: 'attach_followup', permissionLevel: 'NONE', requiresApproval: false }],
      textFallback: res.ok ? res.explanation : res.error,
      evidence: [{ id: 'ev_calc', title: 'Deterministic Percentage Evaluator', sourceType: 'calculator', verified: true }],
      origin: 'deterministic_calculator',
      calculatorKind: 'percentage',
    };
  }

  if (kind === 'unit_conversion') {
    const category = (String(initialState.category ?? 'length') as UnitCategory);
    const defaultUnits: Record<UnitCategory, [string, string]> = {
      length: ['km', 'mi'],
      mass: ['kg', 'lb'],
      temperature: ['C', 'F'],
      data: ['GB', 'MB'],
      speed: ['km/h', 'mph'],
      time: ['h', 'min'],
    };
    const [defFrom, defTo] = defaultUnits[category] ?? ['km', 'mi'];
    const state: GenUIStateRecord = {
      category,
      value: Number(initialState.value ?? 10),
      fromUnit: String(initialState.fromUnit ?? defFrom),
      toUnit: String(initialState.toUnit ?? defTo),
    };
    const res = computeUnitConversion({
      category,
      value: Number(state.value),
      fromUnit: String(state.fromUnit),
      toUnit: String(state.toUnit),
    });
    const unitOptions =
      category === 'temperature'
        ? [
            { label: 'Celsius (C)', value: 'C' },
            { label: 'Fahrenheit (F)', value: 'F' },
            { label: 'Kelvin (K)', value: 'K' },
          ]
        : Object.keys(LINEAR_FACTORS[category] ?? LINEAR_FACTORS.length).map((u) => ({ label: u, value: u }));

    return {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId,
      title: 'Unit Converter',
      rootId: 'calc_root',
      components: [
        { id: 'calc_root', type: 'vertical_group', props: { gap: 'md', children: ['calc_hdr', 'calc_inputs', 'metric_result', 'calc_footer'] } },
        { id: 'calc_hdr', type: 'heading', props: { level: 3, text: 'Unit Converter', subtitle: `Category: ${category}` } },
        { id: 'calc_inputs', type: 'responsive_grid', props: { columns: 3, gap: 'md', children: ['in_val', 'in_from', 'in_to'] } },
        { id: 'in_val', type: 'numeric_input', props: { label: 'Value', stateKey: 'value', step: 1, defaultValue: Number(state.value) } },
        { id: 'in_from', type: 'select_control', props: { label: 'From', stateKey: 'fromUnit', defaultValue: String(state.fromUnit), options: unitOptions } },
        { id: 'in_to', type: 'select_control', props: { label: 'To', stateKey: 'toUnit', defaultValue: String(state.toUnit), options: unitOptions } },
        { id: 'metric_result', type: 'metric_display', props: { label: 'Converted Value', value: res.ok ? res.formatted : res.error, deltaTone: 'neutral' } },
        { id: 'calc_footer', type: 'horizontal_group', props: { gap: 'sm', wrap: true, align: 'center', children: ['btn_reset', 'btn_ask'] } },
        { id: 'btn_reset', type: 'reset_control', props: { label: 'Reset inputs' } },
        { id: 'btn_ask', type: 'action_button', props: { label: 'Ask AIRA about current inputs', actionId: 'act_followup', variant: 'primary', disabled: false } },
      ],
      state,
      actions: [{ id: 'act_followup', label: 'Ask AIRA about current inputs', kind: 'attach_followup', permissionLevel: 'NONE', requiresApproval: false }],
      textFallback: res.ok ? `${state.value} ${state.fromUnit} = ${res.formatted}` : res.error,
      evidence: [{ id: 'ev_calc', title: 'Deterministic Unit Conversion Table', sourceType: 'calculator', verified: true }],
      origin: 'deterministic_calculator',
      calculatorKind: 'unit_conversion',
    };
  }

  // scientific_eval
  const expression = String(initialState.expression ?? 'sin(x) + 0.5 * cos(2 * x)');
  const xMin = Number(initialState.xMin ?? -6);
  const xMax = Number(initialState.xMax ?? 6);
  const state: GenUIStateRecord = { expression, xMin, xMax };
  const sampled = sampleSafeMathFunction(expression, xMin, xMax, 25);
  const midpoint = evaluateSafeMathExpression(expression, { x: (xMin + xMax) / 2 });

  return {
    schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
    surfaceId,
    title: 'Scientific Function Visualizer',
    rootId: 'calc_root',
    components: [
      { id: 'calc_root', type: 'vertical_group', props: { gap: 'md', children: ['calc_hdr', 'in_expr', 'calc_bounds', 'metric_mid', 'calc_chart', 'calc_footer'] } },
      { id: 'calc_hdr', type: 'heading', props: { level: 3, text: 'Scientific Function Plotter', subtitle: 'Safe recursive-descent math parser (no dynamic eval)' } },
      { id: 'in_expr', type: 'text_input', props: { label: 'f(x) =', stateKey: 'expression', placeholder: 'sin(x) + x^2', defaultValue: expression, maxLength: 200 } },
      { id: 'calc_bounds', type: 'responsive_grid', props: { columns: 2, gap: 'md', children: ['in_xmin', 'in_xmax'] } },
      { id: 'in_xmin', type: 'numeric_input', props: { label: 'x Min', stateKey: 'xMin', step: 1, defaultValue: xMin } },
      { id: 'in_xmax', type: 'numeric_input', props: { label: 'x Max', stateKey: 'xMax', step: 1, defaultValue: xMax } },
      { id: 'metric_mid', type: 'metric_display', props: { label: `Midpoint f(${roundTo((xMin + xMax) / 2, 2)})`, value: midpoint.ok ? formatNum(midpoint.value, 4) : midpoint.error, deltaTone: 'neutral' } },
      {
        id: 'calc_chart',
        type: 'scatter_chart',
        props: {
          title: `Plot of f(x) = ${expression}`,
          xLabel: 'x',
          yLabel: 'f(x)',
          series: [{ label: 'f(x)', points: sampled.ok ? sampled.points : [{ x: 0, y: 0 }], colorToken: 'primary' }],
          allowTableToggle: true,
        },
      },
      { id: 'calc_footer', type: 'horizontal_group', props: { gap: 'sm', wrap: true, align: 'center', children: ['btn_reset', 'btn_ask'] } },
      { id: 'btn_reset', type: 'reset_control', props: { label: 'Reset inputs' } },
      { id: 'btn_ask', type: 'action_button', props: { label: 'Ask AIRA about current inputs', actionId: 'act_followup', variant: 'primary', disabled: false } },
    ],
    state,
    actions: [{ id: 'act_followup', label: 'Ask AIRA about current inputs', kind: 'attach_followup', permissionLevel: 'NONE', requiresApproval: false }],
    textFallback: sampled.ok
      ? `f(x) = ${expression} sampled over [${xMin}, ${xMax}]; midpoint = ${midpoint.ok ? formatNum(midpoint.value, 4) : 'N/A'}.`
      : sampled.error,
    evidence: [{ id: 'ev_calc', title: 'Deterministic Safe Math Parser', sourceType: 'calculator', verified: true }],
    origin: 'deterministic_calculator',
    calculatorKind: 'scientific_eval',
  };
}

export function recomputeCalculatorSurface(
  surface: GenUISurface,
  nextState: GenUIStateRecord
): GenUISurface {
  if (!surface.calculatorKind) {
    return { ...surface, state: nextState };
  }
  const rebuilt = buildCalculatorSurface(surface.calculatorKind, nextState, surface.surfaceId);
  return {
    ...rebuilt,
    title: surface.title ?? rebuilt.title,
    modelId: surface.modelId,
    generatedAt: surface.generatedAt,
  };
}
