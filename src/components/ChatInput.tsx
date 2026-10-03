import React, { useState, useRef, useEffect } from 'react';
import { 
  ArrowUp, 
  Paperclip, 
  X, 
  SlidersHorizontal, 
  Check, 
  Brain, 
  Telescope, 
  Bot
} from 'lucide-react';
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
  currentModel: _currentModel,
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
    if (e.key === 'Enter' && !e.shiftKey) { 
      e.preventDefault(); 
      handleSubmit(); 
    }
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

  const placeholderMap: Record<WorkspaceMode, string> = {
    chat: 'How can Aira help you today?',
    research: 'What would you like Aira to research?',
    agents: 'Describe the outcome you want an agent to deliver...',
    automations: 'Describe the trigger and action to automate...',
    library: 'Ask Aira about your workspace knowledge...',
  };

  const placeholder = placeholderMap[workspaceMode] || placeholderMap.chat;
  const canSubmit = (inputText.trim() || attachments.length > 0) && !isLoading;

  return (
    <div className="w-full max-w-3xl mx-auto px-4 pb-6">
      {/* Claude.ai Signature Input Container */}
      <div className="rounded-2xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark p-3.5 sm:p-4 shadow-[0_4px_20px_-4px_rgba(45,40,30,0.06)] dark:shadow-[0_4px_20px_-4px_rgba(0,0,0,0.5)] focus-within:border-claude-terracotta/40 transition-all duration-200">
        
        {/* Attachments Drawer */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3 pb-3 border-b border-claude-border-light dark:border-claude-border-dark">
            {attachments.map(att => (
              <div 
                key={att.id} 
                className="flex items-center space-x-2 px-2.5 py-1.5 rounded-lg bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-xs text-claude-text-light dark:text-claude-text-dark shadow-sm"
              >
                <Paperclip className="w-3.5 h-3.5 text-claude-terracotta" />
                <span className="truncate max-w-[150px] font-medium">{att.name}</span>
                <span className="text-[10px] text-claude-muted-light dark:text-claude-muted-dark font-mono">({att.size})</span>
                <button 
                  onClick={() => setAttachments(prev => prev.filter(a => a.id !== att.id))} 
                  className="hover:text-red-500 ml-1 p-0.5 rounded transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Text Area */}
        <textarea 
          ref={textareaRef} 
          value={inputText} 
          onChange={e => setInputText(e.target.value)} 
          onKeyDown={handleKeyDown} 
          placeholder={placeholder} 
          rows={1} 
          className="w-full bg-transparent resize-none focus:outline-none text-claude-text-light dark:text-claude-text-dark placeholder-claude-muted-light/60 dark:placeholder-claude-muted-dark/60 text-base leading-relaxed px-1 max-h-[38vh] font-sans selection:bg-claude-terracotta/20" 
        />

        {/* Bottom Action Bar */}
        <div className="flex items-center justify-between pt-2.5 mt-1 select-none gap-2">
          
          {/* Left: Attachment + Mode Toggles */}
          <div className="flex items-center gap-1.5 min-w-0">
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleFileUpload} 
              multiple 
              className="hidden" 
            />
            
            <button 
              onClick={() => fileInputRef.current?.click()} 
              className="p-1.5 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-claude-text-dark transition-colors" 
              title="Add documents or images"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            {/* Mode Pills */}
            <button
              type="button"
              onClick={() => onWorkspaceModeChange(workspaceMode === 'research' ? 'chat' : 'research')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-sans transition-colors ${
                workspaceMode === 'research'
                  ? 'bg-claude-terracotta/10 text-claude-terracotta font-medium'
                  : 'text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark'
              }`}
            >
              <Telescope className="w-3.5 h-3.5" />
              <span>Research</span>
            </button>

            <button
              type="button"
              onClick={() => onWorkspaceModeChange(workspaceMode === 'agents' ? 'chat' : 'agents')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-sans transition-colors ${
                workspaceMode === 'agents'
                  ? 'bg-claude-terracotta/10 text-claude-terracotta font-medium'
                  : 'text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark'
              }`}
            >
              <Bot className="w-3.5 h-3.5" />
              <span>Agents</span>
            </button>

            {/* Style Selector */}
            <div className="relative">
              <button 
                onClick={() => setShowStyleMenu(!showStyleMenu)} 
                className="flex items-center space-x-1 px-2 py-1 rounded-lg text-xs text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark transition-colors" 
                title="Tone options"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{styleMode}</span>
              </button>

              {showStyleMenu && (
                <div className="absolute bottom-10 left-0 w-36 rounded-xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-sm p-1 z-50 text-xs">
                  {(['Normal', 'Concise', 'Explanatory'] as const).map(mode => (
                    <button 
                      type="button" 
                      key={mode} 
                      onClick={() => { setStyleMode(mode); setShowStyleMenu(false); }} 
                      className="w-full px-2.5 py-1.5 rounded-lg cursor-pointer hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark flex items-center justify-between transition-colors text-left"
                    >
                      <span>{mode}</span>
                      {styleMode === mode && <Check className="w-3.5 h-3.5 text-claude-terracotta" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {extendedThinking && (
              <span className="flex items-center space-x-1.5 text-[11px] font-medium text-claude-terracotta px-2.5 py-0.5 rounded-full bg-claude-terracotta/10 border border-claude-terracotta/25 select-none shadow-sm">
                <Brain className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Deep reasoning</span>
              </span>
            )}
          </div>

          {/* Right: Claude Terracotta Send Circle with Luxury Gradient */}
          <button 
            onClick={handleSubmit} 
            disabled={!canSubmit}
            title="Send message (Enter)"
            className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
              canSubmit 
                ? 'gradient-terracotta-btn text-white active:scale-95 cursor-pointer' 
                : 'bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light/40 dark:text-claude-muted-dark/40 cursor-not-allowed'
            }`}
          >
            <ArrowUp className="w-4 h-4 stroke-[2.2]" />
          </button>
        </div>
      </div>

      {/* Claude.ai Disclaimer */}
      <div className="text-center mt-3 text-[11px] text-claude-muted-light dark:text-claude-muted-dark font-sans">
        Aira can make mistakes. Please verify important information.
      </div>
    </div>
  );
};
