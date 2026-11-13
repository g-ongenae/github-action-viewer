import { describe, expect, it } from 'vitest';
import { formatAgo, formatDuration, formatExact, formatIn, plural } from './format.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const before = (ms: number): string => new Date(NOW - ms).toISOString();

describe('formatAgo', () => {
  it.each([
    [0, 'just now'],
    [9_999, 'just now'],
    [10_000, '10 s ago'],
    [59_999, '59 s ago'],
    [60_000, '1 min ago'],
    [59 * 60_000, '59 min ago'],
    [3_600_000, '1 h ago'],
    [23.9 * 3_600_000, '23 h ago'],
    [24 * 3_600_000, '1 d ago'],
    [6.9 * 86_400_000, '6 d ago'],
  ])('%i ms ago reads "%s"', (ms, expected) => {
    expect(formatAgo(before(ms), NOW)).toBe(expected);
  });

  it('shows a short date from a week on', () => {
    expect(formatAgo('2026-11-03T08:00:00Z', NOW)).toBe('Nov 3');
  });

  it('reads a time slightly in the future as just now', () => {
    expect(formatAgo(before(-5_000), NOW)).toBe('just now');
  });

  it('gives an empty string for an unparsable date', () => {
    expect(formatAgo('not a date', NOW)).toBe('');
  });
});

describe('formatIn', () => {
  it('counts down to a future time', () => {
    expect(formatIn(before(-12_000), NOW)).toBe('in 12 s');
    expect(formatIn(before(-150_000), NOW)).toBe('in 3 min');
    expect(formatIn(before(-2 * 3_600_000), NOW)).toBe('in 2 h');
  });

  it('reads a due or past time as "in a moment"', () => {
    expect(formatIn(before(1_000), NOW)).toBe('in a moment');
  });

  it('gives an empty string for an unparsable date', () => {
    expect(formatIn('', NOW)).toBe('');
  });
});

describe('formatDuration', () => {
  it('rounds up to the unit shown', () => {
    expect(formatDuration(41)).toBe('41 s');
    expect(formatDuration(61)).toBe('2 min');
    expect(formatDuration(3601)).toBe('2 h');
  });
});

describe('formatExact', () => {
  it('includes the year and the time, and is empty for invalid dates', () => {
    expect(formatExact('2026-11-13T12:00:00Z')).toMatch(/2026/);
    expect(formatExact('nope')).toBe('');
  });
});

describe('plural', () => {
  it('picks the form for the count', () => {
    expect(plural(1, 'run')).toBe('1 run');
    expect(plural(0, 'run')).toBe('0 runs');
  });
});
