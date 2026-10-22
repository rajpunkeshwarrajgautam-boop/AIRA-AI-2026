import type { AppSettings, Artifact, Attachment, ModelId, ArtifactType } from '../types';
import { agentMemory } from './agentMemoryEngine';
import { neonAuth } from '../lib/neonAuth';

export interface StreamCallbacks {
  onThinkingChunk?: (chunk: string) => void;
  onContentChunk: (chunk: string) => void;
  onProvenance?: (provenance: any) => void;
  onArtifactFound?: (artifact: Artifact) => void;
  onApprovalRequired?: (approval: { id: string; runId: string; toolCall?: { name: string; arguments: any }; reason?: string }) => void;
  onStatusUpdate?: (status: string) => void;
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
  signal?: AbortSignal
): Promise<void> {
  const isThinking = (model === 'claude-3-7-sonnet' && settings.extendedThinking);

  // 0. Persistent Long-Term Memory Injection (agentmemory)
  let enrichedContext = contextSubgraph || '';
  if (settings.persistentMemoryEnabled !== false) {
    const memoryBlock = agentMemory.assembleMemoryContext(prompt, settings.memoryTokenBudget || 800);
    if (memoryBlock) {
      enrichedContext = enrichedContext ? `${enrichedContext}\n\n${memoryBlock}` : memoryBlock;
    }
  }

  let accumulatedResponse = '';
  const detector = createStreamingArtifactDetector(artifact => {
    callbacks.onArtifactFound?.(artifact);
  });

  const wrappedCallbacks: StreamCallbacks = {
    ...callbacks,
    onContentChunk: (chunk: string) => {
      accumulatedResponse += chunk;
      const { textToEmit, artifactUpdate } = detector.processChunk(chunk);
      if (artifactUpdate && callbacks.onArtifactFound) {
        callbacks.onArtifactFound(artifactUpdate);
      }
      if (textToEmit) {
        callbacks.onContentChunk(textToEmit);
      }
    },
    onComplete: () => {
      const { remainingText, finalArtifact } = detector.flush();
      if (finalArtifact && callbacks.onArtifactFound) {
        callbacks.onArtifactFound(finalArtifact);
      }
      if (remainingText) {
        callbacks.onContentChunk(remainingText);
      }
      if (settings.autoConsolidateMemory !== false && accumulatedResponse.trim()) {
        try {
          agentMemory.consolidateFromTurn(prompt, accumulatedResponse);
        } catch {
          // Ignore consolidation errors
        }
      }
      callbacks.onComplete();
    },
  };

  // 1. Try Backend SSE Streaming Server (/api/chat/stream)
  try {
    const backendRes = await postChatStream({
      prompt,
      history,
      model,
      extendedThinking: isThinking,
      apiKey: settings.provider === 'anthropic' ? settings.anthropicApiKey : undefined,
      systemPrompt: settings.customInstructions || undefined,
      attachments: attachments?.map(a => ({
        name: a.name,
        type: a.type,
        size: a.size,
        content: a.content || ''
      })),
      contextSubgraph: enrichedContext,
      conversationId,
      intent: intent || undefined
    }, signal);

      if (!backendRes.ok) {
        const errText = await backendRes.text();
        wrappedCallbacks.onError(`Backend returned ${backendRes.status}: ${errText}`);
        return;
      }

      if (backendRes.body) {
        const streamInitiatingEpoch = neonAuth.getAuthEpoch();
        const streamInitiatingUserId = neonAuth.getCurrentUser()?.id || '';

        const isIdentityValid = () => {
          return (
            neonAuth.getAuthEpoch() === streamInitiatingEpoch &&
            (neonAuth.getCurrentUser()?.id || '') === streamInitiatingUserId
          );
        };

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
                } else if (currentEvent === 'artifact_delta' && data.chunk) {
                  artifactCode += data.chunk;
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
