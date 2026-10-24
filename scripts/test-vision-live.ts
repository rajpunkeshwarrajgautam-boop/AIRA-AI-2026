import 'dotenv/config';
import { visionService } from '../apps/api/src/vision/vision-service.js';
import { commercialBillingService } from '../apps/api/src/billing/commercial-billing-service.js';

async function main() {
  const principalId = 'test_principal_vision_' + Date.now();
  console.log(`[1/3] Initializing test wallet for ${principalId}...`);
  const initialEntitlements = await commercialBillingService.getEntitlements(principalId);
  console.log(`  Initial credits: ${initialEntitlements.creditBalance}`);

  const samplePngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  console.log('[2/3] Calling visionService.understand with live NVIDIA NIM Llama 3.2 vision...');
  const res = await visionService.understand(principalId, {
    prompt: 'What color is this single pixel? Describe in under 10 words.',
    imageBase64: samplePngBase64
  });

  console.log('[3/3] Vision understand completed successfully:');
  console.log('  Charged credits:', res.chargedCredits);
  console.log('  Model analysis:', res.analysis);

  const updatedEntitlements = await commercialBillingService.getEntitlements(principalId);
  console.log(`  Post-call wallet balance: ${updatedEntitlements.creditBalance} (debited ${initialEntitlements.creditBalance - updatedEntitlements.creditBalance})`);

  process.exit(0);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
