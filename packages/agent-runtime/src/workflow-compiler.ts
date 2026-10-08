import {
  WorkflowDefinition,
  WorkflowDefinitionSchema,
  validateWorkflowDag,
  ExecutionPrincipal,
  SideEffectLevel
} from '../../contracts/src/index.js';
import { ModelRouter } from '../../model-router/src/index.js';

export class WorkflowCompiler {
  constructor(private modelRouter?: ModelRouter) {}

  /**
   * Compiles natural language intent into a deterministic, validated WorkflowDefinition
   */
  public async compile(
    prompt: string,
    principal: ExecutionPrincipal
  ): Promise<WorkflowDefinition> {
    const text = prompt.toLowerCase();

    // 1. Check for Destructive / Mutation Workflows first
    const isDestructive = /delete|drop|remove|destroy|truncate|wipe/.test(text);
    if (isDestructive) {
      const def: WorkflowDefinition = {
        workflowId: `wf_destruct_${Date.now()}`,
        version: 1,
        name: `Destructive Operation Workflow: ${prompt.slice(0, 40)}`,
        description: 'Server-guarded destructive action workflow requiring explicit approval checkpoint.',
        principalId: principal.userId,
        inputSchema: { prompt },
        steps: [
          {
            stepId: 'destructive_command',
            name: 'Execute Guarded Destructive Action',
            type: 'TOOL',
            toolName: 'system_shell',
            dependsOn: [],
            input: { command: prompt },
            sideEffectLevel: 'DESTRUCTIVE' as SideEffectLevel,
            approvalRequired: true,
            timeoutMs: 30000,
            retry: { maxAttempts: 1, backoffMs: 1000, factor: 1 }
          }
        ],
        executionPolicy: { maxConcurrentSteps: 1, timeoutMs: 60000 },
        outputSchema: {},
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      return WorkflowDefinitionSchema.parse(def);
    }

    // 2. Deterministic Pattern: Research, Summarize & Report
    if (
      /research|investigate|study/.test(text) &&
      /summarize|analyze|extract/.test(text) &&
      /report|brief|synthesize/.test(text)
    ) {
      const topicMatch = prompt.match(/research\s+(?:the\s+latest\s+|three\s+important\s+recent\s+advances\s+in\s+)?([^,.;]+)/i);
      const topic = topicMatch ? topicMatch[1].trim() : prompt;

      const def: WorkflowDefinition = {
        workflowId: `wf_research_report_${Date.now()}`,
        version: 1,
        name: `Research & Synthesis Workflow: ${topic.slice(0, 36)}`,
        description: 'Multi-step DAG executing targeted research, findings extraction, and final synthesized report.',
        principalId: principal.userId,
        inputSchema: { topic },
        steps: [
          {
            stepId: 'step_1_research',
            name: 'Domain Evidence Discovery',
            type: 'CAPABILITY',
            capability: 'RESEARCH',
            dependsOn: [],
            input: { topic: `Recent advances and technical developments in ${topic}` },
            sideEffectLevel: 'READ',
            approvalRequired: false,
            timeoutMs: 60000,
            retry: { maxAttempts: 3, backoffMs: 1000, factor: 2 }
          },
          {
            stepId: 'step_2_extract_findings',
            name: 'Extract Key Discoveries',
            type: 'SYNTHESIS',
            capability: 'ANSWER',
            dependsOn: ['step_1_research'],
            input: { prompt: `Extract the three to five most important breakthrough findings and citation references from:\n{{steps.step_1_research.output}}` },
            sideEffectLevel: 'NONE',
            approvalRequired: false,
            timeoutMs: 60000,
            retry: { maxAttempts: 2, backoffMs: 1000, factor: 2 }
          },
          {
            stepId: 'step_3_final_report',
            name: 'Compile Final Verification Report',
            type: 'SYNTHESIS',
            capability: 'ANSWER',
            dependsOn: ['step_2_extract_findings'],
            input: { prompt: `Prepare a clean, executive summary report with methodology, findings, and verified DOI sources based on:\n{{steps.step_2_extract_findings.output}}` },
            sideEffectLevel: 'NONE',
            approvalRequired: false,
            timeoutMs: 60000,
            retry: { maxAttempts: 2, backoffMs: 1000, factor: 2 }
          }
        ],
        executionPolicy: { maxConcurrentSteps: 2, timeoutMs: 180000 },
        outputSchema: {},
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      const valid = validateWorkflowDag(def);
      if (!valid.valid) throw new Error(valid.error);
      return WorkflowDefinitionSchema.parse(def);
    }

    // 3. Fallback: Generic Multi-Step Synthesis Workflow
    const def: WorkflowDefinition = {
      workflowId: `wf_generic_${Date.now()}`,
      version: 1,
      name: `Multi-Step Workflow: ${prompt.slice(0, 36)}`,
      description: 'Standard multi-step execution pipeline.',
      principalId: principal.userId,
      inputSchema: { prompt },
      steps: [
        {
          stepId: 'step_analyze',
          name: 'Analyze Context & Formulate Strategy',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: [],
          input: { prompt: `Analyze the user objective and structure the execution plan:\n${prompt}` },
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 60000,
          retry: { maxAttempts: 2, backoffMs: 1000, factor: 2 }
        },
        {
          stepId: 'step_execute_synthesize',
          name: 'Synthesize Execution Results',
          type: 'SYNTHESIS',
          capability: 'ANSWER',
          dependsOn: ['step_analyze'],
          input: { prompt: `Execute and synthesize complete deliverables based on:\n{{steps.step_analyze.output}}` },
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 60000,
          retry: { maxAttempts: 2, backoffMs: 1000, factor: 2 }
        }
      ],
      executionPolicy: { maxConcurrentSteps: 2, timeoutMs: 120000 },
      outputSchema: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const valid = validateWorkflowDag(def);
    if (!valid.valid) throw new Error(valid.error);
    return WorkflowDefinitionSchema.parse(def);
  }
}
