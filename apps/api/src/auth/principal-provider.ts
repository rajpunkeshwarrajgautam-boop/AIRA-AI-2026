import { Request } from 'express';
import { ExecutionPrincipal, ExecutionPrincipalSchema, isGuestPrincipal } from '../../../../packages/contracts/src/index.js';
import {
  WorkspaceAuthorityRepository,
  workspaceAuthority
} from '../../../../packages/agent-runtime/src/workspace-authority.js';

export interface PrincipalProvider {
  resolve(req: Request): Promise<ExecutionPrincipal>;
}

export class DevPrincipalProvider implements PrincipalProvider {
  constructor(private readonly workspaceAuthorities: WorkspaceAuthorityRepository = workspaceAuthority) {}

  async resolve(req: Request): Promise<ExecutionPrincipal> {
    // Verified managed identity takes absolute precedence — cryptographic proof cannot be overridden by headers.
    const managedIdentity = (req as any).managedIdentity;
    if (managedIdentity && managedIdentity.userId) {
      const workspaceId = await this.workspaceAuthorities.resolveWorkspace(managedIdentity.userId);
      return ExecutionPrincipalSchema.parse({
        userId: managedIdentity.userId,
        sessionId: managedIdentity.sessionId,
        workspaceId,
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

      if (testUserId && testSessionId) {
        const workspaceId = await this.workspaceAuthorities.resolveWorkspace(testUserId);
        return ExecutionPrincipalSchema.parse({
          userId: testUserId,
          sessionId: testSessionId,
          workspaceId,
          projectId: undefined,
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

    const workspaceId = await this.workspaceAuthorities.resolveWorkspace(user.id);
    const isGuest = isGuestPrincipal(user.id) || user.isGuest === true;
    const principal = ExecutionPrincipalSchema.parse({
      userId: user.id,
      sessionId: user.sessionId,
      workspaceId,
      // No persisted project membership relation exists, so user/client project values are non-authoritative.
      projectId: undefined,
      roles: isGuest ? ['guest_user'] : (user.roles || ['workspace_user']),
      scopes: isGuest ? ['chat:write'] : (user.scopes || ['chat:write', 'runs:read', 'runs:write', 'browser.read', 'files.read']),
    });
    if (isGuest) {
      (principal as any).tier = 'guest';
    } else if (user.tier) {
      (principal as any).tier = user.tier;
    }
    return principal;
  }
}
