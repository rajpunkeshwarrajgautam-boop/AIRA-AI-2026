import {
  ModelAdapter,
  ModelCompletionResult,
  ChatMessageInput,
  SupportedProvider
} from './index.js';
import {
  ToolCallStreamAccumulator,
  isSubstantiveStreamDelta,
  type ModelStreamDelta,
} from './tool-call-stream.js';
import { ModelPolicy } from '../../contracts/src/index.js';

export interface GeminiContentPart {
  text?: string;
  thought?: boolean;
  functionCall?: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiContentPart[];
}

export interface GeminiRequestPayload {
  contents: GeminiContent[];
  systemInstruction?: {
    parts: { text: string }[];
  };
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
  }>;
  toolConfig?: {
    functionCallingConfig: {
      mode: 'AUTO' | 'ANY' | 'NONE';
      allowedFunctionNames?: string[];
    };
  };
  generationConfig: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    responseMimeType?: string;
    thinkingConfig?: {
      thinkingBudget: number;
      includeThoughts?: boolean;
    };
  };
  safetySettings?: Array<{
    category: string;
    threshold: string;
  }>;
}

export interface GeminiParsedChunk {
  text?: string;
  thinking?: string;
  functionCalls?: Array<{
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
    rawArgs?: unknown;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
  isSafetyBlock?: boolean;
}

export class GeminiAdapter implements ModelAdapter {
  readonly provider: SupportedProvider = 'gemini';
  readonly apiKey: string;
  readonly modelName: string;
  readonly baseUrl: string;

  constructor(
    apiKey: string,
    modelName: string = 'gemini-3.5-flash-lite',
    baseUrl: string = 'https://generativelanguage.googleapis.com/v1beta'
  ) {
    this.apiKey = apiKey.trim().replace(/^["']|["']$/g, '');
    this.modelName = modelName;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  public toJSON() {
    return { provider: this.provider, model: this.modelName };
  }

  public sanitizeErrorMessage(msg: string): string {
    if (!this.apiKey) return msg;
    // Replace raw API key occurrences with [REDACTED]
    return msg.replaceAll(this.apiKey, '[REDACTED]');
  }

  public formatRequestPayload(
    messages: ChatMessageInput[],
    policy: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      extendedThinking?: boolean;
      reasoningBudget?: number;
      tools?: ModelPolicy['tools'];
      toolChoice?: ModelPolicy['toolChoice'];
      responseFormat?: ModelPolicy['responseFormat'];
    }
  ): GeminiRequestPayload {
    const rawContents: GeminiContent[] = [];
    const systemParts: { text: string }[] = [];

    for (const msg of messages) {
      const contentText = (msg.content || '').trim() || ' ';
      if (msg.role === 'system') {
        systemParts.push({ text: contentText });
      } else if (msg.role === 'assistant') {
        const parts: GeminiContentPart[] = [];
        if (msg.content && msg.content.trim().length > 0) {
          parts.push({ text: msg.content });
        }
        if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                id: tc.id,
                name: tc.name,
                args: tc.arguments || {},
              },
            });
          }
        }
        if (parts.length === 0) parts.push({ text: contentText });
        rawContents.push({
          role: 'model',
          parts
        });
      } else if (msg.role === 'tool' && msg.name) {
        let parsedResponse: Record<string, unknown>;
        try {
          const parsed = JSON.parse(msg.content || '{}');
          parsedResponse = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed
            : { result: parsed };
        } catch {
          parsedResponse = { output: msg.content };
        }
        rawContents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              id: msg.toolCallId,
              name: msg.name,
              response: parsedResponse,
            },
          }],
        });
      } else {
        // user or default
        rawContents.push({
          role: 'user',
          parts: [{ text: contentText }]
        });
      }
    }

    // Merge consecutive identical roles to adhere to Gemini strict alternating turn requirements
    const mergedContents: GeminiContent[] = [];
    for (const item of rawContents) {
      const last = mergedContents[mergedContents.length - 1];
      if (last && last.role === item.role) {
        last.parts.push(...item.parts);
      } else {
        mergedContents.push({
          role: item.role,
          parts: [...item.parts]
        });
      }
    }

    // Ensure contents is not empty
    if (mergedContents.length === 0) {
      mergedContents.push({
        role: 'user',
        parts: [{ text: 'Hello' }]
      });
    }

    const payload: GeminiRequestPayload = {
      contents: mergedContents,
      generationConfig: {
        temperature: policy.temperature ?? 0.7,
        maxOutputTokens: policy.maxTokens ?? 2048,
        ...(policy.responseFormat ? { responseMimeType: 'application/json' } : {})
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };

    const targetModel = (policy.model || this.modelName || '').toLowerCase();
    const isThinkingCapableGemini = (
      targetModel.startsWith('gemini-2.5-pro') ||
      targetModel.startsWith('gemini-2.5-flash') ||
      targetModel.startsWith('gemini-3')
    ) && !targetModel.includes('lite');
    if (
      policy.extendedThinking &&
      isThinkingCapableGemini &&
      typeof policy.reasoningBudget === 'number' &&
      policy.reasoningBudget >= 1024
    ) {
      payload.generationConfig.thinkingConfig = {
        thinkingBudget: Math.min(Math.max(Math.round(policy.reasoningBudget), 1024), 8192),
        includeThoughts: true
      };
    }

    if (systemParts.length > 0) {
      payload.systemInstruction = {
        parts: systemParts
      };
    }

    if (policy.tools && policy.tools.length > 0) {
      payload.tools = [{
        functionDeclarations: policy.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters || { type: 'object', properties: {} },
        })),
      }];
      if (policy.toolChoice) {
        if (policy.toolChoice === 'auto') {
          payload.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
        } else if (policy.toolChoice === 'none') {
          payload.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
        } else if (policy.toolChoice === 'required') {
          payload.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
        } else {
          payload.toolConfig = {
            functionCallingConfig: {
              mode: 'ANY',
              allowedFunctionNames: [policy.toolChoice.name],
            },
          };
        }
      }
    }

    return payload;
  }

  public parseSSELine(line: string): GeminiParsedChunk | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      return null;
    }

    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') {
      return null;
    }

    try {
      const data = JSON.parse(jsonStr);
      const candidate = data.candidates?.[0];
      let textDelta = '';
      let thinkingDelta = '';
      const functionCalls: NonNullable<GeminiParsedChunk['functionCalls']> = [];

      if (candidate?.content?.parts && Array.isArray(candidate.content.parts)) {
        for (const part of candidate.content.parts) {
          if (part.thought) {
            thinkingDelta += part.text || '';
          } else if (part.functionCall && typeof part.functionCall === 'object') {
            const rawArgs = part.functionCall.args;
            const isPlainObject = typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs);
            functionCalls.push({
              id: typeof part.functionCall.id === 'string' ? part.functionCall.id : undefined,
              name: typeof part.functionCall.name === 'string' ? part.functionCall.name : undefined,
              args: isPlainObject ? (rawArgs as Record<string, unknown>) : undefined,
              rawArgs: !isPlainObject && rawArgs !== undefined ? rawArgs : undefined,
            });
          } else if (part.text) {
            textDelta += part.text;
          }
        }
      }

      let usage: GeminiParsedChunk['usage'] | undefined;
      if (data.usageMetadata) {
        usage = {
          promptTokens: data.usageMetadata.promptTokenCount ?? 0,
          completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: data.usageMetadata.totalTokenCount ?? 0
        };
      }

      const isSafetyBlock = candidate?.finishReason === 'SAFETY' || data.promptFeedback?.blockReason === 'SAFETY';
      if (isSafetyBlock && !textDelta) {
        textDelta = 'I cannot fulfill this request as it triggered safety content guidelines.';
      }

      return {
        text: textDelta || undefined,
        thinking: thinkingDelta || undefined,
        functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
        usage,
        finishReason: candidate?.finishReason,
        isSafetyBlock
      };
    } catch {
      return null;
    }
  }

  async complete(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    signal?: AbortSignal
  ): Promise<ModelCompletionResult> {
    if (!this.apiKey) {
      throw new Error('Gemini API key is not configured.');
    }

    let effectiveModel = (this.modelName && !this.modelName.startsWith('aira-')) ? this.modelName : policy.model;
    if (effectiveModel.startsWith('aira-')) {
      effectiveModel = (process.env.AIRA_GEMINI_MODEL || '').trim().replace(/^["']|["']$/g, '') || 'gemini-3.5-flash-lite';
    }
    const cleanModel = effectiveModel.replace(/^models\//, '');
    if (cleanModel.startsWith('aira-')) {
      throw new Error(`INTERNAL_MODEL_ALIAS_LEAK: Refusing to dispatch internal alias "${cleanModel}" to external provider "gemini".`);
    }
    const url = `${this.baseUrl}/models/${cleanModel}:generateContent`;

    const payload = this.formatRequestPayload(messages, {
      model: cleanModel,
      temperature: policy.temperature,
      maxTokens: policy.maxTokens,
      extendedThinking: policy.extendedThinking,
      reasoningBudget: policy.reasoningBudget,
      tools: policy.tools,
      toolChoice: policy.toolChoice
    });

    signal?.throwIfAborted();

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const sanitized = this.sanitizeErrorMessage(errText);
      const err = new Error(`Gemini upstream error ${response.status}: ${sanitized}`);
      (err as any).status = response.status;
      throw err;
    }

    const data: any = await response.json();
    const candidate = data.candidates?.[0];
    let text = '';
    let thinking = '';
    const accumulator = new ToolCallStreamAccumulator();
    let fnIdx = 0;
    if (Array.isArray(candidate?.content?.parts)) {
      for (const part of candidate.content.parts) {
        if (part?.thought) {
          thinking += part.text || '';
        } else if (part?.functionCall && typeof part.functionCall === 'object') {
          const rawArgs = part.functionCall.args;
          const isPlainObject = typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs);
          accumulator.pushChunk({
            index: fnIdx++,
            id: typeof part.functionCall.id === 'string' ? part.functionCall.id : undefined,
            name: typeof part.functionCall.name === 'string' ? part.functionCall.name : undefined,
            parsedArguments: isPlainObject ? (rawArgs as Record<string, unknown>) : undefined,
            argumentsDelta: !isPlainObject && rawArgs !== undefined ? JSON.stringify(rawArgs) : undefined,
          });
        } else if (typeof part?.text === 'string') {
          text += part.text;
        }
      }
    }
    const { toolCalls, invalidToolCalls } = accumulator.finalizeAll(true);

    const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      text,
      thinking: thinking || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      invalidToolCalls: invalidToolCalls.length > 0 ? invalidToolCalls : undefined,
      finishReason: candidate?.finishReason,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens
      },
      model: cleanModel,
      outboundModel: cleanModel
    };
  }

  async stream(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    onChunk: (delta: ModelStreamDelta) => void,
    options?: {
      firstTokenTimeoutMs?: number;
      signal?: AbortSignal;
      onProvenance?: (provenance: {
        requestedProvider: string;
        requestedModel: string;
        executedProvider: string;
        executedModel: string;
        fallbackOccurred: boolean;
        fallbackReason?: string;
        hedgedRequestUsed?: boolean;
        modelIdentityVerified?: boolean;
      }) => void;
    }
  ): Promise<ModelCompletionResult> {
    if (!this.apiKey) {
      throw new Error('Gemini API key is not configured.');
    }

    let effectiveModel = (this.modelName && !this.modelName.startsWith('aira-')) ? this.modelName : policy.model;
    if (effectiveModel.startsWith('aira-')) {
      effectiveModel = (process.env.AIRA_GEMINI_MODEL || '').trim().replace(/^["']|["']$/g, '') || 'gemini-3.5-flash-lite';
    }
    const cleanModel = effectiveModel.replace(/^models\//, '');
    if (cleanModel.startsWith('aira-')) {
      throw new Error(`INTERNAL_MODEL_ALIAS_LEAK: Refusing to dispatch internal alias "${cleanModel}" to external provider "gemini".`);
    }
    const url = `${this.baseUrl}/models/${cleanModel}:streamGenerateContent?alt=sse`;

    const payload = this.formatRequestPayload(messages, {
      model: cleanModel,
      temperature: policy.temperature,
      maxTokens: policy.maxTokens,
      extendedThinking: policy.extendedThinking,
      reasoningBudget: policy.reasoningBudget,
      tools: policy.tools,
      toolChoice: policy.toolChoice
    });

    options?.signal?.throwIfAborted();

    // First-token timeout tracking: short deadline only when ResilientModelAdapter supplies one;
    // bare Gemini calls allow up to 25s so large-context / thinking requests are not clipped prematurely.
    const firstTokenTimeoutMs = options?.firstTokenTimeoutMs ?? 25000;
    let firstTokenDelivered = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    const timeoutController = new AbortController();

    const combinedSignal = options?.signal
      ? anySignal([options.signal, timeoutController.signal])
      : timeoutController.signal;

    if (firstTokenTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (!firstTokenDelivered) {
          const err = new Error(`Gemini first token deadline exceeded (${firstTokenTimeoutMs}ms)`);
          (err as any).name = 'FirstTokenTimeoutError';
          (err as any).isFirstTokenTimeout = true;
          timeoutController.abort(err);
        }
      }, firstTokenTimeoutMs);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: combinedSignal
      });
    } catch (fetchErr: any) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (fetchErr.name === 'AbortError' && timeoutController.signal.aborted) {
        const err = new Error(`Gemini first token deadline exceeded (${firstTokenTimeoutMs}ms)`);
        (err as any).name = 'FirstTokenTimeoutError';
        (err as any).isFirstTokenTimeout = true;
        throw err;
      }
      throw fetchErr;
    }

    if (!response.ok) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const errText = await response.text().catch(() => '');
      const sanitized = this.sanitizeErrorMessage(errText);
      const err = new Error(`Gemini upstream error ${response.status}: ${sanitized}`);
      (err as any).status = response.status;
      throw err;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      throw new Error('Gemini response body stream is unavailable.');
    }

    const decoder = new TextDecoder();
    let accumulatedText = '';
    let accumulatedThinking = '';
    let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason: string | undefined;
    let buffer = '';
    let truncatedTrailingFrame = false;
    const accumulator = new ToolCallStreamAccumulator();
    let fnIdx = 0;

    const onStreamAbort = () => {
      reader.cancel(combinedSignal.reason).catch(() => undefined);
    };
    if (combinedSignal.aborted) {
      onStreamAbort();
    } else {
      combinedSignal.addEventListener('abort', onStreamAbort, { once: true });
    }

    const handleParsedChunk = (parsed: GeminiParsedChunk | null) => {
      if (!parsed) return;
      if (parsed.finishReason) finishReason = parsed.finishReason;

      const markFirstToken = () => {
        if (!firstTokenDelivered) {
          firstTokenDelivered = true;
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
        }
      };

      if (parsed.thinking !== undefined && parsed.thinking.length > 0) {
        accumulatedThinking += parsed.thinking;
        onChunk({ type: 'thinking', thinking: parsed.thinking });
      }

      if (parsed.text !== undefined && parsed.text.length > 0) {
        markFirstToken();
        accumulatedText += parsed.text;
        onChunk({ type: 'text', text: parsed.text });
      }

      if (parsed.functionCalls && parsed.functionCalls.length > 0) {
        for (const fc of parsed.functionCalls) {
          const events = accumulator.pushChunk({
            index: fnIdx++,
            id: fc.id,
            name: fc.name,
            parsedArguments: fc.args,
            argumentsDelta: fc.rawArgs !== undefined ? JSON.stringify(fc.rawArgs) : undefined,
          });
          for (const evt of events) {
            if (isSubstantiveStreamDelta(evt)) markFirstToken();
            onChunk(evt);
          }
        }
      }

      if (parsed.usage) {
        finalUsage = parsed.usage;
      }
    };

    try {
      while (true) {
        combinedSignal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          handleParsedChunk(this.parseSSELine(line));
        }
      }

      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        const trimmedTrailing = buffer.trim();
        const parsedTrailing = this.parseSSELine(buffer);
        if (!parsedTrailing && trimmedTrailing.startsWith('data:') && trimmedTrailing !== 'data: [DONE]' && trimmedTrailing !== 'data:[DONE]') {
          truncatedTrailingFrame = true;
        } else {
          handleParsedChunk(parsedTrailing);
        }
      }
    } finally {
      combinedSignal.removeEventListener('abort', onStreamAbort);
      reader.releaseLock();
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    const { events: terminalToolEvents, toolCalls, invalidToolCalls } = accumulator.finalizeAll(!truncatedTrailingFrame);
    for (const evt of terminalToolEvents) {
      onChunk(evt);
    }

    if (truncatedTrailingFrame) {
      throw new Error('Gemini upstream stream truncated before completing SSE frame.');
    }

    if (!accumulatedText.trim() && toolCalls.length === 0 && invalidToolCalls.length === 0) {
      const emptyErr = new Error('EMPTY_PROVIDER_RESPONSE: Gemini upstream stream completed without returning content.');
      (emptyErr as any).code = 'EMPTY_PROVIDER_RESPONSE';
      throw emptyErr;
    }

    onChunk({ type: 'done', finishReason: finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'), usage: finalUsage });

    return {
      text: accumulatedText,
      thinking: accumulatedThinking || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      invalidToolCalls: invalidToolCalls.length > 0 ? invalidToolCalls : undefined,
      finishReason,
      usage: finalUsage,
      model: cleanModel,
      outboundModel: cleanModel
    };
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}
