import crypto from 'crypto';
import {
  VisionGenerationParams,
  VisionUnderstandParams,
  VisionEditParams,
  calculateVisionTariff,
  VisionAspectRatio,
  VisionResolution
} from '../../../../packages/contracts/src/commercial.js';
import { commercialBillingService } from '../billing/commercial-billing-service.js';

export interface ImageDimension {
  width: number;
  height: number;
}

export function resolveImageDimensions(aspectRatio: VisionAspectRatio, resolution: VisionResolution): ImageDimension {
  if (aspectRatio === '1:1') {
    return resolution === 'high' ? { width: 1536, height: 1536 } : { width: 1024, height: 1024 };
  }
  if (aspectRatio === '3:4') {
    return resolution === 'high' ? { width: 1344, height: 1792 } : { width: 896, height: 1152 };
  }
  if (aspectRatio === '16:9') {
    return resolution === 'high' ? { width: 2048, height: 1152 } : { width: 1344, height: 768 };
  }
  return { width: 1024, height: 1024 };
}

export interface GeneratedImageResult {
  id: string;
  url: string;
  prompt: string;
  aspectRatio: VisionAspectRatio;
  width: number;
  height: number;
  quality: string;
  resolution: string;
  chargedCredits: number;
  provider: string;
  createdAt: number;
}

export class VisionProviderUnavailableError extends Error {
  readonly code = 'VISION_PROVIDER_NOT_READY';
  readonly statusCode = 503;
  readonly capability: 'understand' | 'generate' | 'edit';
  readonly provider: string | null;

  constructor(capability: 'understand' | 'generate' | 'edit', message?: string, provider: string | null = null) {
    super(message || `Vision ${capability} provider is not configured or unavailable.`);
    this.name = 'VisionProviderUnavailableError';
    this.capability = capability;
    this.provider = provider;
  }
}

export interface VisionProviderStatus {
  understand: {
    available: boolean;
    provider: 'nvidia' | 'gemini' | 'custom' | null;
    model: string | null;
  };
  generate: {
    available: boolean;
    provider: 'fal' | 'openai' | 'replicate' | 'custom' | null;
    model: string | null;
  };
  edit: {
    available: boolean;
    provider: 'openai' | 'fal' | 'custom' | null;
    model: string | null;
  };
}

export type CustomUnderstandProvider = (params: VisionUnderstandParams) => Promise<string>;
export type CustomGenerateProvider = (params: VisionGenerationParams, dimensions: ImageDimension) => Promise<Array<{ url: string; width?: number; height?: number }>>;
export type CustomEditProvider = (params: VisionEditParams, dimensions: ImageDimension) => Promise<{ url: string; width?: number; height?: number }>;

export interface CustomVisionProviders {
  understand?: CustomUnderstandProvider;
  generate?: CustomGenerateProvider;
  edit?: CustomEditProvider;
}

export class VisionService {
  private customProviders: CustomVisionProviders | null = null;

  setCustomProviders(providers: CustomVisionProviders | null): void {
    this.customProviders = providers;
  }

  getProviderStatus(): VisionProviderStatus {
    if (this.customProviders) {
      return {
        understand: {
          available: !!this.customProviders.understand || !!(process.env.NVIDIA_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim()),
          provider: this.customProviders.understand ? 'custom' : (process.env.NVIDIA_API_KEY?.trim() ? 'nvidia' : (process.env.GEMINI_API_KEY?.trim() ? 'gemini' : null)),
          model: this.customProviders.understand ? 'custom' : (process.env.NVIDIA_API_KEY?.trim() ? 'meta/llama-3.2-11b-vision-instruct' : (process.env.GEMINI_API_KEY?.trim() ? 'gemini-2.5-flash' : null))
        },
        generate: {
          available: !!this.customProviders.generate || !!(process.env.FAL_KEY?.trim() || process.env.FAL_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || process.env.REPLICATE_API_TOKEN?.trim()),
          provider: this.customProviders.generate ? 'custom' : (process.env.FAL_KEY?.trim() || process.env.FAL_API_KEY?.trim() ? 'fal' : (process.env.OPENAI_API_KEY?.trim() ? 'openai' : (process.env.REPLICATE_API_TOKEN?.trim() ? 'replicate' : null))),
          model: this.customProviders.generate ? 'custom' : (process.env.OPENAI_API_KEY?.trim() ? 'dall-e-3' : 'flux')
        },
        edit: {
          available: !!this.customProviders.edit || !!(process.env.OPENAI_API_KEY?.trim() || process.env.FAL_KEY?.trim() || process.env.FAL_API_KEY?.trim()),
          provider: this.customProviders.edit ? 'custom' : (process.env.OPENAI_API_KEY?.trim() ? 'openai' : (process.env.FAL_KEY?.trim() || process.env.FAL_API_KEY?.trim() ? 'fal' : null)),
          model: this.customProviders.edit ? 'custom' : 'image-edit'
        }
      };
    }

    let understandProvider: 'nvidia' | 'gemini' | null = null;
    let understandModel: string | null = null;
    if (process.env.NVIDIA_API_KEY && process.env.NVIDIA_API_KEY.trim()) {
      understandProvider = 'nvidia';
      understandModel = 'meta/llama-3.2-11b-vision-instruct';
    } else if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
      understandProvider = 'gemini';
      understandModel = 'gemini-2.5-flash';
    }

    let generateProvider: 'fal' | 'openai' | 'replicate' | null = null;
    let generateModel: string | null = null;
    if ((process.env.FAL_KEY && process.env.FAL_KEY.trim()) || (process.env.FAL_API_KEY && process.env.FAL_API_KEY.trim())) {
      generateProvider = 'fal';
      generateModel = 'flux';
    } else if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()) {
      generateProvider = 'openai';
      generateModel = 'dall-e-3';
    } else if (process.env.REPLICATE_API_TOKEN && process.env.REPLICATE_API_TOKEN.trim()) {
      generateProvider = 'replicate';
      generateModel = 'flux';
    }

    let editProvider: 'openai' | 'fal' | null = null;
    let editModel: string | null = null;
    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()) {
      editProvider = 'openai';
      editModel = 'dall-e-2';
    } else if ((process.env.FAL_KEY && process.env.FAL_KEY.trim()) || (process.env.FAL_API_KEY && process.env.FAL_API_KEY.trim())) {
      editProvider = 'fal';
      editModel = 'flux-edit';
    }

    return {
      understand: {
        available: !!understandProvider,
        provider: understandProvider,
        model: understandModel
      },
      generate: {
        available: !!generateProvider,
        provider: generateProvider,
        model: generateModel
      },
      edit: {
        available: !!editProvider,
        provider: editProvider,
        model: editModel
      }
    };
  }

  /**
   * Vision Understand: Visual Q&A, OCR, charts, diagrams.
   * Fails closed without settling credits if providers are unconfigured or fail.
   */
  async understand(principalId: string, params: VisionUnderstandParams): Promise<{ analysis: string; chargedCredits: number }> {
    const readiness = this.getProviderStatus();
    if (!readiness.understand.available) {
      throw new VisionProviderUnavailableError(
        'understand',
        'Vision understand provider is not configured. Multimodal visual analysis requires an active NVIDIA NIM (NVIDIA_API_KEY) or Google Gemini (GEMINI_API_KEY) key. Zero credits were debited.'
      );
    }

    const tariff = calculateVisionTariff('understand', {});
    const hold = await commercialBillingService.reserveCredits(
      principalId,
      tariff,
      'vision_understand',
      undefined,
      { prompt: params.prompt.slice(0, 100) }
    );

    try {
      let analysisResult = '';
      let usedProvider = readiness.understand.provider || 'unknown';

      if (this.customProviders?.understand) {
        analysisResult = await this.customProviders.understand(params);
        usedProvider = 'custom';
      } else {
        if (process.env.NVIDIA_API_KEY && process.env.NVIDIA_API_KEY.trim()) {
          const nvidiaKey = process.env.NVIDIA_API_KEY.trim();
          const url = 'https://integrate.api.nvidia.com/v1/chat/completions';
          const userContent: any[] = [{ type: 'text', text: params.prompt }];
          if (params.imageBase64) {
            userContent.push({
              type: 'image_url',
              image_url: { url: params.imageBase64 }
            });
          }

          try {
            const resp = await fetch(url, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${nvidiaKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                model: 'meta/llama-3.2-11b-vision-instruct',
                messages: [{ role: 'user', content: userContent }],
                max_tokens: 1024
              })
            });

            if (resp.ok) {
              const data = await resp.json();
              analysisResult = data.choices?.[0]?.message?.content || '';
              usedProvider = 'nvidia-llama-3.2-vision';
            }
          } catch (err) {
            console.warn('[VisionService] NVIDIA vision inference warning:', err);
          }
        }

        if (!analysisResult && process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
          const geminiKey = process.env.GEMINI_API_KEY.trim();
          const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
          
          const contents: any[] = [{
            role: 'user',
            parts: [{ text: params.prompt }]
          }];

          if (params.imageBase64) {
            const match = params.imageBase64.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
            const mimeType = match ? match[1] : 'image/jpeg';
            const data = match ? match[2] : params.imageBase64;
            contents[0].parts.push({
              inline_data: { mime_type: mimeType, data }
            });
          }

          try {
            const resp = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents })
            });

            if (resp.ok) {
              const data = await resp.json();
              analysisResult = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
              usedProvider = 'gemini-2.5-flash';
            }
          } catch (err) {
            console.warn('[VisionService] Gemini vision inference warning:', err);
          }
        }
      }

      // FAIL-CLOSED: Never synthesize placeholder analysis or settle credits if inference failed
      if (!analysisResult || !analysisResult.trim()) {
        await commercialBillingService.releaseReservation(hold.reservationId, 'Vision understand provider failed or returned empty result');
        throw new VisionProviderUnavailableError(
          'understand',
          'Vision understand provider failed to generate analysis. Zero credits were debited.',
          usedProvider
        );
      }

      await commercialBillingService.settleReservation(hold.reservationId, tariff, {
        task: 'understand',
        resultLength: analysisResult.length
      });

      await commercialBillingService.recordUsageEvent({
        principalId,
        taskType: 'vision_understand',
        provider: usedProvider,
        chargedCredits: tariff,
        imagesCount: 1,
        estimatedDirectCostUsd: 0.002
      });

      return { analysis: analysisResult, chargedCredits: tariff };
    } catch (err) {
      await commercialBillingService.releaseReservation(hold.reservationId, 'Vision understand failed').catch(() => {});
      throw err;
    }
  }

  /**
   * Vision Generate: 1 or 2 images, 1:1, 3:4, 16:9, Standard/High, Economy/Premium.
   * Fails closed without settling credits if providers are unconfigured or fail.
   * Never generates placeholder SVGs.
   */
  async generate(principalId: string, params: VisionGenerationParams): Promise<{ images: GeneratedImageResult[]; totalCredits: number }> {
    const readiness = this.getProviderStatus();
    if (!readiness.generate.available) {
      throw new VisionProviderUnavailableError(
        'generate',
        'Vision generation provider is not configured. Text-to-image synthesis requires an active provider key (FAL_KEY, REPLICATE_API_TOKEN, or OPENAI_API_KEY). Zero credits were charged.'
      );
    }

    const numImages = params.numImages || 1;
    const tariff = calculateVisionTariff('generate', {
      quality: params.quality,
      resolution: params.resolution,
      numImages
    });

    const hold = await commercialBillingService.reserveCredits(
      principalId,
      tariff,
      'vision_generate',
      undefined,
      { prompt: params.prompt.slice(0, 100), numImages }
    );

    try {
      const dimensions = resolveImageDimensions(params.aspectRatio, params.resolution);
      const results: GeneratedImageResult[] = [];
      const now = Date.now();
      let usedProvider = readiness.generate.provider || 'unknown';

      if (this.customProviders?.generate) {
        const rawImages = await this.customProviders.generate(params, dimensions);
        if (!rawImages || rawImages.length === 0) {
          throw new Error('Custom test provider returned 0 images');
        }
        for (const img of rawImages) {
          if (!img.url || img.url.startsWith('data:image/svg+xml')) {
            throw new Error('Provider returned invalid image URL or placeholder SVG');
          }
          results.push({
            id: `img_${crypto.randomUUID().replace(/-/g, '')}`,
            url: img.url,
            prompt: params.prompt,
            aspectRatio: params.aspectRatio,
            width: img.width || dimensions.width,
            height: img.height || dimensions.height,
            quality: params.quality,
            resolution: params.resolution,
            chargedCredits: tariff / rawImages.length,
            provider: 'custom',
            createdAt: now
          });
        }
        usedProvider = 'custom';
      } else {
        if ((process.env.FAL_KEY && process.env.FAL_KEY.trim()) || (process.env.FAL_API_KEY && process.env.FAL_API_KEY.trim())) {
          const falKey = (process.env.FAL_KEY || process.env.FAL_API_KEY)!.trim();
          const endpoint = params.quality === 'premium'
            ? 'https://fal.run/fal-ai/flux/dev'
            : 'https://fal.run/fal-ai/flux/schnell';
          usedProvider = params.quality === 'premium' ? 'fal-flux-dev' : 'fal-flux-schnell';

          const resp = await fetch(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Key ${falKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              prompt: params.prompt,
              image_size: { width: dimensions.width, height: dimensions.height },
              num_images: numImages,
              enable_safety_checker: true
            })
          });

          if (!resp.ok) {
            const errBody = await resp.text().catch(() => '');
            throw new Error(`Fal.ai provider returned HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
          }

          const data = await resp.json();
          const images = data.images || [];
          if (images.length === 0) {
            throw new Error('Fal.ai provider returned no images in payload');
          }

          for (const img of images) {
            if (!img.url || img.url.startsWith('data:image/svg+xml')) {
              throw new Error('Fal.ai returned invalid image URL');
            }
            results.push({
              id: `img_${crypto.randomUUID().replace(/-/g, '')}`,
              url: img.url,
              prompt: params.prompt,
              aspectRatio: params.aspectRatio,
              width: img.width || dimensions.width,
              height: img.height || dimensions.height,
              quality: params.quality,
              resolution: params.resolution,
              chargedCredits: tariff / images.length,
              provider: usedProvider,
              createdAt: now
            });
          }
        } else if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()) {
          const openaiKey = process.env.OPENAI_API_KEY.trim();
          usedProvider = 'openai-dall-e-3';

          const resp = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${openaiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'dall-e-3',
              prompt: params.prompt,
              n: 1,
              size: params.aspectRatio === '16:9' ? '1792x1024' : (params.aspectRatio === '3:4' ? '1024x1792' : '1024x1024'),
              quality: params.quality === 'premium' ? 'hd' : 'standard'
            })
          });

          if (!resp.ok) {
            const errBody = await resp.text().catch(() => '');
            throw new Error(`OpenAI provider returned HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
          }

          const data = await resp.json();
          const images = data.data || [];
          if (images.length === 0) {
            throw new Error('OpenAI provider returned no images in payload');
          }

          for (const img of images) {
            if (!img.url || img.url.startsWith('data:image/svg+xml')) {
              throw new Error('OpenAI returned invalid image URL');
            }
            results.push({
              id: `img_${crypto.randomUUID().replace(/-/g, '')}`,
              url: img.url,
              prompt: params.prompt,
              aspectRatio: params.aspectRatio,
              width: dimensions.width,
              height: dimensions.height,
              quality: params.quality,
              resolution: params.resolution,
              chargedCredits: tariff / images.length,
              provider: usedProvider,
              createdAt: now
            });
          }
        } else if (process.env.REPLICATE_API_TOKEN && process.env.REPLICATE_API_TOKEN.trim()) {
          const replicateToken = process.env.REPLICATE_API_TOKEN.trim();
          usedProvider = 'replicate-flux';
          const resp = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${replicateToken}`,
              'Content-Type': 'application/json',
              Prefer: 'wait'
            },
            body: JSON.stringify({
              input: {
                prompt: params.prompt,
                aspect_ratio: params.aspectRatio === '16:9' ? '16:9' : (params.aspectRatio === '3:4' ? '3:4' : '1:1')
              }
            })
          });

          if (!resp.ok) {
            const errBody = await resp.text().catch(() => '');
            throw new Error(`Replicate returned HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
          }

          const data = await resp.json();
          const output = data.output;
          const outputUrls = Array.isArray(output) ? output : (output ? [output] : []);
          if (outputUrls.length === 0) {
            throw new Error('Replicate returned no image output');
          }

          for (const url of outputUrls) {
            results.push({
              id: `img_${crypto.randomUUID().replace(/-/g, '')}`,
              url,
              prompt: params.prompt,
              aspectRatio: params.aspectRatio,
              width: dimensions.width,
              height: dimensions.height,
              quality: params.quality,
              resolution: params.resolution,
              chargedCredits: tariff / outputUrls.length,
              provider: usedProvider,
              createdAt: now
            });
          }
        }
      }

      if (results.length === 0) {
        await commercialBillingService.releaseReservation(hold.reservationId, 'Vision generation provider returned 0 valid images');
        throw new VisionProviderUnavailableError('generate', 'Upstream image generation provider failed to produce output. Zero credits were debited.');
      }

      for (const res of results) {
        if (!res.url || res.url.startsWith('data:image/svg+xml') || res.url.includes('<svg')) {
          await commercialBillingService.releaseReservation(hold.reservationId, 'Invalid image payload (placeholder rejected)');
          throw new VisionProviderUnavailableError('generate', 'Provider produced an invalid or placeholder image format. Zero credits were debited.');
        }
      }

      await commercialBillingService.settleReservation(hold.reservationId, tariff, {
        task: 'generate',
        imagesCount: results.length,
        aspectRatio: params.aspectRatio,
        quality: params.quality
      });

      await commercialBillingService.recordUsageEvent({
        principalId,
        taskType: 'vision_generate',
        provider: usedProvider,
        imagesCount: results.length,
        chargedCredits: tariff,
        estimatedDirectCostUsd: (tariff * 0.001) / 3
      });

      return { images: results, totalCredits: tariff };
    } catch (err: any) {
      await commercialBillingService.releaseReservation(hold.reservationId, `Vision generation failed: ${err.message}`).catch(() => {});
      if (err instanceof VisionProviderUnavailableError) {
        throw err;
      }
      throw new VisionProviderUnavailableError('generate', `Vision generation failed: ${err.message}. Zero credits were charged.`, readiness.generate.provider);
    }
  }

  /**
   * Vision Edit: Inpainting, style modifications, image variations.
   * Fails closed without settling credits if providers are unconfigured or fail.
   * Never generates placeholder SVGs.
   */
  async edit(principalId: string, params: VisionEditParams): Promise<{ image: GeneratedImageResult; chargedCredits: number }> {
    const readiness = this.getProviderStatus();
    if (!readiness.edit.available) {
      throw new VisionProviderUnavailableError(
        'edit',
        'Vision edit provider is not configured. Image editing requires an active provider key. Zero credits were charged.'
      );
    }

    const tariff = calculateVisionTariff('edit', {
      quality: params.quality,
      resolution: params.resolution,
      advancedMode: params.advancedMode
    });

    const hold = await commercialBillingService.reserveCredits(
      principalId,
      tariff,
      'vision_edit',
      undefined,
      { prompt: params.prompt.slice(0, 100), advancedMode: params.advancedMode }
    );

    try {
      const dimensions = resolveImageDimensions('1:1', params.resolution);
      const now = Date.now();
      let usedProvider = readiness.edit.provider || 'unknown';
      let editedUrl = '';

      if (this.customProviders?.edit) {
        const res = await this.customProviders.edit(params, dimensions);
        editedUrl = res.url;
        usedProvider = 'custom';
      } else {
        if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()) {
          throw new Error('Live OpenAI image editing requires multipart source buffer configuration');
        } else if ((process.env.FAL_KEY && process.env.FAL_KEY.trim()) || (process.env.FAL_API_KEY && process.env.FAL_API_KEY.trim())) {
          throw new Error('Live Fal image editing requires image-to-image pipeline configuration');
        }
      }

      if (!editedUrl || editedUrl.startsWith('data:image/svg+xml') || editedUrl.includes('<svg')) {
        await commercialBillingService.releaseReservation(hold.reservationId, 'Vision edit provider returned invalid or placeholder image');
        throw new VisionProviderUnavailableError('edit', 'Vision edit provider returned an invalid image format. Zero credits were debited.');
      }

      const imageResult: GeneratedImageResult = {
        id: `edit_${crypto.randomUUID().replace(/-/g, '')}`,
        url: editedUrl,
        prompt: params.prompt,
        aspectRatio: '1:1',
        width: dimensions.width,
        height: dimensions.height,
        quality: params.quality,
        resolution: params.resolution,
        chargedCredits: tariff,
        provider: usedProvider,
        createdAt: now
      };

      await commercialBillingService.settleReservation(hold.reservationId, tariff, {
        task: 'edit',
        advancedMode: params.advancedMode
      });

      await commercialBillingService.recordUsageEvent({
        principalId,
        taskType: 'vision_edit',
        provider: usedProvider,
        imagesCount: 1,
        chargedCredits: tariff,
        estimatedDirectCostUsd: (tariff * 0.001) / 3
      });

      return { image: imageResult, chargedCredits: tariff };
    } catch (err: any) {
      await commercialBillingService.releaseReservation(hold.reservationId, `Vision edit failed: ${err.message}`).catch(() => {});
      if (err instanceof VisionProviderUnavailableError) {
        throw err;
      }
      throw new VisionProviderUnavailableError('edit', `Vision edit failed: ${err.message}. Zero credits were charged.`, readiness.edit.provider);
    }
  }
}

export const visionService = new VisionService();

