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
  model: string;
}

export interface ModelAdapter {
  complete(messages: ChatMessageInput[], policy: ModelPolicy): Promise<ModelCompletionResult>;
  stream(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    onChunk: (delta: { text?: string; thinking?: string }) => void
  ): Promise<ModelCompletionResult>;
}

export class DeterministicMockAdapter implements ModelAdapter {
  async complete(messages: ChatMessageInput[], policy: ModelPolicy): Promise<ModelCompletionResult> {
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const thinking = policy.extendedThinking
      ? `Analyzing intent for request: "${lastUserMessage.slice(0, 80)}...". Resolving execution strategy via deterministic model policy ${policy.model}.`
      : undefined;

    let text = `Processed your request using ${policy.model}.`;
    if (lastUserMessage.toLowerCase().includes('run command')) {
      text = `{"type": "tool_call", "name": "system_shell", "arguments": {"command": "echo hello"}}`;
    } else if (lastUserMessage.toLowerCase().includes('hang safe')) {
      text = `{"type": "tool_call", "name": "hang_safe", "arguments": {}}`;
    } else if (lastUserMessage.toLowerCase().includes('hang unsafe')) {
      text = `{"type": "tool_call", "name": "hang_unsafe", "arguments": {}}`;
    } else if (lastUserMessage.toLowerCase().includes('search') || lastUserMessage.toLowerCase().includes('find')) {
      text = `Search query analyzed: "${lastUserMessage}". Findings indicate relevant data across index nodes.`;
    } else if (lastUserMessage.toLowerCase().includes('help') || lastUserMessage.toLowerCase().includes('hello')) {
      text = `Hello. I am Aira AI, your autonomous operating workspace. How can I assist your objectives today?`;
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
      model: policy.model
    };
  }

  async stream(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    onChunk: (delta: { text?: string; thinking?: string }) => void
  ): Promise<ModelCompletionResult> {
    const result = await this.complete(messages, policy);
    if (result.thinking) {
      const thinkingParts = result.thinking.split(' ');
      for (const part of thinkingParts) {
        onChunk({ thinking: part + ' ' });
        await new Promise(r => setTimeout(r, 10));
      }
    }
    const textParts = result.text.split(' ');
    for (const part of textParts) {
      onChunk({ text: part + ' ' });
      await new Promise(r => setTimeout(r, 15));
    }
    return result;
  }
}

export class AnthropicAdapter implements ModelAdapter {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl = 'https://api.anthropic.com/v1') {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.baseUrl = baseUrl;
  }

  async complete(messages: ChatMessageInput[], policy: ModelPolicy): Promise<ModelCompletionResult> {
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

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: policy.model === 'aira-pro' ? 'claude-3-7-sonnet-20250219' : policy.model,
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
      model: data.model || policy.model
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
  }

  async complete(messages: ChatMessageInput[], policy: ModelPolicy): Promise<ModelCompletionResult> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key is not configured.');
    }
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: policy.model.startsWith('aira-')
              ? (this.baseUrl.includes('api.openai.com') && policy.model === 'aira-fast' ? 'gpt-4o-mini' : this.airaModel)
              : policy.model,
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
          throw new Error(`OpenAI API error (${response.status}): ${errText}`);
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
          model: data.model || policy.model
        };
      } catch (err: any) {
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
    const res = await this.complete(messages, policy);
    if (res.text) onChunk({ text: res.text });
    return res;
  }
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
      'claude-3-opus': 'aira-deep'
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

  public getAdapter(policy: ModelPolicy): ModelAdapter {
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
      return mock;
    }

    if (model.startsWith('aira-')) {
      const providerPreference = model === 'aira-fast'
        ? ['openai', 'nvidia', 'anthropic']
        : ['anthropic', 'nvidia', 'openai'];

      for (const provider of providerPreference) {
        const adapter = this.adapters.get(provider);
        if (adapter) return adapter;
      }

      throw new Error(
        `CONFIGURATION_ERROR: No production model provider is configured for Aira mode "${model}". ` +
        'Configure NVIDIA_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.'
      );
    }

    if (model.startsWith('claude')) {
      if (this.adapters.has('anthropic')) {
        return this.adapters.get('anthropic')!;
      }
      throw new Error(
        `CONFIGURATION_ERROR: No Anthropic API key configured for model "${model}". ` +
        'Set ANTHROPIC_API_KEY in environment.'
      );
    }

    if (model.startsWith('gpt')) {
      if (this.adapters.has('openai')) {
        return this.adapters.get('openai')!;
      }
      throw new Error(
        `CONFIGURATION_ERROR: No OpenAI API key configured for model "${model}". ` +
        'Set OPENAI_API_KEY in environment.'
      );
    }

    if (model.startsWith('meta/') || model.startsWith('nvidia/')) {
      if (this.adapters.has('nvidia')) {
        return this.adapters.get('nvidia')!;
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

  /** Returns a list of configured provider names (for health/diagnostics). */
  public listProviders(): string[] {
    return Array.from(this.adapters.keys()).filter(k => k !== 'mock');
  }
}
