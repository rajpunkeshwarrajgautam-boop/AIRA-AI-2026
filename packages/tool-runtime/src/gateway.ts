import { EventEmitter } from 'events';
import { isDeepStrictEqual } from 'node:util';
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
import { IsolatedBuildBridge } from './adapters/isolated-build-bridge.js';
import { BrowserWorkerClient } from '../../agent-runtime/src/browser-worker-transport.js';
import { db } from '../../db/src/index.js';
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

    // STEP 7: Check Idempotency Cache for mutative actions
    if (context.idempotencyKey) {
      const cached = await this.repository.getToolCallByIdempotencyKey(context.idempotencyKey);
      if (cached && cached.lifecycleState === 'COMPLETED') {
        if (cached.principalId !== principal.userId ||
            cached.toolName !== def.name || !isDeepStrictEqual(cached.arguments, args)) {
          return {
            toolCallId: callId, output: null, isError: true,
            error: 'TOOL_IDEMPOTENCY_COLLISION: Cached result belongs to another principal, run or payload.',
            errorCode: ToolGatewayErrorCodes.TOOL_PERMISSION_DENIED,
            durationMs: Date.now() - startTime, timestamp: Date.now(), artifacts: []
          };
        }
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

    // STEP 8: Evaluate Approval Kernel
    const requiresApproval = (def.approvalPolicy === 'require_approval' || def.approvalPolicy === 'always_ask') ||
      sideEffectLevel === 'DESTRUCTIVE' ||
      sideEffectLevel === 'WRITE';

    if (requiresApproval && !this.approvalKernel) {
      return {
        toolCallId: callId, output: null, isError: true,
        error: 'TOOL_APPROVAL_KERNEL_REQUIRED: Mutating tools cannot execute without the approval service.',
        errorCode: ToolGatewayErrorCodes.TOOL_PERMISSION_DENIED,
        durationMs: Date.now() - startTime, timestamp: Date.now(), artifacts: []
      };
    }
    if (requiresApproval && this.approvalKernel) {
      const isApproved = def.name === 'isolated_application_build'
        ? await this.approvalKernel.isExactToolCallApproved(runId, {
            id: callId, toolId: def.id, name: def.name, arguments: args, timestamp: startTime
          }, principal.userId)
        : await this.approvalKernel.isToolCallApproved(
            runId, def.name, def.permissionLevel, principal.userId
          );

      if (!isApproved) {
        // Suspend execution and create ApprovalRequest
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
          def.permissionLevel,
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
          // An awaiting approval is never a successful tool execution.
          // Especially for isolated builds, this stops workflows from
          // mistaking a pending user decision for a completed build.
          isError: def.name === 'isolated_application_build',
          ...(def.name === 'isolated_application_build' ? {
            error: 'ISOLATED_BUILD_APPROVAL_REQUIRED',
            errorCode: ToolGatewayErrorCodes.TOOL_PERMISSION_DENIED
          } : {}),
          durationMs: Date.now() - startTime,
          timestamp: Date.now(),
          artifacts: []
        };
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
    // Feature is off until a dedicated browser worker and verified identity
    // are certified. This does not expose clicks, navigation or browser writes.
    if (process.env.AIRA_DURABLE_BROWSER_ENABLED === 'true' &&
        process.env.NODE_ENV !== 'production') {
      const client = new BrowserWorkerClient();
      this.registerTool({
        definition: {
          id: 'tool_browser_session_inspect',
          name: 'browser_session_inspect',
          version: 1,
          description: 'Read the actual currently open page of an explicitly named, owner-bound persistent browser session. Does not navigate or mutate.',
          category: 'browser',
          source: 'native',
          parameters: {
            type: 'object', properties: {
              sessionId: { type: 'string', description: 'Explicit bs_UUID session identifier already created for the authenticated user' }
            }, required: ['sessionId']
          },
          permissionLevel: 'READ',
          sideEffectLevel: 'READ',
          permissionScopes: ['browser.read'],
          approvalPolicy: 'autonomous',
          idempotencyClass: 'IDEMPOTENT',
          retryPolicy: { maxAttempts: 1, backoffMs: 500, factor: 1, retryableErrorCodes: [] },
          executionRuntime: 'CLOUD',
          timeoutMs: 26000,
          availability: 'READY',
          adapter: 'native',
          provider: 'aira-durable-browser-worker'
        },
        execute: async (args, ctx) => {
          const sessionId = args.sessionId;
          if (typeof sessionId !== 'string' ||
              !/^bs_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId) ||
              Object.keys(args).length !== 1) {
            throw new Error('BROWSER_SESSION_ID_INVALID');
          }
          const run = await db('runs').select('principal_id').where({ id:ctx.runId }).first();
          if (!run || run.principal_id !== ctx.principal.userId)
            throw new Error('BROWSER_RUN_OWNER_MISMATCH');
          const row = await db('v2_browser_sessions')
            .select('state').where({id:sessionId,owner_id:ctx.principal.userId}).first();
          if (!row || row.state === 'CLOSED')
            throw new Error('BROWSER_SESSION_NOT_AVAILABLE');
          const observed = await client.observe(ctx.principal.userId,sessionId,'inspect') as any;
          if (observed?.operation !== 'inspect' ||
              observed?.sessionId !== sessionId ||
              observed?.workerVerified !== true ||
              typeof observed.url !== 'string' ||
              typeof observed.title !== 'string' ||
              typeof observed.heading !== 'string' ||
              typeof observed.text !== 'string') {
            throw new Error('BROWSER_WORKER_OBSERVATION_INVALID');
          }
          return observed;
        }
      });
    }

    // The existing isolated Docker worker (PR #42–45) is a separate service.
    // Never expose this privileged tool unless an operator enabled the bridge
    // AND a real approval kernel is present. The gateway further requires an
    // exact call-ID/arguments/principal approval before any remote submission.
    if (process.env.AIRA_ISOLATED_BUILD_ENABLED === 'true' && this.approvalKernel) {
      const bridge = new IsolatedBuildBridge();
      this.registerTool({
        definition: {
          id: 'tool_isolated_application_build',
          name: 'isolated_application_build',
          version: 1,
          description: 'Send explicitly authorized source files to a separate isolated Docker build worker and verify source archive and build/test results.',
          category: 'system',
          source: 'native',
          parameters: {
            type: 'object',
            properties: {
              files: { type: 'array', description: 'Verified project files [{path, content}]' },
              steps: { type: 'array', description: 'Exactly [syntax, build, test]' }
            },
            required: ['files','steps']
          },
          permissionLevel: 'WRITE',
          sideEffectLevel: 'WRITE',
          permissionScopes: ['builder.execute'],
          approvalPolicy: 'require_approval',
          idempotencyClass: 'NON_IDEMPOTENT',
          retryPolicy: { maxAttempts: 1, backoffMs: 500, factor: 1, retryableErrorCodes: [] },
          executionRuntime: 'CLOUD',
          timeoutMs: 55000,
          availability: 'READY',
          adapter: 'native',
          provider: 'aira-isolated-builder'
        },
        execute: async (args, ctx) => {
          // Verify the run owner against the authoritative PostgreSQL record.
          // The principal attached to a ToolGateway invocation is not itself
          // proof that an arbitrary runId belongs to that account.
          const ownedRun = await db('runs').select('principal_id').where({ id: ctx.runId }).first();
          if (!ownedRun || ownedRun.principal_id !== ctx.principal.userId) {
            throw new Error('ISOLATED_BUILD_RUN_OWNER_MISMATCH');
          }
          return bridge.execute(ctx.principal.userId, ctx.runId, args);
        }
      });
    }
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
