import type {} from './middleware/principal.js';
import { Router } from 'express';
import { z } from 'zod';
import type { ModelRouter } from '../../../packages/model-router/src/index.js';
import { BuilderService } from '../../../packages/builder-runtime/src/index.js';
import { BuilderRequestSchema } from '../../../packages/builder-runtime/src/contracts.js';
import { publicBuilderError } from '../../../packages/builder-runtime/src/security.js';

export function createBuilderRoutes(modelRouter: ModelRouter, service = new BuilderService(modelRouter)) {
  const router=Router();
  router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');if(!req.principal?.userId||!req.principal.sessionId){res.status(401).json({error:'A signed Aira session is required.'});return;}next();});
  // Existing signed session + principal middleware MUST run before this router.
  router.get('/status',(req,res)=>{res.json(service.status(req.principal!));});
  router.post('/stream',async(req,res)=>{
    const parsed=BuilderRequestSchema.safeParse(req.body);
    if(!parsed.success){res.status(400).json({error:'A prompt and explicit sandbox-execution consent are required.',details:parsed.error.flatten()});return;}
    const status=service.status(req.principal!);
    if(!status.ready){res.status(status.allowed?503:403).json({error:status.reason==='Ready'?'Configure a real model provider.':status.reason});return;}
    const controller=new AbortController();
    const onClose=()=>{if(!res.writableEnded)controller.abort(new Error('Client disconnected.'));};
    res.on('close',onClose);
    res.setHeader('Content-Type','text/event-stream');res.setHeader('X-Accel-Buffering','no');res.flushHeaders?.();
    const emit=(event:{type:string;data:Record<string,unknown>})=>{if(!res.destroyed&&!res.writableEnded)res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);};
    const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n');},10000);
    try {await service.run(parsed.data,req.principal!,emit,controller.signal);}
    catch(error){emit({type:'builder.error',data:{error:publicBuilderError(error)}});}
    finally{clearInterval(heartbeat);res.off('close',onClose);res.end();}
  });
  router.post('/cancel',async(req,res)=>{
    const parsed=z.object({ticket:z.string().min(1).max(6000)}).strict().safeParse(req.body);
    if(!parsed.success){res.status(400).json({error:'Workspace ticket required.'});return;}
    try{await service.cancel(parsed.data.ticket,req.principal!);res.json({cancelled:true});}
    catch(error){res.status(403).json({error:publicBuilderError(error)});}
  });
  router.get('/download',async(req,res)=>{
    if(typeof req.query.ticket!=='string'){res.status(400).json({error:'File ticket required.'});return;}
    try{
      const file=await service.download(req.query.ticket,req.principal!);
      res.setHeader('Content-Type','application/octet-stream');res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
      res.setHeader('Content-Disposition',`attachment; filename="${file.name}"`);
      res.send(Buffer.from(file.bytes));
    }catch(error){res.status(403).json({error:publicBuilderError(error)});}
  });
  return router;
}
