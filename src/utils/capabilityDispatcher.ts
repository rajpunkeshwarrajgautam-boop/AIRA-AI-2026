import type { WorkspaceMode } from '../types';
import { authenticatedApiFetch } from '../lib/neonAuth';

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
      parameters: { aspectRatio, quality: 'economy', numImages: 1 }
    };
  }

  // 2. Fullstack App / Software Builder Intent
  const builderRegex = /\b(?:build|scaffold|code|create|develop)\s+(?:a|an)\s+(?:crm|dashboard|web\s*app|website|fullstack\s*app|react\s*app|saas\s*platform)\b/i;
  if (builderRegex.test(trimmed)) {
    return {
      capability: 'BUILDER_APP',
      suggestAgentMode: workspaceMode === 'chat',
      cleanPrompt: trimmed,
      parameters: { target: 'fullstack_web' }
    };
  }

  // 3. Automation Intent
  const autoRegex = /\b(?:create|schedule|set\s*up)\s+(?:an?\s+)?automation\b|\brun\s+every\s+(?:monday|day|hour|week|morning)\b/i;
  if (autoRegex.test(trimmed)) {
    return {
      capability: 'AUTOMATION',
      cleanPrompt: trimmed,
      parameters: { isScheduled: true }
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
 * Invoke the actual Vision backend (/api/vision/generate) with entitlement and billing checks.
 */
export async function executeVisionGeneration(
  prompt: string,
  options?: { aspectRatio?: '1:1' | '3:4' | '16:9'; quality?: 'economy' | 'premium' }
): Promise<VisionGenerationResult> {
  try {
    const res = await authenticatedApiFetch('/api/vision/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        aspectRatio: options?.aspectRatio || '1:1',
        quality: options?.quality || 'economy',
        resolution: 'standard',
        numImages: 1
      })
    });

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
      return {
        success: true,
        imageUrl: generatedImage.url,
        altText: prompt,
        creditsCharged: data.creditsCharged || 0
      };
    }

    return {
      success: false,
      error: 'Vision backend completed without generating an image URL.'
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Vision network request error.'
    };
  }
}
