import { Router, Request, Response } from 'express';
import { visionService } from './vision/vision-service.js';
import {
  durableIdempotencyManager,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyDatabaseError
} from './utils/idempotency.js';
import {
  VisionGenerationParamsSchema,
  VisionUnderstandParamsSchema,
  VisionEditParamsSchema
} from '../../../packages/contracts/src/commercial.js';

export function createVisionRoutes(): Router {
  const router = Router();

  /**
   * Protected: Vision Understand (Visual Q&A, OCR, Diagram parsing).
   */
  router.post('/understand', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    const parsed = VisionUnderstandParamsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid understand parameters', details: parsed.error.issues });
    }

    try {
      const result = await visionService.understand(principal.userId, parsed.data);
      res.json(result);
    } catch (err: any) {
      const status = err.code === 'INSUFFICIENT_CREDITS' ? 402 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  /**
   * Protected: Vision Generate (1 or 2 images, aspect ratios, economy/premium).
   * Enforces principal-scoped durable server-side idempotency against double-billing.
   */
  router.post('/generate', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    const clientOpId = (req.headers['x-client-operation-id'] as string) || req.body?.clientOperationId;

    const parsed = VisionGenerationParamsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid generation parameters', details: parsed.error.issues });
    }

    try {
      if (clientOpId) {
        const check = await durableIdempotencyManager.beginOrGet(
          principal.userId,
          clientOpId,
          'VISION_GENERATE',
          parsed.data
        );
        if (check.isReplay) {
          return res.status(check.statusCode).json(check.responseBody);
        }
      }

      const result = await visionService.generate(principal.userId, parsed.data);

      if (clientOpId) {
        await durableIdempotencyManager.complete(principal.userId, clientOpId, 200, result);
      }

      res.json(result);
    } catch (err: any) {
      if (clientOpId) {
        if (!(err instanceof IdempotencyConflictError || err instanceof IdempotencyInProgressError)) {
          await durableIdempotencyManager.fail(principal.userId, clientOpId).catch(() => {});
        }
      }
      const status = err.statusCode || (err.code === 'INSUFFICIENT_CREDITS' ? 402 : (err instanceof IdempotencyConflictError || err instanceof IdempotencyInProgressError ? 409 : (err instanceof IdempotencyDatabaseError ? 503 : 500)));
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  /**
   * Protected: Vision Edit (Inpainting, modifications).
   */
  router.post('/edit', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    const parsed = VisionEditParamsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid edit parameters', details: parsed.error.issues });
    }

    try {
      const result = await visionService.edit(principal.userId, parsed.data);
      res.json(result);
    } catch (err: any) {
      const status = err.code === 'INSUFFICIENT_CREDITS' ? 402 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  return router;
}
