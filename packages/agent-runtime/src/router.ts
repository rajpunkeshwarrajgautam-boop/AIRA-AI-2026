import {
  ExecutionPrincipal,
  IntentTaxonomy,
  RoutingDecision,
  SideEffectLevel
} from '../../contracts/src/index.js';
import { ModelRouter } from '../../model-router/src/index.js';
import { CapabilityRegistry } from './registry.js';

export interface RoutingInput {
  prompt: string;
  principal: ExecutionPrincipal;
  advisoryIntent?: IntentTaxonomy;
  context?: Record<string, any>;
  conversationHistory?: Array<{ role: string; content: string }>;
}

export class ServerIntentRouter {
  private static readonly CONFIDENCE_THRESHOLD_PRIVILEGED = 0.70;

  /**
   * Deliberately narrow: distinguish a request to PRODUCE runnable software
   * from an explanation, example, plan, research query or automation.
   * A matched request fails closed until a real build sandbox is provisioned.
   */
  private isApplicationBuildRequest(text: string): boolean {
    const action = /^(?:(?:please|kindly)\s+|(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:build|create|develop|implement|make|scaffold|code|generate)\b/;
    if (!action.test(text)) return false;
    const informationalObject = /^(?:(?:please|kindly)\s+|(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:build|create|develop|implement|make|scaffold|code|generate)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:plan|outline|guide|tutorial|example|proposal)\b/;
    if (informationalObject.test(text)) return false;
    return /\b(?:game|website|web\s+(?:app|application|site|page)|app(?:lication)?|dashboard|landing\s+page|(?:react|vue|svelte|next\.?js|three\.?js)\s+(?:app|application|dashboard|project)|(?:python|javascript|typescript|node(?:\.js)?)\s+(?:program|project|application)|software|program|api|interactive\s+demo)\b/.test(text);
  }

  constructor(
    private registry: CapabilityRegistry,
    private modelRouter?: ModelRouter
  ) {}

  public async route(input: RoutingInput): Promise<RoutingDecision> {
    const rawPrompt = (input.prompt || '').trim();
    const promptLower = rawPrompt.toLowerCase();

    // 1. Mandatory Server Side-Effect & Policy Gate
    // The server is authoritative. Side effects are classified based on invariant safety rules
    // that cannot be bypassed by client headers, advisory intents, or prompt injection.
    const sideEffectLevel = this.classifySideEffect(promptLower);
    const policyApprovalMandatory = (sideEffectLevel === 'DESTRUCTIVE' || sideEffectLevel === 'WRITE');

    // 2. Deterministic Rule Matching
    const deterministicDecision = this.matchDeterministicRules(promptLower, input.advisoryIntent, sideEffectLevel);
    if (deterministicDecision) {
      return this.finalizeDecision(deterministicDecision, policyApprovalMandatory);
    }

    // 3. Semantic / Model Classification (if providers available and prompt is sufficiently long)
    if (this.modelRouter && this.modelRouter.listProviders().length > 0 && rawPrompt.length > 5) {
      try {
        const modelDecision = await this.classifyWithModel(rawPrompt, input.advisoryIntent, sideEffectLevel);
        if (modelDecision) {
          return this.finalizeDecision(modelDecision, policyApprovalMandatory);
        }
      } catch {
        // Fall through to safe fallback on any model classification error
      }
    }

    // 4. Safe Non-Privileged Fallback
    // Unclear or low-confidence prompts fail safe to ANSWER with NONE side-effect
    const targetInfo = this.registry.resolveExecutionTarget('ANSWER');
    return {
      intent: 'ANSWER',
      confidence: 0.65,
      reason: 'Standard conversational response for general query.',
      executionTarget: targetInfo.target,
      sideEffectLevel: 'NONE',
      approvalRequired: false,
      capabilities: [targetInfo.capabilityId],
      metadata: { fallback: true }
    };
  }

  private classifySideEffect(text: string): SideEffectLevel {
    // Critical / Destructive patterns
    const destructivePatterns = [
      /\b(rm\s+-rf|format\s+[a-z]:|kill\s+-9)\b/,
      /\bdrop\s+.*(table|database|schema)\b/,
      /\bdelete\s+.*(database|tables?|schema|all\s+files)\b/,
      /\bdelete\s+(?:all\s+)?(?:project|workspace|repository|repo)\s+files\b/,
      /\b(truncate\s+table|wipe\s+(disk|system)|hang_unsafe|destroy\s+all|purge\s+database)\b/
    ];
    if (destructivePatterns.some(p => p.test(text))) {
      return 'DESTRUCTIVE';
    }

    // An implementation request implies intended project writes, even if execution is unavailable.
    if (this.isApplicationBuildRequest(text)) return 'WRITE';

    // Write / State Mutation patterns
    const writePatterns = [
      /\b(create\s+(a\s+|an\s+)?automation|schedule\s+(a\s+|an\s+)?(daily|weekly|hourly|cron))\b/,
      /\b(every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|day|hour|week|month))\b/,
      /\b(fix\s+it\s+and\s+verify|patch\s+and\s+verify|write\s+file|create\s+table|modify\s+repo)\b/,
      /\b(save\s+automation|update\s+setting|execute\s+workflow|run\s+workflow|submit\s+form|populate\s+form|fill\s+(in\s+)?(the\s+)?form)\b/,
      /\b(click\s+(the\s+)?(submit|button|login|save|delete|create))\b/
    ];
    if (writePatterns.some(p => p.test(text))) {
      return 'WRITE';
    }

    // Read / Inspection patterns
    const readPatterns = [
      /\b(research|search|lookup|inspect|read\s+(file\s+)?[a-zA-Z0-9_\-./\\]+|calculate|calc\s+|check\s+status|fetch\s+url)\b/,
      /\b(cite\s+sources|find\s+sources|extract\s+the\s+table|open\s+this\s+url|open\s+https?:\/\/|navigate\s+to\s+https?:\/\/)\b/,
      /\b(tell\s+me\s+the\s+(page\s+)?heading|page\s+heading|heading\s+of|extract\s+heading|latest\s+commit|git\s+status|git\s+log|git\s+diff)\b/,
      /\b(capture\s+screenshot|take\s+screenshot|screenshot\s+of|extract\s+(the\s+)?main\s+text|extract\s+text)\b/
    ];
    if (readPatterns.some(p => p.test(text))) {
      return 'READ';
    }

    return 'NONE';
  }

  private matchDeterministicRules(
    text: string,
    advisoryIntent: IntentTaxonomy | undefined,
    sideEffect: SideEffectLevel
  ): Partial<RoutingDecision> | null {
    // Rule A: Destructive commands cannot be disguised as simple answers or safe tools
    if (sideEffect === 'DESTRUCTIVE') {
      return {
        intent: 'TOOL_ACTION',
        confidence: 0.99,
        reason: 'Operation contains potentially destructive commands requiring strict policy confirmation.',
        sideEffectLevel: 'DESTRUCTIVE',
        approvalRequired: true,
        metadata: { securityOverride: true }
      };
    }

    // Rule B: Scheduled Automations
    const isAutomation = /\b(every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|day|morning|night|week|month|hour)|schedule\s+(a\s+|an\s+)?(job|automation|task|run|check)|create\s+(an?\s+)?automation|cron\s+expression)\b/.test(text);
    if (isAutomation) {
      return {
        intent: 'AUTOMATION_CREATE',
        confidence: 0.93,
        reason: 'Identified scheduled automation intent.',
        sideEffectLevel: 'WRITE',
        approvalRequired: true
      };
    }

    // A build request must never silently degrade into a code tutorial or git-status mission.
    // The registered builder is explicitly NOT_READY until real isolation/build/preview exists.
    if (this.isApplicationBuildRequest(text)) {
      return {
        intent: 'APPLICATION_BUILD',
        confidence: 0.99,
        reason: 'Explicit request to create runnable software; isolated build execution is not yet available.',
        sideEffectLevel: 'WRITE',
        approvalRequired: true
      };
    }

    // Rule C: Workflows
    const isMultiStepPipeline = (
      /\b(research|investigate|study)\b/.test(text) &&
      /\b(summarize|extract|analyze)\b/.test(text) &&
      /\b(report|brief|synthesize|document|whitepaper)\b/.test(text)
    );
    const isWorkflow = (
      /\b(run|execute|trigger|start)\s+(my\s+|the\s+)?(approved\s+|weekly\s+|reporting\s+)*workflow\b/.test(text) ||
      (/\bworkflow\b/.test(text) && /\b(run|execute|trigger|start)\b/.test(text)) ||
      isMultiStepPipeline ||
      (advisoryIntent === 'WORKFLOW')
    );
    if (isWorkflow) {
      const isDestructive = sideEffect === 'DESTRUCTIVE';
      return {
        intent: 'WORKFLOW',
        confidence: 0.95,
        reason: isMultiStepPipeline
          ? 'Identified multi-step DAG pipeline (research -> extract findings -> synthesize report).'
          : 'Identified multi-step workflow execution intent.',
        sideEffectLevel: isDestructive ? 'DESTRUCTIVE' : 'WRITE',
        approvalRequired: true
      };
    }

    // Rule D: Agent Missions
    const isAgentMission = /\b(investigate\s+(this\s+|the\s+)?(bug|system|repo|project|codebase)|inspect\s+the\s+repo|mission\s+plan|agent\s+mission|autonomous\s+mission|execute\s+mission)\b/.test(text) ||
      (advisoryIntent === 'AGENT_MISSION' && text.length > 10);
    if (isAgentMission) {
      const isMutating = sideEffect === 'WRITE' || sideEffect === 'DESTRUCTIVE';
      return {
        intent: 'AGENT_MISSION',
        confidence: 0.92,
        reason: 'Identified multi-step autonomous agent mission.',
        sideEffectLevel: isMutating ? sideEffect : 'READ',
        approvalRequired: isMutating
      };
    }

    // Rule for Computer Use / OS Control
    if (/\b(mouse\s+click|desktop\s+coordinate|computer\s+use|screen\s+coordinate|os\s+control|desktop\s+screen|native\s+app\s+control)\b/.test(text)) {
      return {
        intent: 'TOOL_ACTION',
        confidence: 0.95,
        reason: 'Identified computer use / OS control request.',
        sideEffectLevel: 'WRITE',
        approvalRequired: true
      };
    }

    // Rule E: Direct Tool Invocations (Browser, Files, Repo, System, Calculator, Connectors)
    const isTool = (
      /\b(open\s+https?:\/\/|navigate\s+to\s+https?:\/\/|open\s+this\s+url|extract\s+the\s+table|tell\s+me\s+the\s+(page\s+)?heading)\b/.test(text) ||
      /\b(open\s+the\s+website|open\s+the\s+(aira\s+)?github\s+repository|latest\s+commit|git\s+status|git\s+diff|git\s+log)\b/.test(text) ||
      /\b(populate\s+form|fill\s+(in\s+)?(the\s+)?form|submit\s+this\s+form|submit\s+form|click\s+(the\s+)?button)\b/.test(text) ||
      /\b(calculate\s+|calc\s+|read\s+(file\s+)?[a-zA-Z0-9_\-./\\]+|search\s+the\s+web\s+for|run\s+(shell\s+)?command|download\s+file|capture\s+screenshot)\b/.test(text) ||
      (advisoryIntent === 'TOOL_ACTION')
    );
    if (isTool) {
      const toolSideEffect = sideEffect === 'DESTRUCTIVE' ? 'DESTRUCTIVE' : sideEffect === 'WRITE' ? 'WRITE' : 'READ';
      return {
        intent: 'TOOL_ACTION',
        confidence: 0.94,
        reason: 'Identified verified tool execution request.',
        sideEffectLevel: toolSideEffect,
        approvalRequired: toolSideEffect === 'DESTRUCTIVE' || toolSideEffect === 'WRITE'
      };
    }

    // Rule F: Research & Source Investigation
    const isResearch = /\b(research\s+(the\s+|latest\s+|recent\s+|advances\s+in\s+)?|deep\s+dive\s+into.*sources|investigate.*cite\s+sources|find\s+sources\s+and\s+compare)\b/.test(text) ||
      (advisoryIntent === 'RESEARCH');
    if (isResearch) {
      return {
        intent: 'RESEARCH',
        confidence: 0.94,
        reason: 'Identified deep research and evidence citation request.',
        sideEffectLevel: 'READ',
        approvalRequired: false
      };
    }

    // Rule G: Unambiguous Question / Answer / Explanation
    const isQuestion = /^(explain|what\s+is|what\s+are|how\s+does|why\s+is|define|summarize|tell\s+me|who\s+was)\b/.test(text);
    if (isQuestion) {
      return {
        intent: 'ANSWER',
        confidence: 0.95,
        reason: 'Identified standard informational inquiry.',
        sideEffectLevel: 'NONE',
        approvalRequired: false
      };
    }

    return null;
  }

  private async classifyWithModel(
    prompt: string,
    advisoryIntent: IntentTaxonomy | undefined,
    sideEffect: SideEffectLevel
  ): Promise<Partial<RoutingDecision> | null> {
    if (!this.modelRouter) return null;

    const classificationPrompt = `You are the server-authoritative intent classifier for Aira AI.
Classify the user prompt into exactly ONE intent:
- ANSWER: Normal conversational query, explanation, general question.
- RESEARCH: In-depth research, finding and citing sources, comprehensive synthesis.
- TOOL_ACTION: Explicit tool invocation (web search, calculator, file read, shell command).
- WORKFLOW: Running a predefined business or technical workflow.
- AUTOMATION_CREATE: Setting up a recurring schedule, cron job, or triggered automation.
- AGENT_MISSION: Autonomous multi-step goal (investigating a bug, repairing a codebase, verifying fixes).
- APPLICATION_BUILD: Explicitly build a runnable app, game, website, or project; NOT_READY until isolated build runtime exists.

Return a JSON object only:
{
  "intent": "ANSWER" | "RESEARCH" | "TOOL_ACTION" | "WORKFLOW" | "AUTOMATION_CREATE" | "AGENT_MISSION" | "APPLICATION_BUILD",
  "confidence": <number between 0.0 and 1.0>,
  "reason": "<short justification under 200 chars without internal reasoning>"
}

User prompt: "${prompt.slice(0, 500).replace(/"/g, '\\"')}"`;

    try {
      const adapter = this.modelRouter.getAdapter({
        model: 'aira-fast',
        temperature: 0.0,
        maxTokens: 256,
        extendedThinking: false,
        timeoutMs: 4000
      });

      let responseText = '';
      await adapter.stream([
        { role: 'system', content: 'You are a strict JSON intent classifier.' },
        { role: 'user', content: classificationPrompt }
      ], {
        model: 'aira-fast',
        temperature: 0.0,
        maxTokens: 256,
        extendedThinking: false,
        timeoutMs: 4000
      }, async (chunk) => {
        if (chunk.text) responseText += chunk.text;
      });

      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      const validIntents: IntentTaxonomy[] = ['ANSWER', 'RESEARCH', 'TOOL_ACTION', 'WORKFLOW', 'AUTOMATION_CREATE', 'AGENT_MISSION', 'APPLICATION_BUILD'];
      if (!validIntents.includes(parsed.intent)) return null;

      const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.8;
      const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : 'Model classified intent.';

      // Enforce confidence threshold for privileged intents
      if (['AGENT_MISSION', 'AUTOMATION_CREATE', 'WORKFLOW'].includes(parsed.intent) && confidence < ServerIntentRouter.CONFIDENCE_THRESHOLD_PRIVILEGED) {
        return {
          intent: 'ANSWER',
          confidence: 0.65,
          reason: 'Low confidence for privileged operation; routed to conversational clarification.',
          sideEffectLevel: 'NONE',
          approvalRequired: false
        };
      }

      return {
        intent: parsed.intent as IntentTaxonomy,
        confidence,
        reason,
        sideEffectLevel: sideEffect,
        approvalRequired: sideEffect === 'DESTRUCTIVE' || sideEffect === 'WRITE'
      };
    } catch {
      return null;
    }
  }

  private finalizeDecision(
    partial: Partial<RoutingDecision>,
    policyApprovalMandatory: boolean
  ): RoutingDecision {
    const intent: IntentTaxonomy = partial.intent || 'ANSWER';
    const sideEffectLevel: SideEffectLevel = intent === 'APPLICATION_BUILD'
      ? 'WRITE'
      : (partial.sideEffectLevel || (policyApprovalMandatory ? 'WRITE' : 'NONE'));

    
    // Approval policy: Server policy strictly overrides. If side effect is DESTRUCTIVE or WRITE, approval is mandatory.
    const approvalRequired = policyApprovalMandatory || intent === 'APPLICATION_BUILD' || Boolean(partial.approvalRequired);

    const targetResolution = this.registry.resolveExecutionTarget(intent);

    return {
      intent,
      confidence: partial.confidence ?? 0.85,
      reason: (partial.reason || 'Server-authoritative routing decision.').slice(0, 280),
      executionTarget: targetResolution.target,
      sideEffectLevel,
      approvalRequired,
      capabilities: partial.capabilities || [targetResolution.capabilityId],
      metadata: partial.metadata || {}
    };
  }
}
