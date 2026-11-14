import React from 'react';
import { STARTER_PROMPTS, type StarterId } from './copy';

interface StarterChipsProps {
  onSelect: (id: StarterId, prompt: string) => void;
  disabled?: boolean;
}

export function StarterChips({ onSelect, disabled = false }: StarterChipsProps) {
  return (
    <div className="aira-v3-starters" role="group" aria-label="Start with AIRA">
      {STARTER_PROMPTS.map((starter, index) => (
        <button
          key={starter.id}
          type="button"
          className="aira-v3-starter"
          style={{ '--stagger-delay': `${index * 40}ms` } as React.CSSProperties}
          disabled={disabled}
          onClick={() => onSelect(starter.id, starter.prompt)}
        >
          {starter.label}
        </button>
      ))}
    </div>
  );
}

