
import assert from 'node:assert/strict';

import { CapabilityRegistry } from './packages/agent-runtime/src/registry.js';
import { ServerIntentRouter } from './packages/agent-runtime/src/router.js';

async function main() {
  const router = new ServerIntentRouter(
    new CapabilityRegistry()
  );

  const principal = {
    userId: 'usr_test',
    sessionId: 'session_route_test',
    roles: ['USER'],
    scopes: ['agent:run']
  };

  const prompt =
    'What is the current box office collection for latest movie?';

  // TEST 1: Explicit Research Mode
  const explicit = await router.route({
    prompt,
    advisoryIntent: 'RESEARCH',
    principal
  });

  console.log('EXPLICIT RESEARCH:', explicit);

  assert.equal(explicit.intent, 'RESEARCH');
  assert.equal(explicit.executionTarget, 'RESEARCH_SYNTHESIS');
  assert.equal(explicit.sideEffectLevel, 'READ');
  assert.equal(explicit.approvalRequired, false);

  // TEST 2: Automatic Research Detection
  const automatic = await router.route({
    prompt,
    principal
  });

  console.log('AUTOMATIC ROUTING:', automatic);

  if (automatic.intent !== 'RESEARCH') {
    console.error(
      'REGRESSION: Current-information request did not route to RESEARCH.'
    );
    process.exitCode = 1;
  } else {
    console.log(
      'PASS: AIRA correctly detected that current box office data requires research.'
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
