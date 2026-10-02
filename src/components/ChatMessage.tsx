import React, { useState } from 'react';
import { 
  Copy, 
  Check, 
  RotateCw, 
  FileText
} from 'lucide-react';
import confetti from 'canvas-confetti';
import type { Message, Artifact } from '../types';
import { AVAILABLE_MODELS } from '../utils/constants';
import { AiraMark } from './AiraMark';
import { renderMarkdownToHtml } from '../utils/markdown';
import { ThinkingBlock } from './ThinkingBlock';
import { ArtifactCard } from './ArtifactCard';

interface ChatMessageProps {
  message: Message;
  userName: string;
  onOpenArtifact: (artifact: Artifact) => void;
  onRetry?: () => void;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  userName,
  onOpenArtifact,
  onRetry,
}) => {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    confetti({
      particleCount: 15,
      spread: 30,
      origin: { y: 0.6, x: 0.5 },
      colors: ['#7C3AED', '#06B6D4']
    });
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`py-6 px-4 md:px-6 w-full max-w-4xl mx-auto animate-slide-up ${isUser ? '' : 'transition-colors'}`}>
      <div className="flex items-start space-x-3.5">
        {/* Avatar */}
        <div className="flex-shrink-0 mt-0.5">
          {isUser ? (
            <div className="w-8 h-8 rounded-full bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark flex items-center justify-center font-semibold text-xs text-claude-text-light dark:text-claude-text-dark">
              {userName ? userName.slice(0, 2).toUpperCase() : 'ME'}
            </div>
          ) : (
            <AiraMark size="sm" />
          )}
        </div>

        {/* Content Body */}
        <div className="flex-1 min-w-0 space-y-2">
          {/* Header with Name & Model */}
          <div className="flex items-center space-x-2">
            <span className="text-xs font-semibold text-claude-text-light dark:text-claude-text-dark">
              {isUser ? userName || 'You' : 'Aira'}
            </span>
            {!isUser && message.modelUsed && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark border border-claude-border-light/80 dark:border-claude-border-dark/80">
                {AVAILABLE_MODELS.find(model => model.id === message.modelUsed)?.name || 'Aira'}
              </span>
            )}
          </div>

          {/* User Attachments Preview */}
          {isUser && message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1 pb-1">
              {message.attachments.map(att => (
                <div key={att.id} className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-xs">
                  <FileText className="w-3.5 h-3.5 text-claude-terracotta" />
                  <span className="truncate max-w-[140px] font-medium">{att.name}</span>
                  <span className="text-[10px] text-claude-muted-light dark:text-claude-muted-dark">({att.size})</span>
                </div>
              ))}
            </div>
          )}

          {/* Optional reasoning summary */}
          {!isUser && message.thinking && (
            <ThinkingBlock thinking={message.thinking} />
          )}

          {/* Rendered Text Content */}
          <div 
            className="aira-prose text-claude-text-light dark:text-claude-text-dark text-sm md:text-base leading-relaxed break-words"
            dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(message.content) }}
          />

          {/* Streaming Cursor */}
          {message.isStreaming && (
            <span className="inline-block w-2 h-4 ml-1 bg-cyan-500 dark:bg-cyan-400 animate-pulse-slow align-middle shadow-[0_0_8px_rgba(34,211,238,0.6)] rounded-[1px]"></span>
          )}

          {/* In-Message Artifact Cards */}
          {!isUser && message.artifacts && message.artifacts.length > 0 && (
            <div className="pt-2">
              {message.artifacts.map(artifact => (
                <ArtifactCard 
                  key={artifact.id} 
                  artifact={artifact} 
                  onOpen={onOpenArtifact} 
                />
              ))}
            </div>
          )}

          {/* Message Action Footer (Copy, Retry) */}
          {!isUser && !message.isStreaming && (
            <div className="flex items-center space-x-2 pt-2 text-claude-muted-light dark:text-claude-muted-dark">
              <button
                onClick={handleCopy}
                className="p-1 rounded-md hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-claude-text-dark text-xs flex items-center space-x-1 transition"
                title="Copy message"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                <span className="text-[11px]">{copied ? 'Copied' : 'Copy'}</span>
              </button>

              {onRetry && (
                <button
                  onClick={onRetry}
                  className="p-1 rounded-md hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-claude-text-dark text-xs flex items-center space-x-1 transition"
                  title="Retry response"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                  <span className="text-[11px]">Retry</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
