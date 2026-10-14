/** Deterministic parsing of explicitly supported reminder schedules.
 * Unsupported or ambiguous requests must ask for clarification, never guess.
 */
export interface ParsedReminder {
  objective: string;
  name: string;
  cronExpression: string;
  timeZone: string;
  description: string;
}

export type ReminderParseResult =
  | { kind: 'ready'; reminder: ParsedReminder }
  | { kind: 'clarify'; message: string };

function validTimeZone(candidate: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: candidate }); return true; }
  catch { return false; }
}

export function parseReminderRequest(prompt: string, clientTimeZone?: string): ReminderParseResult {
  const original = prompt.trim();
  const lower = original.toLowerCase();
  const explicitZone = /\b(?:ist|india standard time|utc|gmt)\b/i.exec(original)?.[0].toLowerCase();
  const timeZone = explicitZone === 'ist' || explicitZone === 'india standard time'
    ? 'Asia/Kolkata'
    : explicitZone === 'utc' || explicitZone === 'gmt'
    ? 'UTC'
    : clientTimeZone;

  if (!timeZone || !validTimeZone(timeZone)) {
    return { kind: 'clarify', message: 'Which time zone should I use for this reminder? For example, Asia/Kolkata (IST). I have not created a schedule yet.' };
  }

  const hourly = /\b(?:every hour|hourly)\b/i.test(lower);
  const weekly = /\b(?:every|each)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i.exec(lower);
  const weekdays = /\b(?:weekdays|every weekday|each weekday|monday to friday|mon-fri)\b/i.test(lower);
  const daily = /\b(?:daily|every day|each day|every morning|each morning)\b/i.test(lower);
  if (!hourly && !weekly && !weekdays && !daily) {
    return { kind: 'clarify', message: 'How often should I schedule this reminder (daily, weekdays, weekly on a named day, or hourly)? I have not created a schedule yet.' };
  }
  if (hourly && (weekly || weekdays || daily)) {
    return { kind: 'clarify', message: 'Should this run hourly or on the days specified? I have not created a schedule yet.' };
  }

  const timeMatch = /\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(lower);
  if (!hourly && !timeMatch) {
    return { kind: 'clarify', message: 'What time should I use for this reminder? I have not created a schedule yet.' };
  }

  let hour = 0;
  let minute = 0;
  if (timeMatch) {
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2] ?? 0);
    const meridiem = timeMatch[3]?.toLowerCase();
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59 ||
        (meridiem ? hour < 1 || hour > 12 : hour > 23)) {
      return { kind: 'clarify', message: 'The requested time is invalid. Please provide a time such as 10:00 AM. No schedule has been created.' };
    }
    if (meridiem) hour = hour % 12 + (meridiem === 'pm' ? 12 : 0);
  }
  if (hourly && timeMatch) {
    return { kind: 'clarify', message: 'For an hourly reminder, should it run at a particular minute of every hour? Please clarify before I create it.' };
  }

  let dayField = '*';
  let cadence = 'every day';
  if (weekly) {
    const weekdaysMap: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    dayField = String(weekdaysMap[weekly[1]]);
    cadence = 'every ' + weekly[1].replace(/^./, c => c.toUpperCase());
  } else if (weekdays) {
    dayField = '1-5';
    cadence = 'on weekdays';
  } else if (hourly) {
    cadence = 'every hour';
  }

  const cronExpression = hourly ? '0 * * * *' : `${minute} ${hour} * * ${dayField}`;
  const actionText = original
    .replace(/^(?:please\s+)?(?:can you\s+)?(?:remind me to|set (?:up )?a (?:daily )?reminder to|schedule (?:a )?reminder to|create (?:an? )?automation to)\s+/i, '')
    .replace(/\b(?:every|each)\s+(?:day|morning|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi, '')
    .replace(/\b(?:daily|weekdays|hourly|every hour|monday to friday|mon-fri)\b/gi, '')
    .replace(/\b(?:at|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '')
    .replace(/\b(?:ist|india standard time|utc|gmt)\b/gi, '')
    .replace(/[.!?,]+$/g, '')
    .replace(/\s+/g, ' ').trim();

  if (!actionText || actionText.length < 3) {
    return { kind: 'clarify', message: 'What should the reminder say or ask you to do? I have not created a schedule yet.' };
  }
  const objective = actionText.slice(0, 500);
  const name = objective.charAt(0).toUpperCase() + objective.slice(1, 95);
  const timeText = hourly ? 'at the beginning of each hour' : `at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { kind: 'ready', reminder: { objective, name, cronExpression, timeZone, description: `${cadence} ${timeText} (${timeZone})` } };
}

export function isAutomationVerificationRequest(prompt: string, history: Array<{ role: string; content: string }> = []): boolean {
  if (!/\b(?:did you|are you sure|was it|is it|check|verify|already|existing|show|list)\b/i.test(prompt) ||
      !/\b(?:remind|reminder|schedule|automation|created|saved|it)\b/i.test(prompt)) return false;
  return /\b(?:remind|schedule|automation)\b/i.test(prompt) ||
    history.slice(-4).some(item => /\b(?:remind|reminder|automation|schedule)\b/i.test(item.content));
}
