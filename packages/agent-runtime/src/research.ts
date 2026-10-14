import { ToolRegistry } from '../../tool-runtime/src/index.js';
import { Citation, ToolCall, ToolResult, ExecutionPrincipal } from '../../contracts/src/index.js';
import { BrainV2KnowledgeEngine } from '../../knowledge/src/index.js';
import { configuredSearchProviders } from '../../tool-runtime/src/search-providers.js';
import { evaluateFreshness } from './behavioral/semantic-reasoner.js';
import {
  normalizeSourceTitle,
  normalizeSnippetText,
  rankAndFilterWeatherCitations,
  evaluateEvidenceSufficiency,
  buildTargetedSearchQuery
} from './research-evidence.js';

export interface ResearchOptions {
  prompt: string;
  runId: string;
  topic?: string;
  location?: string;
  principal?: ExecutionPrincipal;
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
    return evaluateFreshness(prompt).requiresFreshness;
  }

  public async executeResearch(options: ResearchOptions): Promise<ResearchResult> {
    const { prompt, runId, topic, location } = options;
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
                sourceTitle: normalizeSourceTitle(res.title || 'Live Search Result'),
                uri: res.url!,
                ...(res.publishedDate ? { publishedDate: res.publishedDate } : {}),
                snippet: normalizeSnippetText(res.snippet || res.description || ''),
                score: 1.0,
                provenance: {
                  toolCallId: toolCall.id,
                  retrievalMechanism: 'web_search',
                  timestamp
                }
              }));

            // Bounded Stage-2 Targeted Search for explicit factual questions lacking sufficient evidence (including zero-result initial searches)
            const sufficiency = evaluateEvidenceSufficiency(prompt, citations);
            if (!sufficiency.isSufficient && sufficiency.missingDimension) {
              const targetedQuery = buildTargetedSearchQuery(prompt, topic || 'GENERAL', sufficiency.missingDimension);
              if (targetedQuery && targetedQuery !== prompt) {
                const timestamp2 = Date.now();
                const toolCall2: ToolCall = {
                  id: `call_${timestamp2}_targeted`,
                  toolId: toolDef?.id || 'tool_web_search',
                  name: 'web_search',
                  arguments: { query: targetedQuery },
                  timestamp: timestamp2
                };
                toolCalls.push(toolCall2);
                try {
                  const result2 = await this.toolRegistry.execute(toolCall2, {
                    runId,
                    workspaceRoot: process.cwd(),
                    sessionGrantedTools: new Set<string>()
                  });
                  toolResults.push(result2);
                  const output2 = result2.output;
                  if (!result2.isError && output2 && typeof output2 === 'object' && Array.isArray((output2 as any).results)) {
                    const stage2Results = (output2 as any).results as Array<{ title?: string; url?: string; snippet?: string; description?: string; publishedDate?: string }>;
                    const stage2Citations = stage2Results
                      .filter(res => typeof res.url === 'string' && /^https?:\/\//.test(res.url))
                      .map((res, idx) => ({
                        id: `live_s2_${timestamp2}_${idx}`,
                        sourceId: `web_s2_${idx}`,
                        sourceTitle: normalizeSourceTitle(res.title || 'Live Search Result'),
                        uri: res.url!,
                        ...(res.publishedDate ? { publishedDate: res.publishedDate } : {}),
                        snippet: normalizeSnippetText(res.snippet || res.description || ''),
                        score: 1.0,
                        provenance: {
                          toolCallId: toolCall2.id,
                          retrievalMechanism: 'web_search',
                          timestamp: timestamp2
                        }
                      }));

                    // Merge Stage-2 authoritative summary pages with Stage-1 hits, de-duplicating by URL
                    const seenUrls = new Set<string>();
                    const merged: Citation[] = [];
                    for (const c of [...stage2Citations, ...citations]) {
                      try {
                        const u = new URL(c.uri).href;
                        if (!seenUrls.has(u)) {
                          seenUrls.add(u);
                          merged.push(c);
                        }
                      } catch {}
                    }
                    citations = merged.slice(0, 5);
                  }
                } catch {
                  // Gracefully retain initial stage citations on secondary search error
                }
              }
            }

            // Weather Operational Ranking: filter seasonal climate/tourism pages
            if (topic === 'WEATHER' || /\b(?:weather|forecast|temperature)\b/i.test(prompt)) {
              citations = rankAndFilterWeatherCitations(citations, location);
            }

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
      const scope = options.principal ? { principalId: options.principal.userId, workspaceId: options.principal.workspaceId, isSystem: false } : undefined;
      const internalResults = await this.knowledgeEngine.search(prompt, 3, scope);
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
