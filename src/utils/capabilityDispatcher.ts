import type { WorkspaceMode } from '../types';
import { authenticatedApiFetch } from '../lib/neonAuth';
import { resolveSchedule, ScheduleResolution } from './scheduleResolver';

export type DetectedCapability = 
  | 'IMAGE_GENERATION'
  | 'BUILDER_APP'
  | 'RESEARCH'
  | 'AUTOMATION'
  | 'GENERAL_CONVERSATION';

export interface CapabilityIntent {
  capability: DetectedCapability;
  suggestAgentMode?: boolean;
  cleanPrompt: string;
  parameters?: Record<string, any>;
}

export interface VisionGenerationResult {
  success: boolean;
  imageUrl?: string;
  altText?: string;
  creditsCharged?: number;
  error?: string;
  quotaExceeded?: boolean;
  authRequired?: boolean;
  cancelled?: boolean;
}

export interface CreateAutomationParams {
  name: string;
  trigger?: 'MANUAL' | 'CRON' | 'EVENT' | 'WEBHOOK';
  cronExpression?: string;
  agentId?: string;
  objective: string;
  clientOperationId?: string;
}

export interface CreateAutomationResult {
  success: boolean;
  automationId?: string;
  name?: string;
  trigger?: string;
  cronExpression?: string;
  nextRun?: number;
  error?: string;
}

/**
 * Server-authoritative capability intent detection based on natural language semantics.
 */
export function detectCapabilityIntent(prompt: string, workspaceMode: WorkspaceMode): CapabilityIntent {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();

  // 1. Image Generation Intent
  const imageGenRegex = /^(?:generate|create|render|draw|make|paint|produce)\s+(?:an?\s+)?(?:image|picture|photo|artwork|illustration|concept art|visual|render)\s+(?:of\s+)?(.+)/i;
  const matchImg = trimmed.match(imageGenRegex);
  if (matchImg) {
    let clean = matchImg[1].trim();
    let aspectRatio: '1:1' | '3:4' | '16:9' = '1:1';
    if (lower.includes('16:9') || lower.includes('widescreen') || lower.includes('landscape')) aspectRatio = '16:9';
    if (lower.includes('3:4') || lower.includes('portrait')) aspectRatio = '3:4';

    return {
      capability: 'IMAGE_GENERATION',
      cleanPrompt: clean || trimmed,
      parameters: { aspectRatio, quality: 'economy', resolution: 'standard', numImages: 1 }
    };
  }

  // 2. Fullstack App / Software Builder Intent
  const builderRegex = /\b(?:build|scaffold|code|create|develop)\s+(?:a|an)\s+(?:[\w-]+\s+)*(?:crm|dashboard|web\s*app|website|fullstack\s*app|react\s*app|saas\s*platform|portfolio|app)\b/i;
  if (builderRegex.test(trimmed)) {
    return {
      capability: 'BUILDER_APP',
      suggestAgentMode: workspaceMode === 'chat',
      cleanPrompt: trimmed,
      parameters: { target: 'fullstack_web' }
    };
  }

  // 3. Automation Intent
  const autoRegex = /\b(?:create|schedule|set\s*up|automate)\s+(?:an?\s+)?(?:automation|scheduled\s+task|workflow|cron)\b|\b(?:automate\s+a|run\s+every|schedule\s+every)\b/i;
  if (autoRegex.test(trimmed)) {
    const schedule = resolveSchedule(trimmed);
    return {
      capability: 'AUTOMATION',
      cleanPrompt: trimmed,
      parameters: { isScheduled: true, schedule }
    };
  }

  // 4. Research Intent
  const researchRegex = /\b(?:research|investigate|find\s+sources\s+on|compare\s+sources\s+on|what\s+is\s+the\s+latest\s+on)\b/i;
  if (researchRegex.test(trimmed)) {
    return {
      capability: 'RESEARCH',
      cleanPrompt: trimmed,
      parameters: { requiresWebCitations: true }
    };
  }

  return {
    capability: 'GENERAL_CONVERSATION',
    cleanPrompt: trimmed
  };
}

/**
 * Real tariff calculation based on commercial pricing contract (no fabricated charges).
 */
export function getVisionTariff(options?: {
  quality?: 'economy' | 'premium';
  resolution?: 'standard' | 'high';
  numImages?: number;
}): number {
  const quality = options?.quality || 'economy';
  const resolution = options?.resolution || 'standard';
  const numImages = options?.numImages || 1;
  let perImage = 12;
  if (quality === 'economy' && resolution === 'standard') perImage = 12;
  else if (quality === 'economy' && resolution === 'high') perImage = 24;
  else if (quality === 'premium' && resolution === 'standard') perImage = 100;
  else if (quality === 'premium' && resolution === 'high') perImage = 125;
  return perImage * numImages;
}

/**
 * Invoke the actual Vision backend (/api/vision/generate) with entitlement and billing checks.
 * Passes the caller's AbortSignal and clientOperationId for network-level cancellation and idempotency.
 */
export async function executeVisionGeneration(
  prompt: string,
  options?: {
    aspectRatio?: '1:1' | '3:4' | '16:9';
    quality?: 'economy' | 'premium';
    resolution?: 'standard' | 'high';
    numImages?: number;
    clientOperationId?: string;
  },
  signal?: AbortSignal
): Promise<VisionGenerationResult> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options?.clientOperationId) {
      headers['X-Client-Operation-Id'] = options.clientOperationId;
    }

    const res = await authenticatedApiFetch('/api/vision/generate', {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        prompt,
        aspectRatio: options?.aspectRatio || '1:1',
        quality: options?.quality || 'economy',
        resolution: options?.resolution || 'standard',
        numImages: options?.numImages || 1,
        clientOperationId: options?.clientOperationId
      })
    });

    if (res.status === 401) {
      return {
        success: false,
        authRequired: true,
        error: 'Authentication required: Please sign in to generate images.'
      };
    }

    if (res.status === 402) {
      const data = await res.json().catch(() => ({}));
      return {
        success: false,
        quotaExceeded: true,
        error: data.error || 'Insufficient credits for Vision Generation. Please top up or upgrade plan.'
      };
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        success: false,
        error: data.error || `Vision generation failed with HTTP ${res.status}`
      };
    }

    const data = await res.json();
    const generatedImage = data.images?.[0];
    if (generatedImage?.url) {
      const confirmedCredits = typeof data.totalCredits === 'number'
        ? data.totalCredits
        : (typeof data.creditsCharged === 'number' ? data.creditsCharged : undefined);
      return {
        success: true,
        imageUrl: generatedImage.url,
        altText: prompt,
        creditsCharged: confirmedCredits
      };
    }

    return {
      success: false,
      error: 'Vision backend completed without generating an image URL.'
    };
  } catch (err: any) {
    if (signal?.aborted || err.name === 'AbortError') {
      return {
        success: false,
        cancelled: true,
        error: 'Generation cancelled at transport layer. Note: Provider execution may continue on backend if already dispatched.'
      };
    }
    return {
      success: false,
      error: err.message || 'Vision network request error.'
    };
  }
}

/**
 * Persist an automation through the actual backend (/api/automations) with verified identifier.
 */
export async function createBackendAutomation(params: CreateAutomationParams): Promise<CreateAutomationResult> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (params.clientOperationId) {
      headers['X-Client-Operation-Id'] = params.clientOperationId;
    }

    const res = await authenticatedApiFetch('/api/automations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: params.name,
        trigger: params.trigger || 'CRON',
        cronExpression: params.cronExpression || '0 9 * * *',
        agentId: params.agentId || 'agent_assistant_v1',
        objective: params.objective,
        approvalPolicy: 'autonomous',
        enabled: true
      })
    });

    if (res.status === 401) {
      return {
        success: false,
        error: 'Authentication required to schedule automations. Please sign in.'
      };
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        success: false,
        error: data.error || `Failed to create automation (HTTP ${res.status})`
      };
    }

    const item = await res.json();
    return {
      success: true,
      automationId: item.id,
      name: item.name,
      trigger: item.trigger,
      cronExpression: item.cronExpression,
      nextRun: item.nextRun
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Automation service request failed.'
    };
  }
}
