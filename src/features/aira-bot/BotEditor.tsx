import { useEffect, useRef, useState } from 'react';
import { X, Check, ShieldCheck } from 'lucide-react';
import type { Bot, BotInput, BotSkillRecord, Capabilities } from './api';

const TOOL_LABELS: Record<BotInput['tools'][number], string> = {
  web_search: 'Web search',
  calculator: 'Calculator',
  browser_open: 'Open public web pages',
  browser_click: 'Browser click',
  browser_type: 'Browser type and submit',
  browser_scroll: 'Browser scroll',
  browser_wait: 'Wait for page elements',
  file_read: 'Read workspace files',
  file_write: 'Write workspace files',
  terminal_exec: 'Terminal programs',
  delegate_bot: 'Delegate work to another Aira Bot',
  delegation_status: 'Inspect delegated Bot work',
  connector_list: 'Inspect enabled connector tools',
  connector_call: 'Use enabled connector tools'
};
const TOOL_ORDER = Object.keys(TOOL_LABELS) as BotInput['tools'];

export function BotEditor({ bot, capabilities, skillLibrary, onSave, onClose }: { bot?: Bot; capabilities: Capabilities; skillLibrary: BotSkillRecord[]; onSave: (input: BotInput) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(bot?.name || '');
  const [description, setDescription] = useState(bot?.description || '');
  const [instructions, setInstructions] = useState(bot?.instructions || '');
  const [model, setModel] = useState<BotInput['model']>(bot?.model || 'aira-auto');
  const [tools, setTools] = useState<BotInput['tools']>(bot?.tools || []);
  const [connectorIds, setConnectorIds] = useState<string[]>(bot?.connectorIds || []);
  const [approvalPolicy, setApprovalPolicy] = useState<BotInput['approvalPolicy']>(bot?.approvalPolicy || 'risky_only');
  const [memory, setMemory] = useState(bot?.memory || '');
  const [skills, setSkills] = useState<BotInput['skills']>(bot?.skills || []);
  const [skillIds, setSkillIds] = useState<string[]>(bot?.skillIds || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const element = dialog.current; element?.showModal(); element?.querySelector('input')?.focus(); return () => element?.close(); }, []);

  function toggleConnector(id: string, checked: boolean) {
    const next = checked ? Array.from(new Set([...connectorIds, id])) : connectorIds.filter(item => item !== id);
    setConnectorIds(next);
    if (checked) setTools(prev => Array.from(new Set([...prev, 'connector_list', 'connector_call'])) as BotInput['tools']);
    else if (!next.length) setTools(prev => prev.filter(tool => !['connector_list', 'connector_call'].includes(tool)));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await onSave({ name, description, instructions, model, tools, connectorIds, approvalPolicy, memory, skills, skillIds, maxSteps: bot?.maxSteps || 8 }); onClose(); }
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
      <fieldset><legend>Capabilities</legend><div className="ab-tool-options">{TOOL_ORDER.map(tool => <label className="ab-checkbox" key={tool}><input type="checkbox" checked={tools.includes(tool)} disabled={!capabilities.tools.includes(tool) || (['connector_list', 'connector_call'].includes(tool) && connectorIds.length > 0)} onChange={e => setTools(prev => e.target.checked ? [...prev, tool] : prev.filter(t => t !== tool))} /><span>{TOOL_LABELS[tool]}{!capabilities.tools.includes(tool) ? ' · not connected' : ''}</span></label>)}</div>{capabilities.computerProvider && <p className="ab-muted">Computer: {capabilities.computerProvider.isolation === 'docker-container' ? 'isolated Docker container' : 'bounded local runner'}{capabilities.computerProvider.interactive ? ' · interactive browser control' : ''}.</p>}{capabilities.delegation && <p className="ab-muted">Delegation is owner-scoped, cycle-protected, and limited to three nested Bot levels.</p>}</fieldset>
      {(capabilities.connectors?.length || 0) > 0 && <fieldset><legend>Connectors</legend><div className="ab-tool-options">{capabilities.connectors!.map(connector => <label className="ab-checkbox" key={connector.id}><input type="checkbox" checked={connectorIds.includes(connector.id)} onChange={event => toggleConnector(connector.id, event.target.checked)} /><span>{connector.name}<small>{connector.allowedTools.join(', ')}</small></span></label>)}</div><p className="ab-muted">Connector endpoints and credentials stay server-side. Every connector call pauses for approval.</p></fieldset>}
      <details><summary>Memory and skills</summary><label>Saved memory<textarea value={memory} onChange={e => setMemory(e.target.value)} maxLength={12000} rows={3} placeholder="Preferences and facts this bot should remember across tasks." /></label>{skillLibrary.length > 0 && <fieldset><legend>Reusable skill library</legend><div className="ab-tool-options">{skillLibrary.map(skill => <label className="ab-checkbox" key={skill.id}><input type="checkbox" checked={skillIds.includes(skill.id)} onChange={event => setSkillIds(prev => event.target.checked ? [...prev, skill.id] : prev.filter(id => id !== skill.id))} /><span>{skill.name}<small>{skill.description || 'Reusable procedure'}</small></span></label>)}</div><p className="ab-muted">Selected library skills are snapshotted into each run before execution.</p></fieldset>}{skills.map((skill, index) => <div className="ab-skill-editor" key={index}><label>Bot-only skill name<input value={skill.name} maxLength={80} required onChange={e => setSkills(prev => prev.map((s, i) => i === index ? { ...s, name: e.target.value } : s))} /></label><label>Procedure<textarea value={skill.instructions} maxLength={4000} required rows={2} onChange={e => setSkills(prev => prev.map((s, i) => i === index ? { ...s, instructions: e.target.value } : s))} /></label><button type="button" className="ab-text-button" onClick={() => setSkills(prev => prev.filter((_, i) => i !== index))}>Remove bot-only skill</button></div>)}<button type="button" className="ab-secondary" disabled={skills.length >= 12} onClick={() => setSkills(prev => [...prev, { name: '', instructions: '' }])}>Add bot-only skill</button></details>
      <p className="ab-policy-note"><ShieldCheck size={16} /> Read navigation, delegation status, and connector discovery can run under “risky only”. Delegation, connector calls, browser interaction, file writes, and terminal programs pause for approval. Passwords, one-time codes, CAPTCHA and payment confirmation stay human-controlled.</p>
      {error && <p role="alert" className="ab-error">{error}</p>}
      <footer><button type="button" className="ab-secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="ab-primary" disabled={busy}><Check size={16} />{busy ? 'Saving…' : bot ? 'Save changes' : 'Create bot'}</button></footer>
    </form>
  </dialog>;
}
