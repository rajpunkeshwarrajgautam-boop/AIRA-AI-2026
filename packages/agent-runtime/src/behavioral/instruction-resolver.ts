import {
  InstructionItem,
  InstructionProvenance,
  ResolvedInstructionSet,
  InstructionProvenanceSchema
} from '../../contracts/src/behavioral.js';

export interface ResolveInstructionsInput {
  userPrompt: string;
  activeProjectId?: string;
  activeUserId?: string;
  systemPolicies?: string[];
  customInstructions?: string;
  projectInstructions?: Array<{ id: string; projectId: string; content: string }>;
  recalledMemories?: Array<{ id: string; content: string; category?: string; title?: string }>;
  untrustedContext?: string[];
}

const PROVENANCE_HIERARCHY: Record<InstructionProvenance, number> = {
  TRUSTED_SYSTEM_POLICY: 100,
  SECURITY_AUTHORIZATION: 95,
  USER_CURRENT_REQUEST: 80,
  USER_CUSTOM_INSTRUCTION: 70,
  ACTIVE_PROJECT_CONVENTION: 50,
  CONVERSATION_MEMORY: 30,
  TASK_SPECIFIC_GUIDANCE: 20,
  EXTERNAL_UNTRUSTED_DATA: 10
};

// Patterns representing untrusted instruction injection attempts
const INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|prior)\s+(instructions|rules|prompts)\b/i,
  /\bsystem\s+override\b/i,
  /\byou\s+are\s+now\s+(in\s+)?(developer|jailbreak|god|dan)\s+mode\b/i,
  /\bbypass\s+(all\s+)?(safety|security|policy|restrictions)\b/i,
  /\bdisregard\s+(the\s+)?(above|system)\s+instructions\b/i,
];

export class InstructionResolver {
  /**
   * Resolves instructions before model-context assembly
   * Enforces strict provenance hierarchy, tenant/project isolation,
   * injection neutralization, and relevance filtering.
   */
  public resolve(input: ResolveInstructionsInput): ResolvedInstructionSet {
    const promptLower = (input.userPrompt || '').toLowerCase();

    // 1. Detect if the user's turn is an active software development / coding task
    const isDevTask = this.detectDevelopmentTask(promptLower);

    // 2. Base Trusted System Policies (Level 100)
    const trustedPolicies: string[] = [
      'AIRA core identity: natural, context-aware, reasoning-capable general-purpose intelligence.',
      'Server-authoritative policy: Destructive operations require explicit user approval.',
      'Tenant isolation: User and project boundaries must never be breached.'
    ];

    if (input.systemPolicies && input.systemPolicies.length > 0) {
      trustedPolicies.push(...input.systemPolicies);
    }

    const effectiveInstructions: string[] = [];
    const filteredOut: Array<{
      id: string;
      content: string;
      provenance: InstructionProvenance;
      reason: string;
    }> = [];
    const appliedBrandRules: string[] = [];

    // 3. User Custom Instructions (Level 70)
    if (input.customInstructions && input.customInstructions.trim()) {
      const sanitizedCustom = this.sanitizeUntrusted(input.customInstructions);
      if (sanitizedCustom) {
        effectiveInstructions.push(`User Custom Preference: ${sanitizedCustom}`);
      }
    }

    // 4. Active Project Conventions (Level 50)
    if (input.projectInstructions && input.projectInstructions.length > 0) {
      for (const projInst of input.projectInstructions) {
        // Project isolation: Apply ONLY if project is active
        if (!input.activeProjectId || projInst.projectId !== input.activeProjectId) {
          filteredOut.push({
            id: projInst.id,
            content: projInst.content,
            provenance: 'ACTIVE_PROJECT_CONVENTION',
            reason: `Project instruction not applicable (activeProjectId: ${input.activeProjectId || 'none'}, required: ${projInst.projectId})`
          });
          continue;
        }

        // If it's a procedural dev rule (e.g. lint/build) and the user query is NOT dev-related, filter out
        const isLintRule = /lint|build|oxlint|tsc\s+-b/i.test(projInst.content);
        if (isLintRule && !isDevTask) {
          filteredOut.push({
            id: projInst.id,
            content: projInst.content,
            provenance: 'ACTIVE_PROJECT_CONVENTION',
            reason: 'Procedural verification rule filtered out for non-development request'
          });
          continue;
        }

        effectiveInstructions.push(`Project Convention (${projInst.projectId}): ${projInst.content}`);
      }
    }

    // 5. Conversation Memory (Level 30 - Contextual evidence, NOT privileged commands)
    if (input.recalledMemories && input.recalledMemories.length > 0) {
      for (const mem of input.recalledMemories) {
        const content = mem.content || '';

        // Injection defense: Memory cannot inject system commands
        if (INJECTION_PATTERNS.some(p => p.test(content))) {
          filteredOut.push({
            id: mem.id,
            content,
            provenance: 'CONVERSATION_MEMORY',
            reason: 'Neutralized attempted instruction injection inside memory content'
          });
          continue;
        }

        // Check defective "zero emojis" branding rule inside memory
        if (/zero\s+emojis/i.test(content)) {
          filteredOut.push({
            id: mem.id,
            content,
            provenance: 'CONVERSATION_MEMORY',
            reason: 'Branding "zero emojis" memory rule is not globally binding on user conversation'
          });
          continue;
        }

        // Check procedural development memory (e.g. seed-proc-flow-1) on non-dev query
        if (/verify\s+with\s+`npm run lint`/i.test(content) && !isDevTask) {
          filteredOut.push({
            id: mem.id,
            content,
            provenance: 'CONVERSATION_MEMORY',
            reason: 'Development verification protocol filtered out for casual request'
          });
          continue;
        }

        // Allow legitimate memory context
        effectiveInstructions.push(`Contextual Memory: ${content}`);
      }
    }

    // 6. External Untrusted Data (Level 10)
    if (input.untrustedContext && input.untrustedContext.length > 0) {
      for (let i = 0; i < input.untrustedContext.length; i++) {
        const raw = input.untrustedContext[i];
        if (INJECTION_PATTERNS.some(p => p.test(raw))) {
          filteredOut.push({
            id: `untrusted-${i}`,
            content: raw,
            provenance: 'EXTERNAL_UNTRUSTED_DATA',
            reason: 'Neutralized malicious prompt injection in external data'
          });
        }
      }
    }

    // 7. Resolve Emoji Allowance:
    // User request controls conversation. Emojis are allowed unless the user explicitly asks for no emojis.
    let allowEmojis = true;
    if (/\b(no\s+emojis?|do\s+not\s+use\s+emojis?|without\s+emojis?|zero\s+emojis?)\b/i.test(promptLower)) {
      allowEmojis = false;
    } else if (input.customInstructions && /\b(no\s+emojis?|zero\s+emojis?)\b/i.test(input.customInstructions)) {
      allowEmojis = false;
    }

    return {
      trustedPolicies,
      effectiveInstructions,
      activeProjectId: input.activeProjectId,
      filteredOut,
      allowEmojis,
      isDevTask,
      appliedBrandRules
    };
  }

  private detectDevelopmentTask(promptLower: string): boolean {
    const devKeywords = [
      'typescript', 'javascript', 'python', 'rust', 'react', 'vite', 'npm run',
      'refactor', 'function', 'class', 'method', 'interface', 'compiler', 'lint',
      'syntax error', 'type error', 'docker', 'sql', 'postgres', 'test fail',
      'fix this code', 'debug this', 'write a function', 'implement'
    ];
    return devKeywords.some(kw => promptLower.includes(kw));
  }

  private sanitizeUntrusted(text: string): string {
    let sanitized = text;
    for (const pattern of INJECTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[REDACTED_UNTRUSTED_OVERRIDE]');
    }
    return sanitized.trim();
  }
}
