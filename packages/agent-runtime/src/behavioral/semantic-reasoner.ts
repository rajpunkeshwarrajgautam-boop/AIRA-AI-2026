import {
  IntentTaxonomy,
  SideEffectLevel
} from '../../contracts/src/index.js';
import {
  SemanticIntentAnalysis
} from '../../contracts/src/behavioral.js';
import { ModelRouter } from '../../model-router/src/index.js';

export interface SemanticReasonerInput {
  prompt: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  advisoryIntent?: IntentTaxonomy;
  sideEffectLevel?: SideEffectLevel;
}

export class SemanticReasoner {
  constructor(private modelRouter?: ModelRouter) {}

  /**
   * Analyzes prompt semantics using a 3-tier hybrid reasoning architecture:
   * Tier 1: Deterministic safe fast-paths (<1ms, zero LLM cost) for greetings, calculations, commands.
   * Tier 2: Context-aware model classification for ambiguous, multi-turn, or nuanced requests.
   * Tier 3: Safe uncertainty handling with graceful non-privileged fallbacks.
   */
  public async analyze(input: SemanticReasonerInput): Promise<SemanticIntentAnalysis> {
    const rawPrompt = (input.prompt || '').trim();
    const promptLower = rawPrompt.toLowerCase();
    const history = input.conversationHistory || [];

    // 1. Contextual Referent Resolution
    const contextualReferents = this.resolveReferents(rawPrompt, history);

    // 2. Multi-Part Decomposition
    const subTasks = this.decomposeMultiPart(rawPrompt);
    const isMultiPart = subTasks.length > 1;

    // 3. Explanation vs Execution Differentiation
    const isExplanationOnly = this.isExplanationIntent(promptLower);
    const isExecutionRequested = this.isExecutionIntent(promptLower);

    // 4. Tier 1: Deterministic Safe Fast Path Evaluation
    const fastPathResult = this.evaluateFastPath(
      rawPrompt,
      promptLower,
      history,
      contextualReferents,
      isExplanationOnly,
      isExecutionRequested,
      input.sideEffectLevel,
      input.advisoryIntent
    );

    if (fastPathResult) {
      return {
        ...fastPathResult,
        isExplanationOnly,
        isExecutionRequested,
        contextualReferents,
        isMultiPart,
        subTasks: isMultiPart ? subTasks : [],
        fastPathUsed: true
      } as SemanticIntentAnalysis;
    }

    // 5. Follow-Up Contextual Resolution (e.g. "Now make it faster", "Can you improve it?")
    if (this.isFollowUp(promptLower) && history.length > 0) {
      const inheritedIntent = this.resolveFollowUpIntent(history);
      return {
        primaryIntent: inheritedIntent,
        secondaryIntents: [],
        isExplanationOnly: isExplanationOnly || inheritedIntent === 'ANSWER',
        isExecutionRequested: !isExplanationOnly && inheritedIntent !== 'ANSWER',
        contextualReferents,
        isMultiPart,
        subTasks: isMultiPart ? subTasks : [],
        confidence: 0.92,
        reasoningStrategy: 'CHAIN_OF_THOUGHT',
        fastPathUsed: false
      };
    }

    // 6. Tier 2: Context-Aware Semantic Model Classification
    if (this.modelRouter && this.modelRouter.listProviders().length > 0 && rawPrompt.length > 10) {
      try {
        const modelAnalysis = await this.classifyWithModel(
          rawPrompt,
          history,
          contextualReferents,
          subTasks,
          isExplanationOnly,
          isExecutionRequested
        );
        if (modelAnalysis) {
          return modelAnalysis;
        }
      } catch {
        // Fall through to Tier 3 on model timeout or parsing failure
      }
    }

    // 7. Tier 3: Safe Uncertainty Fallback
    const isHypotheticalOrQuestion = /^(what\s+if|could\s+you\s+describe|how\s+would|can\s+we\s+discuss)\b/i.test(promptLower);
    const needsClarification = promptLower.length < 15 && /^(help|build|run|test|deploy)$/i.test(promptLower);

    return {
      primaryIntent: 'ANSWER',
      secondaryIntents: isMultiPart ? ['RESEARCH'] : [],
      isExplanationOnly: true,
      isExecutionRequested: false,
      contextualReferents,
      isMultiPart,
      subTasks: isMultiPart ? subTasks : [],
      confidence: isHypotheticalOrQuestion ? 0.88 : (needsClarification ? 0.60 : 0.75),
      reasoningStrategy: needsClarification ? 'CLARIFY_AMBIGUOUS' : 'FAST_DIRECT',
      fastPathUsed: false,
      clarificationPrompt: needsClarification
        ? 'Could you clarify whether you would like an explanation or to execute a specific task in the workspace?'
        : undefined
    };
  }

  private async classifyWithModel(
    prompt: string,
    history: Array<{ role: string; content: string }>,
    contextualReferents: Record<string, string>,
    subTasks: string[],
    isExplanationOnly: boolean,
    isExecutionRequested: boolean
  ): Promise<SemanticIntentAnalysis | null> {
    if (!this.modelRouter) return null;

    const historySummary = history.slice(-4).map(h => `${h.role}: ${h.content.slice(0, 160)}`).join('\n');
    const promptText = `Classify this user prompt into exactly ONE primary intent for an AI agent operating system.
Options: ANSWER, RESEARCH, TOOL_ACTION, WORKFLOW, AUTOMATION_CREATE, AGENT_MISSION.
Also specify if it is explanation-only (describing, conceptualizing, explaining) vs execution-requested (actually performing, running, deploying).

User prompt: "${prompt.slice(0, 300).replace(/"/g, '\\"')}"
${historySummary ? `Recent History:\n${historySummary}` : ''}

Respond with valid JSON only:
{
  "primaryIntent": "ANSWER",
  "secondaryIntents": [],
  "isExplanationOnly": true,
  "isExecutionRequested": false,
  "confidence": 0.90,
  "reasoningStrategy": "CHAIN_OF_THOUGHT"
}`;

    const policy = this.modelRouter.resolvePolicy('aira-fast', 'ANSWER');
    const adapter = this.modelRouter.getAdapter(policy);

    const result = await adapter.complete([
      { role: 'system', content: 'You are a strict JSON intent classifier.' },
      { role: 'user', content: promptText }
    ], policy);

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const validIntents: IntentTaxonomy[] = ['ANSWER', 'RESEARCH', 'TOOL_ACTION', 'WORKFLOW', 'AUTOMATION_CREATE', 'AGENT_MISSION'];
    if (!validIntents.includes(parsed.primaryIntent)) return null;

    return {
      primaryIntent: parsed.primaryIntent,
      secondaryIntents: Array.isArray(parsed.secondaryIntents) ? parsed.secondaryIntents.filter((i: any) => validIntents.includes(i)) : [],
      isExplanationOnly: typeof parsed.isExplanationOnly === 'boolean' ? parsed.isExplanationOnly : isExplanationOnly,
      isExecutionRequested: typeof parsed.isExecutionRequested === 'boolean' ? parsed.isExecutionRequested : isExecutionRequested,
      contextualReferents,
      isMultiPart: subTasks.length > 1,
      subTasks,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0.1, Math.min(1.0, parsed.confidence)) : 0.85,
      reasoningStrategy: parsed.reasoningStrategy || 'CHAIN_OF_THOUGHT',
      fastPathUsed: false
    };
  }

  private resolveReferents(
    prompt: string,
    history: Array<{ role: string; content: string }>
  ): Record<string, string> {
    const referents: Record<string, string> = {};
    const lower = prompt.toLowerCase();

    // Check for pronoun referents
    const hasIt = /\b(it|that|this|the same)\b/.test(lower);
    if (hasIt && history.length > 0) {
      // Search across the recent conversation history
      const recentHistoryText = history.slice(-4).map(h => h.content).join('\n');
      if (/\b(bubble_sort|bubble\s+sort|sort|algorithm|function|def\s+|code|script)\b/i.test(recentHistoryText)) {
        referents['it'] = 'the previously provided algorithm/code';
      } else if (/\b(database|postgres|sql|query|schema)\b/i.test(recentHistoryText)) {
        referents['it'] = 'the database query/schema';
      } else if (/\b(document|report|brief|article|essay|text)\b/i.test(recentHistoryText)) {
        referents['it'] = 'the previously generated document';
      } else if (/\b(application|app|service|frontend|api)\b/i.test(recentHistoryText)) {
        referents['it'] = 'the application';
      } else {
        referents['it'] = 'the previous subject';
      }
    }

    return referents;
  }

  private decomposeMultiPart(prompt: string): string[] {
    // Detect conjunctions or clause separators connecting independent imperative clauses
    // e.g. "Calculate 1024 * 4 and also research solar cell records"
    // e.g. "Inspect workspace files, check git status, and summarize repo history."
    const parts = prompt.split(/\b(?:and\s+also|and\s+then|additionally|also)\b|,\s*(?:and\s+)?/i);
    if (parts.length > 1 && parts.every(p => p.trim().length > 5)) {
      return parts.map(p => p.trim());
    }
    return [];
  }

  private isExplanationIntent(promptLower: string): boolean {
    // Queries asking for explanation, concepts, theory, steps, guides without executing
    const explanationPatterns = [
      /^(explain|what\s+is|what\s+are|how\s+does|how\s+do|why\s+is|why\s+do|describe|define)\b/,
      /\bexplain\s+(how|why|what|the\s+difference)\b/,
      /\bhow\s+(is|are)\s+.*built\b/,
      /\bhow\s+an\s+application\s+is\s+built\b/,
      /\bwhat\s+if\s+we\s+built\b/,
      /\bcould\s+you\s+describe\s+how\s+you\s+would\s+deploy\b/,
      /\bguide\s+to\b/,
      /\boverview\s+of\b/
    ];
    return explanationPatterns.some(p => p.test(promptLower));
  }

  private isExecutionIntent(promptLower: string): boolean {
    // Requests demanding real system or environment action
    const executionPatterns = [
      /\b(build\s+(an?\s+)?application\s+and\s+show\s+me)\b/,
      /\b(build\s+a\s+website\s+and\s+preview\s+it)\b/,
      /\b(deploy\s+this\s+now)\b/,
      /\b(run|execute|trigger|start|deploy|compile)\b/,
      /\b(open\s+https?:\/\/|navigate\s+to)\b/,
      /\b(fix\s+it\s+and\s+verify|repair\s+the\s+repo)\b/,
      /\b(inspect|check|examine|investigate|audit)\s+(the\s+)?(workspace|repo|repository|codebase|files|git|status)\b/,
      /\b(calculate|calc)\s+[0-9]/,
      /\b(schedule|create\s+automation)\b/
    ];
    return executionPatterns.some(p => p.test(promptLower));
  }

  private evaluateFastPath(
    rawPrompt: string,
    promptLower: string,
    history: Array<{ role: string; content: string }>,
    contextualReferents: Record<string, string>,
    isExplanationOnly: boolean,
    isExecutionRequested: boolean,
    sideEffectLevel?: SideEffectLevel,
    advisoryIntent?: IntentTaxonomy
  ): Partial<SemanticIntentAnalysis> | null {
    // Fast Path A: Trivial Greetings & Pleasantries (Zero Extra Model Calls)
    if (/^(hi|hello|hey|good\s+(morning|afternoon|evening)|howdy|greetings|thanks|thank\s+you)[!.?]?$/i.test(promptLower)) {
      return {
        primaryIntent: 'ANSWER',
        secondaryIntents: [],
        confidence: 0.99,
        reasoningStrategy: 'FAST_DIRECT'
      };
    }

    // Fast Path B: Destructive Commands Mandatory Gate
    if (sideEffectLevel === 'DESTRUCTIVE' || /\b(rm\s+-rf|drop\s+database|format\s+[a-z]:?|delete\s+all)\b/i.test(promptLower)) {
      return {
        primaryIntent: 'TOOL_ACTION',
        secondaryIntents: [],
        confidence: 0.99,
        reasoningStrategy: 'FAST_DIRECT'
      };
    }

    // Fast Path C: Explanation vs Execution Nuance
    // If clearly explanation only and no execution requested, and not explicitly routed to specialized mode:
    if (isExplanationOnly && !isExecutionRequested && (!advisoryIntent || advisoryIntent === 'ANSWER')) {
      return {
        primaryIntent: 'ANSWER',
        secondaryIntents: [],
        confidence: 0.97,
        reasoningStrategy: 'FAST_DIRECT'
      };
    }

    // Fast Path D: Scheduled Automations
    const isAutomation = (
      /\b(every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|day|morning|night|week|month|hour)|schedule\s+.*(job|automation|task|run|check|backup)|create\s+(an?\s+)?automation|cron\s+expression)\b/i.test(promptLower) ||
      (advisoryIntent === 'AUTOMATION_CREATE')
    );
    if (isAutomation) {
      return {
        primaryIntent: 'AUTOMATION_CREATE',
        secondaryIntents: [],
        confidence: 0.96,
        reasoningStrategy: 'FAST_DIRECT'
      };
    }

    // Fast Path E: Workflows (Multi-step DAG pipelines)
    const isMultiStepPipeline = (
      /\b(research|investigate|study)\b/i.test(promptLower) &&
      /\b(summarize|extract|analyze)\b/i.test(promptLower) &&
      /\b(report|brief|synthesize|document|whitepaper)\b/i.test(promptLower)
    );
    const isWorkflow = isMultiStepPipeline || /\b(run|execute|trigger|start)\s+(the\s+|my\s+)?([a-z\s_-]+)?(workflow|pipeline|dag)\b/i.test(promptLower) ||
      (advisoryIntent === 'WORKFLOW');
    if (isWorkflow) {
      return {
        primaryIntent: 'WORKFLOW',
        secondaryIntents: ['RESEARCH', 'TOOL_ACTION'],
        confidence: 0.95,
        reasoningStrategy: 'DECOMPOSE_DAG'
      };
    }

    // Fast Path F: Agent Missions (Autonomous multi-step coding/repair)
    const isAgentMission = (
      /\b(investigate\s+(this\s+|the\s+|repository\s+)?(bug|system|repo|project|codebase|test\s+failures?|failures?|issue)|inspect\s+(the\s+)?(workspace(\s+files)?|repo|repository|codebase)|mission\s+plan|agent\s+mission|autonomous\s+mission|execute\s+mission|build\s+(an?\s+)?application|build\s+a\s+website\s+and\s+preview|fix\s+(the\s+)?failing\s+tests|verify\s+the\s+build)\b/i.test(promptLower) ||
      (advisoryIntent === 'AGENT_MISSION' && rawPrompt.length > 10)
    );
    if (isAgentMission) {
      return {
        primaryIntent: 'AGENT_MISSION',
        secondaryIntents: ['TOOL_ACTION'],
        confidence: 0.94,
        reasoningStrategy: 'CHAIN_OF_THOUGHT'
      };
    }

    // Fast Path G: Direct Tool Invocations
    const isConversationalMath = /\b(and\s+then\s+tell\s+me|then\s+tell\s+me|tell\s+me\s+if)\b/i.test(promptLower);
    if (isConversationalMath) {
      return {
        primaryIntent: 'ANSWER',
        secondaryIntents: [],
        confidence: 0.95,
        reasoningStrategy: 'FAST_DIRECT'
      };
    }

    const isMarkdownFormatting = /\bformat\s+(it|the\s+output|this)\s+as\s+(a\s+)?(markdown\s+)?table\b/i.test(promptLower);
    if (isMarkdownFormatting) {
      return {
        primaryIntent: 'ANSWER',
        secondaryIntents: [],
        confidence: 0.95,
        reasoningStrategy: 'FAST_DIRECT'
      };
    }

    const isTool = (
      /\b(simulate|execute|test|verify|run)\s+.*(tool|timeout|error|http\s+[0-9]{3}|failure|outage|idempotency|mutation|econnreset|fallback)\b/i.test(promptLower) ||
      /\b(tool\s+execution|tool\s+call|required\s+tool|payment\s+mutation|system\s+shell\s+command)\b/i.test(promptLower) ||
      /\b(modify\s+production\s+configuration|etc\/hosts)\b/i.test(promptLower) ||
      /\b(open\s+https?:\/\/|navigate\s+to|extract\s+the\s+table|tell\s+me\s+the\s+(page\s+)?heading|take\s+(a\s+)?screenshot)\b/i.test(promptLower) ||
      /\b(populate\s+form|fill\s+(in\s+)?form|submit\s+this\s+form|submit\s+form|click\s+button)\b/i.test(promptLower) ||
      /\b(calculate|calc)\s+[0-9+\-*/().^ ]+/i.test(promptLower) ||
      /\b(read\s+(file\s+)?[a-zA-Z0-9_\-./\\]+|list\s+directory|git\s+status|git\s+log|latest\s+commit|package\.json|branch\s+status)\b/i.test(promptLower) ||
      /\b(inspect|read|cat)\s+(file\s+)?[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+\b/i.test(promptLower) ||
      /\b(deploy\s+this\s+now|deploy\s+.*(container|cluster|service|production|staging))\b/i.test(promptLower)
    );
    if (isTool) {
      return {
        primaryIntent: 'TOOL_ACTION',
        secondaryIntents: [],
        confidence: 0.95,
        reasoningStrategy: 'FAST_DIRECT'
      };
    }

    // Fast Path H: Deep Research & Citations
    const isResearch = (
      /\b(research\s+(the\s+|latest\s+|recent\s+|advances\s+in\s+)?|deep\s+dive\s+into|investigate.*cite\s+sources|find\s+sources\s+and\s+compare)\b/i.test(promptLower) ||
      (advisoryIntent === 'RESEARCH')
    );
    if (isResearch) {
      return {
        primaryIntent: 'RESEARCH',
        secondaryIntents: [],
        confidence: 0.94,
        reasoningStrategy: 'CHAIN_OF_THOUGHT'
      };
    }

    return null;
  }

  private isFollowUp(promptLower: string): boolean {
    const followUpPatterns = [
      /^now\s+make\s+it\s+/i,
      /^make\s+it\s+(faster|cleaner|better|shorter|longer)/i,
      /^can\s+you\s+improve\s+(it|that)/i,
      /^what\s+about\s+(that|it)/i,
      /^why\s+did\s+that\s+happen/i,
      /^continue/i,
      /^now\s+add\s+/i
    ];
    return followUpPatterns.some(p => p.test(promptLower));
  }

  private resolveFollowUpIntent(history: Array<{ role: string; content: string }>): IntentTaxonomy {
    if (history.length === 0) return 'ANSWER';
    const lastUser = history.filter(h => h.role === 'user').slice(-1)[0]?.content.toLowerCase() || '';

    if (/\b(research|investigate\s+sources)\b/.test(lastUser)) {
      return 'RESEARCH';
    }
    if (/\b(workflow|pipeline)\b/.test(lastUser)) {
      return 'WORKFLOW';
    }
    if (/\b(git|run|execute|shell|deploy)\b/.test(lastUser)) {
      return 'TOOL_ACTION';
    }
    return 'ANSWER';
  }
}
