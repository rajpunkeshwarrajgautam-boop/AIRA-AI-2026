import {
  ModelId,
  ModelPolicy,
  ModelPolicySchema,
  normalizeModelIdentifier,
  IntentTaxonomy
} from '../../contracts/src/index.js';
import { ProviderHealthTracker } from './health-tracker.js';
import { LatencyAwareRoutingPolicy } from './routing-policy.js';
import { ResilientModelAdapter } from './resilient-adapter.js';
import { GeminiAdapter } from './gemini-adapter.js';
import { PrivateBetaCapacityGuard } from './capacity/index.js';
import { protectInferenceAdapter } from './inference-capacity.js';
export * from './inference-capacity.js';

export * from './capacity/index.js';

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ModelCompletionResult {
  text: string;
  thinking?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model?: string;
  outboundModel?: string;
}

export function isModelMatch(outboundModel?: string, upstreamResponseModel?: string): boolean {
  if (!outboundModel || !upstreamResponseModel) return false;
  const cleanOutbound = outboundModel.trim().toLowerCase();
  const cleanUpstream = upstreamResponseModel.trim().toLowerCase();
  if (cleanOutbound === cleanUpstream) return true;
  const stripNamespace = (m: string) => m.includes('/') ? m.split('/').pop()! : m;
  const bareOutbound = stripNamespace(cleanOutbound);
  const bareUpstream = stripNamespace(cleanUpstream);
  if (bareOutbound === bareUpstream) return true;

  // Handle snapshot / date suffixes only (e.g. gpt-4o vs gpt-4o-2024-08-06, claude-3-5-sonnet vs claude-3-5-sonnet-20241022)
  const isDateSnapshotSuffix = (base: string, candidate: string) => {
    if (!candidate.startsWith(base + '-')) return false;
    const suffix = candidate.slice(base.length + 1);
    return /^\d{4}(-\d{2}-\d{2})?$|^\d{8}$|^\d{4}$/.test(suffix);
  };

  if (isDateSnapshotSuffix(bareOutbound, bareUpstream) || isDateSnapshotSuffix(bareUpstream, bareOutbound)) {
    return true;
  }

  return false;
}

export type SupportedProvider =
  | 'nvidia'
  | 'anthropic'
  | 'openai'
  | 'groq'
  | 'gemini'
  | 'cerebras'
  | 'together'
  | 'fireworks'
  | 'mock'
  | 'unknown';

export interface ModelAdapter {
  provider: SupportedProvider;
  complete(messages: ChatMessageInput[], policy: ModelPolicy, signal?: AbortSignal): Promise<ModelCompletionResult>;
  stream(
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
  ): Promise<ModelCompletionResult>;
}

export class DeterministicMockAdapter implements ModelAdapter {
  readonly provider = 'mock' as const;

  async complete(messages: ChatMessageInput[], policy: ModelPolicy, signal?: AbortSignal): Promise<ModelCompletionResult> {
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const thinking = policy.extendedThinking
      ? `Analyzing intent for request: "${lastUserMessage.slice(0, 80)}...". Resolving execution strategy via deterministic model policy ${policy.model}.`
      : undefined;

    let text = `Processed your request using ${policy.model}.`;
    if (lastUserMessage.includes('[System Tool Execution Result') || lastUserMessage.includes('[System Tool Execution Findings]')) {
      if (lastUserMessage.includes('browser_navigate') || lastUserMessage.includes('pageHeading')) {
        let heading = 'Example Domain';
        const match = lastUserMessage.match(/"pageHeading":\s*"([^"]+)"/);
        if (match) heading = match[1];
        text = `The heading of the page is: ${heading}. Browser navigation and DOM extraction were completed successfully.`;
      } else if (lastUserMessage.includes('repo_git_log') || lastUserMessage.includes('latest commit')) {
        text = `Repository inspection complete. Retrieved commit history successfully.`;
      } else if (lastUserMessage.includes('calculator')) {
        const match = lastUserMessage.match(/Output:\s*"?([0-9.]+)"?/i) || lastUserMessage.match(/"result":\s*"?([0-9.]+)"?/i);
        const res = match ? match[1] : '4194304';
        text = `Calculation completed successfully. Result: ${res}.`;
      } else {
        text = `Tool execution completed. Findings synthesized successfully.`;
      }
    } else if (lastUserMessage.includes('[Durable Prior Conversation History]')) {
      text = `Yes, I recall our previous conversation about paneer bhurjee. Based on the durable prior conversation history retrieved from the server database, you asked for a quick recipe for spicy paneer bhurjee.`;
    } else if (lastUserMessage.toLowerCase().includes('paneer')) {
      text = `Here is a quick recipe for spicy paneer bhurjee: Heat oil, sauté cumin, onions, ginger, and green chilies. Add chopped tomatoes, turmeric, red chili powder, and salt. Cook until mushy, then fold in crumbled paneer. Garnish with fresh cilantro.`;
    } else if (lastUserMessage.toLowerCase().includes('quantum xylophone banana')) {
      text = `I don't recall any prior discussion about a "quantum xylophone banana protocol" in our conversation history. No such topic was discussed.`;
    } else if (lastUserMessage.toLowerCase().includes('run command')) {
      text = `{"type": "tool_call", "name": "system_shell", "arguments": {"command": "echo hello"}}`;
    } else if (lastUserMessage.toLowerCase().includes('hang safe')) {
      text = `{"type": "tool_call", "name": "hang_safe", "arguments": {}}`;
    } else if (lastUserMessage.toLowerCase().includes('hang unsafe')) {
      text = `{"type": "tool_call", "name": "hang_unsafe", "arguments": {}}`;
    } else if (lastUserMessage.toLowerCase().includes('search') || lastUserMessage.toLowerCase().includes('find')) {
      text = `Search query analyzed: "${lastUserMessage}". Findings indicate relevant data across index nodes.`;
    } else if (lastUserMessage.toLowerCase().includes('help') || lastUserMessage.toLowerCase().includes('hello')) {
      text = `Hello. I am Aira AI, your autonomous operating workspace. How can I assist your objectives today?`;
    } else if (lastUserMessage.toLowerCase().includes('how capable are you')) {
      text = `I am AIRA AI, an autonomous intelligence workspace. This response is powered by ${policy.model}. I support web research, multi-step workflows, agent missions, and persistent memory.`;
    } else if (lastUserMessage.toLowerCase().includes('which model') || lastUserMessage.toLowerCase().includes('which ai model')) {
      text = `This response is powered by ${policy.model} in the AIRA AI workspace.`;
    } else if (lastUserMessage.toLowerCase().includes('are you claude')) {
      if (policy.model.includes('claude')) {
        text = `Yes, this response is generated using Anthropic's Claude model (${policy.model}) within AIRA AI.`;
      } else {
        text = `No, I am not Claude. This response is powered by ${policy.model} within AIRA AI.`;
      }
    } else if (lastUserMessage.toLowerCase().includes('are you powered by nvidia')) {
      if (policy.model.includes('nvidia') || policy.model.includes('nemotron')) {
        text = `Yes, this response is powered by NVIDIA NIM using ${policy.model} within AIRA AI.`;
      } else {
        text = `No, this response is powered by ${policy.model} within AIRA AI.`;
      }
    } else {
      text = `Execution complete. Objective: "${lastUserMessage.slice(0, 100)}". Policy: ${policy.model} (maxTokens: ${policy.maxTokens}).`;
    }

    return {
      text,
      thinking,
      usage: {
        promptTokens: Math.max(12, Math.floor(lastUserMessage.length / 4)),
        completionTokens: Math.max(20, Math.floor(text.length / 4)),
        totalTokens: Math.max(32, Math.floor((lastUserMessage.length + text.length) / 4))
      },
      model: policy.model,
      outboundModel: policy.model
    };
  }

  async stream(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    onChunk: (delta: { text?: string; thinking?: string }) => void,
    options?: { firstTokenTimeoutMs?: number; signal?: AbortSignal }
  ): Promise<ModelCompletionResult> {
    const result = await this.complete(messages, policy, options?.signal);
    if (result.thinking) {
      onChunk({ thinking: result.thinking });
    }
    if (result.text) {
      onChunk({ text: result.text });
    }
    return result;
  }
}

export function resolveAnthropicModel(model: ModelId | string): string {
  switch (model) {
    case 'aira-pro':
    case 'claude-3-5-sonnet-20241022':
      return 'claude-3-5-sonnet-20241022';
    case 'aira-fast':
    case 'claude-3-5-haiku-20241022':
      return 'claude-3-5-haiku-20241022';
    case 'aira-deep':
    case 'claude-3-opus-20240229':
      return 'claude-3-opus-20240229';
    case 'aira-auto':
    case 'claude-3-7-sonnet-20250219':
      return 'claude-3-7-sonnet-20250219';
    case 'claude-3-5-sonnet':
      return 'claude-3-5-sonnet';
    case 'claude-3-5-haiku':
      return 'claude-3-5-haiku';
    case 'claude-3-opus':
      return 'claude-3-opus';
    case 'claude-3-7-sonnet':
      return 'claude-3-7-sonnet';
    default:
      if (typeof model === 'string' && model.startsWith('claude-')) {
        return model;
      }
      if (typeof model === 'string' && model.startsWith('aira-')) {
        return model;
      }
      return 'claude-3-7-sonnet-20250219';
  }
}

export function resolveOpenAIModel(model: ModelId | string): string {
  switch (model) {
    case 'aira-fast':
      return 'gpt-4o-mini';
    case 'aira-pro':
    case 'aira-deep':
    case 'aira-auto':
      return 'gpt-4o';
    default:
      if (typeof model === 'string' && model.startsWith('gpt-')) {
        return model;
      }
      if (typeof model === 'string' && model.startsWith('aira-')) {
        return model;
      }
      return 'gpt-4o';
  }
}

export function resolveNvidiaModel(model: ModelId | string): string {
  // Legacy / retired models migrate to the default active NVIDIA model
  if (model === 'meta/llama-3.1-405b-instruct' || model === 'nvidia/nemotron-3-super-120b-a12b') {
    return process.env.NVIDIA_DEFAULT_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct';
  }
  if (process.env.NVIDIA_FAST_MODEL && model === 'aira-fast') {
    return process.env.NVIDIA_FAST_MODEL;
  }
  if (process.env.NVIDIA_DEEP_MODEL && model === 'aira-deep') {
    return process.env.NVIDIA_DEEP_MODEL;
  }
  if (model === 'aira-fast' || model === 'aira-deep' || model === 'aira-auto' || model === 'aira-pro') {
    return process.env.NVIDIA_DEFAULT_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct';
  }
  // Explicitly selected supported NVIDIA models must be preserved and not overridden by NVIDIA_DEFAULT_MODEL
  if (typeof model === 'string' && (model.startsWith('nvidia/') || model.startsWith('meta/') || model.startsWith('nv-'))) {
    return model;
  }
  if (typeof model === 'string' && model.startsWith('aira-')) {
    return model;
  }
  return process.env.NVIDIA_DEFAULT_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct';
}

export class AnthropicAdapter implements ModelAdapter {
  readonly provider = 'anthropic' as const;
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl = 'https://api.anthropic.com/v1') {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.baseUrl = baseUrl;
  }

  toJSON() {
    return { provider: this.provider };
  }

  async complete(messages: ChatMessageInput[], policy: ModelPolicy, signal?: AbortSignal): Promise<ModelCompletionResult> {
    if (!this.apiKey) {
      throw new Error('Anthropic API key is not configured.');
    }
    const systemMessage = messages.find(m => m.role === 'system')?.content;
    const conversationMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }));

    const outboundModel = resolveAnthropicModel(policy.model);
    if (outboundModel.startsWith('aira-')) {
      throw new Error(`INTERNAL_MODEL_ALIAS_LEAK: Refusing to dispatch internal alias "${outboundModel}" to external provider anthropic.`);
    }
    const response = await fetch(`${this.baseUrl}/messages`, {
      signal,
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: outboundModel,
        max_tokens: policy.maxTokens,
        temperature: policy.temperature,
        system: systemMessage,
        messages: conversationMessages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const text = data.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') || '';
    const thinking = data.content?.find((c: any) => c.type === 'thinking')?.thinking;

    return {
      text,
      thinking,
      usage: {
        promptTokens: data.usage?.input_tokens || 0,
        completionTokens: data.usage?.output_tokens || 0,
        totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
      },
      outboundModel,
      model: typeof data.model === 'string' && data.model.trim().length > 0 ? data.model.trim() : undefined
    };
  }

  async stream(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    onChunk: (delta: { text?: string; thinking?: string }) => void,
    options?: { firstTokenTimeoutMs?: number; signal?: AbortSignal }
  ): Promise<ModelCompletionResult> {
    // Falls back to complete then emits chunks if SSE stream not directly hooked
    const res = await this.complete(messages, policy, options?.signal);
    if (res.thinking) onChunk({ thinking: res.thinking });
    if (res.text) onChunk({ text: res.text });
    return res;
  }
}

export class OpenAIAdapter implements ModelAdapter {
  readonly provider: SupportedProvider;
  private apiKey: string;
  private baseUrl: string;
  private airaModel: ModelId | string;

  public modelName: string;

  constructor(
    apiKey?: string,
    baseUrl = 'https://api.openai.com/v1',
    airaModel: ModelId | string = 'gpt-4o',
    provider?: SupportedProvider
  ) {
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
    this.airaModel = (typeof airaModel === 'string' ? airaModel : '').trim().replace(/^["']|["']$/g, '') || airaModel;
    this.modelName = String(this.airaModel);
    if (provider) {
      this.provider = provider;
    } else if (baseUrl.includes('integrate.api.nvidia.com')) {
      this.provider = 'nvidia';
    } else if (baseUrl.includes('api.groq.com')) {
      this.provider = 'groq';
    } else if (baseUrl.includes('api.cerebras.ai')) {
      this.provider = 'cerebras';
    } else if (baseUrl.includes('api.together.xyz')) {
      this.provider = 'together';
    } else if (baseUrl.includes('api.fireworks.ai')) {
      this.provider = 'fireworks';
    } else {
      this.provider = 'openai';
    }

    const rawKey = apiKey || (
      this.provider === 'groq' ? process.env.GROQ_API_KEY :
      this.provider === 'cerebras' ? process.env.CEREBRAS_API_KEY :
      this.provider === 'together' ? process.env.TOGETHER_API_KEY :
      this.provider === 'fireworks' ? process.env.FIREWORKS_API_KEY :
      this.provider === 'nvidia' ? process.env.NVIDIA_API_KEY :
      process.env.OPENAI_API_KEY
    ) || '';
    this.apiKey = rawKey.trim().replace(/^["']|["']$/g, '');
  }

  toJSON() {
    return { provider: this.provider };
  }

  private resolveOutboundModel(policyModel: string): string {
    let outboundModel: string = policyModel;
    if (outboundModel.startsWith('aira-')) {
      if (this.baseUrl.includes('api.openai.com') || this.provider === 'openai') {
        outboundModel = resolveOpenAIModel(policyModel);
      } else if (this.baseUrl.includes('integrate.api.nvidia.com') || this.provider === 'nvidia') {
        outboundModel = resolveNvidiaModel(policyModel);
      } else if (this.provider === 'groq') {
        outboundModel = (typeof this.airaModel === 'string' && !this.airaModel.startsWith('aira-'))
          ? this.airaModel
          : (process.env.AIRA_FAST_MODEL || 'openai/gpt-oss-120b');
      } else if (typeof this.airaModel === 'string' && !this.airaModel.startsWith('aira-')) {
        outboundModel = this.airaModel;
      }
    }

    // Cross-provider fallback defense: Ensure every provider receives a compatible model identifier from its supported family.
    // NOTE: This performs syntactic provider-family namespace validation (prefix checking) to prevent
    // foreign model cross-contamination during fallback; it does not verify live upstream model availability or entitlements.
    if (this.provider === 'groq') {
      const isGroqModel = outboundModel.startsWith('openai/gpt-oss-') ||
                          outboundModel.startsWith('llama-') ||
                          outboundModel.startsWith('qwen/') ||
                          outboundModel.startsWith('allam-');
      if (!isGroqModel) {
        outboundModel = (typeof this.airaModel === 'string' && !this.airaModel.startsWith('aira-'))
          ? this.airaModel
          : (process.env.AIRA_FAST_MODEL || 'openai/gpt-oss-120b');
      }
    } else if (this.provider === 'nvidia') {
      const isNvidiaModel = outboundModel.startsWith('nvidia/') ||
                            outboundModel.startsWith('meta/') ||
                            outboundModel.startsWith('nv-');
      if (!isNvidiaModel) {
        outboundModel = (typeof this.airaModel === 'string' && !this.airaModel.startsWith('aira-'))
          ? this.airaModel
          : resolveNvidiaModel(policyModel);
      }
    } else if (this.provider === 'openai') {
      const isOpenAIModel = outboundModel.startsWith('gpt-') ||
                            outboundModel.startsWith('o1') ||
                            outboundModel.startsWith('o3');
      if (!isOpenAIModel) {
        outboundModel = (typeof this.airaModel === 'string' && !this.airaModel.startsWith('aira-'))
          ? this.airaModel
          : resolveOpenAIModel(policyModel);
      }
    } else if (this.provider === 'cerebras') {
      if (!outboundModel.startsWith('llama3.1-')) {
        outboundModel = (typeof this.airaModel === 'string' && !this.airaModel.startsWith('aira-'))
          ? this.airaModel
          : 'llama3.1-8b';
      }
    } else if (this.provider === 'together') {
      if (!outboundModel.startsWith('meta-llama/')) {
        outboundModel = (typeof this.airaModel === 'string' && !this.airaModel.startsWith('aira-'))
          ? this.airaModel
          : 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo';
      }
    } else if (this.provider === 'fireworks') {
      if (!outboundModel.startsWith('accounts/fireworks/')) {
        outboundModel = (typeof this.airaModel === 'string' && !this.airaModel.startsWith('aira-'))
          ? this.airaModel
          : 'accounts/fireworks/models/llama-v3p1-8b-instruct';
      }
    }

    if (outboundModel.startsWith('aira-')) {
      throw new Error(`INTERNAL_MODEL_ALIAS_LEAK: Refusing to dispatch internal alias "${outboundModel}" to external provider "${this.provider}".`);
    }

    return outboundModel;
  }

  async complete(messages: ChatMessageInput[], policy: ModelPolicy, signal?: AbortSignal): Promise<ModelCompletionResult> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key is not configured.');
    }
    const maxRetries = 2;
    let lastError: Error | null = null;

    const outboundModel = this.resolveOutboundModel(policy.model);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      signal?.throwIfAborted();
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          signal,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: outboundModel,
            messages: messages.map(m => {
              if (m.role === 'tool') {
                return { role: 'tool', content: m.content, tool_call_id: m.toolCallId || 'call_default' };
              }
              return { role: m.role, content: m.content };
            }),
            max_tokens: policy.maxTokens,
            temperature: policy.temperature
          })
        });

        if (!response.ok) {
          const errText = await response.text();
          if ((response.status >= 500 || response.status === 429) && attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          if (response.status === 404 && this.baseUrl.includes('integrate.api.nvidia.com')) {
            const err404: any = new Error(
              `NVIDIA NIM returned 404 for model "${policy.model}". ` +
              'The model may be unavailable or inaccessible with this API key. ' +
              'Select a supported model in Aira.'
            );
            err404.status = 404;
            err404.statusCode = 404;
            throw err404;
          }
          const provider = this.provider === 'nvidia' ? 'NVIDIA NIM' : this.provider.toUpperCase();
          const apiErr: any = new Error(`${provider} API error (${response.status}): ${errText}`);
          apiErr.status = response.status;
          apiErr.statusCode = response.status;
          throw apiErr;
        }

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || '';

        return {
          text,
          usage: {
            promptTokens: data.usage?.prompt_tokens || 0,
            completionTokens: data.usage?.completion_tokens || 0,
            totalTokens: data.usage?.total_tokens || 0
          },
          outboundModel,
          model: typeof data.model === 'string' && data.model.trim().length > 0 ? data.model.trim() : undefined
        };
      } catch (err: any) {
        signal?.throwIfAborted();
        lastError = err;
        if (attempt < maxRetries && (err.message.includes('500') || err.message.includes('429') || err.message.includes('fetch failed'))) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error('Provider request failed after retries.');
  }

  async stream(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    onChunk: (delta: { text?: string; thinking?: string }) => void,
    options?: { firstTokenTimeoutMs?: number; signal?: AbortSignal }
  ): Promise<ModelCompletionResult> {
    const outboundModel = this.resolveOutboundModel(policy.model);

    // First-token deadline timer (commercially reasonable deadline: e.g. 3000ms for fast normal chat)
    const firstTokenTimeoutMs = options?.firstTokenTimeoutMs ?? (policy.model === 'aira-fast' ? 3000 : 0);
    const abortController = new AbortController();
    if (options?.signal) {
      options.signal.addEventListener('abort', () => abortController.abort(options.signal?.reason), { once: true });
    }

    let firstTokenTimer: NodeJS.Timeout | null = null;
    let receivedFirstToken = false;

    if (firstTokenTimeoutMs > 0) {
      firstTokenTimer = setTimeout(() => {
        if (!receivedFirstToken) {
          abortController.abort(
            new Error(`FIRST_TOKEN_TIMEOUT: Fast route first-token deadline (${firstTokenTimeoutMs}ms) exceeded for provider ${this.provider}`)
          );
        }
      }, firstTokenTimeoutMs);
    }

    try {
      // Stream the upstream response rather than waiting for a full completion before
      // forwarding one giant delta. This also exposes the actual upstream model ID.
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        signal: abortController.signal,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        body: JSON.stringify({
          model: outboundModel,
          messages: messages.map(m => m.role === 'tool'
            ? { role: 'tool', content: m.content, tool_call_id: m.toolCallId || 'call_default' }
            : { role: m.role, content: m.content }),
          max_tokens: policy.maxTokens,
          temperature: policy.temperature,
          stream: true,
          stream_options: { include_usage: true }
        })
      });

      if (!response.ok) {
        let errSnippet = '';
        try {
          const errData = await response.json();
          errSnippet = errData?.error?.message || errData?.message || JSON.stringify(errData);
        } catch {
          try {
            errSnippet = (await response.text()).slice(0, 200);
          } catch {}
        }
        await response.body?.cancel().catch(() => undefined);
        const detail = errSnippet ? `: ${errSnippet}` : '';
        const streamErr: any = new Error(`${this.provider} streaming request failed (HTTP ${response.status})${detail}`);
        streamErr.status = response.status;
        streamErr.statusCode = response.status;
        throw streamErr;
      }
      if (!response.body) throw new Error('Provider returned an empty streaming response body.');

      const reader = response.body.getReader();
      const onAbort = () => {
        reader.cancel(abortController.signal.reason).catch(() => undefined);
      };
      if (abortController.signal.aborted) {
        onAbort();
      } else {
        abortController.signal.addEventListener('abort', onAbort, { once: true });
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let output = '';
      let upstreamModel: string | undefined;
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let finished = false;

      const handleFrame = (frame: string) => {
        const dataString = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (!dataString) return;
        if (dataString === '[DONE]') { finished = true; return; }
        const event = JSON.parse(dataString);
        if (event.error) throw new Error('Provider reported a streaming inference error.');
        if (typeof event.model === 'string' && event.model.trim()) upstreamModel = event.model.trim();
        const delta = event.choices?.[0]?.delta;
        if (typeof delta?.content === 'string' && delta.content.length) {
          if (!receivedFirstToken) {
            receivedFirstToken = true;
            if (firstTokenTimer) {
              clearTimeout(firstTokenTimer);
              firstTokenTimer = null;
            }
          }
          output += delta.content;
          onChunk({ text: delta.content });
        }
        if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length) {
          onChunk({ thinking: delta.reasoning_content });
        }
        if (event.usage) usage = {
          promptTokens: event.usage.prompt_tokens || 0,
          completionTokens: event.usage.completion_tokens || 0,
          totalTokens: event.usage.total_tokens || 0
        };
      };

      try {
        while (!finished) {
          abortController.signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          // Normalize line endings only after bytes are accumulated: a CRLF pair
          // can itself be split between two network reads.
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          let separator: number;
          while ((separator = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            handleFrame(frame);
            if (finished) break;
          }
        }
        abortController.signal.throwIfAborted();
        buffer += decoder.decode();
        if (!finished && buffer.trim()) handleFrame(buffer);
      } finally {
        abortController.signal.removeEventListener('abort', onAbort);
        reader.releaseLock();
      }
      if (!finished) throw new Error('Provider stream closed before its terminal event.');
      if (!output.trim()) throw new Error('Provider completed without generating visible answer text.');
      return { text: output, usage, outboundModel, model: upstreamModel };
    } finally {
      if (firstTokenTimer) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = null;
      }
    }
  }
}

export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';
  readonly status = 503;

  constructor(message = 'No paid inference provider is configured in this deployment.') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export interface ResolvedExecution {
  policy: ModelPolicy;
  adapter: ModelAdapter;
  provider: SupportedProvider;
  requestedProvider?: string;
  executedProvider?: string;
  executedModel: string;
  plannedModel: string;
  fallbackOccurred: boolean;
  fallbackReason?: string;
  verified: boolean;
}

export class ModelRouter {
  private adapters: Map<string, ModelAdapter> = new Map();
  public readonly healthTracker: ProviderHealthTracker;
  public readonly routingPolicy: LatencyAwareRoutingPolicy;
  public readonly capacityGuard: PrivateBetaCapacityGuard;

  constructor(healthTracker?: ProviderHealthTracker, capacityGuard?: PrivateBetaCapacityGuard) {
    this.healthTracker = healthTracker || new ProviderHealthTracker();
    this.routingPolicy = new LatencyAwareRoutingPolicy(this.healthTracker);
    this.capacityGuard = capacityGuard || new PrivateBetaCapacityGuard(undefined, undefined, this.healthTracker);

    // DeterministicMockAdapter is ONLY registered in test/dev environments.
    // Production code must never reach this adapter through the normal router.
    // It is accessible only when model is explicitly 'mock-deterministic'.
    if (process.env.NODE_ENV !== 'production') {
      this.adapters.set('mock', new DeterministicMockAdapter());
    }
    if (process.env.GROQ_API_KEY) {
      const groqKey = process.env.GROQ_API_KEY.trim().replace(/^["']|["']$/g, '');
      const groqModel = (process.env.AIRA_FAST_MODEL || '').trim().replace(/^["']|["']$/g, '') || 'openai/gpt-oss-120b';
      this.adapters.set(
        'groq',
        new OpenAIAdapter(
          groqKey,
          'https://api.groq.com/openai/v1',
          groqModel,
          'groq'
        )
      );
    }
    if (process.env.CEREBRAS_API_KEY) {
      this.adapters.set(
        'cerebras',
        new OpenAIAdapter(
          process.env.CEREBRAS_API_KEY,
          'https://api.cerebras.ai/v1',
          process.env.AIRA_FAST_MODEL || 'llama3.1-8b',
          'cerebras'
        )
      );
    }
    if (process.env.TOGETHER_API_KEY) {
      this.adapters.set(
        'together',
        new OpenAIAdapter(
          process.env.TOGETHER_API_KEY,
          'https://api.together.xyz/v1',
          process.env.AIRA_FAST_MODEL || 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
          'together'
        )
      );
    }
    if (process.env.FIREWORKS_API_KEY) {
      this.adapters.set(
        'fireworks',
        new OpenAIAdapter(
          process.env.FIREWORKS_API_KEY,
          'https://api.fireworks.ai/inference/v1',
          process.env.AIRA_FAST_MODEL || 'accounts/fireworks/models/llama-v3p1-8b-instruct',
          'fireworks'
        )
      );
    }
    if (process.env.GEMINI_API_KEY) {
      const geminiKey = process.env.GEMINI_API_KEY.trim().replace(/^["']|["']$/g, '');
      const geminiModel = (process.env.AIRA_GEMINI_MODEL || '').trim().replace(/^["']|["']$/g, '') || 'gemini-3.5-flash-lite';
      this.adapters.set(
        'gemini',
        new GeminiAdapter(
          geminiKey,
          geminiModel
        )
      );
    }
    if (process.env.ANTHROPIC_API_KEY) {
      this.adapters.set('anthropic', new AnthropicAdapter());
    }
    if (process.env.OPENAI_API_KEY) {
      this.adapters.set('openai', new OpenAIAdapter());
    }
    if (process.env.NVIDIA_API_KEY) {
      this.adapters.set(
        'nvidia',
        new OpenAIAdapter(
          process.env.NVIDIA_API_KEY,
          'https://integrate.api.nvidia.com/v1',
          'nvidia/llama-3.1-nemotron-70b-instruct',
          'nvidia'
        )
      );
    }
  }

  public createModelSpecificAdapter(provider: SupportedProvider, model: string): ModelAdapter & { modelName?: string } {
    if (provider === 'groq' && process.env.GROQ_API_KEY) {
      const groqKey = process.env.GROQ_API_KEY.trim().replace(/^["']|["']$/g, '');
      const adapter = new OpenAIAdapter(groqKey, 'https://api.groq.com/openai/v1', model, 'groq');
      (adapter as any).modelName = model;
      return adapter;
    }
    if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
      const geminiKey = process.env.GEMINI_API_KEY.trim().replace(/^["']|["']$/g, '');
      const adapter = new GeminiAdapter(geminiKey, model);
      (adapter as any).modelName = model;
      return adapter;
    }
    if (provider === 'cerebras' && process.env.CEREBRAS_API_KEY) {
      const adapter = new OpenAIAdapter(process.env.CEREBRAS_API_KEY, 'https://api.cerebras.ai/v1', model, 'cerebras');
      (adapter as any).modelName = model;
      return adapter;
    }
    if (provider === 'together' && process.env.TOGETHER_API_KEY) {
      const adapter = new OpenAIAdapter(process.env.TOGETHER_API_KEY, 'https://api.together.xyz/v1', model, 'together');
      (adapter as any).modelName = model;
      return adapter;
    }
    if (provider === 'fireworks' && process.env.FIREWORKS_API_KEY) {
      const adapter = new OpenAIAdapter(process.env.FIREWORKS_API_KEY, 'https://api.fireworks.ai/inference/v1', model, 'fireworks');
      (adapter as any).modelName = model;
      return adapter;
    }
    if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      const adapter = new OpenAIAdapter(process.env.OPENAI_API_KEY, 'https://api.openai.com/v1', model, 'openai');
      (adapter as any).modelName = model;
      return adapter;
    }
    if (provider === 'nvidia' && process.env.NVIDIA_API_KEY) {
      const adapter = new OpenAIAdapter(process.env.NVIDIA_API_KEY, 'https://integrate.api.nvidia.com/v1', model, 'nvidia');
      (adapter as any).modelName = model;
      return adapter;
    }
    const existing = this.adapters.get(provider);
    if (existing) {
      (existing as any).modelName = model;
      return existing;
    }
    throw new Error(`Provider ${provider} is not configured.`);
  }

  public resolvePolicy(modelId: ModelId, intent?: IntentTaxonomy): ModelPolicy {
    let resolvedModel = normalizeModelIdentifier(modelId);

    if (resolvedModel === 'aira-auto') {
      switch (intent) {
        case 'RESEARCH':
        case 'AGENT_MISSION':
          resolvedModel = 'aira-deep';
          break;
        case 'TOOL_ACTION':
        case 'WORKFLOW':
          resolvedModel = 'aira-pro';
          break;
        case 'ANSWER':
        case 'AUTOMATION_CREATE':
        default:
          resolvedModel = 'aira-fast';
          break;
      }
    }

    const extendedThinking = resolvedModel === 'aira-deep';
    const maxTokens = extendedThinking ? 8192 : 4096;
    const reasoningBudget = extendedThinking ? 2048 : undefined;

    return ModelPolicySchema.parse({
      model: resolvedModel,
      maxTokens,
      temperature: extendedThinking ? 1.0 : 0.7,
      extendedThinking,
      reasoningBudget,
      timeoutMs: 60000
    });
  }

  public resolveExecution(requestedModelId: ModelId, intent?: IntentTaxonomy): ResolvedExecution {
    const execution = this.resolveUnprotectedExecution(requestedModelId, intent);
    return { ...execution, adapter: protectInferenceAdapter(execution.adapter, this.capacityGuard) };
  }

  private resolveUnprotectedExecution(requestedModelId: ModelId, intent?: IntentTaxonomy): ResolvedExecution {
    const policy = this.resolvePolicy(requestedModelId, intent);
    const model = policy.model;

    // Test/dev only: explicit injection via model name
    if (model === 'mock-deterministic') {
      const mock = this.adapters.get('mock');
      if (!mock) {
        throw new Error(
          'CONFIGURATION_ERROR: DeterministicMockAdapter is not available in production mode. ' +
          'Test adapters are only registered outside production mode.'
        );
      }
      return {
        policy,
        adapter: mock,
        provider: 'mock',
        requestedProvider: 'mock',
        executedProvider: 'mock',
        executedModel: 'mock-deterministic',
        plannedModel: 'mock-deterministic',
        fallbackOccurred: false,
        verified: true
      };
    }

    if (this.listProviders().length === 0) {
      throw new ProviderUnavailableError();
    }

    if (model.startsWith('aira-')) {
      if (model === 'aira-fast') {
        const configuredProviders = this.listProviders();
        const configuredFastProvider = (process.env.AIRA_FAST_PROVIDER || '').toLowerCase().trim();
        const configuredFastModel = (process.env.AIRA_FAST_MODEL || '').trim();
        const hasDedicatedNvidiaFastModel = Boolean(process.env.NVIDIA_FAST_MODEL?.trim());
        const nvidiaFastModel = process.env.NVIDIA_FAST_MODEL?.trim();
        const enableHedging = process.env.AIRA_ENABLE_HEDGING === 'true';

        const plan = this.routingPolicy.selectFastExecutionPlan({
          configuredProviders,
          preferredProvider: configuredFastProvider,
          preferredModel: configuredFastModel,
          hasDedicatedNvidiaFastModel,
          nvidiaFastModel,
          enableHedging
        });

        // 1. If only NVIDIA is available and no dedicated fast provider is configured in environment
        const hasFastProvider = configuredProviders.some(p => p !== 'nvidia' && p !== 'mock');
        if (!hasFastProvider && this.adapters.has('nvidia')) {
          const executedModel = resolveNvidiaModel(model);
          const hasDedicated = Boolean(process.env.NVIDIA_FAST_MODEL?.trim());
          return {
            policy,
            adapter: this.adapters.get('nvidia')!,
            provider: 'nvidia',
            requestedProvider: hasDedicated ? 'nvidia' : 'groq',
            executedProvider: 'nvidia',
            executedModel,
            plannedModel: executedModel,
            fallbackOccurred: !hasDedicated,
            fallbackReason: !hasDedicated ? 'No dedicated fast provider configured; fell back to NVIDIA Nemotron 70B reasoning model' : undefined,
            verified: true
          };
        }

        // 2. If test mock adapter is available
        if (plan.isDegraded && this.adapters.has('mock')) {
          return {
            policy,
            adapter: this.adapters.get('mock')!,
            provider: 'mock',
            requestedProvider: 'mock',
            executedProvider: 'mock',
            executedModel: 'mock-deterministic',
            plannedModel: 'mock-deterministic',
            fallbackOccurred: false,
            verified: true
          };
        }

        // 3. If no provider is available
        if (plan.isDegraded) {
          throw new ProviderUnavailableError(
            `No paid inference provider is configured for Aira mode "${model}" in this deployment.`
          );
        }

        const primaryAdapter = this.createModelSpecificAdapter(plan.primary.provider as SupportedProvider, plan.primary.model);
        const fallbackAdapter = plan.fallback
          ? this.createModelSpecificAdapter(plan.fallback.provider as SupportedProvider, plan.fallback.model)
          : null;

        // Bounded tertiary adapter for non-account-level Groq failures (Section 8 & 9)
        const tertiaryAdapter = (plan.fallback?.provider === 'gemini' && process.env.GROQ_API_KEY && plan.primary.provider === 'groq')
          ? this.createModelSpecificAdapter('groq', 'allam-2-7b')
          : null;

        const resilientAdapter = new ResilientModelAdapter(
          primaryAdapter,
          fallbackAdapter,
          this.healthTracker,
          {
            firstTokenTimeoutMs: 2500,
            fallbackFirstTokenTimeoutMs: 4000,
            tertiaryAdapter,
            enableHedging,
            hedgeDelayMs: process.env.AIRA_HEDGE_DELAY_MS ? parseInt(process.env.AIRA_HEDGE_DELAY_MS, 10) : 1200
          }
        );

        const isFallback = Boolean(plan.selectionReason.includes('FAILOVER'));

        return {
          policy,
          adapter: resilientAdapter,
          provider: plan.primary.provider as SupportedProvider,
          requestedProvider: configuredFastProvider || 'groq',
          executedProvider: plan.primary.provider,
          executedModel: plan.primary.model,
          plannedModel: plan.primary.model,
          fallbackOccurred: isFallback,
          fallbackReason: isFallback ? plan.selectionReason : undefined,
          verified: plan.primary.provider !== 'mock'
        };
      }

      let providerPreference: Array<SupportedProvider>;
      if (model === 'aira-deep') {
        providerPreference = ['anthropic', 'nvidia', 'openai', 'groq', 'gemini'];
      } else {
        providerPreference = ['anthropic', 'nvidia', 'openai', 'groq', 'gemini'];
      }

      const preferredProvider = providerPreference[0];
      let selectedProvider: SupportedProvider | null = null;
      let selectedAdapter: ModelAdapter | null = null;

      for (const prov of providerPreference) {
        const adapter = this.adapters.get(prov);
        if (adapter) {
          selectedProvider = prov;
          selectedAdapter = adapter;
          break;
        }
      }

      if (!selectedAdapter && this.adapters.has('mock')) {
        selectedProvider = 'mock';
        selectedAdapter = this.adapters.get('mock')!;
      }

      if (!selectedAdapter || !selectedProvider) {
        throw new ProviderUnavailableError(
          `No paid inference provider is configured for Aira mode "${model}" in this deployment.`
        );
      }

      const fallbackOccurred = selectedProvider !== preferredProvider;
      let fallbackReason: string | undefined;
      if (fallbackOccurred) {
        const formatName = (p: string) => {
          if (p === 'nvidia') return 'NVIDIA NIM';
          if (p === 'groq') return 'Groq';
          if (p === 'gemini') return 'Gemini';
          if (p === 'cerebras') return 'Cerebras';
          if (p === 'together') return 'Together AI';
          if (p === 'fireworks') return 'Fireworks AI';
          if (p === 'anthropic') return 'Anthropic';
          if (p === 'openai') return 'OpenAI';
          return p;
        };
        fallbackReason = `Preferred provider (${formatName(preferredProvider)}) not configured; routed to ${formatName(selectedProvider)}`;
      }

      let executedModel: string;
      let modelFallback = false;
      let modelFallbackReason: string | undefined;

      if (selectedProvider === 'groq') {
        const raw = (process.env.AIRA_FAST_MODEL || '').trim().replace(/^["']|["']$/g, '');
        executedModel = raw || 'openai/gpt-oss-120b';
      } else if (selectedProvider === 'gemini') {
        executedModel = (process.env.AIRA_GEMINI_MODEL || '').trim().replace(/^["']|["']$/g, '') || 'gemini-3.5-flash-lite';
      } else if (selectedProvider === 'cerebras') {
        executedModel = process.env.AIRA_FAST_MODEL || 'llama3.1-8b';
      } else if (selectedProvider === 'together') {
        executedModel = process.env.AIRA_FAST_MODEL || 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo';
      } else if (selectedProvider === 'fireworks') {
        executedModel = process.env.AIRA_FAST_MODEL || 'accounts/fireworks/models/llama-v3p1-8b-instruct';
      } else if (selectedProvider === 'openai') {
        executedModel = (model as string) === 'aira-fast'
          ? (process.env.AIRA_FAST_MODEL || 'gpt-4o-mini')
          : 'gpt-4o';
      } else if (selectedProvider === 'nvidia') {
        executedModel = resolveNvidiaModel(model);
        if ((model as string) === 'aira-fast' && !process.env.NVIDIA_FAST_MODEL && executedModel === 'nvidia/llama-3.1-nemotron-70b-instruct') {
          modelFallback = true;
          modelFallbackReason = 'No dedicated fast provider configured; fell back to NVIDIA Nemotron 70B reasoning model';
        }
      } else if (selectedProvider === 'anthropic') {
        if (requestedModelId === 'claude-3-5-sonnet') {
          executedModel = 'claude-3-5-sonnet';
        } else if (requestedModelId === 'claude-3-5-haiku') {
          executedModel = 'claude-3-5-haiku';
        } else if (requestedModelId === 'claude-3-opus') {
          executedModel = 'claude-3-opus';
        } else if (requestedModelId === 'claude-3-7-sonnet') {
          executedModel = 'claude-3-7-sonnet';
        } else {
          executedModel = resolveAnthropicModel(model);
        }
      } else {
        executedModel = model;
      }

      const combinedFallback = fallbackOccurred || modelFallback;
      let combinedReason: string | undefined;
      if (fallbackOccurred && modelFallbackReason) {
        combinedReason = `${fallbackReason}; ${modelFallbackReason}`;
      } else if (fallbackOccurred) {
        combinedReason = fallbackReason;
      } else if (modelFallback) {
        combinedReason = modelFallbackReason;
      }

      let effectiveAdapter = selectedAdapter;
      if (selectedProvider === 'nvidia') {
        const fallbackAdapter = this.adapters.has('groq')
          ? this.createModelSpecificAdapter('groq', 'openai/gpt-oss-120b')
          : (this.adapters.has('gemini')
            ? this.createModelSpecificAdapter('gemini', 'gemini-3.5-flash-lite')
            : (this.adapters.has('anthropic')
              ? this.createModelSpecificAdapter('anthropic', 'claude-3-5-haiku')
              : null));
        const tertiaryAdapter = (fallbackAdapter && fallbackAdapter.provider === 'groq')
          ? (this.adapters.has('gemini')
            ? this.createModelSpecificAdapter('gemini', 'gemini-3.5-flash-lite')
            : (this.adapters.has('anthropic')
              ? this.createModelSpecificAdapter('anthropic', 'claude-3-5-haiku')
              : null))
          : null;

        if (fallbackAdapter && !this.healthTracker.isAvailable('nvidia', executedModel)) {
          return {
            policy,
            adapter: fallbackAdapter,
            provider: fallbackAdapter.provider,
            requestedProvider: preferredProvider,
            executedProvider: fallbackAdapter.provider,
            executedModel: fallbackAdapter.modelName || 'openai/gpt-oss-120b',
            plannedModel: executedModel,
            fallbackOccurred: true,
            fallbackReason: `Circuit breaker is OPEN for NVIDIA model "${executedModel}" due to upstream error (404/503/timeout); routed directly to ${fallbackAdapter.provider}`,
            verified: fallbackAdapter.provider !== 'mock'
          };
        }

        if (fallbackAdapter) {
          effectiveAdapter = new ResilientModelAdapter(selectedAdapter, fallbackAdapter, this.healthTracker, {
            firstTokenTimeoutMs: 3500,
            fallbackFirstTokenTimeoutMs: 4000,
            tertiaryAdapter
          });
        }
      }

      return {
        policy,
        adapter: effectiveAdapter,
        provider: selectedProvider,
        requestedProvider: preferredProvider,
        executedProvider: selectedProvider,
        executedModel,
        plannedModel: executedModel,
        fallbackOccurred: combinedFallback,
        fallbackReason: combinedReason,
        verified: selectedProvider !== 'mock'
      };
    }

    if (model.startsWith('claude')) {
      if (this.adapters.has('anthropic')) {
        const planned = requestedModelId === 'claude-3-5-sonnet' ? 'claude-3-5-sonnet' : (requestedModelId === 'claude-3-5-haiku' ? 'claude-3-5-haiku' : (requestedModelId === 'claude-3-opus' ? 'claude-3-opus' : (requestedModelId === 'claude-3-7-sonnet' ? 'claude-3-7-sonnet' : model)));
        return {
          policy,
          adapter: this.adapters.get('anthropic')!,
          provider: 'anthropic',
          requestedProvider: 'anthropic',
          executedProvider: 'anthropic',
          executedModel: planned,
          plannedModel: planned,
          fallbackOccurred: false,
          verified: true
        };
      }
      throw new Error(
        `CONFIGURATION_ERROR: No Anthropic API key configured for model "${model}". ` +
        'Set ANTHROPIC_API_KEY in environment.'
      );
    }

    if (model === 'gemini-2-5-pro' || model === 'gemini-3.5-flash-lite') {
      const executedModel = model === 'gemini-2-5-pro' ? 'gemini-2.5-pro' : 'gemini-3.5-flash-lite';
      if (!this.adapters.has('gemini')) throw new Error('CONFIGURATION_ERROR: Gemini provider is not configured.');
      return {
        policy,
        adapter: this.createModelSpecificAdapter('gemini', executedModel),
        provider: 'gemini', requestedProvider: 'gemini', executedProvider: 'gemini',
        executedModel, plannedModel: executedModel, fallbackOccurred: false, verified: true
      };
    }

    if (model.startsWith('gpt')) {
      if (this.adapters.has('openai')) {
        return {
          policy,
          adapter: this.adapters.get('openai')!,
          provider: 'openai',
          requestedProvider: 'openai',
          executedProvider: 'openai',
          executedModel: model,
          plannedModel: model,
          fallbackOccurred: false,
          verified: true
        };
      }
      throw new Error(
        `CONFIGURATION_ERROR: No OpenAI API key configured for model "${model}". ` +
        'Set OPENAI_API_KEY in environment.'
      );
    }

    if (
      model.startsWith('llama-3.1-') ||
      model.startsWith('llama-3.3-') ||
      model.startsWith('openai/gpt-oss-') ||
      model.startsWith('qwen/') ||
      model.startsWith('allam-')
    ) {
      if (this.adapters.has('groq')) {
        return {
          policy,
          adapter: this.adapters.get('groq')!,
          provider: 'groq',
          requestedProvider: 'groq',
          executedProvider: 'groq',
          executedModel: model,
          plannedModel: model,
          fallbackOccurred: false,
          verified: true
        };
      }
    }

    if (model.startsWith('llama3.1-')) {
      if (this.adapters.has('cerebras')) {
        return {
          policy,
          adapter: this.adapters.get('cerebras')!,
          provider: 'cerebras',
          requestedProvider: 'cerebras',
          executedProvider: 'cerebras',
          executedModel: model,
          plannedModel: model,
          fallbackOccurred: false,
          verified: true
        };
      }
    }

    if (model.startsWith('accounts/fireworks')) {
      if (this.adapters.has('fireworks')) {
        return {
          policy,
          adapter: this.adapters.get('fireworks')!,
          provider: 'fireworks',
          requestedProvider: 'fireworks',
          executedProvider: 'fireworks',
          executedModel: model,
          plannedModel: model,
          fallbackOccurred: false,
          verified: true
        };
      }
    }

    if (model.startsWith('meta/') || model.startsWith('nvidia/') || model.startsWith('nv-')) {
      if (this.adapters.has('nvidia')) {
        const isLegacyModel = requestedModelId === 'meta/llama-3.1-405b-instruct' || requestedModelId === 'nvidia/nemotron-3-super-120b-a12b';
        const targetModel = isLegacyModel ? 'nvidia/llama-3.1-nemotron-70b-instruct' : model;
        const primaryAdapter = this.createModelSpecificAdapter('nvidia', targetModel);
        const fallbackAdapter = this.adapters.has('groq')
          ? this.createModelSpecificAdapter('groq', 'openai/gpt-oss-120b')
          : (this.adapters.has('gemini')
            ? this.createModelSpecificAdapter('gemini', 'gemini-3.5-flash-lite')
            : (this.adapters.has('anthropic')
              ? this.createModelSpecificAdapter('anthropic', 'claude-3-5-haiku')
              : null));
        const tertiaryAdapter = (fallbackAdapter && fallbackAdapter.provider === 'groq')
          ? (this.adapters.has('gemini')
            ? this.createModelSpecificAdapter('gemini', 'gemini-3.5-flash-lite')
            : (this.adapters.has('anthropic')
              ? this.createModelSpecificAdapter('anthropic', 'claude-3-5-haiku')
              : null))
          : null;

        if (fallbackAdapter && !this.healthTracker.isAvailable('nvidia', targetModel)) {
          return {
            policy,
            adapter: fallbackAdapter,
            provider: fallbackAdapter.provider,
            requestedProvider: 'nvidia',
            executedProvider: fallbackAdapter.provider,
            executedModel: fallbackAdapter.modelName || 'openai/gpt-oss-120b',
            plannedModel: targetModel,
            fallbackOccurred: true,
            fallbackReason: `Circuit breaker is OPEN for NVIDIA model "${targetModel}"; routed directly to ${fallbackAdapter.provider}`,
            verified: true
          };
        }

        const resilientAdapter = fallbackAdapter
          ? new ResilientModelAdapter(primaryAdapter, fallbackAdapter, this.healthTracker, {
              firstTokenTimeoutMs: 3500,
              fallbackFirstTokenTimeoutMs: 4000,
              tertiaryAdapter
            })
          : primaryAdapter;

        return {
          policy,
          adapter: resilientAdapter,
          provider: 'nvidia',
          requestedProvider: 'nvidia',
          executedProvider: 'nvidia',
          executedModel: targetModel,
          plannedModel: targetModel,
          fallbackOccurred: isLegacyModel,
          fallbackReason: isLegacyModel ? 'Deprecated/retired model migrated to NVIDIA Nemotron 70B' : undefined,
          verified: true
        };
      }
      throw new Error(
        `CONFIGURATION_ERROR: No NVIDIA API key configured for model "${model}". ` +
        'Set NVIDIA_API_KEY in environment.'
      );
    }

    throw new Error(
      `CONFIGURATION_ERROR: Unknown model "${model}" — no adapter configured. ` +
      'Provide a valid model ID or set the appropriate provider API key.'
    );
  }

  public getAdapter(policy: ModelPolicy): ModelAdapter {
    return this.resolveExecution(policy?.model || 'aira-auto').adapter;
  }

  /** Returns a list of configured provider names (for health/diagnostics). */
  public listProviders(): string[] {
    return Array.from(this.adapters.keys()).filter(k => k !== 'mock');
  }
}

export * from './health-tracker.js';
export * from './routing-policy.js';
export * from './resilient-adapter.js';
export * from './gemini-adapter.js';
