import {
  CapabilityDefinition,
  IntentTaxonomy,
  ExecutionTarget,
  CapabilityCategory,
  ExecutionMode
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

  public getByCategory(category: CapabilityCategory): CapabilityDefinition[] {
    return this.list().filter(c => c.category === category);
  }

  public getByMode(mode: ExecutionMode): CapabilityDefinition[] {
    return this.list().filter(c => c.supportedModes.includes(mode));
  }

  public isAvailable(id: string): boolean {
    const cap = this.get(id);
    return Boolean(cap?.enabled) &&
      (cap?.status === 'READY' || cap?.status === 'PARTIAL') &&
      (cap?.availability === 'GA' || cap?.availability === 'BETA');
  }

  /**
   * Deterministically identifies capability categories from user input.
   * Uses bounded, high-precision keyword and semantic pattern matching.
   */
  public identifyCapabilities(prompt: string, mode?: ExecutionMode): CapabilityDefinition[] {
    const lower = (prompt || '').toLowerCase();
    const matchedCategories = new Set<CapabilityCategory>();

    // 1. Software Engineering
    if (/\b(?:code|coding|function|class|typescript|javascript|python|rust|golang|repo|git|commit|pull request|\bpr\b|refactor|compile|build|syntax|debug|bug|stack trace)\b/i.test(lower)) {
      matchedCategories.add('software_engineering');
    }

    // 2. Data Analysis & Mathematics
    if (/\b(?:calculate|calculator|calc|compute|arithmetic|quotient|product|sum|difference|formula|statistics|average|median|regression|metrics|dataset)\b|\b\d+\s*[-+*/^]\s*\d+/i.test(lower)) {
      matchedCategories.add('data_analysis');
    }

    // 3. Deep Research
    if (/\b(?:search|web search|research|investigate|find papers|articles|browse|gather facts|citations|evidence|market trends)\b/i.test(lower)) {
      matchedCategories.add('deep_research');
    }

    // 4. Document Intelligence
    if (/\b(?:document|pdf|markdown|doc|text file|contract|invoice|report|extract sections|summarize doc|chunk)\b/i.test(lower)) {
      matchedCategories.add('document_intelligence');
    }

    // 5. Business Intelligence
    if (/\b(?:business|market|competitor|revenue|roi|valuation|kpi|growth|pricing|market fit|gtm|go-to-market|unit economics)\b/i.test(lower)) {
      matchedCategories.add('business_intelligence');
    }

    // 6. Agent Planning
    if (mode === 'agent' || /\b(?:mission|plan|multi-step|workflow|orchestrate|pipeline|decompose|subtasks)\b/i.test(lower)) {
      matchedCategories.add('agent_planning');
    }

    // 7. Tool Execution
    if (mode === 'agent' || /\b(?:run command|shell|execute tool|filesystem|system_shell)\b/i.test(lower)) {
      matchedCategories.add('tool_execution');
    }

    // 8. Result Verification
    if (/\b(?:verify|test|validate|audit|assert|certification|compliance|sanity check|acceptance)\b/i.test(lower)) {
      matchedCategories.add('result_verification');
    }

    // 9. Always include General Reasoning as foundation
    matchedCategories.add('general_reasoning');

    // Retrieve active capabilities matching the categories and requested mode
    const identified = this.list().filter(cap => {
      if (!cap.enabled) return false;
      if (!matchedCategories.has(cap.category)) return false;
      if (mode && !cap.supportedModes.includes(mode)) return false;
      return true;
    });

    return identified;
  }

  public resolveExecutionTarget(intent: IntentTaxonomy): { target: ExecutionTarget; capabilityId: string; status: 'READY' | 'PARTIAL' | 'NOT_READY' } {
    const matching = this.getByExecutionType(intent);
    const readyCap = matching.find(c => c.status === 'READY' || c.status === 'PARTIAL');
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
      return { target, capabilityId: readyCap.id, status: readyCap.status as 'READY' | 'PARTIAL' };
    }

    // Downstream capability is not yet ready or implemented
    return {
      target: 'CAPABILITY_NOT_READY',
      capabilityId: matching[0]?.id || `cap_${intent.toLowerCase()}`,
      status: 'NOT_READY'
    };
  }

  private registerBuiltIns(): void {
    // 1. General Reasoning (Foundation)
    this.register({
      id: 'cap_general_reasoning',
      name: 'General Reasoning & Conversational Synthesis',
      version: '1.0.0',
      category: 'general_reasoning',
      executionType: 'ANSWER',
      supportedModes: ['chat', 'agent'],
      requiredTools: [],
      requiredPermissions: [],
      promptProfileId: 'profile_general_reasoning',
      resourceLimits: { maxTokens: 4096, timeoutMs: 30000 },
      evaluationRequirements: { minAccuracy: 0.95 },
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'NONE',
      approvalPolicy: 'autonomous',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_chat',
      status: 'READY'
    });

    // 2. Deep Research
    this.register({
      id: 'cap_deep_research',
      name: 'Deep Research & Multi-Source Synthesis',
      version: '1.0.0',
      category: 'deep_research',
      executionType: 'RESEARCH',
      supportedModes: ['chat', 'agent'],
      requiredTools: ['web_search', 'firecrawl_scrape'],
      requiredPermissions: ['network:outbound'],
      promptProfileId: 'profile_deep_research',
      resourceLimits: { maxTokens: 8192, timeoutMs: 60000, maxToolCalls: 5 },
      evaluationRequirements: { minAccuracy: 0.90, requiresGrounding: true },
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'READ',
      approvalPolicy: 'autonomous',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_research',
      status: 'PARTIAL'
    });

    // 3. Software Engineering
    this.register({
      id: 'cap_software_engineering',
      name: 'Autonomous Software Engineering & Code Intelligence',
      version: '1.0.0',
      category: 'software_engineering',
      executionType: 'TOOL_ACTION',
      supportedModes: ['chat', 'agent'],
      requiredTools: ['file_system_read', 'file_system_write', 'repo_git_status', 'repo_git_log'],
      requiredPermissions: ['fs:workspace_read', 'fs:workspace_write'],
      promptProfileId: 'profile_software_engineering',
      resourceLimits: { maxTokens: 8192, timeoutMs: 90000, maxSteps: 20 },
      evaluationRequirements: { minAccuracy: 0.98, requiresToolVerification: true },
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'WRITE',
      approvalPolicy: 'require_approval',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_software',
      status: 'READY'
    });

    // 4. Data Analysis & Mathematics
    this.register({
      id: 'cap_data_analysis',
      name: 'Data Analysis & Mathematical Precision',
      version: '1.0.0',
      category: 'data_analysis',
      executionType: 'TOOL_ACTION',
      supportedModes: ['chat', 'agent'],
      requiredTools: ['calculator'],
      requiredPermissions: [],
      promptProfileId: 'profile_data_analysis',
      resourceLimits: { maxTokens: 4096, timeoutMs: 30000, maxToolCalls: 5 },
      evaluationRequirements: { minAccuracy: 1.0 },
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'NONE',
      approvalPolicy: 'autonomous',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_tool',
      status: 'READY'
    });

    // 5. Document Intelligence
    this.register({
      id: 'cap_document_intelligence',
      name: 'Document Intelligence & Structured Extraction',
      version: '1.0.0',
      category: 'document_intelligence',
      executionType: 'RESEARCH',
      supportedModes: ['chat', 'agent'],
      requiredTools: ['file_system_read'],
      requiredPermissions: ['fs:workspace_read'],
      promptProfileId: 'profile_document_intelligence',
      resourceLimits: { maxTokens: 8192, timeoutMs: 45000 },
      evaluationRequirements: { minAccuracy: 0.95, requiresGrounding: true },
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'READ',
      approvalPolicy: 'autonomous',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_document',
      status: 'READY'
    });

    // 6. Business Intelligence
    this.register({
      id: 'cap_business_intelligence',
      name: 'Strategic Business Intelligence & Market Analysis',
      version: '1.0.0',
      category: 'business_intelligence',
      executionType: 'ANSWER',
      supportedModes: ['chat', 'agent'],
      requiredTools: ['web_search'],
      requiredPermissions: ['network:outbound'],
      promptProfileId: 'profile_business_intelligence',
      resourceLimits: { maxTokens: 4096, timeoutMs: 45000 },
      evaluationRequirements: { minAccuracy: 0.90 },
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'NONE',
      approvalPolicy: 'autonomous',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_chat',
      status: 'READY'
    });

    // 7. Agent Planning
    this.register({
      id: 'cap_agent_planning',
      name: 'Hierarchical Task Decomposition & Mission Planning',
      version: '1.0.0',
      category: 'agent_planning',
      executionType: 'AGENT_MISSION',
      supportedModes: ['agent'],
      requiredTools: ['workflow_compiler'],
      requiredPermissions: ['runtime:execute_mission'],
      promptProfileId: 'profile_agent_planning',
      resourceLimits: { maxTokens: 8192, timeoutMs: 120000, maxSteps: 30 },
      evaluationRequirements: { minAccuracy: 0.95 },
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'WRITE',
      approvalPolicy: 'require_approval',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_mission',
      status: 'READY'
    });

    // 8. Tool Execution Gateway
    this.register({
      id: 'cap_tool_execution',
      name: 'Authoritative Tool Execution & Safety Kernel',
      version: '1.0.0',
      category: 'tool_execution',
      executionType: 'TOOL_ACTION',
      supportedModes: ['agent'],
      requiredTools: ['tool_gateway'],
      requiredPermissions: ['runtime:tool_execute'],
      promptProfileId: 'profile_tool_execution',
      resourceLimits: { maxTokens: 4096, timeoutMs: 60000, maxToolCalls: 10 },
      evaluationRequirements: { minAccuracy: 0.99, requiresToolVerification: true },
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'READ',
      approvalPolicy: 'require_approval',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_tool',
      status: 'READY'
    });

    // 9. Result Verification
    this.register({
      id: 'cap_result_verification',
      name: 'Multi-Perspective Evidence & Reality Verification',
      version: '1.0.0',
      category: 'result_verification',
      executionType: 'ANSWER',
      supportedModes: ['chat', 'agent'],
      requiredTools: [],
      requiredPermissions: [],
      promptProfileId: 'profile_result_verification',
      resourceLimits: { maxTokens: 4096, timeoutMs: 30000 },
      evaluationRequirements: { minAccuracy: 0.98 },
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'NONE',
      approvalPolicy: 'autonomous',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_verification',
      status: 'READY'
    });

    // Legacy Aliases for 100% Backward Compatibility
    this.register({
      id: 'cap_chat_answer',
      name: 'Direct Conversational Synthesis (Legacy)',
      version: '1.0.0',
      category: 'general_reasoning',
      executionType: 'ANSWER',
      supportedModes: ['chat'],
      requiredTools: [],
      requiredPermissions: [],
      promptProfileId: 'profile_general_reasoning',
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'NONE',
      approvalPolicy: 'autonomous',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_chat',
      status: 'READY'
    });

    this.register({
      id: 'cap_research_synthesis',
      name: 'Deep Research & Source Synthesis (Legacy)',
      version: '1.0.0',
      category: 'deep_research',
      executionType: 'RESEARCH',
      supportedModes: ['chat', 'agent'],
      requiredTools: ['web_search'],
      requiredPermissions: ['network:outbound'],
      promptProfileId: 'profile_deep_research',
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'READ',
      approvalPolicy: 'autonomous',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_research',
      status: 'PARTIAL'
    });

    this.register({
      id: 'cap_tool_action',
      name: 'Verified Tool Execution Gateway (Legacy)',
      version: '1.0.0',
      category: 'tool_execution',
      executionType: 'TOOL_ACTION',
      supportedModes: ['agent'],
      requiredTools: ['tool_gateway'],
      requiredPermissions: [],
      promptProfileId: 'profile_tool_execution',
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'READ',
      approvalPolicy: 'require_approval',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_tool',
      status: 'READY'
    });

    this.register({
      id: 'cap_agent_mission',
      name: 'Autonomous Agent Mission Planner (Legacy)',
      version: '1.0.0',
      category: 'agent_planning',
      executionType: 'AGENT_MISSION',
      supportedModes: ['agent'],
      requiredTools: ['workflow_compiler'],
      requiredPermissions: [],
      promptProfileId: 'profile_agent_planning',
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'WRITE',
      approvalPolicy: 'require_approval',
      requiredPrincipalScope: [],
      handler: 'agent_runtime_mission',
      status: 'READY'
    });

    this.register({
      id: 'cap_automation_create',
      name: 'Scheduled Automation Engineering (Legacy)',
      version: '1.0.0',
      category: 'software_engineering',
      executionType: 'AUTOMATION_CREATE',
      supportedModes: ['agent'],
      requiredTools: [],
      requiredPermissions: [],
      promptProfileId: 'profile_software_engineering',
      enabled: true,
      availability: 'BETA',
      sideEffectClass: 'WRITE',
      approvalPolicy: 'require_approval',
      requiredPrincipalScope: [],
      handler: 'automation_engine',
      status: 'READY'
    });

    this.register({
      id: 'cap_workflow_engine',
      name: 'Multi-Step Workflow Engine (Legacy)',
      version: '1.0.0',
      category: 'agent_planning',
      executionType: 'WORKFLOW',
      supportedModes: ['agent'],
      requiredTools: ['workflow_compiler'],
      requiredPermissions: [],
      promptProfileId: 'profile_agent_planning',
      enabled: true,
      availability: 'GA',
      sideEffectClass: 'WRITE',
      approvalPolicy: 'require_approval',
      requiredPrincipalScope: [],
      handler: 'workflow_engine',
      status: 'READY'
    });
  }
}
