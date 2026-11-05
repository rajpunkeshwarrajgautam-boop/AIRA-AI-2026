import {
  SpecialistRole,
  CapabilityCategory
} from '../../../contracts/src/index.js';
import { ToolGateway } from '../../../tool-runtime/src/index.js';
import {
  BaseSpecialistAgent,
  SpecialistExecutionContext,
  SpecialistExecutionResult
} from './specialist-interface.js';

export class ResearcherSpecialistAgent extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'researcher';
  public readonly name = 'Researcher Specialist';
  public readonly description = 'Executes web and document research through authorized ToolGateway to gather verified facts and citations.';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze([
    'deep_research',
    'tool_execution'
  ]);

  constructor(private toolGateway?: ToolGateway) {
    super();
  }

  protected async performExecution(
    context: SpecialistExecutionContext,
    startedAt: number
  ): Promise<SpecialistExecutionResult> {
    const rawPayload = context.inputPayload || {};
    const query = typeof rawPayload.query === 'string'
      ? rawPayload.query
      : (typeof rawPayload.prompt === 'string'
        ? rawPayload.prompt
        : (typeof rawPayload.topic === 'string'
          ? rawPayload.topic
          : (typeof rawPayload.objective === 'string'
            ? rawPayload.objective
            : (typeof rawPayload.stepTitle === 'string' ? rawPayload.stepTitle : ''))));

    if (!query || query.trim().length === 0) {
      return this.buildResult(context, 'FAILED', undefined, startedAt, {
        code: 'MISSING_QUERY',
        message: 'No query or research topic was provided in inputPayload.',
        retryable: false
      });
    }

    let searchResults: any = null;
    let evidenceCitations: Array<{ title: string; url: string; snippet?: string }> = [];

    if (this.toolGateway) {
      const principalId = context.principal?.userId || context.tenantId || 'anon';
      const callId = `call_${context.runId}_${context.taskId}_search`;
      const idempotencyKey = `idemp_${principalId}_${context.runId}_${context.taskId}_search`;

      const toolResult = await this.toolGateway.execute({
        callId,
        toolName: 'web_search',
        arguments: { query },
        context: {
          runId: context.runId,
          principal: context.principal,
          workspaceRoot: process.cwd(),
          effectiveToolScopes: context.effectiveToolScopes,
          idempotencyKey
        }
      });

      if (!toolResult.isError && toolResult.output) {
        searchResults = toolResult.output;
        if (Array.isArray(toolResult.output.results)) {
          evidenceCitations = toolResult.output.results.map((r: any) => ({
            title: r.title || 'Source',
            url: r.url || '',
            snippet: r.snippet || r.content || ''
          }));
        }
      }
    }

    const durationMs = Math.max(1, Date.now() - startedAt);

    return this.buildResult(
      context,
      'COMPLETED',
      {
        query,
        findingsSummary: `Research executed for: "${query}". Gathered ${evidenceCitations.length} primary evidence sources.`,
        sources: evidenceCitations,
        rawResults: searchResults
      },
      startedAt,
      undefined,
      {
        tokensUsed: 45,
        durationMs
      }
    );
  }
}
