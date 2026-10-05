import { useState } from 'react';
import { BookOpenCheck, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { botApi } from './api';
import type { BotSkillRecord } from './api';
import './skills.css';

export function SkillLibraryPanel({ skills, onChanged }: { skills: BotSkillRecord[]; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<BotSkillRecord | 'new'>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  function open(value: BotSkillRecord | 'new') {
    setEditing(value);
    setName(value === 'new' ? '' : value.name);
    setDescription(value === 'new' ? '' : value.description);
    setInstructions(value === 'new' ? '' : value.instructions);
    setError('');
  }

  async function save() {
    if (!editing || !name.trim() || !instructions.trim()) return;
    setBusy('save'); setError('');
    try {
      await botApi(editing === 'new' ? '/skills' : `/skills/${encodeURIComponent(editing.id)}`, {
        method: editing === 'new' ? 'POST' : 'PATCH',
        body: JSON.stringify({ name, description, instructions })
      });
      setEditing(undefined);
      await onChanged();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  }

  async function remove(skill: BotSkillRecord) {
    setBusy(skill.id); setError('');
    try { await botApi(`/skills/${encodeURIComponent(skill.id)}`, { method: 'DELETE' }); await onChanged(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  }

  return <section className="ab-skill-library" aria-labelledby="ab-skill-library-title">
    <header><div><BookOpenCheck size={19} /><div><h2 id="ab-skill-library-title">Reusable skills</h2><p>Write a procedure once and attach it to any Aira Bot. A run snapshots the skill before execution.</p></div></div><button type="button" className="ab-secondary" onClick={() => open('new')}><Plus size={15} />New skill</button></header>
    {error && <p className="ab-error" role="alert">{error}</p>}
    {skills.length ? <div className="ab-skill-grid">{skills.map(skill => <article key={skill.id}><div><strong>{skill.name}</strong><p>{skill.description || skill.instructions.slice(0, 160)}</p><small>Updated {new Date(skill.updatedAt).toLocaleString()}</small></div><footer><button type="button" className="ab-text-button" onClick={() => open(skill)}><Pencil size={13} />Edit</button><button type="button" className="ab-text-button" disabled={!!busy} onClick={() => void remove(skill)}><Trash2 size={13} />Delete</button></footer></article>)}</div> : <p className="ab-muted">No library skills yet. Inline Bot skills still work; library skills are for procedures you want to reuse across Bots.</p>}
    {editing && <div className="ab-skill-modal-backdrop" role="presentation"><div className="ab-skill-modal" role="dialog" aria-modal="true" aria-label={editing === 'new' ? 'Create reusable skill' : 'Edit reusable skill'}><header><div><strong>{editing === 'new' ? 'Create reusable skill' : 'Edit reusable skill'}</strong><small>Attached Bots reference this library skill by ID.</small></div><button type="button" className="ab-icon-button" aria-label="Close skill editor" onClick={() => setEditing(undefined)}><X size={17} /></button></header><label>Name<input value={name} onChange={event => setName(event.target.value)} maxLength={80} required /></label><label>Description<input value={description} onChange={event => setDescription(event.target.value)} maxLength={500} /></label><label>Procedure<textarea value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={8000} rows={7} required /></label>{error && <p className="ab-error" role="alert">{error}</p>}<footer><button type="button" className="ab-secondary" onClick={() => setEditing(undefined)}>Cancel</button><button type="button" className="ab-primary" disabled={busy === 'save' || !name.trim() || !instructions.trim()} onClick={() => void save()}><Check size={14} />Save skill</button></footer></div></div>}
  </section>;
}
