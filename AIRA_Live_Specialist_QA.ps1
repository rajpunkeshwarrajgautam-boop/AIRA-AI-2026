# AIRA AI 2026 — local QA only. No production credentials or changes.
# Run from the AIRA-AI-2026-WORKER-QA checkout using the PowerShell session
# in which NVIDIA_API_KEY was configured.
$ErrorActionPreference = 'Stop'
if (-not $env:NVIDIA_API_KEY) { throw 'NVIDIA_API_KEY is not set in this PowerShell process.' }
if (-not (Test-Path 'packages/agent-runtime/src/index.ts')) { throw 'Run from AIRA-AI-2026-WORKER-QA repository root.' }
if (-not (Test-Path 'node_modules')) { throw 'Run npm ci first.' }
if ((git rev-parse HEAD).Trim() -ne 'b92d50596e6a57d1d68fde78335042ecf60fe7b1') {
    throw 'Unexpected revision. This QA script targets PR #72 at b92d505.'
}
$qaId = [guid]::NewGuid().ToString('N').Substring(0, 8)
$pgName = "aira-live-qa-$qaId"
$pgPassword = 'qa' + [guid]::NewGuid().ToString('N')
$seedFile = Join-Path $PWD.Path "aira-live-seed-$qaId.ts"
$verifyFile = Join-Path $PWD.Path "aira-live-verify-$qaId.ts"
$stdoutLog = Join-Path $env:TEMP "aira-specialist-$qaId.stdout.log"
$stderrLog = Join-Path $env:TEMP "aira-specialist-$qaId.stderr.log"
$worker = $null
$dbStarted = $false
$testSucceeded = $false
$previous = @{}
foreach ($name in @('DATABASE_URL','AIRA_AGENT_PLAN_SIGNING_KEY','AIRA_SPECIALIST_WORKER_ENABLED','AIRA_SPECIALIST_DELEGATION_ENABLED','AIRA_SPECIALIST_WORKER_PROCESS','AIRA_MODEL_MISSIONS_ENABLED','NODE_ENV','VERCEL','AIRA_ALLOW_MOCK','QA_DELEGATION_ID','QA_CHILD_ID','QA_OWNER_ID')) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$seedSource = @'
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {db,runMigrations,closeDb} from './packages/db/src/index.js';
import {RunSchema} from './packages/contracts/src/index.js';
import {ModelRouter} from './packages/model-router/src/index.js';
import {ToolRegistry,ToolGateway,PostgresToolCallRepository} from './packages/tool-runtime/src/index.js';
import {ApprovalKernel} from './packages/approvals/src/index.js';
import {PostgresApprovalRepository,PostgresSessionGrantRepository} from './packages/approvals/src/repositories.js';
import {BrainV2KnowledgeEngine} from './packages/knowledge/src/index.js';
import {PostgresRunRepository} from './packages/agent-runtime/src/repositories.js';
import {AgentRuntime} from './packages/agent-runtime/src/index.js';

await runMigrations();
const model = new ModelRouter();
const approval = new ApprovalKernel(new PostgresApprovalRepository(),new PostgresSessionGrantRepository());
const toolGateway = new ToolGateway(new PostgresToolCallRepository(),approval,process.cwd());
const repo = new PostgresRunRepository();
const runtime = new AgentRuntime(model,new ToolRegistry(process.cwd()),approval,
    new BrainV2KnowledgeEngine(),repo,process.cwd(),
    undefined,undefined,undefined,undefined,undefined,toolGateway);
try {
  assert.deepEqual(model.listProviders(),['nvidia']);
  const principal={userId:'localqa_owner_'+randomUUID(),sessionId:'localqa_session_'+randomUUID(),scopes:['repo.read']};
  const now=Date.now();
  // A QA-only synthetic parent. This is deliberately NOT a certification of HTTP authentication.
  const parent=RunSchema.parse({
    id:'run_qa_'+randomUUID(),principalId:principal.userId,
    principalScopes:principal.scopes,sessionId:principal.sessionId,
    modelPolicy:model.resolvePolicy('nvidia/nemotron-3-super-120b-a12b'),
    prompt:'Local QA parent authorizing read-only repository inspection',
    intent:'AGENT_MISSION',state:'QUEUED',createdAt:now,updatedAt:now
  });
  await repo.saveRun(parent);
  const objective='Perform a read-only agent mission to inspect the git repository status and identify the current branch and HEAD revision SHA using observable evidence.';
  const delegation=await runtime.delegateSpecialist(parent.id,'repository',objective,['repo.read'],principal);
  const child=await repo.getRun(delegation.childRunId);
  assert.ok(child,'Durable child is missing');
  assert.equal(delegation.status,'QUEUED');
  assert.equal(child.state,'QUEUED');
  assert.equal(child.provenance?.provider,'nvidia');
  assert.equal(child.intent,'AGENT_MISSION','Child was not routed as a model-generated AGENT_MISSION');
  assert.notEqual(child.routingDecision?.executionTarget,'CAPABILITY_NOT_READY');
  console.log('QA_SEED_JSON:'+JSON.stringify({owner:principal.userId,delegationId:delegation.id,childRunId:child.id,childIntent:child.intent}));
} finally {
  await toolGateway.shutdown();
  await closeDb();
}
'@

$verifySource = @'
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {db,closeDb} from './packages/db/src/index.js';
import {PostgresRunRepository} from './packages/agent-runtime/src/repositories.js';
import {DurableDelegations} from './packages/agent-runtime/src/specialist-delegation.js';
const runRepo = new PostgresRunRepository();
const delegationRepo = new DurableDelegations();
try {
  const deadline=Date.now()+180000;
  let child,delegation;
  while(Date.now()<deadline){
    child=await runRepo.getRun(process.env.QA_CHILD_ID!);
    delegation=await delegationRepo.get(process.env.QA_OWNER_ID!,process.env.QA_DELEGATION_ID!);
    if(!child||!delegation)throw new Error('QA_RUN_OR_DELEGATION_MISSING');
    if(['COMPLETED','FAILED','CANCELLED'].includes(delegation.status))break;
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
  if(!child||!delegation)throw new Error('MISSING_DURABLE_RESULT');
  console.log('Child state:',child.state);
  console.log('Delegation status:',delegation.status);
  console.log('Tool calls:',child.toolCalls?.map(c=>c.name).join(', ')||'(none)');
  if(child.state!=='COMPLETED'||delegation.status!=='COMPLETED'){
    throw new Error('CHILD_NOT_COMPLETED: '+String(child.error||'timeout or pending'));
  }
  const progress=child.context?.__airaMissionV1;
  assert.equal(progress?.version,2,'A genuine model-generated V2 plan is required');
  assert.ok(progress.plan?.steps?.length>0,'No signed plan steps');
  assert.ok(progress.plan.steps.every(s=>s.toolName==='repo_git_status'),'Unexpected tool in mission');
  assert.ok(child.toolCalls.length>0,'No tool calls');
  assert.ok(child.toolResults.length>0,'No persisted tool output');
  const expectedSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const actual=child.toolResults.find(result=>result.output?.headSha===expectedSha&&!result.isError);
  assert.ok(actual,'Persisted tool output must independently match current Git HEAD');
  const verification=await delegationRepo.verification(process.env.QA_OWNER_ID!,process.env.QA_DELEGATION_ID!);
  assert.equal(verification.status,'COMPLETED_VERIFIED','Final independent outcome verification missing');
  assert.equal(child.provenance?.provider,'nvidia');
  assert.equal(child.provenance?.verified,true,'Upstream model identity unverified');
  console.log('Actual HEAD SHA:',actual.output.headSha);
  console.log('Verified steps:',verification.verifiedSteps);
  console.log('Model:',child.provenance?.executedModel);
  console.log('AIRA REAL DEDICATED SPECIALIST WORKER: PASS');
} catch(error:any){
  console.error('AIRA REAL DEDICATED SPECIALIST WORKER: FAILED');
  console.error(String(error?.message||error));
  process.exitCode=1;
} finally { await closeDb(); }
'@

try {
    [System.IO.File]::WriteAllText($seedFile,$seedSource,[System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($verifyFile,$verifySource,[System.Text.UTF8Encoding]::new($false))
    Write-Host "Starting disposable PostgreSQL for QA: $pgName"
    docker run -d --rm --name $pgName -e POSTGRES_USER=aira_qa -e "POSTGRES_PASSWORD=$pgPassword" -e POSTGRES_DB=aira_qa -p '127.0.0.1::5432' postgres:16-alpine | Out-Host
    if($LASTEXITCODE -ne 0){throw 'PostgreSQL container did not start'}
    $dbStarted = $true
    $portText = docker port $pgName '5432/tcp' | Out-String
    $port = [regex]::Match($portText,'(\d+)\s*$').Groups[1].Value
    if(-not $port){throw 'Could not discover PostgreSQL local port'}
    $env:DATABASE_URL = "postgres://aira_qa:" + $pgPassword + "@127.0.0.1:" + $port + "/aira_qa"
    $ready = $false
    for($i=0;$i -lt 45;$i++){
        docker exec $pgName pg_isready -U aira_qa -d aira_qa -q 2>$null
        if($LASTEXITCODE -eq 0){$ready=$true;break}
        Start-Sleep -Seconds 1
    }
    if(-not $ready){throw 'QA PostgreSQL not ready'}
    $bytes = New-Object byte[] 48
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {$rng.GetBytes($bytes)} finally {$rng.Dispose()}
    $env:AIRA_AGENT_PLAN_SIGNING_KEY = [BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()
    $env:AIRA_SPECIALIST_DELEGATION_ENABLED = 'true'
    $env:AIRA_SPECIALIST_WORKER_ENABLED = 'true'
    $env:AIRA_MODEL_MISSIONS_ENABLED = 'true'
    $env:NODE_ENV = 'production'
    $env:AIRA_ALLOW_MOCK = 'false'
    $env:VERCEL = '0'
    Remove-Item Env:AIRA_SPECIALIST_WORKER_PROCESS -ErrorAction SilentlyContinue
    Write-Host 'Seeding local QA parent and a real durable child through AgentRuntime...'
    $seedOutput = & npx.cmd tsx $seedFile 2>&1
    $seedExit = $LASTEXITCODE
    $seedOutput | Out-Host
    if($seedExit -ne 0){throw "AgentRuntime local QA seed failed (exit $seedExit)"}
    $seedLine = $seedOutput | Where-Object { "$_" -like 'QA_SEED_JSON:*' } | Select-Object -Last 1
    if(-not $seedLine){throw 'QA child delegation record not found in seed output'}
    $seed = ("$seedLine" -replace '^QA_SEED_JSON:','') | ConvertFrom-Json
    $env:QA_OWNER_ID = $seed.owner
    $env:QA_DELEGATION_ID = $seed.delegationId
    $env:QA_CHILD_ID = $seed.childRunId
    $env:AIRA_SPECIALIST_WORKER_PROCESS = 'true'
    Write-Host 'Starting real dedicated specialist-worker OS process...'
    $worker = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/s','/c','npx tsx apps/specialist-worker/src/index.ts') -WorkingDirectory $PWD.Path -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru -WindowStyle Hidden
    if(-not $worker){throw 'Unable to launch specialist worker'}
    Write-Host "Worker process ID: $($worker.Id)"
    $result = & npx.cmd tsx $verifyFile 2>&1
    $verifyExit = $LASTEXITCODE
    $result | Out-Host
    if($verifyExit -ne 0){throw "Independent specialist verification failed (exit $verifyExit)"}
    Write-Host 'QA COMPLETE: Local real-model dedicated worker execution VERIFIED' -ForegroundColor Green
    $testSucceeded = $true
}
finally {
    if($worker){
        try { & taskkill.exe /PID $worker.Id /T /F 2>$null | Out-Null } catch {}
    }
    if($dbStarted){ try { & docker.exe rm -f $pgName 2>$null | Out-Null } catch {} }
    foreach($name in $previous.Keys){
        if($null -eq $previous[$name]){Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue}
        else {[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}
    }
    foreach($path in @($seedFile,$verifyFile)){
        Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue
    }
    if($testSucceeded){
        foreach($path in @($stdoutLog,$stderrLog)){Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue}
    } else {
        Write-Host "Local worker logs retained for private diagnosis: $stdoutLog ; $stderrLog"
        Write-Host 'Logs may contain sensitive provider responses. Do not share them unredacted.'
    }
    Write-Host 'Local QA container, scripts, and temporary environment settings cleaned.'
}
