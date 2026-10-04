import { useEffect, useRef, useState } from 'react';
import { X, Check, ShieldCheck } from 'lucide-react';
import type { Bot, BotInput, Capabilities } from './api';

const TOOL_LABELS: Record<BotInput['tools'][number], string> = {
  web_search: 'Web search',
  calculator: 'Calculator',
  browser_open: 'Browser',
  file_read: 'Read workspace files',
  file_write: 'Write workspace files',
  terminal_exec: 'Terminal programs'
};
const TOOL_ORDER = Object.keys(TOOL_LABELS) as BotInput['tools'];

export function BotEditor({ bot, capabilities, onSave, onClose }: { bot?: Bot; capabilities: Capabilities; onSave: (input: BotInput) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(bot?.name || '');
  const [description, setDescription] = useState(bot?.description || '');
  const [instructions, setInstructions] = useState(bot?.instructions || '');
  const [model, setModel] = useState<BotInput['model']>(bot?.model || 'aira-auto');
  const [tools, setTools] = useState<BotInput['tools']>(bot?.tools || []);
  const [approvalPolicy, setApprovalPolicy] = useState<BotInput['approvalPolicy']>(bot?.approvalPolicy || 'risky_only');
  const [memory, setMemory] = useState(bot?.memory || '');
  const [skills, setSkills] = useState<BotInput['skills']>(bot?.skills || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const element = dialog.current; element?.showModal(); element?.querySelector('input')?.focus(); return () => element?.close(); }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await onSave({ name, description, instructions, model, tools, approvalPolicy, memory, skills, maxSteps: bot?.maxSteps || 8 }); onClose(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="ab-dialog" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} aria-labelledby="bot-editor-title">
    <form onSubmit={submit}>
      <div className="ab-editor-heading"><div><span className="ab-eyebrow">YOUR NEXT TEAMMATE</span><h2 id="bot-editor-title">{bot ? 'Edit your bot' : 'Create an Aira Bot'}</h2></div><button type="button" className="ab-icon-button" onClick={onClose} disabled={busy} aria-label="Close bot editor"><X size={20} /></button></div>
      <p className="ab-muted">Give it a purpose. Choose its tools. Keep control.</p>
      <label>Name<input autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={80} required placeholder="Competitive Intelligence Analyst" /></label>
      <label>Purpose<input value={description} onChange={e => setDescription(e.target.value)} maxLength={500} placeholder="What does this bot help you achieve?" /></label>
      <label>Instructions<textarea value={instructions} onChange={e => setInstructions(e.target.value)} maxLength={12000} required rows={4} placeholder="Describe its role, working style, and the standards its results must meet." /></label>
      <div className="ab-form-grid"><label>Model<select value={model} onChange={e => setModel(e.target.value as BotInput['model'])}><option value="aira-auto">Aira Auto</option>{Array.from(new Set([...capabilities.models, ...(model !== 'aira-auto' ? [model] : [])])).map(m => <option key={m} value={m}>{m}</option>)}</select></label><label>Approval policy<select value={approvalPolicy} onChange={e => setApprovalPolicy(e.target.value as BotInput['approvalPolicy'])}><option value="risky_only">Allow enabled read tools</option><option value="always_ask">Ask before every tool</option></select></label></div>
      <fieldset><legend>Capabilities</legend><div className="ab-tool-options">{TOOL_ORDER.map(tool => <label className="ab-checkbox" key={tool}><input type="checkbox" checked={tools.includes(tool)} disabled={!capabilities.tools.includes(tool)} onChange={e => setTools(prev => e.target.checked ? [...prev, tool] : prev.filter(t => t !== tool))} /><span>{TOOL_LABELS[tool]}{!capabilities.tools.includes(tool) ? ' · not connected' : ''}</span></label>)}</div></fieldset>
      <details><summary>Memory and reusable skills</summary><label>Saved memory<textarea value={memory} onChange={e => setMemory(e.target.value)} maxLength={12000} rows={3} placeholder="Preferences and facts this bot should remember across tasks." /></label>{skills.map((skill, index) => <div className="ab-skill-editor" key={index}><label>Skill name<input value={skill.name} maxLength={80} required onChange={e => setSkills(prev => prev.map((s, i) => i === index ? { ...s, name: e.target.value } : s))} /></label><label>Procedure<textarea value={skill.instructions} maxLength={4000} required rows={2} onChange={e => setSkills(prev => prev.map((s, i) => i === index ? { ...s, instructions: e.target.value } : s))} /></label><button type="button" className="ab-text-button" onClick={() => setSkills(prev => prev.filter((_, i) => i !== index))}>Remove skill</button></div>)}<button type="button" className="ab-secondary" disabled={skills.length >= 12} onClick={() => setSkills(prev => [...prev, { name: '', instructions: '' }])}>Add a skill</button></details>
      <p className="ab-policy-note"><ShieldCheck size={16} /> Read tools can run under “risky only”. File writes and terminal programs pause for approval. Computer tools remain confined to this bot workspace.</p>
      {error && <p role="alert" className="ab-error">{error}</p>}
      <footer><button type="button" className="ab-secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="ab-primary" disabled={busy}><Check size={16} />{busy ? 'Saving…' : bot ? 'Save changes' : 'Create bot'}</button></footer>
    </form>
  </dialog>;
}
