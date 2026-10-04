import React, { useState } from 'react';
import { 
  Copy, 
  Check, 
  RotateCw, 
  FileText
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { motion } from 'framer-motion';
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
      particleCount: 20,
      spread: 40,
      origin: { y: 0.6, x: 0.5 },
      colors: ['#D97757', '#C15335', '#F5E3DC']
    });
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div 
      layout
      initial={{ opacity: 0, y: 15, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 120, damping: 20, mass: 0.8 }}
      className={`py-5 px-4 md:px-6 w-full max-w-4xl mx-auto group ${isUser ? 'flex justify-end' : ''}`}
    >
      {isUser ? (
        <div className="flex flex-col items-end max-w-[85%]">
          {userName && (
            <span className="text-[11px] font-mono text-claude-muted-light/70 dark:text-claude-muted-dark/70 mb-1.5 px-1">
              {userName}
            </span>
          )}
          <div className="w-fit bg-claude-surface2-light dark:bg-claude-surface2-dark rounded-2xl px-5 py-3 md:px-6 md:py-4 text-claude-text-light dark:text-claude-text-dark shadow-sm border border-claude-borderMuted-light dark:border-claude-borderMuted-dark">
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 pb-3 mb-2 border-b border-claude-border-light dark:border-claude-border-dark">
              {message.attachments.map(att => (
                <div key={att.id} className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-borderMuted-light dark:border-claude-borderMuted-dark text-xs shadow-sm">
                  <FileText className="w-3.5 h-3.5 text-claude-terracotta" />
                  <span className="truncate max-w-[140px] font-medium">{att.name}</span>
                </div>
              ))}
            </div>
          )}
          <div 
            className="aira-prose text-base leading-relaxed break-words whitespace-pre-wrap font-sans"
            dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(message.content) }}
          />
        </div>
      </div>
      ) : (
        <div className="flex items-start space-x-5 w-full">
          <div className="flex-shrink-0 mt-1">
            <AiraMark size="sm" />
          </div>

          <div className="flex-1 min-w-0 space-y-3">
            <div className="flex items-center space-x-2.5">
              <span className="text-sm font-semibold tracking-tight text-claude-text-light dark:text-claude-text-dark">
                Aira
              </span>
              {message.modelUsed && (
                <span className="text-[10px] uppercase font-bold tracking-wider text-claude-muted-light dark:text-claude-muted-dark bg-claude-surface2-light dark:bg-claude-surface2-dark px-2 py-0.5 rounded-full">
                  {AVAILABLE_MODELS.find(model => model.id === message.modelUsed)?.name}
                </span>
              )}
            </div>

            {message.thinking && (
              <ThinkingBlock thinking={message.thinking} />
            )}

            <motion.div layout>
              <div 
                className="aira-prose text-claude-text-light dark:text-claude-text-dark text-base md:text-[17px] leading-[1.7] break-words font-sans"
                dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(message.content) }}
              />
              
              {message.isStreaming && (
                <motion.span 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 1, 0] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                  className="inline-block w-[6px] h-[18px] ml-1.5 bg-claude-terracotta align-middle rounded-full"
                />
              )}
            </motion.div>

            {message.artifacts && message.artifacts.length > 0 && (
              <motion.div layout className="pt-3">
                {message.artifacts.map(artifact => (
                  <ArtifactCard 
                    key={artifact.id} 
                    artifact={artifact} 
                    onOpen={onOpenArtifact} 
                  />
                ))}
              </motion.div>
            )}

            {!message.isStreaming && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="flex items-center space-x-2 pt-1 text-claude-muted-light dark:text-claude-muted-dark opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity duration-200"
              >
                <button
                  onClick={handleCopy}
                  className="p-1.5 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-claude-text-dark text-xs flex items-center space-x-1.5 transition-all duration-200 active:scale-95"
                  title="Copy message"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>

                {onRetry && (
                  <button
                    onClick={onRetry}
                    className="p-1.5 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-claude-text-dark text-xs flex items-center space-x-1.5 transition-all duration-200 active:scale-95"
                    title="Retry response"
                  >
                    <RotateCw className="w-4 h-4" />
                  </button>
                )}
              </motion.div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
};
