import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolDefinitionSchema, type ToolCall, type ToolResult } from '../packages/contracts/src/index.js';
import { FileSystemAdapter } from '../packages/tool-runtime/src/adapters/file-adapter.js';
import { validateModelMission, signModelMission, validateStoredModelMission, type ModelMissionProgress } from '../packages/agent-runtime/src/model-mission.js';
import { verifyFinalMissionOutcome } from '../packages/agent-runtime/src/independent-outcome.js';

const scopes = ['files.read', 'repo.read'];
const definitions = [
  ['file_system_read','files.read','READ'],
  ['file_system_list','files.read','READ'],
  ['repo_git_status','repo.read','READ'],
  ['repo_git_log','repo.read','READ'],
  ['file_system_write','files.write','WRITE']
].map(([name, scope, level]) => ToolDefinitionSchema.parse({
  id: name, name, description: name, source: 'native', parameters: {},
  permissionLevel: level, executionRuntime: 'LOCAL', permissionScopes: [scope],
  sideEffectLevel: level, availability: 'READY'
}));
const objective = 'Read package.json and README.md and compare both files';
const raw = {
  version: 2, objective, steps: [
    {id:'first',purpose:'Read the first requested file',toolName:'file_system_read',
      arguments:{filePath:'package.json'},dependsOn:[],specialist:'files'},
    {id:'second',purpose:'Read the second requested file',toolName:'file_system_read',
      arguments:{filePath:'README.md'},dependsOn:['first'],specialist:'files'}
  ]
};
const plan = validateModelMission(objective, raw, definitions, scopes);
const key = 'integration-test-only-signing-secret-32chars';
const progress: ModelMissionProgress = {
  version: 2, plan, dispatched: 1, verified: [], currentCallId: 'call_1',
  planSignature: signModelMission(objective,plan,key)
};
assert.equal(validateStoredModelMission(objective,progress,key,definitions,scopes),true);
const shuffled = JSON.parse(JSON.stringify(progress));
shuffled.plan = { steps: shuffled.plan.steps, objective: shuffled.plan.objective, version: 2 };
shuffled.plan.steps[0] = {
  specialist:'files', dependsOn:[], arguments:{filePath:'package.json'},
  toolName:'file_system_read', purpose:'Read the first requested file', id:'first'
};
assert.equal(validateStoredModelMission(objective,shuffled,key,definitions,scopes),true,
  'JSONB key reordering must not break signatures');
const tampered = structuredClone(progress);
tampered.plan.steps[0].arguments = {filePath:'secrets.txt'};
assert.equal(validateStoredModelMission(objective,tampered,key,definitions,scopes),false);
assert.throws(()=>validateModelMission(objective,
  {...raw,steps:[raw.steps[1],raw.steps[0]]},definitions,scopes),/DEPENDENCY/);
assert.throws(()=>validateModelMission(objective,
  {...raw,steps:[{...raw.steps[0],toolName:'file_system_write',arguments:{filePath:'README.md',content:'bad'}}]},
  definitions,scopes));
assert.throws(()=>validateModelMission(objective,
  {...raw,steps:[{...raw.steps[0],arguments:{filePath:'secrets.json'}}]},definitions,scopes),
  /FILE_TARGET/);
assert.throws(()=>validateModelMission('Delete package.json',
  {...raw,objective:'Delete package.json'},definitions,scopes),/WRITE_NOT_CERTIFIED/);
assert.throws(()=>validateModelMission(objective,raw,definitions,[]),/SCOPE_DENIED/);

const root=fs.mkdtempSync(path.join(os.tmpdir(),'aira-v2-'));
const sibling=root+'-sibling';
fs.mkdirSync(sibling);
fs.writeFileSync(path.join(sibling,'private.txt'),'not for AIRA');
fs.writeFileSync(path.join(root,'README.md'),'file contents');
const adapter=new FileSystemAdapter(root);
const expected=await adapter.read('README.md');
assert.equal(expected.content,'file contents');
await assert.rejects(adapter.read('../'+path.basename(sibling)+'/private.txt'),/SECURITY_REJECTED/,
  'Sibling-prefix traversal must be blocked');
await assert.rejects(adapter.write('../'+path.basename(sibling)+'/bad.txt','unsafe'),/SECURITY_REJECTED/);
fs.symlinkSync(sibling,path.join(root,'linked'),'dir');
await assert.rejects(adapter.read('linked/private.txt'),/SECURITY_REJECTED/,
  'Symlinked parent must not escape');
await assert.rejects(adapter.write('linked/new.txt','unsafe'),/SECURITY_REJECTED/);
const call: ToolCall={
  id:'call_first',name:'file_system_read',toolId:'tool_fs_read',
  arguments:{filePath:'README.md'},timestamp:Date.now()
};
const result: ToolResult={
  toolCallId:'call_first',output:expected,isError:false,durationMs:1,
  timestamp:Date.now(),artifacts:[]
};
const step={id:'first',purpose:'Read the requested file',
  toolName:'file_system_read' as const,arguments:{filePath:'README.md'}};
let checked=await verifyFinalMissionOutcome([step],[call],[result],root);
assert.equal(checked.status,'COMPLETED_VERIFIED','Independent readback must certify actual file');
fs.writeFileSync(path.join(root,'README.md'),'tampered');
checked=await verifyFinalMissionOutcome([step],[call],[result],root);
assert.equal(checked.status,'FAILED_VERIFICATION','Fabricated or outdated tool output must fail');
checked=await verifyFinalMissionOutcome([step],[call],[],root);
assert.equal(checked.status,'FAILED_VERIFICATION','Missing tool execution must fail');

fs.rmSync(root,{recursive:true,force:true}); fs.rmSync(sibling,{recursive:true,force:true});
console.log('PASS: V2 model-plan policy, signed persistence, filesystem containment and independent readback');
