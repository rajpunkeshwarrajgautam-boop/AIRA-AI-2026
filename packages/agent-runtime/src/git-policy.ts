/**
 * Semantic Git Intent & Mutation Policy Engine
 *
 * Implements a strict semantic distinction between read-only Git inspection operations
 * (e.g., branch reporting, HEAD revision, commit metadata/history/SHA, repo status)
 * and mutating Git commands (e.g., git commit, git push, git merge, git rebase,
 * cherry-pick, branch deletion, tag creation).
 *
 * Preserves deny-by-default behavior for unauthorized mutation.
 */

// Mutating Git command and natural language mutation patterns
const gitMutationPatterns: RegExp[] = [
  /\bgit\s+(?:commit|push|merge|rebase|reset|revert|cherry-pick|branch\s+-[dDmM]|checkout\s+-b|switch\s+-c|tag\s+-[as]|clean\s+-[fdx])\b/i,
  /\bcommit\s+(?:the\s+|all\s+|my\s+|these\s+|staged\s+|unstaged\s+|code|changes?|files?|patch|work|fixes?|fix|branch|everything)\b/i,
  /\bcommit\s+and\s+push\b/i,
  /\bcommit\s+-m\b/i,
  /\b(?:make|create|generate)\s+a\s+commit\b/i,
  /\b(?:merge|rebase|cherry-pick)\b/i,
  /\bpush\s+(?:to\s+|changes?|code|branch|commits?|origin|upstream|main|master)\b/i,
  /\bgit\s+push\b/i,
];

// Read-only commit reference patterns (nouns and inspection operations)
const readOnlyCommitPatterns: RegExp[] = [
  /\bcommit\s+(?:sha|hash|id|metadata|history|log|logs|message|author|timestamp|date|info|details|summary|count)\b/i,
  /\b(?:last|latest|recent|head|current|previous|prior)\s+(?:\d{1,2}\s+)?commits?\b/i,
  /\b(?:list|show|view|inspect|read|get|summarize|display|query|report|check)\s+(?:the\s+)?(?:recent\s+|latest\s+|last\s+)?(?:\d{1,2}\s+)?commits?\b/i,
  /\bcommits?\s+(?:in|of|from|on)\s+(?:the\s+)?(?:repo|repository|branch|codebase)\b/i,
  /\bhead\s+(?:revision|sha|hash|commit)\b/i,
];

// General non-git write/mutation verbs
const generalWriteVerbs = /\b(fix|patch|edit|implement|build|deploy|create|modify|update|write|delete|remove|submit|send|publish|install|configure|refactor|upload|purchase|pay)\b/i;

/**
 * Returns true if the text expresses a mutating Git operation.
 * Returns false only when any Git references are exclusively read-only inspection.
 * Defaults to true (deny-by-default) if 'commit' is ambiguous or used imperatively.
 */
export function isMutatingGitIntent(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // 1. Any explicit mutating Git command or pattern is immediately flagged
  for (const pattern of gitMutationPatterns) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // 2. If 'commit' is present, verify whether all occurrences are strictly read-only inspection
  if (/\bcommits?\b/i.test(trimmed)) {
    // If it matches known read-only commit patterns, strip those matched segments
    let remaining = trimmed;
    for (const pattern of readOnlyCommitPatterns) {
      remaining = remaining.replace(new RegExp(pattern.source, 'gi'), ' ');
    }

    // If an unmatched 'commit' still remains, it is treated as an unauthorized imperative verb (deny-by-default)
    if (/\bcommits?\b/i.test(remaining)) {
      return true;
    }

    // All commit occurrences were valid read-only references
    return false;
  }

  return false;
}

/**
 * Returns true if the prompt or text expresses any write, modification,
 * destructive action, or mutating Git operation.
 *
 * Grounded in deny-by-default: only purely read-only requests return false.
 */
export function hasMutationIntent(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // 1. General non-git write/mutation verbs
  if (generalWriteVerbs.test(trimmed)) {
    return true;
  }

  // 2. Git mutation checks
  if (isMutatingGitIntent(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Helper to identify whether a prompt is a read-only Git inspection query.
 */
export function isReadOnlyGitInspection(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  if (hasMutationIntent(text)) return false;

  const gitInspectionPatterns = [
    /\b(?:git|repo|repository)\s+status\b/i,
    /\b(?:git|repo|repository)\s+log\b/i,
    /\b(?:current\s+)?git\s+branch\b/i,
    /\bhead\s+(?:revision|sha|hash|commit)\b/i,
    /\bcommit\s+(?:sha|hash|id|metadata|history|log|logs|message|author|timestamp|date|info|details|summary)\b/i,
    /\b(?:last|latest|recent)\s+(?:\d{1,2}\s+)?commits?\b/i,
    /\bsummarize\s+(?:recent\s+|latest\s+)?(?:\d{1,2}\s+)?commits?\b/i,
  ];

  return gitInspectionPatterns.some(p => p.test(text));
}
