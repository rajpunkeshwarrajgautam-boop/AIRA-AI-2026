import { db, closeDb } from '../packages/db/src/index.js';

async function verifyDurability() {
  console.log('--- VERIFYING REAL PREVIEW RUN DURABILITY IN NEON ---');
  
  // Find the latest completed runs
  const runs = await db('runs')
    .select('*')
    .where('state', 'COMPLETED')
    .orderBy('createdAt', 'desc')
    .limit(3);

  if (runs.length === 0) {
    throw new Error('No completed runs found in database!');
  }

  const latestRun = runs[0];
  console.log('\n1. Run record in DB:');
  console.log(`- ID: ${latestRun.id}`);
  console.log(`- State: ${latestRun.state}`);
  console.log(`- Execution Checkpoint: ${latestRun.executionCheckpoint}`);
  console.log(`- Assistant Content: "${latestRun.content?.slice(0, 100)}..."`);
  console.log(`- Created At: ${latestRun.createdAt}`);

  // Fetch events for this run
  const events = await db('run_events')
    .select('*')
    .where('run_id', latestRun.id)
    .orderBy('sequence', 'asc');

  console.log(`\n2. Stored events for run (${events.length} total events):`);
  for (const evt of events) {
    console.log(`- Seq ${evt.sequence}: ${evt.type}`);
  }

  const eventTypes = events.map(e => e.type);
  console.log('\n3. Durability Verification Checks:');
  console.log(`- run exists: YES`);
  console.log(`- run state = COMPLETED: ${latestRun.state === 'COMPLETED' ? 'YES' : 'NO'}`);
  console.log(`- final assistant content exists: ${latestRun.content ? 'YES' : 'NO'}`);
  console.log(`- run.created exists: ${eventTypes.includes('run.created') ? 'YES' : 'NO'}`);
  console.log(`- routing.decision exists: ${eventTypes.includes('routing.decision') ? 'YES' : 'NO'}`);
  console.log(`- model.provenance exists: ${eventTypes.includes('model.provenance') ? 'YES' : 'NO'}`);
  console.log(`- run.completed exists: ${eventTypes.includes('run.completed') ? 'YES' : 'NO'}`);
  
  // Check sequence order and no duplicates
  const sequences = events.map(e => Number(e.sequence));
  const hasDupes = new Set(sequences).size !== sequences.length;
  console.log(`- correct event order (monotonically increasing): ${sequences.every((val, i, arr) => i === 0 || val > arr[i - 1]) ? 'YES' : 'NO'}`);
  console.log(`- no duplicate sequences: ${!hasDupes ? 'YES' : 'NO'}`);

  await closeDb();
}

verifyDurability().catch(err => {
  console.error(err);
  closeDb().catch(() => {});
  process.exit(1);
});
