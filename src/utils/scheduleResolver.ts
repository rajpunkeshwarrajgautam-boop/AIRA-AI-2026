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

/**
 * Ambiguous timezone abbreviations that cannot be safely mapped to a unique UTC offset
 * (e.g. CST can mean US Central, China Standard, or Cuba Standard; IST can mean India, Israel, or Ireland).
 */
const AMBIGUOUS_TIMEZONE_ABBREVIATIONS = [
  'EST', 'EDT', 'CST', 'CDT', 'MST', 'MDT', 'PST', 'PDT', 
  'IST', 'BST', 'CET', 'CEST', 'AEST', 'AEDT', 'JST', 'KST', 'HKT', 'SGT'
];

/**
 * Validates whether a timezone identifier is a recognized, valid IANA timezone name.
 */
export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  const upper = tz.toUpperCase();
  if (upper === 'UTC' || upper === 'GMT') return true;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface WallClockDateTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;  // 0-23
  minute: number; // 0-59
  second?: number;
}

/**
 * Gets the wall-clock calendar and time components for a given Date in a specific IANA timezone.
 */
export function getWallClockInTimezone(date: Date, timeZone: string): WallClockDateTime {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const partMap: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      partMap[p.type] = parseInt(p.value, 10);
    }
  }
  const hour = partMap.hour === 24 ? 0 : partMap.hour;
  return {
    year: partMap.year,
    month: partMap.month,
    day: partMap.day,
    hour,
    minute: partMap.minute,
    second: partMap.second || 0
  };
}

/**
 * Converts a wall-clock date and time in an IANA timezone into an exact UTC epoch milliseconds.
 * Explicitly handles DST spring-forward gaps (nonexistent local times) and fall-back overlaps (ambiguous local times).
 */
export function wallClockToUtcEpoch(
  wallClock: WallClockDateTime,
  timeZone: string
): { epochMs: number; isAmbiguous: boolean; isNonexistent: boolean } {
  const { year, month, day, hour, minute, second = 0 } = wallClock;
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  const obs1 = getWallClockInTimezone(new Date(guessUtc), timeZone);
  const obsUtc1 = Date.UTC(obs1.year, obs1.month - 1, obs1.day, obs1.hour, obs1.minute, obs1.second);
  const offset1 = guessUtc - obsUtc1;
  let candidateEpoch = guessUtc + offset1;

  const obs2 = getWallClockInTimezone(new Date(candidateEpoch), timeZone);
  const obsUtc2 = Date.UTC(obs2.year, obs2.month - 1, obs2.day, obs2.hour, obs2.minute, obs2.second);

  let isAmbiguous = false;
  let isNonexistent = false;

  if (obsUtc2 !== guessUtc) {
    // Wall-clock time falls in a DST spring-forward gap (nonexistent local time)
    isNonexistent = true;
    const diff = guessUtc - obsUtc2;
    candidateEpoch = candidateEpoch + diff;
  } else {
    // Check if wall-clock falls in a DST fall-back repeated hour (ambiguous local time)
    const checkLater = getWallClockInTimezone(new Date(candidateEpoch + 3600_000), timeZone);
    const checkEarlier = getWallClockInTimezone(new Date(candidateEpoch - 3600_000), timeZone);
    const wallMatches = (obs: WallClockDateTime) => 
      obs.year === year && obs.month === month && obs.day === day && obs.hour === hour && obs.minute === minute;

    if (wallMatches(checkLater) || wallMatches(checkEarlier)) {
      isAmbiguous = true;
    }
  }

  return { epochMs: candidateEpoch, isAmbiguous, isNonexistent };
}

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

  // 1. Detect ambiguous timezone abbreviations
  for (const abbr of AMBIGUOUS_TIMEZONE_ABBREVIATIONS) {
    const abbrRegex = new RegExp(`\\b${abbr}\\b`, 'i');
    if (abbrRegex.test(trimmed)) {
      return {
        valid: false,
        isAmbiguous: true,
        clarificationPrompt: `Ambiguous timezone abbreviation "${abbr.toUpperCase()}" detected. Please specify an unambiguous IANA timezone (for example: "UTC", "America/New_York", "Europe/London", or "Asia/Kolkata").`,
        cleanObjective: trimmed
      };
    }
  }

  // 2. Extract explicit IANA timezone if specified (e.g. "UTC", "America/New_York", "Asia/Kolkata")
  let detectedTz: string | undefined = undefined;
  const tzMatch = trimmed.match(/\b(?:in|timezone|tz\s*:?)\s+([A-Za-z_]+(?:\/[A-Za-z_]+)?)\b/i) ||
                  trimmed.match(/\b(UTC|GMT|America\/[A-Za-z_]+|Europe\/[A-Za-z_]+|Asia\/[A-Za-z_]+|Australia\/[A-Za-z_]+|Pacific\/[A-Za-z_]+)\b/i);

  if (tzMatch) {
    const candidateTz = tzMatch[1];
    if (isValidIanaTimezone(candidateTz)) {
      detectedTz = candidateTz.toUpperCase() === 'UTC' || candidateTz.toUpperCase() === 'GMT' ? candidateTz.toUpperCase() : candidateTz;
    } else {
      return {
        valid: false,
        isAmbiguous: true,
        clarificationPrompt: `Invalid timezone specified ("${candidateTz}"). Please provide a recognized IANA timezone (such as "UTC", "America/New_York", or "Europe/London").`,
        cleanObjective: trimmed
      };
    }
  }

  const timezone = detectedTz || defaultTimezone;
  if (!isValidIanaTimezone(timezone)) {
    return {
      valid: false,
      isAmbiguous: true,
      clarificationPrompt: `Invalid default timezone ("${timezone}"). Please provide a valid IANA timezone.`,
      cleanObjective: trimmed
    };
  }

  // 3. Time parsing: e.g. "3pm", "3:00 PM", "8:30pm", "14:00", "3am"
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

  // 4. Check for One-Time schedule: e.g. "tomorrow at 3pm", "today at 5pm", "once at 10am"
  const isOneTime = /\b(?:tomorrow|today|once|on\s+[A-Za-z]+\s+\d{1,2})\b/i.test(trimmed);
  if (isOneTime) {
    if (hour === null) {
      return {
        valid: false,
        isAmbiguous: true,
        clarificationPrompt: 'Please specify the exact time for this one-time automation (for example: "tomorrow at 3:00 PM UTC").',
        cleanObjective: trimmed
      };
    }

    // Determine target calendar date in the target timezone
    const nowWall = getWallClockInTimezone(new Date(), timezone);
    let targetYear = nowWall.year;
    let targetMonth = nowWall.month;
    let targetDay = nowWall.day;

    if (/\btomorrow\b/i.test(trimmed)) {
      const nextDay = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay + 1));
      targetYear = nextDay.getUTCFullYear();
      targetMonth = nextDay.getUTCMonth() + 1;
      targetDay = nextDay.getUTCDate();
    } else if (/\btoday\b/i.test(trimmed)) {
      // Keep today's date in target timezone
    } else {
      const dateMatch = trimmed.match(/\bon\s+([A-Za-z]+)\s+(\d{1,2})\b/i);
      if (dateMatch) {
        const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
        const shortMonths = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const mStr = dateMatch[1].toLowerCase();
        let mIdx = monthNames.indexOf(mStr);
        if (mIdx === -1) mIdx = shortMonths.indexOf(mStr);
        if (mIdx !== -1) {
          targetMonth = mIdx + 1;
          targetDay = parseInt(dateMatch[2], 10);
        }
      }
    }

    // Timezone-aware conversion from wall-clock to exact UTC epoch
    const { epochMs, isAmbiguous, isNonexistent } = wallClockToUtcEpoch(
      { year: targetYear, month: targetMonth, day: targetDay, hour, minute },
      timezone
    );

    // Validate future timestamp
    if (epochMs <= Date.now()) {
      return {
        valid: false,
        isAmbiguous: true,
        clarificationPrompt: 'The scheduled one-time execution time must be in the future. Please specify a future date and time.',
        cleanObjective: trimmed
      };
    }

    const dateFormatted = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(new Date(epochMs));

    let humanNote = `One-time execution on ${dateFormatted} at ${timeStr} (${timezone})`;
    if (isNonexistent) {
      humanNote += ` [Note: Wall-clock time falls in daylight saving transition gap; scheduled for valid post-transition time]`;
    } else if (isAmbiguous) {
      humanNote += ` [Note: Daylight saving repeated hour; scheduled for first occurrence]`;
    }

    // GENUINE ONE-TIME CONTRACT: Do NOT generate a recurring 5-field yearly cron!
    // cronExpression is omitted/undefined. targetTimestamp stores the absolute future execution epoch.
    return {
      valid: true,
      isAmbiguous: false,
      scheduleType: 'ONE_TIME',
      cronExpression: undefined,
      humanSchedule: humanNote,
      targetTimestamp: epochMs,
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
