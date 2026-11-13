// Time formatting for the page: short relative times that tick in the browser, and the exact time
// for tooltips and assistive technology.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Below this, a past time reads "just now" rather than a count of seconds. */
const JUST_NOW_MS = 10 * SECOND;

/**
 * How long ago `iso` was, relative to `now` (milliseconds since the epoch): "just now", "42 s
 * ago", "3 min ago", "5 h ago", "2 d ago", then a short date ("Nov 3") from a week on. A time in
 * the future (clocks a little apart) reads "just now". An unparsable date gives "".
 */
export function formatAgo(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return '';
  }
  const elapsed = now - time;
  if (elapsed < JUST_NOW_MS) {
    return 'just now';
  }
  if (elapsed < MINUTE) {
    return `${String(Math.floor(elapsed / SECOND))} s ago`;
  }
  if (elapsed < HOUR) {
    return `${String(Math.floor(elapsed / MINUTE))} min ago`;
  }
  if (elapsed < DAY) {
    return `${String(Math.floor(elapsed / HOUR))} h ago`;
  }
  if (elapsed < 7 * DAY) {
    return `${String(Math.floor(elapsed / DAY))} d ago`;
  }
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(time);
}

/**
 * How long until `iso`: "in 12 s", "in 4 min", "in 2 h"; "in a moment" when due or past. An
 * unparsable date gives "".
 */
export function formatIn(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return '';
  }
  const remaining = time - now;
  if (remaining < SECOND) {
    return 'in a moment';
  }
  return `in ${formatDuration(remaining / SECOND)}`;
}

/** A duration in seconds, rounded up to the unit shown: "45 s", "2 min", "3 h". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${String(Math.ceil(seconds))} s`;
  }
  if (seconds < 3600) {
    return `${String(Math.ceil(seconds / 60))} min`;
  }
  return `${String(Math.ceil(seconds / 3600))} h`;
}

const exactFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

const clockFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/** The full date and time in the reader's locale, for tooltips; "" for an unparsable date. */
export function formatExact(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : exactFormat.format(time);
}

/** The time of day in the reader's locale ("14:05"), for "until 14:05"; "" if unparsable. */
export function formatClock(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : clockFormat.format(time);
}

/** "1 run", "3 runs". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}
