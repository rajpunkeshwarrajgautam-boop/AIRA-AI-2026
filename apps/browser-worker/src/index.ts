import 'dotenv/config';
import { DurableBrowserSessions } from '../../../packages/agent-runtime/src/browser-sessions.js';
import { PersistentChromiumWorker } from '../../../packages/agent-runtime/src/persistent-browser-worker.js';
import { BrowserWorkerHttp } from '../../../packages/agent-runtime/src/browser-worker-transport.js';

if(process.env.AIRA_BROWSER_WORKER_PROCESS!=='true' || process.env.VERCEL==='1')
  throw new Error('BROWSER_DEDICATED_WORKER_REQUIRED');
if(process.getuid?.()===0)throw new Error('BROWSER_WORKER_MUST_NOT_RUN_AS_ROOT');
if(process.env.AIRA_DURABLE_BROWSER_ENABLED!=='true')
  throw new Error('BROWSER_WORKER_NOT_ENABLED');
const token=process.env.AIRA_BROWSER_WORKER_TOKEN||'';
if(token.length<32)throw new Error('BROWSER_WORKER_TOKEN_REQUIRED');
const profileRoot=process.env.AIRA_BROWSER_PROFILE_ROOT||'';
if(!profileRoot.startsWith('/'))throw new Error('BROWSER_PERSISTENT_PROFILE_ROOT_REQUIRED');
const sessions=new DurableBrowserSessions();
const browser=new PersistentChromiumWorker(sessions,profileRoot);
const service=new BrowserWorkerHttp(browser,sessions,token);
const server=service.server();
const port=Number(process.env.AIRA_BROWSER_WORKER_PORT||4103);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('BROWSER_INVALID_WORKER_PORT');
server.listen(port,'127.0.0.1',()=>{
  console.log(JSON.stringify({kind:'browser-worker',status:'LISTENING',port,
    note:'Loopback listener must use trusted HTTPS proxy for nonlocal API access'}));
});
const shutdown=async()=>{
  server.close();
  await browser.shutdown();
  process.exit(0);
};
process.once('SIGINT',()=>{void shutdown()});
process.once('SIGTERM',()=>{void shutdown()});
