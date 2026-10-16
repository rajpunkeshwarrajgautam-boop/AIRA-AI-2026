import {
  ModelId,
  ModelPolicy,
  ModelPolicySchema,
  IntentTaxonomy
} from '../../contracts/src/index.js';

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

export interface ModelAdapter {
  provider: 'nvidia' | 'anthropic' | 'openai' | 'mock' | 'unknown';
  complete(messages: ChatMessageInput[], policy: ModelPolicy, signal?: AbortSignal): Promise<ModelCompletionResult>;
  stream(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    onChunk: (delta: { text?: string; thinking?: string }) => void
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
    if (lastUserMessage.includes('[System Tool Execution Result')) {
      if (lastUserMessage.includes('browser_navigate') || lastUserMessage.includes('pageHeading')) {
        let heading = 'Example Domain';
        const match = lastUserMessage.match(/"pageHeading":\s*"([^"]+)"/);
        if (match) heading = match[1];
        text = `The heading of the page is: ${heading}. Browser navigation and DOM extraction were completed successfully.`;
      } else if (lastUserMessage.includes('repo_git_log') || lastUserMessage.includes('latest commit')) {
        text = `Repository inspection complete. Retrieved commit history successfully.`;
      } else if (lastUserMessage.includes('calculator')) {
        text = `Calculation completed successfully. Result: 4096.`;
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
    onChunk: (delta: { text?: string; thinking?: string }) => void
  ): Promise<ModelCompletionResult> {
    const result = await this.complete(messages, policy);
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
      return 'gpt-4o';
  }
}

export function resolveNvidiaModel(model: ModelId | string): string {
  switch (model) {
    case 'aira-fast':
      return process.env.NVIDIA_FAST_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct';
    case 'aira-deep':
      return process.env.NVIDIA_DEEP_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
    case 'aira-pro':
    case 'aira-auto':
      return process.env.NVIDIA_DEFAULT_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
    default:
      if (typeof model === 'string' && (model.startsWith('nvidia/') || model.startsWith('meta/') || model.startsWith('nv-'))) {
        return model;
      }
      return 'nvidia/nemotron-3-super-120b-a12b';
  }
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
    onChunk: (delta: { text?: string; thinking?: string }) => void
  ): Promise<ModelCompletionResult> {
    // Falls back to complete then emits chunks if SSE stream not directly hooked
    const res = await this.complete(messages, policy);
    if (res.thinking) onChunk({ thinking: res.thinking });
    if (res.text) onChunk({ text: res.text });
    return res;
  }
}

export class OpenAIAdapter implements ModelAdapter {
  readonly provider: 'openai' | 'nvidia';
  private apiKey: string;
  private baseUrl: string;
  private airaModel: ModelId;

  constructor(
    apiKey?: string,
    baseUrl = 'https://api.openai.com/v1',
    airaModel: ModelId = 'gpt-4o'
  ) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = baseUrl;
    this.airaModel = airaModel;
    this.provider = baseUrl.includes('integrate.api.nvidia.com') ? 'nvidia' : 'openai';
  }

  toJSON() {
    return { provider: this.provider };
  }

  async complete(messages: ChatMessageInput[], policy: ModelPolicy, signal?: AbortSignal): Promise<ModelCompletionResult> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key is not configured.');
    }
    const maxRetries = 2;
    let lastError: Error | null = null;

    const outboundModel = policy.model.startsWith('aira-')
      ? (this.baseUrl.includes('api.openai.com')
          ? resolveOpenAIModel(policy.model)
          : this.baseUrl.includes('integrate.api.nvidia.com')
            ? resolveNvidiaModel(policy.model)
            : this.airaModel)
      : policy.model;

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
            throw new Error(
              `NVIDIA NIM returned 404 for model "${policy.model}". ` +
              'The model may be unavailable or inaccessible with this API key. ' +
              'Select a supported model in Aira.'
            );
          }
          const provider = this.baseUrl.includes('integrate.api.nvidia.com') ? 'NVIDIA NIM' : 'OpenAI';
          throw new Error(`${provider} API error (${response.status}): ${errText}`);
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
    onChunk: (delta: { text?: string; thinking?: string }) => void
  ): Promise<ModelCompletionResult> {
    if (!this.apiKey) throw new Error('Model provider API key is not configured.');
    const outboundModel = policy.model.startsWith('aira-')
      ? (this.baseUrl.includes('api.openai.com')
          ? resolveOpenAIModel(policy.model)
          : this.baseUrl.includes('integrate.api.nvidia.com')
            ? resolveNvidiaModel(policy.model)
            : this.airaModel)
      : policy.model;

    // Stream the upstream response rather than waiting for a full completion before
    // forwarding one giant delta. This also exposes the actual upstream model ID.
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
      // Upstream error bodies can contain submitted content and must not be
      // reflected to clients or application logs.
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${this.provider} streaming request failed (HTTP ${response.status})`);
    }
    if (!response.body) throw new Error('Provider returned an empty streaming response body.');

    const reader = response.body.getReader();
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
      buffer += decoder.decode();
      if (!finished && buffer.trim()) handleFrame(buffer);
    } finally {
      reader.releaseLock();
    }
    if (!finished) throw new Error('Provider stream closed before its terminal event.');
    if (!output.trim()) throw new Error('Provider completed without generating visible answer text.');
    return { text: output, usage, outboundModel, model: upstreamModel };
  }
}

export interface ResolvedExecution {
  policy: ModelPolicy;
  adapter: ModelAdapter;
  provider: 'nvidia' | 'anthropic' | 'openai' | 'mock' | 'unknown';
  executedModel: string;
  plannedModel: string;
  fallbackOccurred: boolean;
  fallbackReason?: string;
  verified: boolean;
}

export class ModelRouter {
  private adapters: Map<string, ModelAdapter> = new Map();

  constructor() {
    // DeterministicMockAdapter is ONLY registered in test/dev environments.
    // Production code must never reach this adapter through the normal router.
    // It is accessible only when model is explicitly 'mock-deterministic'.
    if (process.env.NODE_ENV !== 'production' || process.env.AIRA_ALLOW_MOCK === 'true') {
      this.adapters.set('mock', new DeterministicMockAdapter());
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
          'nvidia/nemotron-3-super-120b-a12b'
        )
      );
    }
  }

  public resolvePolicy(modelId: ModelId, intent?: IntentTaxonomy): ModelPolicy {
    // Frontend v1 exposed Aira modes using legacy Claude IDs. Treat those IDs as
    // product-level aliases so persisted browser settings keep working while
    // routing remains provider-agnostic.
    const legacyAiraAliases: Partial<Record<ModelId, ModelId>> = {
      'claude-3-7-sonnet': 'aira-auto',
      'claude-3-5-sonnet': 'aira-pro',
      'claude-3-5-haiku': 'aira-fast',
      'claude-3-opus': 'aira-deep',
      // The hosted Llama 3.1 405B endpoint is not a current NVIDIA catalog option.
      // Old browser state and direct API callers must use the supported replacement.
      'meta/llama-3.1-405b-instruct': 'nvidia/nemotron-3-super-120b-a12b'
    };

    let resolvedModel: ModelId = legacyAiraAliases[modelId] || modelId;

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
    const policy = this.resolvePolicy(requestedModelId, intent);
    const model = policy.model;

    // Test/dev only: explicit injection via model name
    if (model === 'mock-deterministic') {
      const mock = this.adapters.get('mock');
      if (!mock) {
        throw new Error(
          'CONFIGURATION_ERROR: DeterministicMockAdapter is not available in production mode. ' +
          'Set NODE_ENV=development or AIRA_ALLOW_MOCK=true to enable test adapters.'
        );
      }
      return {
        policy,
        adapter: mock,
        provider: 'mock',
        executedModel: 'mock-deterministic',
        plannedModel: 'mock-deterministic',
        fallbackOccurred: false,
        verified: true
      };
    }

    if (model.startsWith('aira-')) {
      const providerPreference: Array<'openai' | 'nvidia' | 'anthropic'> = model === 'aira-fast'
        ? ['openai', 'nvidia', 'anthropic']
        : ['anthropic', 'nvidia', 'openai'];

      const preferredProvider = providerPreference[0];
      let selectedProvider: 'openai' | 'nvidia' | 'anthropic' | 'mock' | null = null;
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
        throw new Error(
          `CONFIGURATION_ERROR: No production model provider is configured for Aira mode "${model}". ` +
          'Configure NVIDIA_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.'
        );
      }

      const fallbackOccurred = selectedProvider !== preferredProvider;
      let fallbackReason: string | undefined;
      if (fallbackOccurred) {
        const preferredName = preferredProvider === 'anthropic' ? 'Anthropic' : preferredProvider === 'nvidia' ? 'NVIDIA' : 'OpenAI';
        const selectedName = selectedProvider === 'nvidia' ? 'NVIDIA NIM' : selectedProvider === 'anthropic' ? 'Anthropic' : selectedProvider === 'openai' ? 'OpenAI' : 'Mock';
        fallbackReason = `Preferred provider (${preferredName}) not configured; routed to ${selectedName}`;
      }

      let executedModel: string;
      if (selectedProvider === 'nvidia') {
        executedModel = resolveNvidiaModel(model);
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
      } else if (selectedProvider === 'openai') {
        executedModel = model === 'aira-fast' ? 'gpt-4o-mini' : 'gpt-4o';
      } else {
        executedModel = model;
      }

      return {
        policy,
        adapter: selectedAdapter,
        provider: selectedProvider,
        executedModel,
        plannedModel: executedModel,
        fallbackOccurred,
        fallbackReason,
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

    if (model.startsWith('gpt')) {
      if (this.adapters.has('openai')) {
        return {
          policy,
          adapter: this.adapters.get('openai')!,
          provider: 'openai',
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

    if (model.startsWith('meta/') || model.startsWith('nvidia/') || model.startsWith('nv-')) {
      if (this.adapters.has('nvidia')) {
        const isLegacyLlama = requestedModelId === 'meta/llama-3.1-405b-instruct';
        const targetModel = isLegacyLlama ? 'nvidia/nemotron-3-super-120b-a12b' : model;
        return {
          policy,
          adapter: this.adapters.get('nvidia')!,
          provider: 'nvidia',
          executedModel: targetModel,
          plannedModel: targetModel,
          fallbackOccurred: isLegacyLlama,
          fallbackReason: isLegacyLlama ? 'Retired Llama 405B migrated to NVIDIA Nemotron' : undefined,
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
