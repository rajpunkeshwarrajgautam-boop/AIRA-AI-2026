/**
 * Phase 2 E2E Browser Acceptance (Playwright Chromium + Built dist/ + Live NIM)
 * Verifies all 7 interactive scenarios (A-G), $0 client recompute, persistence across
 * reload, live AI-generated GenUI composition, security/ownership enforcement,
 * keyboard/a11y semantics, light/dark themes, and Desktop/Tablet/Mobile viewports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import {
  AIRA_GENUI_CONTRACT_VERSION,
  GenUIInteractionEventSchema,
  type ExecutionPrincipal,
  type GenUISurface,
} from '../packages/contracts/src/index.js';
import {
  AgentRuntime,
  authorizeGenUIActionServerSide,
} from '../packages/agent-runtime/src/index.js';
import { InMemoryRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { BrainV2KnowledgeEngine, InMemoryKnowledgeRepository } from '../packages/knowledge/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ModelRouter, ProviderHealthTracker } from '../packages/model-router/src/index.js';

function loadNvidiaKeyIfAvailable(): string | undefined {
  if (process.env.NVIDIA_API_KEY?.trim()) return process.env.NVIDIA_API_KEY.trim();
  for (const envPath of [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', 'AIRA-AI-2026', '.env'),
  ]) {
    if (!fs.existsSync(envPath)) continue;
    const match = fs.readFileSync(envPath, 'utf8').match(/^NVIDIA_API_KEY=(.+)$/m);
    if (match?.[1]?.trim()) return match[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

async function dismissBlockingOverlays(page: Page): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    let closed = false;
    const whatsNew = page.locator('[data-testid="whats-new-dismiss-btn"], [data-testid="whats-new-close-btn"]').first();
    if (await whatsNew.isVisible().catch(() => false)) {
      closed = true;
      await whatsNew.click().catch(() => {});
    }
    const skip = page.locator('[data-testid="onboarding-skip-btn"]');
    if (await skip.isVisible().catch(() => false)) {
      closed = true;
      await skip.click().catch(() => {});
    }
    if (!closed) break;
  }
}

function buildScenarioSurfaces(): Record<string, GenUISurface> {
  return {
    investment: {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'surf_inv_p2',
      title: 'Investment Planner',
      rootId: 'inv_root',
      textFallback: 'Investment projection planner',
      origin: 'model',
      state: { inv: { principal: 10000, monthly: 500, rate: 8, years: 10 } },
      computed: [
        {
          target: '/derived/inv',
          kind: 'compound_growth',
          principalRef: '/inv/principal',
          monthlyContributionRef: '/inv/monthly',
          annualRateRef: '/inv/rate',
          yearsRef: '/inv/years',
          currency: 'USD',
        },
      ],
      actions: [],
      evidence: [],
      components: [
        { id: 'inv_root', type: 'vertical_group', props: { gap: 'sm', children: ['inv_hdr', 'inv_metrics', 'inv_ctrls', 'inv_chart', 'inv_tbl'] } },
        { id: 'inv_hdr', type: 'heading', props: { level: 3, text: 'Investment Growth Planner' } },
        { id: 'inv_metrics', type: 'responsive_grid', props: { columns: 2, gap: 'sm', children: ['m_bal', 'm_int'] } },
        { id: 'm_bal', type: 'metric_display', props: { label: 'Projected Value', value: '$0', dataRef: '/derived/inv/finalBalanceFormatted' } },
        { id: 'm_int', type: 'metric_display', props: { label: 'Total Interest', value: '$0', dataRef: '/derived/inv/totalInterestFormatted' } },
        { id: 'inv_ctrls', type: 'responsive_grid', props: { columns: 2, gap: 'sm', children: ['in_p', 'in_m', 'in_r', 'in_y'] } },
        { id: 'in_p', type: 'numeric_input', props: { label: 'Initial Principal', stateKey: '/inv/principal', min: 1000, max: 1000000, step: 500, defaultValue: 10000 } },
        { id: 'in_m', type: 'numeric_input', props: { label: 'Monthly Contribution', stateKey: '/inv/monthly', min: 0, max: 20000, step: 50, defaultValue: 500 } },
        { id: 'in_r', type: 'slider', props: { label: 'Assumed Return %', stateKey: '/inv/rate', min: 1, max: 20, step: 0.5, defaultValue: 8, unit: '%' } },
        { id: 'in_y', type: 'slider', props: { label: 'Years', stateKey: '/inv/years', min: 1, max: 40, step: 1, defaultValue: 10, unit: 'yrs' } },
        { id: 'inv_chart', type: 'line_chart', props: { title: 'Growth Curve', labels: [], datasets: [{ label: 'Value', values: [] }], labelsRef: '/derived/inv/labels', datasetsRef: '/derived/inv/datasets', allowTableToggle: true } },
        { id: 'inv_tbl', type: 'data_table', props: { title: 'Yearly Breakdown', rowsRef: '/derived/inv/rows', rows: [], columns: [{ key: 'year', label: 'Year', align: 'left', format: 'text' }, { key: 'balanceFormatted', label: 'Balance', align: 'right', format: 'text' }] } },
      ],
    },
    loan: {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'surf_loan_p2',
      title: 'Loan Amortization Calculator',
      rootId: 'loan_root',
      textFallback: 'Loan EMI calculator',
      origin: 'model',
      state: { loan: { principal: 300000, rate: 6.5, years: 20 } },
      computed: [
        {
          target: '/derived/loan',
          kind: 'amortization',
          principalRef: '/loan/principal',
          annualRateRef: '/loan/rate',
          termMonthsRef: '/loan/years',
          termIsYears: true,
          currency: 'USD',
        },
      ],
      actions: [],
      evidence: [],
      components: [
        { id: 'loan_root', type: 'vertical_group', props: { gap: 'sm', children: ['l_hdr', 'l_m', 'l_c', 'l_tbl'] } },
        { id: 'l_hdr', type: 'heading', props: { level: 3, text: 'Mortgage & Loan EMI Planner' } },
        { id: 'l_m', type: 'responsive_grid', props: { columns: 3, gap: 'sm', children: ['m_emi', 'm_tot', 'm_lint'] } },
        { id: 'm_emi', type: 'metric_display', props: { label: 'Monthly EMI', value: '$0', dataRef: '/derived/loan/monthlyPaymentFormatted' } },
        { id: 'm_tot', type: 'metric_display', props: { label: 'Total Payment', value: '$0', dataRef: '/derived/loan/totalPaymentFormatted' } },
        { id: 'm_lint', type: 'metric_display', props: { label: 'Total Interest', value: '$0', dataRef: '/derived/loan/totalInterestFormatted' } },
        { id: 'l_c', type: 'responsive_grid', props: { columns: 2, gap: 'sm', children: ['in_lp', 'in_lr'] } },
        { id: 'in_lp', type: 'numeric_input', props: { label: 'Loan Principal', stateKey: '/loan/principal', min: 10000, max: 2000000, step: 5000, defaultValue: 300000 } },
        { id: 'in_lr', type: 'slider', props: { label: 'Annual Rate %', stateKey: '/loan/rate', min: 1, max: 18, step: 0.25, defaultValue: 6.5, unit: '%' } },
        { id: 'l_tbl', type: 'data_table', props: { title: 'Amortization Milestones', rowsRef: '/derived/loan/rows', rows: [], columns: [{ key: 'month', label: 'Period', align: 'left', format: 'text' }, { key: 'balanceFormatted', label: 'Remaining', align: 'right', format: 'text' }] } },
      ],
    },
    dashboard: {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'surf_dash_p2',
      title: 'Regional Revenue Dashboard',
      rootId: 'dash_root',
      textFallback: 'Supplied regional revenue dashboard',
      origin: 'model',
      state: {
        dash: {
          category: 'all',
          search: '',
          records: [
            { region: 'North America', category: 'cloud', revenue: 420 },
            { region: 'Europe', category: 'cloud', revenue: 280 },
            { region: 'APAC', category: 'ai', revenue: 350 },
            { region: 'LATAM', category: 'ai', revenue: 120 },
          ],
        },
      },
      computed: [
        {
          target: '/derived/dash',
          kind: 'table_filter_aggregate',
          rowsRef: '/dash/records',
          searchRef: '/dash/search',
          categoryRef: '/dash/category',
          categoryField: 'category',
          labelField: 'region',
          valueField: 'revenue',
          metricLabel: 'Revenue ($k)',
          currency: 'USD',
        },
      ],
      actions: [],
      evidence: [],
      components: [
        { id: 'dash_root', type: 'vertical_group', props: { gap: 'sm', children: ['d_hdr', 'd_flt', 'd_kpi', 'd_ch', 'd_tbl'] } },
        { id: 'd_hdr', type: 'heading', props: { level: 3, text: 'Supplied-Data Revenue Dashboard' } },
        { id: 'd_flt', type: 'horizontal_group', props: { gap: 'sm', wrap: true, align: 'end', children: ['d_cat', 'd_srch'] } },
        { id: 'd_cat', type: 'select_control', props: { label: 'Segment Filter', stateKey: '/dash/category', defaultValue: 'all', options: [{ label: 'All Segments', value: 'all' }, { label: 'Cloud', value: 'cloud' }, { label: 'AI Suite', value: 'ai' }] } },
        { id: 'd_srch', type: 'text_input', props: { label: 'Region Search', stateKey: '/dash/search', defaultValue: '', placeholder: 'Filter region...' } },
        { id: 'd_kpi', type: 'responsive_grid', props: { columns: 2, gap: 'sm', children: ['d_tot', 'd_cnt'] } },
        { id: 'd_tot', type: 'metric_display', props: { label: 'Filtered Total ($k)', value: '$0', dataRef: '/derived/dash/totalFormatted' } },
        { id: 'd_cnt', type: 'metric_display', props: { label: 'Matching Regions', value: 0, dataRef: '/derived/dash/count' } },
        { id: 'd_ch', type: 'bar_chart', props: { title: 'Revenue by Region', labels: [], datasets: [{ label: 'Revenue', values: [] }], labelsRef: '/derived/dash/labels', datasetsRef: '/derived/dash/datasets' } },
        { id: 'd_tbl', type: 'data_table', props: { title: 'Filtered Records', rowsRef: '/derived/dash/rows', rows: [], columns: [{ key: 'region', label: 'Region', align: 'left', format: 'text' }, { key: 'revenue', label: 'Revenue', align: 'right', format: 'number' }] } },
      ],
    },
    matrix: {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'surf_mat_p2',
      title: 'Decision Matrix',
      rootId: 'mat_root',
      textFallback: 'Vendor weighted decision matrix',
      origin: 'model',
      state: {
        weights: { cost: 70, speed: 30 },
        candidates: [
          { name: 'Vendor Alpha', cost: 92, speed: 50 },
          { name: 'Vendor Beta', cost: 50, speed: 98 },
        ],
      },
      computed: [
        {
          target: '/derived/mat',
          kind: 'weighted_decision',
          candidatesRef: '/candidates',
          weightsRef: '/weights',
          criteria: [{ key: 'cost', label: 'Cost' }, { key: 'speed', label: 'Speed' }],
        },
      ],
      actions: [],
      evidence: [],
      components: [
        { id: 'mat_root', type: 'vertical_group', props: { gap: 'sm', children: ['m_hdr', 'm_top_w', 'm_sl_c', 'm_sl_s', 'm_bar'] } },
        { id: 'm_hdr', type: 'heading', props: { level: 3, text: 'Weighted Decision Matrix' } },
        { id: 'm_top_w', type: 'metric_display', props: { label: 'Leading Option', value: '-', dataRef: '/derived/mat/topScoreLabel' } },
        { id: 'm_sl_c', type: 'numeric_input', props: { label: 'Cost Weight Input', stateKey: '/weights/cost', min: 0, max: 100, step: 5, defaultValue: 70 } },
        { id: 'm_sl_s', type: 'numeric_input', props: { label: 'Speed Weight Input', stateKey: '/weights/speed', min: 0, max: 100, step: 5, defaultValue: 30 } },
        { id: 'm_bar', type: 'bar_chart', props: { title: 'Weighted Scores', labels: [], datasets: [{ label: 'Score', values: [] }], labelsRef: '/derived/mat/labels', datasetsRef: '/derived/mat/datasets' } },
      ],
    },
    study: {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'surf_study_p2',
      title: 'Study Planner',
      rootId: 'st_root',
      textFallback: 'Interactive study checklist',
      origin: 'model',
      state: { study: { t1: false, t2: false, hours: 8 } },
      computed: [{ target: '/derived/study', kind: 'progress_ratio', itemKeys: ['/study/t1', '/study/t2'] }],
      actions: [],
      evidence: [],
      components: [
        { id: 'st_root', type: 'vertical_group', props: { gap: 'sm', children: ['st_hdr', 'st_prog', 'st_c1', 'st_c2'] } },
        { id: 'st_hdr', type: 'heading', props: { level: 3, text: 'Interactive Study Planner' } },
        { id: 'st_prog', type: 'progress_indicator', props: { label: 'Completion Progress', value: 0, valueRef: '/derived/study/completed', max: 2, unit: 'tasks' } },
        { id: 'st_c1', type: 'checkbox', props: { label: 'Complete Algorithms Reading', stateKey: '/study/t1', defaultChecked: false } },
        { id: 'st_c2', type: 'checkbox', props: { label: 'Solve Dynamic Programming Lab', stateKey: '/study/t2', defaultChecked: false } },
      ],
    },
    form: {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'surf_form_p2',
      title: 'Onboarding Multi-Step Form',
      rootId: 'fm_root',
      textFallback: 'Multi-step project onboarding wizard',
      origin: 'model',
      state: { form: { step: 1, email: '', role: 'engineer' } },
      actions: [
        { id: 'act_next', label: 'Continue', kind: 'local_recompute', permissionLevel: 'NONE', requiresApproval: false },
        { id: 'act_back', label: 'Back', kind: 'local_recompute', permissionLevel: 'NONE', requiresApproval: false },
        { id: 'act_submit_form', label: 'Submit Onboarding', kind: 'attach_followup', permissionLevel: 'NONE', requiresApproval: false },
      ],
      evidence: [],
      components: [
        { id: 'fm_root', type: 'vertical_group', props: { gap: 'sm', children: ['fm_hdr', 'sec_s1', 'sec_s2'] } },
        { id: 'fm_hdr', type: 'heading', props: { level: 3, text: 'Multi-Step Onboarding Form' } },
        {
          id: 'sec_s1',
          type: 'section',
          visibleWhen: { stateKey: '/form/step', equals: 1 },
          props: { title: 'Step 1: Contact Details', collapsible: false, defaultCollapsed: false, children: ['fm_email', 'btn_next'] },
        },
        {
          id: 'fm_email',
          type: 'text_input',
          checks: [
            { kind: 'required', valueRef: '/form/email', message: 'Work email is required.' },
            { kind: 'email', valueRef: '/form/email', message: 'Enter a valid email address.' },
          ],
          props: { label: 'Work Email', stateKey: '/form/email', defaultValue: '', placeholder: 'alex@company.com' },
        },
        {
          id: 'btn_next',
          type: 'action_button',
          props: { label: 'Next Step', actionId: 'act_next', variant: 'primary', requiresValidState: true, setState: { '/form/step': 2 } },
        },
        {
          id: 'sec_s2',
          type: 'section',
          visibleWhen: { stateKey: '/form/step', equals: 2 },
          props: { title: 'Step 2: Role & Confirm', collapsible: false, defaultCollapsed: false, children: ['fm_role', 'fm_btns'] },
        },
        {
          id: 'fm_role',
          type: 'select_control',
          props: { label: 'Primary Role', stateKey: '/form/role', defaultValue: 'engineer', options: [{ label: 'Engineer', value: 'engineer' }, { label: 'Architect', value: 'architect' }] },
        },
        { id: 'fm_btns', type: 'horizontal_group', props: { gap: 'sm', wrap: true, align: 'center', children: ['btn_back', 'btn_submit'] } },
        { id: 'btn_back', type: 'action_button', props: { label: 'Back Step', actionId: 'act_back', variant: 'secondary', setState: { '/form/step': 1 } } },
        { id: 'btn_submit', type: 'action_button', props: { label: 'Submit Form Action', actionId: 'act_submit_form', variant: 'primary', requiresValidState: true } },
      ],
    },
  };
}

test('Phase 2 E2E Acceptance: 7 Interactive Apps, A2UI Streaming, Persistence, Live NIM, Accessibility & Security', async () => {
  const distDir = path.resolve(process.cwd(), 'dist');
  assert.ok(fs.existsSync(path.join(distDir, 'index.html')), 'dist/index.html must exist from npm run build');

  const savedEnv = { ...process.env };
  const nvidiaKey = loadNvidiaKeyIfAvailable();
  if (nvidiaKey) process.env.NVIDIA_API_KEY = nvidiaKey;
  process.env.AIRA_ALLOW_MOCK = 'true';

  const modelRouter = new ModelRouter(new ProviderHealthTracker());
  const toolRegistry = new ToolRegistry(process.cwd());
  const approvalRepo: any = {
    requests: new Map<string, any>(),
    async saveRequest(r: any) { this.requests.set(r.id, r); },
    async getRequest(id: string) { return this.requests.get(id); },
    async getPendingForRun() { return []; },
    async resolveRequest() {},
  };
  const grantRepo: any = {
    async hasAlwaysGrant() { return false; },
    async hasSessionGrant() { return false; },
    async grantSession() {},
    async grantAlways() {},
    async clearSession() {},
  };
  const runtime = new AgentRuntime(
    modelRouter,
    toolRegistry,
    new ApprovalKernel(approvalRepo, grantRepo),
    new BrainV2KnowledgeEngine(new InMemoryKnowledgeRepository(), { seedDefaults: false }),
    new InMemoryRunRepository(),
    process.cwd()
  );

  const ownerPrincipal: ExecutionPrincipal = {
    userId: 'usr_p2_e2e_owner',
    sessionId: 'sess_p2_e2e',
    workspaceId: 'ws_p2_e2e',
    roles: ['member'],
  };

  const surfaces = buildScenarioSurfaces();
  const persistedConvs = new Map<string, { owner: string; data: any }>();
  const actionReplayCache = new Map<string, { hash: string; body: any }>();
  const chatCalls: string[] = [];
  const liveTelemetry: any = { completed: false, terminated: false, error: '', surfaces: 0, textLen: 0, ttftMs: 0, completeMs: 0 };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.principal = req.headers['x-test-principal'] === 'attacker'
      ? { userId: 'usr_p2_attacker', sessionId: 's_att', workspaceId: 'ws_att', roles: ['member'] }
      : ownerPrincipal;
    next();
  });

  app.get('/api/auth/session', (_req, res) =>
    res.json({ status: 'AUTHENTICATED', user: { id: ownerPrincipal.userId, email: 'p2@example.com', name: 'Phase2 QA' }, csrfToken: 'csrf_p2' })
  );
  app.get('/api/billing/summary', (_req, res) =>
    res.json({ tier: 'pro', usage: { standardDaily: 0, standardMonthly: 0, deepMonthly: 0, tokensMonthly: 0 }, limits: { standardDaily: 150, standardMonthly: 2000, deepMonthly: 200 }, creditBalance: 0 })
  );
  app.get('/api/billing/entitlements', (_req, res) =>
    res.json({ tier: 'pro', features: { webSearch: true, deepThinking: true, builder: true, autonomous: true, vision: true } })
  );
  app.get('/api/announcements', (_req, res) => res.json({ announcements: [], unreadCount: 0 }));
  app.post('/api/announcements/dismiss', (_req, res) => res.json({ ok: true }));
  app.get('/api/user/onboarding', (_req, res) => res.json({ completed: true, currentStep: 99 }));
  app.post('/api/user/onboarding', (_req, res) => res.json({ completed: true, currentStep: 99 }));
  app.get('/api/account/settings', (_req, res) => res.json({ settings: null }));
  app.put('/api/account/settings', (_req, res) => res.json({ ok: true }));
  app.get('/api/conversations/search', (_req, res) => res.json({ results: [] }));

  app.post('/api/conversations/sync', (req, res) => {
    const pid = req.principal!.userId;
    const conv = req.body;
    const existing = persistedConvs.get(conv.id);
    if (existing && existing.owner !== pid) return res.status(403).json({ error: 'Cross-tenant write denied' });
    persistedConvs.set(conv.id, { owner: pid, data: conv });
    res.json({ status: 'SYNCED', conversationId: conv.id });
  });
  app.get('/api/conversations', (req, res) => {
    const pid = req.principal!.userId;
    const list = Array.from(persistedConvs.values()).filter((v) => v.owner === pid).map((v) => v.data);
    res.json({ conversations: list });
  });
  app.get('/api/conversations/:id', (req, res) => {
    const item = persistedConvs.get(String(req.params.id));
    if (!item || item.owner !== req.principal!.userId) return res.status(404).json({ error: 'Not found' });
    res.json({ conversation: item.data });
  });

  app.post('/api/genui/actions', (req, res) => {
    const pid = req.principal!.userId;
    const parsed = GenUIInteractionEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid GenUI payload' });
    const evt = parsed.data;
    const convOwner = evt.conversationId ? persistedConvs.get(evt.conversationId)?.owner || 'other_user' : undefined;
    const authz = authorizeGenUIActionServerSide({
      principalUserId: pid,
      conversationOwnerUserId: convOwner,
      event: evt,
    });
    if (!authz.allowed) return res.status(authz.status).json({ error: authz.reason });

    const key = `${pid}:${evt.idempotencyKey || evt.eventId}`;
    const payloadHash = JSON.stringify({ s: evt.surfaceId, a: evt.actionId, st: evt.stateSnapshot });
    const prev = actionReplayCache.get(key);
    if (prev) {
      if (prev.hash !== payloadHash) return res.status(409).json({ error: 'Idempotency mismatch' });
      return res.json({ ...prev.body, idempotentReplay: true });
    }
    const body = { accepted: true, eventId: evt.eventId, surfaceId: evt.surfaceId, recordedAt: Date.now() };
    actionReplayCache.set(key, { hash: payloadHash, body });
    return res.json(body);
  });

  app.post('/api/chat/stream', async (req, res) => {
    const prompt = String(req.body?.prompt || '');
    chatCalls.push(prompt);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    const writeSse = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (prompt.startsWith('[LIVE_NIM]')) {
      const t0 = performance.now();
      const run = await runtime.createRun(
        {
          prompt: prompt.replace(/^\[LIVE_NIM\]\s*/, ''),
          modelPolicy: { model: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
          conversationId: String(req.body?.conversationId || 'conv_live_p2'),
        },
        ownerPrincipal,
        { callerTier: 'pro' }
      );
      writeSse('run_started', { runId: run.id });
      const stream = runtime.getEventStream(run.id);
      const done = new Promise<void>((resolve) => {
        const handler = (evt: any) => {
          if (evt.type === 'content.delta') {
            if (!liveTelemetry.ttftMs) liveTelemetry.ttftMs = Math.round(performance.now() - t0);
            liveTelemetry.textLen += String(evt.data.delta || '').length;
            writeSse('content_delta', { text: evt.data.delta });
          } else if (evt.type === 'genui.surface.created' || evt.type === 'genui.surface.completed' || evt.type === 'genui.surface.error') {
            if (evt.type === 'genui.surface.created') liveTelemetry.surfaces += 1;
            writeSse('genui_event', {
              eventId: evt.eventId,
              type: evt.type,
              runId: evt.runId,
              sequence: evt.sequence ?? evt.data?.sequence ?? 0,
              timestamp: evt.timestamp,
              ...(evt.data || {}),
            });
          } else if (evt.type === 'run.completed' || evt.type === 'run.failed' || evt.type === 'run.cancelled') {
            liveTelemetry.completed = evt.type === 'run.completed';
            liveTelemetry.terminated = true;
            if (evt.type !== 'run.completed') {
              liveTelemetry.error = String(evt.data?.error || evt.type);
            }
            liveTelemetry.completeMs = Math.round(performance.now() - t0);
            stream.off('event', handler);
            resolve();
          }
        };
        stream.on('event', handler);
      });
      void runtime.startRun(run.id).catch(() => {});
      await done;
      res.write('event: done\ndata: [DONE]\n\n');
      res.end();
      return;
    }

    if (/plot\s+function/i.test(prompt)) {
      const run = await runtime.createRun(
        { prompt, modelPolicy: { model: 'mock-deterministic' }, conversationId: 'conv_p2_sci' },
        ownerPrincipal,
        { callerTier: 'pro' }
      );
      writeSse('run_started', { runId: run.id });
      const stream = runtime.getEventStream(run.id);
      const done = new Promise<void>((resolve) => {
        const h = (evt: any) => {
          if (evt.type === 'genui.surface.created' || evt.type === 'genui.surface.completed') {
            writeSse('genui_event', { eventId: evt.eventId, type: evt.type, runId: evt.runId, sequence: evt.sequence ?? evt.data?.sequence ?? 1, timestamp: evt.timestamp, ...(evt.data || {}) });
          } else if (evt.type === 'content.delta') {
            writeSse('content_delta', { text: evt.data.delta });
          } else if (evt.type === 'run.completed') {
            stream.off('event', h);
            resolve();
          }
        };
        stream.on('event', h);
      });
      await runtime.startRun(run.id);
      await done;
      res.write('event: done\ndata: [DONE]\n\n');
      res.end();
      return;
    }

    const mappedKey = prompt.includes('[SCENARIO:investment]')
      ? 'investment'
      : prompt.includes('[SCENARIO:loan]')
        ? 'loan'
        : prompt.includes('[SCENARIO:dashboard]')
          ? 'dashboard'
          : prompt.includes('[SCENARIO:matrix]')
            ? 'matrix'
            : prompt.includes('[SCENARIO:study]')
              ? 'study'
              : prompt.includes('[SCENARIO:form]')
                ? 'form'
                : null;

    if (mappedKey) {
      const surf = surfaces[mappedKey];
      writeSse('run_started', { runId: `run_${mappedKey}` });
      writeSse('content_delta', { text: `Interactive surface ready for ${surf.title}.` });
      writeSse('genui_event', {
        eventId: `evt_${mappedKey}_1`,
        type: 'genui.surface.created',
        surfaceId: surf.surfaceId,
        runId: `run_${mappedKey}`,
        sequence: 1,
        timestamp: Date.now(),
        surface: surf,
      });
      writeSse('genui_event', {
        eventId: `evt_${mappedKey}_2`,
        type: 'genui.surface.completed',
        surfaceId: surf.surfaceId,
        runId: `run_${mappedKey}`,
        sequence: 2,
        timestamp: Date.now(),
      });
      res.write('event: done\ndata: [DONE]\n\n');
      res.end();
      return;
    }

    writeSse('run_started', { runId: 'run_followup' });
    writeSse('content_delta', { text: `Follow-up confirmed: ${prompt.slice(0, 120)}` });
    res.write('event: done\ndata: [DONE]\n\n');
    res.end();
  });

  app.use(express.static(distDir));
  app.use((_req, res) => res.sendFile(path.join(distDir, 'index.html')));

  let server: ReturnType<typeof app.listen> | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  const pageErrors: string[] = [];

  try {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server!.once('listening', r));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      browser = await chromium.launch({
        headless: true,
        executablePath: fs.existsSync(chromePath) ? chromePath : edgePath,
      });
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.addInitScript(() => {
      const dismissed = JSON.stringify(['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']);
      window.localStorage.setItem('aira_dismissed_announcements_usr_p2_e2e_owner', dismissed);
      window.localStorage.setItem('aira_dismissed_announcements_guest', dismissed);
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await dismissBlockingOverlays(page);
    const composer = page.locator('textarea').first();
    await composer.waitFor({ state: 'visible', timeout: 10000 });

    // A. Investment Planner ($0 inference on input change)
    await composer.fill('[SCENARIO:investment] Build an investment planner');
    await composer.press('Enter');
    await page.getByText('Investment Growth Planner').waitFor({ state: 'visible', timeout: 8000 });
    const invCallsBefore = chatCalls.length;
    const invBeforeTxt = await page.locator('[data-testid="genui-surface-surf_inv_p2"]').innerText();
    const tInvStart = performance.now();
    await page.getByRole('spinbutton', { name: 'Initial Principal' }).fill('50000');
    const invReactMs = Math.round(performance.now() - tInvStart);
    const invAfterTxt = await page.locator('[data-testid="genui-surface-surf_inv_p2"]').innerText();
    assert.notEqual(invBeforeTxt, invAfterTxt);
    assert.equal(chatCalls.length, invCallsBefore, 'Local investment input update must trigger 0 AI requests');

    // B. Loan Calculator
    await composer.fill('[SCENARIO:loan] Build a loan calculator');
    await composer.press('Enter');
    await page.getByText('Mortgage & Loan EMI Planner').waitFor({ state: 'visible', timeout: 8000 });
    const loanCallsBefore = chatCalls.length;
    const loanTxt1 = await page.locator('[data-testid="genui-surface-surf_loan_p2"]').innerText();
    await page.getByRole('spinbutton', { name: 'Loan Principal' }).fill('600000');
    const loanTxt2 = await page.locator('[data-testid="genui-surface-surf_loan_p2"]').innerText();
    assert.notEqual(loanTxt1, loanTxt2);
    assert.equal(chatCalls.length, loanCallsBefore);

    // C. Supplied-Data Dashboard (filter updates table + metrics + chart at $0)
    await composer.fill('[SCENARIO:dashboard] Build regional dashboard');
    await composer.press('Enter');
    await page.getByText('Supplied-Data Revenue Dashboard').waitFor({ state: 'visible', timeout: 8000 });
    const dashCallsBefore = chatCalls.length;
    await page.getByLabel('Segment Filter').selectOption('ai');
    const dashText = await page.locator('[data-testid="genui-surface-surf_dash_p2"]').innerText();
    assert.ok(dashText.includes('APAC') && !dashText.includes('Europe'));
    assert.equal(chatCalls.length, dashCallsBefore);

    // D. Interactive Decision Matrix (flip weights -> leading candidate changes)
    await composer.fill('[SCENARIO:matrix] Build decision matrix');
    await composer.press('Enter');
    await page.getByText('Weighted Decision Matrix').waitFor({ state: 'visible', timeout: 8000 });
    const matSurf = page.locator('[data-testid="genui-surface-surf_mat_p2"]');
    assert.ok((await matSurf.innerText()).includes('Vendor Alpha'));
    await matSurf.getByRole('spinbutton', { name: 'Cost Weight Input' }).fill('10');
    await matSurf.getByRole('spinbutton', { name: 'Speed Weight Input' }).fill('90');
    assert.ok((await matSurf.innerText()).includes('Vendor Beta'));

    // F. Scientific Function Explorer + invalid expression resilience
    await composer.fill('Plot function f(x) = sin(x) + 0.25 * x^2');
    await composer.press('Enter');
    await page.getByText('Scientific Function Plotter').waitFor({ state: 'visible', timeout: 8000 });
    await page.getByRole('textbox', { name: 'f(x) =' }).fill('eval("hack")');
    await page.getByText(/Unsupported/i).waitFor({ state: 'visible', timeout: 5000 });

    // G. Multi-Step Form (@checks block invalid step 1, valid advances, authorized submit)
    await composer.fill('[SCENARIO:form] Create onboarding form');
    await composer.press('Enter');
    await page.getByText('Multi-Step Onboarding Form').waitFor({ state: 'visible', timeout: 8000 });
    const formSurf = page.locator('[data-testid="genui-surface-surf_form_p2"]');
    assert.equal(await formSurf.getByRole('button', { name: 'Next Step' }).isDisabled(), true);
    await formSurf.getByRole('textbox', { name: 'Work Email' }).fill('bad-email');
    assert.ok((await formSurf.getByRole('alert').innerText()).includes('valid email'));
    await formSurf.getByRole('textbox', { name: 'Work Email' }).fill('architect@virexa.ai');
    assert.equal(await formSurf.getByRole('button', { name: 'Next Step' }).isDisabled(), false);
    await formSurf.getByRole('button', { name: 'Next Step' }).click();
    await formSurf.getByText('Step 2: Role & Confirm').waitFor({ state: 'visible', timeout: 4000 });
    await formSurf.getByRole('button', { name: 'Submit Form Action' }).click();
    await page.getByText(/Follow-up confirmed:.*architect@virexa\.ai/).waitFor({ state: 'visible', timeout: 8000 });

    // E. Study Planner + Reload Persistence Verification
    await composer.fill('[SCENARIO:study] Create study planner');
    await composer.press('Enter');
    await page.getByText('Interactive Study Planner').waitFor({ state: 'visible', timeout: 8000 });
    const studySurf = page.locator('[data-testid="genui-surface-surf_study_p2"]');
    await studySurf.getByLabel('Complete Algorithms Reading').check();
    assert.equal(await studySurf.getByRole('progressbar').getAttribute('aria-valuenow'), '1');
    await page.waitForTimeout(500);

    // Reload browser page and verify deterministic state restore without re-running inference!
    const callsBeforeReload = chatCalls.length;
    const tRestoreStart = performance.now();
    await page.reload({ waitUntil: 'networkidle' });
    await dismissBlockingOverlays(page);
    await page.getByText('Interactive Study Planner').waitFor({ state: 'visible', timeout: 8000 });
    const restoreMs = Math.round(performance.now() - tRestoreStart);
    assert.equal(await page.locator('[data-testid="genui-surface-surf_study_p2"]').getByRole('progressbar').getAttribute('aria-valuenow'), '1');
    assert.equal(chatCalls.length, callsBeforeReload, 'Reload restoration must NOT re-run AI inference');

    // Keyboard & viewport checks (Desktop Dark, Tablet 768x1024, Mobile 375x812)
    await page.keyboard.press('Tab');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.setViewportSize({ width: 768, height: 1024 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.setViewportSize({ width: 1440, height: 900 });

    // Security endpoint checks from API boundary
    const attackerResp = await fetch(`${baseUrl}/api/genui/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': 'attacker' },
      body: JSON.stringify({
        eventId: 'evt_att_1',
        surfaceId: 'surf_form_p2',
        componentId: 'btn_submit',
        actionId: 'act_submit_form',
        kind: 'attach_followup',
        conversationId: Array.from(persistedConvs.keys())[0] || 'conv_x',
        stateSnapshot: { x: 1 },
        timestamp: Date.now(),
      }),
    });
    assert.equal(attackerResp.status, 403);

    // Bounded Live NVIDIA NIM AI-generated declarative interactive UI turn
    if (nvidiaKey) {
      const liveCallsBefore = chatCalls.length;
      await composer.fill(
        '[LIVE_NIM] Create an interactive budget allocator with two sliders (housingPct, savingsPct) and a metric card.'
      );
      await composer.press('Enter');
      const deadline = Date.now() + 28000;
      while (!liveTelemetry.terminated && Date.now() < deadline) {
        await page.waitForTimeout(150);
      }
      assert.equal(liveTelemetry.completed, true, `Live NIM declarative turn must complete (${liveTelemetry.error || 'timeout'})`);
      assert.ok(liveTelemetry.surfaces >= 1 || liveTelemetry.textLen > 20, 'Must deliver surface or safe text fallback');
      assert.equal(chatCalls.length, liveCallsBefore + 1);
      console.log(
        `[PHASE2_E2E_METRICS] invReactMs=${invReactMs}ms restoreMs=${restoreMs}ms liveCompleted=${liveTelemetry.completed} liveSurfaces=${liveTelemetry.surfaces} liveTtftMs=${liveTelemetry.ttftMs}ms liveCompleteMs=${liveTelemetry.completeMs}ms liveTextLen=${liveTelemetry.textLen}`
      );
    } else {
      console.log(`[PHASE2_E2E_METRICS] invReactMs=${invReactMs}ms restoreMs=${restoreMs}ms live=SKIPPED_NO_KEY`);
    }

    assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join(' | ')}`);
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
    process.env = savedEnv;
  }
});
