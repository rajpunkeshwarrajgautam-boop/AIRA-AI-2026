import React, { useState } from 'react';
import { FolderGit2, Plus, X, Trash2, FileText } from 'lucide-react';
import type { Project, ProjectDoc } from '../types';
import { buildKnowledgeGraphFromDocs } from '../utils/knowledgeGraph';

interface ProjectsModalProps {
  isOpen: boolean;
  onClose: () => void;
  projects: Project[];
  activeProjectId?: string;
  onSelectProject: (id: string | undefined) => void;
  onSaveProject: (project: Project) => void;
  onDeleteProject: (id: string) => void;
}

export const ProjectsModal: React.FC<ProjectsModalProps> = ({
  isOpen, onClose, projects, activeProjectId, onSelectProject, onSaveProject, onDeleteProject,
}) => {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [docs, setDocs] = useState<ProjectDoc[]>([]);
  const [docName, setDocName] = useState('');
  const [docContent, setDocContent] = useState('');

  if (!isOpen) return null;

  const addDoc = () => {
    if (!docName.trim() || !docContent.trim()) return;
    setDocs(prev => [...prev, {
      id: 'doc-' + Date.now(),
      name: docName.trim(),
      content: docContent.trim(),
      size: `${(docContent.length / 1024).toFixed(1)} KB`,
      createdAt: Date.now(),
    }]);
    setDocName('');
    setDocContent('');
  };

  const createProject = async () => {
    if (!name.trim()) return;
    const knowledgeGraph = docs.length ? await buildKnowledgeGraphFromDocs(docs) : undefined;
    const project: Project = {
      id: 'proj-' + Date.now(),
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      docs,
      createdAt: Date.now(),
      knowledgeGraph,
    };
    onSaveProject(project);
    onSelectProject(project.id);
    setName(''); setDescription(''); setInstructions(''); setDocs([]); setCreating(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-2xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light dark:bg-claude-surface-dark shadow-2xl flex flex-col animate-scale-in">
        <header className="px-6 py-4 border-b border-claude-border-light dark:border-claude-border-dark flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-claude-terracotta/10 text-claude-terracotta"><FolderGit2 className="w-5 h-5" /></div>
            <div><h2 className="font-semibold">Aira Projects</h2><p className="text-xs text-claude-muted-light dark:text-claude-muted-dark">Persistent context for related work.</p></div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark"><X className="w-4 h-4" /></button>
        </header>

        <div className="p-6 overflow-y-auto flex-1">
          {!creating ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark">{projects.length} projects</span>
                <button onClick={() => setCreating(true)} className="btn-whimsy px-3 py-2 rounded-xl bg-claude-terracotta text-white text-xs font-medium flex gap-2 items-center"><Plus className="w-3.5 h-3.5" />Create project</button>
              </div>
              <div className="space-y-3">
                {projects.length === 0 && (
                  <div className="py-16 px-6 text-center border border-dashed border-claude-border-light dark:border-claude-border-dark rounded-2xl bg-claude-surface2-light/30 dark:bg-claude-surface2-dark/30 animate-scale-in">
                    <FolderGit2 className="w-8 h-8 mx-auto mb-3 text-claude-terracotta/60" />
                    <h3 className="text-sm font-medium text-claude-text-light dark:text-claude-text-dark mb-1.5">No projects yet</h3>
                    <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark max-w-sm mx-auto mb-4 leading-relaxed">
                      Projects give Aira persistent context. Group your conversations, reference files, and custom instructions together to help Aira understand your specific goals.
                    </p>
                    <button onClick={() => setCreating(true)} className="btn-whimsy px-4 py-2 rounded-xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-sm text-claude-text-light dark:text-claude-text-dark text-xs font-medium mx-auto inline-flex items-center gap-2 hover:border-claude-terracotta/40">
                      <Plus className="w-3.5 h-3.5" /> Start your first project
                    </button>
                  </div>
                )}
                {projects.map(project => (
                  <div key={project.id} className={`p-4 rounded-xl border ${project.id === activeProjectId ? 'border-claude-terracotta bg-claude-terracotta/5' : 'border-claude-border-light dark:border-claude-border-dark'}`}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold truncate">{project.name}</h3>
                        {project.description && <p className="text-xs mt-1 text-claude-muted-light dark:text-claude-muted-dark">{project.description}</p>}
                        <p className="text-[11px] mt-2 text-claude-muted-light dark:text-claude-muted-dark flex items-center gap-1"><FileText className="w-3 h-3" />{project.docs.length} knowledge docs</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => { onSelectProject(project.id === activeProjectId ? undefined : project.id); onClose(); }} className="px-3 py-1.5 rounded-lg bg-claude-terracotta text-white text-xs">{project.id === activeProjectId ? 'Clear' : 'Open'}</button>
                        <button onClick={() => onDeleteProject(project.id)} className="p-1.5 rounded-lg hover:bg-red-500/10 hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Project name" className="w-full px-3.5 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark outline-none focus:border-claude-terracotta text-sm" />
              <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description" className="w-full px-3.5 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark outline-none focus:border-claude-terracotta text-sm" />
              <textarea value={instructions} onChange={e => setInstructions(e.target.value)} rows={3} placeholder="Project instructions for Aira" className="w-full px-3.5 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark outline-none focus:border-claude-terracotta text-sm" />
              <div className="p-3 rounded-xl border border-claude-border-light dark:border-claude-border-dark space-y-2">
                <div className="text-xs font-semibold">Add knowledge document</div>
                <input value={docName} onChange={e => setDocName(e.target.value)} placeholder="Document title" className="w-full px-3 py-2 rounded-lg bg-transparent border border-claude-border-light dark:border-claude-border-dark text-xs" />
                <textarea value={docContent} onChange={e => setDocContent(e.target.value)} rows={3} placeholder="Paste document content" className="w-full px-3 py-2 rounded-lg bg-transparent border border-claude-border-light dark:border-claude-border-dark text-xs" />
                <button onClick={addDoc} className="text-xs px-3 py-1.5 rounded-lg bg-claude-surface2-light dark:bg-claude-surface2-dark">+ Add doc ({docs.length})</button>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setCreating(false)} className="px-4 py-2 text-xs">Cancel</button>
                <button onClick={createProject} disabled={!name.trim()} className="btn-whimsy px-4 py-2 rounded-xl bg-claude-terracotta text-white text-xs disabled:opacity-40">Create project</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
