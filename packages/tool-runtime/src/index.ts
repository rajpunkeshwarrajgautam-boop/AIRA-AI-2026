import * as fs from 'fs';
import * as path from 'path';
import {
  ToolDefinition,
  ToolCall,
  ToolResult,
  PermissionLevel
} from '../../contracts/src/index.js';

export interface ExecutableTool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;
}

export interface ToolExecutionContext {
  runId: string;
  workspaceRoot: string;
  sessionGrantedTools: Set<string>;
}

export class ToolRegistry {
  private tools: Map<string, ExecutableTool> = new Map();
  private auditLog: Array<{
    timestamp: number;
    runId: string;
    toolName: string;
    permission: PermissionLevel;
    durationMs: number;
    success: boolean;
    error?: string;
  }> = [];

  constructor(workspaceRoot = process.cwd()) {
    this.registerBuiltIns(workspaceRoot);
  }

  public register(tool: ExecutableTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  public get(name: string): ExecutableTool | undefined {
    return this.tools.get(name);
  }

  public listDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  public getAuditLog() {
    return [...this.auditLog];
  }

  public async execute(
    call: ToolCall,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    const startTime = Date.now();

    if (!tool) {
      const errRes: ToolResult = {
        toolCallId: call.id,
        output: null,
        error: `Tool "${call.name}" is not registered in the runtime.`,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: Date.now()
      };
      this.recordAudit(context.runId, call.name, 'READ', startTime, false, errRes.error);
      return errRes;
    }

    try {
      const result = await tool.execute(call.arguments, context);
      this.recordAudit(
        context.runId,
        call.name,
        tool.definition.permissionLevel,
        startTime,
        !result.isError,
        result.error
      );
      return result;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.recordAudit(
        context.runId,
        call.name,
        tool.definition.permissionLevel,
        startTime,
        false,
        errorMsg
      );
      return {
        toolCallId: call.id,
        output: null,
        error: errorMsg,
        isError: true,
        durationMs,
        timestamp: Date.now()
      };
    }
  }

  private recordAudit(
    runId: string,
    toolName: string,
    permission: PermissionLevel,
    startTime: number,
    success: boolean,
    error?: string
  ): void {
    this.auditLog.push({
      timestamp: Date.now(),
      runId,
      toolName,
      permission,
      durationMs: Date.now() - startTime,
      success,
      error
    });
  }

  private registerBuiltIns(_workspaceRoot: string): void {
    // 1. Web Search Tool
    this.register({
      definition: {
        id: 'tool_web_search',
        name: 'web_search',
        description: 'Search the public web for verified facts and technical documentation via Brave Search API.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query or keyword phrase' }
          },
          required: ['query']
        },
        source: 'native',
        permissionLevel: 'READ',
        executionRuntime: 'CLOUD'
      },
      execute: async (args, _ctx) => {
        const start = Date.now();
        const query = String(args.query || '');

        const braveKey = process.env.BRAVE_SEARCH_API_KEY;
        if (!braveKey) {
          return {
            toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
            output: null,
            error: 'PROVIDER_NOT_CONFIGURED: web_search requires BRAVE_SEARCH_API_KEY environment variable. ' +
                   'Set this key to enable real web search. This tool does not return simulated results.',
            isError: true,
            durationMs: Date.now() - start,
            timestamp: Date.now()
          };
        }

        // Real Brave Search API call
        const response = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
          {
            headers: {
              'Accept': 'application/json',
              'Accept-Encoding': 'gzip',
              'X-Subscription-Token': braveKey
            }
          }
        );

        if (!response.ok) {
          const errText = await response.text();
          return {
            toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
            output: null,
            error: `Brave Search API error (${response.status}): ${errText}`,
            isError: true,
            durationMs: Date.now() - start,
            timestamp: Date.now()
          };
        }

        const data = await response.json() as any;
        const results = (data.web?.results || []).map((r: any) => ({
          title: r.title,
          url: r.url,
          snippet: r.description || ''
        }));

        return {
          toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
          output: {
            query,
            totalResults: results.length,
            results
          },
          isError: false,
          durationMs: Date.now() - start,
          timestamp: Date.now()
        };
      }
    });


    // 2. Safe File System Read Tool
    this.register({
      definition: {
        id: 'tool_fs_read',
        name: 'file_system_read',
        description: 'Read the contents of a safe local file inside the workspace root sandbox.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Relative path to file from workspace root' }
          },
          required: ['filePath']
        },
        source: 'native',
        permissionLevel: 'READ',
        executionRuntime: 'LOCAL'
      },
      execute: async (args, ctx) => {
        const start = Date.now();
        const rawPath = String(args.filePath || '');
        const safePath = path.resolve(ctx.workspaceRoot, rawPath);

        if (!safePath.startsWith(path.resolve(ctx.workspaceRoot))) {
          return {
            toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
            output: null,
            error: 'Access denied: Path is outside workspace root sandbox.',
            isError: true,
            durationMs: Date.now() - start,
            timestamp: Date.now()
          };
        }

        if (!fs.existsSync(safePath)) {
          return {
            toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
            output: null,
            error: `File not found: ${rawPath}`,
            isError: true,
            durationMs: Date.now() - start,
            timestamp: Date.now()
          };
        }

        const stats = fs.statSync(safePath);
        if (stats.isDirectory()) {
          const files = fs.readdirSync(safePath);
          return {
            toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
            output: { isDirectory: true, files },
            isError: false,
            durationMs: Date.now() - start,
            timestamp: Date.now()
          };
        }

        const content = fs.readFileSync(safePath, 'utf8');
        return {
          toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
          output: {
            filePath: rawPath,
            sizeBytes: stats.size,
            content: content.slice(0, 32000)
          },
          isError: false,
          durationMs: Date.now() - start,
          timestamp: Date.now()
        };
      }
    });

    // 3. Calculator Tool
    this.register({
      definition: {
        id: 'tool_calculator',
        name: 'calculator',
        description: 'Evaluate an arithmetic mathematical expression safely.',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'Arithmetic expression e.g. (1024 * 7) / 2' }
          },
          required: ['expression']
        },
        source: 'native',
        permissionLevel: 'READ',
        executionRuntime: 'LOCAL'
      },
      execute: async (args, _ctx) => {
        const start = Date.now();
        const expr = String(args.expression || '').replace(/[^0-9+\-*/().^ ]/g, '');
        try {
          const fn = new Function(`return (${expr})`);
          const result = fn();
          return {
            toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
            output: { expression: expr, result },
            isError: false,
            durationMs: Date.now() - start,
            timestamp: Date.now()
          };
        } catch {
          return {
            toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
            output: null,
            error: `Invalid mathematical expression: ${expr}`,
            isError: true,
            durationMs: Date.now() - start,
            timestamp: Date.now()
          };
        }
      }
    });

    // 4. System Shell Tool (DESTRUCTIVE — approval enforced upstream by AgentRuntime)
    this.register({
      definition: {
        id: 'tool_system_shell',
        name: 'system_shell',
        description: 'Execute a vetted shell command in the workspace sandbox. Requires explicit user approval. Blocked in production deployments.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute (runs in workspace root directory)' },
            timeoutMs: { type: 'number', description: 'Max execution time in ms (max 30000, default 15000)' }
          },
          required: ['command']
        },
        source: 'native',
        permissionLevel: 'DESTRUCTIVE',
        executionRuntime: 'LOCAL',
        riskClass: 'CRITICAL'
      },
      execute: async (args, ctx) => {
        const start = Date.now();
        const command = String(args.command || '').trim();

        // Block in production cloud deployments
        if (process.env.NODE_ENV === 'production' && process.env.AIRA_ALLOW_SHELL !== 'true') {
          return {
            toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
            output: null,
            error: 'PRODUCTION_DISABLED: system_shell is disabled in production deployments. ' +
                   'Set AIRA_ALLOW_SHELL=true only in approved local-runner environments.',
            isError: true,
            durationMs: Date.now() - start,
            timestamp: Date.now()
          };
        }

        if (!command) {
          return {
            toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
            output: null,
            error: 'Empty command rejected.',
            isError: true,
            durationMs: Date.now() - start,
            timestamp: Date.now()
          };
        }

        // Prevent obvious path-traversal in command itself
        const dangerous = ['../', '..\\', '/etc/', '/proc/', 'C:\\Windows\\System32\\cmd.exe /c del'];
        if (dangerous.some(d => command.toLowerCase().includes(d.toLowerCase()))) {
          return {
            toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
            output: null,
            error: 'SECURITY_REJECTED: Command contains potentially unsafe path traversal patterns.',
            isError: true,
            durationMs: Date.now() - start,
            timestamp: Date.now()
          };
        }

        const workspaceRoot = path.resolve(ctx.workspaceRoot);
        const timeoutMs = Math.min(Number(args.timeoutMs) || 15000, 30000);
        const OUTPUT_LIMIT = 65536; // 64 KB

        return new Promise((resolve) => {
          const { execFile } = require('child_process') as typeof import('child_process');
          const isWin = process.platform === 'win32';
          const shell = isWin ? 'powershell.exe' : 'sh';
          const shellArgs = isWin ? ['-Command', command] : ['-c', command];

          let timedOut = false;
          const proc = execFile(
            shell,
            shellArgs,
            {
              cwd: workspaceRoot,
              timeout: timeoutMs,
              maxBuffer: OUTPUT_LIMIT,
              env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                // Sanitize: do NOT forward API keys or secrets
              }
            },
            (err, stdout, stderr) => {
              const durationMs = Date.now() - start;
              if (timedOut) {
                resolve({
                  toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
                  output: null,
                  error: `TIMEOUT: Command exceeded ${timeoutMs}ms limit.`,
                  isError: true,
                  durationMs,
                  timestamp: Date.now()
                });
                return;
              }
              if (err && !stdout) {
                resolve({
                  toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
                  output: null,
                  error: `Shell error (exit ${(err as any).code ?? 1}): ${stderr || err.message}`,
                  isError: true,
                  durationMs,
                  timestamp: Date.now()
                });
                return;
              }
              resolve({
                toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
                output: {
                  command,
                  exitCode: (err as any)?.code ?? 0,
                  stdout: stdout.slice(0, OUTPUT_LIMIT),
                  stderr: stderr.slice(0, 4096),
                  workingDirectory: workspaceRoot,
                  truncated: stdout.length > OUTPUT_LIMIT
                },
                isError: false,
                durationMs,
                timestamp: Date.now()
              });
            }
          );

          proc.on('error', (err) => {
            resolve({
              toolCallId: 'call_' + Math.random().toString(36).slice(2, 9),
              output: null,
              error: `Process spawn error: ${err.message}`,
              isError: true,
              durationMs: Date.now() - start,
              timestamp: Date.now()
            });
          });

          setTimeout(() => {
            timedOut = true;
            try { proc.kill(); } catch { /* ignore */ }
          }, timeoutMs + 100);
        });
      }
    });
  }
}

