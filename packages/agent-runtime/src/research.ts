import { ToolRegistry } from '../../tool-runtime/src/index.js';
import { Citation, ToolCall, ToolResult } from '../../contracts/src/index.js';
import { BrainV2KnowledgeEngine } from '../../knowledge/src/index.js';
import { configuredSearchProviders } from '../../tool-runtime/src/search-providers.js';

export interface ResearchOptions {
  prompt: string;
  runId: string;
}

export interface ResearchResult {
  citations: Citation[];
  freshnessRequired: boolean;
  providerReady: boolean;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
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
    
    // Availability is dynamic, but providerReady becomes true only after verified results.
    let providerReady = configuredSearchProviders().length > 0;

    let citations: Citation[] = [];
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    const timestamp = Date.now();

    // Every configured Research run attempts live evidence, not only temporal prompts.
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
          toolResults.push(result);
          const output = result.output;
          if (!result.isError && output && typeof output === 'object' && Array.isArray((output as any).results)) {
            const searchResults = (output as any).results as Array<{ title?: string; url?: string; snippet?: string; description?: string; publishedDate?: string }>;
            citations = searchResults
              .filter(res => typeof res.url === 'string' && /^https?:\/\//.test(res.url))
              .map((res, idx) => ({
                id: `live_${timestamp}_${idx}`,
                sourceId: `web_${idx}`,
                sourceTitle: res.title || 'Live Search Result',
                uri: res.url!,
                ...(res.publishedDate ? { publishedDate: res.publishedDate } : {}),
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
    // Only use internal evidence for non-freshness queries when live search
    // is unconfigured or unavailable. Never invent live sources.
    if (!providerReady && !freshnessRequired) {
      const internalResults = await this.knowledgeEngine.search(prompt, 3);
      citations = internalResults.map(r => r.citation);
    }

    return {
      citations,
      freshnessRequired,
      providerReady,
      toolCalls,
      toolResults
    };
  }
}
