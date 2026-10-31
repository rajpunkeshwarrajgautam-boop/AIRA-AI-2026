import {
  ModelAdapter,
  ModelCompletionResult,
  ChatMessageInput,
  SupportedProvider
} from './index.js';
import { ModelPolicy } from '../../contracts/src/index.js';

export interface GeminiContentPart {
  text?: string;
  thought?: boolean;
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
  generationConfig: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
  };
  safetySettings?: Array<{
    category: string;
    threshold: string;
  }>;
}

export interface GeminiParsedChunk {
  text?: string;
  thinking?: string;
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
    policy: { model?: string; temperature?: number; maxTokens?: number }
  ): GeminiRequestPayload {
    const rawContents: GeminiContent[] = [];
    const systemParts: { text: string }[] = [];

    for (const msg of messages) {
      const contentText = (msg.content || '').trim() || ' ';
      if (msg.role === 'system') {
        systemParts.push({ text: contentText });
      } else if (msg.role === 'assistant') {
        rawContents.push({
          role: 'model',
          parts: [{ text: contentText }]
        });
      } else {
        // user, tool, or default
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
        maxOutputTokens: policy.maxTokens ?? 2048
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };

    if (systemParts.length > 0) {
      payload.systemInstruction = {
        parts: systemParts
      };
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

      if (candidate?.content?.parts && Array.isArray(candidate.content.parts)) {
        for (const part of candidate.content.parts) {
          if (part.thought) {
            thinkingDelta += part.text || '';
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
      maxTokens: policy.maxTokens
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
    const text = candidate?.content?.parts?.[0]?.text || '';

    const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      text,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens
      },
      model: cleanModel
    };
  }

  async stream(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    onChunk: (delta: { text?: string; thinking?: string }) => void,
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
      maxTokens: policy.maxTokens
    });

    options?.signal?.throwIfAborted();

    // First-token timeout tracking (evidence-based default for Gemini fallback: 4000ms)
    const firstTokenTimeoutMs = options?.firstTokenTimeoutMs ?? 4000;
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
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const parsed = this.parseSSELine(line);
          if (!parsed) continue;

          if (parsed.text !== undefined && parsed.text.length > 0) {
            if (!firstTokenDelivered) {
              firstTokenDelivered = true;
              if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = null;
              }
            }
            accumulatedText += parsed.text;
            onChunk({ text: parsed.text });
          }

          if (parsed.thinking !== undefined && parsed.thinking.length > 0) {
            accumulatedThinking += parsed.thinking;
            onChunk({ thinking: parsed.thinking });
          }

          if (parsed.usage) {
            finalUsage = parsed.usage;
          }
        }
      }

      if (buffer.length > 0) {
        const parsed = this.parseSSELine(buffer);
        if (parsed?.text) {
          if (!firstTokenDelivered) {
            firstTokenDelivered = true;
            if (timeoutTimer) {
              clearTimeout(timeoutTimer);
              timeoutTimer = null;
            }
          }
          accumulatedText += parsed.text;
          onChunk({ text: parsed.text });
        }
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    return {
      text: accumulatedText,
      usage: finalUsage,
      model: cleanModel
    };
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    sig.addEventListener('abort', () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}
