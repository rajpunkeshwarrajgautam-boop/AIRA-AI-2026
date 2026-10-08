import {
  CapabilityDefinition,
  IntentTaxonomy,
  ExecutionTarget
} from '../../contracts/src/index.js';

export class CapabilityRegistry {
  private capabilities: Map<string, CapabilityDefinition> = new Map();

  constructor() {
    this.registerBuiltIns();
  }

  public register(cap: CapabilityDefinition): void {
    this.capabilities.set(cap.id, cap);
  }

  public get(id: string): CapabilityDefinition | undefined {
    return this.capabilities.get(id);
  }

  public list(): CapabilityDefinition[] {
    return Array.from(this.capabilities.values());
  }

  public getByExecutionType(type: IntentTaxonomy): CapabilityDefinition[] {
    return this.list().filter(c => c.executionType === type);
  }

  public isAvailable(id: string): boolean {
    const cap = this.get(id);
    return cap?.status === 'READY' && (cap.availability === 'GA' || cap.availability === 'BETA');
  }

  public resolveExecutionTarget(intent: IntentTaxonomy): { target: ExecutionTarget; capabilityId: string; status: 'READY' | 'NOT_READY' } {
    const matching = this.getByExecutionType(intent);
    const readyCap = matching.find(c => c.status === 'READY');
    if (readyCap) {
      let target: ExecutionTarget = 'CHAT_STREAM';
      switch (intent) {
        case 'ANSWER':
          target = 'CHAT_STREAM';
          break;
        case 'RESEARCH':
          target = 'RESEARCH_SYNTHESIS';
          break;
        case 'TOOL_ACTION':
          target = 'TOOL_PIPELINE';
          break;
        case 'AGENT_MISSION':
          target = 'AGENT_PLANNER';
          break;
        case 'AUTOMATION_CREATE':
          target = 'AUTOMATION_ENGINE';
          break;
        case 'WORKFLOW':
          target = 'WORKFLOW_ENGINE';
          break;
      }
      return { target, capabilityId: readyCap.id, status: 'READY' };
    }

    // Downstream capability is not yet ready or implemented
    return {
      target: 'CAPABILITY_NOT_READY',
      capabilityId: matching[0]?.id || `cap_${intent.toLowerCase()}`,
      status: 'NOT_READY'
    };
  }

  private registerBuiltIns(): void {
    this.register({
      id: 'cap_chat_answer',
      name: 'Direct Conversational Synthesis',
      executionType: 'ANSWER',
      availability: 'GA',
      sideEffectClass: 'NONE',
      approvalPolicy: 'autonomous',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_chat',
      status: 'READY'
    });

    this.register({
      id: 'cap_research_synthesis',
      name: 'Deep Research & Source Synthesis',
      executionType: 'RESEARCH',
      availability: 'GA',
      sideEffectClass: 'READ',
      approvalPolicy: 'autonomous',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_research',
      status: 'READY'
    });

    this.register({
      id: 'cap_tool_action',
      name: 'Verified Tool Execution Gateway',
      executionType: 'TOOL_ACTION',
      availability: 'GA',
      sideEffectClass: 'READ',
      approvalPolicy: 'require_approval',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_tool',
      status: 'READY'
    });

    this.register({
      id: 'cap_agent_mission',
      name: 'Autonomous Agent Mission Planner',
      executionType: 'AGENT_MISSION',
      availability: 'GA',
      sideEffectClass: 'WRITE',
      approvalPolicy: 'require_approval',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_mission',
      status: 'READY'
    });

    this.register({
      id: 'cap_automation_create',
      name: 'Scheduled Automation Engineering',
      executionType: 'AUTOMATION_CREATE',
      availability: 'BETA',
      sideEffectClass: 'WRITE',
      approvalPolicy: 'require_approval',
      requiredPrincipalScope: [],
      handler: 'automation_engine',
      status: 'READY'
    });

    this.register({
      id: 'cap_workflow_engine',
      name: 'Multi-Step Workflow Engine',
      executionType: 'WORKFLOW',
      availability: 'GA',
      sideEffectClass: 'WRITE',
      approvalPolicy: 'require_approval',
      requiredPrincipalScope: [],
      handler: 'workflow_engine',
      status: 'READY'
    });
  }
}
