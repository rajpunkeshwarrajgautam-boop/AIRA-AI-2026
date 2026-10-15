/** Browser acceptance with explicitly mocked API receipts. Never creates paid sandboxes. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const base=process.env.AIRA_BUILDER_TEST_URL||'http://127.0.0.1:5173';
const launchOptions: any = { headless: true };
if (process.env.PLAYWRIGHT_CHROME_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
else if (process.env.PLAYWRIGHT_CHROMIUM_CHANNEL) launchOptions.channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL;
else launchOptions.channel = 'chrome';
const browser=await chromium.launch(launchOptions);
const results:unknown[]=[];
try{
 for(const [width,height] of [[1440,900],[768,1024],[390,844],[320,568],[844,390]]){
  const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  let ready=false;
  await page.route('**/api/auth/session',r=>r.fulfill({json:{ok:true}}));
  await page.route('**/api/builder/status',r=>r.fulfill({json:{ready,enabled:ready,allowed:ready,configured:ready,providerConfigured:ready,reason:ready?'Ready':'Builder is disabled. Complete the sandbox setup.',principalId:'test-owner',temporaryMinutes:15}}));
  await page.route('**/api/builder/cancel',r=>r.fulfill({json:{cancelled:true}}));
  await page.route('**/api/agents',r=>r.fulfill({json:[]}));
  const expiresAt=Date.now()+900000;
  const frames=[
   ['builder.started',{workspaceTicket:'mock-ticket-NOT-A-LIVE-TOKEN',expiresAt}],
   ['builder.tool.started',{id:'t1',name:'write_file',label:'index.html'}],
   ['builder.tool.completed',{id:'t1',name:'write_file',isError:false,output:{bytesWritten:35}}],
   ['builder.preview',{url:'https://preview.aira-test.invalid/',expiresAt}],
   ['builder.file',{path:'index.html',title:'Download website',url:'/api/builder/download?ticket=mock-file',bytes:35,expiresAt}],
   ['builder.completed',{summary:'MOCK TEST: website file and tool receipts.',expiresAt}],
  ].map(([type,data])=>`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  await page.route('**/api/builder/stream',async r=>{
   const body=r.request().postDataJSON();assert.equal(body.allowExecution,true);assert.equal(body.allowPreview,true);assert.equal(body.allowInternet,false);
   await r.fulfill({contentType:'text/event-stream',body:frames});
  });
  await page.route('https://preview.aira-test.invalid/',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Mock test preview</title><h1>Test preview only</h1>'}));
  await page.route('**/api/builder/download?ticket=mock-file',r=>r.fulfill({headers:{'Content-Disposition':'attachment; filename="index.html"'},contentType:'application/octet-stream',body:'<!doctype html><h1>Mock download</h1>'}));
  await page.goto(base);
  if(width<1280)await page.getByRole('button',{name:'Open sidebar navigation'}).click();
  await page.getByRole('button',{name:'Agents',exact:true}).click();
  await page.getByText('Builder is disabled. Complete the sandbox setup.').waitFor();
  assert.equal(await page.getByRole('button',{name:'Start build',exact:true}).isEnabled(),false);
  ready=true;await page.getByRole('button',{name:'Check setup again'}).click();
  await page.getByText('Builder is disabled. Complete the sandbox setup.').waitFor({state:'hidden'});
  await page.getByLabel('What should Aira build?').fill('Build a dashboard');
  const checks=page.locator('[data-testid="builder-workspace"] input[type="checkbox"]');await checks.nth(0).check();await checks.nth(2).check();
  await page.getByRole('button',{name:'Start build',exact:true}).click();
  await page.getByText('MOCK TEST: website file and tool receipts.').waitFor();
  assert.equal(await page.locator('iframe[title="Aira generated website preview"]').getAttribute('sandbox'),'allow-scripts');
  assert.equal(await page.getByRole('button',{name:'Continue building'}).isEnabled(),true);
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:/Download website/}).click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'index.html');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  await fs.mkdir('test-results/builder',{recursive:true});await page.screenshot({path:`test-results/builder/${width}x${height}.png`,fullPage:true});
  results.push({width,height,setupGate:'pass',consent:'pass',mockStream:'pass',sandboxedIframe:'pass',download:'pass',overflow:false,errors});await page.close();
 }
 await fs.writeFile('test-results/builder/ui-results.json',JSON.stringify({mode:'Mocked API browser checks, not a live E2B test',results},null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}
