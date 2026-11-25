#!/usr/bin/env node
/**
 * Cashfree Recurring Plan Operator CLI
 *
 * Provides safe, audited, idempotent operator provisioning for Cashfree recurring plans (Plus ₹399/mo and Pro ₹999/mo).
 *
 * Usage:
 *   npx tsx scripts/provision-cashfree-plans.ts --audit
 *   npx tsx scripts/provision-cashfree-plans.ts --authorize [--env TEST|PROD] [--tier plus|pro|all]
 */

import {
  cashfreePlanProvisioningService,
  getAuthoritativeCashfreeSpec,
  CashfreeCredentials
} from '../apps/api/src/billing/cashfree-plan-provisioning-service.js';

interface CliArgs {
  audit: boolean;
  authorize: boolean;
  env?: 'TEST' | 'PROD';
  tier?: 'plus' | 'pro' | 'all';
  help: boolean;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    audit: false,
    authorize: false,
    tier: 'all',
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--audit') {
      result.audit = true;
    } else if (arg === '--authorize') {
      result.authorize = true;
    } else if (arg === '--env') {
      const val = (args[++i] || '').toUpperCase();
      if (val === 'TEST' || val === 'PROD') {
        result.env = val;
      }
    } else if (arg === '--tier') {
      const val = (args[++i] || '').toLowerCase();
      if (val === 'plus' || val === 'pro' || val === 'all') {
        result.tier = val as any;
      }
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    }
  }

  return result;
}

function printUsage(): void {
  console.log(`
Cashfree Recurring Plan Provisioning CLI

Usage:
  npx tsx scripts/provision-cashfree-plans.ts [options]

Options:
  --audit             Read-only audit: checks whether Plus and Pro plans exist on Cashfree and verifies their terms.
  --authorize         Operator authorization flag: required to permit provider-side plan creation for missing plans.
  --env <TEST|PROD>   Target environment (defaults to CASHFREE_ENV or TEST).
  --tier <plus|pro>   Specific tier to inspect or provision (defaults to all).
  --help, -h          Show this help message.

Safety Invariants:
  - Without --authorize, the tool runs in strict read-only mode and refuses to mutate provider state.
  - Plans with conflicting terms are strictly rejected and never overwritten.
  - Existing matching plans are verified and left unchanged (idempotent).
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!args.audit && !args.authorize) {
    console.error('ERROR: You must specify either --audit (read-only inspection) or --authorize (operator-approved provisioning).');
    printUsage();
    process.exit(1);
  }

  let creds: CashfreeCredentials;
  try {
    creds = cashfreePlanProvisioningService.resolveCredentials(args.env ? { env: args.env } : undefined);
  } catch (err: any) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }

  // Hard production isolation barrier: production plan mutations can never be triggered from non-production runtime
  if (args.authorize && creds.env === 'PROD' && process.env.AIRA_ENVIRONMENT !== 'production') {
    console.error('ERROR: Refusing production plan provisioning from non-production runtime environment (AIRA_ENVIRONMENT !== production).');
    process.exit(1);
  }

  console.log('='.repeat(70));
  console.log('AIRA 2026 - Cashfree Recurring Plan Operator Provisioning Tool');
  console.log('='.repeat(70));
  console.log(`Environment : ${creds.env}`);
  console.log(`App ID      : ${creds.appId.slice(0, 8)}...`);
  console.log(`Mode        : ${args.authorize ? 'OPERATOR AUTHORIZED (Mutation Enabled)' : 'READ-ONLY AUDIT'}`);
  console.log(`Base URL    : ${cashfreePlanProvisioningService.getBaseUrl(creds.env)}`);
  console.log('-'.repeat(70));

  const tiers: ('plus' | 'pro')[] = args.tier === 'plus' ? ['plus'] : (args.tier === 'pro' ? ['pro'] : ['plus', 'pro']);
  let allHealthy = true;

  for (const tier of tiers) {
    const spec = getAuthoritativeCashfreeSpec(tier);
    console.log(`\nInspecting Plan: ${spec.planName} (${spec.planId})`);
    console.log(`  Expected terms: ₹${spec.recurringAmount}/mo, ${spec.currency}, ${spec.intervalType} x ${spec.intervals}`);

    try {
      const lookup = await cashfreePlanProvisioningService.fetchPlan(spec.planId, creds);

      if (lookup.exists && lookup.plan) {
        const verification = cashfreePlanProvisioningService.verifyPlanTerms(lookup.plan, spec);
        if (verification.isValid) {
          console.log(`  [OK] Plan exists on Cashfree and terms match specification.`);
        } else {
          allHealthy = false;
          console.error(`  [TERMS_MISMATCH] Plan exists but terms conflict:`);
          for (const m of verification.mismatches || []) {
            console.error(`    - ${m}`);
          }
          console.error(`  REFUSING to overwrite existing plan. Operator investigation required.`);
        }
      } else {
        console.log(`  [MISSING] Plan does not exist on Cashfree ${creds.env}.`);
        if (args.authorize) {
          console.log(`  Attempting operator-authorized provisioning...`);
          const provisionResult = await cashfreePlanProvisioningService.provisionPlan(spec, {
            operatorAuthorized: true,
            credentials: creds
          });
          console.log(`  [SUCCESS] Plan ${provisionResult.planId} provisioned with status: ${provisionResult.status}`);
        } else {
          allHealthy = false;
          console.log(`  To provision this plan, run with --authorize:`);
          console.log(`    npx tsx scripts/provision-cashfree-plans.ts --authorize --env ${creds.env} --tier ${tier}`);
        }
      }
    } catch (err: any) {
      allHealthy = false;
      console.error(`  [ERROR] Inspection failed for ${spec.planId}: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(70));
  if (allHealthy) {
    console.log('SUMMARY: All inspected Cashfree recurring plans are verified and healthy.');
    console.log('='.repeat(70));
    process.exit(0);
  } else {
    console.error('SUMMARY: One or more plans require operator attention or provisioning.');
    console.log('='.repeat(70));
    process.exit(1);
  }
}

main().catch((err: any) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
