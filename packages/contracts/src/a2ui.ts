import { z } from 'zod';
import {
  AIRA_GENUI_CONTRACT_VERSION,
  AIRA_GENUI_LIMITS,
  containsForbiddenObjectKey,
  validateGenUISurface,
  type GenUIActionDefinition,
  type GenUICheckRule,
  type GenUIComponent,
  type GenUIStateRecord,
  type GenUISurface,
} from './genui.js';
import { getByJsonPointer, setByJsonPointer } from './genui-reactive.js';

export const A2UI_PROTOCOL_VERSION = '1.0' as const;
export const A2UI_BASIC_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json' as const;
export const AIRA_A2UI_CATALOG_ID = 'urn:aira:genui:catalog:v1' as const;

const SafeA2UIIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/, 'Invalid A2UI identifier');

const SafeA2UIPointerSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^\/[a-zA-Z0-9_.\/~-]{0,119}$/, 'Invalid JSON Pointer')
  .refine(
    (p) =>
      p.startsWith('/') &&
      !p.includes('..') &&
      !p.split('/').some((s) => s === '__proto__' || s === 'constructor' || s === 'prototype'),
    'Invalid or forbidden JSON Pointer'
  );

// Unicode UAX #31-safe subset identifier (letters/underscore followed by letters/digits/underscore)
const ExtensionKeySchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Extension keys must be valid identifiers');

const ExtensionsMapSchema = z.record(ExtensionKeySchema, z.unknown());

export const A2UIDataBindingSchema = z
  .object({
    '@path': SafeA2UIPointerSchema,
  })
  .strict();

const MAX_A2UI_CALL_DEPTH = 6;

function buildA2UIFunctionCallSchema(depth: number): z.ZodType<any> {
  if (depth >= MAX_A2UI_CALL_DEPTH) {
    return z
      .object({
        '@call': z.string().min(1).max(64),
        catalogId: z.string().max(200).optional(),
      })
      .strict();
  }
  return z.lazy(() =>
    z
      .object({
        '@call': z.string().min(1).max(64),
        catalogId: z.string().max(200).optional(),
        args: z
          .record(
            z.string().max(64),
            z.union([
              z.string().max(AIRA_GENUI_LIMITS.maxTextLength),
              z.number().finite(),
              z.boolean(),
              z.null(),
              A2UIDataBindingSchema,
              buildA2UIFunctionCallSchema(depth + 1),
              z.array(z.unknown()).max(32),
            ])
          )
          .optional(),
      })
      .strict()
  );
}

export const A2UIFunctionCallSchema: z.ZodType<any> = buildA2UIFunctionCallSchema(0);

export const A2UIDynamicStringSchema = z.union([
  z.string().max(AIRA_GENUI_LIMITS.maxTextLength),
  A2UIDataBindingSchema,
  A2UIFunctionCallSchema,
]);

export const A2UIDynamicNumberSchema = z.union([
  z.number().finite(),
  A2UIDataBindingSchema,
  A2UIFunctionCallSchema,
]);

export const A2UIDynamicBooleanSchema = z.union([
  z.boolean(),
  A2UIDataBindingSchema,
  A2UIFunctionCallSchema,
]);

export const A2UICheckRuleWireSchema = z
  .object({
    condition: z.union([A2UIDataBindingSchema, A2UIFunctionCallSchema]),
    message: z.string().max(240).optional(),
  })
  .strict();

export const A2UIAccessibilitySchema = z
  .object({
    label: A2UIDynamicStringSchema.optional(),
    description: A2UIDynamicStringSchema.optional(),
    live: z.enum(['off', 'polite', 'assertive']).optional(),
    hidden: A2UIDynamicBooleanSchema.optional(),
  })
  .strict();

export const A2UIActionSchema = z.union([
  z
    .object({
      event: z
        .object({
          name: z.string().min(1).max(96),
          userMessage: A2UIDynamicStringSchema.optional(),
          context: z.record(z.string().max(64), z.unknown()).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      functionCall: A2UIFunctionCallSchema,
    })
    .strict(),
]);

export const A2UIChildListSchema = z.union([
  z.array(z.string().min(1).max(96)).max(AIRA_GENUI_LIMITS.maxChildrenPerLayout),
  z
    .object({
      componentId: z.string().min(1).max(96),
      path: SafeA2UIPointerSchema,
    })
    .strict(),
]);

export const A2UIComponentWireSchema = z
  .object({
    id: SafeA2UIIdSchema,
    component: z
      .string()
      .min(1)
      .max(64)
      .refine((c) => c !== 'Surface', 'Cannot redefine reserved "Surface" component in v1.0'),
    '@catalogId': z.string().max(200).optional(),
    '@accessibility': A2UIAccessibilitySchema.optional(),
    '@checks': z.array(A2UICheckRuleWireSchema).max(16).optional(),
    '@metadata': z
      .object({
        extensions: ExtensionsMapSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

export type A2UIComponentWire = z.infer<typeof A2UIComponentWireSchema>;

export const A2UICreateSurfaceMessageSchema = z
  .object({
    version: z.literal(A2UI_PROTOCOL_VERSION),
    createSurface: z
      .object({
        surfaceId: SafeA2UIIdSchema,
        catalogId: z.string().max(240).optional(),
        sendDataModel: z.boolean().optional(),
        components: z.array(A2UIComponentWireSchema).min(1).max(AIRA_GENUI_LIMITS.maxComponents).optional(),
        dataModel: z.record(z.string(), z.unknown()).optional(),
        metadata: z
          .object({
            extensions: ExtensionsMapSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict(), // Strictly rejects deprecated v0.9 'theme' property
  })
  .strict()
  .refine((v) => !containsForbiddenObjectKey(v), 'Forbidden prototype key in A2UI createSurface message');

export const A2UIUpdateComponentsMessageSchema = z
  .object({
    version: z.literal(A2UI_PROTOCOL_VERSION),
    updateComponents: z
      .object({
        surfaceId: SafeA2UIIdSchema,
        components: z.array(A2UIComponentWireSchema).min(1).max(AIRA_GENUI_LIMITS.maxComponents),
      })
      .strict(),
  })
  .strict()
  .refine((v) => !containsForbiddenObjectKey(v), 'Forbidden prototype key in A2UI updateComponents message');

export const A2UIUpdateDataModelMessageSchema = z
  .object({
    version: z.literal(A2UI_PROTOCOL_VERSION),
    updateDataModel: z
      .object({
        surfaceId: SafeA2UIIdSchema,
        path: SafeA2UIPointerSchema.optional(),
        value: z.unknown(),
      })
      .strict()
      .refine((d) => 'value' in d, 'value is required in updateDataModel'),
  })
  .strict()
  .refine((v) => !containsForbiddenObjectKey(v), 'Forbidden prototype key in A2UI updateDataModel message');

export const A2UIDeleteSurfaceMessageSchema = z
  .object({
    version: z.literal(A2UI_PROTOCOL_VERSION),
    deleteSurface: z
      .object({
        surfaceId: SafeA2UIIdSchema,
      })
      .strict(),
  })
  .strict();

export const A2UIAgentToRendererMessageSchema = z.union([
  A2UICreateSurfaceMessageSchema,
  A2UIUpdateComponentsMessageSchema,
  A2UIUpdateDataModelMessageSchema,
  A2UIDeleteSurfaceMessageSchema,
]);

export type A2UIAgentToRendererMessage = z.infer<typeof A2UIAgentToRendererMessageSchema>;

export const A2UIRendererActionMessageSchema = z
  .object({
    version: z.literal(A2UI_PROTOCOL_VERSION),
    action: z
      .object({
        name: z.string().min(1).max(96),
        userMessage: z.string().max(1000).optional(),
        surfaceId: SafeA2UIIdSchema,
        sourceComponentId: SafeA2UIIdSchema,
        timestamp: z.string().min(4).max(64),
        context: z.record(z.string(), z.unknown()),
        metadata: z
          .object({
            extensions: ExtensionsMapSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
  .refine((v) => !containsForbiddenObjectKey(v), 'Forbidden prototype key in A2UI action message');

export const A2UIValidationErrorCodeSchema = z.enum([
  'VALIDATION_FAILED',
  'UNALLOWED_PARENT',
  'UNALLOWED_CHILD',
]);

export const A2UIRendererErrorMessageSchema = z
  .object({
    version: z.literal(A2UI_PROTOCOL_VERSION),
    error: z.union([
      z
        .object({
          code: A2UIValidationErrorCodeSchema,
          surfaceId: z.string().min(1).max(96),
          path: SafeA2UIPointerSchema,
          message: z.string().min(1).max(500),
        })
        .strict(),
      z
        .object({
          code: z.string().min(1).max(64).refine((c) => !['VALIDATION_FAILED', 'UNALLOWED_PARENT', 'UNALLOWED_CHILD'].includes(c)),
          message: z.string().min(1).max(500),
          surfaceId: z.string().min(1).max(96),
        })
        .strict(),
      z
        .object({
          code: z.string().min(1).max(64).refine((c) => !['VALIDATION_FAILED', 'UNALLOWED_PARENT', 'UNALLOWED_CHILD'].includes(c)),
          message: z.string().min(1).max(500),
          functionCallId: z.string().min(1).max(96),
        })
        .strict(),
    ]),
  })
  .strict();

export const A2UIRendererToAgentMessageSchema = z.union([
  A2UIRendererActionMessageSchema,
  A2UIRendererErrorMessageSchema,
]);

export const A2UIRendererCapabilitiesSchema = z
  .object({
    '1.0': z
      .object({
        supportedCatalogIds: z.array(z.string().min(1)).min(1),
        inlineCatalogs: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .strict(),
  })
  .strict();

export const A2UIAgentCapabilitiesSchema = z
  .object({
    '1.0': z
      .object({
        supportedCatalogIds: z.array(z.string().min(1)).optional(),
        acceptsInlineCatalogs: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const AIRA_A2UI_PROFILE_CAPABILITIES = {
  protocolVersion: A2UI_PROTOCOL_VERSION,
  compatibilityLevel: 'profiled-a2ui-v1.0' as const,
  a2uiCompliant: true as const,
  supportedCatalogIds: [AIRA_A2UI_CATALOG_ID, A2UI_BASIC_CATALOG_ID] as const,
  acceptsInlineCatalogs: false as const,
  supportedMessages: [
    'createSurface',
    'updateComponents',
    'updateDataModel',
    'deleteSurface',
    'action',
    'error',
  ] as const,
  supportedBasicComponents: [
    'Text',
    'Divider',
    'Row',
    'Column',
    'List',
    'Card',
    'Tabs',
    'Modal',
    'Button',
    'TextField',
    'CheckBox',
    'ChoicePicker',
    'Slider',
    'Image',
    'Icon',
    'DateTimeInput',
  ] as const,
  supportedFunctions: [
    'required',
    'regex',
    'length',
    'numeric',
    'email',
    'formatString',
    'formatNumber',
    'formatCurrency',
    'formatDate',
    'pluralize',
    'openUrl',
    'and',
    'or',
    'not',
    '@index',
  ] as const,
  unsupportedFeatures: [
    'inlineCatalogs',
    'remote $ref schema network fetching',
    'callRendererFunction / callAgentFunction remote RPC',
    'Video / AudioPlayer streaming widgets',
    'arbitrary JS / unsafe-eval / remote MCP App frames',
  ] as const,
};

const SUPPORTED_A2UI_FUNCTIONS = new Set<string>(AIRA_A2UI_PROFILE_CAPABILITIES.supportedFunctions);

function extractPathOrDefault(val: unknown): { literal?: unknown; pointer?: string } {
  if (val && typeof val === 'object' && '@path' in (val as Record<string, unknown>)) {
    const p = (val as Record<string, unknown>)['@path'];
    if (typeof p === 'string') return { pointer: p };
  }
  return { literal: val };
}

function translateWireConditionToRules(
  cond: unknown,
  msg: string | undefined,
  fallbackRef: string | undefined,
  depth = 0
): GenUICheckRule[] {
  if (depth > 4 || !cond || typeof cond !== 'object' || !('@call' in cond)) return [];
  const fn = String((cond as Record<string, unknown>)['@call']);
  if (!SUPPORTED_A2UI_FUNCTIONS.has(fn)) return [];
  const args = ((cond as Record<string, unknown>).args || {}) as Record<string, unknown>;

  if (fn === 'and') {
    const subs = Array.isArray(args.conditions) ? args.conditions : Array.isArray(args.items) ? args.items : [];
    const rules: GenUICheckRule[] = [];
    for (const sub of subs.slice(0, 8)) {
      rules.push(...translateWireConditionToRules(sub, msg, fallbackRef, depth + 1));
    }
    return rules;
  }
  if (fn === 'or' || fn === 'not') {
    const inner = Array.isArray(args.conditions) ? args.conditions[0] : args.condition ?? args.value;
    return translateWireConditionToRules(inner, msg, fallbackRef, depth + 1);
  }

  const valBinding = extractPathOrDefault(args.value);
  const valueRef = valBinding.pointer || fallbackRef;
  if (fn === 'required' || fn === 'email') {
    return [{ kind: fn, valueRef, message: msg }];
  }
  if (fn === 'regex' && typeof args.pattern === 'string') {
    return [{ kind: 'regex', valueRef, pattern: args.pattern.slice(0, 120), message: msg }];
  }
  if (fn === 'length') {
    return [
      {
        kind: 'length',
        valueRef,
        min: typeof args.min === 'number' ? args.min : undefined,
        max: typeof args.max === 'number' ? args.max : undefined,
        message: msg,
      },
    ];
  }
  if (fn === 'numeric') {
    return [
      {
        kind: 'numeric',
        valueRef,
        min: typeof args.min === 'number' ? args.min : undefined,
        max: typeof args.max === 'number' ? args.max : undefined,
        message: msg,
      },
    ];
  }
  return [];
}

function translateWireChecks(checksRaw: unknown, fallbackRef?: string): GenUICheckRule[] | undefined {
  if (!Array.isArray(checksRaw) || checksRaw.length === 0) return undefined;
  const out: GenUICheckRule[] = [];
  for (const item of checksRaw) {
    if (!item || typeof item !== 'object') continue;
    const msg = typeof (item as any).message === 'string' ? (item as any).message : undefined;
    out.push(...translateWireConditionToRules((item as any).condition, msg, fallbackRef, 0));
  }
  return out.length > 0 ? out : undefined;
}

function resolveDynamicValue(val: unknown, dataModel: Record<string, unknown>, depth = 0): unknown {
  if (depth > 4) return '';
  if (val && typeof val === 'object') {
    const rec = val as Record<string, unknown>;
    if ('@path' in rec && typeof rec['@path'] === 'string') {
      return getByJsonPointer(dataModel, rec['@path']);
    }
    if ('@call' in rec && typeof rec['@call'] === 'string') {
      const fn = rec['@call'];
      const args = (rec.args && typeof rec.args === 'object' ? rec.args : {}) as Record<string, unknown>;
      if (fn === 'formatString') {
        const tmpl = String(resolveDynamicValue(args.value ?? args.template ?? '', dataModel, depth + 1) ?? '');
        return tmpl.replace(/\$\{([^}]+)\}/g, (_m, expr) => {
          const trimmed = String(expr).trim();
          if (trimmed.startsWith('/')) {
            const resolved = getByJsonPointer(dataModel, trimmed);
            return resolved !== undefined && resolved !== null ? String(resolved) : '';
          }
          if (args[trimmed] !== undefined) {
            return String(resolveDynamicValue(args[trimmed], dataModel, depth + 1) ?? '');
          }
          return '';
        });
      }
      if (fn === 'formatNumber') {
        const n = Number(resolveDynamicValue(args.value ?? 0, dataModel, depth + 1));
        const decimals = typeof args.decimals === 'number' ? Math.max(0, Math.min(8, args.decimals)) : 2;
        return Number.isFinite(n)
          ? n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
          : '0';
      }
      if (fn === 'formatCurrency') {
        const n = Number(resolveDynamicValue(args.value ?? 0, dataModel, depth + 1));
        const currency = typeof args.currency === 'string' && /^[A-Z]{3}$/.test(args.currency) ? args.currency : 'USD';
        const decimals = typeof args.decimals === 'number' ? Math.max(0, Math.min(6, args.decimals)) : 2;
        try {
          return Number.isFinite(n)
            ? new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n)
            : '$0.00';
        } catch {
          return Number.isFinite(n) ? `${currency} ${n.toFixed(decimals)}` : `${currency} 0`;
        }
      }
      if (fn === 'formatDate') {
        const rawDate = resolveDynamicValue(args.value ?? '', dataModel, depth + 1);
        const dt = rawDate instanceof Date ? rawDate : new Date(String(rawDate));
        return Number.isNaN(dt.getTime()) ? String(rawDate ?? '') : dt.toISOString().slice(0, 10);
      }
      if (fn === 'pluralize') {
        const count = Number(resolveDynamicValue(args.value ?? args.count ?? 0, dataModel, depth + 1));
        const one = typeof args.one === 'string' ? args.one : 'item';
        const other = typeof args.other === 'string' ? args.other : `${one}s`;
        return count === 1 ? one : other;
      }
    }
  }
  return val;
}

function resolveDisplayText(val: unknown, dataModel: Record<string, unknown>): string {
  const resolved = resolveDynamicValue(val, dataModel, 0);
  if (typeof resolved === 'string') return resolved;
  if (typeof resolved === 'number' || typeof resolved === 'boolean') return String(resolved);
  return '';
}

function resolveWireChildren(
  rawChildren: unknown,
  parentId: string,
  catalogId: string | undefined,
  dataModel: Record<string, unknown>,
  allWireById: Map<string, A2UIComponentWire>,
  actionsOut: GenUIActionDefinition[],
  seenActionIds: Set<string>,
  extraOut: GenUIComponent[]
): string[] {
  if (Array.isArray(rawChildren)) return rawChildren.map(String);
  if (rawChildren && typeof rawChildren === 'object' && 'componentId' in rawChildren && 'path' in rawChildren) {
    const tmplId = String((rawChildren as any).componentId);
    const arrPath = String((rawChildren as any).path);
    const listVal = getByJsonPointer(dataModel, arrPath);
    const templateWire = allWireById.get(tmplId);
    if (!Array.isArray(listVal) || !templateWire) return [];
    const generatedIds: string[] = [];
    for (let idx = 0; idx < Math.min(listVal.length, AIRA_GENUI_LIMITS.maxChildrenPerLayout); idx++) {
      const clonedId = `${parentId}__${idx}__${tmplId}`.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 96);
      const itemDataModel = { ...dataModel, '@index': idx, item: listVal[idx] };
      const clonedWire: A2UIComponentWire = {
        ...templateWire,
        id: clonedId,
      };
      const mapped = mapWireComponentToGenUI(
        clonedWire,
        catalogId,
        itemDataModel,
        allWireById,
        actionsOut,
        seenActionIds,
        extraOut
      );
      if (mapped) {
        extraOut.push(mapped);
        generatedIds.push(clonedId);
      }
    }
    return generatedIds;
  }
  return [];
}

function mapWireComponentToGenUI(
  wire: A2UIComponentWire,
  surfaceCatalogId: string | undefined,
  dataModel: Record<string, unknown>,
  allWireById: Map<string, A2UIComponentWire>,
  actionsOut: GenUIActionDefinition[],
  seenActionIds: Set<string>,
  extraOut: GenUIComponent[]
): GenUIComponent | null {
  const raw = wire as Record<string, unknown>;
  const catalogId = wire['@catalogId'] || surfaceCatalogId || A2UI_BASIC_CATALOG_ID;
  const kind = wire.component;

  // Allow native AIRA component names when targeting AIRA catalog
  if (catalogId === AIRA_A2UI_CATALOG_ID && raw.props && typeof raw.props === 'object') {
    const nativeCandidate = {
      id: wire.id,
      type: kind,
      props: raw.props,
      ...(wire['@checks'] ? { checks: translateWireChecks(wire['@checks']) } : {}),
    };
    return nativeCandidate as GenUIComponent;
  }

  const labelStr = typeof raw.label === 'string' ? raw.label : resolveDisplayText(raw.label, dataModel);

  switch (kind) {
    case 'Column': {
      const children = resolveWireChildren(raw.children, wire.id, catalogId, dataModel, allWireById, actionsOut, seenActionIds, extraOut);
      return { id: wire.id, type: 'vertical_group', props: { gap: 'md', children } };
    }
    case 'Row': {
      const children = resolveWireChildren(raw.children, wire.id, catalogId, dataModel, allWireById, actionsOut, seenActionIds, extraOut);
      const align = raw.align === 'center' || raw.align === 'end' || raw.align === 'start' ? raw.align : 'stretch';
      return { id: wire.id, type: 'horizontal_group', props: { gap: 'md', wrap: true, align, children } };
    }
    case 'List': {
      const children = resolveWireChildren(raw.children, wire.id, catalogId, dataModel, allWireById, actionsOut, seenActionIds, extraOut);
      if (raw.direction === 'horizontal') {
        return {
          id: wire.id,
          type: 'horizontal_group',
          props: { gap: 'sm', wrap: true, align: 'stretch', children },
        };
      }
      return {
        id: wire.id,
        type: 'vertical_group',
        props: { gap: 'sm', children },
      };
    }
    case 'Card': {
      const children = typeof raw.child === 'string' ? [raw.child] : Array.isArray(raw.children) ? raw.children.map(String) : [];
      return { id: wire.id, type: 'card', props: { tone: 'default', children } };
    }
    case 'Tabs': {
      const tabs = Array.isArray(raw.tabs) ? raw.tabs : [];
      const children = tabs
        .map((t: any) => (typeof t?.child === 'string' ? t.child : null))
        .filter((x: string | null): x is string => Boolean(x));
      return { id: wire.id, type: 'vertical_group', props: { gap: 'md', children } };
    }
    case 'Modal': {
      const children = [raw.trigger, raw.content].filter((x): x is string => typeof x === 'string');
      return { id: wire.id, type: 'section', props: { title: 'Dialog', collapsible: false, defaultCollapsed: false, children } };
    }
    case 'Text': {
      const binding = extractPathOrDefault(raw.text);
      const txt = resolveDisplayText(raw.text, dataModel);
      if (!binding.pointer && txt.startsWith('#')) {
        const match = txt.match(/^(#{1,4})\s+(.+)$/);
        if (match) {
          return {
            id: wire.id,
            type: 'heading',
            props: { level: Math.min(4, match[1].length) as 1 | 2 | 3 | 4, text: match[2].slice(0, 280) },
          };
        }
      }
      const variant = raw.variant === 'caption' ? 'muted' : 'body';
      return {
        id: wire.id,
        type: 'text',
        props: {
          text: txt || ' ',
          variant,
          ...(binding.pointer ? { dataRef: binding.pointer } : {}),
        },
      };
    }
    case 'Divider': {
      return { id: wire.id, type: 'divider', props: {} };
    }
    case 'Button': {
      const childWire = typeof raw.child === 'string' ? allWireById.get(raw.child) : undefined;
      const btnText = childWire
        ? resolveDisplayText((childWire as Record<string, unknown>).text, dataModel) || 'Action'
        : 'Action';
      const rawAction = (raw.action || {}) as Record<string, any>;
      const fnCall = rawAction.functionCall;
      if (fnCall && fnCall['@call'] === 'openUrl') {
        const rawUrl = resolveDisplayText(fnCall.args?.url, dataModel);
        let safeUrl: string | undefined;
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') safeUrl = parsed.toString();
        } catch {
          safeUrl = undefined;
        }
        const actionId = `open_url_${wire.id}`.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 80);
        if (!seenActionIds.has(actionId)) {
          seenActionIds.add(actionId);
          actionsOut.push({
            id: actionId,
            label: btnText.slice(0, 120),
            kind: 'open_artifact',
            permissionLevel: 'READ',
            requiresApproval: false,
            ...(safeUrl ? { promptTemplate: safeUrl } : {}),
          });
        }
        return {
          id: wire.id,
          type: 'action_button',
          props: {
            label: btnText.slice(0, 100),
            actionId,
            variant: raw.variant === 'primary' ? 'primary' : 'secondary',
            disabled: !safeUrl,
          },
        };
      }
      const evtName = rawAction.event?.name ? String(rawAction.event.name) : `act_${wire.id}`;
      const actionId = evtName.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 80) || `act_${wire.id}`;
      const tmpl = rawAction.event?.userMessage
        ? resolveDisplayText(rawAction.event.userMessage, dataModel).slice(0, 500)
        : undefined;
      if (!seenActionIds.has(actionId)) {
        seenActionIds.add(actionId);
        actionsOut.push({
          id: actionId,
          label: btnText.slice(0, 120),
          kind: 'attach_followup',
          permissionLevel: 'NONE',
          requiresApproval: false,
          ...(tmpl ? { promptTemplate: tmpl } : {}),
        });
      }
      return {
        id: wire.id,
        type: 'action_button',
        props: {
          label: btnText.slice(0, 100),
          actionId,
          variant: raw.variant === 'primary' ? 'primary' : 'secondary',
          disabled: false,
        },
      };
    }
    case 'TextField': {
      const binding = extractPathOrDefault(raw.value);
      const stateKey = binding.pointer || `field_${wire.id}`;
      const existingVal = binding.pointer ? getByJsonPointer(dataModel, binding.pointer) : binding.literal;
      const checks = translateWireChecks(wire['@checks'], stateKey);
      return {
        id: wire.id,
        type: 'text_input',
        props: {
          label: labelStr || wire.id,
          stateKey,
          placeholder: typeof raw.placeholder === 'string' ? raw.placeholder : undefined,
          defaultValue: typeof existingVal === 'string' ? existingVal : '',
          maxLength: 500,
        },
        ...(checks ? { checks } : {}),
      };
    }
    case 'Slider': {
      const binding = extractPathOrDefault(raw.value);
      const stateKey = binding.pointer || `slider_${wire.id}`;
      const min = typeof raw.min === 'number' && Number.isFinite(raw.min) ? raw.min : 0;
      const max = typeof raw.max === 'number' && Number.isFinite(raw.max) && raw.max > min ? raw.max : min + 100;
      const step = typeof raw.steps === 'number' && raw.steps > 0 ? raw.steps : 1;
      const existing = binding.pointer ? getByJsonPointer(dataModel, binding.pointer) : binding.literal;
      const defNum = typeof existing === 'number' && Number.isFinite(existing) ? existing : min;
      return {
        id: wire.id,
        type: 'slider',
        props: { label: labelStr || wire.id, stateKey, min, max, step, defaultValue: defNum },
      };
    }
    case 'CheckBox': {
      const binding = extractPathOrDefault(raw.value);
      const stateKey = binding.pointer || `check_${wire.id}`;
      const existing = binding.pointer ? getByJsonPointer(dataModel, binding.pointer) : binding.literal;
      return {
        id: wire.id,
        type: 'checkbox',
        props: { label: labelStr || wire.id, stateKey, defaultChecked: Boolean(existing) },
      };
    }
    case 'ChoicePicker': {
      const binding = extractPathOrDefault(raw.value);
      const stateKey = binding.pointer || `choice_${wire.id}`;
      const rawOpts = Array.isArray(raw.options) ? raw.options : [];
      const options = rawOpts
        .filter((o: any) => o && typeof o === 'object')
        .slice(0, AIRA_GENUI_LIMITS.maxOptions)
        .map((o: any) => ({
          label: resolveDisplayText(o.label, dataModel) || String(o.value ?? ''),
          value: String(o.value ?? ''),
        }));
      if (options.length === 0) options.push({ label: 'Default', value: 'default' });
      const existing = binding.pointer ? getByJsonPointer(dataModel, binding.pointer) : binding.literal;
      return {
        id: wire.id,
        type: 'select_control',
        props: {
          label: labelStr || wire.id,
          stateKey,
          defaultValue: typeof existing === 'string' ? existing : options[0].value,
          options,
        },
      };
    }
    case 'Image': {
      const alt = resolveDisplayText(raw.description, dataModel) || resolveDisplayText(raw.url, dataModel) || 'Image';
      return { id: wire.id, type: 'caption', props: { text: alt.slice(0, 500), sourceLabel: 'Image' } };
    }
    case 'Icon': {
      return { id: wire.id, type: 'caption', props: { text: String(raw.name || 'icon').slice(0, 120) } };
    }
    case 'DateTimeInput': {
      const binding = extractPathOrDefault(raw.value);
      const stateKey = binding.pointer || `dt_${wire.id}`;
      const existing = binding.pointer ? getByJsonPointer(dataModel, binding.pointer) : binding.literal;
      return {
        id: wire.id,
        type: 'text_input',
        props: {
          label: labelStr || 'Date / Time',
          stateKey,
          placeholder: 'YYYY-MM-DD',
          defaultValue: typeof existing === 'string' ? existing : '',
          maxLength: 64,
        },
      };
    }
    default:
      return null;
  }
}

interface InternalSurfaceState {
  surfaceId: string;
  catalogId?: string;
  sendDataModel?: boolean;
  components: Map<string, A2UIComponentWire>;
  dataModel: Record<string, unknown>;
}

export interface A2UIReduceResult {
  ok: boolean;
  surfaceId?: string;
  surface: GenUISurface | null;
  deleted?: boolean;
  error?: { code: string; message: string; path?: string };
}

export class A2UISurfaceReducer {
  private surfaces = new Map<string, InternalSurfaceState>();

  public hasSurface(surfaceId: string): boolean {
    return this.surfaces.has(surfaceId);
  }

  public getDataModel(surfaceId: string): Record<string, unknown> | undefined {
    return this.surfaces.get(surfaceId)?.dataModel;
  }

  public applyMessage(rawMessage: unknown): A2UIReduceResult {
    if (containsForbiddenObjectKey(rawMessage)) {
      return {
        ok: false,
        surface: null,
        error: { code: 'VALIDATION_FAILED', message: 'Forbidden prototype key detected in A2UI message.' },
      };
    }

    const parsed = A2UIAgentToRendererMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      return {
        ok: false,
        surface: null,
        error: {
          code: 'VALIDATION_FAILED',
          path: '/version',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      };
    }

    const msg = parsed.data;

    if ('createSurface' in msg) {
      const cs = msg.createSurface;
      if (this.surfaces.size >= 16 && !this.surfaces.has(cs.surfaceId)) {
        return {
          ok: false,
          surfaceId: cs.surfaceId,
          surface: null,
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Maximum active A2UI surface limit reached for this session.',
          },
        };
      }
      if (this.surfaces.has(cs.surfaceId)) {
        return {
          ok: false,
          surfaceId: cs.surfaceId,
          surface: null,
          error: {
            code: 'SURFACE_ALREADY_EXISTS',
            message: `Surface "${cs.surfaceId}" already exists; deleteSurface must precede recreation.`,
          },
        };
      }
      const compMap = new Map<string, A2UIComponentWire>();
      if (cs.components) {
        for (const c of cs.components) compMap.set(c.id, c);
      }
      const candidateState: InternalSurfaceState = {
        surfaceId: cs.surfaceId,
        catalogId: cs.catalogId,
        sendDataModel: cs.sendDataModel,
        components: compMap,
        dataModel: cs.dataModel ? { ...cs.dataModel } : {},
      };
      const compiled = this.compileSurface(candidateState);
      if (compiled.ok) this.surfaces.set(cs.surfaceId, candidateState);
      return compiled;
    }

    if ('updateComponents' in msg) {
      const uc = msg.updateComponents;
      const stateObj = this.surfaces.get(uc.surfaceId);
      if (!stateObj) {
        return {
          ok: false,
          surfaceId: uc.surfaceId,
          surface: null,
          error: { code: 'SURFACE_NOT_FOUND', message: `Surface "${uc.surfaceId}" does not exist.` },
        };
      }
      const nextComps = new Map(stateObj.components);
      for (const c of uc.components) {
        nextComps.set(c.id, c);
      }
      const candidateState: InternalSurfaceState = { ...stateObj, components: nextComps };
      const compiled = this.compileSurface(candidateState);
      if (compiled.ok) this.surfaces.set(uc.surfaceId, candidateState);
      return compiled;
    }

    if ('updateDataModel' in msg) {
      const ud = msg.updateDataModel;
      const stateObj = this.surfaces.get(ud.surfaceId);
      if (!stateObj) {
        return {
          ok: false,
          surfaceId: ud.surfaceId,
          surface: null,
          error: { code: 'SURFACE_NOT_FOUND', message: `Surface "${ud.surfaceId}" does not exist.` },
        };
      }
      let nextDataModel: Record<string, unknown>;
      try {
        const targetPath = ud.path || '/';
        nextDataModel = setByJsonPointer(stateObj.dataModel, targetPath, ud.value);
      } catch (err: any) {
        return {
          ok: false,
          surfaceId: ud.surfaceId,
          surface: null,
          error: {
            code: 'VALIDATION_FAILED',
            path: ud.path || '/',
            message: err?.message || 'Invalid data model pointer update.',
          },
        };
      }
      const candidateState: InternalSurfaceState = { ...stateObj, dataModel: nextDataModel };
      const compiled = this.compileSurface(candidateState);
      if (compiled.ok) this.surfaces.set(ud.surfaceId, candidateState);
      return compiled;
    }

    // deleteSurface
    const ds = msg.deleteSurface;
    if (!this.surfaces.has(ds.surfaceId)) {
      return {
        ok: false,
        surfaceId: ds.surfaceId,
        surface: null,
        error: { code: 'SURFACE_NOT_FOUND', message: `Surface "${ds.surfaceId}" does not exist.` },
      };
    }
    this.surfaces.delete(ds.surfaceId);
    return { ok: true, surfaceId: ds.surfaceId, surface: null, deleted: true };
  }

  private compileSurface(stateObj: InternalSurfaceState): A2UIReduceResult {
    const rootWire = stateObj.components.get('root');
    if (!rootWire) {
      return { ok: true, surfaceId: stateObj.surfaceId, surface: null };
    }

    const mappedComponents: GenUIComponent[] = [];
    const actions: GenUIActionDefinition[] = [];
    const seenActionIds = new Set<string>();
    const extraTemplateComponents: GenUIComponent[] = [];

    for (const wire of stateObj.components.values()) {
      const mapped = mapWireComponentToGenUI(
        wire,
        stateObj.catalogId,
        stateObj.dataModel,
        stateObj.components,
        actions,
        seenActionIds,
        extraTemplateComponents
      );
      if (!mapped) {
        return {
          ok: false,
          surfaceId: stateObj.surfaceId,
          surface: null,
          error: {
            code: 'VALIDATION_FAILED',
            path: `/components/${wire.id}`,
            message: `Unsupported A2UI component "${wire.component}" in Phase 2 profile.`,
          },
        };
      }
      mappedComponents.push(mapped);
    }
    for (const extra of extraTemplateComponents) {
      if (!mappedComponents.some((c) => c.id === extra.id)) {
        mappedComponents.push(extra);
      }
    }

    const candidate: GenUISurface = {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: stateObj.surfaceId,
      rootId: 'root',
      components: mappedComponents,
      state: stateObj.dataModel as GenUIStateRecord,
      actions,
      textFallback: `Interactive surface ${stateObj.surfaceId}`,
      evidence: [],
      origin: 'model',
      presentationMode: 'declarative_interactive',
      generatedAt: Date.now(),
    };

    const validated = validateGenUISurface(candidate);
    if (!validated.ok) {
      return {
        ok: false,
        surfaceId: stateObj.surfaceId,
        surface: null,
        error: {
          code: 'VALIDATION_FAILED',
          path: '/components',
          message: validated.error,
        },
      };
    }

    return { ok: true, surfaceId: stateObj.surfaceId, surface: validated.surface };
  }
}

export function mapAiraGenUIToA2UIV1Messages(surface: GenUISurface): A2UIAgentToRendererMessage[] {
  const wireComponents: A2UIComponentWire[] = surface.components.map((comp) => {
    const id = comp.id === surface.rootId ? 'root' : comp.id;
    const rawProps = { ...comp.props } as Record<string, unknown>;
    if (Array.isArray(rawProps.children)) {
      rawProps.children = rawProps.children.map((cid) => (cid === surface.rootId ? 'root' : cid));
    }
    return {
      id,
      component: comp.type,
      '@catalogId': AIRA_A2UI_CATALOG_ID,
      props: rawProps,
    };
  });

  return [
    {
      version: A2UI_PROTOCOL_VERSION,
      createSurface: {
        surfaceId: surface.surfaceId,
        catalogId: AIRA_A2UI_CATALOG_ID,
        sendDataModel: true,
        components: wireComponents,
        dataModel: surface.state as Record<string, unknown>,
      },
    },
  ];
}
