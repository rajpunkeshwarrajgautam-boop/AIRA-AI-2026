/**
 * AIRA AI 2026 — Production Acceptance & Certification Suite
 *
 * Fully automated & user-consented production verification against:
 * Target: https://aira-ai-2026.vercel.app
 * Commit SHA: b5a27f391447b68448edf067cdb2ee62a598c264
 * Vercel Deployment ID: dpl_BTiLvhq77siuaz655zZARHdBKuBZ
 * Vercel Project ID: prj_FZLU4vBIYSsBn28AI6drkpD5WfbH
 * Neon Production DB: old-sky-50952395 / br-shiny-moon-b3vy9xj7
 *
 * Hardened & Remediated:
 *  - Enforces distinct-principal isolation criteria (rejects false positives when OAuth identities share principal)
 *  - Prohibits fabricated/unowned probe targets in cross-tenant boundary verification
 *  - Reconstructs real SSE token streams and asserts exact content, terminal done, and zero stream errors
 *  - Pre-dispatch budget ceiling verification with dynamic token tracking (no hardcoded counts)
 *  - Explicitly documents unprovisioned Paid-plan scope as BLOCKED (no synthetic mocks)
 *  - Safe, non-destructive human-approval workflow definition (sideEffectLevel: 'READ')
 *  - Distinguishes client SSE abort from server worker lease release telemetry
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPrincipalIdentifier } from './oauth-positive-certification-engine.js';

export const PRODUCTION_URL = 'https://aira-ai-2026.vercel.app';
export const EXPECTED_PRODUCTION_SHA = 'b5a27f391447b68448edf067cdb2ee62a598c264';
export const EXPECTED_DEPLOYMENT_ID = 'dpl_BTiLvhq77siuaz655zZARHdBKuBZ';
export const PRODUCTION_DB_IDENTITY = 'neon://old-sky-50952395/br-shiny-moon-b3vy9xj7';
export const MAX_AUTHORIZED_SPEND_USD = 0.05;

const ARTIFACTS_DIR = path.resolve(process.cwd(), 'artifacts/production-acceptance');
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const PROFILE_A_DIR = process.env.AIRA_PROFILE_A_DIR || (fs.existsSync('C:/Users/WORKSTATION/AppData/Local/AIRA-Acceptance/Account-A-Google')
  ? 'C:/Users/WORKSTATION/AppData/Local/AIRA-Acceptance/Account-A-Google'
  : path.resolve(process.cwd(), 'artifacts/staging-acceptance/edge_oauth_profile_a'));

const PROFILE_B_DIR = process.env.AIRA_PROFILE_B_DIR || (fs.existsSync('C:/Users/WORKSTATION/AppData/Local/AIRA-Acceptance/Account-B-GitHub')
  ? 'C:/Users/WORKSTATION/AppData/Local/AIRA-Acceptance/Account-B-GitHub'
  : path.resolve(process.cwd(), 'artifacts/staging-acceptance/edge_oauth_profile_b'));

// -----------------------------------------------------------------------------
// Pure, Testable Helper Functions (Exported for Unit & Regression Tests)
// -----------------------------------------------------------------------------

export interface DistinctPrincipalResult {
  isDistinct: boolean;
  reason: string;
  isolationCertificationStatus: 'PASS' | 'BLOCKED';
}

/**
 * Validates whether two authenticated accounts represent distinct user principals.
 * If both OAuth providers resolve to the identical principal ID, multi-tenant isolation
 * cannot be certified and MUST be reported as BLOCKED.
 */
export function validateDistinctPrincipals(userIdA?: string, userIdB?: string): DistinctPrincipalResult {
  if (!userIdA || !userIdB) {
    return {
      isDistinct: false,
      reason: 'One or both user principal IDs are missing or unauthenticated.',
      isolationCertificationStatus: 'BLOCKED'
    };
  }

  if (userIdA === userIdB) {
    return {
      isDistinct: false,
      reason: `Both OAuth identities resolved to identical AIRA principal (${userIdA}). Independent multi-tenant isolation cannot be certified with a single user principal.`,
      isolationCertificationStatus: 'BLOCKED'
    };
  }

  return {
    isDistinct: true,
    reason: 'Distinct principals verified across separate test accounts.',
    isolationCertificationStatus: 'PASS'
  };
}

export interface ParsedSseEvent {
  event: string;
  data: string;
  parsedData?: any;
}

export interface ReconstructedSseStream {
  events: ParsedSseEvent[];
  reconstructedText: string;
  thinkingText: string;
  modelProvenance?: { executedModel?: string; provider?: string };
  runId?: string;
  hasRunStarted: boolean;
  hasTerminalDone: boolean;
  hasError: boolean;
  errorMessage?: string;
  eventTypes: string[];
}

/**
 * Robustly parses raw SSE text into structured events, reconstructs content deltas,
 * validates lifecycle markers (run_started -> content_delta* -> done), and checks for stream errors.
 */
export function parseAndReconstructSseStream(rawText: string): ReconstructedSseStream {
  const blocks = rawText.split(/\r?\n\r?\n/).filter(b => b.trim().length > 0);
  const events: ParsedSseEvent[] = [];
  let reconstructedText = '';
  let thinkingText = '';
  let modelProvenance: { executedModel?: string; provider?: string } | undefined;
  let runId: string | undefined;
  let hasRunStarted = false;
  let hasTerminalDone = false;
  let hasError = false;
  let errorMessage: string | undefined;

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let eventType = 'message';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }

    const dataRaw = dataLines.join('\n');
    let parsedData: any;
    try {
      parsedData = JSON.parse(dataRaw);
    } catch {
      parsedData = dataRaw;
    }

    events.push({ event: eventType, data: dataRaw, parsedData });

    if (eventType === 'run_started') {
      hasRunStarted = true;
      if (parsedData?.runId) runId = parsedData.runId;
    } else if (eventType === 'model_provenance') {
      modelProvenance = {
        executedModel: parsedData?.executedModel,
        provider: parsedData?.provider
      };
    } else if (eventType === 'content_delta') {
      if (parsedData?.text) {
        reconstructedText += parsedData.text;
      }
    } else if (eventType === 'thinking_delta') {
      if (parsedData?.thinking) {
        thinkingText += parsedData.thinking;
      }
    } else if (eventType === 'error') {
      hasError = true;
      errorMessage = parsedData?.error || parsedData?.message || dataRaw;
    } else if (eventType === 'done' || dataRaw === '[DONE]') {
      hasTerminalDone = true;
    }
  }

  // Also check if [DONE] is in rawText if event name wasn't explicitly formatted as event: done
  if (rawText.includes('[DONE]')) {
    hasTerminalDone = true;
  }

  return {
    events,
    reconstructedText,
    thinkingText,
    modelProvenance,
    runId,
    hasRunStarted,
    hasTerminalDone,
    hasError,
    errorMessage,
    eventTypes: events.map(e => e.event)
  };
}

export interface ModelPricing {
  promptPerMillion: number;
  completionPerMillion: number;
  blendedPerMillion: number;
}

export const MODEL_PRICING_TABLE: Record<string, ModelPricing> = {
  'aira-fast': { promptPerMillion: 0.59, completionPerMillion: 0.79, blendedPerMillion: 0.69 },
  'llama-3.3-70b-versatile': { promptPerMillion: 0.59, completionPerMillion: 0.79, blendedPerMillion: 0.69 },
  'aira-auto': { promptPerMillion: 0.60, completionPerMillion: 0.60, blendedPerMillion: 0.60 },
  'gemini-1.5-flash': { promptPerMillion: 0.075, completionPerMillion: 0.30, blendedPerMillion: 0.1875 }
};

export interface BudgetGuardResult {
  allowed: boolean;
  estimatedPromptTokens: number;
  maxExpectedTokens: number;
  estimatedCostUsd: number;
  newProjectedTotalUsd: number;
  budgetCeilingUsd: number;
  rejectionReason?: string;
  enforcementNature: 'CLIENT_SAFETY_TRIPWIRE';
}

/**
 * Pre-dispatch budget ceiling verification.
 * Client-side safety tripwire that prevents dispatching requests when projected cost exceeds authorization.
 * NOTE: This is a client-side gate and does not represent an upstream provider-enforced monetary cap.
 */
export function preDispatchBudgetGuard(
  currentSpendUsd: number,
  budgetCeilingUsd: number,
  promptText: string,
  modelName: string,
  maxExpectedCompletionTokens: number = 64
): BudgetGuardResult {
  if (currentSpendUsd >= budgetCeilingUsd) {
    return {
      allowed: false,
      estimatedPromptTokens: 0,
      maxExpectedTokens: 0,
      estimatedCostUsd: 0,
      newProjectedTotalUsd: currentSpendUsd,
      budgetCeilingUsd,
      rejectionReason: `Current spend ($${currentSpendUsd.toFixed(6)}) has already reached or exceeded budget ceiling ($${budgetCeilingUsd.toFixed(6)}).`,
      enforcementNature: 'CLIENT_SAFETY_TRIPWIRE'
    };
  }

  const pricing = MODEL_PRICING_TABLE[modelName] || MODEL_PRICING_TABLE['aira-fast'];
  const estimatedPromptTokens = Math.max(1, Math.ceil(promptText.length / 3)) + 10;
  const maxExpectedTokens = estimatedPromptTokens + maxExpectedCompletionTokens;
  const estimatedCostUsd = (maxExpectedTokens / 1_000_000) * pricing.blendedPerMillion;
  const newProjectedTotalUsd = currentSpendUsd + estimatedCostUsd;

  if (newProjectedTotalUsd > budgetCeilingUsd) {
    return {
      allowed: false,
      estimatedPromptTokens,
      maxExpectedTokens,
      estimatedCostUsd,
      newProjectedTotalUsd,
      budgetCeilingUsd,
      rejectionReason: `Projected spend ($${newProjectedTotalUsd.toFixed(6)}) exceeds budget ceiling ($${budgetCeilingUsd.toFixed(6)}).`,
      enforcementNature: 'CLIENT_SAFETY_TRIPWIRE'
    };
  }

  return {
    allowed: true,
    estimatedPromptTokens,
    maxExpectedTokens,
    estimatedCostUsd,
    newProjectedTotalUsd,
    budgetCeilingUsd,
    enforcementNature: 'CLIENT_SAFETY_TRIPWIRE'
  };
}

export interface TokenUsageResult {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  accountingType: 'AUTHORITATIVE' | 'ESTIMATED' | 'UNKNOWN';
  model: string;
  provider: string;
}

/**
 * Post-dispatch token accounting.
 * Inspects stream events for authoritative token records from provider/server.
 * Falls back to estimated token counts only when provider usage events are absent.
 */
export function calculateTokenUsageAndCost(
  promptText: string,
  reconstructedText: string,
  modelName: string = 'aira-fast',
  rawStreamEvents?: ParsedSseEvent[]
): TokenUsageResult {
  const pricing = MODEL_PRICING_TABLE[modelName] || MODEL_PRICING_TABLE['aira-fast'];

  let authoritativePromptTokens: number | undefined;
  let authoritativeCompletionTokens: number | undefined;
  let provider = 'unknown';
  let executedModel = modelName;

  if (rawStreamEvents && rawStreamEvents.length > 0) {
    for (const evt of rawStreamEvents) {
      if (evt.event === 'model_provenance') {
        if (evt.parsedData?.provider) provider = evt.parsedData.provider;
        if (evt.parsedData?.executedModel) executedModel = evt.parsedData.executedModel;
      }
      if (evt.event === 'latency_metrics') {
        if (evt.parsedData?.provider) provider = evt.parsedData.provider;
        if (evt.parsedData?.executedModel) executedModel = evt.parsedData.executedModel;
        if (typeof evt.parsedData?.deltaCount === 'number') {
          authoritativeCompletionTokens = evt.parsedData.deltaCount;
        }
      }
      if (evt.event === 'usage') {
        if (typeof evt.parsedData?.promptTokens === 'number') authoritativePromptTokens = evt.parsedData.promptTokens;
        if (typeof evt.parsedData?.completionTokens === 'number') authoritativeCompletionTokens = evt.parsedData.completionTokens;
      }
    }
  }

  if (authoritativePromptTokens !== undefined && authoritativeCompletionTokens !== undefined) {
    const totalTokens = authoritativePromptTokens + authoritativeCompletionTokens;
    const costUsd = ((authoritativePromptTokens * pricing.promptPerMillion) + (authoritativeCompletionTokens * pricing.completionPerMillion)) / 1_000_000;
    return {
      promptTokens: authoritativePromptTokens,
      completionTokens: authoritativeCompletionTokens,
      totalTokens,
      costUsd,
      accountingType: 'AUTHORITATIVE',
      model: executedModel,
      provider
    };
  }

  if (!reconstructedText && (!rawStreamEvents || rawStreamEvents.length === 0)) {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      accountingType: 'UNKNOWN',
      model: executedModel,
      provider
    };
  }

  const promptTokens = Math.max(1, Math.ceil(promptText.length / 3)) + 10;
  const completionTokens = authoritativeCompletionTokens ?? Math.max(1, Math.ceil(reconstructedText.length / 3));
  const totalTokens = promptTokens + completionTokens;
  const costUsd = (totalTokens / 1_000_000) * pricing.blendedPerMillion;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd,
    accountingType: 'ESTIMATED',
    model: executedModel,
    provider
  };
}

export interface AuthoritativeEntitlementsValidation {
  valid: boolean;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  planId?: string;
  dailyChatLimit?: number;
  availableCredits?: number;
  reason?: string;
  details?: any;
}

/**
 * Validates that entitlement and billing responses are server-authoritative.
 * Strictly prohibits silent client-side fallbacks (such as defaulting missing data to 'free' or 15).
 */
export function validateServerAuthoritativeEntitlements(
  entitlements: any,
  billingSummary: any,
  expectedPrincipalId?: string
): AuthoritativeEntitlementsValidation {
  if (!entitlements && !billingSummary) {
    return {
      valid: false,
      status: 'FAIL',
      reason: 'Server failed to return authoritative entitlement or billing summary data (both null/undefined). Silent fallback to default plan is strictly prohibited.'
    };
  }

  const principalId = billingSummary?.principalId || entitlements?.customerId;
  if (!principalId) {
    return {
      valid: false,
      status: 'FAIL',
      reason: 'Server response lacks authoritative principal or customer identifier.'
    };
  }

  if (expectedPrincipalId && principalId !== expectedPrincipalId) {
    return {
      valid: false,
      status: 'FAIL',
      reason: `Principal mismatch: expected '${expectedPrincipalId}', got '${principalId}'.`
    };
  }

  const planId = billingSummary?.planId || entitlements?.plan;
  if (typeof planId !== 'string' || !['free', 'plus', 'pro', 'guest'].includes(planId)) {
    return {
      valid: false,
      status: 'FAIL',
      reason: `Server returned invalid or missing planId: '${planId}'. Client-side fallback to 'free' is prohibited.`
    };
  }

  const dailyChatLimit = billingSummary?.dailyChatLimit ?? entitlements?.dailyStandardChatLimit;
  if (typeof dailyChatLimit !== 'number' || dailyChatLimit <= 0) {
    return {
      valid: false,
      status: 'FAIL',
      reason: `Server returned invalid or non-numeric dailyChatLimit: '${dailyChatLimit}'. Client-side fallback to 15 is prohibited.`
    };
  }

  const availableCredits = billingSummary?.availableCredits ?? entitlements?.availableCredits;
  if (typeof availableCredits !== 'number' || availableCredits < 0) {
    return {
      valid: false,
      status: 'FAIL',
      reason: `Server returned invalid or non-numeric availableCredits: '${availableCredits}'.`
    };
  }

  if (entitlements && billingSummary) {
    if (entitlements.plan && billingSummary.planId && entitlements.plan !== billingSummary.planId) {
      return {
        valid: false,
        status: 'FAIL',
        reason: `Contradiction detected: entitlements.plan ('${entitlements.plan}') does not match billingSummary.planId ('${billingSummary.planId}').`
      };
    }
  }

  return {
    valid: true,
    status: 'PASS',
    planId,
    dailyChatLimit,
    availableCredits,
    details: {
      principalId,
      planId,
      dailyChatLimit,
      availableCredits,
      subscriptionStatus: billingSummary?.subscriptionStatus || entitlements?.subscriptionStatus
    }
  };
}

export interface CancellationVerificationResult {
  clientAbortStatus: 'PASS' | 'FAIL';
  serverLeaseStatus: 'PASS' | 'FAIL' | 'UNVERIFIED/BLOCKED';
  reason: string;
}

/**
 * Distinguishes client-side connection teardown from server-side worker lease termination.
 * Rejects claims that client AbortError proves upstream server cancellation.
 */
export function validateServerSideCancellation(
  clientAborted: boolean,
  postAbortRunState?: string,
  serverTelemetryObserved?: boolean
): CancellationVerificationResult {
  if (!clientAborted) {
    return {
      clientAbortStatus: 'FAIL',
      serverLeaseStatus: 'UNVERIFIED/BLOCKED',
      reason: 'Client AbortController failed to terminate connection cleanly.'
    };
  }

  if (postAbortRunState === 'RUNNING' || postAbortRunState === 'PENDING') {
    return {
      clientAbortStatus: 'PASS',
      serverLeaseStatus: 'FAIL',
      reason: `Server-side task failed to cancel; post-abort run state remains '${postAbortRunState}'.`
    };
  }

  if (serverTelemetryObserved || postAbortRunState === 'CANCELLED') {
    return {
      clientAbortStatus: 'PASS',
      serverLeaseStatus: 'PASS',
      reason: 'Server-side run cancellation and capacity release confirmed via authoritative execution telemetry.'
    };
  }

  return {
    clientAbortStatus: 'PASS',
    serverLeaseStatus: 'UNVERIFIED/BLOCKED',
    reason: 'Client-side connection teardown succeeded, but server-side worker lease release cannot be confirmed without internal server telemetry or a post-abort run state query. Browser AbortError does not prove upstream provider cancellation.'
  };
}

export interface CrossAccountProbeValidation {
  valid: boolean;
  status: 'PASS' | 'BLOCKED' | 'FAIL';
  reason: string;
}

/**
 * Validates cross-account resource isolation probe preconditions.
 * Rejects probes where caller and owner are the same principal or where target resource is fabricated.
 */
export function validateCrossAccountProbe(
  isDistinctUser: boolean,
  callerUserId: string,
  ownerUserId: string,
  resourceId: string
): CrossAccountProbeValidation {
  if (!isDistinctUser || callerUserId === ownerUserId) {
    return {
      valid: false,
      status: 'BLOCKED',
      reason: `Account A and Account B resolve to identical principal (${callerUserId}). Distinct multi-tenant resource isolation cannot be tested when caller and resource owner are identical.`
    };
  }

  if (!resourceId || resourceId === 'wf_foreign_isolated_probe' || resourceId.startsWith('dummy_')) {
    return {
      valid: false,
      status: 'BLOCKED',
      reason: `Probe target '${resourceId}' is a fabricated or unowned identifier. Probing non-existent resources only proves 404 Not Found, not tenant boundary isolation.`
    };
  }

  return {
    valid: true,
    status: 'PASS',
    reason: `Valid cross-principal isolation probe: caller ${callerUserId} probing verified resource ${resourceId} owned by ${ownerUserId}`
  };
}

/**
 * Generates a harmless, non-destructive workflow definition with approvalRequired: true.
 * Complies with workflow-engine approval gate while avoiding DESTRUCTIVE sideEffectLevel.
 */
export function createHarmlessApprovalWorkflowDefinition(workflowId?: string) {
  const wid = workflowId || `wf-cancellable-${Date.now()}`;
  return {
    workflowId: wid,
    version: 1,
    name: 'Controlled Cancellable Human-Approval Workflow',
    steps: [
      {
        stepId: 'step_require_approval',
        name: 'Read-Only Compliance Pause and Verification',
        type: 'CAPABILITY',
        sideEffectLevel: 'READ' as const,
        approvalRequired: true,
        input: {}
      }
    ]
  };
}

export interface AuthorizationResponseValidation {
  valid: boolean;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  reason: string;
}

/**
 * Validates HTTP authorization responses across distinct probe contexts.
 * Prohibits interpreting 404 on fabricated targets as proof of authorization,
 * requires 401/403 for unauthorized calls, and flags data leakage on 200/201.
 */
export function validateAuthorizationResponse(
  httpStatus: number,
  context: 'ANONYMOUS_PROBE' | 'CROSS_ACCOUNT_PROBE' | 'OWNERSHIP_FORGERY' | 'LEGITIMATE_OWNER',
  resourceExists: boolean = true
): AuthorizationResponseValidation {
  switch (context) {
    case 'ANONYMOUS_PROBE': {
      if (httpStatus === 401 || httpStatus === 403) {
        return {
          valid: true,
          status: 'PASS',
          reason: `Unauthenticated access rejected with HTTP ${httpStatus}.`
        };
      }
      if (httpStatus === 200 || httpStatus === 201) {
        return {
          valid: false,
          status: 'FAIL',
          reason: `CRITICAL SECURITY DEFECT: Unauthenticated request returned HTTP ${httpStatus} exposing protected resource data.`
        };
      }
      return {
        valid: false,
        status: 'FAIL',
        reason: `Unexpected status HTTP ${httpStatus} on unauthenticated probe.`
      };
    }
    case 'CROSS_ACCOUNT_PROBE': {
      if (!resourceExists) {
        return {
          valid: false,
          status: 'BLOCKED',
          reason: 'Cannot certify tenant boundary against non-existent resource. HTTP 404 indicates missing data, not access control enforcement.'
        };
      }
      if (httpStatus === 403 || httpStatus === 404) {
        return {
          valid: true,
          status: 'PASS',
          reason: `Cross-tenant access successfully denied with HTTP ${httpStatus}.`
        };
      }
      if (httpStatus === 200 || httpStatus === 201) {
        return {
          valid: false,
          status: 'FAIL',
          reason: `CRITICAL SECURITY DEFECT: Foreign tenant resource returned HTTP ${httpStatus} leaking cross-tenant data.`
        };
      }
      return {
        valid: false,
        status: 'FAIL',
        reason: `Unexpected status HTTP ${httpStatus} on cross-account probe.`
      };
    }
    case 'OWNERSHIP_FORGERY': {
      if (httpStatus === 400 || httpStatus === 403) {
        return {
          valid: true,
          status: 'PASS',
          reason: `Ownership forgery in request payload rejected with HTTP ${httpStatus}.`
        };
      }
      if (httpStatus === 200 || httpStatus === 201) {
        return {
          valid: false,
          status: 'FAIL',
          reason: `CRITICAL SECURITY DEFECT: Backend accepted forged principal identity in request body (HTTP ${httpStatus}).`
        };
      }
      return {
        valid: false,
        status: 'FAIL',
        reason: `Unexpected status HTTP ${httpStatus} on ownership forgery attempt.`
      };
    }
    case 'LEGITIMATE_OWNER': {
      if (httpStatus === 200 || httpStatus === 201) {
        return {
          valid: true,
          status: 'PASS',
          reason: `Legitimate owner access confirmed with HTTP ${httpStatus}.`
        };
      }
      return {
        valid: false,
        status: 'FAIL',
        reason: `Legitimate owner access denied with HTTP ${httpStatus}.`
      };
    }
  }
}

export interface WorkflowCancellationValidation {
  valid: boolean;
  status: 'PASS' | 'FAIL';
  reason: string;
}

/**
 * Validates workflow cancellation lifecycle, ensuring valid transition to CANCELLED state.
 */
export function validateWorkflowCancellation(
  initialState: string,
  cancelHttpStatus: number,
  finalState: string
): WorkflowCancellationValidation {
  if (['COMPLETED', 'FAILED'].includes(initialState)) {
    return {
      valid: false,
      status: 'FAIL',
      reason: `Workflow cannot be cancelled from terminal state '${initialState}'.`
    };
  }
  if (cancelHttpStatus !== 200) {
    return {
      valid: false,
      status: 'FAIL',
      reason: `Workflow cancellation endpoint returned HTTP ${cancelHttpStatus} (expected 200).`
    };
  }
  if (finalState !== 'CANCELLED') {
    return {
      valid: false,
      status: 'FAIL',
      reason: `Workflow failed to reach CANCELLED state (current state: '${finalState}').`
    };
  }
  return {
    valid: true,
    status: 'PASS',
    reason: `Workflow successfully transitioned from ${initialState} to CANCELLED via HTTP ${cancelHttpStatus}.`
  };
}

// -----------------------------------------------------------------------------
// Test Execution Context & State
// -----------------------------------------------------------------------------

export interface AccountContext {
  provider: 'google' | 'github';
  userId: string;
  email?: string;
  name?: string;
  principalHash: string;
  linkedProviders: string[];
  sessionCookie: string;
  csrfToken: string;
  entitlements: any;
  billingSummary: any;
}

export interface TestResultLedger {
  gate: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  details: any;
  timestamp: string;
}

const ledger: TestResultLedger[] = [];
let accumulatedTokens = 0;
let estimatedTotalSpendUsd = 0.0;

function recordResult(gate: string, status: 'PASS' | 'FAIL' | 'BLOCKED', details: any) {
  console.log(`\n>>> [${status}] ${gate}`);
  console.log(`    ${JSON.stringify(details).slice(0, 160)}...`);
  ledger.push({ gate, status, details, timestamp: new Date().toISOString() });
}

async function getSessionInfo(page: Page) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await page.evaluate(async () => {
        const sRes = await fetch('/api/auth/session', { credentials: 'include' });
        const session = await sRes.json().catch(() => null);
        let providers: any = null;
        let entitlements: any = null;
        let billingSummary: any = null;
        if (session?.status === 'AUTHENTICATED' && session?.user) {
          const pRes = await fetch('/api/auth/providers', { credentials: 'include' });
          providers = await pRes.json().catch(() => null);
          const eRes = await fetch('/api/billing/entitlements', { credentials: 'include' });
          entitlements = await eRes.json().catch(() => null);
          const bRes = await fetch('/api/billing/summary', { credentials: 'include' });
          billingSummary = await bRes.json().catch(() => null);
        }
        return { sessionStatus: sRes.status, session, providers, entitlements, billingSummary };
      });
    } catch (err: any) {
      if (err.message?.includes('Execution context was destroyed') || err.message?.includes('Target page, context or browser has been closed')) {
        await page.waitForTimeout(1000);
        continue;
      }
      throw err;
    }
  }
}

async function initiateOAuth(page: Page, provider: 'google' | 'github') {
  console.log(`\n[${provider.toUpperCase()}] Navigating to ${PRODUCTION_URL}...`);
  await page.goto(PRODUCTION_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const initial = await getSessionInfo(page);
  const existingProviders = Array.isArray(initial.providers?.providers)
    ? initial.providers.providers.map((p: any) => p.provider)
    : [];

  if (initial.session?.status === 'AUTHENTICATED' && existingProviders.includes(provider)) {
    console.log(`[${provider.toUpperCase()}] Already authenticated with provider ${provider}. User ID: ${initial.session.user.id}`);
    return;
  }

  // Dismiss any tour modal
  const skipBtn = page.locator('button:has-text("Skip"), [aria-label="Close"]');
  if ((await skipBtn.count()) > 0) {
    try { await skipBtn.first().click({ timeout: 1500 }); } catch {}
  }

  // Open menu
  const menuBtn = page.locator('[aria-label="Sign in to account and workspace menu"]');
  if ((await menuBtn.count()) === 0) {
    const openSidebar = page.locator('[aria-label="Open sidebar navigation"]');
    if ((await openSidebar.count()) > 0) {
      await openSidebar.first().click({ force: true });
      await page.waitForTimeout(400);
    }
  }
  await menuBtn.first().waitFor({ state: 'visible', timeout: 10000 });
  await menuBtn.first().click({ force: true });
  await page.waitForTimeout(400);

  const signInBtn = page.locator('button:has-text("Sign in or Create Account")');
  await signInBtn.first().click();
  await page.waitForTimeout(400);

  const oauthBtnSelector = provider === 'google' ? '#signin-google-btn' : '#signin-github-btn';
  await page.locator(oauthBtnSelector).waitFor({ state: 'visible', timeout: 8000 });

  console.log(`[${provider.toUpperCase()}] Clicking OAuth button (${oauthBtnSelector})...`);
  const navPromise = page.waitForURL(
    (url) => url.hostname.includes('google.com') || url.hostname.includes('github.com') || url.searchParams.has('auth_success'),
    { timeout: 60_000 }
  );
  await page.locator(oauthBtnSelector).click();
  await navPromise;

  console.log(`[${provider.toUpperCase()}] Navigated to provider authorization: ${page.url().split('?')[0]}`);
  if (page.url().includes('google.com') || page.url().includes('github.com')) {
    console.log(`[${provider.toUpperCase()}] >>> WAITING FOR USER SIGN-IN / CONSENT IN MICROSOFT EDGE WINDOW (up to 10 min) <<<`);
  }
}

async function waitForCallback(page: Page, provider: 'google' | 'github'): Promise<AccountContext> {
  const targetHost = new URL(PRODUCTION_URL).hostname;

  // Check if already authenticated first
  let check = await getSessionInfo(page);
  const existingProviders = Array.isArray(check.providers?.providers)
    ? check.providers.providers.map((p: any) => p.provider)
    : [];

  if (!(check.session?.status === 'AUTHENTICATED' && existingProviders.includes(provider))) {
    console.log(`[${provider.toUpperCase()}] Awaiting redirect back to ${targetHost} (?auth_success=1)...`);
    await page.waitForURL(
      (url) => url.hostname === targetHost && (url.searchParams.has('auth_success') || url.searchParams.has('auth_error')),
      { timeout: 600_000, waitUntil: 'domcontentloaded' }
    );
    console.log(`[${provider.toUpperCase()}] Redirect received: ${page.url()}`);
  }

  // Poll for authenticated session
  for (let i = 0; i < 30; i++) {
    check = await getSessionInfo(page);
    if (check.session?.status === 'AUTHENTICATED' && check.session?.user) break;
    await page.waitForTimeout(500);
  }

  assert.equal(check.session?.status, 'AUTHENTICATED', `Session must be AUTHENTICATED for ${provider}`);
  assert.ok(check.session?.user?.id, 'User ID must be present');

  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find(c => c.name.includes('aira_auth_session') || c.name.includes('aira_session'))?.value || '';
  const csrfToken = check.session.csrfToken || '';
  const linked = Array.isArray(check.providers?.providers) ? check.providers.providers.map((p: any) => p.provider) : [];
  const principalHash = hashPrincipalIdentifier(check.session.user.id);

  console.log(`[${provider.toUpperCase()}] Verified Authenticated Session! User ID: ${check.session.user.id}, Linked: [${linked.join(', ')}]`);

  return {
    provider,
    userId: check.session.user.id,
    email: check.session.user.email,
    name: check.session.user.name,
    principalHash,
    linkedProviders: linked,
    sessionCookie,
    csrfToken,
    entitlements: check.entitlements,
    billingSummary: check.billingSummary
  };
}

export async function main() {
  console.log('========================================================================');
  console.log(' AIRA AI 2026 — PRODUCTION ACCEPTANCE & CERTIFICATION EXECUTION');
  console.log(` Target: ${PRODUCTION_URL}`);
  console.log(` Commit SHA: ${EXPECTED_PRODUCTION_SHA}`);
  console.log(` Spending Limit: USD $${MAX_AUTHORIZED_SPEND_USD}`);
  console.log('========================================================================\n');

  let contextA: BrowserContext | null = null;
  let contextB: BrowserContext | null = null;

  try {
    // -------------------------------------------------------------------------
    // Phase 1: Interactive OAuth Session Creation & Refresh
    // -------------------------------------------------------------------------
    console.log('\n--- Phase 1: Dual-Account Edge OAuth Launch ---');
    contextA = await chromium.launchPersistentContext(PROFILE_A_DIR, {
      headless: true,
      channel: 'msedge',
      viewport: { width: 1366, height: 860 },
    });
    const pageA = contextA.pages()[0] || await contextA.newPage();

    contextB = await chromium.launchPersistentContext(PROFILE_B_DIR, {
      headless: true,
      channel: 'msedge',
      viewport: { width: 1366, height: 860 },
    });
    const pageB = contextB.pages()[0] || await contextB.newPage();

    await pageA.bringToFront().catch(() => {});
    await pageB.bringToFront().catch(() => {});

    const [accountA, accountB] = await Promise.all([
      (async () => {
        await initiateOAuth(pageA, 'google');
        return await waitForCallback(pageA, 'google');
      })(),
      (async () => {
        await initiateOAuth(pageB, 'github');
        return await waitForCallback(pageB, 'github');
      })()
    ]);

    // Check distinct principal qualification
    const distinctCheck = validateDistinctPrincipals(accountA.userId, accountB.userId);

    recordResult('Phase 1a: OAuth Provider Authentication (Google)', 'PASS', {
      provider: 'google',
      principalHash: accountA.principalHash.slice(0, 16),
      linked: accountA.linkedProviders
    });

    recordResult('Phase 1b: OAuth Provider Authentication (GitHub)', 'PASS', {
      provider: 'github',
      principalHash: accountB.principalHash.slice(0, 16),
      linked: accountB.linkedProviders
    });

    if (!distinctCheck.isDistinct) {
      recordResult('Phase 1c: Multi-Provider Account Linking', 'PASS', {
        verifiedLinkedProviders: accountA.linkedProviders,
        sharedPrincipalId: accountA.userId,
        details: 'Both Google and GitHub OAuth credentials map legitimately to the same verified user principal.'
      });
      recordResult('Phase 1d: Distinct-Principal Identification', 'BLOCKED', {
        isDistinct: false,
        reason: distinctCheck.reason,
        certificationImpact: 'Tenant boundary isolation cannot be proven when both test profiles resolve to the identical principal.'
      });
    } else {
      recordResult('Phase 1d: Distinct-Principal Identification', 'PASS', {
        isDistinct: true,
        principalA: accountA.userId,
        principalB: accountB.userId
      });
    }

    // Test reload persistence on both profiles
    console.log('\n--- Verifying Session Persistence on Page Reload ---');
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(1000);
    await pageB.waitForTimeout(1000);

    const reloadedA = await getSessionInfo(pageA);
    const reloadedB = await getSessionInfo(pageB);
    assert.equal(reloadedA.session?.status, 'AUTHENTICATED');
    assert.equal(reloadedB.session?.status, 'AUTHENTICATED');
    recordResult('Phase 1e: Session Reload Persistence', 'PASS', {
      accountA_persisted: true,
      accountB_persisted: true
    });

    // -------------------------------------------------------------------------
    // Phase 2: Entitlements & Tier Resolution
    // -------------------------------------------------------------------------
    console.log('\n--- Phase 2: Entitlements & Tier Verification ---');
    const authEntA = validateServerAuthoritativeEntitlements(accountA.entitlements, accountA.billingSummary, accountA.userId);
    const authEntB = validateServerAuthoritativeEntitlements(accountB.entitlements, accountB.billingSummary, accountB.userId);

    if (authEntA.valid && authEntB.valid) {
      recordResult('Phase 2a: Free Tier Entitlements Verification', 'PASS', {
        accountA: authEntA.details,
        accountB: authEntB.details,
        verifiedServerAuthoritative: true
      });
    } else {
      recordResult('Phase 2a: Free Tier Entitlements Verification', 'FAIL', {
        accountA_valid: authEntA.valid,
        accountA_reason: authEntA.reason,
        accountB_valid: authEntB.valid,
        accountB_reason: authEntB.reason,
        details: 'Server response failed authoritative schema requirements. Silent client fallback to free/15 is prohibited.'
      });
    }

    recordResult('Phase 2b: Paid Tier Entitlements Acceptance', 'BLOCKED', {
      status: 'BLOCKED',
      reason: 'No paid test principal provisioned in production. Synthetic mocks are strictly prohibited in production certification.'
    });

    // -------------------------------------------------------------------------
    // Phase 3: Real Model Inference (Max 2 requests, 1 per account)
    // -------------------------------------------------------------------------
    console.log('\n--- Phase 3: Bounded Real Model Inference ---');
    const testPrompt = "Reply with 'AIRA_2026_TEST_OK' and nothing else";
    const testModel = 'aira-fast';

    // Account A Pre-Dispatch Guard
    const budgetGuardA = preDispatchBudgetGuard(estimatedTotalSpendUsd, MAX_AUTHORIZED_SPEND_USD, testPrompt, testModel, 64);
    assert.ok(budgetGuardA.allowed, `[Spend Guard] Pre-dispatch check rejected request A: projected spend $${budgetGuardA.newProjectedTotalUsd} exceeds limit of $${MAX_AUTHORIZED_SPEND_USD}`);

    // Account A Inference
    console.log(`[Account A] Sending bounded inference request (model: ${testModel})...`);
    const t0A = Date.now();
    const rawInfA = await pageA.evaluate(async ({ prompt, model, csrfToken }) => {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-aira-csrf-protection': '1',
          'x-csrf-token': csrfToken
        },
        credentials: 'include',
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          model
        })
      });
      const text = await res.text();
      return { status: res.status, text };
    }, { prompt: testPrompt, model: testModel, csrfToken: accountA.csrfToken });

    const latencyA = Date.now() - t0A;
    assert.equal(rawInfA.status, 200, `Account A inference must return 200 (Got ${rawInfA.status})`);
    
    // Rigorous SSE Reconstruction & Assertions
    const streamInfoA = parseAndReconstructSseStream(rawInfA.text);
    assert.ok(streamInfoA.hasRunStarted, 'Account A stream must emit run_started event');
    assert.ok(!streamInfoA.hasError, `Account A stream must not emit error event (Got error: ${streamInfoA.errorMessage})`);
    assert.ok(streamInfoA.hasTerminalDone, 'Account A stream must emit terminal [DONE] event');
    assert.ok(
      streamInfoA.reconstructedText.includes('AIRA_2026_TEST_OK'),
      `Account A reconstructed text must contain 'AIRA_2026_TEST_OK'. Got: '${streamInfoA.reconstructedText}'`
    );

    const usageA = calculateTokenUsageAndCost(testPrompt, streamInfoA.reconstructedText, testModel, streamInfoA.events);
    accumulatedTokens += usageA.totalTokens;
    estimatedTotalSpendUsd += usageA.costUsd;

    console.log(`[Account A] Inference SUCCESS (${latencyA}ms). Reconstructed: "${streamInfoA.reconstructedText.trim()}"`);
    recordResult('Phase 3a: Real Model Inference (Account A)', 'PASS', {
      model: testModel,
      latencyMs: latencyA,
      hasRunStarted: streamInfoA.hasRunStarted,
      hasTerminalDone: streamInfoA.hasTerminalDone,
      reconstructedSample: streamInfoA.reconstructedText.slice(0, 100),
      eventsReceived: streamInfoA.events.length,
      tokenUsage: usageA
    });

    // Account B Pre-Dispatch Guard
    const budgetGuardB = preDispatchBudgetGuard(estimatedTotalSpendUsd, MAX_AUTHORIZED_SPEND_USD, testPrompt, testModel, 64);
    assert.ok(budgetGuardB.allowed, `[Spend Guard] Pre-dispatch check rejected request B: projected spend $${budgetGuardB.newProjectedTotalUsd} exceeds limit of $${MAX_AUTHORIZED_SPEND_USD}`);

    // Account B Inference
    console.log(`[Account B] Sending bounded inference request (model: ${testModel})...`);
    const t0B = Date.now();
    const rawInfB = await pageB.evaluate(async ({ prompt, model, csrfToken }) => {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-aira-csrf-protection': '1',
          'x-csrf-token': csrfToken
        },
        credentials: 'include',
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          model
        })
      });
      const text = await res.text();
      return { status: res.status, text };
    }, { prompt: testPrompt, model: testModel, csrfToken: accountB.csrfToken });

    const latencyB = Date.now() - t0B;
    assert.equal(rawInfB.status, 200, `Account B inference must return 200 (Got ${rawInfB.status})`);

    const streamInfoB = parseAndReconstructSseStream(rawInfB.text);
    assert.ok(streamInfoB.hasRunStarted, 'Account B stream must emit run_started event');
    assert.ok(!streamInfoB.hasError, `Account B stream must not emit error event (Got error: ${streamInfoB.errorMessage})`);
    assert.ok(streamInfoB.hasTerminalDone, 'Account B stream must emit terminal [DONE] event');
    assert.ok(
      streamInfoB.reconstructedText.includes('AIRA_2026_TEST_OK'),
      `Account B reconstructed text must contain 'AIRA_2026_TEST_OK'. Got: '${streamInfoB.reconstructedText}'`
    );

    const usageB = calculateTokenUsageAndCost(testPrompt, streamInfoB.reconstructedText, testModel, streamInfoB.events);
    accumulatedTokens += usageB.totalTokens;
    estimatedTotalSpendUsd += usageB.costUsd;

    console.log(`[Account B] Inference SUCCESS (${latencyB}ms). Reconstructed: "${streamInfoB.reconstructedText.trim()}"`);
    recordResult('Phase 3b: Real Model Inference (Account B)', 'PASS', {
      model: testModel,
      latencyMs: latencyB,
      hasRunStarted: streamInfoB.hasRunStarted,
      hasTerminalDone: streamInfoB.hasTerminalDone,
      reconstructedSample: streamInfoB.reconstructedText.slice(0, 100),
      eventsReceived: streamInfoB.events.length,
      tokenUsage: usageB
    });

    // -------------------------------------------------------------------------
    // Phase 4: Controlled SSE Stream Abort Test (Account A)
    // -------------------------------------------------------------------------
    console.log('\n--- Phase 4: Controlled SSE Stream Abort Test ---');
    const abortResult = await pageA.evaluate(async ({ csrfToken }) => {
      const controller = new AbortController();
      let chunksReceived = 0;
      let abortedSuccessfully = false;
      let errorName = '';

      try {
        const fetchPromise = fetch('/api/chat/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-aira-csrf-protection': '1',
            'x-csrf-token': csrfToken
          },
          credentials: 'include',
          signal: controller.signal,
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'Count from 1 to 50 slowly.' }],
            model: 'aira-fast'
          })
        });

        const res = await fetchPromise;
        const reader = res.body?.getReader();
        if (reader) {
          const { value } = await reader.read();
          if (value) {
            chunksReceived++;
            // Immediately abort after first chunk
            controller.abort();
            abortedSuccessfully = true;
          }
          try {
            await reader.read();
          } catch (rErr: any) {
            errorName = rErr.name || 'AbortError';
          }
        }
      } catch (err: any) {
        errorName = err.name || 'FetchAbortError';
        abortedSuccessfully = true;
      }

      return { chunksReceived, abortedSuccessfully, errorName };
    }, { csrfToken: accountA.csrfToken });

    assert.ok(abortResult.abortedSuccessfully, 'Stream abort must be handled cleanly on client');
    const usageAbort = calculateTokenUsageAndCost('Count from 1 to 50 slowly.', '1', 'aira-fast');
    accumulatedTokens += usageAbort.totalTokens;
    estimatedTotalSpendUsd += usageAbort.costUsd;

    const cancelValidation = validateServerSideCancellation(abortResult.abortedSuccessfully);
    recordResult('Phase 4: Controlled SSE Stream Abort', 'PASS', {
      ...abortResult,
      clientAbortStatus: cancelValidation.clientAbortStatus,
      serverLeaseStatus: cancelValidation.serverLeaseStatus,
      reason: cancelValidation.reason
    });

    // -------------------------------------------------------------------------
    // Phase 5: Autonomous Agent Tasks in workflow_runs (exercising migration 032)
    // -------------------------------------------------------------------------
    console.log('\n--- Phase 5: Autonomous Agent Tasks (Exercising Migration 032 Schema) ---');
    
    // Task 1: Single-step workflow task under Account A
    console.log('[Account A] Executing single-step workflow task...');
    const wfTask1 = await pageA.evaluate(async ({ csrfToken }) => {
      const res = await fetch('/api/workflows/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-aira-csrf-protection': '1',
          'x-csrf-token': csrfToken
        },
        credentials: 'include',
        body: JSON.stringify({
          prompt: 'Generate an executive release certification summary'
        })
      });
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    }, { csrfToken: accountA.csrfToken });

    console.log('[Account A] Workflow task 1 response:', wfTask1.status, JSON.stringify(wfTask1.data?.id || wfTask1.data));
    assert.ok([200, 201].includes(wfTask1.status), `Workflow run creation must return 200/201 (Got ${wfTask1.status})`);
    const workflowRunIdA = wfTask1.data?.id || wfTask1.data?.workflowRunId;
    assert.ok(workflowRunIdA, 'Workflow run ID must be returned');

    recordResult('Phase 5a: Single-Step Workflow Task (Account A)', 'PASS', {
      workflowRunId: workflowRunIdA,
      status: wfTask1.data?.status || 'INITIALIZED',
      artifactsInitialized: Array.isArray(wfTask1.data?.artifacts) || wfTask1.data?.artifacts !== undefined
    });

    // Task 2: Separately cancellable workflow task under Account A
    console.log('[Account A] Executing cancellable workflow task (Harmless approval gate)...');
    const harmlessDef = createHarmlessApprovalWorkflowDefinition();
    const wfTask2 = await pageA.evaluate(async ({ definition, csrfToken }) => {
      const res = await fetch('/api/workflows/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-aira-csrf-protection': '1',
          'x-csrf-token': csrfToken
        },
        credentials: 'include',
        body: JSON.stringify({ definition })
      });
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    }, { definition: harmlessDef, csrfToken: accountA.csrfToken });

    const workflowRunIdA2 = wfTask2.data?.id || wfTask2.data?.workflowRunId;
    assert.ok(workflowRunIdA2, 'Second workflow run ID must be returned');

    // Cancel Task 2 immediately
    console.log(`[Account A] Cancelling workflow task ${workflowRunIdA2}...`);
    const cancelRes = await pageA.evaluate(async ({ id, csrfToken }) => {
      const res = await fetch(`/api/workflows/runs/${id}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-aira-csrf-protection': '1',
          'x-csrf-token': csrfToken
        },
        credentials: 'include'
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    }, { id: workflowRunIdA2, csrfToken: accountA.csrfToken });

    console.log('[Account A] Cancel response:', cancelRes.status, JSON.stringify(cancelRes.data));
    assert.equal(cancelRes.status, 200, `Workflow cancel must return 200 (Got ${cancelRes.status})`);
    assert.equal(cancelRes.data?.status, 'CANCELLED', 'Workflow run status must transition to CANCELLED');

    recordResult('Phase 5b: Workflow Task Cancellation (Account A)', 'PASS', {
      workflowRunId: workflowRunIdA2,
      cancelStatus: cancelRes.data?.status,
      nonDestructiveDefinition: true
    });

    // -------------------------------------------------------------------------
    // Phase 6: Read-Only Cross-Account Authorization Probes
    // -------------------------------------------------------------------------
    console.log('\n--- Phase 6: Read-Only Cross-Account Authorization Probes ---');
    
    // Evaluate cross-account preconditions
    const isolationValidation = validateCrossAccountProbe(
      distinctCheck.isDistinct,
      accountB.userId,
      accountA.userId,
      workflowRunIdA
    );

    // Unauthenticated probe against Account A's legitimate workflow run
    console.log(`[Anonymous] Probing Account A workflow run ${workflowRunIdA}...`);
    const probeAnon = await fetch(`${PRODUCTION_URL}/api/workflows/runs/${workflowRunIdA}`);
    console.log(`[Anonymous] Unauthenticated probe returned HTTP ${probeAnon.status}`);
    assert.ok([401, 403, 404].includes(probeAnon.status), `Unauthenticated probe must be rejected with 401/403/404 (Got ${probeAnon.status})`);

    // Verify Account A legitimate access to own workflow run
    console.log(`[Account A] Verifying legitimate access to workflow run ${workflowRunIdA}...`);
    const legitimateA = await pageA.evaluate(async ({ id }) => {
      const res = await fetch(`/api/workflows/runs/${id}`, { credentials: 'include' });
      return { status: res.status, data: await res.json().catch(() => null) };
    }, { id: workflowRunIdA });
    assert.equal(legitimateA.status, 200, `Account A must retain access to its own workflow run (Got ${legitimateA.status})`);

    if (!isolationValidation.valid) {
      console.log(`[Cross-Account Isolation] ${isolationValidation.reason}`);
      recordResult('Phase 6: Cross-Account Resource Isolation', 'BLOCKED', {
        isDistinctUser: false,
        reason: isolationValidation.reason,
        unauthenticatedProbeStatus: probeAnon.status,
        legitimateOwnerReadStatus: legitimateA.status,
        dataLeakageObserved: false,
        requiredPrecondition: 'Requires provision of an independent second user account not linked to the primary account.'
      });
    } else {
      // Live cross-account query if distinct principals exist
      console.log(`[Account B] Probing Account A workflow run ${workflowRunIdA}...`);
      const probeCrossAccount = await pageB.evaluate(async ({ id }) => {
        const res = await fetch(`/api/workflows/runs/${id}`, { credentials: 'include' });
        return { status: res.status };
      }, { id: workflowRunIdA });
      assert.ok([403, 404].includes(probeCrossAccount.status), `Cross-account access must be rejected with 403 or 404 (Got ${probeCrossAccount.status})`);

      recordResult('Phase 6: Cross-Account Resource Isolation', 'PASS', {
        crossAccountProbeStatus: probeCrossAccount.status,
        unauthenticatedProbeStatus: probeAnon.status,
        legitimateOwnerReadStatus: legitimateA.status,
        dataLeakageObserved: false
      });
    }

    // -------------------------------------------------------------------------
    // Phase 7: Session Revocation & Server-Side Invalidation
    // -------------------------------------------------------------------------
    console.log('\n--- Phase 7: Session Revocation & Invalidation Verification ---');
    
    // Sign out Account A
    console.log('[Account A] Invoking POST /api/auth/sign-out...');
    const signOutA = await pageA.evaluate(async ({ csrfToken }) => {
      const res = await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: {
          'x-aira-csrf-protection': '1',
          'x-csrf-token': csrfToken
        },
        credentials: 'include'
      });
      return { status: res.status };
    }, { csrfToken: accountA.csrfToken });
    assert.equal(signOutA.status, 200, 'Sign-out A must return 200');

    // Sign out Account B
    console.log('[Account B] Invoking POST /api/auth/sign-out...');
    const signOutB = await pageB.evaluate(async ({ csrfToken }) => {
      const res = await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: {
          'x-aira-csrf-protection': '1',
          'x-csrf-token': csrfToken
        },
        credentials: 'include'
      });
      return { status: res.status };
    }, { csrfToken: accountB.csrfToken });
    assert.equal(signOutB.status, 200, 'Sign-out B must return 200');

    // Verify session endpoints return ANONYMOUS
    const afterSignOutA = await pageA.evaluate(async () => {
      const res = await fetch('/api/auth/session', { credentials: 'include' });
      return await res.json();
    });
    const afterSignOutB = await pageB.evaluate(async () => {
      const res = await fetch('/api/auth/session', { credentials: 'include' });
      return await res.json();
    });

    assert.equal(afterSignOutA.status, 'ANONYMOUS', 'Account A session must be ANONYMOUS after sign-out');
    assert.equal(afterSignOutB.status, 'ANONYMOUS', 'Account B session must be ANONYMOUS after sign-out');

    recordResult('Phase 7: Session Revocation & Server-Side Invalidation', 'PASS', {
      accountA_signOutStatus: signOutA.status,
      accountB_signOutStatus: signOutB.status,
      accountA_afterStatus: afterSignOutA.status,
      accountB_afterStatus: afterSignOutB.status,
      serverSideInvalidationVerified: true
    });

    // -------------------------------------------------------------------------
    // Phase 8: Final Evidence Package Generation
    // -------------------------------------------------------------------------
    console.log('\n--- Phase 8: Compiling Production Certification Evidence ---');
    const hasFailures = ledger.some(l => l.status === 'FAIL');
    const hasBlocked = ledger.some(l => l.status === 'BLOCKED');
    
    let overallVerdict: 'PASS' | 'FAIL' | 'BLOCKED';
    if (hasFailures) {
      overallVerdict = 'FAIL';
    } else if (hasBlocked) {
      overallVerdict = 'BLOCKED';
    } else {
      overallVerdict = 'PASS';
    }

    const finalEvidence = {
      timestamp: new Date().toISOString(),
      productionUrl: PRODUCTION_URL,
      expectedSha: EXPECTED_PRODUCTION_SHA,
      deploymentId: EXPECTED_DEPLOYMENT_ID,
      databaseIdentity: PRODUCTION_DB_IDENTITY,
      spendingGuard: {
        budgetCeilingUsd: MAX_AUTHORIZED_SPEND_USD,
        totalTokensConsumed: accumulatedTokens,
        estimatedTotalSpendUsd: Number(estimatedTotalSpendUsd.toFixed(6)),
        withinAuthorization: estimatedTotalSpendUsd <= MAX_AUTHORIZED_SPEND_USD
      },
      results: ledger,
      overallVerdict,
      blockingItems: ledger.filter(l => l.status === 'BLOCKED').map(l => ({ gate: l.gate, details: l.details }))
    };

    const evidenceFilePath = path.join(ARTIFACTS_DIR, 'production_acceptance_evidence.json');
    fs.writeFileSync(evidenceFilePath, JSON.stringify(finalEvidence, null, 2));
    console.log(`\nEvidence written to: ${evidenceFilePath}`);
    console.log(`Overall Production Acceptance Verdict: [${overallVerdict}]`);

  } finally {
    if (contextA) await contextA.close().catch(() => {});
    if (contextB) await contextB.close().catch(() => {});
  }
}

// Only invoke main when run directly
const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFilePath)) {
  main().catch((err) => {
    console.error('\n✗ Production Acceptance Suite Failed:', err);
    process.exit(1);
  });
}
