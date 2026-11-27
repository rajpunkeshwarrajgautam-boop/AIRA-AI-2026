import crypto from 'node:crypto';
import type { ModelToolChoice, ModelToolDefinition } from '../../contracts/src/index.js';

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolCallValidationErrorCode =
  | 'MALFORMED_TOOL_ARGUMENTS'
  | 'MISSING_TOOL_NAME'
  | 'INCOMPLETE_TOOL_CALL';

export interface ModelToolCallValidationError {
  id: string;
  index: number;
  name?: string;
  rawArguments: string;
  error: string;
  code: ToolCallValidationErrorCode;
}

export type ModelStreamEventType =
  | 'text'
  | 'thinking'
  | 'tool_call_start'
  | 'tool_call_delta'
  | 'tool_call_end'
  | 'tool_call_validation_error'
  | 'done';

export interface ModelStreamUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelStreamDelta {
  type?: ModelStreamEventType;
  text?: string;
  thinking?: string;
  toolCallId?: string;
  toolCallIndex?: number;
  toolName?: string;
  argumentsDelta?: string;
  arguments?: Record<string, unknown>;
  rawArguments?: string;
  validationError?: ModelToolCallValidationError;
  finishReason?: string;
  usage?: ModelStreamUsage;
}

export function isSubstantiveStreamDelta(delta: ModelStreamDelta): boolean {
  if (typeof delta.text === 'string' && delta.text.trim().length > 0) {
    return true;
  }
  return (
    delta.type === 'tool_call_start' ||
    delta.type === 'tool_call_delta' ||
    delta.type === 'tool_call_end'
  );
}

interface PendingToolCallSlot {
  index: number;
  id: string;
  name: string;
  rawArguments: string;
  started: boolean;
  closed: boolean;
}

export function validateToolArgumentsJson(
  id: string,
  index: number,
  name: string | undefined,
  rawArguments: string
): { valid: true; toolCall: ModelToolCall } | { valid: false; error: ModelToolCallValidationError } {
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName) {
    return {
      valid: false,
      error: {
        id,
        index,
        name: cleanName || undefined,
        rawArguments,
        error: 'Tool call omitted required function name.',
        code: 'MISSING_TOOL_NAME',
      },
    };
  }

  const trimmed = rawArguments.trim();
  const jsonSource = trimmed.length === 0 ? '{}' : trimmed;

  try {
    const parsed = JSON.parse(jsonSource);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        valid: false,
        error: {
          id,
          index,
          name: cleanName,
          rawArguments,
          error: 'Tool call arguments must deserialize to a JSON object.',
          code: 'MALFORMED_TOOL_ARGUMENTS',
        },
      };
    }
    return {
      valid: true,
      toolCall: {
        id,
        name: cleanName,
        arguments: parsed as Record<string, unknown>,
      },
    };
  } catch (err: any) {
    return {
      valid: false,
      error: {
        id,
        index,
        name: cleanName,
        rawArguments,
        error: `Malformed JSON tool arguments: ${err?.message || 'parse error'}`,
        code: 'MALFORMED_TOOL_ARGUMENTS',
      },
    };
  }
}

/**
 * Shared provider-normalized incremental tool-call accumulator.
 * Handles chunked JSON strings, concurrent interleaved indices, missing provider IDs,
 * duplicate terminal events, and strict validation before execution exposure.
 */
export class ToolCallStreamAccumulator {
  private readonly streamToken = crypto.randomUUID().slice(0, 8);
  private readonly slots = new Map<number, PendingToolCallSlot>();
  private readonly validCalls: ModelToolCall[] = [];
  private readonly invalidCalls: ModelToolCallValidationError[] = [];

  public pushChunk(input: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
    parsedArguments?: Record<string, unknown>;
  }): ModelStreamDelta[] {
    const events: ModelStreamDelta[] = [];
    const index = Number.isInteger(input.index) && input.index >= 0 ? input.index : 0;
    let slot = this.slots.get(index);

    if (!slot) {
      const resolvedId =
        typeof input.id === 'string' && input.id.trim().length > 0
          ? input.id.trim()
          : `call_${this.streamToken}_${index}`;
      slot = {
        index,
        id: resolvedId,
        name: typeof input.name === 'string' ? input.name.trim() : '',
        rawArguments: '',
        started: false,
        closed: false,
      };
      this.slots.set(index, slot);
    } else if (slot.closed) {
      // Ignore duplicate chunks for an already terminated slot
      return events;
    } else {
      if (!slot.name && typeof input.name === 'string' && input.name.trim().length > 0) {
        slot.name = input.name.trim();
      }
      if (!slot.started && typeof input.id === 'string' && input.id.trim().length > 0) {
        slot.id = input.id.trim();
      }
    }

    if (!slot.started) {
      slot.started = true;
      events.push({
        type: 'tool_call_start',
        toolCallId: slot.id,
        toolCallIndex: slot.index,
        toolName: slot.name || undefined,
      });
    }

    if (typeof input.argumentsDelta === 'string' && input.argumentsDelta.length > 0) {
      slot.rawArguments += input.argumentsDelta;
      events.push({
        type: 'tool_call_delta',
        toolCallId: slot.id,
        toolCallIndex: slot.index,
        toolName: slot.name || undefined,
        argumentsDelta: input.argumentsDelta,
      });
    } else if (input.parsedArguments !== undefined) {
      const serialized = JSON.stringify(input.parsedArguments);
      slot.rawArguments += serialized;
      events.push({
        type: 'tool_call_delta',
        toolCallId: slot.id,
        toolCallIndex: slot.index,
        toolName: slot.name || undefined,
        argumentsDelta: serialized,
      });
    }

    return events;
  }

  public closeSlot(index: number): ModelStreamDelta | null {
    const slot = this.slots.get(index);
    if (!slot || slot.closed) {
      return null;
    }
    slot.closed = true;

    const checked = validateToolArgumentsJson(slot.id, slot.index, slot.name, slot.rawArguments);
    if (checked.valid) {
      this.validCalls.push(checked.toolCall);
      return {
        type: 'tool_call_end',
        toolCallId: checked.toolCall.id,
        toolCallIndex: slot.index,
        toolName: checked.toolCall.name,
        arguments: checked.toolCall.arguments,
        rawArguments: slot.rawArguments,
      };
    }

    this.invalidCalls.push(checked.error);
    return {
      type: 'tool_call_validation_error',
      toolCallId: slot.id,
      toolCallIndex: slot.index,
      toolName: slot.name || undefined,
      rawArguments: slot.rawArguments,
      validationError: checked.error,
    };
  }

  public finalizeAll(streamTerminatedCleanly: boolean): {
    events: ModelStreamDelta[];
    toolCalls: ModelToolCall[];
    invalidToolCalls: ModelToolCallValidationError[];
  } {
    const events: ModelStreamDelta[] = [];
    const orderedIndices = [...this.slots.keys()].sort((a, b) => a - b);

    for (const idx of orderedIndices) {
      const slot = this.slots.get(idx)!;
      if (slot.closed) continue;

      if (!streamTerminatedCleanly) {
        slot.closed = true;
        const err: ModelToolCallValidationError = {
          id: slot.id,
          index: slot.index,
          name: slot.name || undefined,
          rawArguments: slot.rawArguments,
          error: 'Tool call stream terminated before completion.',
          code: 'INCOMPLETE_TOOL_CALL',
        };
        this.invalidCalls.push(err);
        events.push({
          type: 'tool_call_validation_error',
          toolCallId: slot.id,
          toolCallIndex: slot.index,
          toolName: slot.name || undefined,
          rawArguments: slot.rawArguments,
          validationError: err,
        });
        continue;
      }

      const evt = this.closeSlot(idx);
      if (evt) events.push(evt);
    }

    return {
      events,
      toolCalls: [...this.validCalls],
      invalidToolCalls: [...this.invalidCalls],
    };
  }

  public getResults(): {
    toolCalls: ModelToolCall[];
    invalidToolCalls: ModelToolCallValidationError[];
  } {
    return {
      toolCalls: [...this.validCalls],
      invalidToolCalls: [...this.invalidCalls],
    };
  }
}

export function formatOpenAITools(tools?: ModelToolDefinition[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

export function formatOpenAIToolChoice(toolChoice?: ModelToolChoice): unknown {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  return {
    type: 'function',
    function: { name: toolChoice.name },
  };
}

export function formatAnthropicTools(tools?: ModelToolDefinition[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters || { type: 'object', properties: {} },
  }));
}

export function formatAnthropicToolChoice(toolChoice?: ModelToolChoice): unknown {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice === 'none') return { type: 'none' };
  return { type: 'tool', name: toolChoice.name };
}
