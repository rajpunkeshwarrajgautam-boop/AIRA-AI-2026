import type { AppSettings, Artifact, Attachment, ModelId, ArtifactType } from '../types';
import { agentMemory } from './agentMemoryEngine';

export interface StreamCallbacks {
  onThinkingChunk?: (chunk: string) => void;
  onContentChunk: (chunk: string) => void;
  onArtifactFound?: (artifact: Artifact) => void;
  onApprovalRequired?: (approval: { id: string; runId: string; toolCall?: { name: string; arguments: any }; reason?: string }) => void;
  onStatusUpdate?: (status: string) => void;
  onComplete: () => void;
  onError: (error: string) => void;
}

let sessionBootstrapPromise: Promise<void> | null = null;

async function ensureApiSession(forceRefresh = false): Promise<void> {
  if (forceRefresh) sessionBootstrapPromise = null;
  if (sessionBootstrapPromise) return sessionBootstrapPromise;

  sessionBootstrapPromise = (async () => {
    const response = await fetch('/api/auth/session', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
      },
      credentials: 'same-origin',
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Session bootstrap failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
  })();

  try {
    await sessionBootstrapPromise;
  } catch (error) {
    sessionBootstrapPromise = null;
    throw error;
  }
}

async function postChatStream(body: unknown): Promise<Response> {
  await ensureApiSession();

  const request = () => fetch('/api/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });

  let response = await request();

  // Recover once from an expired/invalid session by issuing a fresh signed cookie.
  if (response.status === 401) {
    await ensureApiSession(true);
    response = await request();
  }

  return response;
}



export async function streamAIResponse(
  prompt: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: ModelId,
  settings: AppSettings,
  attachments: Attachment[] | undefined,
  callbacks: StreamCallbacks,
  contextSubgraph?: string,
  conversationId?: string
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
  const wrappedCallbacks: StreamCallbacks = {
    ...callbacks,
    onContentChunk: (chunk: string) => {
      accumulatedResponse += chunk;
      callbacks.onContentChunk(chunk);
    },
    onComplete: () => {
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
    });

      if (!backendRes.ok) {
        const errText = await backendRes.text();
        wrappedCallbacks.onError(`Backend returned ${backendRes.status}: ${errText}`);
        return;
      }

      if (backendRes.body) {
        const reader = backendRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let activeArtifact: Artifact | null = null;
        let artifactCode = '';
        let currentEvent = 'message';
        let emittedArtifact = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
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
                if (currentEvent === 'capability_unready' && data.message) {
                  // The backend also emits content_delta; avoid showing the same notice twice.
                  wrappedCallbacks.onStatusUpdate?.('Capability unavailable');
                } else if (currentEvent === 'approval_required') {
                  wrappedCallbacks.onApprovalRequired?.(data);
                  wrappedCallbacks.onStatusUpdate?.('Waiting for approval...');
                  if (data.reason) {
                    wrappedCallbacks.onContentChunk(`\n\n> ⚠️ **Approval Required**: ${data.reason}\n`);
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

        if (!accumulatedResponse.trim() && !emittedArtifact) {
          wrappedCallbacks.onError('Aira runtime closed the stream without producing a response.');
          return;
        }

        wrappedCallbacks.onComplete();
        return;
      }
    } catch (backendError: any) {
      wrappedCallbacks.onError(`Failed to connect to backend runtime: ${backendError.message}`);
    }
}
