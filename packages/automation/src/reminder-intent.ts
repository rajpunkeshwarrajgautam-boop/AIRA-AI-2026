import { CronExpressionParser } from 'cron-parser';

export interface ParsedReminder {
  kind: 'create';
  objective: string;
  name: string;
  cronExpression: string;
  timeZone: string;
  nextRun: number;
  summary: string;
}
export interface ReminderClarification { kind: 'clarify'; message: string }
export type ReminderIntent = ParsedReminder | ReminderClarification;

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6
};

export function validTimeZone(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length > 100) return undefined;
  const aliases: Record<string, string> = { IST: 'Asia/Kolkata', UTC: 'UTC', GMT: 'UTC' };
  const candidate = aliases[input.trim().toUpperCase()] || input.trim();
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** Parse only explicit reminders; never guess an hour, recurrence, or timezone. */
export function parseReminderIntent(prompt: string, callerTimeZone?: string, now = Date.now()): ReminderIntent {
  const request = prompt.trim().replace(/[.!?]+$/, '');
  const match = request.match(/^(?:please\s+)?(?:remind me to|set (?:a )?reminder to|schedule (?:a )?reminder to)\s+(.+)$/i);
  if (!match) {
    return { kind: 'clarify', message: 'What would you like me to remind you about, and when should I remind you?' };
  }

  const full = match[1].trim();
  const recurrence = /\b(every\s+day|daily|every\s+weekday|on\s+weekdays|every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.exec(full);
  if (!recurrence) return {
    kind: 'clarify',
    message: 'How often should I remind you (for example, every day or every Monday), and at what time?'
  };

  const objective = full.slice(0, recurrence.index).trim().replace(/[,;\s]+$/, '');
  if (!objective) return { kind: 'clarify', message: 'What should the reminder say?' };

  const afterRecurrence = full.slice(recurrence.index + recurrence[0].length);
  const timeMatch = /\bat\s+(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b/i.exec(afterRecurrence)
    || /\bat\s+([01]?\d|2[0-3]):([0-5]\d)\b/i.exec(afterRecurrence);
  if (!timeMatch) return {
    kind: 'clarify',
    message: 'What time should I send this reminder? Please specify a time such as 10:00 AM.'
  };

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] || '0');
  const meridiem = timeMatch[3]?.toLowerCase();
  if (meridiem && (hour < 1 || hour > 12)) return {
    kind: 'clarify', message: 'Please specify a valid time, such as 10:00 AM.'
  };
  if (meridiem) hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
  if (hour > 23) return { kind: 'clarify', message: 'Please specify a valid time.' };

  const suffix = afterRecurrence.slice(timeMatch.index + timeMatch[0].length).trim();
  const tzLiteral = /\b(?:in\s+)?(Asia\/[\w+-]+|Europe\/[\w+-]+|America\/[\w+-]+|Australia\/[\w+-]+|Africa\/[\w+-]+|Pacific\/[\w+-]+|UTC|GMT|IST)\b/i.exec(suffix)?.[1];
  const timeZone = validTimeZone(tzLiteral || callerTimeZone);
  if (!timeZone) return {
    kind: 'clarify', message: 'Which timezone should I use for this reminder? For example, Asia/Kolkata or UTC.'
  };

  const cadence = recurrence[0].toLowerCase().replace(/\s+/g, ' ');
  let days = '*';
  let summary = 'every day';
  if (cadence.includes('weekday')) { days = '1-5'; summary = 'every weekday'; }
  else if (cadence.startsWith('every ') && cadence !== 'every day') {
    const day = cadence.slice(6);
    days = String(WEEKDAYS[day]);
    summary = `every ${day[0].toUpperCase() + day.slice(1)}`;
  }

  const cronExpression = `${minute} ${hour} * * ${days}`;
  const nextRun = CronExpressionParser.parse(cronExpression, {
    currentDate: new Date(now),
    tz: timeZone
  }).next().getTime();
  const displayHour = hour % 12 || 12;
  const displayTime = `${displayHour}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
  return {
    kind: 'create',
    objective,
    name: `Reminder: ${objective.slice(0, 80)}`,
    cronExpression,
    timeZone,
    nextRun,
    summary: `${summary} at ${displayTime} (${timeZone})`
  };
}
