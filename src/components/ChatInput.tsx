import React, { useState, useRef, useEffect } from 'react';
import { ArrowUp, Paperclip, X, SlidersHorizontal, Check, Brain, Telescope, Wrench, Bot, MessageSquareText } from 'lucide-react';
import type { Attachment, ModelId, WorkspaceMode } from '../types';

interface ChatInputProps {
  onSendMessage: (text: string, attachments: Attachment[]) => void;
  isLoading: boolean;
  onStop?: () => void;
  currentModel: ModelId;
  extendedThinking: boolean;
  workspaceMode: WorkspaceMode;
  onWorkspaceModeChange: (mode: WorkspaceMode) => void;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  isLoading,
  currentModel,
  extendedThinking,
  workspaceMode,
  onWorkspaceModeChange,
}) => {
  const [inputText, setInputText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [styleMode, setStyleMode] = useState<'Normal' | 'Concise' | 'Explanatory'>('Normal');
  const [showStyleMenu, setShowStyleMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 220)}px`;
    }
  }, [inputText]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const handleSubmit = () => {
    const trimmed = inputText.trim();
    if ((!trimmed && attachments.length === 0) || isLoading) return;
    let finalPrompt = trimmed;
    if (styleMode === 'Concise') finalPrompt = `[Style: Please respond concisely and directly] ${trimmed}`;
    else if (styleMode === 'Explanatory') finalPrompt = `[Style: Please explain in detail with a structured breakdown] ${trimmed}`;
    onSendMessage(finalPrompt, attachments);
    setInputText('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = event => {
        const content = event.target?.result as string;
        setAttachments(prev => [...prev, {
          id: 'att-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          name: file.name,
          size: `${(file.size / 1024).toFixed(1)} KB`,
          type: file.type || 'text/plain',
          content,
        }]);
      };
      if (file.type.startsWith('image/')) reader.readAsDataURL(file); else reader.readAsText(file);
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const modeButton = (mode: WorkspaceMode, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      onClick={() => onWorkspaceModeChange(workspaceMode === mode ? 'chat' : mode)}
      className={`hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] transition border ${workspaceMode === mode ? 'bg-claude-terracotta/12 text-claude-terracotta border-claude-terracotta/25' : 'text-claude-muted-light dark:text-claude-muted-dark border-transparent hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark'}`}
    >
      {icon}<span>{label}</span>
    </button>
  );

  const placeholder = workspaceMode === 'research' ? 'What should Aira research?' : workspaceMode === 'agents' ? 'Describe the outcome you want an agent to deliver...' : workspaceMode === 'automations' ? 'Describe the trigger and action to automate...' : workspaceMode === 'library' ? 'Ask Aira about your workspace knowledge...' : 'Ask Aira anything...';

  return (
    <div className="w-full max-w-4xl mx-auto px-4 pb-4">
      <div className="relative rounded-2xl bg-claude-surface-light/95 dark:bg-claude-surface-dark/95 border border-claude-border-light dark:border-claude-border-dark shadow-claude-input dark:shadow-claude-input-dark p-3.5 transition-all duration-200 focus-within:border-claude-terracotta/50 focus-within:ring-4 focus-within:ring-claude-terracotta/5 backdrop-blur-xl">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 pb-2.5 border-b border-claude-border-light/60 dark:border-claude-border-dark/60">
            {attachments.map(att => (
              <div key={att.id} className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-xs text-claude-text-light dark:text-claude-text-dark">
                <Paperclip className="w-3.5 h-3.5 text-claude-terracotta" /><span className="truncate max-w-[140px] font-medium">{att.name}</span>
                <button onClick={() => setAttachments(prev => prev.filter(a => a.id !== att.id))} className="hover:text-red-500 ml-1 p-0.5 rounded"><X className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
        )}

        <textarea ref={textareaRef} value={inputText} onChange={e => setInputText(e.target.value)} onKeyDown={handleKeyDown} placeholder={placeholder} rows={1} className="w-full bg-transparent resize-none focus:outline-none text-claude-text-light dark:text-claude-text-dark placeholder-claude-muted-light/60 dark:placeholder-claude-muted-dark/60 text-[15px] md:text-base leading-relaxed px-1 max-h-56" />

        <div className="flex items-center justify-between pt-2.5 border-t border-claude-border-light/40 dark:border-claude-border-dark/40 mt-1 select-none gap-2">
          <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
            <input type="file" ref={fileInputRef} onChange={handleFileUpload} multiple className="hidden" />
            <button onClick={() => fileInputRef.current?.click()} className="p-1.5 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-claude-text-dark transition" title="Add files"><Paperclip className="w-4 h-4" /></button>
            {modeButton('research', 'Research', <Telescope className="w-3 h-3" />)}
            {modeButton('agents', 'Agent', <Bot className="w-3 h-3" />)}
            <button type="button" className="hidden md:flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark transition" title="Tool routing shell"><Wrench className="w-3 h-3" /><span>Tools</span></button>
            <div className="relative">
              <button onClick={() => setShowStyleMenu(!showStyleMenu)} className="flex items-center space-x-1 px-2 py-1 rounded-lg text-[11px] text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark transition" title="Response style"><SlidersHorizontal className="w-3 h-3" /><span className="hidden lg:inline">{styleMode}</span></button>
              {showStyleMenu && (
                <div className="absolute bottom-8 left-0 w-40 rounded-xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-claude-popup p-1 z-50 text-xs">
                  {(['Normal', 'Concise', 'Explanatory'] as const).map(mode => (
                    <button type="button" key={mode} onClick={() => { setStyleMode(mode); setShowStyleMenu(false); }} className="w-full px-2.5 py-1.5 rounded-lg cursor-pointer hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark flex items-center justify-between"><span>{mode}</span>{styleMode === mode && <Check className="w-3 h-3 text-claude-terracotta" />}</button>
                  ))}
                </div>
              )}
            </div>
            {currentModel === 'claude-3-7-sonnet' && extendedThinking && <span className="hidden lg:flex items-center space-x-1.5 text-[10px] text-violet-300 px-2 py-0.5 rounded-full bg-violet-500/10 border border-violet-500/20"><Brain className="w-3 h-3" /><span>Deep reasoning</span></span>}
          </div>

          <button onClick={handleSubmit} disabled={(!inputText.trim() && attachments.length === 0) || isLoading} className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-150 ${(inputText.trim() || attachments.length > 0) && !isLoading ? 'bg-claude-terracotta hover:bg-claude-terracotta-hover text-white shadow-sm ring-2 ring-claude-terracotta/20 hover:scale-105 active:scale-95' : 'bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light/60 dark:text-claude-muted-dark/60 opacity-60 cursor-not-allowed'}`} title="Send to Aira"><ArrowUp className="w-4 h-4 stroke-[2.5]" /></button>
        </div>
      </div>
      <div className="flex items-center justify-center gap-1.5 mt-2.5 text-[10.5px] text-claude-muted-light/75 dark:text-claude-muted-dark/75 tracking-tight"><MessageSquareText className="w-3 h-3" /><span>Aira routes work across intelligence, knowledge, tools, and execution layers.</span></div>
    </div>
  );
};
