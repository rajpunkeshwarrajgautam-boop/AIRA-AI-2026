import type { Express, Request, Response } from 'express';
import {
  handleBffSignUp,
  handleBffSignIn,
  handleBffOAuthExchange,
  handleBffOAuthGoogleStart,
  handleBffOAuthGoogleCallback,
  handleBffOAuthGithubStart,
  handleBffOAuthGithubCallback,
  handleBffOAuthLinkStart,
  handleBffGetProviders,
  handleBffUnlinkProvider,
  handleBffRecoveryRequest,
  handleBffRecoveryGuidance,
  handleBffSession,
  handleBffSignOut
} from './bff-session.js';

/**
 * Register the first-party BFF routes after authentication and CSRF middleware.
 * This preserves the established HTTP methods, paths and failure status codes.
 * Route order matters: the caller mounts all security middleware first.
 */
export function registerBffRoutes(app: Express): void {
  app.post('/api/auth/sign-in', (req: Request, res: Response) => {
    handleBffSignIn(req, res).catch((err) => {
      res.status(500).json({ error: err.message || 'BFF sign in failed' });
    });
  });
  app.post('/api/auth/sign-up', (req: Request, res: Response) => {
    handleBffSignUp(req, res).catch((err) => {
      res.status(500).json({ error: err.message || 'BFF sign up failed' });
    });
  });
  app.post('/api/auth/oauth-exchange', (req: Request, res: Response) => {
    handleBffOAuthExchange(req, res).catch((err) => {
      res.status(500).json({ error: err.message || 'BFF OAuth exchange failed' });
    });
  });
  app.post('/api/auth/oauth/google/start', (req: Request, res: Response) => {
    handleBffOAuthGoogleStart(req, res).catch((err) => {
      res.status(500).json({ error: err.message || 'OAuth start failed' });
    });
  });
  app.get('/api/auth/oauth/google/start', (req: Request, res: Response) => {
    handleBffOAuthGoogleStart(req, res).catch((err) => {
      res.status(500).json({ error: err.message || 'OAuth start failed' });
    });
  });
  app.get('/api/auth/oauth/google/callback', (req: Request, res: Response) => {
    handleBffOAuthGoogleCallback(req, res).catch((err) => {
      res.status(500).json({ error: err.message || 'OAuth callback failed' });
    });
  });
  app.post('/api/auth/oauth/github/start', (req: Request, res: Response) => {
    handleBffOAuthGithubStart(req, res).catch(() => {
      res.status(502).json({ error: 'GitHub OAuth start failed' });
    });
  });
  app.get('/api/auth/oauth/github/start', (req: Request, res: Response) => {
    handleBffOAuthGithubStart(req, res).catch(() => {
      res.status(502).json({ error: 'GitHub OAuth start failed' });
    });
  });
  app.get('/api/auth/oauth/github/callback', (req: Request, res: Response) => {
    handleBffOAuthGithubCallback(req, res).catch(() => {
      res.status(502).json({ error: 'GitHub OAuth callback failed' });
    });
  });
  app.get('/api/auth/oauth/google/link', (req: Request, res: Response) => {
    handleBffOAuthLinkStart(req, res, 'google').catch((err) => {
      res.status(500).json({ error: err.message || 'OAuth linking start failed' });
    });
  });
  app.get('/api/auth/oauth/github/link', (req: Request, res: Response) => {
    handleBffOAuthLinkStart(req, res, 'github').catch((err) => {
      res.status(500).json({ error: err.message || 'OAuth linking start failed' });
    });
  });
  app.get('/api/auth/providers', (req: Request, res: Response) => {
    handleBffGetProviders(req, res).catch((err) => {
      res.status(500).json({ error: err.message || 'Failed to get providers' });
    });
  });
  app.post('/api/auth/providers/:provider/unlink', (req: Request, res: Response) => {
    handleBffUnlinkProvider(req, res).catch((err) => {
      res.status(500).json({ error: err.message || 'Failed to unlink provider' });
    });
  });
  app.get('/api/auth/recovery/guidance', (req: Request, res: Response) => {
    handleBffRecoveryGuidance(req, res).catch((err) => {
      res.status(500).json({ error: err.message || 'Failed to get recovery guidance' });
    });
  });
  app.post('/api/auth/recovery/request', (req: Request, res: Response) => {
    handleBffRecoveryRequest(req, res).catch((err) => {
      res.status(500).json({ error: err.message || 'Failed to submit recovery request' });
    });
  });
  app.get('/api/auth/session', handleBffSession);
  app.post('/api/auth/sign-out', (req: Request, res: Response) => {
    handleBffSignOut(req, res).catch((err) => {
      res.status(500).json({ error: err.message || 'BFF sign out failed' });
    });
  });
}
