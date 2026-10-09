const EXPLICIT_MEMORY_RECALL_PATTERNS: RegExp[] = [
  /\bdo you remember\b/i,
  /\bcan you remember\b/i,
  /\bdid you remember\b/i,
  /\bremember when\b/i,
  /\bdid we (?:talk|discuss|speak|chat)\b/i,
  /\bhave we (?:talked|discussed|spoken|chatted)\b/i,
  /\bwhat did (?:i|we) (?:say|decide|discuss|talk about)\b/i,
  /\bwhat (?:was|were) (?:our|my) (?:previous|earlier|last)\b/i,
  /\b(?:last time|earlier chat|previous chat|previous conversation|past conversation)\b/i,
  /\bpreviously discussed\b/i,
  /\brecall (?:our|my|the)\b/i,
  /\bfrom (?:our|my) (?:earlier|previous|past) (?:chat|conversation)\b/i
];

export function isExplicitMemoryRecallPrompt(prompt: string): boolean {
  const text = String(prompt || '').trim();
  if (!text) return false;
  return EXPLICIT_MEMORY_RECALL_PATTERNS.some(pattern => pattern.test(text));
}

export function buildDurableHistorySystemMessage(
  principalId: string,
  durablePastHistory: string,
  prompt: string
): string {
  const recallRequested = isExplicitMemoryRecallPrompt(prompt);

  if (recallRequested) {
    return `DURABLE PRIOR CONVERSATION HISTORY RETRIEVED FROM SERVER DATABASE FOR THIS USER (PRINCIPAL: ${principalId}):
${durablePastHistory}

INSTRUCTIONS FOR EXPLICIT MEMORY RECALL:
- The user is explicitly asking about a prior conversation, decision, preference, or earlier discussion.
- Use the retrieved history as evidence.
- If the requested topic is present, confirm it accurately with specific details.
- If the topic is NOT present in this retrieved history, state: "I did not find a record of that in our recent conversation history."
- Do not claim with absolute certainty that the user never discussed it, because older conversations may not be indexed in the immediate retrieval window.`;
  }

  return `DURABLE PRIOR CONVERSATION HISTORY RETRIEVED FROM SERVER DATABASE FOR THIS USER (PRINCIPAL: ${principalId}):
${durablePastHistory}

INSTRUCTIONS FOR CONTINUITY:
- Treat this history as optional background context, not as the boundary of Aira's knowledge.
- For ordinary factual, explanatory, creative, coding, research, or tool requests, answer the user's actual request normally.
- Never say a fact or topic is unavailable merely because it does not appear in this retrieved conversation history.
- Do not emit the memory-recall fallback phrase unless the user explicitly asks whether something was previously discussed or remembered.
- If current information is required, use the configured live research path according to routing policy.`;
}
