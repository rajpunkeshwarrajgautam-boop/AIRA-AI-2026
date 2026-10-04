import { Request } from 'express';
import { ExecutionPrincipal, ExecutionPrincipalSchema } from '../../../../packages/contracts/src/index.js';

export interface PrincipalProvider {
  resolve(req: Request): Promise<ExecutionPrincipal>;
}

export class DevPrincipalProvider implements PrincipalProvider {
  async resolve(req: Request): Promise<ExecutionPrincipal> {
    const isDevOrTest = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';

    if (isDevOrTest) {
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

    return ExecutionPrincipalSchema.parse({
      userId: user.id,
      sessionId: user.sessionId || req.headers['x-session-id'] || 'default-session',
      workspaceId: user.workspaceId || req.headers['x-workspace-id'],
      projectId: user.projectId || req.headers['x-project-id'],
      roles: user.roles || [],
      scopes: user.scopes || [],
    });
  }
}
