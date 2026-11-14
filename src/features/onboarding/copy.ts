export type IntroTone = 'Minimal' | 'Friendly' | 'Playful' | 'Premium';

export const INTRO_COPY: Record<IntroTone, { title: string; description: string }> = {
  Minimal: {
    title: 'What are we working on?',
    description: 'Ask a question, write code, or start an agent.',
  },
  Friendly: {
    title: 'Good to have you here.',
    description: 'Tell AIRA what you are working through. We will take it from there.',
  },
  Playful: {
    title: 'What is on your mind?',
    description: 'A tricky question, a new idea, or a task to hand off?',
  },
  Premium: {
    title: 'Your workspace is ready.',
    description: 'Research with depth. Build with precision. Delegate execution.',
  },
};

export const STARTER_PROMPTS = [
  { id: 'research', label: 'Research', prompt: 'Research a topic with sources and identify what is uncertain.' },
  { id: 'code', label: 'Code', prompt: 'Help me plan and implement a coding task step by step.' },
  { id: 'automate', label: 'Automate', prompt: 'Help me design an automated workflow and explain the required approvals.' },
] as const;
export type StarterId = (typeof STARTER_PROMPTS)[number]['id'];

