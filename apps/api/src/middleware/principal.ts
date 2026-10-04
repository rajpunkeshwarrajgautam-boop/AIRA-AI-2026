import { Request, Response, NextFunction } from 'express';
import { PrincipalProvider, DevPrincipalProvider } from '../auth/principal-provider.js';
import { ExecutionPrincipal } from '../../../../packages/contracts/src/index.js';

declare global {
  namespace Express {
    interface Request {
      principal?: ExecutionPrincipal;
    }
  }
}

const defaultPrincipalProvider: PrincipalProvider = new DevPrincipalProvider();

export function createPrincipalMiddleware(provider: PrincipalProvider = defaultPrincipalProvider) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const principal = await provider.resolve(req);
      req.principal = principal;
      next();
    } catch (error: any) {
      res.status(401).json({
        error: 'Unauthorized',
        message: error.message || 'Failed to resolve execution principal',
      });
    }
  };
}
