import React, { useEffect, useRef, useState } from 'react';
import { Bot, CheckCircle2, Download, ExternalLink, FileCode2, Loader2, Play, Plus, Square, Terminal, Wrench } from 'lucide-react';
import type { ModelId } from '../types';
import { AgentsView } from './AgentsView';
import { builderStatus, cancelBuilder, downloadBuilderFile, streamBuilder, type BuilderEvent, type BuilderStatus } from '../utils/builderClient';

interface ToolStep { id:string; name:string; label:string; state:'running'|'done'|'error'; output?:unknown }
interface FileResult { title:string; path:string; bytes:number; url:string; expiresAt:number }
export const BuilderWorkspace:React.FC<{model:ModelId}> = ({model}) => {
  const [tab,setTab]=useState<'builder'|'saved'>('builder');
  const [status,setStatus]=useState<BuilderStatus|null>(null),[statusError,setStatusError]=useState('');
  const [prompt,setPrompt]=useState(''),[allowExecution,setAllowExecution]=useState(false),[allowInternet,setAllowInternet]=useState(false),[allowPreview,setAllowPreview]=useState(false);
  const [hasWorkspace,setHasWorkspace]=useState(false);
  const [busy,setBusy]=useState(false),[steps,setSteps]=useState<ToolStep[]>([]),[files,setFiles]=useState<FileResult[]>([]),[preview,setPreview]=useState(''),[summary,setSummary]=useState(''),[error,setError]=useState(''),[activity,setActivity]=useState(''),[expires,setExpires]=useState(0),[provenance,setProvenance]=useState('');
  const controller=useRef<AbortController|null>(null),ticket=useRef(''),active=useRef(false),mounted=useRef(true);
  const [clock,setClock]=useState(()=>Date.now());
  const refresh=()=>{setStatusError('');builderStatus().then(s=>{if(mounted.current)setStatus(s);}).catch(e=>{if(mounted.current)setStatusError(e.message);});};
  useEffect(()=>{mounted.current=true;refresh();const timer=setInterval(()=>setClock(Date.now()),10000);return()=>{mounted.current=false;clearInterval(timer);if(active.current)controller.current?.abort();if(ticket.current)void cancelBuilder(ticket.current,true).catch(()=>{});};},[]);
  const expired=expires>0&&clock>=expires;
  const onEvent=({type,data}:BuilderEvent)=>{
    if(!mounted.current)return;
    if(type==='builder.started'){ticket.current=data.workspaceTicket;setHasWorkspace(true);setExpires(data.expiresAt);}
    if(type==='builder.status')setActivity(data.text);
    if(type==='builder.tool.started')setSteps(s=>[...s,{id:data.id,name:data.name,label:data.label,state:'running'}]);
    if(type==='builder.tool.completed')setSteps(s=>s.map(t=>t.id===data.id?{...t,state:data.isError?'error':'done',output:data.output}:t));
    if(type==='builder.file')setFiles(f=>[...f.filter(x=>x.path!==data.path),data as FileResult]);
    if(type==='builder.preview' && /^https:\/\/[a-zA-Z0-9.-]+\/$/.test(data.url))setPreview(data.url);
    if(type==='model.provenance')setProvenance(`${data.provider} · ${data.executedModel}${data.verified?'':' · upstream model unconfirmed'}`);
    if(type==='builder.completed'){setSummary(data.summary);setActivity('Completed');}
    if(type==='builder.error'){setError(data.error);ticket.current='';setHasWorkspace(false);setPreview('');setFiles([]);setSteps(s=>s.map(t=>t.state==='running'?{...t,state:'error'}:t));}
  };
  const run=async(e:React.FormEvent)=>{
    e.preventDefault();if(busy||!allowExecution||!status?.ready||!prompt.trim()||expired)return;
    setBusy(true);active.current=true;setSteps([]);setFiles([]);setSummary('');setError('');setActivity('Connecting to isolated sandbox…');
    controller.current=new AbortController();
    try{await streamBuilder({prompt,model,allowExecution:true,allowInternet,allowPreview,...(ticket.current?{workspaceTicket:ticket.current}:{})},controller.current.signal,onEvent);}
    catch(e:any){if(mounted.current){setError(e.name==='AbortError'?'Run stopped. Temporary files may no longer be available.':e.message);setFiles([]);setPreview('');ticket.current='';setHasWorkspace(false);setSteps(s=>s.map(t=>t.state==='running'?{...t,state:'error'}:t));}}
    finally{active.current=false;if(mounted.current){setBusy(false);setActivity('');}}
  };
  const stop=async()=>{
    const token=ticket.current;controller.current?.abort();ticket.current='';setHasWorkspace(false);setFiles([]);setPreview('');
    if(token)try{await cancelBuilder(token);}catch(e:any){setError(e.message+' The provider timeout still limits the sandbox lifetime.');}
  };
  const reset=async()=>{const old=ticket.current;ticket.current='';setHasWorkspace(false);if(old)void cancelBuilder(old).catch(()=>{});setSteps([]);setFiles([]);setPreview('');setSummary('');setExpires(0);setError('');setProvenance('');};
  const shell='rounded-2xl border border-claude-borderMuted-light dark:border-claude-borderMuted-dark bg-white/60 dark:bg-white/[0.025]';
  const ready=status?.ready;
  return <div className="mx-auto w-full max-w-6xl p-4 sm:p-6" data-testid="builder-workspace">
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div><div className="flex items-center gap-2"><Bot size={22} className="text-claude-terracotta"/><h1 className="text-xl font-semibold">Agent workspace</h1><span className="rounded-full bg-claude-terracotta/10 px-2 py-1 text-[10px] font-semibold text-claude-terracotta">BUILDER BETA</span></div><p className="mt-1 text-sm text-claude-muted-light dark:text-claude-muted-dark">Create files. Run code in isolation. Preview what actually works.</p></div>
      <div className="flex rounded-xl border border-claude-borderMuted-light p-1 dark:border-claude-borderMuted-dark" role="group" aria-label="Agent workspace view">
        <button className={`rounded-lg px-3 py-2 text-sm ${tab==='builder'?'bg-claude-terracotta/15':''}`} aria-pressed={tab==='builder'} onClick={()=>setTab('builder')}>Builder</button>
        <button className={`rounded-lg px-3 py-2 text-sm ${tab==='saved'?'bg-claude-terracotta/15':''}`} aria-pressed={tab==='saved'} onClick={()=>setTab('saved')}>Saved agents</button>
      </div>
    </div>
    {tab==='saved'?<AgentsView/>:<>
      {(!ready||statusError)&&<div className={`${shell} mb-5 p-4 text-sm`} role="status">
        <p className="font-medium">{statusError||status?.reason||'Checking builder configuration…'}</p>
        {status?.reason==='Ready'&&!status.providerConfigured&&<p>Configure a real model provider.</p>}
        {status&&(
          <div className="my-3 grid grid-cols-2 gap-2 rounded-xl bg-black/[0.03] p-3 text-xs dark:bg-white/[0.03] sm:grid-cols-4">
            <div><span className="font-medium text-claude-terracotta">Sandbox provider:</span> {status.sandboxProvider ? (status.sandboxProvider.charAt(0).toUpperCase() + status.sandboxProvider.slice(1)) : 'Lightning'}</div>
            <div><span className="font-medium text-claude-terracotta">Provider configured:</span> {status.sandboxProviderConfigured ? 'Yes' : (status.configured ? 'Yes' : 'No')}</div>
            <div><span className="font-medium text-claude-terracotta">Teamspace configured:</span> {status.teamspaceConfigured ? 'Yes' : 'No'}</div>
            <div><span className="font-medium text-claude-terracotta">Runtime:</span> {status.runtime || 'node24'}</div>
            <div><span className="font-medium text-claude-terracotta">Instance:</span> {status.instanceType || 'cpu-2'}</div>
            <div><span className="font-medium text-claude-terracotta">Workspace TTL:</span> {status.workspaceTtlMinutes || status.temporaryMinutes || 15} minutes</div>
            <div><span className="font-medium text-claude-terracotta">Preview port:</span> {status.previewPort || 3000}</div>
            <div><span className="font-medium text-claude-terracotta">Fallback provider:</span> {status.fallbackProvider ? (status.fallbackProvider === 'disabled' ? 'disabled' : status.fallbackProvider.toUpperCase()) : 'disabled'}</div>
          </div>
        )}
        <p className="mt-2 text-xs text-claude-muted-light dark:text-claude-muted-dark">The owner must configure the sandbox provider, enable the beta and approve your Aira user ID. No sandbox is created until setup is complete.</p>
        {status&&<p className="mt-2 break-all font-mono text-xs">Your user ID: {status.principalId}</p>}
        <button onClick={refresh} className="mt-3 min-h-11 text-claude-terracotta underline">Check setup again</button>
      </div>}
      {ready&&status&&(
        <details className={`${shell} mb-5 p-3 text-xs`} data-testid="builder-diagnostics">
          <summary className="cursor-pointer font-medium text-claude-muted-light dark:text-claude-muted-dark">Sandbox diagnostics ({status.sandboxProvider ? (status.sandboxProvider.charAt(0).toUpperCase() + status.sandboxProvider.slice(1)) : 'Lightning'})</summary>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div><span className="font-medium text-claude-terracotta">Sandbox provider:</span> {status.sandboxProvider ? (status.sandboxProvider.charAt(0).toUpperCase() + status.sandboxProvider.slice(1)) : 'Lightning'}</div>
            <div><span className="font-medium text-claude-terracotta">Provider configured:</span> {status.sandboxProviderConfigured ? 'Yes' : (status.configured ? 'Yes' : 'No')}</div>
            <div><span className="font-medium text-claude-terracotta">Teamspace configured:</span> {status.teamspaceConfigured ? 'Yes' : 'No'}</div>
            <div><span className="font-medium text-claude-terracotta">Runtime:</span> {status.runtime || 'node24'}</div>
            <div><span className="font-medium text-claude-terracotta">Instance:</span> {status.instanceType || 'cpu-2'}</div>
            <div><span className="font-medium text-claude-terracotta">Workspace TTL:</span> {status.workspaceTtlMinutes || status.temporaryMinutes || 15} minutes</div>
            <div><span className="font-medium text-claude-terracotta">Preview port:</span> {status.previewPort || 3000}</div>
            <div><span className="font-medium text-claude-terracotta">Fallback provider:</span> {status.fallbackProvider ? (status.fallbackProvider === 'disabled' ? 'disabled' : status.fallbackProvider.toUpperCase()) : 'disabled'}</div>
          </div>
        </details>
      )}
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <form onSubmit={run} className={`${shell} p-4`}>
            <label htmlFor="builder-prompt" className="text-sm font-medium">What should Aira build?</label>
            <textarea id="builder-prompt" value={prompt} onChange={e=>setPrompt(e.target.value)} disabled={busy} maxLength={24000} rows={6} placeholder="Build an interactive dashboard with sample data, test it, and provide the source files." className="mt-3 w-full resize-y rounded-xl border border-claude-borderMuted-light bg-transparent p-3 text-sm outline-none focus:border-claude-terracotta dark:border-claude-borderMuted-dark"/>
            <fieldset disabled={busy||hasWorkspace} className="mt-3 space-y-3 text-xs disabled:opacity-60"><legend className="sr-only">Sandbox permissions</legend>
              <label className="flex min-h-8 items-start gap-2"><input type="checkbox" checked={allowExecution} onChange={e=>setAllowExecution(e.target.checked)} className="mt-0.5"/>I authorize Aira to create files and execute code inside a temporary isolated sandbox. Usage may incur model and sandbox charges.</label>
              <label className="flex min-h-8 items-start gap-2"><input type="checkbox" checked={allowInternet} onChange={e=>setAllowInternet(e.target.checked)}/>Allow outbound internet access for packages and public resources.</label>
              <label className="flex min-h-8 items-start gap-2"><input type="checkbox" checked={allowPreview} onChange={e=>setAllowPreview(e.target.checked)}/>Allow a public preview link. Anyone with that link may view the generated website. Do not include sensitive data.</label>
            </fieldset>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {busy?<button type="button" onClick={stop} className="flex min-h-11 items-center gap-2 rounded-xl border border-red-400/40 px-4 text-sm"><Square size={14}/>Stop</button>:<button type="submit" disabled={!ready||!allowExecution||!prompt.trim()||expired} className="flex min-h-11 items-center gap-2 rounded-xl bg-claude-terracotta px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"><Play size={14}/>{hasWorkspace?'Continue building':'Start build'}</button>}
              <button type="button" onClick={reset} disabled={busy} className="flex min-h-11 items-center gap-1 px-2 text-xs disabled:opacity-40"><Plus size={14}/>New workspace</button>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-claude-muted-light dark:text-claude-muted-dark">Temporary files and previews last up to 15 minutes. Download your results before they expire. No deployment, image generation or external account actions are included.</p>
          </form>
          {activity&&<p role="status" className="flex items-center gap-2 text-xs text-claude-terracotta"><Loader2 size={14} className="animate-spin"/>{activity}</p>}
          {error&&<p role="alert" className="rounded-xl border border-red-400/30 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-300">{error}</p>}
          {expired&&<p role="status" className="text-sm text-amber-600 dark:text-amber-300">This workspace has expired. Start a new workspace; expired links cannot be recovered.</p>}
          {!!steps.length&&<section className={`${shell} p-4`} aria-label="Builder tool activity"><h2 className="mb-3 text-sm font-medium">Execution activity</h2><ol className="space-y-3">{steps.map(t=><li key={t.id} className="text-xs"><div className="flex items-start gap-2">{t.state==='running'?<Loader2 size={15} className="mt-0.5 shrink-0 animate-spin"/>:t.state==='done'?<CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-500"/>:<Wrench size={15} className="mt-0.5 shrink-0 text-red-400"/>}<div className="min-w-0"><span className="font-medium">{t.name.replaceAll('_',' ')}</span><p className="break-words text-claude-muted-light dark:text-claude-muted-dark">{t.label}</p></div></div>{t.output!==undefined&&<details className="ml-6 mt-1"><summary className="cursor-pointer py-1">{t.state==='error'?'View error':'View result'}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/5 p-2 dark:bg-black/30">{JSON.stringify(t.output,null,2)}</pre></details>}</li>)}</ol></section>}
          {summary&&<section className={`${shell} p-4`}><h2 className="mb-2 text-sm font-medium">Build summary</h2><p className="whitespace-pre-wrap text-sm leading-relaxed">{summary}</p>{provenance&&<p className="mt-3 text-[11px] text-claude-muted-light dark:text-claude-muted-dark">{provenance}</p>}</section>}
        </div>
        <div className="min-w-0 space-y-4">
          <section className={`${shell} overflow-hidden`} aria-label="Website preview"><div className="flex min-h-12 items-center justify-between gap-2 border-b border-claude-borderMuted-light px-4 dark:border-claude-borderMuted-dark"><h2 className="text-sm font-medium">Live preview</h2>{preview&&!expired&&<a href={preview} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-1 text-xs text-claude-terracotta">Open separately<ExternalLink size={13}/></a>}</div>{preview&&!expired?<iframe title="Aira generated website preview" src={preview} sandbox="allow-scripts" referrerPolicy="no-referrer" className="h-[400px] w-full border-0 bg-white sm:h-[520px]"/>:<div className="grid min-h-64 place-items-center p-8 text-center text-sm text-claude-muted-light dark:text-claude-muted-dark"><div><FileCode2 className="mx-auto mb-3 opacity-50" size={32}/>{expired?'Preview expired.':allowPreview?'A verified preview appears after the agent starts its server.':'Enable public preview before starting, or download the files privately.'}</div></div>}</section>
          {!!files.length&&<section className={`${shell} p-4`} aria-label="Generated files"><h2 className="mb-2 text-sm font-medium">Download results</h2>{files.map(f=><button key={f.path} disabled={expired||busy} onClick={()=>downloadBuilderFile(f.url,f.path.split('/').pop()||'download').catch(e=>setError(e.message))} className="flex min-h-12 w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5"><Download size={17} className="shrink-0 text-claude-terracotta"/><span className="min-w-0 flex-1"><span className="block truncate text-sm">{f.title}</span><span className="block truncate text-[11px] text-claude-muted-light dark:text-claude-muted-dark">{f.path} · {Math.ceil(f.bytes/1024)} KB</span></span></button>)}<p className="mt-2 text-[10px] text-claude-muted-light dark:text-claude-muted-dark">Available until {new Date(expires).toLocaleTimeString()}. Downloads are verified against the published file hash.</p></section>}
          <p className="flex gap-2 text-[11px] leading-relaxed text-claude-muted-light dark:text-claude-muted-dark"><Terminal size={15} className="shrink-0"/>Commands execute in a separate VM, never on Aira’s web server. This beta uses a bounded streaming request, not a durable background job.</p>
        </div>
      </div>
    </>}
  </div>;
};
