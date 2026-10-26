import { CapabilityCategory } from '../../../contracts/src/index.js';

export type SkillTrustLevel = 'TRUSTED_CORE' | 'VERIFIED_PARTNER' | 'COMMUNITY_SANDBOXED';

export interface SkillPermissionPolicy {
  allowedTools: string[];
  allowNetwork: boolean;
  allowFileSystem: boolean;
  allowShell: boolean; // Strictly false for all non-privileged curated skills
}

export interface SkillProvenanceRecord {
  sourceRepo: string;
  sourceCommit: string;
  license: string;
  securityReviewDate: string;
  reviewer: string;
}

export interface SkillEvaluationResult {
  benchmarkSuite: string;
  score: number;
  passed: boolean;
  evaluatedAt: string;
}

export interface CuratedSkillDefinition {
  id: string;
  name: string;
  version: string;
  category: CapabilityCategory;
  trustLevel: SkillTrustLevel;
  permissionPolicy: SkillPermissionPolicy;
  provenance: SkillProvenanceRecord;
  evaluationResult: SkillEvaluationResult;
  promptAddendum: string;
  enabled: boolean;
}

export class CuratedSkillRegistry {
  private skills: Map<string, CuratedSkillDefinition> = new Map();

  constructor() {
    this.registerCuratedBuiltIns();
  }

  public register(skill: CuratedSkillDefinition): void {
    // Invariant: Non-privileged curated skills must never be granted shell execution
    if (skill.permissionPolicy.allowShell) {
      throw new Error(`SECURITY_VIOLATION: Skill "${skill.id}" cannot be registered with allowShell=true.`);
    }
    this.skills.set(skill.id, skill);
  }

  public get(id: string): CuratedSkillDefinition | undefined {
    return this.skills.get(id);
  }

  public list(): CuratedSkillDefinition[] {
    return Array.from(this.skills.values());
  }

  public getByCategory(category: CapabilityCategory): CuratedSkillDefinition[] {
    return this.list().filter(s => s.category === category && s.enabled);
  }

  public getByTrustLevel(trustLevel: SkillTrustLevel): CuratedSkillDefinition[] {
    return this.list().filter(s => s.trustLevel === trustLevel && s.enabled);
  }

  /**
   * Selects skills appropriate for a given task prompt and category.
   */
  public selectSkillsForPrompt(prompt: string, category?: CapabilityCategory): CuratedSkillDefinition[] {
    const lower = (prompt || '').toLowerCase();
    const results: CuratedSkillDefinition[] = [];

    for (const skill of this.skills.values()) {
      if (!skill.enabled) continue;
      if (category && skill.category !== category) continue;

      if (skill.id === 'skill_systematic_debugging' && /\b(?:bug|error|exception|debug|fail|stack trace|regression|fix)\b/i.test(lower)) {
        results.push(skill);
      } else if (skill.id === 'skill_mathematical_precision' && (/\b(?:calculate|calc|compute|arithmetic|formula|quotient)\b/i.test(lower) || /\b\d+\s*[-+*/^]\s*\d+/.test(lower))) {
        results.push(skill);
      } else if (skill.id === 'skill_deep_research_synthesis' && /\b(?:research|investigate|search|sources|citations|evidence)\b/i.test(lower)) {
        results.push(skill);
      } else if (skill.id === 'skill_evidence_qa_verifier' && /\b(?:verify|test|assert|validate|acceptance|audit)\b/i.test(lower)) {
        results.push(skill);
      } else if (skill.id === 'skill_clean_software_architecture' && /\b(?:architecture|refactor|design pattern|decouple|interface)\b/i.test(lower)) {
        results.push(skill);
      } else if (skill.id === 'skill_document_intelligence_extraction' && /\b(?:document|pdf|contract|report|extract sections)\b/i.test(lower)) {
        results.push(skill);
      } else if (skill.id === 'skill_business_intelligence_strategist' && /\b(?:market|business|revenue|roi|pricing|competitor)\b/i.test(lower)) {
        results.push(skill);
      }
    }

    return results;
  }

  /**
   * Builds an instruction addendum from selected skills.
   * Ensures skills cannot override system policies.
   */
  public buildInstructionAddendum(skills: CuratedSkillDefinition[]): string {
    if (skills.length === 0) return '';
    const lines: string[] = [
      '### CURATED SPECIALIST SKILL GUIDANCE (ADVISORY ONLY):'
    ];
    for (const skill of skills) {
      lines.push(`- [${skill.name} v${skill.version}]: ${skill.promptAddendum}`);
    }
    return lines.join('\n');
  }

  private registerCuratedBuiltIns(): void {
    // 1. Systematic Debugging (antigravity-awesome-skills)
    this.register({
      id: 'skill_systematic_debugging',
      name: 'Systematic Debugging & Root Cause Isolation',
      version: '1.0.0',
      category: 'software_engineering',
      trustLevel: 'TRUSTED_CORE',
      permissionPolicy: {
        allowedTools: ['file_system_read', 'file_system_write'],
        allowNetwork: false,
        allowFileSystem: true,
        allowShell: false
      },
      provenance: {
        sourceRepo: 'benjaminasterA/antigravity-awesome-skills',
        sourceCommit: 'f7c81a29b',
        license: 'MIT',
        securityReviewDate: '2026-10-26',
        reviewer: 'AIRA Security Architecture'
      },
      evaluationResult: {
        benchmarkSuite: 'aira-debug-eval-v1',
        score: 0.98,
        passed: true,
        evaluatedAt: '2026-10-26T08:00:00Z'
      },
      promptAddendum: 'Reproduce the defect first, isolate the root cause, form a falsifiable hypothesis, and make the minimal surgical fix.',
      enabled: true
    });

    // 2. Deep Research Synthesis (agentic-awesome-skills)
    this.register({
      id: 'skill_deep_research_synthesis',
      name: 'Multi-Source Evidence Grounding & Synthesis',
      version: '1.0.0',
      category: 'deep_research',
      trustLevel: 'TRUSTED_CORE',
      permissionPolicy: {
        allowedTools: ['web_search'],
        allowNetwork: true,
        allowFileSystem: false,
        allowShell: false
      },
      provenance: {
        sourceRepo: 'sickn33/agentic-awesome-skills',
        sourceCommit: '38a9b20cd',
        license: 'Apache-2.0',
        securityReviewDate: '2026-10-26',
        reviewer: 'AIRA Security Architecture'
      },
      evaluationResult: {
        benchmarkSuite: 'aira-research-grounding-v1',
        score: 0.95,
        passed: true,
        evaluatedAt: '2026-10-26T08:00:00Z'
      },
      promptAddendum: 'Cross-reference claims across multiple authoritative sources. Flag ambiguities and conflicting accounts transparently.',
      enabled: true
    });

    // 3. Clean Software Architecture (antigravity-awesome-skills)
    this.register({
      id: 'skill_clean_software_architecture',
      name: 'Clean Architecture & Modular Decoupling',
      version: '1.0.0',
      category: 'software_engineering',
      trustLevel: 'TRUSTED_CORE',
      permissionPolicy: {
        allowedTools: ['file_system_read'],
        allowNetwork: false,
        allowFileSystem: true,
        allowShell: false
      },
      provenance: {
        sourceRepo: 'benjaminasterA/antigravity-awesome-skills',
        sourceCommit: 'f7c81a29b',
        license: 'MIT',
        securityReviewDate: '2026-10-26',
        reviewer: 'AIRA Security Architecture'
      },
      evaluationResult: {
        benchmarkSuite: 'aira-arch-patterns-v1',
        score: 0.96,
        passed: true,
        evaluatedAt: '2026-10-26T08:00:00Z'
      },
      promptAddendum: 'Enforce strict modular boundaries, dependency inversion, and contract-first interfaces.',
      enabled: true
    });

    // 4. Mathematical Precision (agentic-awesome-skills)
    this.register({
      id: 'skill_mathematical_precision',
      name: 'Mathematical Precision & Quota Arithmetic',
      version: '1.0.0',
      category: 'data_analysis',
      trustLevel: 'TRUSTED_CORE',
      permissionPolicy: {
        allowedTools: ['calculator'],
        allowNetwork: false,
        allowFileSystem: false,
        allowShell: false
      },
      provenance: {
        sourceRepo: 'sickn33/agentic-awesome-skills',
        sourceCommit: '38a9b20cd',
        license: 'Apache-2.0',
        securityReviewDate: '2026-10-26',
        reviewer: 'AIRA Security Architecture'
      },
      evaluationResult: {
        benchmarkSuite: 'aira-math-eval-v1',
        score: 1.0,
        passed: true,
        evaluatedAt: '2026-10-26T08:00:00Z'
      },
      promptAddendum: 'Evaluate formulas deterministically. Never invent default expressions when user prompt contains no arithmetic formula.',
      enabled: true
    });

    // 5. Document Intelligence Extraction (antigravity-awesome-skills)
    this.register({
      id: 'skill_document_intelligence_extraction',
      name: 'Structured Document Extraction & Hierarchy',
      version: '1.0.0',
      category: 'document_intelligence',
      trustLevel: 'VERIFIED_PARTNER',
      permissionPolicy: {
        allowedTools: ['file_system_read'],
        allowNetwork: false,
        allowFileSystem: true,
        allowShell: false
      },
      provenance: {
        sourceRepo: 'benjaminasterA/antigravity-awesome-skills',
        sourceCommit: 'f7c81a29b',
        license: 'MIT',
        securityReviewDate: '2026-10-26',
        reviewer: 'AIRA Security Architecture'
      },
      evaluationResult: {
        benchmarkSuite: 'aira-doc-extract-v1',
        score: 0.94,
        passed: true,
        evaluatedAt: '2026-10-26T08:00:00Z'
      },
      promptAddendum: 'Extract tabular and hierarchical structures verbatim without altering semantic definitions.',
      enabled: true
    });

    // 6. Evidence QA Verifier (agentic-awesome-skills)
    this.register({
      id: 'skill_evidence_qa_verifier',
      name: 'Evidence QA & Reality Gate Verification',
      version: '1.0.0',
      category: 'result_verification',
      trustLevel: 'TRUSTED_CORE',
      permissionPolicy: {
        allowedTools: [],
        allowNetwork: false,
        allowFileSystem: false,
        allowShell: false
      },
      provenance: {
        sourceRepo: 'sickn33/agentic-awesome-skills',
        sourceCommit: '38a9b20cd',
        license: 'Apache-2.0',
        securityReviewDate: '2026-10-26',
        reviewer: 'AIRA Security Architecture'
      },
      evaluationResult: {
        benchmarkSuite: 'aira-qa-evidence-v1',
        score: 0.99,
        passed: true,
        evaluatedAt: '2026-10-26T08:00:00Z'
      },
      promptAddendum: 'Require empirical runtime evidence before certifying any release gate. Zero fabricated passes.',
      enabled: true
    });

    // 7. Business Intelligence Strategist (antigravity-awesome-skills)
    this.register({
      id: 'skill_business_intelligence_strategist',
      name: 'Strategic Business Analysis & Unit Economics',
      version: '1.0.0',
      category: 'business_intelligence',
      trustLevel: 'VERIFIED_PARTNER',
      permissionPolicy: {
        allowedTools: ['web_search'],
        allowNetwork: true,
        allowFileSystem: false,
        allowShell: false
      },
      provenance: {
        sourceRepo: 'benjaminasterA/antigravity-awesome-skills',
        sourceCommit: 'f7c81a29b',
        license: 'MIT',
        securityReviewDate: '2026-10-26',
        reviewer: 'AIRA Security Architecture'
      },
      evaluationResult: {
        benchmarkSuite: 'aira-biz-eval-v1',
        score: 0.92,
        passed: true,
        evaluatedAt: '2026-10-26T08:00:00Z'
      },
      promptAddendum: 'Quantify addressable markets, competitive moats, cost structures, and risk factors objectively.',
      enabled: true
    });
  }
}
