import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

/**
 * Native Microsoft Edge browser zoom under Xvfb.
 * Sends Ctrl++ through the X11 input system. Unlike CSS zoom, viewport
 * emulation or pinch scaling, this changes the browser zoom level.
 * The test fails unless real devicePixelRatio doubles and CSS viewport halves.
 * No account login, user data mutation, or bypass of app authentication.
 */
const url = new URL(process.env.AIRA_RESPONSIVE_URL || 'http://127.0.0.1:5173/');
assert(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)));
const expectedSha = process.env.AIRA_EXPECTED_SHA || '';
assert.match(expectedSha, /^[a-f0-9]{40}$/);
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '';
const directory = path.resolve(process.env.AIRA_ZOOM_EVIDENCE_DIR || 'artifacts/edge-native-zoom');
mkdirSync(directory, { recursive: true });
const results: Array<{
  viewport: string, theme: string, zoom: string, cssWidth: number, dpr: number,
  screen: string, result: 'PASS'|'FAIL', screenshot: string, issue: string
}> = [];
const persist = () => writeFileSync(path.join(directory,'results.json'),
  JSON.stringify({source:url.origin,expectedSha,browser:'Microsoft Edge (headed, native X11 Ctrl+Plus)',
    results},null,2)+'\n');
let index=0;

const browser = await chromium.launch({channel:'msedge',headless:false});
try {
  for (const [physicalWidth,physicalHeight] of [[800,900],[1280,800],[1920,1080]]) {
    for (const theme of ['light','dark']) {
      const context = await browser.newContext({
        viewport:{width:physicalWidth,height:physicalHeight},
        reducedMotion:'reduce',colorScheme:theme
      });
      if (bypass) await context.route('**/*', route => {
        if (new URL(route.request().url()).origin !== url.origin) return route.continue();
        return route.continue({headers:{
          ...route.request().headers(),'x-vercel-protection-bypass':bypass
        }});
      });
      const page=await context.newPage();
      page.setDefaultTimeout(3000);
      page.setDefaultNavigationTimeout(15000);
      const record=async(screen:string,action:()=>Promise<void>)=>{
        const row={viewport:physicalWidth+'x'+physicalHeight,theme,zoom:'200%',cssWidth:0,
          dpr:0,screen,result:'PASS' as 'PASS'|'FAIL',screenshot:'',issue:''};
        try{
          await page.goto(url.toString(),{waitUntil:'domcontentloaded',timeout:18000});
          await page.getByRole('textbox',{name:'Message Aira'}).waitFor({state:'visible',timeout:12000});
          await page.evaluate(()=>document.fonts.ready);
          await page.evaluate(t=>document.documentElement.classList.toggle('dark',t==='dark'),theme);
          const metrics=await page.evaluate(()=>({
            cssWidth:innerWidth,dpr:devicePixelRatio,scale:visualViewport?.scale,
            scrollWidth:document.documentElement.scrollWidth
          }));
          row.cssWidth=metrics.cssWidth;
          row.dpr=metrics.dpr;
          assert(Math.abs(metrics.dpr-2)<0.05,'Native browser zoom was not 200%: '+JSON.stringify(metrics));
          assert(Math.abs(metrics.cssWidth-physicalWidth/2)<7,
            'CSS viewport did not halve after native zoom: '+JSON.stringify(metrics));
          assert(metrics.scale===1,'Pinch scaling is not accepted as browser zoom');
          await action();
          const width=await page.evaluate(()=>({page:document.documentElement.scrollWidth,view:innerWidth}));
          assert(width.page <= width.view + 2,'Horizontal document overflow: '+JSON.stringify(width));
        }catch(error){
          row.result='FAIL';
          row.issue=String(error);
        }
        const file=String(++index).padStart(3,'0')+'-'+screen.toLowerCase().replace(/[^a-z0-9]+/g,'-')+
          '-'+physicalWidth+'x'+physicalHeight+'-'+theme+'-200.png';
        try{await page.screenshot({path:path.join(directory,file),animations:'disabled',timeout:8000});
          row.screenshot=file;}catch(error){row.result='FAIL';row.issue+=' screenshot: '+String(error);}
        results.push(row);persist();
        console.log(row.result+' '+row.screen+' '+row.viewport+' '+theme+' zoom 200%, CSS '+row.cssWidth+
          (row.issue?' '+row.issue:''));
      };

      try{
        await page.goto(url.toString(),{waitUntil:'domcontentloaded',timeout:20000});
        await page.bringToFront();
        const baseline=await page.evaluate(()=>({dpr:devicePixelRatio,cssWidth:innerWidth}));
        assert(Math.abs(baseline.dpr-1)<0.1,'Baseline zoom not 100%: '+JSON.stringify(baseline));
        // 100 -> 110 -> 125 -> 150 -> 175 -> 200 in Microsoft Edge.
        for(let z=0;z<5;z++){
          execFileSync('xdotool',['key','--clearmodifiers','ctrl+plus'],{timeout:4000});
          await page.waitForTimeout(180);
        }
        await page.waitForFunction(()=>Math.abs(devicePixelRatio-2)<0.05,undefined,{timeout:5000});
        await record('Greeting',async()=>{
          assert(await page.locator('.aira-editorial-greeting').isVisible(),'Greeting not visible');
        });
        await record('Model Selector',async()=>{
          await page.getByTestId('model-selector-button').click();
          await page.getByRole('listbox',{name:'Available Aira models'}).waitFor({state:'visible',timeout:4000});
        });
        await record('Artifact Studio',async()=>{
          await page.getByTestId('artifact-studio-launcher').click();
          const studio=page.getByTestId('unified-workspace');
          await studio.waitFor({state:'visible',timeout:4000});
          const rect=await studio.boundingBox();
          assert(rect && rect.x>=-2 && rect.x+rect.width<=physicalWidth/2+2,
            'Workspace outside CSS viewport: '+JSON.stringify(rect));
        });
        await record('Sidebar',async()=>{
          const open=page.getByRole('button',{name:'Open sidebar navigation'});
          if(await open.isVisible())await open.click();
          await page.getByTestId('sidebar-drawer').waitFor({state:'visible',timeout:4500});
        });
        await record('Projects',async()=>{
          const open=page.getByRole('button',{name:'Open sidebar navigation'});
          if(await open.isVisible())await open.click();
          await page.getByRole('button',{name:/^Projects/}).first().click();
          const dlg=page.getByRole('dialog',{name:'Aira Projects'});
          await dlg.waitFor({state:'visible',timeout:4500});
          const front=await dlg.evaluate(el=>{
            const r=el.getBoundingClientRect(), hit=document.elementFromPoint(r.x+r.width/2,r.y+60);
            return Boolean(hit&&el.contains(hit));
          });
          assert(front,'Projects dialog not in foreground at 200% zoom');
        });
        await record('Settings',async()=>{
          const open=page.getByRole('button',{name:'Open sidebar navigation'});
          if(await open.isVisible())await open.click();
          await page.getByRole('button',{name:'Open settings'}).click();
          await page.getByRole('dialog',{name:'Workspace Settings'})
            .waitFor({state:'visible',timeout:4500});
        });
        await record('Account Menu',async()=>{
          const open=page.getByRole('button',{name:'Open sidebar navigation'});
          if(await open.isVisible())await open.click();
          await page.getByTestId('account-button').click();
          await page.getByRole('menu',{name:'Account and user settings menu'})
            .waitFor({state:'visible',timeout:4500});
        });
        await record('Guest Agent Gate',async()=>{
          await page.getByRole('group',{name:'Workspace mode'}).getByRole('button',{name:'Agent'}).click();
          await page.locator('[role="dialog"][aria-labelledby="upgrade-modal-title"]')
            .waitFor({state:'visible',timeout:4500});
          assert(await page.getByRole('button',{name:/Sign In|Create Account/i}).count()>0,
            'Agent gate is missing sign-in action');
        });
      }catch(error){
        results.push({viewport:physicalWidth+'x'+physicalHeight,theme,zoom:'200%',
          cssWidth:0,dpr:0,screen:'Zoom initialization',result:'FAIL',
          screenshot:'',issue:String(error)});
        persist();
      }finally{
        await context.close();
      }
    }
  }
}finally{
  await browser.close();
  persist();
}
const failures=results.filter(r=>r.result==='FAIL');
if(failures.length)throw Error(failures.length+'/'+results.length+' native Edge zoom checks failed');
console.log('PASS all '+results.length+' native browser zoom checks');
