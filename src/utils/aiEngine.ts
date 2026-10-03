import type { AppSettings, Artifact, Attachment, ModelId, ArtifactType } from '../types';
import { agentMemory } from './agentMemoryEngine';

export interface StreamCallbacks {
  onThinkingChunk?: (chunk: string) => void;
  onContentChunk: (chunk: string) => void;
  onArtifactFound?: (artifact: Artifact) => void;
  onComplete: () => void;
  onError: (error: string) => void;
}



export async function streamAIResponse(
  prompt: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: ModelId,
  settings: AppSettings,
  _attachments: Attachment[] | undefined,
  callbacks: StreamCallbacks,
  contextSubgraph?: string
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
    const backendRes = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        history,
        model,
        extendedThinking: isThinking,
        apiKey: settings.provider === 'anthropic' ? settings.anthropicApiKey : undefined,
        contextSubgraph: enrichedContext,
      }),
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

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          let currentEvent = 'message';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') continue;
              try {
                const data = JSON.parse(dataStr);
                if ((currentEvent === 'thinking_delta' || data.thinking) && wrappedCallbacks.onThinkingChunk && !data.text) {
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
                  }
                  activeArtifact = null;
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

        wrappedCallbacks.onComplete();
        return;
      }
    } catch (backendError: any) {
      wrappedCallbacks.onError(`Failed to connect to backend runtime: ${backendError.message}`);
    }
}
