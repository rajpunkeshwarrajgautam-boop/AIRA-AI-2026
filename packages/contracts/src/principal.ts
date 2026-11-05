import { z } from 'zod';

export const ExecutionPrincipalSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  sessionId: z.string().min(1, "sessionId is required"),
  workspaceId: z.string().optional(),
  projectId: z.string().optional(),
  roles: z.array(z.string()).optional(),
  scopes: z.array(z.string()).optional()
});
export type ExecutionPrincipal = z.infer<typeof ExecutionPrincipalSchema>;
