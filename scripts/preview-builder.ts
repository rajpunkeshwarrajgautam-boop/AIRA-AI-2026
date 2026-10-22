/** Local UI review only: no database, provider calls, shell execution or paid resources. */
import express from 'express';
import { ModelRouter } from '../packages/model-router/src/index.js';
import { createBuilderRoutes } from '../apps/api/src/builder-routes.js';
import { createSessionAuthMiddleware, ensureAuthenticatedSession } from '../apps/api/src/auth/session-auth.js';
import { createPrincipalMiddleware } from '../apps/api/src/middleware/principal.js';
process.env.AIRA_BUILDER_ENABLED='false';
const app=express();app.use(express.json());app.use(createSessionAuthMiddleware());
app.post('/api/auth/session',(req,res)=>res.json(ensureAuthenticatedSession(req,res)));
app.use('/api/builder',createPrincipalMiddleware(),createBuilderRoutes(new ModelRouter()));
app.listen(3001,'0.0.0.0',()=>console.log('Builder UI review API: setup mode, no code execution enabled.'));
