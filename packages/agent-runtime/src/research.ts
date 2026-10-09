import { ToolRegistry, ToolCall } from '../../tool-runtime/src/index.js';
import { Citation } from '../../contracts/src/index.js';
import { BrainV2KnowledgeEngine } from '../../knowledge/src/index.js';

export interface ResearchOptions {
  prompt: string;
  runId: string;
}

export interface ResearchResult {
  citations: Citation[];
  freshnessRequired: boolean;
  providerReady: boolean;
  toolCalls: ToolCall[];
}

export class ResearchService {
  constructor(
    private toolRegistry: ToolRegistry,
    private knowledgeEngine: BrainV2KnowledgeEngine
  ) {}

  public isFreshnessRequired(prompt: string): boolean {
    const text = prompt.toLowerCase();
    const temporalKeywords = [
      'today', 'currently', 'current', 'latest', 'recent', 'recently',
      'this week', 'this month', 'new', 'newest', 'as of now', 'right now',
      'current price', 'current status', 'latest collection', 'latest news',
      'latest release', 'latest version'
    ];
    return temporalKeywords.some(kw => text.includes(kw));
  }

  public async executeResearch(options: ResearchOptions): Promise<ResearchResult> {
    const { prompt, runId } = options;
    const freshnessRequired = this.isFreshnessRequired(prompt);
    
    // Check provider capability
    // In our system, web_search tool capability requires BRAVE_SEARCH_API_KEY
    const isBraveConfigured = !!process.env.BRAVE_SEARCH_API_KEY;
    let providerReady = isBraveConfigured;

    let citations: Citation[] = [];
    const toolCalls: ToolCall[] = [];
    const timestamp = Date.now();

    // 1. Freshness required - use live tools
    if (freshnessRequired) {
      if (providerReady) {
        // Execute real live web search tool
        const toolDef = this.toolRegistry.get('web_search')?.definition;
        const toolCall: ToolCall = {
          id: `call_${Date.now()}_research`,
          toolId: toolDef?.id || 'tool_web_search',
          name: 'web_search',
          arguments: { query: prompt },
          timestamp
        };
        toolCalls.push(toolCall);
        
        try {
          const result = await this.toolRegistry.execute(toolCall, {
            runId,
            workspaceRoot: process.cwd(),
            sessionGrantedTools: new Set<string>()
          });
          const output = result.output;
          if (!result.isError && output && typeof output === 'object' && Array.isArray((output as any).results)) {
            const searchResults = (output as any).results as Array<{ title?: string; url?: string; snippet?: string; description?: string }>;
            citations = searchResults
              .filter(res => typeof res.url === 'string' && /^https?:\/\//.test(res.url))
              .map((res, idx) => ({
                id: `live_${timestamp}_${idx}`,
                sourceId: `web_${idx}`,
                sourceTitle: res.title || 'Live Search Result',
                uri: res.url!,
                snippet: res.snippet || res.description || '',
                score: 1.0,
                provenance: {
                  toolCallId: toolCall.id,
                  retrievalMechanism: 'web_search',
                  timestamp
                }
              }));
            // A configured API key alone does not prove that evidence was retrieved.
            providerReady = citations.length > 0;
          } else {
            providerReady = false;
          }
        } catch {
          // Fail closed on network/provider errors. Do not invent research evidence.
          providerReady = false;
        }
      }
    } else {
      // 2. Not freshness sensitive - use internal knowledge engine + live search as fallback
      const internalResults = await this.knowledgeEngine.search(prompt, 3);
      citations = internalResults.map(r => r.citation);
    }

    return {
      citations,
      freshnessRequired,
      providerReady,
      toolCalls
    };
  }
}
