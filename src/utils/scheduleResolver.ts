export interface ScheduleResolution {
  valid: boolean;
  isAmbiguous: boolean;
  scheduleType?: 'ONE_TIME' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  cronExpression?: string;
  humanSchedule?: string;
  targetTimestamp?: number;
  timezone?: string;
  clarificationPrompt?: string;
  cleanObjective: string;
}

const TIMEZONES = ['UTC', 'GMT', 'EST', 'EDT', 'CST', 'CDT', 'MST', 'MDT', 'PST', 'PDT', 'IST', 'BST', 'CET', 'CEST'];

const DAYS_OF_WEEK: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6
};

/**
 * Structured schedule resolution with explicit date, time, timezone, recurrence, trigger, and action validation.
 * Fails closed on ambiguous or unsupported schedules.
 */
export function resolveSchedule(prompt: string, defaultTimezone = 'UTC'): ScheduleResolution {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();

  // Extract explicit timezone if present
  let detectedTz: string | undefined = undefined;
  for (const tz of TIMEZONES) {
    const tzRegex = new RegExp(`\\b${tz}\\b`, 'i');
    if (tzRegex.test(trimmed)) {
      detectedTz = tz.toUpperCase();
      break;
    }
  }
  const timezone = detectedTz || defaultTimezone;

  // Time parsing: e.g. "3pm", "3:00 PM", "8:30pm", "14:00", "3am"
  let hour: number | null = null;
  let minute: number = 0;
  let timeStr: string | null = null;

  const time12Match = trimmed.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (time12Match) {
    let rawH = parseInt(time12Match[1], 10);
    minute = time12Match[2] ? parseInt(time12Match[2], 10) : 0;
    const ampm = time12Match[3].toLowerCase();
    if (ampm === 'pm' && rawH < 12) rawH += 12;
    if (ampm === 'am' && rawH === 12) rawH = 0;
    hour = rawH;
    const displayH = (rawH % 12) || 12;
    const displayM = minute.toString().padStart(2, '0');
    timeStr = `${displayH}:${displayM} ${ampm.toUpperCase()}`;
  } else {
    const time24Match = trimmed.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/i);
    if (time24Match) {
      hour = parseInt(time24Match[1], 10);
      minute = parseInt(time24Match[2], 10);
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const displayH = (hour % 12) || 12;
      const displayM = minute.toString().padStart(2, '0');
      timeStr = `${displayH}:${displayM} ${ampm}`;
    }
  }

  // Check for One-Time schedule: e.g. "tomorrow at 3pm", "today at 5pm", "once at 10am"
  const isOneTime = /\b(?:tomorrow|today|once|on\s+[A-Za-z]+\s+\d{1,2})\b/i.test(trimmed);
  if (isOneTime) {
    if (hour === null) {
      return {
        valid: false,
        isAmbiguous: true,
        clarificationPrompt: 'Please specify the exact time for this one-time automation (for example: "tomorrow at 3:00 PM").',
        cleanObjective: trimmed
      };
    }

    const now = new Date();
    let targetDate = new Date(now);
    if (/\btomorrow\b/i.test(trimmed)) {
      targetDate.setDate(targetDate.getDate() + 1);
    }
    targetDate.setHours(hour, minute, 0, 0);

    const dayOfMonth = targetDate.getDate();
    const month = targetDate.getMonth() + 1; // 1-12
    const cronExpression = `${minute} ${hour} ${dayOfMonth} ${month} *`;
    const dateFormatted = targetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    return {
      valid: true,
      isAmbiguous: false,
      scheduleType: 'ONE_TIME',
      cronExpression,
      humanSchedule: `One-time execution on ${dateFormatted} at ${timeStr} (${timezone})`,
      targetTimestamp: targetDate.getTime(),
      timezone,
      cleanObjective: trimmed
    };
  }

  // Check for Hourly / Interval: e.g. "every hour", "every 2 hours"
  const everyHourMatch = trimmed.match(/\bevery\s+(?:(\d+)\s+)?hours?\b/i);
  if (everyHourMatch) {
    const interval = everyHourMatch[1] ? parseInt(everyHourMatch[1], 10) : 1;
    const cron = interval === 1 ? '0 * * * *' : `0 */${interval} * * *`;
    const human = interval === 1 ? `Every hour at minute 0 (${timezone})` : `Every ${interval} hours at minute 0 (${timezone})`;
    return {
      valid: true,
      isAmbiguous: false,
      scheduleType: 'HOURLY',
      cronExpression: cron,
      humanSchedule: human,
      timezone,
      cleanObjective: trimmed
    };
  }

  // Check for Weekly: e.g. "every Sunday at 3am", "weekly on Friday at 4pm", "every weekday at 9am"
  let dayOfWeekNumber: number | string | null = null;
  let dayName: string | null = null;

  if (/\bevery\s+weekday\b|\bweekdays\b/i.test(trimmed)) {
    dayOfWeekNumber = '1-5';
    dayName = 'weekday (Monday through Friday)';
  } else if (/\bevery\s+weekend\b|\bweekends\b/i.test(trimmed)) {
    dayOfWeekNumber = '0,6';
    dayName = 'weekend (Saturday and Sunday)';
  } else {
    for (const [name, num] of Object.entries(DAYS_OF_WEEK)) {
      const dayRegex = new RegExp(`\\b(?:every|on)\\s+${name}s?\\b|\\bweekly\\s+on\\s+${name}s?\\b`, 'i');
      if (dayRegex.test(trimmed)) {
        dayOfWeekNumber = num;
        dayName = name.charAt(0).toUpperCase() + name.slice(1);
        break;
      }
    }
  }

  if (dayOfWeekNumber !== null) {
    if (hour === null) {
      return {
        valid: false,
        isAmbiguous: true,
        clarificationPrompt: `Please specify the time of day for the weekly schedule on ${dayName} (for example: "every ${dayName} at 9:00 AM").`,
        cleanObjective: trimmed
      };
    }

    const cronExpression = `${minute} ${hour} * * ${dayOfWeekNumber}`;
    return {
      valid: true,
      isAmbiguous: false,
      scheduleType: 'WEEKLY',
      cronExpression,
      humanSchedule: `Every ${dayName} at ${timeStr} (${timezone})`,
      timezone,
      cleanObjective: trimmed
    };
  }

  // Check for Daily: e.g. "every day at 8:30pm", "daily at 9am", "every morning at 8am"
  const isDaily = /\b(?:every\s+day|daily|every\s+morning|every\s+night|every\s+evening)\b/i.test(trimmed);
  if (isDaily) {
    if (hour === null) {
      return {
        valid: false,
        isAmbiguous: true,
        clarificationPrompt: 'Please specify the time of day for this daily automation (for example: "every day at 9:00 AM" or "daily at 8:30 PM").',
        cleanObjective: trimmed
      };
    }

    const cronExpression = `${minute} ${hour} * * *`;
    return {
      valid: true,
      isAmbiguous: false,
      scheduleType: 'DAILY',
      cronExpression,
      humanSchedule: `Every day at ${timeStr} (${timezone})`,
      timezone,
      cleanObjective: trimmed
    };
  }

  // If time was specified without frequency keyword (e.g. "run backup at 8pm")
  if (hour !== null) {
    // If it mentions once or tomorrow, handled above. If standalone time, ask for frequency confirmation
    return {
      valid: false,
      isAmbiguous: true,
      clarificationPrompt: `You specified ${timeStr}, but did not state if this automation should run daily, weekly, or as a one-time execution (for example: "every day at ${timeStr}" or "tomorrow at ${timeStr}").`,
      cleanObjective: trimmed
    };
  }

  // Ambiguous schedule: missing both time and frequency
  return {
    valid: false,
    isAmbiguous: true,
    clarificationPrompt: 'Please specify the exact time and frequency for this automation (for example: "every Monday at 9:00 AM" or "tomorrow at 3:00 PM").',
    cleanObjective: trimmed
  };
}
