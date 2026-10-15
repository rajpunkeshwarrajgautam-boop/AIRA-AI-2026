'use strict';
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const fs=require('node:fs');
const mode=process.env.MODE;
const root='/profiles/persistent';
const cookie='AIRA_BROWSER_ISOLATION_VERIFIED';
(async()=>{
  assert.notEqual(process.getuid(),0,'browser worker must be unprivileged');
  assert.equal(fs.existsSync('/profiles'),true);
  const context=await chromium.launchPersistentContext(root,{
    headless:true,viewport:{width:800,height:600}
  });
  const page=context.pages()[0]||await context.newPage();
  await page.setContent('<main><h1>Actual isolated Chromium</h1></main>');
  assert.equal(await page.locator('h1').innerText(),'Actual isolated Chromium');
  if(mode==='seed'){
    await context.addCookies([{
      name:'aira_stored',value:cookie,
      domain:'example.org',path:'/',httpOnly:true,secure:true,
      expires:Math.floor(Date.now()/1000)+3600
    }]);
    const found=await context.cookies('https://example.org/');
    assert.equal(found.find(x=>x.name==='aira_stored')?.value,cookie);
    await context.close();
    console.log('DOCKER_BROWSER_SEEDED_REAL_PROFILE');
    process.exit(0);
  }else if(mode==='crash'||mode==='restore'){
    const found=await context.cookies('https://example.org/');
    assert.equal(found.find(x=>x.name==='aira_stored')?.value,cookie,
      'Persistent cookie must survive the previous Docker process');
    if(mode==='crash'){
      console.log('DOCKER_BROWSER_READY_FOR_FORCED_SIGKILL');
      process.kill(process.pid,'SIGKILL');
    }
    await context.close();
    console.log('DOCKER_BROWSER_RESTORED_AFTER_SIGKILL');
    process.exit(0);
  }else throw new Error('UNKNOWN_MODE');
})().catch(e=>{console.error(e);process.exitCode=1});
