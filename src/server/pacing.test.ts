import { describe, expect, it } from 'vitest';
import { paceNextPoll, type PacingInput } from './pacing.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const MINUTE = 60_000;
const BASE = 15_000;

/** Quota of 5,000 resetting in `minutes`. */
function quota(remaining: number, minutes: number): PacingInput['quota'] {
  return { limit: 5000, remaining, resetAt: NOW + minutes * MINUTE };
}

describe('paceNextPoll', () => {
  it.each<[string, Omit<PacingInput, 'baseIntervalMs' | 'now'>, number, string]>([
    ['nothing spent (all 304s)', { spent: 0, quota: quota(100, 60), retryAt: null }, BASE, 'base'],
    ['no quota known', { spent: 50, quota: null, retryAt: null }, BASE, 'base'],
    // 3 per poll × 240 polls = 720, well within 4,000 − 1,000.
    ['affordable spending', { spent: 3, quota: quota(4000, 60), retryAt: null }, BASE, 'base'],
    // 20 per poll × 240 = 4,800 > 4,000 − 1,000: stretch to 3,600 s × 20 / 3,000 = 24 s.
    ['busy: stretched', { spent: 20, quota: quota(4000, 60), retryAt: null }, 24_000, 'budget'],
    // Exactly at the budget: 12.5 per poll × 240 = 3,000.
    ['at the budget', { spent: 12.5, quota: quota(4000, 60), retryAt: null }, BASE, 'base'],
    // Only the reserve is left: wait for the reset.
    ['reserve reached', { spent: 1, quota: quota(1000, 30), retryAt: null }, 30 * MINUTE, 'budget'],
    [
      'below the reserve',
      { spent: 1, quota: quota(200, 30), retryAt: null },
      30 * MINUTE,
      'budget',
    ],
    // A tiny budget would stretch past the reset; the quota is full again then.
    [
      'capped at the reset',
      { spent: 500, quota: quota(1010, 30), retryAt: null },
      30 * MINUTE,
      'budget',
    ],
    ['reset is imminent', { spent: 500, quota: quota(1000, 0.1), retryAt: null }, BASE, 'base'],
    ['reset already passed', { spent: 500, quota: quota(1000, -1), retryAt: null }, BASE, 'base'],
    [
      'rate limited',
      { spent: 0, quota: quota(0, 10), retryAt: NOW + 10 * MINUTE },
      10 * MINUTE,
      'rate_limited',
    ],
    [
      'rate limit lifting sooner than the base interval',
      { spent: 0, quota: quota(4000, 60), retryAt: NOW + 5_000 },
      BASE,
      'base',
    ],
  ])('%s', (_name, input, delayMs, reason) => {
    expect(paceNextPoll({ ...input, baseIntervalMs: BASE, now: NOW })).toEqual({ delayMs, reason });
  });

  it('never goes below the base interval', () => {
    expect(
      paceNextPoll({
        spent: 1,
        quota: quota(5000, 60),
        retryAt: null,
        baseIntervalMs: 60_000,
        now: NOW,
      }),
    ).toEqual({ delayMs: 60_000, reason: 'base' });
  });
});
