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
   * Tier 1: Deterministic safe fast-paths (<1ms, zero LLM cost) for greetings, calculations, commands, and freshness-sensitive research.
   * Tier 2: Context-aware model classification for ambiguous, multi-turn, or nuanced requests.
   * Tier 3: Safe uncertainty handling with graceful non-privileged fallbacks.
   */
  public async analyze(input: SemanticReasonerInput): Promise<SemanticIntentAnalysis> {
    const rawPrompt = (input.prompt || '').trim();
    const promptLower = rawPrompt.toLowerCase();
    const history = input.conversationHistory || [];

    // 1. Contextual Referent Resolution
    const contextualReferents = this.resolveReferents(rawPrompt, history);

    // 2. Freshness & Time-Sensitive Information Evaluation
    const freshnessEval = evaluateFreshness(rawPrompt, history, contextualReferents);

    // 3. Multi-Part Decomposition
    const subTasks = this.decomposeMultiPart(rawPrompt);
    const isMultiPart = subTasks.length > 1;

    // 4. Explanation vs Execution Differentiation
    // If live freshness is required, the query demands external facts, not timeless conceptual explanation.
    const isExplanationOnly = !freshnessEval.requiresFreshness && this.isExplanationIntent(promptLower);
    const isExecutionRequested = this.isExecutionIntent(promptLower);

    // 5. Tier 1: Deterministic Safe Fast Path Evaluation
    const fastPathResult = this.evaluateFastPath(
      rawPrompt,
      promptLower,
      history,
      contextualReferents,
      freshnessEval,
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
        isFreshnessRequired: fastPathResult.isFreshnessRequired ?? freshnessEval.requiresFreshness,
        detectedSubject: (fastPathResult as any).detectedSubject ?? freshnessEval.detectedSubject,
        topic: (fastPathResult as any).topic ?? freshnessEval.topic,
        contextualReferents,
        isMultiPart,
        subTasks: isMultiPart ? subTasks : [],
        fastPathUsed: true
      } as SemanticIntentAnalysis;
    }

    // 6. Follow-Up Contextual Resolution (e.g. "Now make it faster", "Can you improve it?")
    if (this.isFollowUp(promptLower) && history.length > 0) {
      const inheritedIntent = this.resolveFollowUpIntent(history);
      return {
        primaryIntent: inheritedIntent,
        secondaryIntents: [],
        isExplanationOnly: isExplanationOnly || inheritedIntent === 'ANSWER',
        isExecutionRequested: !isExplanationOnly && inheritedIntent !== 'ANSWER',
        isFreshnessRequired: freshnessEval.requiresFreshness,
        contextualReferents,
        isMultiPart,
        subTasks: isMultiPart ? subTasks : [],
        confidence: 0.92,
        reasoningStrategy: 'CHAIN_OF_THOUGHT',
        fastPathUsed: false
      };
    }

    // 7. Tier 2: Context-Aware Semantic Model Classification
    if (this.modelRouter && this.modelRouter.listProviders().length > 0 && rawPrompt.length > 10) {
      try {
        const modelAnalysis = await this.classifyWithModel(
          rawPrompt,
          history,
          contextualReferents,
          subTasks,
          isExplanationOnly,
          isExecutionRequested,
          freshnessEval.requiresFreshness
        );
        if (modelAnalysis) {
          return modelAnalysis;
        }
      } catch {
        // Fall through to Tier 3 on model timeout or parsing failure
      }
    }

    // 8. Tier 3: Safe Uncertainty Fallback
    const isHypotheticalOrQuestion = /^(what\s+if|could\s+you\s+describe|how\s+would|can\s+we\s+discuss)\b/i.test(promptLower);
    const needsClarification = promptLower.length < 15 && /^(help|build|run|test|deploy)$/i.test(promptLower);

    return {
      primaryIntent: 'ANSWER',
      secondaryIntents: isMultiPart ? ['RESEARCH'] : [],
      isExplanationOnly: true,
      isExecutionRequested: false,
      isFreshnessRequired: freshnessEval.requiresFreshness,
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
    isExecutionRequested: boolean,
    isFreshnessRequired: boolean
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
  "isFreshnessRequired": ${isFreshnessRequired},
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
      isFreshnessRequired: typeof parsed.isFreshnessRequired === 'boolean' ? parsed.isFreshnessRequired : isFreshnessRequired,
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
    const hasIt = /\b(it|that|this|the same|its|their|there)\b/.test(lower);
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

    // Extract financial entities and locations across history to resolve multi-turn references
    if (history.length > 0) {
      const recentHistoryText = history.slice(-4).map(h => h.content).join('\n');
      const companyMatch = recentHistoryText.match(/\b(nvidia|nvda|apple|aapl|microsoft|msft|google|googl|alphabet|amazon|amzn|tesla|tsla|meta|netflix|nflx|amd|intel|intc|tsmc|openai|anthropic|bitcoin|btc|ethereum|eth|solana|sol)\b/i);
      if (companyMatch) {
        referents['company'] = companyMatch[1];
        if (/\b(its|their|the\s+stock|the\s+share)\b/i.test(lower) || (hasIt && !referents['it'])) {
          referents['it'] = companyMatch[1];
        }
      }

      const cityMatch = recentHistoryText.match(/\b(tokyo|paris|london|new\s+york|berlin|san\s+francisco|seattle|chicago|los\s+angeles|sydney|toronto|mumbai|singapore|dubai)\b/i);
      if (cityMatch) {
        referents['location'] = cityMatch[1];
        if (/\bthere\b/i.test(lower)) {
          referents['there'] = cityMatch[1];
        }
      }

      const movieMatch = recentHistoryText.match(/\b(avatar|dune|oppenheimer|barbie|wicked|gladiator|marvel|batman|superman|spider-man|star\s+wars|deadpool)\b/i);
      if (movieMatch) {
        referents['movie'] = movieMatch[1];
        if (/\b(its|their|the\s+movie|the\s+film|box\s+office)\b/i.test(lower) || (hasIt && !referents['it'])) {
          referents['it'] = movieMatch[1];
        }
      }

      // Check if immediate prior turn was an assistant clarification
      const lastAssistant = history.filter(h => h.role === 'assistant').slice(-1)[0]?.content || '';
      if (lastAssistant) {
        if (/(?:company\s+or\s+(?:stock\s+)?ticker|share\s+price)/i.test(lastAssistant)) {
          referents['company'] = prompt.trim();
          referents['subject'] = prompt.trim();
        } else if (/(?:city\s+or\s+location|weather\s+forecast)/i.test(lastAssistant)) {
          referents['location'] = prompt.trim();
          referents['subject'] = prompt.trim();
        } else if (/(?:which\s+movie|box\s+office)/i.test(lastAssistant)) {
          referents['movie'] = prompt.trim();
          referents['subject'] = prompt.trim();
        }
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
    freshnessEval: FreshnessEvaluation,
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
        reasoningStrategy: 'FAST_DIRECT',
        isFreshnessRequired: false
      };
    }

    // Fast Path B: Destructive Commands Mandatory Gate
    if (sideEffectLevel === 'DESTRUCTIVE' || /\b(rm\s+-rf|drop\s+database|format\s+[a-z]:?|delete\s+all)\b/i.test(promptLower)) {
      return {
        primaryIntent: 'TOOL_ACTION',
        secondaryIntents: [],
        confidence: 0.99,
        reasoningStrategy: 'FAST_DIRECT',
        isFreshnessRequired: false
      };
    }

    // Context-free booking references must be clarified before tool selection.
    // A missing referent is not a reason to execute research or make reservations.
    // Existing conversation history is deliberately left to contextual resolution.
    const unidentifiedBooking = history.length === 0 &&
      /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:book|reserve)\s+(?:it|that|this)\b/i.test(promptLower);
    if (unidentifiedBooking) {
      return {
        primaryIntent: 'ANSWER',
        secondaryIntents: [],
        confidence: 0.98,
        reasoningStrategy: 'CLARIFY_AMBIGUOUS',
        clarificationPrompt: 'What would you like me to book or reserve? Please identify the place, appointment, or service.',
        isFreshnessRequired: false
      };
    }

    // Fast Path C: Automation Management (Delete/Cancel/Disable scheduled jobs)
    const isAutomationManagement = /\b(delete|cancel|remove|stop|disable|drop)\s+.*(automation|job|task|cron|workflow)\b/i.test(promptLower);
    if (isAutomationManagement) {
      return {
        primaryIntent: 'TOOL_ACTION',
        secondaryIntents: [],
        confidence: 0.97,
        reasoningStrategy: 'FAST_DIRECT',
        isFreshnessRequired: false
      };
    }

    // Fast Path D: Scheduled Automations (Creation & Scheduling)
    const isAutomation = (
      /\b(every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|day|morning|night|week|month|hour)|(?:run|execute|schedule)\s+(an?\s+)?(?:daily|weekly|hourly|monthly)\s+(?:job|task|check|run|automation)|schedule\s+.*(job|automation|task|run|check|backup)|create\s+(an?\s+)?automation|setup\s+(an?\s+)?automation|cron\s+expression)\b/i.test(promptLower) ||
      (advisoryIntent === 'AUTOMATION_CREATE')
    );
    if (isAutomation) {
      return {
        primaryIntent: 'AUTOMATION_CREATE',
        secondaryIntents: [],
        confidence: 0.96,
        reasoningStrategy: 'FAST_DIRECT',
        isFreshnessRequired: freshnessEval.requiresFreshness
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
        reasoningStrategy: 'DECOMPOSE_DAG',
        isFreshnessRequired: freshnessEval.requiresFreshness
      };
    }

    // Fast Path F: Agent Missions (Autonomous multi-step coding/repair)
    const isAgentMission = (
      /\b(investigate\s+.*(bug|failure|failing|deployment|build|pipeline|ci|issue|incident|repo|codebase|system)|fix\s+.*(source\s+code|code|repo|tests?|implementation)|inspect\s+(the\s+)?(workspace(\s+files)?|repo|repository|codebase)|mission\s+plan|agent\s+mission|autonomous\s+mission|execute\s+mission|build\s+(an?\s+)?application|build\s+a\s+website\s+and\s+preview|fix\s+(the\s+)?failing\s+tests|verify\s+the\s+build)\b/i.test(promptLower) ||
      (advisoryIntent === 'AGENT_MISSION' && rawPrompt.length > 10)
    );
    if (isAgentMission) {
      return {
        primaryIntent: 'AGENT_MISSION',
        secondaryIntents: ['TOOL_ACTION'],
        confidence: 0.94,
        reasoningStrategy: 'CHAIN_OF_THOUGHT',
        isFreshnessRequired: freshnessEval.requiresFreshness
      };
    }

    // Fast Path G: Direct Tool Invocations
    const isConversationalMath = /\b(and\s+then\s+tell\s+me|then\s+tell\s+me|tell\s+me\s+if)\b/i.test(promptLower);
    if (isConversationalMath) {
      return {
        primaryIntent: 'ANSWER',
        secondaryIntents: [],
        confidence: 0.95,
        reasoningStrategy: 'FAST_DIRECT',
        isFreshnessRequired: false
      };
    }

    const isMarkdownFormatting = /\bformat\s+(it|the\s+output|this)\s+as\s+(a\s+)?(markdown\s+)?table\b/i.test(promptLower);
    if (isMarkdownFormatting) {
      return {
        primaryIntent: 'ANSWER',
        secondaryIntents: [],
        confidence: 0.95,
        reasoningStrategy: 'FAST_DIRECT',
        isFreshnessRequired: false
      };
    }

    const isTool = (
      /\b(simulate|execute|test|verify|run)\s+.*(tool|timeout|error|http\s+[0-9]{3}|failure|outage|idempotency|mutation|econnreset|fallback)\b/i.test(promptLower) ||
      /\b(tool\s+execution|tool\s+call|required\s+tool|payment\s+mutation|system\s+shell\s+command)\b/i.test(promptLower) ||
      /\b(modify\s+production\s+configuration|etc\/hosts)\b/i.test(promptLower) ||
      /\b(open\s+(a|the|this)?\s*(website|web\s+page|url|page|site)|browse\s+(to\s+)?(a|the)?\s*(website|url|site)|navigate\s+to|open\s+https?:\/\/|extract\s+the\s+table|tell\s+me\s+the\s+(page\s+)?heading|take\s+(a\s+)?screenshot)\b/i.test(promptLower) ||
      /\b(populate\s+form|fill\s+(in\s+)?form|submit\s+this\s+form|submit\s+form|click\s+button)\b/i.test(promptLower) ||
      /\b(calculate|calc)\s+[0-9+\-*/().^ ]+/i.test(promptLower) ||
      /\b(read\s+(file\s+)?[a-zA-Z0-9_\-./\\]+|list\s+directory|git\s+status|git\s+log|latest\s+commit|package\.json|branch\s+status|(current\s+)?git\s+branch|(recent|latest)\s+commits?|summarize\s+(recent\s+)?commits?)\b/i.test(promptLower) ||
      /\b(inspect|read|cat)\s+(file\s+)?[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+\b/i.test(promptLower) ||
      /\b(deploy\s+this\s+now|deploy\s+.*(container|cluster|service|production|staging))\b/i.test(promptLower) ||
      (advisoryIntent === 'TOOL_ACTION')
    );
    if (isTool) {
      return {
        primaryIntent: 'TOOL_ACTION',
        secondaryIntents: [],
        confidence: 0.95,
        reasoningStrategy: 'FAST_DIRECT',
        isFreshnessRequired: freshnessEval.requiresFreshness
      };
    }

    // Fast Path H: Freshness Gate: Genuinely Time-Sensitive External Information
    // Evaluated only if prompt is NOT an automation, workflow, agent mission, or direct tool invocation
    if (freshnessEval.requiresFreshness && (!advisoryIntent || advisoryIntent === 'RESEARCH' || advisoryIntent === 'ANSWER')) {
      if (freshnessEval.isAmbiguous) {
        return {
          primaryIntent: 'ANSWER',
          secondaryIntents: ['RESEARCH'],
          confidence: 0.88,
          reasoningStrategy: 'CLARIFY_AMBIGUOUS',
          clarificationPrompt: freshnessEval.clarificationPrompt,
          isFreshnessRequired: true,
          detectedSubject: freshnessEval.detectedSubject,
          topic: freshnessEval.topic
        } as any;
      }
      return {
        primaryIntent: 'RESEARCH',
        secondaryIntents: [],
        confidence: 0.95,
        reasoningStrategy: 'CHAIN_OF_THOUGHT',
        isFreshnessRequired: true,
        detectedSubject: freshnessEval.detectedSubject,
        topic: freshnessEval.topic
      } as any;
    }

    // Fast Path I: Explanation vs Execution Nuance (Timeless Concepts & Explanations)
    // If clearly explanation only, not requiring freshness, and no execution requested:
    if (!freshnessEval.requiresFreshness && isExplanationOnly && !isExecutionRequested && (!advisoryIntent || advisoryIntent === 'ANSWER')) {
      return {
        primaryIntent: 'ANSWER',
        secondaryIntents: [],
        confidence: 0.97,
        reasoningStrategy: 'FAST_DIRECT',
        isFreshnessRequired: false
      };
    }

    // Fast Path J: Deep Research & Citations
    const isResearch = (
      /\b(research\s+(the\s+|latest\s+|recent\s+|advances\s+in\s+)?|deep\s+dive\s+into|investigate.*cite\s+sources|find\s+sources\s+and\s+compare)\b/i.test(promptLower) ||
      (advisoryIntent === 'RESEARCH')
    );
    if (isResearch) {
      return {
        primaryIntent: 'RESEARCH',
        secondaryIntents: [],
        confidence: 0.94,
        reasoningStrategy: 'CHAIN_OF_THOUGHT',
        isFreshnessRequired: freshnessEval.requiresFreshness
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

export interface FreshnessEvaluation {
  requiresFreshness: boolean;
  isAmbiguous: boolean;
  topic?: string;
  clarificationPrompt?: string;
  detectedSubject?: string;
}

/**
 * Robust, context-aware evaluation of whether a prompt requires up-to-date,
 * live external information (market figures, box office, breaking news, sports, weather, releases).
 * Disqualifies timeless explanations, mechanisms, historical dates, and casual inquiries.
 */
export function evaluateFreshness(
  rawPrompt: string,
  history: Array<{ role: string; content: string }> = [],
  contextualReferents: Record<string, string> = {}
): FreshnessEvaluation {
  const promptLower = (rawPrompt || '').trim().toLowerCase();
  if (!promptLower) {
    return { requiresFreshness: false, isAmbiguous: false };
  }

  // ==========================================
  // 1. NEGATIVE OVERRIDES (Disqualifiers)
  // ==========================================

  // A. Creative writing requests (fiction, stories, poems, scripts)
  const isCreativeWriting = /^(?:write|compose|draft|create|tell)\s+(?:a\s+|an\s+)?(?:fictional\s+|sci-fi\s+|bedtime\s+)?(?:story|news\s+story|poem|song|script|play|novel|fable|parable|dialogue|fairy\s+tale)\b/i.test(promptLower);
  if (isCreativeWriting) {
    return { requiresFreshness: false, isAmbiguous: false };
  }

  // B. Mechanical / conceptual / industry explanations ("Explain how box office revenue works")
  const isMechanismExplanation = (
    /\b(?:explain\s+how|how\s+does|how\s+do|the\s+mechanism\s+of|the\s+concept\s+of|the\s+theory\s+of)\s+.*\s+(?:works?|functions?|operate[s]?)\b/i.test(promptLower) ||
    /\bexplain\s+(?:how|why)\s+(?:box\s+office|stock\s+markets?|financial\s+markets?|revenue|weather|inflation)\s+(?:revenue\s+)?(?:works?|is\s+calculated)\b/i.test(promptLower)
  );
  if (isMechanismExplanation) {
    return { requiresFreshness: false, isAmbiguous: false };
  }

  // C. Timeless scientific / philosophical / academic definitions
  const isTimelessDefinition = /^(?:what\s+is|what\s+are|define|explain)\s+(?:quantum\s+entanglement|photosynthesis|gravity|general\s+relativity|dark\s+matter|special\s+relativity|string\s+theory|thermodynamics|plate\s+tectonics|mitosis|meiosis|dna|rna|cellular\s+respiration|schrodinger(?:'s)?\s+cat|fermi\s+paradox|newton(?:'s)?\s+laws?|black\s+holes?|evolution)\b/i.test(promptLower);
  if (isTimelessDefinition) {
    return { requiresFreshness: false, isAmbiguous: false };
  }

  // D. Explicit past historical timeframe or history inquiry ("Tell me about the history of the stock market", "movies of 1997")
  const isHistoryQuery = /\b(?:history\s+of|historical\s+overview|in\s+the\s+past|origin\s+of)\b/i.test(promptLower);
  const hasHistoricalYear = /\b(?:in|of|during|from)\s+(?:18\d\d|19\d\d|20[01]\d|202[0-4])\b/i.test(promptLower) ||
    /\b(?:in\s+the\s+(?:19\d0s|2000s|2010s)|during\s+world\s+war|in\s+ancient\s+rome|in\s+the\s+middle\s+ages)\b/i.test(promptLower);
  const mentionsLiveFreshness = /\b(?:current|latest|today|now|recently|newest|as\s+compared\s+to\s+today)\b/i.test(promptLower);
  if ((hasHistoricalYear || isHistoryQuery) && !mentionsLiveFreshness) {
    return { requiresFreshness: false, isAmbiguous: false };
  }

  // E. Polysemy of "current" (electric current, ocean current, current directory)
  const isPolysemicCurrent = (
    /\b(?:electric(?:al)?|alternating|direct|ocean|gulf\s+stream|rip|air|fluid)\s+current[s]?\b/i.test(promptLower) ||
    /\bcurrent\s+(?:directory|working\s+directory|branch|process|thread|buffer)\b/i.test(promptLower) ||
    /\b(?:flow\s+of\s+current|amperage|voltage\s+and\s+current|circuit)\b/i.test(promptLower)
  );
  if (isPolysemicCurrent && !/\b(?:share\s+price|stock|box\s+office|news|weather|ceo|president|winner|record)\b/i.test(promptLower)) {
    return { requiresFreshness: false, isAmbiguous: false };
  }

  // F. Casual / idiomatic "today"
  const isCasualToday = /\b(?:today\s+is\s+a\s+great\s+day|live\s+for\s+today|in\s+today's\s+(?:society|world)|quote\s+(?:for|of)\s+today|poem\s+about\s+today)\b/i.test(promptLower);
  if (isCasualToday) {
    return { requiresFreshness: false, isAmbiguous: false };
  }

  // ==========================================
  // 2. POSITIVE FRESHNESS EVALUATION
  // ==========================================

  // Helper to extract financial/stock entity from prompt, referents, or history
  const extractFinancialSubject = (): string | undefined => {
    // Check for possessive "<entity>'s (share|stock) price"
    const possessiveMatch = promptLower.match(/([a-zA-Z0-9.\-_$]+)'s\s+(?:current\s+|latest\s+|real-time\s+)?(?:share\s+price|stock\s+price|stock|market\s+cap)/i);
    if (possessiveMatch && !/^(?:it|that|this|today)$/i.test(possessiveMatch[1])) {
      return possessiveMatch[1].trim();
    }

    // Check prompt for "is <entity> trading" or "of/for <entity>"
    const match = promptLower.match(/\bis\s+([a-zA-Z0-9.\-_$]+)\s+(?:trading|priced|valued|changing)\b/i) ||
      promptLower.match(/\b(?:of|for)\s+([a-zA-Z0-9.\-_$]+(?:\s+to\s+[a-zA-Z0-9]+)?(?:\s+[a-zA-Z0-9]+)?)/i);
    let candidate = match ? match[1].trim() : undefined;
    if (candidate && /^(?:the\s+(?:company|stock|share|ticker|price|current|latest|market|exchange|rate|value|crypto|asset|index)|a\s+share|a\s+stock|all\s+companies|it|that|this|there|now|today)$/i.test(candidate)) {
      candidate = undefined;
    }
    if (candidate && candidate.toLowerCase().startsWith('the current')) {
      candidate = undefined;
    }
    if (candidate) return candidate;

    // Check referents
    if (contextualReferents['company']) return contextualReferents['company'];
    if (contextualReferents['subject']) return contextualReferents['subject'];
    if (contextualReferents['it'] && !contextualReferents['it'].includes('previous')) return contextualReferents['it'];

    // Check recent history
    for (const h of history.slice(-4).reverse()) {
      const text = h.content;
      const knownEntity = text.match(/\b(nvidia|nvda|apple|aapl|microsoft|msft|google|googl|alphabet|amazon|amzn|tesla|tsla|meta|netflix|nflx|amd|intel|intc|tsmc|openai|anthropic|palantir|pltr|bitcoin|btc|ethereum|eth|solana|sol)\b/i);
      if (knownEntity) return knownEntity[1];
    }
    return undefined;
  };

  // Helper to extract location from prompt, referents, or history
  const extractLocationSubject = (): string | undefined => {
    const possessiveMatch = promptLower.match(/([a-zA-Z0-9.\-_]+)'s\s+(?:current\s+|today's\s+)?(?:weather|temperature|forecast)/i);
    if (possessiveMatch && !/^(?:it|that|this|today|tomorrow)$/i.test(possessiveMatch[1])) {
      return possessiveMatch[1].trim();
    }

    const match = promptLower.match(/\b(?:in|for|at)\s+([a-zA-Z\s]+?)(?:\s+(?:today|tomorrow|this\s+week|this\s+weekend|now|right\s+now))?$/i) ||
      promptLower.match(/\b(?:in|for|at)\s+([a-zA-Z\s]+)/i);
    let candidate = match ? match[1].trim() : undefined;
    if (candidate && /^(?:the\s+city|my\s+area|here|there|today|tomorrow|now)$/i.test(candidate)) {
      candidate = undefined;
    }
    if (candidate) return candidate;

    if (contextualReferents['location']) return contextualReferents['location'];
    if (contextualReferents['there']) return contextualReferents['there'];

    for (const h of history.slice(-4).reverse()) {
      const text = h.content;
      const knownCity = text.match(/\b(tokyo|paris|london|new\s+york|berlin|san\s+francisco|seattle|chicago|los\s+angeles|sydney|toronto|mumbai|singapore|dubai|new\s+delhi|delhi|bengaluru|bangalore)\b/i);
      if (knownCity) return knownCity[1];
    }
    return undefined;
  };

  // Helper to extract movie from prompt, referents, or history
  const extractMovieSubject = (): string | undefined => {
    // Check possessive: "<Movie>'s (latest/current) box office"
    const possessiveMatch = promptLower.match(/([a-zA-Z0-9.\-_]+)'s\s+(?:current\s+|latest\s+|weekend\s+)?(?:box\s+office|gross)/i);
    if (possessiveMatch && !/^(?:it|that|this|today|yesterday)$/i.test(possessiveMatch[1])) {
      return possessiveMatch[1].trim();
    }

    if (/\b(?:for|of)\s+(?:the\s+)?(?:latest|newest|current)\s+movie\b/i.test(promptLower) || /\b(?:the\s+)?new\s+movie\b/i.test(promptLower)) {
      return 'the latest movie release';
    }
    const match = promptLower.match(/\b(?:for|of)\s+([a-zA-Z0-9.\-_$]+(?:\s+[a-zA-Z0-9]+)?)/i);
    let candidate = match ? match[1].trim() : undefined;
    if (candidate && /^(?:the\s+box\s+office|the\s+movie|a\s+movie|the\s+film|all\s+movies|it|that)$/i.test(candidate)) {
      candidate = undefined;
    }
    if (candidate) return candidate;

    if (contextualReferents['movie']) return contextualReferents['movie'];
    if (contextualReferents['film']) return contextualReferents['film'];
    if (contextualReferents['it'] && !contextualReferents['it'].includes('previous')) return contextualReferents['it'];

    for (const h of history.slice(-4).reverse()) {
      const text = h.content;
      const movieMatch = text.match(/\b(avatar|dune|oppenheimer|barbie|wicked|gladiator|marvel|batman|superman|spider-man|star\s+wars|deadpool)\b/i);
      if (movieMatch) return movieMatch[1];
    }
    return undefined;
  };

  // 0. Assistant Clarification Continuation Resolution
  if (history.length > 0) {
    const lastAssistant = history.filter(h => h.role === 'assistant').slice(-1)[0]?.content || '';
    if (lastAssistant && !/^(?:cancel|stop|nevermind|no|exit|quit)$/i.test(promptLower)) {
      if (/(?:company\s+or\s+(?:stock\s+)?ticker(?:\s+symbol)?|share\s+price\s+for)/i.test(lastAssistant)) {
        const subject = extractFinancialSubject() || rawPrompt.trim();
        return {
          requiresFreshness: true,
          isAmbiguous: false,
          topic: 'FINANCIAL',
          detectedSubject: subject
        };
      }
      if (/(?:city\s+or\s+location|weather\s+forecast\s+for)/i.test(lastAssistant)) {
        const location = extractLocationSubject() || rawPrompt.trim();
        return {
          requiresFreshness: true,
          isAmbiguous: false,
          topic: 'WEATHER',
          detectedSubject: location
        };
      }
      if (/(?:which\s+movie|box\s+office\s+collection\s+for|box\s+office\s+rankings)/i.test(lastAssistant)) {
        const movie = extractMovieSubject() || rawPrompt.trim();
        return {
          requiresFreshness: true,
          isAmbiguous: false,
          topic: 'BOX_OFFICE',
          detectedSubject: movie
        };
      }
      if (/(?:organization\s+or\s+company.*current\s+leadership)/i.test(lastAssistant)) {
        return {
          requiresFreshness: true,
          isAmbiguous: false,
          topic: 'FACTUAL_UPDATE',
          detectedSubject: rawPrompt.trim()
        };
      }
      if (/(?:game,\s*match,\s*or\s+team.*latest\s+score)/i.test(lastAssistant)) {
        return {
          requiresFreshness: true,
          isAmbiguous: false,
          topic: 'SPORTS',
          detectedSubject: rawPrompt.trim()
        };
      }
    }
  }

  // 1. Box Office & Theatrical Releases
  const isBoxOffice = /\b(?:box\s+office|opening\s+weekend\s+gross|worldwide\s+gross|grossing\s+movie[s]?|box\s+office\s+collection|movie\s+earn(?:ed)?|did\s+.*movie\s+earn)\b/i.test(promptLower);
  if (isBoxOffice) {
    const movie = extractMovieSubject();
    if (!movie) {
      return {
        requiresFreshness: true,
        isAmbiguous: true,
        topic: 'BOX_OFFICE',
        clarificationPrompt: 'Which movie would you like to check the box office collection for, or are you looking for the latest weekend box office rankings?'
      };
    }
    return {
      requiresFreshness: true,
      isAmbiguous: false,
      topic: 'BOX_OFFICE',
      detectedSubject: movie
    };
  }

  // 2. Financial & Asset Prices
  const isFinancialPrice = (
    /\b(?:share\s+price|stock\s+price|stock\s+quote|market\s+cap|trading\s+at|trading\s+for|crypto\s+price|price\s+of\s+(?:bitcoin|btc|eth|ethereum|solana)|exchange\s+rate|currency\s+rate)\b/i.test(promptLower) ||
    (/\b(?:current|latest|today['s]?|real-time)\s+price\b/i.test(promptLower) && !/\b(?:historic|history|all-time)\b/i.test(promptLower)) ||
    /\b(?:how\s+much\s+is\s+.*trading\s+for|changing\s+hands|shares?\s+of\s+.*changing\s+hands)\b/i.test(promptLower)
  );
  if (isFinancialPrice) {
    const subject = extractFinancialSubject();
    if (!subject) {
      return {
        requiresFreshness: true,
        isAmbiguous: true,
        topic: 'FINANCIAL',
        clarificationPrompt: 'Which company or stock ticker symbol would you like to check the current share price for?'
      };
    }
    return {
      requiresFreshness: true,
      isAmbiguous: false,
      topic: 'FINANCIAL',
      detectedSubject: subject
    };
  }

  // 3. News & Current Events
  const isNews = /\b(?:what\s+happened\s+in\s+.*news|news\s+today|today['s]?\s+news|breaking\s+news|latest\s+news|latest\s+developments\s+in|what\s+happened\s+today|headlines\s+today)\b/i.test(promptLower);
  if (isNews) {
    return {
      requiresFreshness: true,
      isAmbiguous: false,
      topic: 'NEWS'
    };
  }

  // 4. Sports Results & Live Competitions
  const isSports = (
    /\b(?:who\s+won\s+(?:the\s+)?(?:latest|recent|today['s]?|yesterday['s]?)|latest\s+(?:formula\s+1|f1|nba|nfl|premier\s+league|champions\s+league|world\s+series|super\s+bowl|grand\s+slam|ufc|race|match|game))\b/i.test(promptLower) ||
    /\b(?:latest|current)\s+score\b/i.test(promptLower) ||
    /\bwho\s+won\s+the\s+latest\b/i.test(promptLower)
  );
  if (isSports) {
    const match = promptLower.match(/\b(?:score\s+of|score\s+for|in\s+the|between)\s+([a-zA-Z0-9\s]+)/i);
    let subject = match ? match[1].trim() : undefined;
    if (!subject && (contextualReferents['match'] || contextualReferents['game'] || contextualReferents['team'])) {
      subject = contextualReferents['match'] || contextualReferents['game'] || contextualReferents['team'];
    }
    if (/\b(?:latest|current)\s+score\b/i.test(promptLower) && !subject) {
      return {
        requiresFreshness: true,
        isAmbiguous: true,
        topic: 'SPORTS',
        clarificationPrompt: 'Which game, match, or team would you like the latest score for?'
      };
    }
    return {
      requiresFreshness: true,
      isAmbiguous: false,
      topic: 'SPORTS',
      detectedSubject: subject
    };
  }

  // 5. Weather Forecasts
  const isWeather = /\b(?:weather|forecast|temperature|rain\s+forecast|is\s+it\s+raining)\b/i.test(promptLower);
  if (isWeather) {
    const location = extractLocationSubject();
    if (!location) {
      return {
        requiresFreshness: true,
        isAmbiguous: true,
        topic: 'WEATHER',
        clarificationPrompt: 'Which city or location would you like the weather forecast for?'
      };
    }
    return {
      requiresFreshness: true,
      isAmbiguous: false,
      topic: 'WEATHER',
      detectedSubject: location
    };
  }

  // 6. Recent Releases & Product Versions
  const isRelease = (
    /\b(?:current\s+version\s+of|latest\s+version\s+of|latest\s+release\s+of|newest\s+version\s+of|newest\s+model\s+released\s+by|latest\s+update\s+to|what\s+is\s+the\s+latest\s+(?:stable\s+)?release|what\s+changed\s+in\s+the\s+latest|available\s+yet|is\s+the\s+new\s+.*available|rolled\s+out|brand\s+new\s+updates?|updates?\s+this\s+week)\b/i.test(promptLower) ||
    /\b(?:latest|newest|recent)\s+(?:[a-zA-Z0-9_-]+\s+)?(?:releases?|versions?|updates?|models?)\b/i.test(promptLower)
  );
  if (isRelease) {
    return {
      requiresFreshness: true,
      isAmbiguous: false,
      topic: 'RELEASE'
    };
  }

  // 7. Present-Day Facts That Change Over Time
  const isLeadership = /\b(?:current\s+(?:ceo|cto|cfo|president|prime\s+minister|chancellor|leader|pope|governor|mayor)\s+of|who\s+is\s+(?:currently\s+(?:the\s+)?|their\s+|the\s+|its\s+|current\s+)?(?:current\s+)?(?:ceo|leader|president|prime\s+minister|chancellor)|who\s+currently\s+leads)\b/i.test(promptLower);
  if (isLeadership) {
    const orgMatch = promptLower.match(/\b(?:of|leads)\s+([a-zA-Z0-9\s]+)/i);
    let org = orgMatch ? orgMatch[1].trim() : undefined;
    if (org && /^(?:the\s+organization|the\s+company|the\s+group|it|them)$/i.test(org)) {
      org = undefined;
    }
    if (!org && (contextualReferents['company'] || contextualReferents['organization'])) {
      org = contextualReferents['company'] || contextualReferents['organization'];
    }
    if (!org) {
      return {
        requiresFreshness: true,
        isAmbiguous: true,
        topic: 'FACTUAL_UPDATE',
        clarificationPrompt: 'Which organization or company would you like to know the current leadership for?'
      };
    }
    return {
      requiresFreshness: true,
      isAmbiguous: false,
      topic: 'FACTUAL_UPDATE',
      detectedSubject: org
    };
  }

  const isFactualUpdate = /\b(?:current\s+world\s+record\s+for|current\s+status\s+of)\b/i.test(promptLower);
  if (isFactualUpdate) {
    return {
      requiresFreshness: true,
      isAmbiguous: false,
      topic: 'FACTUAL_UPDATE'
    };
  }

  // 8. Explicit Research / Citations / Comparative Study / Source Investigation
  const isExplicitResearch = (
    /\b(?:compare\s+the\s+latest\s+.*with\s+citations|research\s+this\s+and\s+summarize|find\s+sources\s+and\s+compare|compare\s+(?:the\s+)?sources|research\s+the\s+latest|investigate.*cite\s+sources)\b/i.test(promptLower) ||
    /\b(?:latest|recent)\s+(?:information|updates?|developments?|news|reports?|figures?|numbers?|data|statistics|events?)\s+(?:about|on|regarding|in)\b/i.test(promptLower) ||
    /\bwhat\s+changed\s+recently\b/i.test(promptLower)
  );
  if (isExplicitResearch) {
    return {
      requiresFreshness: true,
      isAmbiguous: false,
      topic: 'RESEARCH'
    };
  }

  // 9. Temporal Modifiers on Dynamic Topics
  const hasTemporalKeyword = /\b(?:currently|current|latest|recent|recently|today|as\s+of\s+now|right\s+now|this\s+week|this\s+month|newest)\b/i.test(promptLower);
  const isDynamicTopic = /\b(?:inflation\s+rates?|interest\s+rates?|unemployment\s+rates?|gas\s+prices?|ticket\s+prices?|population\s+of|election\s+results?|layoffs?|downsizing|strikes?|protests?|outages?|mergers?|acquisitions?|earnings|bankruptcies?)\b/i.test(promptLower);
  if (hasTemporalKeyword && isDynamicTopic) {
    return {
      requiresFreshness: true,
      isAmbiguous: false,
      topic: 'GENERAL_FRESHNESS'
    };
  }

  return { requiresFreshness: false, isAmbiguous: false };
}
