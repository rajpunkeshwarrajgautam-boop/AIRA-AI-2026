/**
 * Server-owned deterministic dispatch for explicitly executable, single-tool requests.
 * A selection is never fabricated from an unrelated default file, formula or form value.
 * Multi-step missions require a real planner/executor, not one arbitrary tool call.
 */
export type ExecutableToolSelection = {
  ok: true;
  name: string;
  args: Record<string, unknown>;
};

export type UnresolvedToolSelection = {
  ok: false;
  code: 'COMPUTER_USE_NOT_AVAILABLE' | 'ACTION_TARGET_UNRESOLVED' |
    'MISSION_EXECUTOR_NOT_READY' | 'FORM_INPUT_NOT_SPECIFIED';
  reason: string;
};

export type ToolSelection = ExecutableToolSelection | UnresolvedToolSelection;

const commandVerbs = /\b(fix|patch|edit|implement|build|deploy|create|modify|update|write|delete|remove|submit|send|publish|install|configure|refactor|commit|merge)\b/i;
const browserFormIntent = /\b(form|input|button|field|submit|log\s*in|sign\s*in)\b/i;
const browserMutation = /\b(fill|populate|type|click|submit|save|log\s*in|sign\s*in)\b/i;
const fileVerb = /\b(read|inspect|view|open|analy[sz]e|examine|show|summarize)\b/i;

function unresolved(code: UnresolvedToolSelection['code'], reason: string): UnresolvedToolSelection {
  return { ok: false, code, reason };
}

function executable(name: string, args: Record<string, unknown>): ExecutableToolSelection {
  return { ok: true, name, args };
}

export function selectExecutableTool(
  rawPrompt: string,
  intent: 'TOOL_ACTION' | 'AGENT_MISSION',
  options: { allowDiagnosticTools?: boolean } = {}
): ToolSelection {
  const prompt = rawPrompt.trim();

  // Controlled test fixtures for crash/recovery certification only.
  // These hang-inducing tools are never selected for public production requests.
  if (options.allowDiagnosticTools) {
    if (/^hang safe$/i.test(prompt)) return executable('hang_safe', {});
    if (/^hang unsafe$/i.test(prompt)) return executable('hang_unsafe', {});
  }

  if (/\b(mouse\s+click|desktop\s+coordinate|computer\s+use|screen\s+coordinate|os\s+control|native\s+app\s+control)\b/i.test(prompt)) {
    return unresolved('COMPUTER_USE_NOT_AVAILABLE', 'Native desktop control requires an attached, verified computer-use runtime.');
  }

  // A multi-step mutation must not be reported complete after merely reading a file or searching.
  if (intent === 'AGENT_MISSION' && commandVerbs.test(prompt)) {
    return unresolved('MISSION_EXECUTOR_NOT_READY', 'This request requires a multi-step execution plan with real write-capable tools and verifiable outcomes. The current single-tool agent path cannot complete it.');
  }

  // Browser form actions require actual field selectors, values, and a session.
  // The former hard-coded "AIRA 2026 Test" value was never user-provided.
  if (browserFormIntent.test(prompt) && browserMutation.test(prompt)) {
    return unresolved('FORM_INPUT_NOT_SPECIFIED', 'Browser form interaction needs a verified live session, field targets, values, and any required approval. No sample data was submitted.');
  }

  // A fully specified read-only repository audit has a real three-tool path.
  if (intent === 'AGENT_MISSION' &&
      /\b(?:inspect|list)\s+(?:the\s+)?workspace\s+files\b/i.test(prompt) &&
      /\b(?:git|repo)\s+status\b/i.test(prompt)) {
    return executable('file_system_list', { directoryPath: '.' });
  }

  // Research missions use a real web lookup rather than arbitrary local repository tools.
  if (intent === 'AGENT_MISSION' &&
      /\b(find|compare|research|investigate)\b/i.test(prompt) &&
      /\b(latest|recent|web\s+sources?|sources)\b/i.test(prompt)) {
    return executable('web_search', { query: prompt });
  }

  const urlMatch = prompt.match(/https?:\/\/[^\s"'<>]+/i);
  if (urlMatch) {
    const url = urlMatch[0].replace(/[),;.!?]+$/, '');
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid protocol');
      return executable(/\bscreenshot\b|\bcapture\s+(?:a\s+)?screen/i.test(prompt)
        ? 'browser_screenshot' : 'browser_navigate', { url: parsed.toString() });
    } catch {
      return unresolved('ACTION_TARGET_UNRESOLVED', 'No valid HTTP(S) browser target was provided.');
    }
  }

  if (/\b(git\s+status|repo\s+status|repository\s+status)\b/i.test(prompt)) {
    return executable('repo_git_status', {});
  }
  if (/\b(git\s+log|latest\s+commits?|recent\s+commits?|commit\s+history|(?:last|latest|recent)\s+\d{1,2}\s+commits?)\b/i.test(prompt)) {
    const n = prompt.match(/\b(?:last|latest|recent)\s+(\d{1,2})\s+commits?\b/i);
    return executable('repo_git_log', { count: n ? Math.min(20, Math.max(1, Number(n[1]))) : 5 });
  }

  const directoryMatch = prompt.match(/\b(?:list(?:\s+files)?\s+(?:in|under)|files\s+in|list\s+directory)\s+([\w./\\-]+)/i);
  if (directoryMatch) {
    return executable('file_system_list', { directoryPath: directoryMatch[1] });
  }

  const pathMatch = prompt.match(/\b(?:read|inspect|view|open|analy[sz]e|examine|show|summarize)\s+(?:the\s+)?(?:file\s+)?(?:contents?\s+of\s+)?([\w./\\-]+\.[a-z\d]{1,10})\b/i);
  if (fileVerb.test(prompt) && pathMatch) {
    return executable('file_system_read', { filePath: pathMatch[1] });
  }

  if (/\b(calculate|compute|evaluate|calculator|\d\s*[+*/^-]\s*\d)\b/i.test(prompt)) {
    // Require an actual numerical expression; never substitute a sample calculation.
    const expression = prompt.match(/\d+(?:\.\d+)?(?:\s*[-+*/^]\s*\d+(?:\.\d+)?)+/);
    if (!expression) {
      return unresolved('ACTION_TARGET_UNRESOLVED', 'A numerical arithmetic expression is required for the calculator tool.');
    }
    return executable('calculator', { expression: expression[0] });
  }

  if (/\b(run\s+(?:this\s+)?(?:shell\s+)?command|execute\s+shell\s+command)\b/i.test(prompt)) {
    const command = prompt.match(/\b(?:run\s+(?:this\s+)?(?:shell\s+)?command|execute\s+shell\s+command)\s*:\s*(.+)$/is)?.[1]?.trim();
    if (!command) {
      return unresolved('ACTION_TARGET_UNRESOLVED', 'Shell execution requires an explicit command following a colon; natural-language instructions are not shell commands.');
    }
    return executable('system_shell', { command });
  }

  if (/\b(search\s+(?:the\s+)?web|web\s+search|find\s+(?:web\s+)?sources?|look\s+up\s+online|research\s+online)\b/i.test(prompt)) {
    return executable('web_search', { query: prompt });
  }

  return unresolved('ACTION_TARGET_UNRESOLVED', 'No executable single-tool target can be identified from this request. AIRA does not substitute a random web search, file, command or calculator input.');
}

/** Continue only a recognized, user-requested, read-only repository inspection. */
export function selectMissionFollowUp(prompt: string, completedSteps: number): ExecutableToolSelection | null {
  const isRepositoryAudit =
    /\b(?:inspect|list)\s+(?:the\s+)?workspace\s+files\b/i.test(prompt) &&
    /\b(?:git|repo)\s+status\b/i.test(prompt) &&
    /\b(?:repo|repository)\s+history\b/i.test(prompt);

  if (!isRepositoryAudit) return null;
  if (completedSteps === 1) return executable('repo_git_status', {});
  if (completedSteps === 2) return executable('repo_git_log', { count: 2 });
  return null;
}
