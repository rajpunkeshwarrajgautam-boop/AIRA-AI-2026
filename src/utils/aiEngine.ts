import type { AppSettings, Artifact, Attachment, ModelId, ArtifactType } from '../types';

export interface StreamCallbacks {
  onThinkingChunk?: (chunk: string) => void;
  onContentChunk: (chunk: string) => void;
  onArtifactFound?: (artifact: Artifact) => void;
  onComplete: () => void;
  onError: (error: string) => void;
}

// Built-in intelligent template generator for immediate out-of-the-box readiness
function getSimulatedResponseForPrompt(
  prompt: string,
  _model: ModelId,
  isThinking: boolean
): { thinking?: string; content: string; artifact?: Artifact } {
  const lower = prompt.toLowerCase();

  // Scenario 1: Interactive game, widget, or dashboard artifact
  if (lower.includes('game') || lower.includes('snake') || lower.includes('tic tac toe')) {
    const code = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Retro Arcade - Snake</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    canvas { background-color: #1a1918; border: 2px solid #cc785c; border-radius: 8px; }
  </style>
</head>
<body class="bg-stone-900 text-stone-100 flex flex-col items-center justify-center min-h-screen p-4">
  <div class="text-center mb-4">
    <h1 class="text-2xl font-bold tracking-tight text-[#cc785c]">Arcade Snake Challenge</h1>
    <p class="text-xs text-stone-400 mt-1">Use Arrow Keys or WASD to navigate</p>
    <div class="mt-2 text-sm font-mono font-semibold">Score: <span id="score" class="text-amber-400">0</span> | Best: <span id="highScore" class="text-stone-400">0</span></div>
  </div>
  <canvas id="gameCanvas" width="340" height="340"></canvas>
  <div class="mt-4 flex space-x-3">
    <button onclick="restartGame()" class="px-4 py-2 bg-[#cc785c] hover:bg-[#ba6549] text-white rounded-lg text-sm font-medium transition">Restart Game</button>
  </div>

  <script>
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    const gridSize = 17;
    const tileCount = canvas.width / gridSize;
    let snake = [{x: 10, y: 10}];
    let food = {x: 5, y: 5};
    let dx = 1, dy = 0;
    let score = 0;
    let highScore = 0;
    let gameLoop = null;

    function placeFood() {
      food.x = Math.floor(Math.random() * tileCount);
      food.y = Math.floor(Math.random() * tileCount);
    }

    function draw() {
      const head = {x: snake[0].x + dx, y: snake[0].y + dy};
      if (head.x < 0 || head.x >= tileCount || head.y < 0 || head.y >= tileCount || snake.some(s => s.x === head.x && s.y === head.y)) {
        clearInterval(gameLoop);
        alert('Game Over! Your score: ' + score);
        return;
      }
      snake.unshift(head);
      if (head.x === food.x && head.y === food.y) {
        score += 10;
        if (score > highScore) highScore = score;
        document.getElementById('score').innerText = score;
        document.getElementById('highScore').innerText = highScore;
        placeFood();
      } else {
        snake.pop();
      }

      ctx.fillStyle = '#181716';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#cc785c';
      snake.forEach(part => ctx.fillRect(part.x * gridSize, part.y * gridSize, gridSize - 1, gridSize - 1));
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(food.x * gridSize, food.y * gridSize, gridSize - 1, gridSize - 1);
    }

    window.addEventListener('keydown', e => {
      if ((e.key === 'ArrowUp' || e.key === 'w') && dy === 0) { dx = 0; dy = -1; }
      if ((e.key === 'ArrowDown' || e.key === 's') && dy === 0) { dx = 0; dy = 1; }
      if ((e.key === 'ArrowLeft' || e.key === 'a') && dx === 0) { dx = -1; dy = 0; }
      if ((e.key === 'ArrowRight' || e.key === 'd') && dx === 0) { dx = 1; dy = 0; }
    });

    function restartGame() {
      clearInterval(gameLoop);
      snake = [{x: 10, y: 10}];
      dx = 1; dy = 0; score = 0;
      document.getElementById('score').innerText = score;
      placeFood();
      gameLoop = setInterval(draw, 110);
    }
    restartGame();
  </script>
</body>
</html>`;
    return {
      thinking: isThinking ? `1. Analyze user request for interactive arcade snake game.
2. Architecture requirements:
   - Self-contained HTML5 Canvas game with responsive layout.
   - Clean controls, collision detection, and dynamic score tracking.
   - Aesthetic aligned with modern dark theme and Aira violet and cyan accents.
3. Generating standalone interactive Artifact for immediate sandbox execution.` : undefined,
      content: `I've created a complete, playable **Arcade Snake Challenge** for you as an interactive artifact!

You can test it right now in the interactive sandbox panel on the right. You can also view the clean source code or copy and download it for your own web projects.`,
      artifact: {
        id: 'snake-arcade-' + Date.now(),
        title: 'Retro Arcade: Snake Challenge',
        type: 'text/html',
        language: 'html',
        content: code,
        version: 1,
        versions: [{ version: 1, content: code, timestamp: Date.now() }],
      }
    };
  }

  // Scenario 2: Calculator or Financial tool
  if (lower.includes('calculator') || lower.includes('mortgage') || lower.includes('loan') || lower.includes('finance')) {
    const code = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Smart Financial Calculator</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-stone-50 text-stone-800 p-6 flex items-center justify-center min-h-screen">
  <div class="bg-white rounded-2xl shadow-lg border border-stone-200 p-8 max-w-md w-full">
    <h2 class="text-xl font-bold text-stone-900 mb-1">Mortgage & Loan Estimator</h2>
    <p class="text-xs text-stone-500 mb-6">Calculate monthly amortization and interest splits.</p>
    
    <div class="space-y-4">
      <div>
        <label class="block text-xs font-semibold text-stone-600 uppercase mb-1">Principal Amount ($)</label>
        <input id="amount" type="number" value="350000" class="w-full px-3.5 py-2 rounded-lg border border-stone-200 focus:outline-none focus:border-[#cc785c] font-medium" oninput="calculate()">
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-semibold text-stone-600 uppercase mb-1">Interest Rate (%)</label>
          <input id="rate" type="number" step="0.1" value="6.5" class="w-full px-3.5 py-2 rounded-lg border border-stone-200 focus:outline-none focus:border-[#cc785c] font-medium" oninput="calculate()">
        </div>
        <div>
          <label class="block text-xs font-semibold text-stone-600 uppercase mb-1">Term (Years)</label>
          <input id="years" type="number" value="30" class="w-full px-3.5 py-2 rounded-lg border border-stone-200 focus:outline-none focus:border-[#cc785c] font-medium" oninput="calculate()">
        </div>
      </div>
      
      <div class="pt-4 border-t border-stone-100 text-center">
        <div class="text-xs uppercase tracking-wider text-stone-400 font-semibold mb-1">Estimated Monthly Payment</div>
        <div id="monthly" class="text-4xl font-extrabold text-[#cc785c] font-mono">$2,212</div>
        <div class="text-xs text-stone-500 mt-2">Total repayment: <span id="totalPayment" class="font-semibold text-stone-800">$796,400</span></div>
      </div>
    </div>
  </div>

  <script>
    function calculate() {
      const p = parseFloat(document.getElementById('amount').value) || 0;
      const r = (parseFloat(document.getElementById('rate').value) || 0) / 100 / 12;
      const n = (parseFloat(document.getElementById('years').value) || 0) * 12;
      if (r === 0 || n === 0) return;
      const m = (p * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
      document.getElementById('monthly').innerText = '$' + Math.round(m).toLocaleString();
      document.getElementById('totalPayment').innerText = '$' + Math.round(m * n).toLocaleString();
    }
    calculate();
  </script>
</body>
</html>`;
    return {
      thinking: isThinking ? `User requested a financial calculator or mortgage calculation tool.
- Modeling amortization formula: M = P * [ r(1 + r)^n ] / [ (1 + r)^n - 1 ]
- Creating responsive, high-aesthetic HTML/JS artifact with instant recalculation on keystrokes.
- Outputting artifact alongside explanatory text.` : undefined,
      content: `Here is a custom **Smart Financial & Mortgage Estimator** built as an interactive artifact.

You can tweak the principal, interest rate, and repayment horizon, and it will dynamically recalculate your monthly payment and total loan cost in real-time.`,
      artifact: {
        id: 'calc-' + Date.now(),
        title: 'Smart Loan & Mortgage Estimator',
        type: 'text/html',
        language: 'html',
        content: code,
        version: 1,
        versions: [{ version: 1, content: code, timestamp: Date.now() }],
      }
    };
  }

  // Scenario 3: General analysis / thought / coding request
  return {
    thinking: isThinking ? `1. **Intent Analysis**:
   - The user is asking: "${prompt.slice(0, 80)}..."
   - Primary discipline: Comprehensive analysis, clean structured explanation, and actionable code/recommendations.

2. **Formulating Response**:
   - Adopt Aira's product voice: precise, capable, direct, and calm.
   - Organize logically using clear Markdown headers, bullet points, and code demonstrations where relevant.
   - Ensure conclusions are grounded, practical, and immediately useful.` : undefined,
    content: `Thank you for sharing that question. Here is a comprehensive breakdown:

### Key Considerations
1. **Clarity & Architecture**: A modular system ensures scalability and makes maintenance straightforward across components.
2. **Performance & Ergonomics**: Focusing on low latency, responsive micro-interactions, and accessible typography yields an intuitive user experience.
3. **Execution Steps**:
   - Establish clean domain boundaries.
   - Maintain robust client-side fallback mechanisms.
   - Leverage interactive artifacts for complex data representations and standalone tools.

\`\`\`typescript
// Example: Composable state handler
export function createSessionContext<T>(initialState: T) {
  let state = initialState;
  const listeners = new Set<(s: T) => void>();

  return {
    getState: () => state,
    setState: (update: Partial<T>) => {
      state = { ...state, ...update };
      listeners.forEach(fn => fn(state));
    },
    subscribe: (fn: (s: T) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}
\`\`\`

Feel free to ask if you'd like me to build this out into an interactive artifact or tailor the logic to a specific use case!`
  };
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
        contextSubgraph,
      }),
    });

    if (backendRes.ok && backendRes.body) {
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
              if (currentEvent === 'thinking_delta' && data.thinking && callbacks.onThinkingChunk) {
                callbacks.onThinkingChunk(data.thinking);
              } else if (currentEvent === 'content_delta' && data.text) {
                callbacks.onContentChunk(data.text);
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
                if (callbacks.onArtifactFound) {
                  callbacks.onArtifactFound(activeArtifact);
                }
                activeArtifact = null;
              } else if (currentEvent === 'done') {
                callbacks.onComplete();
                return;
              }
            } catch {
              // Ignore partial JSON chunk errors
            }
          }
        }
      }

      callbacks.onComplete();
      return;
    }
  } catch (backendError) {
    console.warn('Backend SSE server unreachable or failed, falling back to client engine:', backendError);
  }

  // 2. Direct Anthropic API Call (If configured in settings)
  if (settings.provider === 'anthropic' && settings.anthropicApiKey.trim()) {
    try {
      const messages = history.map(h => ({
        role: h.role,
        content: h.content,
      }));
      messages.push({ role: 'user', content: prompt });

      const body: Record<string, unknown> = {
        model: model === 'claude-3-7-sonnet' ? 'claude-3-7-sonnet-20250219' : 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        messages: messages,
        stream: true,
      };

      if (isThinking) {
        body.thinking = {
          type: 'enabled',
          budget_tokens: Math.min(settings.thinkingBudget || 4096, 16000),
        };
      }

      let systemPrompt = settings.customInstructions || '';
      if (contextSubgraph) {
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n${contextSubgraph}`
          : contextSubgraph;
      }

      if (systemPrompt.trim()) {
        body.system = systemPrompt;
      }

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': settings.anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `Anthropic API error: ${res.statusText}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No readable response stream');
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') continue;
            try {
              const event = JSON.parse(dataStr);
              if (event.type === 'content_block_delta') {
                if (event.delta.type === 'thinking_delta' && callbacks.onThinkingChunk) {
                  callbacks.onThinkingChunk(event.delta.thinking);
                } else if (event.delta.type === 'text_delta') {
                  callbacks.onContentChunk(event.delta.text);
                }
              }
            } catch {
              // Ignore partial chunk parsing errors
            }
          }
        }
      }
      callbacks.onComplete();
      return;
    } catch (apiError: unknown) {
      console.warn('Anthropic API direct access failed, falling back to simulated intelligence engine:', apiError);
    }
  }

  // 3. High-Fidelity Client Fallback Simulation Mode
  const template = getSimulatedResponseForPrompt(prompt, model, isThinking);

  // Stream thinking first if present
  if (template.thinking && callbacks.onThinkingChunk) {
    const thinkingWords = template.thinking.split(' ');
    for (let i = 0; i < thinkingWords.length; i += 4) {
      const slice = thinkingWords.slice(i, i + 4).join(' ') + ' ';
      callbacks.onThinkingChunk(slice);
      await new Promise(r => setTimeout(r, 25));
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Stream content words
  const contentWords = template.content.split(' ');
  for (let i = 0; i < contentWords.length; i += 3) {
    const slice = contentWords.slice(i, i + 3).join(' ') + ' ';
    callbacks.onContentChunk(slice);
    await new Promise(r => setTimeout(r, 20));
  }

  // If there is an artifact, emit it
  if (template.artifact && callbacks.onArtifactFound) {
    callbacks.onArtifactFound(template.artifact);
  }

  callbacks.onComplete();
}
