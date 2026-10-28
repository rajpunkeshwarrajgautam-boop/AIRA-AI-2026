import { EventEmitter } from 'events';
import {
  ToolDefinition,
  DurableToolCall,
  ToolResult,
  ExecutionPrincipal,
  SideEffectLevel,
  ToolGatewayErrorCodes,
  ToolLifecycleState,
  ToolCall
} from '../../contracts/src/index.js';
import { ApprovalKernel } from '../../approvals/src/index.js';
import { PostgresToolCallRepository, ToolCallRepository } from './repository.js';
import { BrowserAdapter } from './adapters/browser-adapter.js';
import { FileSystemAdapter } from './adapters/file-adapter.js';
import { RepositoryAdapter } from './adapters/repo-adapter.js';
import { ConnectorRegistry, GitHubConnectorAdapter } from './adapters/connector-adapter.js';

export interface GatewayExecutionContext {
  runId: string;
  workflowRunId?: string;
  agentMissionId?: string;
  principal: ExecutionPrincipal;
  idempotencyKey?: string;
  workspaceRoot?: string;
}

export interface ToolGatewayInvocation {
  toolName: string;
  arguments: Record<string, any>;
  context: GatewayExecutionContext;
  callId?: string;
}

export interface ExecutableToolAdapter {
  definition: ToolDefinition;
  execute: (args: Record<string, any>, context: GatewayExecutionContext) => Promise<any>;
}

export class ToolGateway extends EventEmitter {
  private tools: Map<string, ExecutableToolAdapter> = new Map();
  private browserAdapter: BrowserAdapter;
  private fileAdapter: FileSystemAdapter;
  private repoAdapter: RepositoryAdapter;
  private connectorRegistry: ConnectorRegistry;

  constructor(
    private repository: ToolCallRepository = new PostgresToolCallRepository(),
    private approvalKernel?: ApprovalKernel,
    private workspaceRoot = process.cwd()
  ) {
    super();
    this.browserAdapter = new BrowserAdapter();
    this.fileAdapter = new FileSystemAdapter(this.workspaceRoot);
    this.repoAdapter = new RepositoryAdapter(this.workspaceRoot);
    this.connectorRegistry = new ConnectorRegistry();
    this.connectorRegistry.register(new GitHubConnectorAdapter());

    this.registerBuiltInTools();
  }

  public registerTool(tool: ExecutableToolAdapter): void {
    this.tools.set(tool.definition.name, tool);
    if (tool.definition.id) {
      this.tools.set(tool.definition.id, tool);
    }
  }

  public getTool(nameOrId: string): ExecutableToolAdapter | undefined {
    return this.tools.get(nameOrId);
  }

  public hasTool(nameOrId: string): boolean {
    return this.tools.has(nameOrId);
  }

  public listDefinitions(): ToolDefinition[] {
    const unique = new Map<string, ToolDefinition>();
    for (const t of this.tools.values()) {
      unique.set(t.definition.name, t.definition);
    }
    return Array.from(unique.values());
  }

  public getBrowserAdapter(): BrowserAdapter {
    return this.browserAdapter;
  }

  public getConnectorRegistry(): ConnectorRegistry {
    return this.connectorRegistry;
  }

  /**
   * The central authoritative 12-step Gateway Execution Pipeline
   */
  public async execute(invocation: ToolGatewayInvocation): Promise<ToolResult> {
    const startTime = Date.now();
    const callId = invocation.callId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const { toolName, arguments: args, context } = invocation;
    const { runId, principal } = context;

    // STEP 1: Resolve Tool Definition
    const tool = this.getTool(toolName);
    if (!tool) {
      const errorMsg = `Tool "${toolName}" was not found in the Tool Registry.`;
      this.emit('tool.validation_failed', { callId, runId, toolName, error: errorMsg });
      return {
        toolCallId: callId,
        output: null,
        error: errorMsg,
        errorCode: ToolGatewayErrorCodes.TOOL_NOT_FOUND,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
        artifacts: []
      };
    }
    const def = tool.definition;
    this.emit('tool.resolved', { callId, runId, toolId: def.id, toolName: def.name });

    // STEP 2: Verify Capability Availability
    if (def.availability !== 'READY') {
      const errorMsg = `Tool "${def.name}" is currently ${def.availability} and cannot be executed.`;
      return {
        toolCallId: callId,
        output: null,
        error: errorMsg,
        errorCode: ToolGatewayErrorCodes.CAPABILITY_NOT_READY,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
        artifacts: []
      };
    }

    // STEP 3: Verify ExecutionPrincipal Authenticity
    if (!principal || !principal.userId || !principal.sessionId) {
      const errorMsg = 'Invalid or unauthenticated ExecutionPrincipal.';
      return {
        toolCallId: callId,
        output: null,
        error: errorMsg,
        errorCode: ToolGatewayErrorCodes.TOOL_PERMISSION_DENIED,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
        artifacts: []
      };
    }

    // STEP 4: Validate Input Arguments
    const validationError = this.validateArguments(args, def);
    if (validationError) {
      this.emit('tool.validation_failed', { callId, runId, toolName: def.name, error: validationError });
      return {
        toolCallId: callId,
        output: null,
        error: validationError,
        errorCode: ToolGatewayErrorCodes.TOOL_INPUT_INVALID,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
        artifacts: []
      };
    }

    // STEP 5: Verify Scopes & Permissions
    const scopeError = this.verifyPermissionScopes(principal, def);
    if (scopeError) {
      return {
        toolCallId: callId,
        output: null,
        error: scopeError,
        errorCode: ToolGatewayErrorCodes.TOOL_PERMISSION_DENIED,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
        artifacts: []
      };
    }

    // STEP 6: Determine Side-Effect Level
    const sideEffectLevel: SideEffectLevel = def.sideEffectLevel ||
      (def.permissionLevel === 'DESTRUCTIVE' ? 'DESTRUCTIVE' : def.permissionLevel === 'WRITE' ? 'WRITE' : 'READ');
    const policyRequiresApproval = def.approvalPolicy === 'require_approval' || def.approvalPolicy === 'always_ask';
    const requiresApproval = policyRequiresApproval ||
      def.permissionLevel === 'DESTRUCTIVE' ||
      def.permissionLevel === 'WRITE' ||
      sideEffectLevel === 'DESTRUCTIVE' ||
      sideEffectLevel === 'WRITE';
    // Preserve the strongest classification represented by either axis. The
    // ApprovalKernel maps DESTRUCTIVE to critical risk and FINANCIAL to high;
    // WRITE must not erase a FINANCIAL permission classification.
    const approvalPermissionLevel =
      def.permissionLevel === 'DESTRUCTIVE' || sideEffectLevel === 'DESTRUCTIVE'
        ? 'DESTRUCTIVE'
        : def.permissionLevel === 'FINANCIAL'
          ? 'FINANCIAL'
          : def.permissionLevel === 'WRITE' || sideEffectLevel === 'WRITE' ||
              (policyRequiresApproval && def.permissionLevel === 'READ')
            ? 'WRITE'
            : def.permissionLevel;

    // Even an idempotent replay must not be reported as successful if the
    // approval boundary itself is not configured for an approval-required tool.
    if (requiresApproval && !this.approvalKernel) {
      return this.approvalUnavailableResult(callId, runId, def.name, startTime);
    }

    // STEP 7: Check Idempotency Cache for mutative actions
    if (context.idempotencyKey) {
      const cached = await this.repository.getToolCallByIdempotencyKey(context.idempotencyKey);
      if (cached && cached.lifecycleState === 'COMPLETED') {
        const cachedPrincipalId = cached.principalId;
        const callerPrincipalId = principal.userId;
        if (
          typeof cachedPrincipalId !== 'string' || cachedPrincipalId.trim().length === 0 ||
          typeof callerPrincipalId !== 'string' || callerPrincipalId.trim().length === 0 ||
          cachedPrincipalId !== callerPrincipalId
        ) {
          return this.idempotencyReplayDeniedResult(callId, runId, def.name, startTime);
        }

        // If the idempotency key was explicitly scoped to a specific run, reject
        // replaying its cached receipt from a different run.
        if (
          cached.runId &&
          runId &&
          cached.runId !== runId &&
          (cached.idempotencyKey?.includes(`_${cached.runId}_`) || context.idempotencyKey?.includes(`_${runId}_`))
        ) {
          console.warn(
            `[ToolGateway] Cross-run idempotency collision blocked: receipt run (${cached.runId}) !== caller run (${runId})`
          );
        } else {
          return {
            toolCallId: cached.id,
            output: cached.output,
            isError: false,
            durationMs: cached.durationMs || 0,
            timestamp: Date.now(),
            artifacts: []
          };
        }
      }
    }

    // STEP 8: Evaluate Approval Kernel
    if (requiresApproval) {
      try {
        const isApproved = await this.approvalKernel.isToolCallApproved(
          runId,
          def.name,
          approvalPermissionLevel,
          principal.userId
        );

        if (!isApproved) {
          // Suspend execution and create ApprovalRequest. Any persistence failure
          // below must fail closed before the adapter dispatch step.
          const initialToolCall: ToolCall = {
            id: callId,
            toolId: def.id,
            name: def.name,
            arguments: args,
            timestamp: startTime
          };

          const approvalReq = await this.approvalKernel.createRequest(
            runId,
            initialToolCall,
            approvalPermissionLevel,
            `Action "${def.name}" requires user authorization under ${sideEffectLevel} policy.`
          );

          const durableCall: DurableToolCall = {
            id: callId,
            runId,
            workflowRunId: context.workflowRunId,
            agentMissionId: context.agentMissionId,
            principalId: principal.userId,
            toolId: def.id,
            toolName: def.name,
            adapter: def.adapter,
            sideEffectLevel,
            permissionScopes: def.permissionScopes,
            lifecycleState: 'WAITING_FOR_APPROVAL',
            arguments: args,
            approvalId: approvalReq.id,
            idempotencyKey: context.idempotencyKey,
            startedAt: startTime
          };
          await this.repository.saveToolCall(durableCall);

          this.emit('tool.approval_required', {
            callId,
            runId,
            requestId: approvalReq.id,
            toolName: def.name,
            sideEffectLevel
          });

          return {
            toolCallId: callId,
            output: {
              approvalRequired: true,
              requestId: approvalReq.id,
              status: 'WAITING_FOR_APPROVAL',
              reason: approvalReq.reason
            },
            isError: false,
            durationMs: Date.now() - startTime,
            timestamp: Date.now(),
            artifacts: []
          };
        }
      } catch {
        // Do not leak approval-store errors, and never continue to adapter execution
        // when approval state cannot be established or persisted.
        return this.approvalUnavailableResult(callId, runId, def.name, startTime);
      }
    }

    // STEP 9: Create and Persist Durable ToolCall (RUNNING)
    const durableCall: DurableToolCall = {
      id: callId,
      runId,
      workflowRunId: context.workflowRunId,
      agentMissionId: context.agentMissionId,
      principalId: principal.userId,
      toolId: def.id,
      toolName: def.name,
      adapter: def.adapter,
      sideEffectLevel,
      permissionScopes: def.permissionScopes,
      lifecycleState: 'RUNNING',
      arguments: args,
      attemptCount: 1,
      idempotencyKey: context.idempotencyKey,
      startedAt: startTime
    };
    await this.repository.saveToolCall(durableCall);
    this.emit('tool.started', { callId, runId, toolName: def.name });

    // STEP 10: Dispatch to Adapter with Bounded Retries & Timeout
    let output: any = null;
    let error: string | null = null;
    let errorCode: string | undefined;
    let artifacts: any[] = [];
    const maxAttempts = def.retryPolicy?.maxAttempts || 1;
    let attempt = 1;

    while (attempt <= maxAttempts) {
      try {
        output = await this.executeWithTimeout(tool, args, context, def.timeoutMs);
        error = null;
        break;
      } catch (err: any) {
        error = err.message || String(err);
        const isTransient = this.isTransientError(error, def);
        if (!isTransient || attempt >= maxAttempts) {
          errorCode = ToolGatewayErrorCodes.TOOL_EXECUTION_FAILED;
          break;
        }

        const delay = (def.retryPolicy?.backoffMs || 500) * Math.pow(def.retryPolicy?.factor || 2, attempt - 1);
        await new Promise(r => setTimeout(r, Math.min(delay, 5000)));
        attempt++;
        durableCall.attemptCount = attempt;
        await this.repository.saveToolCall(durableCall);
      }
    }

    // STEP 11: Collect Artifacts if output includes artifacts
    if (output && output.artifacts && Array.isArray(output.artifacts)) {
      artifacts = output.artifacts;
    }

    // STEP 12: Terminal State Update & Persistence
    const durationMs = Date.now() - startTime;
    const finalState: ToolLifecycleState = error ? 'FAILED' : 'COMPLETED';

    await this.repository.updateToolCallStatus(
      callId,
      finalState,
      output,
      error || undefined,
      errorCode,
      durationMs
    );

    if (error) {
      this.emit('tool.failed', { callId, runId, toolName: def.name, error, durationMs });
      return {
        toolCallId: callId,
        output: null,
        error,
        errorCode: errorCode || ToolGatewayErrorCodes.TOOL_EXECUTION_FAILED,
        isError: true,
        durationMs,
        timestamp: Date.now(),
        artifacts: []
      };
    }

    this.emit('tool.completed', { callId, runId, toolName: def.name, output, durationMs });
    return {
      toolCallId: callId,
      output,
      isError: false,
      durationMs,
      timestamp: Date.now(),
      artifacts
    };
  }

  private idempotencyReplayDeniedResult(
    callId: string,
    runId: string,
    toolName: string,
    startTime: number
  ): ToolResult {
    const error = 'Cached result ownership could not be verified; the replay was denied.';
    this.emit('tool.validation_failed', { callId, runId, toolName, error });
    return {
      toolCallId: callId,
      output: null,
      error,
      errorCode: ToolGatewayErrorCodes.TOOL_PERMISSION_DENIED,
      isError: true,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
      artifacts: []
    };
  }

  private approvalUnavailableResult(
    callId: string,
    runId: string,
    toolName: string,
    startTime: number
  ): ToolResult {
    const error = `Approval could not be verified for tool "${toolName}"; the operation was not executed.`;
    this.emit('tool.approval_failed', { callId, runId, toolName, code: ToolGatewayErrorCodes.TOOL_APPROVAL_DENIED });
    return {
      toolCallId: callId,
      output: null,
      error,
      errorCode: ToolGatewayErrorCodes.TOOL_APPROVAL_DENIED,
      isError: true,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
      artifacts: []
    };
  }

  /**
   * Cancel an active tool call
   */
  public async cancel(callId: string, principal: ExecutionPrincipal): Promise<boolean> {
    const call = await this.repository.getToolCall(callId);
    if (!call || call.principalId !== principal.userId) {
      return false;
    }
    if (call.lifecycleState === 'COMPLETED' || call.lifecycleState === 'CANCELLED') {
      return false;
    }

    await this.repository.updateToolCallStatus(callId, 'CANCELLED', undefined, 'Operation cancelled by user.', ToolGatewayErrorCodes.TOOL_CANCELLED);
    this.emit('tool.cancelled', { callId, runId: call.runId, toolName: call.toolName });
    return true;
  }

  private async executeWithTimeout(
    tool: ExecutableToolAdapter,
    args: Record<string, any>,
    context: GatewayExecutionContext,
    timeoutMs?: number
  ): Promise<any> {
    const effectiveTimeout = timeoutMs && timeoutMs > 0 ? timeoutMs : 45000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`TOOL_TIMEOUT: Tool execution exceeded limit of ${effectiveTimeout}ms.`));
      }, effectiveTimeout);

      tool.execute(args, context)
        .then(res => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch(err => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private validateArguments(args: Record<string, any>, def: ToolDefinition): string | null {
    if (!def.parameters || typeof def.parameters !== 'object') return null;

    const schemaProps = def.parameters.properties || {};
    const required = Array.isArray(def.parameters.required) ? def.parameters.required : [];

    for (const reqField of required) {
      if (args[reqField] === undefined || args[reqField] === null || args[reqField] === '') {
        return `Validation failed: Required argument "${reqField}" is missing for tool "${def.name}".`;
      }
    }

    for (const [key, propDef] of Object.entries(schemaProps)) {
      const val = args[key];
      if (val === undefined || val === null) continue;
      const expectedType = (propDef as any).type;
      if (expectedType === 'string' && typeof val !== 'string') {
        return `Validation failed: Argument "${key}" must be a string.`;
      }
      if (expectedType === 'number' && typeof val !== 'number') {
        return `Validation failed: Argument "${key}" must be a number.`;
      }
      if (expectedType === 'boolean' && typeof val !== 'boolean') {
        return `Validation failed: Argument "${key}" must be a boolean.`;
      }
    }

    return null;
  }

  private verifyPermissionScopes(principal: ExecutionPrincipal, def: ToolDefinition): string | null {
    if (!def.permissionScopes || def.permissionScopes.length === 0) return null;
    if (!principal.scopes || principal.scopes.length === 0) {
      return `TOOL_PERMISSION_DENIED: ExecutionPrincipal lacks required scope "${def.permissionScopes[0]}".`;
    }

    for (const requiredScope of def.permissionScopes) {
      if (!principal.scopes.includes(requiredScope) && !principal.scopes.includes('*')) {
        return `TOOL_PERMISSION_DENIED: ExecutionPrincipal lacks required scope "${requiredScope}".`;
      }
    }
    return null;
  }

  private isTransientError(error: string, def: ToolDefinition): boolean {
    const transientPatterns = ['ECONNRESET', 'ETIMEDOUT', '429', '502', '503', '504', 'rate limit'];
    if (transientPatterns.some(p => error.toLowerCase().includes(p.toLowerCase()))) {
      return true;
    }
    if (def.retryPolicy?.retryableErrorCodes) {
      return def.retryPolicy.retryableErrorCodes.some(c => error.includes(c));
    }
    return false;
  }

  private registerBuiltInTools(): void {
    // -------------------------------------------------------------------------
    // 1. Browser Navigate
    // -------------------------------------------------------------------------
    this.registerTool({
      definition: {
        id: 'tool_browser_navigate',
        name: 'browser_navigate',
        version: 1,
        description: 'Navigate the headless browser to a verified web page URL.',
        category: 'browser',
        source: 'native',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The absolute http or https URL to navigate to' },
            timeoutMs: { type: 'number', description: 'Maximum navigation timeout in ms' }
          },
          required: ['url']
        },
        permissionLevel: 'READ',
        sideEffectLevel: 'READ',
        permissionScopes: ['browser.read'],
        approvalPolicy: 'autonomous',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'browser',
        provider: 'aira-browser'
      },
      execute: async (args, ctx) => {
        const res = await this.browserAdapter.navigate(ctx.principal, String(args.url), args.timeoutMs);
        this.emit('browser.navigation', { runId: ctx.runId, url: res.url, status: res.status });
        return res;
      }
    });

    // -------------------------------------------------------------------------
    // 2. Browser Extract DOM
    // -------------------------------------------------------------------------
    this.registerTool({
      definition: {
        id: 'tool_browser_extract',
        name: 'browser_extract',
        version: 1,
        description: 'Extract headings, body text, form inputs, and links from the active browser page.',
        category: 'browser',
        source: 'native',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Optional CSS or text selector to extract specific element' }
          }
        },
        permissionLevel: 'READ',
        sideEffectLevel: 'READ',
        permissionScopes: ['browser.read'],
        approvalPolicy: 'autonomous',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'browser',
        provider: 'aira-browser'
      },
      execute: async (args, ctx) => {
        return this.browserAdapter.extractDom(ctx.principal, args.selector);
      }
    });

    // -------------------------------------------------------------------------
    // 3. Browser Type
    // -------------------------------------------------------------------------
    this.registerTool({
      definition: {
        id: 'tool_browser_type',
        name: 'browser_type',
        version: 1,
        description: 'Type text into a designated input element on the active browser page.',
        category: 'browser',
        source: 'native',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Target selector (name, id, or css)' },
            text: { type: 'string', description: 'Text to type into input' },
            clear: { type: 'boolean', description: 'Whether to clear existing text first' }
          },
          required: ['selector', 'text']
        },
        permissionLevel: 'WRITE',
        sideEffectLevel: 'WRITE',
        permissionScopes: ['browser.write'],
        approvalPolicy: 'require_approval',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'browser',
        provider: 'aira-browser'
      },
      execute: async (args, ctx) => {
        const res = await this.browserAdapter.type(ctx.principal, String(args.selector), String(args.text), args.clear !== false);
        this.emit('browser.action', { runId: ctx.runId, action: 'type', selector: args.selector });
        return res;
      }
    });

    // -------------------------------------------------------------------------
    // 4. Browser Click
    // -------------------------------------------------------------------------
    this.registerTool({
      definition: {
        id: 'tool_browser_click',
        name: 'browser_click',
        version: 1,
        description: 'Click a button, link, or interactive element on the active browser page.',
        category: 'browser',
        source: 'native',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Target selector to click' },
            timeoutMs: { type: 'number', description: 'Timeout in ms' }
          },
          required: ['selector']
        },
        permissionLevel: 'WRITE',
        sideEffectLevel: 'WRITE',
        permissionScopes: ['browser.write'],
        approvalPolicy: 'require_approval',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'browser',
        provider: 'aira-browser'
      },
      execute: async (args, ctx) => {
        const res = await this.browserAdapter.click(ctx.principal, String(args.selector), args.timeoutMs);
        this.emit('browser.action', { runId: ctx.runId, action: 'click', selector: args.selector });
        return res;
      }
    });

    // -------------------------------------------------------------------------
    // 5. Browser Screenshot
    // -------------------------------------------------------------------------
    this.registerTool({
      definition: {
        id: 'tool_browser_screenshot',
        name: 'browser_screenshot',
        version: 1,
        description: 'Capture a screenshot of the current page or a specified URL.',
        category: 'browser',
        source: 'native',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Optional URL to navigate to before capturing screenshot' },
            selector: { type: 'string', description: 'Optional element selector to screenshot' }
          }
        },
        permissionLevel: 'READ',
        sideEffectLevel: 'READ',
        permissionScopes: ['browser.read'],
        approvalPolicy: 'autonomous',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'browser',
        provider: 'aira-browser'
      },
      execute: async (args, ctx) => {
        if (args.url) {
          await this.browserAdapter.navigate(ctx.principal, String(args.url));
        }
        return this.browserAdapter.screenshot(ctx.principal, args.selector);
      }
    });

    // -------------------------------------------------------------------------
    // 6. File System List
    // -------------------------------------------------------------------------
    this.registerTool({
      definition: {
        id: 'tool_fs_list',
        name: 'file_system_list',
        version: 1,
        description: 'List directory entries safely within the workspace root sandbox.',
        category: 'files',
        source: 'native',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative directory path from workspace root' }
          }
        },
        permissionLevel: 'READ',
        sideEffectLevel: 'READ',
        permissionScopes: ['files.read'],
        approvalPolicy: 'autonomous',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'files',
        provider: 'aira-fs'
      },
      execute: async (args) => {
        return this.fileAdapter.list(args.path || '.');
      }
    });

    // -------------------------------------------------------------------------
    // 7. File System Read
    // -------------------------------------------------------------------------
    this.registerTool({
      definition: {
        id: 'tool_fs_read',
        name: 'file_system_read',
        version: 1,
        description: 'Read the contents of a safe local file inside workspace sandbox.',
        category: 'files',
        source: 'native',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Relative path to file from workspace root' }
          },
          required: ['filePath']
        },
        permissionLevel: 'READ',
        sideEffectLevel: 'READ',
        permissionScopes: ['files.read'],
        approvalPolicy: 'autonomous',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'files',
        provider: 'aira-fs'
      },
      execute: async (args) => {
        return this.fileAdapter.read(String(args.filePath));
      }
    });

    // -------------------------------------------------------------------------
    // 8. File System Write
    // -------------------------------------------------------------------------
    this.registerTool({
      definition: {
        id: 'tool_fs_write',
        name: 'file_system_write',
        version: 1,
        description: 'Create or overwrite a file inside the workspace sandbox.',
        category: 'files',
        source: 'native',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Relative path to file' },
            content: { type: 'string', description: 'Full file content to write' }
          },
          required: ['filePath', 'content']
        },
        permissionLevel: 'WRITE',
        sideEffectLevel: 'WRITE',
        permissionScopes: ['files.write'],
        approvalPolicy: 'require_approval',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'files',
        provider: 'aira-fs'
      },
      execute: async (args) => {
        return this.fileAdapter.write(String(args.filePath), String(args.content));
      }
    });

    // -------------------------------------------------------------------------
    // 9. File System Patch
    // -------------------------------------------------------------------------
    this.registerTool({
      definition: {
        id: 'tool_fs_patch',
        name: 'file_system_patch',
        version: 1,
        description: 'Apply a targeted search-and-replace patch to a file in workspace.',
        category: 'files',
        source: 'native',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Relative file path' },
            targetText: { type: 'string', description: 'Existing substring to replace' },
            replacementText: { type: 'string', description: 'New substring' }
          },
          required: ['filePath', 'targetText', 'replacementText']
        },
        permissionLevel: 'WRITE',
        sideEffectLevel: 'WRITE',
        permissionScopes: ['files.write'],
        approvalPolicy: 'require_approval',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'files',
        provider: 'aira-fs'
      },
      execute: async (args) => {
        return this.fileAdapter.patch(String(args.filePath), String(args.targetText), String(args.replacementText));
      }
    });

    // -------------------------------------------------------------------------
    // 10. File System Delete (DESTRUCTIVE)
    // -------------------------------------------------------------------------
    this.registerTool({
      definition: {
        id: 'tool_fs_delete',
        name: 'file_system_delete',
        version: 1,
        description: 'Delete a file or empty directory inside workspace sandbox.',
        category: 'files',
        source: 'native',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Relative path to file' }
          },
          required: ['filePath']
        },
        permissionLevel: 'DESTRUCTIVE',
        sideEffectLevel: 'DESTRUCTIVE',
        permissionScopes: ['files.write'],
        approvalPolicy: 'require_approval',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'files',
        provider: 'aira-fs'
      },
      execute: async (args) => {
        return this.fileAdapter.delete(String(args.filePath));
      }
    });

    // -------------------------------------------------------------------------
    // 11. Git Repository Status
    // -------------------------------------------------------------------------
    this.registerTool({
      definition: {
        id: 'tool_repo_status',
        name: 'repo_git_status',
        version: 1,
        description: 'Inspect the git status, current branch, and changed files of workspace.',
        category: 'repo',
        source: 'native',
        parameters: { type: 'object', properties: {} },
        permissionLevel: 'READ',
        sideEffectLevel: 'READ',
        permissionScopes: ['repo.read'],
        approvalPolicy: 'autonomous',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'repo',
        provider: 'aira-git'
      },
      execute: async () => {
        return this.repoAdapter.getStatus();
      }
    });

    // -------------------------------------------------------------------------
    // 12. Git Repository Log
    // -------------------------------------------------------------------------
    this.registerTool({
      definition: {
        id: 'tool_repo_log',
        name: 'repo_git_log',
        version: 1,
        description: 'Read recent commit history of the workspace repository.',
        category: 'repo',
        source: 'native',
        parameters: {
          type: 'object',
          properties: {
            count: { type: 'number', description: 'Number of recent commits to fetch (max 20)' }
          }
        },
        permissionLevel: 'READ',
        sideEffectLevel: 'READ',
        permissionScopes: ['repo.read'],
        approvalPolicy: 'autonomous',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'repo',
        provider: 'aira-git'
      },
      execute: async (args) => {
        return this.repoAdapter.getLog(args.count ? Number(args.count) : 5);
      }
    });

    // -------------------------------------------------------------------------
    // 13. Calculator (Safe arithmetic utility)
    // -------------------------------------------------------------------------
    this.registerTool({
      definition: {
        id: 'tool_calculator',
        name: 'calculator',
        version: 1,
        description: 'Safely evaluate an arithmetic mathematical expression.',
        category: 'utility',
        source: 'native',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'Expression e.g. (1024 * 7) / 2' }
          },
          required: ['expression']
        },
        permissionLevel: 'READ',
        sideEffectLevel: 'NONE',
        permissionScopes: [],
        approvalPolicy: 'autonomous',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'native',
        provider: 'aira-math'
      },
      execute: async (args) => {
        const expr = String(args.expression || '').replace(/[^0-9+\-*/().^ ]/g, '');
        try {
          const fn = new Function(`return (${expr})`);
          const result = fn();
          return { expression: expr, result };
        } catch {
          throw new Error(`Invalid mathematical expression: ${expr}`);
        }
      }
    });

    // -------------------------------------------------------------------------
    // 14. GitHub Connector Actions
    // -------------------------------------------------------------------------
    const ghConnector = this.connectorRegistry.get('connector_github') as GitHubConnectorAdapter;
    if (ghConnector) {
      for (const action of ghConnector.listActions()) {
        this.registerTool({
          definition: {
            id: `tool_connector_github_${action.name}`,
            name: `github_${action.name}`,
            version: 1,
            description: action.description,
            category: 'connector',
            source: 'connector',
            parameters: {
              type: 'object',
              properties: action.parameters,
              required: Object.keys(action.parameters).filter(k => k === 'owner' || k === 'repo')
            },
            permissionLevel: action.sideEffectLevel === 'WRITE' ? 'WRITE' : 'READ',
            sideEffectLevel: action.sideEffectLevel,
            permissionScopes: action.requiredScopes,
            approvalPolicy: action.sideEffectLevel === 'WRITE' ? 'require_approval' : 'autonomous',
            executionRuntime: 'CLOUD',
            availability: 'READY',
            adapter: 'connector',
            provider: 'github'
          },
          execute: async (args, ctx) => {
            return ghConnector.executeAction(action.name, args, ctx.principal);
          }
        });
      }
    }
  }

  public async shutdown(): Promise<void> {
    await this.browserAdapter.shutdown();
  }
}
