import React, { useState } from 'react';
import { FolderGit2, Plus, X, Trash2, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
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
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="absolute inset-0 bg-white/20 dark:bg-black/40 backdrop-blur-md"
            onClick={onClose}
          />
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="w-full max-w-3xl max-h-[85vh] overflow-hidden rounded-[2rem] border border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light dark:bg-claude-surface-dark backdrop-blur-2xl shadow-sm flex flex-col relative z-10"
          >
            <header className="px-5 sm:px-8 py-4 sm:py-5 border-b border-claude-border-light dark:border-claude-border-dark flex items-center justify-between bg-claude-surface2-light dark:bg-claude-surface2-dark">
              <div className="flex items-center gap-3 sm:gap-4">
                <div className="p-2 sm:p-2.5 rounded-2xl bg-claude-terracotta/10 text-claude-terracotta shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
                  <FolderGit2 className="w-5 h-5 sm:w-6 sm:h-6" />
                </div>
                <div>
                  <h2 className="font-bold text-base sm:text-lg tracking-tight text-claude-text-light dark:text-white">Aira Projects</h2>
                  <p className="text-[10px] sm:text-[11px] font-medium text-claude-muted-light dark:text-claude-muted-dark tracking-wide uppercase mt-0.5">Persistent context for related work</p>
                </div>
              </div>
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={onClose} 
                className="p-2 rounded-xl hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark transition-colors"
              >
                <X className="w-5 h-5" />
              </motion.button>
            </header>

            <div className="p-5 sm:p-8 overflow-y-auto flex-1 bg-transparent">
              <AnimatePresence mode="wait">
                {!creating ? (
                  <motion.div key="list" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-6">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-claude-muted-light dark:text-claude-muted-dark">{projects.length} projects</span>
                      <motion.button 
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => setCreating(true)} 
                        className="px-4 py-2.5 rounded-xl bg-claude-text-light dark:bg-claude-text-dark hover:bg-claude-terracotta transition-colors text-claude-bg-light dark:text-claude-bg-dark text-[13px] font-bold shadow-sm flex gap-2 items-center"
                      >
                        <Plus className="w-4 h-4" /> Create project
                      </motion.button>
                    </div>
                    <div className="grid gap-4">
                      {projects.length === 0 && (
                        <div className="py-20 px-8 text-center border-2 border-dashed border-claude-border-light dark:border-claude-border-dark rounded-[2rem] bg-claude-surface2-light dark:bg-claude-surface2-dark">
                          <FolderGit2 className="w-12 h-12 mx-auto mb-4 text-claude-terracotta/40" />
                          <h3 className="text-base font-bold text-claude-text-light dark:text-white mb-2">No projects yet</h3>
                          <p className="text-[13px] text-claude-muted-light dark:text-claude-muted-dark max-w-sm mx-auto mb-6 leading-relaxed font-medium">
                            Projects give Aira persistent context. Group your conversations, reference files, and custom instructions together to help Aira understand your specific goals.
                          </p>
                          <motion.button 
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => setCreating(true)} 
                            className="px-5 py-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark hover:border-claude-terracotta/50 transition-colors shadow-sm text-claude-text-light dark:text-claude-text-dark text-[13px] font-bold mx-auto inline-flex items-center gap-2"
                          >
                            <Plus className="w-4 h-4" /> Start your first project
                          </motion.button>
                        </div>
                      )}
                      {projects.map(project => (
                        <motion.div 
                          layout
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          key={project.id} 
                          className={`p-5 rounded-2xl border transition-all duration-300 ${project.id === activeProjectId ? 'border-claude-terracotta/50 bg-claude-terracotta/5 shadow-sm' : 'border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark hover:border-claude-terracotta/30'}`}
                        >
                          <div className="flex items-start justify-between gap-5">
                            <div className="min-w-0 flex-1">
                              <h3 className="text-base font-bold truncate tracking-tight text-claude-text-light dark:text-white">{project.name}</h3>
                              {project.description && <p className="text-[13px] font-medium mt-1 text-claude-muted-light dark:text-claude-muted-dark leading-snug">{project.description}</p>}
                              <p className="text-[11px] font-bold uppercase tracking-wider mt-3 text-claude-muted-light dark:text-claude-muted-dark flex items-center gap-1.5"><FileText className="w-3.5 h-3.5 text-claude-terracotta" />{project.docs.length} knowledge docs</p>
                            </div>
                            <div className="flex gap-2.5 shrink-0">
                              <button onClick={() => { onSelectProject(project.id === activeProjectId ? undefined : project.id); onClose(); }} className={`px-4 py-2 rounded-xl font-bold text-[13px] transition-colors ${project.id === activeProjectId ? 'bg-claude-terracotta text-white shadow-sm' : 'bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-text-light dark:text-claude-text-dark hover:bg-claude-border-light dark:hover:bg-claude-border-dark'}`}>
                                {project.id === activeProjectId ? 'Clear' : 'Open'}
                              </button>
                              <button onClick={() => onDeleteProject(project.id)} className="p-2.5 rounded-xl hover:bg-red-50 dark:hover:bg-red-500/10 text-claude-muted-light dark:text-claude-muted-dark hover:text-red-500 transition-colors"><Trash2 className="w-4 h-4" /></button>
                            </div>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </motion.div>
                ) : (
                  <motion.div key="create" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="space-y-5">
                    <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Project name" className="w-full px-4 py-3.5 rounded-2xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark outline-none focus:border-claude-terracotta focus:shadow-sm text-sm font-medium transition-all" />
                    <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description" className="w-full px-4 py-3.5 rounded-2xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark outline-none focus:border-claude-terracotta focus:shadow-sm text-sm font-medium transition-all" />
                    <textarea value={instructions} onChange={e => setInstructions(e.target.value)} rows={4} placeholder="Project instructions for Aira (e.g., 'Always use functional components', 'Focus on SEO')" className="w-full px-4 py-3.5 rounded-2xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark outline-none focus:border-claude-terracotta focus:shadow-sm text-sm font-medium transition-all resize-none" />
                    
                    <div className="p-5 rounded-2xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark space-y-3">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark">Add knowledge document</div>
                      <input value={docName} onChange={e => setDocName(e.target.value)} placeholder="Document title" className="w-full px-3.5 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-medium outline-none focus:border-claude-terracotta/50 transition-colors" />
                      <textarea value={docContent} onChange={e => setDocContent(e.target.value)} rows={3} placeholder="Paste document content (code, API specs, guidelines)" className="w-full px-3.5 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-medium outline-none focus:border-claude-terracotta/50 transition-colors resize-none font-mono" />
                      <button onClick={addDoc} className="text-[13px] font-bold px-4 py-2 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark hover:bg-claude-border-light dark:hover:bg-claude-border-dark transition-colors inline-flex items-center gap-2">
                        <Plus className="w-4 h-4" /> Add to Knowledge ({docs.length})
                      </button>
                    </div>

                    <div className="flex justify-end gap-3 pt-4 border-t border-claude-border-light dark:border-claude-border-dark">
                      <button onClick={() => setCreating(false)} className="px-5 py-2.5 rounded-xl text-[13px] font-bold text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-claude-text-dark transition-colors">Cancel</button>
                      <button onClick={createProject} disabled={!name.trim()} className="px-5 py-2.5 rounded-xl bg-claude-text-light dark:bg-claude-text-dark hover:bg-claude-terracotta text-claude-bg-light dark:text-claude-bg-dark text-[13px] font-bold transition-all shadow-sm disabled:opacity-40 disabled:hover:bg-claude-text-light disabled:dark:hover:bg-claude-text-dark">Create project</button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
