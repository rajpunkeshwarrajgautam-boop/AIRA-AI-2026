import { EventType, type BaseEvent } from '@ag-ui/core';
import {
  AIRA_GENUI_CONTRACT_VERSION,
  A2UISurfaceReducer,
  validateGenUISurface,
  applyGenUILifecycleEventToMap,
  buildCalculatorSurface,
  type GenUICalculatorKind,
  type GenUIComponent,
  type GenUIInteractionEvent,
  type GenUIStateRecord,
  type GenUISurface,
  type GenUIValidationResult,
  type StreamingEvent,
} from '../../contracts/src/index.js';

export { applyGenUILifecycleEventToMap };

const GENUI_OPEN_TAG = '<airaGenUI>';
const GENUI_CLOSE_TAG = '</airaGenUI>';

/**
 * Narrow AG-UI compatibility adapter: translates authoritative AIRA StreamingEvents
 * into validated @ag-ui/core protocol events without replacing AgentRuntime.
 */
export function adaptAiraEventToAGUI(event: StreamingEvent): BaseEvent[] {
  const threadId = String((event.data as any)?.threadId || (event.data as any)?.conversationId || event.runId);
  const messageId = `msg_${event.runId}`;
  const ts = Math.trunc(event.timestamp);

  switch (event.type) {
    case 'run.started':
      return [
        {
          type: EventType.RUN_STARTED,
          threadId,
          runId: event.runId,
          timestamp: ts,
        },
      ];
    case 'thinking.delta':
      return [
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: `reason_${event.runId}`,
          delta: String((event.data as any)?.delta || ''),
          timestamp: ts,
        },
      ];
    case 'content.delta':
      return [
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: String((event.data as any)?.delta || ''),
          timestamp: ts,
        },
      ];
    case 'tool.started':
      return [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: String((event.data as any)?.callId || (event.data as any)?.toolCallId || event.eventId),
          toolCallName: String((event.data as any)?.toolName || 'tool'),
          parentMessageId: messageId,
          timestamp: ts,
        },
      ];
    case 'tool.completed':
    case 'tool.failed':
      return [
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId,
          toolCallId: String((event.data as any)?.callId || (event.data as any)?.toolCallId || event.eventId),
          content:
            typeof (event.data as any)?.output === 'string'
              ? (event.data as any).output
              : JSON.stringify((event.data as any)?.output ?? (event.data as any)?.error ?? {}),
          timestamp: ts,
        },
      ];
    case 'workflow.started':
    case 'workflow.step.started':
      return [
        {
          type: EventType.STEP_STARTED,
          stepName: String((event.data as any)?.stepId || (event.data as any)?.workflowId || 'step'),
          timestamp: ts,
        },
      ];
    case 'workflow.step.completed':
    case 'workflow.completed':
      return [
        {
          type: EventType.STEP_FINISHED,
          stepName: String((event.data as any)?.stepId || (event.data as any)?.workflowId || 'step'),
          timestamp: ts,
        },
      ];
    case 'genui.surface.created': {
      const surface = (event.data as any)?.surface;
      const out: BaseEvent[] = [
        {
          type: EventType.CUSTOM,
          name: 'aira.genui.surface.created',
          value: event.data,
          timestamp: ts,
        },
      ];
      if (surface && surface.surfaceId) {
        out.unshift({
          type: EventType.STATE_SNAPSHOT,
          snapshot: { genuiSurfaces: { [surface.surfaceId]: surface } },
          timestamp: ts,
        });
      }
      return out;
    }
    case 'genui.surface.patched':
    case 'genui.surface.completed':
    case 'genui.surface.deleted':
    case 'genui.surface.error':
      return [
        {
          type: EventType.CUSTOM,
          name: `aira.${event.type}`,
          value: event.data,
          timestamp: ts,
        },
      ];
    case 'run.completed':
      return [
        {
          type: EventType.RUN_FINISHED,
          threadId,
          runId: event.runId,
          outcome: 'success',
          timestamp: ts,
        },
      ];
    case 'run.cancelled':
      return [
        {
          type: EventType.RUN_FINISHED,
          threadId,
          runId: event.runId,
          outcome: 'interrupt',
          timestamp: ts,
        },
      ];
    case 'run.failed':
      return [
        {
          type: EventType.RUN_ERROR,
          message: String((event.data as any)?.error || 'Run failed'),
          code: 'RUN_FAILED',
          timestamp: ts,
        },
      ];
    default:
      return [
        {
          type: EventType.CUSTOM,
          name: `aira.${event.type}`,
          value: event.data ?? null,
          timestamp: ts,
        },
      ];
  }
}

function tryParseGenUIBlock(
  rawInner: string,
  a2uiReducer: A2UISurfaceReducer
): { surfaces: GenUIValidationResult[]; deletedSurfaceIds: string[] } {
  const cleaned = rawInner
    .trim()
    .replace(/^```(?:json|jsonl)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const surfaces: GenUIValidationResult[] = [];
  const deletedSurfaceIds: string[] = [];

  const handleParsed = (obj: unknown) => {
    if (obj && typeof obj === 'object' && (obj as any).version === '1.0') {
      const res = a2uiReducer.applyMessage(obj);
      if (!res.ok && res.error) {
        surfaces.push({
          ok: false,
          code: res.error.code,
          error: res.error.message,
        });
      } else if (res.deleted && res.surfaceId) {
        const idx = surfaces.findIndex((s) => s.ok && s.surface.surfaceId === res.surfaceId);
        if (idx >= 0) surfaces.splice(idx, 1);
        deletedSurfaceIds.push(res.surfaceId);
      } else if (res.ok && res.surface) {
        // Keep latest reduced snapshot for same surfaceId inside the same block
        const idx = surfaces.findIndex((s) => s.ok && s.surface.surfaceId === res.surface!.surfaceId);
        if (idx >= 0) surfaces[idx] = { ok: true, surface: res.surface };
        else surfaces.push({ ok: true, surface: res.surface });
      }
      return;
    }
    surfaces.push(validateGenUISurface(obj));
  };

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      for (const item of parsed) handleParsed(item);
    } else {
      handleParsed(parsed);
    }
    return { surfaces, deletedSurfaceIds };
  } catch (err: any) {
    // Support JSONL streams of A2UI v1.0 messages (one JSON object per line)
    const lines = cleaned
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length > 1) {
      let parsedAny = false;
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          parsedAny = true;
          handleParsed(item);
        } catch (lineErr: any) {
          return {
            surfaces: [
              {
                ok: false,
                code: 'GENUI_INVALID_JSON',
                error: lineErr?.message || 'Malformed JSONL line inside <airaGenUI> block.',
              },
            ],
            deletedSurfaceIds,
          };
        }
      }
      if (parsedAny) return { surfaces, deletedSurfaceIds };
    }

    return {
      surfaces: [
        {
          ok: false,
          code: 'GENUI_INVALID_JSON',
          error: err?.message || 'Malformed JSON inside <airaGenUI> block.',
        },
      ],
      deletedSurfaceIds,
    };
  }
}

/**
 * Streaming detector that extracts validated <airaGenUI>{...}</airaGenUI> blocks
 * (native aira-genui/v1 or profiled A2UI v1.0 JSON/JSONL messages) while stripping
 * partial/complete tag markup from user-visible prose.
 */
export class GenUIStreamTagExtractor {
  private buffer = '';
  private insideTag = false;
  private tagBuffer = '';
  private readonly maxTagBytes = 256 * 1024;
  private readonly a2uiReducer = new A2UISurfaceReducer();

  public pushChunk(chunk: string): {
    visibleText: string;
    surfaces: GenUIValidationResult[];
    deletedSurfaceIds: string[];
  } {
    this.buffer += chunk;
    let visibleText = '';
    const surfaces: GenUIValidationResult[] = [];
    const deletedSurfaceIds: string[] = [];

    while (this.buffer.length > 0) {
      if (!this.insideTag) {
        const openIdx = this.buffer.indexOf(GENUI_OPEN_TAG);
        if (openIdx >= 0) {
          visibleText += this.buffer.slice(0, openIdx);
          this.buffer = this.buffer.slice(openIdx + GENUI_OPEN_TAG.length);
          this.insideTag = true;
          this.tagBuffer = '';
          continue;
        }

        // Preserve any trailing prefix that could start <airaGenUI>
        let partialStart = -1;
        for (let i = Math.max(0, this.buffer.length - GENUI_OPEN_TAG.length + 1); i < this.buffer.length; i++) {
          if (GENUI_OPEN_TAG.startsWith(this.buffer.slice(i))) {
            partialStart = i;
            break;
          }
        }
        if (partialStart >= 0) {
          visibleText += this.buffer.slice(0, partialStart);
          this.buffer = this.buffer.slice(partialStart);
          break;
        }
        visibleText += this.buffer;
        this.buffer = '';
        break;
      } else {
        const closeIdx = this.buffer.indexOf(GENUI_CLOSE_TAG);
        if (closeIdx >= 0) {
          if (this.tagBuffer.length + closeIdx > this.maxTagBytes) {
            this.buffer = this.buffer.slice(closeIdx + GENUI_CLOSE_TAG.length);
            this.insideTag = false;
            this.tagBuffer = '';
            surfaces.push({
              ok: false,
              code: 'GENUI_PAYLOAD_TOO_LARGE',
              error: 'Streaming GenUI block exceeded size limit.',
            });
            continue;
          }
          this.tagBuffer += this.buffer.slice(0, closeIdx);
          this.buffer = this.buffer.slice(closeIdx + GENUI_CLOSE_TAG.length);
          this.insideTag = false;
          const blockResult = tryParseGenUIBlock(this.tagBuffer, this.a2uiReducer);
          surfaces.push(...blockResult.surfaces);
          deletedSurfaceIds.push(...blockResult.deletedSurfaceIds);
          this.tagBuffer = '';
          continue;
        }

        // Keep partial close tag suffix buffered
        let partialClose = -1;
        for (let i = Math.max(0, this.buffer.length - GENUI_CLOSE_TAG.length + 1); i < this.buffer.length; i++) {
          if (GENUI_CLOSE_TAG.startsWith(this.buffer.slice(i))) {
            partialClose = i;
            break;
          }
        }
        const appendSlice = partialClose >= 0 ? this.buffer.slice(0, partialClose) : this.buffer;
        if (this.tagBuffer.length + appendSlice.length > this.maxTagBytes) {
          this.insideTag = false;
          this.tagBuffer = '';
          this.buffer = '';
          surfaces.push({
            ok: false,
            code: 'GENUI_PAYLOAD_TOO_LARGE',
            error: 'Streaming GenUI block exceeded size limit.',
          });
          break;
        }
        this.tagBuffer += appendSlice;
        this.buffer = partialClose >= 0 ? this.buffer.slice(partialClose) : '';
        break;
      }
    }

    return { visibleText, surfaces, deletedSurfaceIds };
  }

  public flush(): { visibleText: string; surfaces: GenUIValidationResult[]; deletedSurfaceIds: string[] } {
    if (this.insideTag) {
      const result: GenUIValidationResult = {
        ok: false,
        code: 'GENUI_UNTERMINATED_BLOCK',
        error: 'GenUI stream ended before closing </airaGenUI> tag.',
      };
      this.insideTag = false;
      this.tagBuffer = '';
      this.buffer = '';
      return { visibleText: '', surfaces: [result], deletedSurfaceIds: [] };
    }
    const visibleText = this.buffer;
    this.buffer = '';
    return { visibleText, surfaces: [], deletedSurfaceIds: [] };
  }
}

export function detectDeterministicCalculatorIntent(prompt: string): GenUICalculatorKind | null {
  const q = prompt.trim().toLowerCase();
  if (!q) return null;

  if (/\b(?:compound interest|compounding|savings growth|investment growth|future value)\b/.test(q)) {
    return 'compound_interest';
  }
  if (/\b(?:emi|loan payment|mortgage calculator|mortgage payment|amortization|car loan|monthly payment)\b/.test(q)) {
    return 'loan_payment';
  }
  if (
    /\bconvert\b/.test(q) &&
    /\b(?:km|mi|miles|kilometers|meters|feet|ft|inches|kg|lb|lbs|pounds|celsius|fahrenheit|kelvin|gb|mb|tb|kb|mph|km\/h)\b/.test(q)
  ) {
    return 'unit_conversion';
  }
  if (
    /\b(?:what is|calculate|compute)\b.*\b(?:\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+\d+/.test(q) ||
    /\b(?:percentage calculator|percent change calculator|percent increase calculator)\b/.test(q)
  ) {
    return 'percentage';
  }
  if (
    /\b(?:plot|graph|evaluate|calculator)\b/.test(q) &&
    /(?:f\(x\)|sin\(|cos\(|tan\(|sqrt\(|x\s*\^\s*\d)/i.test(q)
  ) {
    return 'scientific_eval';
  }
  return null;
}

export function extractCalculatorInitialState(kind: GenUICalculatorKind, prompt: string): GenUIStateRecord {
  const nums = (prompt.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || [])
    .map((s) => Number(s.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));

  if (kind === 'compound_interest') {
    const rateMatch = prompt.match(/(\d+(?:\.\d+)?)\s*%/);
    const yearsMatch = prompt.match(/(\d+)\s*(?:years?|yrs?)/i);
    const principalMatch = prompt.match(/(?:\$|rs\.?|inr|principal|on)\s*(\d+(?:,\d{3})*(?:\.\d+)?)/i);
    return {
      principal: principalMatch ? Number(principalMatch[1].replace(/,/g, '')) : nums[0] ?? 10000,
      annualRatePercent: rateMatch ? Number(rateMatch[1]) : 8,
      years: yearsMatch ? Number(yearsMatch[1]) : 10,
      compoundingPerYear: /\bquarter/i.test(prompt) ? 4 : /\bannual|yearly/i.test(prompt) ? 1 : 12,
      monthlyContribution: 0,
    };
  }

  if (kind === 'loan_payment') {
    const rateMatch = prompt.match(/(\d+(?:\.\d+)?)\s*%/);
    const yearsMatch = prompt.match(/(\d+)\s*(?:years?|yrs?)/i);
    const monthsMatch = prompt.match(/(\d+)\s*months?/i);
    return {
      principal: nums[0] ?? 250000,
      annualRatePercent: rateMatch ? Number(rateMatch[1]) : 6.5,
      termMonths: monthsMatch ? Number(monthsMatch[1]) : yearsMatch ? Number(yearsMatch[1]) * 12 : 60,
    };
  }

  if (kind === 'percentage') {
    if (/change/i.test(prompt)) {
      return { mode: 'percent_change', valueA: nums[0] ?? 80, valueB: nums[1] ?? 100 };
    }
    return { mode: 'percent_of', valueA: nums[0] ?? 15, valueB: nums[1] ?? 200 };
  }

  if (kind === 'unit_conversion') {
    const lower = prompt.toLowerCase();
    if (/celsius|fahrenheit|kelvin|\b[cfk]\b/.test(lower) && (/\bcelsius\b|\bfahrenheit\b|\bkelvin\b/.test(lower))) {
      return {
        category: 'temperature',
        value: nums[0] ?? 100,
        fromUnit: /to fahrenheit|-> fahrenheit/i.test(lower) ? 'C' : 'F',
        toUnit: /to fahrenheit|-> fahrenheit/i.test(lower) ? 'F' : 'C',
      };
    }
    if (/\bkg\b|\blb\b|\bpounds?\b|\bgrams?\b/.test(lower)) {
      return {
        category: 'mass',
        value: nums[0] ?? 10,
        fromUnit: /\bkg\b/i.test(lower.split(/\bto\b/)[0] || '') ? 'kg' : 'lb',
        toUnit: /\blb|pounds?\b/i.test(lower.split(/\bto\b/)[1] || '') ? 'lb' : 'kg',
      };
    }
    return {
      category: 'length',
      value: nums[0] ?? 10,
      fromUnit: /\bmi\b|\bmiles?\b/i.test(lower.split(/\bto\b/)[0] || '') ? 'mi' : 'km',
      toUnit: /\bkm\b|\bkilometers?\b/i.test(lower.split(/\bto\b/)[1] || '') ? 'km' : 'mi',
    };
  }

  const exprMatch = prompt.match(/(?:f\(x\)\s*=\s*)([a-zA-Z0-9_+\-*/^().\s]+)/i);
  return {
    expression: exprMatch ? exprMatch[1].trim() : 'sin(x) + 0.25 * x^2',
    xMin: -6,
    xMax: 6,
  };
}

export function buildDeterministicCalculatorPromptSurface(prompt: string, runId: string): GenUISurface | null {
  const kind = detectDeterministicCalculatorIntent(prompt);
  if (!kind) return null;
  const initialState = extractCalculatorInitialState(kind, prompt);
  return buildCalculatorSurface(kind, initialState, `calc_${kind}_${runId}`);
}

export function buildRuntimeExecutionGenUISurface(params: {
  runId: string;
  title: string;
  status: 'QUEUED' | 'RUNNING' | 'WAITING_FOR_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  intent?: string;
  modelLabel?: string;
  summary?: string;
  toolCalls?: Array<{
    toolName: string;
    status: 'PENDING' | 'RUNNING' | 'WAITING_FOR_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
    durationMs?: number;
    summary?: string;
  }>;
  timeline?: Array<{
    id: string;
    label: string;
    status: 'pending' | 'active' | 'done' | 'error' | 'waiting';
    detail?: string;
  }>;
  artifacts?: Array<{ id: string; title: string; type: string; version?: number }>;
  pendingApproval?: {
    approvalId: string;
    runId: string;
    toolName: string;
    risk?: 'low' | 'medium' | 'high' | 'critical';
    reason: string;
    decision?: 'PENDING' | 'ALLOW_ONCE' | 'ALLOW_SESSION' | 'ALLOW_ALWAYS_FOR_TOOL' | 'REJECT';
  };
  errorMessage?: string;
}): GenUISurface {
  const children: string[] = ['exec_mission_summary'];
  const components: GenUIComponent[] = [
    {
      id: 'exec_root',
      type: 'vertical_group',
      props: { gap: 'sm', children },
    },
    {
      id: 'exec_mission_summary',
      type: 'mission_summary',
      props: {
        title: params.title.slice(0, 180) || 'Agent Execution',
        status: params.status,
        intent: params.intent || 'AGENT_MISSION',
        stepCount: Math.max(params.timeline?.length ?? 0, params.toolCalls?.length ?? 0, 1),
        completedSteps: (params.toolCalls || []).filter((t) => t.status === 'COMPLETED').length,
        summary: params.summary,
        modelLabel: params.modelLabel,
      },
    },
  ];

  if (params.timeline && params.timeline.length > 0) {
    children.push('exec_timeline');
    components.push({
      id: 'exec_timeline',
      type: 'execution_timeline',
      props: { title: 'Execution Timeline', entries: params.timeline.slice(0, 30) },
    });
  }

  if (params.toolCalls && params.toolCalls.length > 0) {
    children.push('exec_tools');
    components.push({
      id: 'exec_tools',
      type: 'tool_execution_summary',
      props: { title: 'Tool Executions', calls: params.toolCalls.slice(0, 30) },
    });
  }

  if (params.pendingApproval) {
    children.push('exec_approval');
    components.push({
      id: 'exec_approval',
      type: 'approval_request',
      props: {
        approvalId: params.pendingApproval.approvalId,
        runId: params.pendingApproval.runId,
        toolName: params.pendingApproval.toolName,
        risk: params.pendingApproval.risk || 'medium',
        reason: params.pendingApproval.reason,
        decision: params.pendingApproval.decision || 'PENDING',
      },
    });
  }

  if (params.artifacts && params.artifacts.length > 0) {
    params.artifacts.slice(0, 5).forEach((art, i) => {
      const id = `exec_art_${i}`;
      children.push(id);
      components.push({
        id,
        type: 'artifact_reference',
        props: {
          artifactId: art.id,
          title: art.title,
          artifactType: art.type,
          version: art.version ?? 1,
        },
      });
    });
  }

  if (params.errorMessage) {
    children.push('exec_err');
    components.push({
      id: 'exec_err',
      type: 'error_recovery',
      props: {
        title: 'Execution Stopped',
        message: params.errorMessage.slice(0, 550),
        recoverable: false,
      },
    });
  }

  return {
    schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
    surfaceId: `exec_${params.runId}`,
    title: 'Agent Workspace Execution',
    rootId: 'exec_root',
    components,
    state: {},
    actions: [],
    textFallback: `${params.title} — Status: ${params.status}${params.errorMessage ? ` (${params.errorMessage})` : ''}`,
    evidence: [],
    origin: 'runtime_execution',
    presentationMode: 'agent_workspace_view',
    generatedAt: Date.now(),
  };
}

export function buildGenUISystemInstruction(presentationMode: string): string {
  if (presentationMode === 'declarative_interactive') {
    const example =
      '{"schemaVersion":"aira-genui/v1","surfaceId":"surf_app","rootId":"root","textFallback":"Interactive workspace summary","state":{"weightCost":50,"rows":[]},"computed":[{"target":"/derived/top","kind":"math","expression":"weightCost * 2"}],"components":[{"id":"root","type":"vertical_group","props":{"gap":"md","children":["s1","m1"]}},{"id":"s1","type":"slider","props":{"label":"Weight","stateKey":"weightCost","min":0,"max":100,"step":5,"defaultValue":50}},{"id":"m1","type":"metric_display","props":{"label":"Score","value":100,"dataRef":"/derived/top"}}]}';
    return [
      'Presentation guidance (declarative_interactive):',
      'After a 1-2 sentence intro, emit one <airaGenUI>{...}</airaGenUI> JSON matching schemaVersion "aira-genui/v1" using only safe catalog types (vertical_group, horizontal_group, responsive_grid, card, section, heading, text, metric_display, progress_indicator, data_table, bar_chart, line_chart, pie_chart, doughnut_chart, numeric_input, text_input, slider, select_control, checkbox, radio_group, segmented_control, reset_control, action_button).',
      'For multi-component live updates without extra LLM calls, declare state + reactive computed rules (kinds: math, compound_growth, amortization, function_series, weighted_decision, table_filter_aggregate, progress_ratio, format_value) and bind dataRef/rowsRef/labelsRef/datasetsRef. Never emit HTML/JS/eval:',
      `<airaGenUI>${example}</airaGenUI>`,
    ].join('\n');
  }

  const example =
    presentationMode === 'table'
      ? '{"schemaVersion":"aira-genui/v1","surfaceId":"surf_tbl","rootId":"c1","textFallback":"Summary table","components":[{"id":"c1","type":"data_table","props":{"title":"Comparison","columns":[{"key":"item","label":"Item","align":"left","format":"text"},{"key":"val","label":"Value","align":"right","format":"number"}],"rows":[{"item":"A","val":10}],"sortable":true,"compact":false}}]}'
      : '{"schemaVersion":"aira-genui/v1","surfaceId":"surf_viz","rootId":"c1","textFallback":"Chart summary","components":[{"id":"c1","type":"bar_chart","props":{"title":"Comparison","labels":["A","B"],"datasets":[{"label":"Value","values":[10,20]}],"horizontal":false,"stacked":false,"allowTableToggle":true}}]}';

  return [
    `Presentation guidance (${presentationMode}):`,
    'After a short 1-2 sentence explanation, include exactly one <airaGenUI>{...}</airaGenUI> JSON block matching this exact structure (strict keys only, no extra properties, no HTML/JS):',
    `<airaGenUI>${example}</airaGenUI>`,
  ].join('\n');
}

export function authorizeGenUIActionServerSide(params: {
  principalUserId?: string;
  runOwnerUserId?: string;
  conversationOwnerUserId?: string;
  surface?: GenUISurface;
  requirePersistedSurface?: boolean;
  event: GenUIInteractionEvent;
}): {
  allowed: boolean;
  status: number;
  reason?: string;
  sanitizedStateSnapshot?: Record<string, unknown>;
} {
  const {
    principalUserId,
    runOwnerUserId,
    conversationOwnerUserId,
    surface,
    requirePersistedSurface = false,
    event,
  } = params;

  if (!principalUserId) {
    return { allowed: false, status: 401, reason: 'Authentication required for GenUI action.' };
  }

  if (!runOwnerUserId && !conversationOwnerUserId && !surface) {
    return { allowed: false, status: 403, reason: 'Ownership or persisted surface context required for GenUI action.' };
  }

  if (runOwnerUserId && principalUserId !== runOwnerUserId) {
    return { allowed: false, status: 403, reason: 'Cross-principal GenUI action denied.' };
  }

  if (conversationOwnerUserId && principalUserId !== conversationOwnerUserId) {
    return { allowed: false, status: 403, reason: 'Cross-conversation GenUI action denied.' };
  }

  if (event.kind === 'run_approval' || event.kind === 'workflow_trigger') {
    return {
      allowed: false,
      status: 403,
      reason: `Action kind "${event.kind}" must execute through dedicated /api/runs/:id/approve or /api/workflows approval endpoints.`,
    };
  }

  if (requirePersistedSurface && !surface) {
    return { allowed: false, status: 403, reason: 'Persisted GenUI surface not found for this conversation or run.' };
  }

  let sanitizedStateSnapshot: Record<string, unknown> = event.stateSnapshot || {};
  if (surface) {
    if (surface.surfaceId !== event.surfaceId) {
      return { allowed: false, status: 403, reason: 'Surface identity mismatch.' };
    }
    const def = surface.actions.find((a) => a.id === event.actionId);
    if (!def) {
      return { allowed: false, status: 403, reason: `Undeclared GenUI action "${event.actionId}".` };
    }
    if (def.kind !== event.kind) {
      return { allowed: false, status: 403, reason: `Action kind mismatch for "${event.actionId}".` };
    }
    const sourceComp = surface.components.find((c) => c.id === event.componentId);
    if (
      !sourceComp ||
      (sourceComp.type !== 'action_button' && sourceComp.type !== 'reset_control') ||
      sourceComp.props.actionId !== event.actionId
    ) {
      return {
        allowed: false,
        status: 403,
        reason: `Component "${event.componentId}" is not authorized to dispatch action "${event.actionId}".`,
      };
    }
    if (def.requiresApproval || def.permissionLevel === 'WRITE' || def.permissionLevel === 'DESTRUCTIVE') {
      return {
        allowed: false,
        status: 403,
        reason: `Consequential action "${event.actionId}" requires explicit ApprovalKernel verification.`,
      };
    }
    if (def.allowedKeys && def.allowedKeys.length > 0) {
      const allowedSet = new Set(def.allowedKeys);
      sanitizedStateSnapshot = Object.fromEntries(
        Object.entries(event.stateSnapshot || {}).filter(([k]) => allowedSet.has(k))
      );
    }
  }

  if (event.kind === 'local_recompute' || event.kind === 'reset_state' || event.kind === 'open_artifact' || event.kind === 'attach_followup') {
    return { allowed: true, status: 200, sanitizedStateSnapshot };
  }

  return { allowed: false, status: 400, reason: 'Unsupported GenUI action kind.' };
}
