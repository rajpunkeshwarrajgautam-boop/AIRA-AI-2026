import {
  IntentTaxonomy,
  SideEffectLevel
} from '../../contracts/src/index.js';
import {
  SemanticIntentAnalysis
} from '../../contracts/src/behavioral.js';

export interface SemanticReasonerInput {
  prompt: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  advisoryIntent?: IntentTaxonomy;
  sideEffectLevel?: SideEffectLevel;
}

export class SemanticReasoner {
  /**
   * Analyzes prompt semantics, conversational context, referents,
   * and separates explanation vs execution intent.
   */
  public analyze(input: SemanticReasonerInput): SemanticIntentAnalysis {
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

    // 4. Fast Path Classification
    const fastPathResult = this.evaluateFastPath(
      rawPrompt,
      promptLower,
      history,
      contextualReferents,
      isExplanationOnly,
      isExecutionRequested,
      input.sideEffectLevel
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
      };
    }

    // 5. Context-Assisted Resolution
    // If prompt is a follow-up ("Now make it faster", "Can you improve it?"),
    // leverage conversation history to determine intent
    if (this.isFollowUp(promptLower)) {
      const inheritedIntent = this.resolveFollowUpIntent(history);
      return {
        primaryIntent: inheritedIntent,
        secondaryIntents: [],
        isExplanationOnly,
        isExecutionRequested,
        contextualReferents,
        isMultiPart,
        subTasks: isMultiPart ? subTasks : [],
        confidence: 0.91,
        reasoningStrategy: 'CHAIN_OF_THOUGHT',
        fastPathUsed: false
      };
    }

    // 6. Safe Default Fallback
    return {
      primaryIntent: 'ANSWER',
      secondaryIntents: [],
      isExplanationOnly: true,
      isExecutionRequested: false,
      contextualReferents,
      isMultiPart: false,
      subTasks: [],
      confidence: 0.85,
      reasoningStrategy: 'FAST_DIRECT',
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
      } else if (/\b(application|app|service|frontend|api)\b/i.test(recentHistoryText)) {
        referents['it'] = 'the application';
      } else {
        referents['it'] = 'the previous subject';
      }
    }

    return referents;
  }

  private decomposeMultiPart(prompt: string): string[] {
    // Detect conjunctions connecting independent imperative clauses
    // e.g. "Calculate 1024 * 4 and also research solar cell records"
    const parts = prompt.split(/\b(?:and\s+also|and\s+then|additionally|also)\b/i);
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
      /\bguide\s+to\b/,
      /\boverview\s+of\b/
    ];
    return explanationPatterns.some(p => p.test(promptLower));
  }

  private isExecutionIntent(promptLower: string): boolean {
    // Requests demanding real system or environment action
    const executionPatterns = [
      /\b(build\s+(an?\s+)?application\s+and\s+show\s+me)\b/,
      /\b(run|execute|trigger|start|deploy|compile)\b/,
      /\b(open\s+https?:\/\/|navigate\s+to)\b/,
      /\b(fix\s+it\s+and\s+verify|repair\s+the\s+repo)\b/,
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
    sideEffectLevel?: SideEffectLevel
  ): Partial<SemanticIntentAnalysis> | null {
    // Fast Path A: Trivial Greetings & Pleasantries (Zero Extra Model Calls)
    if (/^(hi|hello|hey|good\s+(morning|afternoon|evening)|howdy|greetings)[!.?]?$/i.test(promptLower)) {
      return {
        primaryIntent: 'ANSWER',
        secondaryIntents: [],
        confidence: 0.99,
        reasoningStrategy: 'FAST_DIRECT'
      };
    }

    // Fast Path B: Destructive Commands Mandatory Gate
    if (sideEffectLevel === 'DESTRUCTIVE' || /\b(rm\s+-rf|drop\s+database|format\s+[a-z]:?|delete\s+all)/i.test(promptLower)) {
      return {
        primaryIntent: 'TOOL_ACTION',
        secondaryIntents: [],
        confidence: 0.99,
        reasoningStrategy: 'FAST_DIRECT'
      };
    }

    // Fast Path C: Explanation vs Execution
    if (isExplanationOnly && !isExecutionRequested) {
      return {
        primaryIntent: 'ANSWER',
        secondaryIntents: [],
        confidence: 0.97,
        reasoningStrategy: 'FAST_DIRECT'
      };
    }

    // Fast Path D: Scheduled Automations
    const isAutomation = /\b(every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|day|morning|night|week|month|hour)|schedule\s+.*(job|automation|task|run|check|backup)|create\s+(an?\s+)?automation|cron\s+expression)\b/i.test(promptLower);
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
    const isWorkflow = isMultiStepPipeline || /\b(run|execute|trigger|start)\s+(the\s+|my\s+)?([a-z\s_-]+)?(workflow|pipeline|dag)\b/i.test(promptLower);
    if (isWorkflow) {
      return {
        primaryIntent: 'WORKFLOW',
        secondaryIntents: ['RESEARCH', 'TOOL_ACTION'],
        confidence: 0.95,
        reasoningStrategy: 'DECOMPOSE_DAG'
      };
    }

    // Fast Path F: Agent Missions (Autonomous repo/system investigation, multi-step coding/repair)
    const isAgentMission = /\b(investigate\s+(this\s+|the\s+|repository\s+)?(bug|system|repo|project|codebase|test\s+failures?|failures?|issue)|inspect\s+the\s+repo|mission\s+plan|agent\s+mission|autonomous\s+mission|execute\s+mission|build\s+(an?\s+)?application|build\s+an\s+app|fix\s+(the\s+)?failing\s+tests|verify\s+the\s+build)\b/i.test(promptLower);
    if (isAgentMission) {
      return {
        primaryIntent: 'AGENT_MISSION',
        secondaryIntents: ['TOOL_ACTION'],
        confidence: 0.94,
        reasoningStrategy: 'CHAIN_OF_THOUGHT'
      };
    }

    // Fast Path G: Direct Tool Invocations
    const isConversationalMath = /\b(and\s+then\s+tell\s+me|then\s+tell\s+me)\b/i.test(promptLower);
    const isTool = !isConversationalMath && (
      /\b(open\s+https?:\/\/|navigate\s+to|extract\s+the\s+table|tell\s+me\s+the\s+(page\s+)?heading|take\s+(a\s+)?screenshot)\b/i.test(promptLower) ||
      /\b(populate\s+form|fill\s+(in\s+)?form|submit\s+this\s+form|submit\s+form|click\s+button)\b/i.test(promptLower) ||
      /\b(calculate|calc)\s+[0-9+\-*/().^ ]+/i.test(promptLower) ||
      /\b(read\s+(file\s+)?[a-zA-Z0-9_\-./\\]+|list\s+directory|git\s+status|git\s+log|latest\s+commit|package\.json|branch\s+status)\b/i.test(promptLower) ||
      /\b(inspect|read|cat)\s+(file\s+)?[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+\b/i.test(promptLower) ||
      /\b(deploy\s+.*(container|cluster|service|production|staging|to\s+production))\b/i.test(promptLower) ||
      /\b(modify|edit|update|write|create|delete)\s+.*(file|configuration|config|\/etc\/|[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)\b/i.test(promptLower) ||
      /\b(simulate\s+.*(tool|error|outage|timeout|failure|fail|crash|exception|http|\d{3}|unauthorized)|execute\s+.*(tool|mutation|shell)|tool\s+execution|run\s+(system\s+)?shell|payment\s+mutation|delete\s+production\s+database|echo\s+hello|request\s+its\s+execution|call\s+tool|idempotencykey)\b/i.test(promptLower)
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
    const isResearch = /\b(research\s+(the\s+|latest\s+|recent\s+|advances\s+in\s+)?|deep\s+dive\s+into|investigate.*cite\s+sources|find\s+sources\s+and\s+compare)\b/i.test(promptLower);
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
    if (/\b(git|run|execute|shell)\b/.test(lastUser)) {
      return 'TOOL_ACTION';
    }
    return 'ANSWER';
  }
}
