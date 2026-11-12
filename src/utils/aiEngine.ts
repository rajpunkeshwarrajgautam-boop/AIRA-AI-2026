import type { AppSettings, Artifact, Attachment, ModelId, ArtifactType, AgentTimelineEvent } from '../types';
import { normalizeAgentTimelineEvent } from './agentTimeline';
import { agentMemory } from './agentMemoryEngine';
import { neonAuth } from '../lib/neonAuth';

export interface StreamCallbacks {
  onThinkingChunk?: (chunk: string) => void;
  onContentChunk: (chunk: string) => void;
  onProvenance?: (provenance: any) => void;
  onArtifactFound?: (artifact: Artifact) => void;
  onApprovalRequired?: (approval: { id: string; runId: string; toolCall?: { name: string; arguments: any }; reason?: string }) => void;
  onStatusUpdate?: (status: string) => void;
  onAgentEvent?: (event: AgentTimelineEvent) => void;
  onGraphEvent?: (type: string, data: any) => void;
  onRunStarted?: (runId: string) => void;
  onSourceAdded?: (source: any) => void;
  onCancelled?: () => void;
  onLatencyMetrics?: (metrics: {
    requestId: string;
    ttftMs: number | null;
    totalMs: number;
    deltaCount: number;
    thinkingCount: number;
    executedModel: string;
    executedProvider: string;
  }) => void;
  onComplete: () => void;
  onError: (error: string) => void;
}

import { authenticatedApiFetch, AuthenticationRequiredError } from '../lib/neonAuth';

async function postChatStream(body: unknown, signal?: AbortSignal): Promise<Response> {
  return authenticatedApiFetch('/api/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
}



import { createStreamingArtifactDetector } from './artifactParser';
import { createStreamingArtifactReconciler, createStreamingFenceArtifactDetector } from './streamingArtifactParser';

export const PERSONALIZATION_BOUNDS = {
  MAX_BIO_CHARS: 500,
  MAX_CUSTOM_INSTRUCTIONS_CHARS: 2000,
  MAX_RUNTIME_DIRECTIVE_CHARS: 2000,
} as const;

function boundText(value: string | undefined, maxChars: number): string {
  if (!value || typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trimEnd() + '... [truncated]';
}

export function composeSystemPrompt(settings: AppSettings, customPrompt?: string): string {
  const parts: string[] = [];

  // 1. Response Style Directive (Platform Formatting Preset)
  const style = settings.responseStyle || 'normal';
  switch (style) {
    case 'concise':
      parts.push('Response Style Directive: Provide concise, direct answers without unnecessary preamble or filler.');
      break;
    case 'explanatory':
      parts.push('Response Style Directive: Provide detailed, pedagogical explanations breaking down concepts step-by-step.');
      break;
    case 'academic':
      parts.push('Response Style Directive: Provide rigorous, academically grounded analysis with analytical depth and formal phrasing.');
      break;
    case 'code-first':
      parts.push('Response Style Directive: Provide dense, production-grade code-first implementations with minimal conversational overhead.');
      break;
    case 'normal':
    default:
      parts.push('Response Style Directive: Adopt a balanced, clear, and adaptive tone tailored to the question.');
      break;
  }

  // 2. Workspace / Caller Mode Directive (Distinct from user custom instructions; deduplicated)
  const boundedCustomPrompt = boundText(customPrompt, PERSONALIZATION_BOUNDS.MAX_RUNTIME_DIRECTIVE_CHARS);

  // 3. Account-Scoped User Profile Context (Bounded; never leaks across identities)
  const boundedBio = boundText(settings.userBio, PERSONALIZATION_BOUNDS.MAX_BIO_CHARS);
  if (boundedBio) {
    parts.push(`User Profile Context: ${boundedBio}`);
  }

  // 4. Account-Scoped User Custom Instructions (Bounded; subject to AIRA invariant precedence)
  const boundedInstructions = boundText(settings.customInstructions, PERSONALIZATION_BOUNDS.MAX_CUSTOM_INSTRUCTIONS_CHARS);
  if (boundedInstructions) {
    parts.push(`User Custom Instructions: ${boundedInstructions}`);
  }

  // 5. Mode / Runtime Directive (Only if non-empty and not already present)
  if (boundedCustomPrompt && boundedCustomPrompt !== boundedInstructions) {
    parts.push(boundedCustomPrompt);
  }

  return parts.join('\n\n');
}

export async function streamAIResponse(
  prompt: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: ModelId,
  settings: AppSettings,
  attachments: Attachment[] | undefined,
  callbacks: StreamCallbacks,
  contextSubgraph?: string,
  conversationId?: string,
  intent?: string,
  signal?: AbortSignal,
  reconcileArtifacts = false,
  modeDirective?: string,
): Promise<void> {
  const isThinking = Boolean(
    settings.extendedThinking && (
      model === 'aira-auto' ||
      model === 'aira-deep' ||
      model === 'claude-3-7-sonnet' ||
      model === 'claude-3-opus' ||
      model.includes('nemotron')
    )
  );
  const initiatingMemoryOwner = neonAuth.getCurrentUser()?.id || 'guest';
  const initiatingAuthEpoch = neonAuth.getAuthEpoch();
  const isInitiatingIdentityValid = () => (
    neonAuth.getAuthEpoch() === initiatingAuthEpoch &&
    (neonAuth.getCurrentUser()?.id || 'guest') === initiatingMemoryOwner
  );

  // 0. Persistent Long-Term Memory Injection (agentmemory)
  let enrichedContext = contextSubgraph || '';
  if (settings.persistentMemoryEnabled !== false) {
    const memoryBlock = agentMemory.assembleMemoryContext(
      prompt,
      settings.memoryTokenBudget || 800,
      undefined,
      initiatingMemoryOwner
    );
    if (memoryBlock) {
      enrichedContext = enrichedContext ? `${enrichedContext}\n\n${memoryBlock}` : memoryBlock;
    }
  }

  let accumulatedResponse = '';
  const reconciler = reconcileArtifacts && callbacks.onArtifactFound
    ? createStreamingArtifactReconciler(artifact => {
      if (isInitiatingIdentityValid() && !signal?.aborted) callbacks.onArtifactFound?.(artifact);
    })
    : null;
  const emitArtifact = (artifact: Artifact) => {
    if (signal?.aborted || !isInitiatingIdentityValid()) return;
    if (reconciler) reconciler.publish(artifact);
    else callbacks.onArtifactFound?.(artifact);
  };
  const abandonArtifactUpdates = () => reconciler?.cancel();
  signal?.addEventListener('abort', abandonArtifactUpdates, { once: true });
  const finishArtifactUpdates = () => {
    reconciler?.flush();
    signal?.removeEventListener('abort', abandonArtifactUpdates);
  };
  const detector = createStreamingArtifactDetector(artifact => {
    emitArtifact(artifact);
  });
  const fenceDetector = reconcileArtifacts && callbacks.onArtifactFound
    ? createStreamingFenceArtifactDetector()
    : null;

  const wrappedCallbacks: StreamCallbacks = {
    ...callbacks,
    onThinkingChunk: chunk => { if (isInitiatingIdentityValid()) callbacks.onThinkingChunk?.(chunk); },
    onProvenance: value => { if (isInitiatingIdentityValid()) callbacks.onProvenance?.(value); },
    onApprovalRequired: value => { if (isInitiatingIdentityValid()) callbacks.onApprovalRequired?.(value); },
    onStatusUpdate: value => { if (isInitiatingIdentityValid()) callbacks.onStatusUpdate?.(value); },
    onAgentEvent: value => { if (isInitiatingIdentityValid()) callbacks.onAgentEvent?.(value); },
    onGraphEvent: (event, value) => { if (isInitiatingIdentityValid()) callbacks.onGraphEvent?.(event, value); },
    onRunStarted: value => { if (isInitiatingIdentityValid()) callbacks.onRunStarted?.(value); },
    onSourceAdded: value => { if (isInitiatingIdentityValid()) callbacks.onSourceAdded?.(value); },
    onLatencyMetrics: value => { if (isInitiatingIdentityValid()) callbacks.onLatencyMetrics?.(value); },
    onArtifactFound: callbacks.onArtifactFound ? emitArtifact : undefined,
    onContentChunk: (chunk: string) => {
      if (!isInitiatingIdentityValid()) return;
      accumulatedResponse += chunk;
      const { textToEmit, artifactUpdate } = detector.processChunk(chunk);
      if (artifactUpdate && callbacks.onArtifactFound) {
        emitArtifact(artifactUpdate);
      }
      if (textToEmit) {
        fenceDetector?.processChunk(textToEmit).forEach(emitArtifact);
        if (isInitiatingIdentityValid()) callbacks.onContentChunk(textToEmit);
      }
    },
    onComplete: () => {
      if (!isInitiatingIdentityValid()) {
        abandonArtifactUpdates();
        return;
      }
      const { remainingText, finalArtifact } = detector.flush();
      if (finalArtifact && callbacks.onArtifactFound) {
        emitArtifact(finalArtifact);
      }
      if (remainingText) {
        fenceDetector?.processChunk(remainingText).forEach(emitArtifact);
        if (isInitiatingIdentityValid()) callbacks.onContentChunk(remainingText);
      }
      fenceDetector?.flush().forEach(emitArtifact);
      finishArtifactUpdates();
      if (!isInitiatingIdentityValid()) return;
      if (
        settings.autoConsolidateMemory !== false &&
        accumulatedResponse.trim() &&
        isInitiatingIdentityValid()
      ) {
        try {
          agentMemory.consolidateFromTurn(prompt, accumulatedResponse);
        } catch {
          // Ignore consolidation errors
        }
      }
      callbacks.onComplete();
    },
    onError: error => {
      abandonArtifactUpdates();
      signal?.removeEventListener('abort', abandonArtifactUpdates);
      if (isInitiatingIdentityValid()) callbacks.onError(error);
    },
    onCancelled: () => {
      abandonArtifactUpdates();
      signal?.removeEventListener('abort', abandonArtifactUpdates);
      if (isInitiatingIdentityValid()) callbacks.onCancelled?.();
    },
  };

  // 1. Try Backend SSE Streaming Server (/api/chat/stream)
  try {
    const assembledSystemPrompt = composeSystemPrompt(settings, modeDirective);
    // Avoid duplicating project context if it was accidentally included in customPrompt or systemPrompt
    const trimmedContextSubgraph = enrichedContext.trim();
    const dedupedContextSubgraph = (
      trimmedContextSubgraph &&
      assembledSystemPrompt &&
      assembledSystemPrompt.includes(trimmedContextSubgraph)
    )
      ? ''
      : trimmedContextSubgraph;
    const backendRes = await postChatStream({
      prompt,
      history,
      model,
      extendedThinking: isThinking,
      thinkingBudget: isThinking ? Math.min(Math.max(settings.thinkingBudget || 2048, 1024), 8192) : undefined,
      apiKey: settings.provider === 'anthropic' ? settings.anthropicApiKey : undefined,
      systemPrompt: assembledSystemPrompt || undefined,
      attachments: attachments?.map(a => ({
        name: a.name,
        type: a.type,
        size: a.size,
        content: a.content || ''
      })),
      contextSubgraph: dedupedContextSubgraph,
      conversationId,
      intent: intent || undefined
    }, signal);

      if (!isInitiatingIdentityValid()) {
        try { await backendRes.body?.cancel(); } catch {}
        abandonArtifactUpdates();
        return;
      }

      if (!backendRes.ok) {
        const errText = await backendRes.text();
        wrappedCallbacks.onError(`Backend returned ${backendRes.status}: ${errText}`);
        return;
      }

      if (backendRes.body) {
        const isIdentityValid = isInitiatingIdentityValid;

        const reader = backendRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let activeArtifact: Artifact | null = null;
        let artifactCode = '';
        let currentEvent = 'message';
        let emittedArtifact = false;

        while (true) {
          if (signal?.aborted) {
            try { await reader.cancel(); } catch {}
            wrappedCallbacks.onCancelled?.();
            return;
          }

          if (!isIdentityValid()) {
            console.warn('[streamAIResponse] Stream processing aborted: auth identity changed during stream');
            try { await reader.cancel(); } catch {}
            abandonArtifactUpdates();
            return;
          }

          const { done, value } = await reader.read();
          if (done) break;

          if (signal?.aborted) {
            try { await reader.cancel(); } catch {}
            wrappedCallbacks.onCancelled?.();
            return;
          }

          if (!isIdentityValid()) {
            console.warn('[streamAIResponse] Stream chunk discarded: auth identity changed during chunk arrival');
            try { await reader.cancel(); } catch {}
            abandonArtifactUpdates();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const rawLine of lines) {
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            if (signal?.aborted) {
              try { await reader.cancel(); } catch {}
              wrappedCallbacks.onCancelled?.();
              return;
            }
            if (!isIdentityValid()) {
              try { await reader.cancel(); } catch {}
              abandonArtifactUpdates();
              return;
            }
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') {
                if (currentEvent === 'done') {
                  wrappedCallbacks.onComplete();
                  return;
                }
                continue;
              }
              try {
                const data = JSON.parse(dataStr);
                if (wrappedCallbacks.onAgentEvent) {
                  const timelineEvent = normalizeAgentTimelineEvent(currentEvent, data);
                  if (timelineEvent) wrappedCallbacks.onAgentEvent(timelineEvent);
                }
                if (wrappedCallbacks.onGraphEvent) {
                  wrappedCallbacks.onGraphEvent(currentEvent, data);
                }
                if (currentEvent === 'run_started' && data.runId) {
                  wrappedCallbacks.onRunStarted?.(data.runId);
                } else if (currentEvent === 'source_added') {
                  wrappedCallbacks.onSourceAdded?.(data);
                } else if (currentEvent === 'run_cancelled') {
                  wrappedCallbacks.onCancelled?.();
                  return;
                } else if (currentEvent === 'model_provenance' || (data.requestedModel && data.executedModel)) {
                  wrappedCallbacks.onProvenance?.(data);
                } else if (currentEvent === 'capability_unready' && data.message) {
                  wrappedCallbacks.onContentChunk(data.message);
                } else if (currentEvent === 'approval_required') {
                  wrappedCallbacks.onApprovalRequired?.(data);
                  wrappedCallbacks.onStatusUpdate?.('Waiting for approval...');
                  if (data.reason) {
                    wrappedCallbacks.onContentChunk(`\n\n> [Approval Required]: ${data.reason}\n`);
                  }
                } else if (currentEvent === 'tool_started') {
                  wrappedCallbacks.onStatusUpdate?.(`Executing tool: ${data.name || 'tool'}...`);
                } else if (currentEvent === 'tool_completed') {
                  wrappedCallbacks.onStatusUpdate?.(`Completed tool: ${data.name || data.toolId || 'action'}`);
                } else if (currentEvent === 'workflow_started') {
                  wrappedCallbacks.onStatusUpdate?.('Executing multi-step workflow...');
                } else if (currentEvent === 'workflow_step_started') {
                  wrappedCallbacks.onStatusUpdate?.(`Workflow step "${data.stepId}" in progress...`);
                } else if (currentEvent === 'workflow_step_progress') {
                  wrappedCallbacks.onStatusUpdate?.(`Workflow step "${data.stepId}": ${data.progress || 'working'}...`);
                } else if (currentEvent === 'workflow_step_completed') {
                  wrappedCallbacks.onStatusUpdate?.(`Workflow step "${data.stepId}" completed.`);
                } else if ((currentEvent === 'thinking_delta' || data.thinking) && wrappedCallbacks.onThinkingChunk && !data.text) {
                  wrappedCallbacks.onThinkingChunk(data.thinking);
                } else if ((currentEvent === 'content_delta' || data.text) && data.text) {
                  wrappedCallbacks.onContentChunk(data.text);
                } else if (currentEvent === 'latency_metrics') {
                  wrappedCallbacks.onLatencyMetrics?.(data);
                } else if (currentEvent === 'artifact_open') {
                  artifactCode = '';
                  activeArtifact = {
                    id: 'art-' + Date.now(),
                    title: data.title || 'Interactive Artifact',
                    type: (data.type || 'text/html') as ArtifactType,
                    language: data.language || 'html',
                    content: '',
                    version: data.version || 1,
                    versions: [],
                  };
                  if (reconcileArtifacts && wrappedCallbacks.onArtifactFound) {
                    wrappedCallbacks.onArtifactFound(activeArtifact);
                  }
                } else if (currentEvent === 'artifact_delta' && data.chunk) {
                  artifactCode += data.chunk;
                  if (reconcileArtifacts && activeArtifact && wrappedCallbacks.onArtifactFound) {
                    activeArtifact.content = artifactCode;
                    wrappedCallbacks.onArtifactFound(activeArtifact);
                  }
                } else if (currentEvent === 'artifact_close' && activeArtifact) {
                  activeArtifact.content = artifactCode;
                  activeArtifact.versions = [{
                    version: activeArtifact.version,
                    content: artifactCode,
                    timestamp: Date.now(),
                  }];
                  if (wrappedCallbacks.onArtifactFound) {
                    wrappedCallbacks.onArtifactFound(activeArtifact);
                    emittedArtifact = true;
                  }
                  activeArtifact = null;
                } else if (currentEvent === 'error' || data.error) {
                  wrappedCallbacks.onError(data.error || data.message || 'Aira runtime failed before producing a response');
                  return;
                } else if (currentEvent === 'done') {
                  wrappedCallbacks.onComplete();
                  return;
                }
              } catch {
                // Ignore partial JSON chunk errors
              }
            }
          }
        }

        if (!isIdentityValid()) {
          console.warn('[streamAIResponse] Stream completion suppressed: auth identity changed during stream');
          abandonArtifactUpdates();
          return;
        }

        if (!accumulatedResponse.trim() && !emittedArtifact) {
          wrappedCallbacks.onError('Aira runtime closed the stream without producing a response.');
          return;
        }

        wrappedCallbacks.onComplete();
        return;
      }
    } catch (backendError: any) {
      if (signal?.aborted || backendError?.name === 'AbortError') {
        wrappedCallbacks.onCancelled?.();
        return;
      }
      if (backendError instanceof AuthenticationRequiredError || backendError?.isAuthError) {
        wrappedCallbacks.onError(`Authentication required: ${backendError.message}`);
      } else {
        wrappedCallbacks.onError(`Failed to connect to backend runtime: ${backendError.message}`);
      }
    }
}
