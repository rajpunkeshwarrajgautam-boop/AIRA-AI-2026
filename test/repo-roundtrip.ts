// Repository roundtrip test: validates all required fields exist and sequences are monotonically increasing
import { pathToFileURL } from 'url';
import path from 'path';

const runId = process.argv[2];
if (!runId) {
  console.error('FAIL: No run ID provided');
  process.exit(1);
}

async function run() {
  const repoModule = await import(
    pathToFileURL(path.resolve('./packages/agent-runtime/src/repositories.ts')).href as string
  );
  const repo = new (repoModule as any).PostgresRunRepository();
  const events: any[] = await repo.getRunEvents(runId);

  if (events.length === 0) {
    console.error('FAIL: no events returned');
    process.exit(1);
  }

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e.eventId) { console.error(`FAIL: missing eventId at index ${i}`); process.exit(1); }
    if (!e.runId) { console.error(`FAIL: missing runId at index ${i}`); process.exit(1); }
    if (e.sequence === undefined || e.sequence === null) { console.error(`FAIL: missing sequence at index ${i}`); process.exit(1); }
    if (!e.type) { console.error(`FAIL: missing type at index ${i}`); process.exit(1); }
    if (!e.timestamp) { console.error(`FAIL: missing timestamp at index ${i}`); process.exit(1); }
    if (e.data === undefined) { console.error(`FAIL: missing data at index ${i}`); process.exit(1); }
    if (i > 0 && events[i].sequence <= events[i - 1].sequence) {
      console.error(`FAIL: sequences not strictly increasing at index ${i}: ${events[i].sequence} vs ${events[i - 1].sequence}`);
      process.exit(1);
    }
  }

  console.log(`PASS: roundtrip OK, events=${events.length}, seqs=${events.map((e: any) => e.sequence).join(',')}`);
  process.exit(0);
}

run().catch((err: any) => {
  console.error('FAIL:', err);
  process.exit(1);
});
