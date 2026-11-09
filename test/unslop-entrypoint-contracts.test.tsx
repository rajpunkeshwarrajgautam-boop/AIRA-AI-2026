import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerBffRoutes } from '../apps/api/src/auth/register-bff-routes.js';
import { ExecutionApprovalBanner } from '../src/components/ExecutionApprovalBanner.js';

test('extracted BFF registration preserves the exact first-party route surface', () => {
  const app = express();
  registerBffRoutes(app);
  const registered = (app.router.stack as Array<{
    route?: { path: string; methods: Record<string, boolean> };
  }>).filter(layer => layer.route).flatMap(layer => {
    const route = layer.route!;
    return Object.entries(route.methods)
      .filter(([, enabled]) => enabled)
      .map(([method]) => `${method.toUpperCase()} ${route.path}`);
  });

  assert.deepEqual(registered, [
    'POST /api/auth/sign-in',
    'POST /api/auth/sign-up',
    'POST /api/auth/oauth-exchange',
    'POST /api/auth/oauth/google/start',
    'GET /api/auth/oauth/google/start',
    'GET /api/auth/oauth/google/callback',
    'POST /api/auth/oauth/github/start',
    'GET /api/auth/oauth/github/start',
    'GET /api/auth/oauth/github/callback',
    'GET /api/auth/oauth/google/link',
    'GET /api/auth/oauth/github/link',
    'GET /api/auth/providers',
    'POST /api/auth/providers/:provider/unlink',
    'GET /api/auth/recovery/guidance',
    'POST /api/auth/recovery/request',
    'GET /api/auth/session',
    'POST /api/auth/sign-out',
  ]);
});

test('extracted approval banner retains approval labels and submission interlock', () => {
  const approval = { id: 'approval-1', runId: 'run-1', toolName: 'sandbox_python', reason: 'Explicit consent required' };
  const rendered = renderToStaticMarkup(
    React.createElement(ExecutionApprovalBanner, { approval, isSubmitting: true, onDecision: () => undefined })
  );
  assert.match(rendered, /Tool Execution Approval Required/);
  assert.match(rendered, /sandbox_python/);
  assert.match(rendered, /Explicit consent required/);
  assert.match(rendered, /Submitting\.\.\./);
  assert.match(rendered, /Deny/);
  assert.equal((rendered.match(/disabled=""/g) ?? []).length, 2);
});
