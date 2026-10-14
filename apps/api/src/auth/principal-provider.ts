import { Request } from 'express';
import { ExecutionPrincipal, ExecutionPrincipalSchema } from '../../../../packages/contracts/src/index.js';

export interface PrincipalProvider {
  resolve(req: Request): Promise<ExecutionPrincipal>;
}

export class DevPrincipalProvider implements PrincipalProvider {
  async resolve(req: Request): Promise<ExecutionPrincipal> {
    // Verified managed identity takes absolute precedence — cryptographic proof cannot be overridden by headers.
    const managedIdentity = (req as any).managedIdentity;
    if (managedIdentity && managedIdentity.userId) {
      return ExecutionPrincipalSchema.parse({
        userId: managedIdentity.userId,
        sessionId: managedIdentity.sessionId,
        workspaceId: undefined,
        projectId: undefined,
        roles: ['workspace_user'],
        scopes: ['chat:write', 'runs:read', 'runs:write', 'browser.read', 'files.read'],
      });
    }

    // Never trust caller-supplied principal headers on a deployed Vercel environment.
    const isDevOrTest = !process.env.VERCEL_ENV && (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development');

    if (isDevOrTest && !req.headers.authorization) {
      const testUserId = req.headers['x-test-user-id'] as string;
      const testSessionId = req.headers['x-test-session-id'] as string;
      const testWorkspaceId = req.headers['x-workspace-id'] as string;
      const testProjectId = req.headers['x-project-id'] as string;

      if (testUserId && testSessionId) {
        return ExecutionPrincipalSchema.parse({
          userId: testUserId,
          sessionId: testSessionId,
          workspaceId: testWorkspaceId || undefined,
          projectId: testProjectId || undefined,
          roles: ['dev_user'],
          scopes: ['*'],
        });
      }
    }

    // Default authenticated principal resolution
    const user = (req as any).user;
    if (!user || !user.id) {
      throw new Error("Unauthorized: No valid principal found on request context");
    }

    if (!user.sessionId) {
      throw new Error("Unauthorized: No valid session identity found on request context");
    }

    return ExecutionPrincipalSchema.parse({
      userId: user.id,
      sessionId: user.sessionId,
      workspaceId: user.workspaceId,
      projectId: user.projectId,
      roles: user.roles || [],
      scopes: user.scopes || [],
    });
  }
}
