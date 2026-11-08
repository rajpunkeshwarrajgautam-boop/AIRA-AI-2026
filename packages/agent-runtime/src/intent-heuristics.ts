/**
 * Strictly detect repository intent.
 * Generic words such as 'status', 'log', 'branch', or 'diff' on their own MUST NOT trigger repository operations.
 * Requires explicit git/repo/codebase context or explicit git commands.
 */
export function isRepositoryIntent(prompt: string): boolean {
  if (!prompt || typeof prompt !== 'string') return false;
  const lower = prompt.toLowerCase();

  if (/\bgit\s+(?:status|log|diff|branch|commit|show|history|blame)\b/i.test(lower)) return true;
  if (/\b(?:repo|repository|codebase)\s+(?:status|log|diff|branch|commits?|history|state|inspect)\b/i.test(lower)) return true;

  const hasRepoContext = /\b(?:git|repo|repository|codebase|github)\b/i.test(lower);
  if (!hasRepoContext) return false;

  return /\b(?:status|log|diff|branch|commits?|history|head|tracking|inspect|read)\b/i.test(lower) ||
         /\b(?:check|inspect|show|display|get)\s+(?:the\s+)?(?:git|repo|repository|codebase)\b/i.test(lower);
}

/**
 * Deterministically extracts valid mathematical expressions from prompt text.
 * Requires genuine arithmetic operator (+, -, *, /, ^) between numbers or inside formula parentheses.
 * Rejects standalone numbers (e.g. years "2026", PR numbers), generic keywords without operators,
 * and never invents default expressions.
 */
export function extractCalculatorExpression(prompt: string): string {
  if (!prompt || typeof prompt !== 'string') return '';
  const trimmed = prompt.trim();

  const formulaMatch = trimmed.match(/(?:\((?:[0-9+\-*/().^\s]+)\)|[0-9]+(?:\.[0-9]+)?\s*[-+*/^]\s*[0-9]+(?:\.[0-9]+)?(?:[0-9+\-*/().^\s]*))/);
  if (formulaMatch && formulaMatch[0]) {
    const cleaned = formulaMatch[0].replace(/[^0-9+\-*/().^ ]/g, '').replace(/[. ]+$/, '').trim();
    if (cleaned.length > 0 && /[0-9]/.test(cleaned) && /[-+*/^]/.test(cleaned)) {
      return cleaned;
    }
  }

  const keywordMatch = trimmed.match(/\b(?:calculate|calculator|calc|compute)\b\s*:?\s*([0-9+\-*/().^]*[0-9]+[0-9+\-*/().^ ]*)/i);
  if (keywordMatch && keywordMatch[1] && /[+\-*/^]/.test(keywordMatch[1])) {
    const cleaned = keywordMatch[1].replace(/[^0-9+\-*/().^ ]/g, '').replace(/[. ]+$/, '').trim();
    if (cleaned.length > 0 && /[0-9]/.test(cleaned) && /[-+*/^]/.test(cleaned)) {
      return cleaned;
    }
  }

  return '';
}
