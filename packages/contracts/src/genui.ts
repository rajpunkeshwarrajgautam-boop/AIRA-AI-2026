import { z } from 'zod';
import {
  isSafeGenUIRegexPattern,
  validateComputedDependencyGraph,
  writeStateKeyOrPointer,
} from './genui-reactive.js';

export const AIRA_GENUI_CONTRACT_VERSION = 'aira-genui/v1' as const;

export const AIRA_GENUI_LIMITS = {
  maxPayloadBytes: 256 * 1024,
  maxStateBytes: 64 * 1024,
  maxComponents: 100,
  maxNestingDepth: 8,
  maxTextLength: 16384,
  maxShortTextLength: 280,
  maxChildrenPerLayout: 48,
  maxTableColumns: 20,
  maxTableRows: 500,
  maxChartLabels: 120,
  maxChartDatasets: 16,
  maxScatterPoints: 300,
  maxOptions: 32,
  maxActions: 24,
  maxEvidenceItems: 24,
  maxTimelineEvents: 60,
  maxToolItems: 40,
} as const;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_OBJECT_WALK_DEPTH = 16;

export function containsForbiddenObjectKey(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): boolean {
  if (depth > MAX_OBJECT_WALK_DEPTH) return true;
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenObjectKey(item, seen, depth + 1));
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    const child = (value as Record<string, unknown>)[key];
    if (containsForbiddenObjectKey(child, seen, depth + 1)) return true;
  }
  return false;
}

const IdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/, 'Invalid GenUI identifier');

const StateKeySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^(?:\/[a-zA-Z0-9_.\/~-]{1,118}|[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})$/, 'Invalid GenUI state key or JSON Pointer')
  .refine(
    (k) =>
      !FORBIDDEN_KEYS.has(k) &&
      !k.includes('..') &&
      !k.split('/').some((seg) => FORBIDDEN_KEYS.has(seg)),
    'Forbidden state key'
  );

export const GenUIDataReferenceSchema = z
  .string()
  .min(2)
  .max(160)
  .regex(/^\/[a-zA-Z0-9_.\/~-]{1,159}$/, 'Data reference must start with /')
  .refine(
    (ref) =>
      !ref.includes('..') &&
      !ref.split('/').some((seg) => FORBIDDEN_KEYS.has(seg)),
    'Forbidden path segment in data reference'
  );

export type GenUIDataReference = z.infer<typeof GenUIDataReferenceSchema>;

export const HttpUrlSchema = z
  .string()
  .max(2048)
  .refine((uri) => {
    try {
      const parsed = new URL(uri);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Only http: and https: URIs are allowed');

const SafeFiniteNumberSchema = z.number().finite();

const SafePrimitiveSchema = z.union([
  z.string().max(4096),
  SafeFiniteNumberSchema,
  z.boolean(),
  z.null(),
]);

const MAX_GENUI_STATE_DEPTH = 8;

function buildGenUIStateValueSchema(depth: number): z.ZodType<any> {
  if (depth >= MAX_GENUI_STATE_DEPTH) {
    return SafePrimitiveSchema;
  }
  return z.lazy(() =>
    z.union([
      SafePrimitiveSchema,
      z.array(buildGenUIStateValueSchema(depth + 1)).max(500),
      z.record(
        z.string().min(1).max(80).refine((k) => !FORBIDDEN_KEYS.has(k), 'Forbidden state key'),
        buildGenUIStateValueSchema(depth + 1)
      ),
    ])
  );
}

export const GenUIStateValueSchema: z.ZodType<any> = buildGenUIStateValueSchema(0);

export type GenUIStateValue =
  | string
  | number
  | boolean
  | null
  | GenUIStateValue[]
  | { [key: string]: GenUIStateValue };

export const GenUIStateRecordSchema = z
  .record(StateKeySchema, GenUIStateValueSchema)
  .refine((rec) => !containsForbiddenObjectKey(rec), 'Forbidden key in GenUI state');

export type GenUIStateRecord = Record<string, GenUIStateValue>;

export const GenUICheckRuleSchema = z
  .object({
    kind: z.enum(['required', 'regex', 'length', 'numeric', 'email']),
    valueRef: GenUIDataReferenceSchema.optional(),
    pattern: z
      .string()
      .max(120)
      .refine((p) => isSafeGenUIRegexPattern(p), 'Unsafe or overly complex regex pattern')
      .optional(),
    min: SafeFiniteNumberSchema.optional(),
    max: SafeFiniteNumberSchema.optional(),
    message: z.string().min(1).max(200).optional(),
  })
  .strict();

export type GenUICheckRule = z.infer<typeof GenUICheckRuleSchema>;

export const GenUIVisibleConditionSchema = z
  .object({
    stateKey: StateKeySchema,
    equals: SafePrimitiveSchema.optional(),
    notEquals: SafePrimitiveSchema.optional(),
    min: SafeFiniteNumberSchema.optional(),
    max: SafeFiniteNumberSchema.optional(),
    truthy: z.boolean().optional(),
  })
  .strict();

export type GenUIVisibleCondition = z.infer<typeof GenUIVisibleConditionSchema>;

export const GenUIComputedRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    target: GenUIDataReferenceSchema,
    kind: z.literal('math'),
    expression: z.string().min(1).max(240),
    bindings: z.record(z.string().min(1).max(48), StateKeySchema).optional(),
    decimals: z.number().int().min(0).max(8).optional(),
    deps: z.array(StateKeySchema).max(24).optional(),
  }).strict(),
  z.object({
    target: GenUIDataReferenceSchema,
    kind: z.literal('compound_growth'),
    principalRef: StateKeySchema,
    monthlyContributionRef: StateKeySchema.optional(),
    annualRateRef: StateKeySchema,
    yearsRef: StateKeySchema,
    currency: z.string().max(8).optional(),
    deps: z.array(StateKeySchema).max(16).optional(),
  }).strict(),
  z.object({
    target: GenUIDataReferenceSchema,
    kind: z.literal('amortization'),
    principalRef: StateKeySchema,
    annualRateRef: StateKeySchema,
    termMonthsRef: StateKeySchema,
    termIsYears: z.boolean().optional(),
    currency: z.string().max(8).optional(),
    deps: z.array(StateKeySchema).max(16).optional(),
  }).strict(),
  z.object({
    target: GenUIDataReferenceSchema,
    kind: z.literal('function_series'),
    expressionRef: StateKeySchema,
    xMinRef: StateKeySchema.optional(),
    xMaxRef: StateKeySchema.optional(),
    steps: z.number().int().min(5).max(80).optional(),
    deps: z.array(StateKeySchema).max(16).optional(),
  }).strict(),
  z.object({
    target: GenUIDataReferenceSchema,
    kind: z.literal('weighted_decision'),
    candidatesRef: StateKeySchema,
    weightsRef: StateKeySchema,
    filterRef: StateKeySchema.optional(),
    filterField: z.string().max(64).optional(),
    nameField: z.string().max(64).optional(),
    criteria: z.array(z.object({ key: z.string().min(1).max(64), label: z.string().min(1).max(120) }).strict()).min(1).max(16),
    deps: z.array(StateKeySchema).max(16).optional(),
  }).strict(),
  z.object({
    target: GenUIDataReferenceSchema,
    kind: z.literal('table_filter_aggregate'),
    rowsRef: StateKeySchema,
    searchRef: StateKeySchema.optional(),
    categoryRef: StateKeySchema.optional(),
    categoryField: z.string().max(64).optional(),
    minValueRef: StateKeySchema.optional(),
    labelField: z.string().max(64).optional(),
    valueField: z.string().max(64).optional(),
    metricLabel: z.string().max(80).optional(),
    currency: z.string().max(8).optional(),
    deps: z.array(StateKeySchema).max(16).optional(),
  }).strict(),
  z.object({
    target: GenUIDataReferenceSchema,
    kind: z.literal('progress_ratio'),
    itemKeys: z.array(StateKeySchema).max(64).optional(),
    itemsRef: StateKeySchema.optional(),
    doneField: z.string().max(64).optional(),
    deps: z.array(StateKeySchema).max(24).optional(),
  }).strict(),
  z.object({
    target: GenUIDataReferenceSchema,
    kind: z.literal('format_value'),
    valueRef: StateKeySchema,
    format: z.enum(['currency', 'number', 'percent']),
    currency: z.string().max(8).optional(),
    decimals: z.number().int().min(0).max(6).optional(),
    deps: z.array(StateKeySchema).max(8).optional(),
  }).strict(),
]);

export type GenUIComputedRule = z.infer<typeof GenUIComputedRuleSchema>;

export const GenUIEvidenceItemSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1).max(240),
    uri: HttpUrlSchema.optional(),
    snippet: z.string().max(1000).optional(),
    sourceType: z.enum(['tool', 'knowledge', 'web', 'runtime', 'calculator']).default('runtime'),
    verified: z.boolean().default(false),
    timestamp: z.number().finite().optional(),
  })
  .strict();

export type GenUIEvidenceItem = z.infer<typeof GenUIEvidenceItemSchema>;

export const GenUIActionKindSchema = z.enum([
  'local_recompute',
  'attach_followup',
  'run_approval',
  'workflow_trigger',
  'reset_state',
  'open_artifact',
]);

export const GenUIActionDefinitionSchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1).max(120),
    kind: GenUIActionKindSchema,
    permissionLevel: z.enum(['NONE', 'READ', 'WRITE', 'DESTRUCTIVE']).default('NONE'),
    requiresApproval: z.boolean().default(false),
    confirmMessage: z.string().max(280).optional(),
    targetRunId: IdSchema.optional(),
    targetApprovalId: IdSchema.optional(),
    targetArtifactId: IdSchema.optional(),
    allowedKeys: z.array(StateKeySchema).max(32).optional(),
    promptTemplate: z.string().max(1000).optional(),
  })
  .strict();

export type GenUIActionDefinition = z.infer<typeof GenUIActionDefinitionSchema>;

const OptionItemSchema = z
  .object({
    label: z.string().min(1).max(120),
    value: z.string().min(1).max(120),
    description: z.string().max(240).optional(),
  })
  .strict();

// ==========================================
// COMPONENT CATALOG (DISCRIMINATED UNION)
// ==========================================

// 1. Content components
const TextComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('text'),
  props: z
    .object({
      text: z.string().max(AIRA_GENUI_LIMITS.maxTextLength),
      variant: z.enum(['body', 'muted', 'lead', 'emphasis']).default('body'),
      dataRef: GenUIDataReferenceSchema.optional(),
    })
    .strict(),
}).strict();

const HeadingComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('heading'),
  props: z
    .object({
      level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(3),
      text: z.string().min(1).max(AIRA_GENUI_LIMITS.maxShortTextLength),
      subtitle: z.string().max(AIRA_GENUI_LIMITS.maxShortTextLength).optional(),
    })
    .strict(),
}).strict();

const CaptionComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('caption'),
  props: z
    .object({
      text: z.string().min(1).max(500),
      sourceLabel: z.string().max(120).optional(),
    })
    .strict(),
}).strict();

const RichTextComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('rich_text'),
  props: z
    .object({
      markdown: z.string().max(AIRA_GENUI_LIMITS.maxTextLength),
    })
    .strict(),
}).strict();

const DividerComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('divider'),
  props: z
    .object({
      label: z.string().max(80).optional(),
    })
    .strict()
    .default({}),
}).strict();

const CodeBlockComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('code_block'),
  props: z
    .object({
      code: z.string().max(AIRA_GENUI_LIMITS.maxTextLength),
      language: z.string().max(40).default('plaintext'),
      title: z.string().max(120).optional(),
    })
    .strict(),
}).strict();

const MathBlockComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('math_block'),
  props: z
    .object({
      latex: z.string().min(1).max(4096),
      displayMode: z.boolean().default(true),
      caption: z.string().max(240).optional(),
    })
    .strict(),
}).strict();

const TableColumnSchema = z
  .object({
    key: z.string().min(1).max(64),
    label: z.string().min(1).max(120),
    align: z.enum(['left', 'center', 'right']).default('left'),
    format: z.enum(['text', 'number', 'currency', 'percent']).default('text'),
  })
  .strict();

const TableCellValueSchema = z.union([z.string().max(500), SafeFiniteNumberSchema, z.boolean(), z.null()]);

const DataTableComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('data_table'),
  checks: z.array(GenUICheckRuleSchema).max(16).optional(),
  visibleWhen: GenUIVisibleConditionSchema.optional(),
  props: z
    .object({
      title: z.string().max(160).optional(),
      columns: z.array(TableColumnSchema).min(1).max(AIRA_GENUI_LIMITS.maxTableColumns),
      rows: z
        .array(z.record(z.string().max(64), TableCellValueSchema))
        .max(AIRA_GENUI_LIMITS.maxTableRows),
      rowsRef: GenUIDataReferenceSchema.optional(),
      sortable: z.boolean().default(true),
      compact: z.boolean().default(false),
    })
    .strict(),
}).strict();

const SummaryItemSchema = z
  .object({
    label: z.string().min(1).max(120),
    value: z.union([z.string().max(240), SafeFiniteNumberSchema]),
    stateKey: StateKeySchema.optional(),
    note: z.string().max(240).optional(),
  })
  .strict();

const DataSummaryComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('data_summary'),
  props: z
    .object({
      title: z.string().max(160).optional(),
      items: z.array(SummaryItemSchema).min(1).max(24),
    })
    .strict(),
}).strict();

// 2. Layout components (children reference IDs in the flat component graph)
const ChildrenProp = z.array(IdSchema).max(AIRA_GENUI_LIMITS.maxChildrenPerLayout);

const VerticalGroupComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('vertical_group'),
  props: z
    .object({
      gap: z.enum(['xs', 'sm', 'md', 'lg']).default('md'),
      children: ChildrenProp,
    })
    .strict(),
}).strict();

const HorizontalGroupComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('horizontal_group'),
  props: z
    .object({
      gap: z.enum(['xs', 'sm', 'md', 'lg']).default('md'),
      wrap: z.boolean().default(true),
      align: z.enum(['start', 'center', 'end', 'stretch']).default('stretch'),
      children: ChildrenProp,
    })
    .strict(),
}).strict();

const ResponsiveGridComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('responsive_grid'),
  props: z
    .object({
      columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(2),
      gap: z.enum(['sm', 'md', 'lg']).default('md'),
      children: ChildrenProp,
    })
    .strict(),
}).strict();

const CardComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('card'),
  props: z
    .object({
      title: z.string().max(160).optional(),
      subtitle: z.string().max(240).optional(),
      tone: z.enum(['default', 'elevated', 'subtle', 'accent']).default('default'),
      children: ChildrenProp,
    })
    .strict(),
}).strict();

const SectionComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('section'),
  checks: z.array(GenUICheckRuleSchema).max(16).optional(),
  visibleWhen: GenUIVisibleConditionSchema.optional(),
  props: z
    .object({
      title: z.string().min(1).max(160),
      description: z.string().max(300).optional(),
      collapsible: z.boolean().default(false),
      defaultCollapsed: z.boolean().default(false),
      children: ChildrenProp,
    })
    .strict(),
}).strict();

const AdaptiveContainerComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('adaptive_container'),
  props: z
    .object({
      maxWidth: z.enum(['sm', 'md', 'lg', 'full']).default('lg'),
      padding: z.enum(['none', 'sm', 'md']).default('md'),
      children: ChildrenProp,
    })
    .strict(),
}).strict();

// 3. Data visualization components
const ChartDatasetSchema = z
  .object({
    label: z.string().min(1).max(100),
    values: z.array(SafeFiniteNumberSchema).max(AIRA_GENUI_LIMITS.maxChartLabels),
    colorToken: z.enum(['primary', 'secondary', 'tertiary', 'accent', 'success', 'warning']).optional(),
  })
  .strict();

const CartesianChartPropsSchema = z
  .object({
    title: z.string().min(1).max(160),
    subtitle: z.string().max(240).optional(),
    labels: z.array(z.string().min(1).max(80)).max(AIRA_GENUI_LIMITS.maxChartLabels),
    datasets: z.array(ChartDatasetSchema).max(AIRA_GENUI_LIMITS.maxChartDatasets),
    labelsRef: GenUIDataReferenceSchema.optional(),
    datasetsRef: GenUIDataReferenceSchema.optional(),
    unit: z.string().max(32).optional(),
    stacked: z.boolean().default(false),
    allowTableToggle: z.boolean().default(true),
  })
  .strict()
  .refine(
    (p) => (p.labels.length >= 1 && p.datasets.length >= 1) || Boolean(p.labelsRef || p.datasetsRef),
    'Cartesian chart requires labels and datasets or reactive bindings'
  );

const BarChartComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('bar_chart'),
  props: CartesianChartPropsSchema.extend({
    horizontal: z.boolean().default(false),
  }).strict(),
}).strict();

const LineChartComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('line_chart'),
  props: CartesianChartPropsSchema.extend({
    smooth: z.boolean().default(true),
    area: z.boolean().default(false),
  }).strict(),
}).strict();

const ScatterPointSchema = z
  .object({
    x: SafeFiniteNumberSchema,
    y: SafeFiniteNumberSchema,
    label: z.string().max(80).optional(),
  })
  .strict();

const ScatterSeriesSchema = z
  .object({
    label: z.string().min(1).max(100),
    points: z.array(ScatterPointSchema).min(1).max(AIRA_GENUI_LIMITS.maxScatterPoints),
    colorToken: z.enum(['primary', 'secondary', 'tertiary', 'accent']).optional(),
  })
  .strict();

const ScatterChartComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('scatter_chart'),
  props: z
    .object({
      title: z.string().min(1).max(160),
      subtitle: z.string().max(240).optional(),
      xLabel: z.string().max(80).default('X'),
      yLabel: z.string().max(80).default('Y'),
      series: z.array(ScatterSeriesSchema).max(AIRA_GENUI_LIMITS.maxChartDatasets),
      seriesRef: GenUIDataReferenceSchema.optional(),
      allowTableToggle: z.boolean().default(true),
    })
    .strict(),
}).strict();

const RadialChartPropsSchema = z
  .object({
    title: z.string().min(1).max(160),
    subtitle: z.string().max(240).optional(),
    labels: z.array(z.string().min(1).max(80)).max(20),
    values: z.array(z.number().finite().nonnegative()).max(20),
    labelsRef: GenUIDataReferenceSchema.optional(),
    valuesRef: GenUIDataReferenceSchema.optional(),
    unit: z.string().max(32).optional(),
    allowTableToggle: z.boolean().default(true),
  })
  .strict()
  .refine(
    (p) => (p.labels.length === p.values.length && p.labels.length >= 1) || Boolean(p.labelsRef && p.valuesRef),
    'Radial chart labels and values length must match'
  );

const PieChartComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('pie_chart'),
  props: RadialChartPropsSchema,
}).strict();

const DoughnutChartComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('doughnut_chart'),
  props: RadialChartPropsSchema,
}).strict();

const ProgressIndicatorComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('progress_indicator'),
  props: z
    .object({
      label: z.string().min(1).max(160),
      value: z.number().finite().min(0),
      valueRef: GenUIDataReferenceSchema.optional(),
      max: z.number().finite().positive().default(100),
      unit: z.string().max(24).optional(),
      tone: z.enum(['neutral', 'accent', 'success', 'warning', 'danger']).default('accent'),
    })
    .strict(),
}).strict();

const MetricDisplayComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('metric_display'),
  props: z
    .object({
      label: z.string().min(1).max(120),
      value: z.union([z.string().max(80), SafeFiniteNumberSchema]),
      stateKey: StateKeySchema.optional(),
      dataRef: GenUIDataReferenceSchema.optional(),
      delta: z.string().max(64).optional(),
      deltaTone: z.enum(['positive', 'negative', 'neutral']).default('neutral'),
      caption: z.string().max(200).optional(),
    })
    .strict(),
}).strict();

const ComparisonBarItemSchema = z
  .object({
    label: z.string().min(1).max(100),
    primaryValue: SafeFiniteNumberSchema,
    secondaryValue: SafeFiniteNumberSchema.optional(),
    note: z.string().max(160).optional(),
  })
  .strict();

const ComparisonVizComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('comparison_viz'),
  props: z
    .object({
      title: z.string().min(1).max(160),
      primaryLabel: z.string().min(1).max(64).default('Baseline'),
      secondaryLabel: z.string().max(64).optional(),
      unit: z.string().max(24).optional(),
      items: z.array(ComparisonBarItemSchema).min(1).max(20),
    })
    .strict(),
}).strict();

// 4. Interactive components
const NumericInputComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('numeric_input'),
  checks: z.array(GenUICheckRuleSchema).max(16).optional(),
  visibleWhen: GenUIVisibleConditionSchema.optional(),
  props: z
    .object({
      label: z.string().min(1).max(120),
      stateKey: StateKeySchema,
      min: SafeFiniteNumberSchema.optional(),
      max: SafeFiniteNumberSchema.optional(),
      step: z.number().finite().positive().default(1),
      defaultValue: SafeFiniteNumberSchema.default(0),
      unit: z.string().max(24).optional(),
      helperText: z.string().max(200).optional(),
    })
    .strict(),
}).strict();

const TextInputComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('text_input'),
  checks: z.array(GenUICheckRuleSchema).max(16).optional(),
  visibleWhen: GenUIVisibleConditionSchema.optional(),
  props: z
    .object({
      label: z.string().min(1).max(120),
      stateKey: StateKeySchema,
      placeholder: z.string().max(120).optional(),
      defaultValue: z.string().max(500).default(''),
      maxLength: z.number().int().min(1).max(500).default(240),
    })
    .strict(),
}).strict();

const SliderComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('slider'),
  checks: z.array(GenUICheckRuleSchema).max(16).optional(),
  visibleWhen: GenUIVisibleConditionSchema.optional(),
  props: z
    .object({
      label: z.string().min(1).max(120),
      stateKey: StateKeySchema,
      min: SafeFiniteNumberSchema,
      max: SafeFiniteNumberSchema,
      step: z.number().finite().positive().default(1),
      defaultValue: SafeFiniteNumberSchema,
      unit: z.string().max(24).optional(),
    })
    .strict()
    .refine((p) => p.max > p.min, 'Slider max must exceed min'),
}).strict();

const SelectControlComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('select_control'),
  checks: z.array(GenUICheckRuleSchema).max(16).optional(),
  visibleWhen: GenUIVisibleConditionSchema.optional(),
  props: z
    .object({
      label: z.string().min(1).max(120),
      stateKey: StateKeySchema,
      defaultValue: z.string().max(120),
      options: z.array(OptionItemSchema).min(1).max(AIRA_GENUI_LIMITS.maxOptions),
    })
    .strict(),
}).strict();

const CheckboxComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('checkbox'),
  checks: z.array(GenUICheckRuleSchema).max(16).optional(),
  visibleWhen: GenUIVisibleConditionSchema.optional(),
  props: z
    .object({
      label: z.string().min(1).max(160),
      stateKey: StateKeySchema,
      defaultChecked: z.boolean().default(false),
      description: z.string().max(240).optional(),
    })
    .strict(),
}).strict();

const RadioGroupComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('radio_group'),
  checks: z.array(GenUICheckRuleSchema).max(16).optional(),
  visibleWhen: GenUIVisibleConditionSchema.optional(),
  props: z
    .object({
      label: z.string().min(1).max(120),
      stateKey: StateKeySchema,
      defaultValue: z.string().max(120),
      options: z.array(OptionItemSchema).min(1).max(AIRA_GENUI_LIMITS.maxOptions),
    })
    .strict(),
}).strict();

const SegmentedControlComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('segmented_control'),
  checks: z.array(GenUICheckRuleSchema).max(16).optional(),
  visibleWhen: GenUIVisibleConditionSchema.optional(),
  props: z
    .object({
      label: z.string().min(1).max(120),
      stateKey: StateKeySchema,
      defaultValue: z.string().max(120),
      options: z.array(OptionItemSchema).min(2).max(8),
    })
    .strict(),
}).strict();

const ResetControlComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('reset_control'),
  visibleWhen: GenUIVisibleConditionSchema.optional(),
  props: z
    .object({
      label: z.string().min(1).max(80).default('Reset inputs'),
      actionId: IdSchema.optional(),
    })
    .strict(),
}).strict();

const ActionButtonComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('action_button'),
  visibleWhen: GenUIVisibleConditionSchema.optional(),
  props: z
    .object({
      label: z.string().min(1).max(100),
      actionId: IdSchema,
      variant: z.enum(['primary', 'secondary', 'ghost', 'danger']).default('secondary'),
      disabled: z.boolean().default(false),
      requiresValidState: z.boolean().optional(),
      setState: z.record(StateKeySchema, SafePrimitiveSchema).optional(),
    })
    .strict(),
}).strict();

// 5. Agent execution components
const ExecutionStatusBadgeSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

const MissionSummaryComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('mission_summary'),
  props: z
    .object({
      title: z.string().min(1).max(200),
      status: ExecutionStatusBadgeSchema,
      intent: z.string().max(64).default('AGENT_MISSION'),
      stepCount: z.number().int().nonnegative().default(0),
      completedSteps: z.number().int().nonnegative().default(0),
      summary: z.string().max(600).optional(),
      modelLabel: z.string().max(120).optional(),
    })
    .strict(),
}).strict();

const TaskStatusComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('task_status'),
  props: z
    .object({
      taskName: z.string().min(1).max(160),
      status: z.enum(['PENDING', 'RUNNING', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED']),
      detail: z.string().max(320).optional(),
      durationMs: z.number().finite().nonnegative().optional(),
    })
    .strict(),
}).strict();

const TimelineEntrySchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1).max(160),
    status: z.enum(['pending', 'active', 'done', 'error', 'waiting']),
    timestampLabel: z.string().max(48).optional(),
    detail: z.string().max(240).optional(),
  })
  .strict();

const ExecutionTimelineComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('execution_timeline'),
  props: z
    .object({
      title: z.string().max(160).default('Execution Timeline'),
      entries: z.array(TimelineEntrySchema).max(AIRA_GENUI_LIMITS.maxTimelineEvents),
    })
    .strict(),
}).strict();

const ToolSummaryItemSchema = z
  .object({
    toolName: z.string().min(1).max(120),
    status: z.enum(['PENDING', 'RUNNING', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED']),
    durationMs: z.number().finite().nonnegative().optional(),
    summary: z.string().max(320).optional(),
  })
  .strict();

const ToolExecutionSummaryComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('tool_execution_summary'),
  props: z
    .object({
      title: z.string().max(160).default('Tool Activity'),
      calls: z.array(ToolSummaryItemSchema).max(AIRA_GENUI_LIMITS.maxToolItems),
    })
    .strict(),
}).strict();

const ArtifactReferenceComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('artifact_reference'),
  props: z
    .object({
      artifactId: IdSchema,
      title: z.string().min(1).max(160),
      artifactType: z.string().max(80),
      version: z.number().int().positive().default(1),
      actionId: IdSchema.optional(),
    })
    .strict(),
}).strict();

const ApprovalRequestComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('approval_request'),
  props: z
    .object({
      approvalId: IdSchema,
      runId: IdSchema,
      toolName: z.string().min(1).max(120),
      risk: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
      reason: z.string().min(1).max(400),
      decision: z.enum(['PENDING', 'ALLOW_ONCE', 'ALLOW_SESSION', 'ALLOW_ALWAYS_FOR_TOOL', 'REJECT']).default('PENDING'),
      approveActionId: IdSchema.optional(),
      rejectActionId: IdSchema.optional(),
    })
    .strict(),
}).strict();

const ErrorRecoveryComponentSchema = z.object({
  id: IdSchema,
  type: z.literal('error_recovery'),
  props: z
    .object({
      title: z.string().min(1).max(160),
      message: z.string().min(1).max(600),
      code: z.string().max(64).optional(),
      recoverable: z.boolean().default(true),
      retryActionId: IdSchema.optional(),
    })
    .strict(),
}).strict();

export const GenUIComponentSchema = z.discriminatedUnion('type', [
  TextComponentSchema,
  HeadingComponentSchema,
  CaptionComponentSchema,
  RichTextComponentSchema,
  DividerComponentSchema,
  CodeBlockComponentSchema,
  MathBlockComponentSchema,
  DataTableComponentSchema,
  DataSummaryComponentSchema,
  VerticalGroupComponentSchema,
  HorizontalGroupComponentSchema,
  ResponsiveGridComponentSchema,
  CardComponentSchema,
  SectionComponentSchema,
  AdaptiveContainerComponentSchema,
  BarChartComponentSchema,
  LineChartComponentSchema,
  ScatterChartComponentSchema,
  PieChartComponentSchema,
  DoughnutChartComponentSchema,
  ProgressIndicatorComponentSchema,
  MetricDisplayComponentSchema,
  ComparisonVizComponentSchema,
  NumericInputComponentSchema,
  TextInputComponentSchema,
  SliderComponentSchema,
  SelectControlComponentSchema,
  CheckboxComponentSchema,
  RadioGroupComponentSchema,
  SegmentedControlComponentSchema,
  ResetControlComponentSchema,
  ActionButtonComponentSchema,
  MissionSummaryComponentSchema,
  TaskStatusComponentSchema,
  ExecutionTimelineComponentSchema,
  ToolExecutionSummaryComponentSchema,
  ArtifactReferenceComponentSchema,
  ApprovalRequestComponentSchema,
  ErrorRecoveryComponentSchema,
]);

export type GenUIComponent = z.infer<typeof GenUIComponentSchema>;
export type GenUIComponentType = GenUIComponent['type'];

export const GENUI_LAYOUT_COMPONENT_TYPES: ReadonlySet<GenUIComponentType> = new Set([
  'vertical_group',
  'horizontal_group',
  'responsive_grid',
  'card',
  'section',
  'adaptive_container',
]);

export const GenUICalculatorKindSchema = z.enum([
  'compound_interest',
  'percentage',
  'unit_conversion',
  'loan_payment',
  'scientific_eval',
]);
export type GenUICalculatorKind = z.infer<typeof GenUICalculatorKindSchema>;

export const GenUISurfaceSchema = z
  .object({
    schemaVersion: z.literal(AIRA_GENUI_CONTRACT_VERSION),
    surfaceId: IdSchema,
    title: z.string().min(1).max(200).optional(),
    rootId: IdSchema,
    components: z.array(GenUIComponentSchema).min(1).max(AIRA_GENUI_LIMITS.maxComponents),
    state: GenUIStateRecordSchema.default({}),
    computed: z.array(GenUIComputedRuleSchema).max(32).optional(),
    actions: z.array(GenUIActionDefinitionSchema).max(AIRA_GENUI_LIMITS.maxActions).default([]),
    textFallback: z.string().min(1).max(32768),
    evidence: z.array(GenUIEvidenceItemSchema).max(AIRA_GENUI_LIMITS.maxEvidenceItems).default([]),
    origin: z
      .enum(['model', 'deterministic_calculator', 'runtime_execution', 'tool_output'])
      .default('model'),
    calculatorKind: GenUICalculatorKindSchema.optional(),
    presentationMode: z.string().max(64).optional(),
    modelId: z.string().max(120).optional(),
    generatedAt: z.number().finite().optional(),
  })
  .strict();

export type GenUISurface = z.infer<typeof GenUISurfaceSchema>;

export const GenUILifecycleEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      eventId: IdSchema,
      type: z.literal('genui.surface.created'),
      surfaceId: IdSchema,
      runId: IdSchema.optional(),
      sequence: z.number().int().nonnegative(),
      timestamp: z.number().finite(),
      surface: GenUISurfaceSchema,
    })
    .strict(),
  z
    .object({
      eventId: IdSchema,
      type: z.literal('genui.surface.patched'),
      surfaceId: IdSchema,
      runId: IdSchema.optional(),
      sequence: z.number().int().nonnegative(),
      timestamp: z.number().finite(),
      upsertComponents: z.array(GenUIComponentSchema).max(AIRA_GENUI_LIMITS.maxComponents).optional(),
      removeComponentIds: z.array(IdSchema).max(AIRA_GENUI_LIMITS.maxComponents).optional(),
      statePatch: GenUIStateRecordSchema.optional(),
      textFallback: z.string().min(1).max(32768).optional(),
    })
    .strict(),
  z
    .object({
      eventId: IdSchema,
      type: z.literal('genui.surface.completed'),
      surfaceId: IdSchema,
      runId: IdSchema.optional(),
      sequence: z.number().int().nonnegative(),
      timestamp: z.number().finite(),
    })
    .strict(),
  z
    .object({
      eventId: IdSchema,
      type: z.literal('genui.surface.deleted'),
      surfaceId: IdSchema,
      runId: IdSchema.optional(),
      sequence: z.number().int().nonnegative(),
      timestamp: z.number().finite(),
    })
    .strict(),
  z
    .object({
      eventId: IdSchema,
      type: z.literal('genui.surface.error'),
      surfaceId: IdSchema,
      runId: IdSchema.optional(),
      sequence: z.number().int().nonnegative(),
      timestamp: z.number().finite(),
      error: z.string().min(1).max(500),
      fallbackText: z.string().max(32768).optional(),
    })
    .strict(),
]);

export type GenUILifecycleEvent = z.infer<typeof GenUILifecycleEventSchema>;

export const GenUIInteractionEventSchema = z
  .object({
    eventId: IdSchema,
    surfaceId: IdSchema,
    componentId: IdSchema,
    actionId: IdSchema,
    kind: GenUIActionKindSchema,
    runId: IdSchema.optional(),
    conversationId: IdSchema.optional(),
    nonce: z.string().max(128).optional(),
    idempotencyKey: z.string().max(128).optional(),
    stateSnapshot: GenUIStateRecordSchema.default({}),
    timestamp: z.number().finite(),
  })
  .strict()
  .refine(
    (evt) => {
      try {
        return new TextEncoder().encode(JSON.stringify(evt.stateSnapshot)).length <= AIRA_GENUI_LIMITS.maxStateBytes;
      } catch {
        return false;
      }
    },
    'GenUI action stateSnapshot exceeds size limit.'
  );

export type GenUIInteractionEvent = z.infer<typeof GenUIInteractionEventSchema>;

export type GenUIValidationResult =
  | { ok: true; surface: GenUISurface }
  | { ok: false; code: string; error: string };

function getChildIds(component: GenUIComponent): readonly string[] {
  if ('children' in component.props && Array.isArray(component.props.children)) {
    return component.props.children;
  }
  return [];
}

/**
 * Validates untrusted GenUI surface payloads against strict structural,
 * size, uniqueness, cycle, and nesting depth bounds.
 */
export function validateGenUISurface(input: unknown): GenUIValidationResult {
  if (containsForbiddenObjectKey(input)) {
    return {
      ok: false,
      code: 'GENUI_FORBIDDEN_KEY',
      error: 'Surface payload contains forbidden prototype-manipulation property keys.',
    };
  }

  let serializedBytes = 0;
  try {
    serializedBytes = new TextEncoder().encode(JSON.stringify(input) ?? '').length;
  } catch {
    return {
      ok: false,
      code: 'GENUI_UNSERIALIZABLE',
      error: 'Surface payload cannot be JSON serialized.',
    };
  }

  if (serializedBytes > AIRA_GENUI_LIMITS.maxPayloadBytes) {
    return {
      ok: false,
      code: 'GENUI_PAYLOAD_TOO_LARGE',
      error: `Surface payload (${serializedBytes} bytes) exceeds limit (${AIRA_GENUI_LIMITS.maxPayloadBytes} bytes).`,
    };
  }

  const parsed = GenUISurfaceSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'GENUI_SCHEMA_INVALID',
      error: parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
    };
  }

  const surface = parsed.data;
  const stateBytes = new TextEncoder().encode(JSON.stringify(surface.state)).length;
  if (stateBytes > AIRA_GENUI_LIMITS.maxStateBytes) {
    return {
      ok: false,
      code: 'GENUI_STATE_TOO_LARGE',
      error: `Surface state (${stateBytes} bytes) exceeds limit (${AIRA_GENUI_LIMITS.maxStateBytes} bytes).`,
    };
  }

  const byId = new Map<string, GenUIComponent>();
  for (const component of surface.components) {
    if (byId.has(component.id)) {
      return {
        ok: false,
        code: 'GENUI_DUPLICATE_COMPONENT_ID',
        error: `Duplicate component identifier "${component.id}".`,
      };
    }
    byId.set(component.id, component);
  }

  if (!byId.has(surface.rootId)) {
    return {
      ok: false,
      code: 'GENUI_MISSING_ROOT',
      error: `Root component "${surface.rootId}" does not exist.`,
    };
  }

  const actionIds = new Set<string>();
  for (const act of surface.actions) {
    if (actionIds.has(act.id)) {
      return {
        ok: false,
        code: 'GENUI_DUPLICATE_ACTION_ID',
        error: `Duplicate action identifier "${act.id}".`,
      };
    }
    actionIds.add(act.id);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const dfs = (id: string, depth: number): string | null => {
    if (depth > AIRA_GENUI_LIMITS.maxNestingDepth) {
      return `Component nesting depth exceeds maximum (${AIRA_GENUI_LIMITS.maxNestingDepth}) at "${id}".`;
    }
    if (visiting.has(id)) {
      return `Cycle detected in component tree at "${id}".`;
    }
    const comp = byId.get(id);
    if (!comp) {
      return `Missing child component "${id}".`;
    }
    if (visited.has(id)) {
      return `Component "${id}" is referenced more than once in the tree.`;
    }
    visiting.add(id);
    for (const childId of getChildIds(comp)) {
      const err = dfs(childId, depth + 1);
      if (err) return err;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  const graphError = dfs(surface.rootId, 1);
  if (graphError) {
    return { ok: false, code: 'GENUI_GRAPH_INVALID', error: graphError };
  }

  if (surface.computed && surface.computed.length > 0) {
    const depCheck = validateComputedDependencyGraph(surface.computed);
    if (!depCheck.ok) {
      return { ok: false, code: depCheck.code, error: depCheck.error };
    }
  }

  return { ok: true, surface };
}

function canonicalSortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalSortValue);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        out[key] = canonicalSortValue(child);
      }
    }
    return out;
  }
  return value;
}

/**
 * Deterministic canonical JSON serialization with sorted object keys.
 */
export function serializeGenUISurfaceDeterministic(surface: GenUISurface): string {
  return JSON.stringify(canonicalSortValue(surface));
}

export interface GenUISurfaceEntry {
  surface: GenUISurface;
  status: 'streaming' | 'completed' | 'error';
  lastSequence: number;
  seenEventIds: string[];
  error?: string;
}

/**
 * Pure, idempotent lifecycle event reducer that safely rejects duplicate,
 * out-of-order, or stale-run GenUI lifecycle events.
 */
export function applyGenUILifecycleEventToMap(
  current: ReadonlyMap<string, GenUISurfaceEntry>,
  rawEvent: unknown,
  activeRunId?: string
): Map<string, GenUISurfaceEntry> {
  const parsed = GenUILifecycleEventSchema.safeParse(rawEvent);
  if (!parsed.success) {
    return current instanceof Map ? (current as Map<string, GenUISurfaceEntry>) : new Map(current);
  }

  const event = parsed.data;
  if (activeRunId && event.runId && event.runId !== activeRunId) {
    return current instanceof Map ? (current as Map<string, GenUISurfaceEntry>) : new Map(current);
  }

  const existing = current.get(event.surfaceId);
  if (existing) {
    if (existing.seenEventIds.includes(event.eventId)) {
      return current instanceof Map ? (current as Map<string, GenUISurfaceEntry>) : new Map(current);
    }
    if (event.sequence < existing.lastSequence) {
      return current instanceof Map ? (current as Map<string, GenUISurfaceEntry>) : new Map(current);
    }
  }

  const next = new Map(current);
  const seen = existing ? [...existing.seenEventIds.slice(-63), event.eventId] : [event.eventId];

  if (event.type === 'genui.surface.created') {
    const validated = validateGenUISurface(event.surface);
    if (!validated.ok) return next;
    next.set(event.surfaceId, {
      surface: validated.surface,
      status: 'streaming',
      lastSequence: event.sequence,
      seenEventIds: seen,
    });
    return next;
  }

  if (event.type === 'genui.surface.patched' && existing) {
    const removeSet = new Set(event.removeComponentIds || []);
    let mergedComponents = removeSet.size > 0
      ? existing.surface.components.filter((c) => !removeSet.has(c.id))
      : [...existing.surface.components];
    if (event.upsertComponents) {
      for (const comp of event.upsertComponents) {
        const idx = mergedComponents.findIndex((c) => c.id === comp.id);
        if (idx >= 0) mergedComponents[idx] = comp;
        else mergedComponents.push(comp);
      }
    }
    let patchedState = existing.surface.state;
    if (event.statePatch) {
      patchedState = { ...existing.surface.state };
      for (const [k, v] of Object.entries(event.statePatch)) {
        patchedState = writeStateKeyOrPointer(patchedState, k, v);
      }
    }
    const candidate: GenUISurface = {
      ...existing.surface,
      components: mergedComponents,
      state: patchedState,
      textFallback: event.textFallback ?? existing.surface.textFallback,
    };
    const validated = validateGenUISurface(candidate);
    if (!validated.ok) return next;
    next.set(event.surfaceId, {
      ...existing,
      surface: validated.surface,
      lastSequence: event.sequence,
      seenEventIds: seen,
    });
    return next;
  }

  if (event.type === 'genui.surface.completed' && existing) {
    next.set(event.surfaceId, {
      ...existing,
      status: 'completed',
      lastSequence: event.sequence,
      seenEventIds: seen,
    });
    return next;
  }

  if (event.type === 'genui.surface.deleted') {
    next.delete(event.surfaceId);
    return next;
  }

  if (event.type === 'genui.surface.error') {
    if (existing) {
      next.set(event.surfaceId, {
        ...existing,
        status: 'error',
        error: event.error,
        lastSequence: event.sequence,
        seenEventIds: seen,
      });
    } else {
      const fallbackSurface: GenUISurface = {
        schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
        surfaceId: event.surfaceId,
        rootId: 'err_fallback',
        components: [
          {
            id: 'err_fallback',
            type: 'error_recovery',
            props: {
              title: 'Interactive View Unavailable',
              message: event.error,
              recoverable: false,
            },
          },
        ],
        state: {},
        actions: [],
        textFallback: event.fallbackText || event.error,
        evidence: [],
        origin: 'runtime_execution',
      };
      next.set(event.surfaceId, {
        surface: fallbackSurface,
        status: 'error',
        error: event.error,
        lastSequence: event.sequence,
        seenEventIds: seen,
      });
    }
    return next;
  }

  return next;
}

/**
 * Explicit Phase 1 compatibility boundaries for A2UI v1.0.
 * Full A2UI protocol transport & dynamic catalog negotiation remain Phase 2 scope.
 */
export const A2UI_V1_COMPATIBILITY_BOUNDARY = {
  a2uiTargetVersion: '1.0' as const,
  a2uiCompliant: false as const,
  compatibilityLevel: 'structural-adapter-boundary' as const,
  supportedInPhase1: [
    'Adjacency-list flat component collection + explicit rootId',
    'Surface create/patch/completed/error lifecycle semantics',
    'JSON-pointer-compatible data reference paths (/key)',
    'Strict component catalog allowlist with explicit textFallback',
  ] as const,
  deferredToPhase2: [
    'Full A2UI v1.0 client catalog capability negotiation handshake',
    'Arbitrary dynamic A2UI expression evaluation / template bindings',
    'Remote external A2UI component catalogs & MCP App frames',
  ] as const,
};

export interface A2UIV1BoundaryEnvelope {
  a2uiTargetVersion: '1.0';
  compatibilityLevel: 'structural-adapter-boundary';
  a2uiCompliant: false;
  surfaceUpdate: {
    surfaceId: string;
    root: string;
    components: Array<{ id: string; component: Record<string, unknown> }>;
  };
  dataModelUpdate: {
    surfaceId: string;
    contents: GenUIStateRecord;
  };
  textFallback: string;
}

export function mapAiraGenUIToA2UIV1BoundaryEnvelope(surface: GenUISurface): A2UIV1BoundaryEnvelope {
  return {
    a2uiTargetVersion: '1.0',
    compatibilityLevel: 'structural-adapter-boundary',
    a2uiCompliant: false,
    surfaceUpdate: {
      surfaceId: surface.surfaceId,
      root: surface.rootId,
      components: surface.components.map((c) => ({
        id: c.id,
        component: { [c.type]: c.props },
      })),
    },
    dataModelUpdate: {
      surfaceId: surface.surfaceId,
      contents: { ...surface.state },
    },
    textFallback: surface.textFallback,
  };
}
